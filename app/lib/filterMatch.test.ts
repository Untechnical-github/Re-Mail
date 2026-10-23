import { describe, it, expect } from "vitest";
import { isMineEmail, messageMatchesFilter } from "./filterMatch";

describe("isMineEmail", () => {
  it("完全一致するFromは自分のメールと判定する", () => {
    expect(isMineEmail({ from: "田中太郎 <a@gmail.com>" }, "a@gmail.com")).toBe(true);
    expect(isMineEmail({ from: "a@gmail.com" }, "a@gmail.com")).toBe(true);
  });

  it("部分一致だけでは自分のメールと誤判定しない（ba@gmail.com vs a@gmail.com）", () => {
    expect(isMineEmail({ from: "誰か <ba@gmail.com>" }, "a@gmail.com")).toBe(false);
  });

  it("大文字小文字・前後空白の違いは無視して一致判定する", () => {
    expect(isMineEmail({ from: "A@Gmail.com " }, " a@gmail.COM")).toBe(true);
  });

  it("isMeフラグが立っていれば無条件でtrue", () => {
    expect(isMineEmail({ isMe: true, from: "誰か <other@example.com>" }, "a@gmail.com")).toBe(true);
  });

  it("配列で複数アドレス（メイン＋連携）のいずれかと一致すればtrue", () => {
    expect(isMineEmail({ from: "sub@work.com" }, ["main@gmail.com", "sub@work.com"])).toBe(true);
    expect(isMineEmail({ from: "other@work.com" }, ["main@gmail.com", "sub@work.com"])).toBe(false);
  });
});

describe("messageMatchesFilter の方向（sent/received）判定", () => {
  it("email.accountIdが連携アカウントの場合、そのアカウント自身を基準に送受信を判定する", () => {
    const email = {
      from: "linked@work.com", to: "someone@example.com", subject: "件名", labelIds: ["SENT"],
      accountId: "linked@work.com",
    };
    // myEmail はメインアカウント固定で渡されても、email.accountId（連携アカウント）を
    // 基準に正しく「送信済み」と判定できる必要がある
    const matches = messageMatchesFilter(email, { conditionSets: [{ direction: "sent" }], accountEmail: "linked@work.com" }, "main@gmail.com");
    expect(matches).toBe(true);
  });

  it("同上、受信メールを送信済みと誤判定しない", () => {
    const email = {
      from: "someone@example.com", to: "linked@work.com", subject: "件名", labelIds: ["INBOX"],
      accountId: "linked@work.com",
    };
    const matches = messageMatchesFilter(email, { conditionSets: [{ direction: "sent" }], accountEmail: "linked@work.com" }, "main@gmail.com");
    expect(matches).toBe(false);
  });
});

describe("壊れたフィルターの保存データ", () => {
  const email = { id: "1", from: "a@example.com", to: "me@example.com", subject: "テスト語", body: "", labelIds: ["INBOX"] };

  it("語の無い条件や形の違う条件でも例外にせず、一致しない扱いにする", () => {
    const broken = { conditionSets: [{ textRules: [{ field: "subject", text: "テスト語" }] }], accountEmail: "me@example.com" } as unknown as Parameters<typeof messageMatchesFilter>[1];
    expect(() => messageMatchesFilter(email, broken, "me@example.com")).not.toThrow();
    expect(messageMatchesFilter(email, broken, "me@example.com")).toBe(false);
    const weird = { conditionSets: "x", accountEmail: "me@example.com" } as unknown as Parameters<typeof messageMatchesFilter>[1];
    expect(messageMatchesFilter(email, weird, "me@example.com")).toBe(false);
  });
});

describe("未読・既読の条件", () => {
  const base = { id: "u1", from: "田中 <tanaka@example.com>", to: "me@example.com", subject: "件名", body: "本文", date: "2026-10-01T00:00:00Z" };
  it("isUnread=true は UNREAD ラベルのあるメールだけ、false は無いメールだけに一致する", async () => {
    const { messageMatchesFilter } = await import("./filterMatch");
    const unread = { ...base, labelIds: ["INBOX", "UNREAD"] };
    const read = { ...base, labelIds: ["INBOX"] };
    const noLabels = { ...base };
    expect(messageMatchesFilter(unread, { conditionSets: [{ isUnread: true }], accountEmail: "me@example.com" }, "me@example.com")).toBe(true);
    expect(messageMatchesFilter(read, { conditionSets: [{ isUnread: true }], accountEmail: "me@example.com" }, "me@example.com")).toBe(false);
    expect(messageMatchesFilter(read, { conditionSets: [{ isUnread: false }], accountEmail: "me@example.com" }, "me@example.com")).toBe(true);
    expect(messageMatchesFilter(unread, { conditionSets: [{ isUnread: false }], accountEmail: "me@example.com" }, "me@example.com")).toBe(false);
    // ラベルが無い（読み込み途中など）メールは既読とみなす
    expect(messageMatchesFilter(noLabels, { conditionSets: [{ isUnread: false }], accountEmail: "me@example.com" }, "me@example.com")).toBe(true);
  });
  it("未読の条件だけのセットも「条件あり」として扱う", async () => {
    const { isEmptyFilterCriteria } = await import("./filterMatch");
    expect(isEmptyFilterCriteria({ conditionSets: [{ isUnread: true }] })).toBe(false);
  });
  it("既読・未読にするアクションは、どの場所のメールにも使える", async () => {
    const { isActionBoxRestricted } = await import("./filterMatch");
    for (const box of ["inbox", "archive", "sent", "spam", "trash"] as const) {
      expect(isActionBoxRestricted("read", box)).toBe(false);
      expect(isActionBoxRestricted("unread", box)).toBe(false);
    }
  });
});

describe("フィルターのアカウント", () => {
  const email = { id: "a1", from: "田中 <tanaka@example.com>", to: "me@example.com", subject: "請求書", body: "", labelIds: ["INBOX"], accountId: "me@example.com" };
  const sets = [{ textRules: [{ field: "subject" as const, mode: "contains" as const, keyword: "請求書" }] }];

  it("そのアカウントのメールにだけ一致する", () => {
    expect(messageMatchesFilter(email, { conditionSets: sets, accountEmail: "me@example.com" }, "me@example.com")).toBe(true);
    expect(messageMatchesFilter(email, { conditionSets: sets, accountEmail: "other@example.com" }, "me@example.com")).toBe(false);
  });

  it("アカウントの決まっていないフィルター（壊れた設定）はどのメールにも一致させず、例外にもしない", () => {
    expect(messageMatchesFilter(email, { conditionSets: sets }, "me@example.com")).toBe(false);
    expect(messageMatchesFilter(email, { conditionSets: sets, accountEmail: "" }, "me@example.com")).toBe(false);
  });

  it("以前のフラットな条件（conditionSets の無い textRules）は読まない", () => {
    const legacy = { textRules: sets[0].textRules, accountEmail: "me@example.com" } as unknown as Parameters<typeof messageMatchesFilter>[1];
    // textRules は読まれないので件名の条件は効かず、場所の条件だけで判断される
    expect(messageMatchesFilter({ ...email, subject: "関係ない" }, { ...legacy, boxes: ["inbox"] }, "me@example.com")).toBe(true);
  });
});
