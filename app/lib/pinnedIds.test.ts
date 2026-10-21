import { describe, it, expect } from "vitest";
import { readPinnedField, capPinnedIds, mergePinnedIds, missingPinnedEmail, MAX_PINNED_IDS_PER_CHAT } from "./pinnedIds";

const mail = (id: string) => ({ id, threadId: "t", subject: "件名", from: "a@example.com", to: "b@example.com", date: "", body: "本文", snippet: "", labelIds: [] });

describe("readPinnedField", () => {
  it("新しい形式（ids だけ）を読む", () => {
    expect(readPinnedField({ ids: ["18c2f0a1b2c3d4e5", "18c2f0a1b2c3d4e6"] })).toEqual({ ids: ["18c2f0a1b2c3d4e5", "18c2f0a1b2c3d4e6"], legacyEmails: [] });
  });

  it("古い形式（data に本文入りのメール配列）から ID と本体を取り出す", () => {
    const r = readPinnedField({ data: [mail("18c2f0a1b2c3d4e5"), mail("18c2f0a1b2c3d4e6")] });
    expect(r.ids).toEqual(["18c2f0a1b2c3d4e5", "18c2f0a1b2c3d4e6"]);
    expect(r.legacyEmails).toHaveLength(2);
  });

  it("古い形式で1件だけ入っている場合も読む", () => {
    expect(readPinnedField({ data: mail("18c2f0a1b2c3d4e5") }).ids).toEqual(["18c2f0a1b2c3d4e5"]);
  });

  it("壊れた値・ID でないもの・送信直後の仮 ID は捨てる", () => {
    expect(readPinnedField({ ids: ["18c2f0a1b2c3d4e5", "fake-123", 5, null, "user@example.com"] }).ids).toEqual(["18c2f0a1b2c3d4e5"]);
    expect(readPinnedField({ data: [null, "x", mail("fake-1")] })).toEqual({ ids: [], legacyEmails: [] });
    expect(readPinnedField({})).toEqual({ ids: [], legacyEmails: [] });
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
