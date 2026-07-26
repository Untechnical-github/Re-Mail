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
    const matches = messageMatchesFilter(email, { conditionSets: [{ direction: "sent" }] }, "main@gmail.com");
    expect(matches).toBe(true);
  });

  it("同上、受信メールを送信済みと誤判定しない", () => {
    const email = {
      from: "someone@example.com", to: "linked@work.com", subject: "件名", labelIds: ["INBOX"],
      accountId: "linked@work.com",
    };
    const matches = messageMatchesFilter(email, { conditionSets: [{ direction: "sent" }] }, "main@gmail.com");
    expect(matches).toBe(false);
  });
});
