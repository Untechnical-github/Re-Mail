import { describe, it, expect } from "vitest";
import { readPinnedIds, capPinnedIds, mergePinnedIds, missingPinnedEmail, stripPinnedBodies, MAX_PINNED_IDS_PER_CHAT } from "./pinnedIds";

const mail = (id: string) => ({ id, threadId: "t", subject: "件名", from: "a@example.com", to: "b@example.com", date: "", body: "本文", snippet: "", labelIds: [] });

describe("readPinnedIds", () => {
  it("ids だけを読む", () => {
    expect(readPinnedIds({ ids: ["18c2f0a1b2c3d4e5", "18c2f0a1b2c3d4e6"] })).toEqual(["18c2f0a1b2c3d4e5", "18c2f0a1b2c3d4e6"]);
  });

  it("古い形式（data に本文入りのメール）は読まない", () => {
    expect(readPinnedIds({ data: [mail("18c2f0a1b2c3d4e5")] } as { ids?: unknown })).toEqual([]);
  });

  it("壊れた値・ID でないもの・送信直後の仮 ID は捨て、例外にしない", () => {
    expect(readPinnedIds({ ids: ["18c2f0a1b2c3d4e5", "fake-123", 5, null, "user@example.com"] })).toEqual(["18c2f0a1b2c3d4e5"]);
    expect(readPinnedIds({ ids: "x" })).toEqual([]);
    expect(readPinnedIds({})).toEqual([]);
  });
});

describe("capPinnedIds", () => {
  it("重複を除いて上限までにする", () => {
    const ids = Array.from({ length: 80 }, (_, i) => `18c2f0a1b2c3${i.toString(16).padStart(4, "0")}`);
    expect(capPinnedIds([...ids, ids[0]])).toHaveLength(MAX_PINNED_IDS_PER_CHAT);
    expect(capPinnedIds(["aaaaaa", "aaaaaa", "bbbbbb"])).toEqual(["aaaaaa", "bbbbbb"]);
  });
});

describe("mergePinnedIds", () => {
  it("読み込めたメールを先に、まだ読み込めていない以前の ID を後ろに残す", () => {
    expect(mergePinnedIds(["cccccc", "aaaaaa"], ["aaaaaa", "bbbbbb"], new Set())).toEqual(["cccccc", "aaaaaa", "bbbbbb"]);
  });

  it("ゴミ箱・迷惑メールに移ったものは除く", () => {
    expect(mergePinnedIds(["cccccc"], ["aaaaaa", "bbbbbb"], new Set(["bbbbbb", "cccccc"]))).toEqual(["aaaaaa"]);
  });
});

describe("missingPinnedEmail", () => {
  it("存在しないことが分かる表示用のメールを作る", () => {
    const e = missingPinnedEmail("aaaaaa", "相手", "me@example.com");
    expect(e).toMatchObject({ id: "aaaaaa", isMissing: true, senderRoom: "相手", accountId: "me@example.com", body: "このメールは存在しません" });
  });
});

describe("stripPinnedBodies（保存の前に、メール本体を D1 に書かない守り）", () => {
  const mail = (id: string) => ({ id, threadId: id, subject: "件名", from: "a@example.com", to: "b@example.com", date: "", body: "本文".repeat(50), snippet: "", labelIds: [] });

  it("data を消し、ほかの値（ids を含む）はそのまま。data から ids は作らない", () => {
    const out = stripPinnedBodies(JSON.stringify({ name: "A", forceFetch: true, ids: ["eee555"], data: [mail("aaa111")] }));
    expect(JSON.parse(out!)).toEqual({ name: "A", forceFetch: true, ids: ["eee555"] });
    expect(out).not.toContain("本文");
    expect(JSON.parse(stripPinnedBodies(JSON.stringify({ forceFetch: true, roomId: "x", data: mail("ddd444") }))!)).toEqual({ forceFetch: true, roomId: "x" });
    expect(JSON.parse(stripPinnedBodies(JSON.stringify({ forceFetch: true, data: [mail("ccc333")] }))!)).toEqual({ forceFetch: true });
  });

  it("data の無い設定・JSON でない名前・壊れた JSON は、受け取った値をそのまま返す", () => {
    for (const v of [JSON.stringify({ name: "G", isGroup: true }), "山田さん", "{壊れた", "", null, undefined]) {
      expect(stripPinnedBodies(v)).toBe(v);
    }
  });
});
