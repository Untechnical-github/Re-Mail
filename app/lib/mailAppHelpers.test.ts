import { describe, it, expect } from "vitest";
import { mapWithConcurrency, reconcileFakeSentEmails, getSavedBoxSettings, getSavedAccountSettings, parseAddressSet, sameAddressSet, countOccurrences } from "./mailAppHelpers";
import type { Email } from "../types/email";

const mail = (over: Partial<Email>): Email => ({ id: "x", threadId: "t", subject: "件名", from: "a@example.com", to: "b@example.com", date: "2026-01-01T00:00:00Z", body: "", snippet: "", labelIds: [], ...over } as Email);

describe("mapWithConcurrency", () => {
  it("順番どおりの結果を返し、同時に動くのは上限まで", async () => {
    let running = 0;
    let peak = 0;
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise(r => setTimeout(r, 5 - n));
      running--;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50]);
    expect(peak).toBe(2);
  });

  it("空の配列は空を返す・上限0でも1つずつ動く", async () => {
    expect(await mapWithConcurrency([], 3, async (n: number) => n)).toEqual([]);
    expect(await mapWithConcurrency([1, 2], 0, async (n) => n + 1)).toEqual([2, 3]);
  });
});

describe("reconcileFakeSentEmails", () => {
  const real = mail({ id: "18c2f0a1b2c3d4e5", isMe: true, accountId: "user@example.com", to: "b@example.com", subject: "s", date: "2026-01-01T00:00:00Z" });

  it("仮 ID が無ければそのまま返す", () => {
    const list = [real];
    expect(reconcileFakeSentEmails(list)).toBe(list);
  });

  it("同じアカウント・宛先・件名で5分以内の実メールがあれば仮 ID を除く", () => {
    const fake = mail({ id: "fake-1", isMe: true, accountId: "user@example.com", to: "b@example.com", subject: "s", date: "2026-01-01T00:04:59Z" });
    expect(reconcileFakeSentEmails([fake, real]).map(e => e.id)).toEqual([real.id]);
  });

  it("5分ちょうど離れている・宛先が違う・自分の送信でないときは残す", () => {
    const far = mail({ id: "fake-2", isMe: true, accountId: "user@example.com", to: "b@example.com", subject: "s", date: "2026-01-01T00:05:00Z" });
    const otherTo = mail({ id: "fake-3", isMe: true, accountId: "user@example.com", to: "c@example.com", subject: "s", date: "2026-01-01T00:00:00Z" });
    const notMine = { ...real, isMe: false };
    expect(reconcileFakeSentEmails([far, otherTo, notMine]).map(e => e.id)).toEqual(["fake-2", "fake-3", real.id]);
  });

  it("Gmail から取り直した実メール（isMe が無く SENT ラベルだけ）でも仮 ID を除く", () => {
    const fake = mail({ id: "fake-4", isMe: true, accountId: "user@example.com", to: "b@example.com", subject: "s", date: "2026-01-01T00:01:00Z" });
    const fetched = mail({ id: "18c2f0a1b2c3d4e6", accountId: "user@example.com", to: "b@example.com", subject: "s", labelIds: ["SENT"], date: "2026-01-01T00:01:00Z" });
    expect(reconcileFakeSentEmails([fake, fetched]).map(e => e.id)).toEqual([fetched.id]);
  });
});

describe("parseAddressSet / sameAddressSet", () => {
  it("名前付き・大文字・空の項目を正規化する", () => {
    expect([...parseAddressSet("Taro <A@Example.com>, b@example.com ,")]).toEqual(["a@example.com", "b@example.com"]);
    expect(parseAddressSet("").size).toBe(0);
  });

  it("同じ集合だけ true。空どうしは false", () => {
    expect(sameAddressSet(parseAddressSet("a@example.com, b@example.com"), parseAddressSet("B@example.com, a@example.com"))).toBe(true);
    expect(sameAddressSet(parseAddressSet("a@example.com"), parseAddressSet("a@example.com, b@example.com"))).toBe(false);
    expect(sameAddressSet(new Set(), new Set())).toBe(false);
  });
});

describe("countOccurrences", () => {
  it("大文字小文字を無視し、重ならずに数える", () => {
    expect(countOccurrences("Abc abc ABC", "abc")).toBe(3);
    expect(countOccurrences("aaaa", "aa")).toBe(2);
    expect(countOccurrences("abc", "")).toBe(0);
    expect(countOccurrences("", "a")).toBe(0);
  });
});

describe("getSavedBoxSettings / getSavedAccountSettings", () => {
  it("ブラウザでない環境では null", () => {
    expect(getSavedBoxSettings()).toBeNull();
    expect(getSavedAccountSettings()).toBeNull();
  });
});
