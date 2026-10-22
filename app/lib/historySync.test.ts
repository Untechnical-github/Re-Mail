import { describe, it, expect } from "vitest";
import { summarizeHistory, matchesBoxFlags, applySyncResult, type BoxFlags } from "./historySync";
import type { Email } from "../types/email";

const mail = (id: string, labelIds: string[], extra: Partial<Email> = {}): Email => ({ id, threadId: id, subject: "s", from: "a@example.com", to: "b@example.com", date: "", body: "", snippet: "", labelIds, ...extra });

describe("summarizeHistory", () => {
  it("追加・削除・ラベルの変化を、最終的な状態にまとめる", () => {
    const s = summarizeHistory([
      { messagesAdded: [{ message: { id: "n1" } }, { message: { id: "n2" } }] },
      { labelsAdded: [{ message: { id: "old1", labelIds: ["INBOX", "STARRED"] }, labelIds: ["STARRED"] }] },
      { labelsRemoved: [{ message: { id: "old1", labelIds: ["STARRED"] }, labelIds: ["INBOX"] }] },
      { messagesDeleted: [{ message: { id: "n2" } }, { message: { id: "old2" } }] },
      { labelsAdded: [{ message: { id: "n1", labelIds: ["INBOX", "IMPORTANT"] } }] },
    ]);
    expect(s.added).toEqual(["n1"]);
    expect(s.deleted).toEqual(["old2"]);
    expect(s.labels).toEqual({ old1: ["STARRED"] });
  });

  it("空・壊れた記録でも例外にしない", () => {
    expect(summarizeHistory([])).toEqual({ added: [], deleted: [], labels: {} });
    expect(summarizeHistory([{ messagesAdded: [{ message: { id: "" } }] }, {}])).toEqual({ added: [], deleted: [], labels: {} });
  });
});

describe("matchesBoxFlags（一覧の検索条件と同じ決まり）", () => {
  const f = (o: Partial<BoxFlags>): BoxFlags => ({ inbox: false, archive: false, spam: false, trash: false, sent: false, ...o });

  it("受信箱だけ: INBOX のものだけ。迷惑・ゴミ箱は入らない", () => {
    expect(matchesBoxFlags(["INBOX"], f({ inbox: true }))).toBe(true);
    expect(matchesBoxFlags(["CATEGORY_UPDATES"], f({ inbox: true }))).toBe(false);
    expect(matchesBoxFlags(["INBOX", "SPAM"], f({ inbox: true }))).toBe(false);
  });

  it("アーカイブだけ: 受信箱以外（迷惑・ゴミ箱を除く）。受信箱＋アーカイブなら全部", () => {
    expect(matchesBoxFlags(["CATEGORY_UPDATES"], f({ archive: true }))).toBe(true);
    expect(matchesBoxFlags(["INBOX"], f({ archive: true }))).toBe(false);
    expect(matchesBoxFlags(["INBOX"], f({ archive: true, inbox: true }))).toBe(true);
    expect(matchesBoxFlags(["TRASH"], f({ archive: true, inbox: true }))).toBe(false);
  });

  it("送信済・迷惑・ゴミ箱を選んだら、それぞれのラベルのものが入る", () => {
    expect(matchesBoxFlags(["SENT"], f({ sent: true }))).toBe(true);
    expect(matchesBoxFlags(["SENT", "TRASH"], f({ sent: true }))).toBe(true);
    expect(matchesBoxFlags(["SPAM"], f({ spam: true }))).toBe(true);
    expect(matchesBoxFlags(["TRASH"], f({ trash: true }))).toBe(true);
    expect(matchesBoxFlags(["INBOX"], f({ spam: true }))).toBe(false);
  });

  it("下書きはどの場所でも入らない", () => {
    expect(matchesBoxFlags(["DRAFT"], f({ archive: true, inbox: true }))).toBe(false);
    expect(matchesBoxFlags(["DRAFT", "SENT"], f({ sent: true }))).toBe(false);
  });
});

describe("applySyncResult", () => {
  const flags: BoxFlags = { inbox: true, archive: false, spam: false, trash: false, sent: false };

  it("新しいメールは場所の条件に合うものだけ足し、既存のものはラベルを差し替え、削除されたものは取り除く", () => {
    const before = [mail("a", ["INBOX"]), mail("b", ["INBOX"]), mail("c", ["INBOX"])];
    const after = applySyncResult(before, {
      messages: [mail("n1", ["INBOX"]), mail("n2", ["SPAM"])],
      labelUpdates: [{ id: "b", labelIds: ["TRASH"] }],
      deleted: ["c"],
    }, flags);
    expect(after.map((e) => e.id).sort()).toEqual(["a", "b", "n1"]);
    expect(after.find((e) => e.id === "b")!.labelIds).toEqual(["TRASH"]);
  });

  it("元の配列は変えない", () => {
    const before = [mail("a", ["INBOX"])];
    applySyncResult(before, { messages: [], labelUpdates: [{ id: "a", labelIds: [] }], deleted: [] }, flags);
    expect(before[0].labelIds).toEqual(["INBOX"]);
  });
});
