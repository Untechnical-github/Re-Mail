import { describe, it, expect, vi } from "vitest";
import { classifySaveStatus, createSaveQueue } from "./configSaveQueue";

// タイマーを手で進めるための、偽の schedule / cancel
function fakeTimers() {
  let id = 0;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  return {
    schedule: (fn: () => void, ms: number) => { pending.set(++id, { fn, ms }); return id; },
    cancel: (h: unknown) => { pending.delete(h as number); },
    pending,
    // 予約されているものを1つずつ実行する
    async runAll() {
      const list = Array.from(pending.entries());
      pending.clear();
      for (const [, t] of list) t.fn();
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

const res = (status: number) => new Response(null, { status });

describe("classifySaveStatus", () => {
  it("成功・送り直す・あきらめる に分ける", () => {
    expect(classifySaveStatus(200)).toBe("ok");
    expect(classifySaveStatus(204)).toBe("ok");
    expect(classifySaveStatus(null)).toBe("retry");
    expect(classifySaveStatus(500)).toBe("retry");
    expect(classifySaveStatus(503)).toBe("retry");
    expect(classifySaveStatus(429)).toBe("retry");
    expect(classifySaveStatus(408)).toBe("retry");
    expect(classifySaveStatus(401)).toBe("fatal");
    expect(classifySaveStatus(400)).toBe("fatal");
    expect(classifySaveStatus(403)).toBe("fatal");
  });
});

describe("createSaveQueue", () => {
  it("成功したら送り直さず、何も知らせない", async () => {
    const t = fakeTimers();
    const onRetrying = vi.fn(), onGaveUp = vi.fn(), onRecovered = vi.fn();
    const q = createSaveQueue({ ...t, onRetrying, onGaveUp, onRecovered });
    const send = vi.fn().mockResolvedValue(res(200));
    await q.save("a", send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(t.pending.size).toBe(0);
    expect(onRetrying).not.toHaveBeenCalled();
    expect(onRecovered).not.toHaveBeenCalled();
    expect(q.hasPending()).toBe(false);
  });

  it("通信断のあと送り直して保存できたら、「送り直します」と「保存しました」を1回ずつ知らせる", async () => {
    const t = fakeTimers();
    const onRetrying = vi.fn(), onGaveUp = vi.fn(), onRecovered = vi.fn();
    const q = createSaveQueue({ ...t, delaysMs: [10, 20], onRetrying, onGaveUp, onRecovered });
    const send = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(res(500)).mockResolvedValueOnce(res(200));
    await q.save("a", send);
    expect(onRetrying).toHaveBeenCalledTimes(1);
    expect(q.hasPending()).toBe(true);
    expect(Array.from(t.pending.values())[0].ms).toBe(10);
    await t.runAll();
    expect(Array.from(t.pending.values())[0].ms).toBe(20);
    await t.runAll();
    expect(send).toHaveBeenCalledTimes(3);
    expect(onRetrying).toHaveBeenCalledTimes(1);
    expect(onRecovered).toHaveBeenCalledTimes(1);
    expect(onGaveUp).not.toHaveBeenCalled();
    expect(q.hasPending()).toBe(false);
  });

  it("決めた回数送り直してもだめなら、あきらめて1回だけ知らせる", async () => {
    const t = fakeTimers();
    const onGaveUp = vi.fn(), onRecovered = vi.fn();
    const q = createSaveQueue({ ...t, delaysMs: [10, 20], onGaveUp, onRecovered });
    const send = vi.fn().mockResolvedValue(res(503));
    await q.save("a", send);
    await t.runAll();
    await t.runAll();
    expect(send).toHaveBeenCalledTimes(3);
    expect(t.pending.size).toBe(0);
    expect(onGaveUp).toHaveBeenCalledTimes(1);
    expect(onGaveUp).toHaveBeenCalledWith("a");
    expect(onRecovered).not.toHaveBeenCalled();
    expect(q.hasPending()).toBe(false);
  });

  it("401 など送り直しても変わらない失敗は、送り直さずにすぐ知らせる", async () => {
    const t = fakeTimers();
    const onGaveUp = vi.fn(), onRetrying = vi.fn();
    const q = createSaveQueue({ ...t, onGaveUp, onRetrying });
    const send = vi.fn().mockResolvedValue(res(401));
    await q.save("a", send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(t.pending.size).toBe(0);
    expect(onRetrying).not.toHaveBeenCalled();
    expect(onGaveUp).toHaveBeenCalledTimes(1);
  });

  it("送り直し待ちの行に新しい保存が来たら、古い値は送らず新しい値だけを送る", async () => {
    const t = fakeTimers();
    const onRecovered = vi.fn();
    const q = createSaveQueue({ ...t, delaysMs: [10], onRecovered });
    const oldSend = vi.fn().mockResolvedValue(res(500));
    const newSend = vi.fn().mockResolvedValue(res(200));
    await q.save("a", oldSend);
    expect(t.pending.size).toBe(1);
    await q.save("a", newSend);
    // 古い送り直しの予約は取り消されている
    expect(t.pending.size).toBe(0);
    await t.runAll();
    expect(oldSend).toHaveBeenCalledTimes(1);
    expect(newSend).toHaveBeenCalledTimes(1);
    expect(onRecovered).toHaveBeenCalledTimes(1);
  });

  it("古い保存の結果が新しい保存より後に返ってきても、その結果では送り直さない", async () => {
    const t = fakeTimers();
    const q = createSaveQueue({ ...t, delaysMs: [10] });
    let resolveOld: (r: Response) => void = () => {};
    const oldSend = vi.fn(() => new Promise<Response>((r) => { resolveOld = r; }));
    const newSend = vi.fn().mockResolvedValue(res(200));
    const first = q.save("a", oldSend);
    await q.save("a", newSend);
    resolveOld(res(500));
    await first;
    expect(t.pending.size).toBe(0);
    expect(oldSend).toHaveBeenCalledTimes(1);
  });

  it("別の行の失敗はほかの行の保存を止めず、すべて直ったときだけ「保存しました」を知らせる", async () => {
    const t = fakeTimers();
    const onRetrying = vi.fn(), onRecovered = vi.fn();
    const q = createSaveQueue({ ...t, delaysMs: [10], onRetrying, onRecovered });
    const a = vi.fn().mockResolvedValueOnce(res(500)).mockResolvedValueOnce(res(200));
    const b = vi.fn().mockResolvedValueOnce(res(500)).mockResolvedValueOnce(res(200));
    const c = vi.fn().mockResolvedValue(res(200));
    await q.save("a", a);
    await q.save("b", b);
    await q.save("c", c);
    expect(c).toHaveBeenCalledTimes(1);
    expect(onRetrying).toHaveBeenCalledTimes(1);
    await t.runAll();
    expect(onRecovered).toHaveBeenCalledTimes(1);
  });

  it("flush は待たずに今すぐ送り直す", async () => {
    const t = fakeTimers();
    const q = createSaveQueue({ ...t, delaysMs: [60000] });
    const send = vi.fn().mockResolvedValueOnce(res(500)).mockResolvedValueOnce(res(200));
    await q.save("a", send);
    expect(t.pending.size).toBe(1);
    q.flush();
    await new Promise((r) => setTimeout(r, 0));
    expect(send).toHaveBeenCalledTimes(2);
    expect(t.pending.size).toBe(0);
    expect(q.hasPending()).toBe(false);
  });
});
