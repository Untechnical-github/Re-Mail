import { describe, it, expect } from "vitest";
import { labelChangeFor, sanitizeMessageIds, chunkIds, groupIdsByAccount, BATCH_MODIFY_LIMIT } from "./mailboxOps";

describe("labelChangeFor", () => {
  it("アーカイブは受信箱・ゴミ箱・迷惑メールから外すだけ（付けるラベルは無い）", () => {
    expect(labelChangeFor("ARCHIVE")).toEqual({ addLabelIds: [], removeLabelIds: ["INBOX", "TRASH", "SPAM"] });
  });
  it("受信箱・迷惑メール・ゴミ箱は、そのラベルを付けてほかの2つを外す", () => {
    expect(labelChangeFor("INBOX")).toEqual({ addLabelIds: ["INBOX"], removeLabelIds: ["TRASH", "SPAM"] });
    expect(labelChangeFor("SPAM")).toEqual({ addLabelIds: ["SPAM"], removeLabelIds: ["INBOX", "TRASH"] });
    expect(labelChangeFor("TRASH")).toEqual({ addLabelIds: ["TRASH"], removeLabelIds: ["INBOX", "SPAM"] });
  });
  it("知らない移動先・未指定は null（何も変えずに成功と返さないため）", () => {
    expect(labelChangeFor(undefined)).toBeNull();
    expect(labelChangeFor("archive")).toBeNull();
    expect(labelChangeFor("SENT")).toBeNull();
    expect(labelChangeFor(null)).toBeNull();
  });
});

describe("sanitizeMessageIds", () => {
  it("仮 ID（fake-）・文字列でないもの・おかしな文字・重複を外す", () => {
    expect(sanitizeMessageIds(["18c2a", "fake-123", 5, null, "18c2a", "a b", "../x", "", "19fF0"])).toEqual(["18c2a", "19fF0"]);
  });
  it("配列でなければ空", () => {
    expect(sanitizeMessageIds(undefined)).toEqual([]);
    expect(sanitizeMessageIds("18c2a")).toEqual([]);
  });
  it("長すぎる ID は外す", () => {
    expect(sanitizeMessageIds(["a".repeat(65), "a".repeat(64)])).toEqual(["a".repeat(64)]);
  });
});

describe("chunkIds", () => {
  it("1000件ごとに分ける（境界ちょうど・1件はみ出し）", () => {
    const ids = Array.from({ length: BATCH_MODIFY_LIMIT + 1 }, (_, i) => `m${i}`);
    expect(chunkIds(ids.slice(0, BATCH_MODIFY_LIMIT)).length).toBe(1);
    const chunks = chunkIds(ids);
    expect(chunks.map((c) => c.length)).toEqual([BATCH_MODIFY_LIMIT, 1]);
    expect(chunkIds([])).toEqual([]);
  });
});

describe("groupIdsByAccount", () => {
  it("連携アカウントのメールはそのアカウントに、分からないものはメインアカウントにまとめる", () => {
    const owner: Record<string, string> = { a: "linked@example.com", b: "main@example.com", c: "linked@example.com" };
    const groups = groupIdsByAccount(["a", "b", "c", "d"], (id) => owner[id], "main@example.com");
    expect(Object.fromEntries(groups)).toEqual({ "linked@example.com": ["a", "c"], "main@example.com": ["b", "d"] });
  });
});
