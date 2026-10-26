import { describe, it, expect } from "vitest";
import { summarizeHistory, matchesBoxFlags, applySyncResult, idsToFetchForLabelChanges, mergeEmails, mailIdentity, type BoxFlags, draftHistory, shouldRefreshDrafts } from "./historySync";
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

describe("アカウントをまたいで同じ ID のメール（連携アカウントどうしのやり取り）", () => {
  const flags: BoxFlags = { inbox: true, archive: false, spam: false, trash: false, sent: true };
  const A = "a@example.com", B = "b@example.com";

  it("mailIdentity はアカウント（大文字小文字を無視）と ID で決まり、accountId が無ければ既定のアカウント", () => {
    expect(mailIdentity(mail("x", [], { accountId: "A@Example.com" }), B)).toBe(mailIdentity(mail("x", [], { accountId: A }), B));
    expect(mailIdentity(mail("x", []), A)).toBe(mailIdentity(mail("x", [], { accountId: A }), B));
    expect(mailIdentity(mail("x", [], { accountId: A }), A)).not.toBe(mailIdentity(mail("x", [], { accountId: B }), A));
  });

  it("mergeEmails は同じ ID でもアカウントが違えば両方残し、同じアカウントなら新しいほうで置き換える", () => {
    const base = [mail("x", ["SENT"], { accountId: A }), mail("y", ["INBOX"], { accountId: A })];
    const merged = mergeEmails(base, [mail("x", ["INBOX"], { accountId: B }), mail("y", ["INBOX", "UNREAD"], { accountId: A })], A);
    expect(merged).toHaveLength(3);
    expect(merged.find(e => e.id === "x" && e.accountId === A)!.labelIds).toEqual(["SENT"]);
    expect(merged.find(e => e.id === "x" && e.accountId === B)!.labelIds).toEqual(["INBOX"]);
    expect(merged.find(e => e.id === "y")!.labelIds).toEqual(["INBOX", "UNREAD"]);
  });

  it("applySyncResult は account を渡すと、そのアカウントのメールにだけラベルの変化と削除を当てる", () => {
    const before = [mail("x", ["SENT"], { accountId: A }), mail("x", ["INBOX"], { accountId: B }), mail("z", ["INBOX"], { accountId: B })];
    const after = applySyncResult(before, { messages: [], labelUpdates: [{ id: "x", labelIds: ["SENT", "STARRED"] }], deleted: ["z"] }, flags, A, A);
    expect(after.find(e => e.id === "x" && e.accountId === B)!.labelIds).toEqual(["INBOX"]);
    expect(after.find(e => e.id === "x" && e.accountId === A)!.labelIds).toEqual(["SENT", "STARRED"]);
    // z は B のメールなので、A の削除では消さない
    expect(after.some(e => e.id === "z")).toBe(true);
  });

  it("applySyncResult で新しく届いたメールは、ほかのアカウントの同じ ID のメールを上書きしない", () => {
    const before = [mail("x", ["SENT"], { accountId: A })];
    const after = applySyncResult(before, { messages: [mail("x", ["INBOX"], { accountId: B })], labelUpdates: [], deleted: [] }, flags, B, A);
    expect(after).toHaveLength(2);
  });
});

describe("idsToFetchForLabelChanges", () => {
  it("まだ画面に無く、今の場所に入るようになったメールだけを返す", () => {
    const flags: BoxFlags = { inbox: true, archive: false, spam: false, trash: false, sent: false };
    const ids = idsToFetchForLabelChanges(new Set(["known"]), [
      { id: "known", labelIds: ["INBOX"] },
      { id: "restored", labelIds: ["INBOX"] },
      { id: "stillTrash", labelIds: ["TRASH"] },
    ], flags);
    expect(ids).toEqual(["restored"]);
  });
});

describe("draftHistory / shouldRefreshDrafts（Gmail の下書きとの同期）", () => {
  it("DRAFT ラベルのメールの追加・削除・ラベルの付け外しがあれば変わったとする。下書きのメールは詳細を取らない", () => {
    const r = draftHistory([
      { messagesAdded: [{ message: { id: "d1", labelIds: ["DRAFT"] } }, { message: { id: "m1", labelIds: ["INBOX"] } }] },
    ]);
    expect(r).toEqual({ changed: true, addedDraftIds: ["d1"] });
    expect(draftHistory([{ messagesDeleted: [{ message: { id: "d0", labelIds: ["DRAFT"] } }] }]).changed).toBe(true);
    expect(draftHistory([{ labelsRemoved: [{ message: { id: "x" }, labelIds: ["DRAFT"] }] }]).changed).toBe(true);
    expect(draftHistory([{ messagesAdded: [{ message: { id: "m1", labelIds: ["INBOX"] } }] }])).toEqual({ changed: false, addedDraftIds: [] });
  });
  it("知っている下書きのメッセージ ID が消えたときも読み直す", () => {
    expect(shouldRefreshDrafts(false, ["m9"], new Set(["m9"]))).toBe(true);
    expect(shouldRefreshDrafts(false, ["m1"], new Set(["m9"]))).toBe(false);
    expect(shouldRefreshDrafts(true, [], new Set())).toBe(true);
  });
});
