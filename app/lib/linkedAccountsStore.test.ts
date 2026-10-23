import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { createFakeD1 } from "./fakeD1.testutil";

type Store = typeof import("./linkedAccountsStore");
let store: Store;
type Db = Parameters<Store["findLinkedAccount"]>[0];

// テスト用の鍵（本物の鍵ではない）
const TEST_KEY = Buffer.alloc(32, 9).toString("base64");
beforeAll(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY;
  store = await import("./linkedAccountsStore");
});
beforeEach(() => { process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY; });

const ME = "owner@example.com";
const LINKED = "Second.Account@example.com";
const tokens = { refreshToken: "rt-1", accessToken: "at-1", expiresAt: 1, name: "セカンド", picture: "https://example.com/p.png" };

describe("linkedAccountsStore（連携アカウントの保存の形）", () => {
  it("保存した値が元どおりに読め、D1 には平文のアドレス・名前・トークンが残らない", async () => {
    const fake = createFakeD1();
    const db = fake as unknown as Db;
    await store.saveLinkedAccount(db, ME, LINKED, tokens);
    expect(await store.listLinkedAccounts(db, ME)).toEqual([{ account_email: LINKED, needs_reauth: 0, name: "セカンド", picture: "https://example.com/p.png" }]);
    const raw = JSON.stringify(fake.dump("linked_accounts"));
    for (const s of [ME, LINKED, LINKED.toLowerCase(), "セカンド", "example.com/p.png", "rt-1", "at-1"]) expect(raw).not.toContain(s);
    // トークンを取り出せる（大文字小文字が違っても同じ行）
    const row = await store.findLinkedAccount(db, ME, LINKED.toLowerCase());
    expect(row?.account_email.startsWith("a1:")).toBe(true);
    expect(row?.refresh_token.startsWith("encv1:")).toBe(true);
    // 連携し直しても1行のまま
    await store.saveLinkedAccount(db, ME, LINKED, { ...tokens, refreshToken: "rt-2" });
    expect(fake.dump("linked_accounts")).toHaveLength(1);
    await store.deleteLinkedAccount(db, ME, LINKED);
    expect(fake.dump("linked_accounts")).toHaveLength(0);
  });

  it("古い形式の行（平文のアドレス・平文の名前）は読まず、例外にもしない。今の形式の行は読める", async () => {
    const fake = createFakeD1();
    const db = fake as unknown as Db;
    await store.saveLinkedAccount(db, ME, LINKED, tokens);
    const userKey = String(fake.dump("linked_accounts")[0].user_email);
    fake.prepare("INSERT INTO linked_accounts (user_email, account_email, refresh_token) VALUES (?, ?, ?)").bind(ME, "old@example.com", "rt-plain").exec();
    fake.prepare("INSERT INTO linked_accounts (user_email, account_email, account_enc, refresh_token, name) VALUES (?, ?, ?, ?, ?)").bind(userKey, "a1:plain-name", "old@example.com", "rt-plain", "平文の名前").exec();
    expect((await store.listLinkedAccounts(db, ME)).map(a => a.account_email)).toEqual([LINKED]);
    expect(await store.listLinkedAccountEmails(db, ME)).toEqual([LINKED]);
    expect(await store.findLinkedAccount(db, ME, "old@example.com")).toBeNull();
  });

  it("鍵が無いと保存せずに例外にする（平文では書かない）", async () => {
    const fake = createFakeD1();
    const db = fake as unknown as Db;
    delete process.env.TOKEN_ENCRYPTION_KEY;
    await expect(store.saveLinkedAccount(db, ME, LINKED, tokens)).rejects.toThrow();
    await expect(store.listLinkedAccounts(db, ME)).rejects.toThrow();
    expect(fake.dump("linked_accounts")).toHaveLength(0);
  });

  it("ほかの人の行には触れない", async () => {
    const fake = createFakeD1();
    const db = fake as unknown as Db;
    await store.saveLinkedAccount(db, ME, LINKED, tokens);
    await store.saveLinkedAccount(db, "other@example.com", LINKED, tokens);
    await store.deleteLinkedAccount(db, ME, LINKED);
    expect(await store.listLinkedAccounts(db, "other@example.com")).toHaveLength(1);
  });
});

describe("promoteLinkedAccount（1つのアカウントだけログアウトし、残りのアカウントに引き継ぐ）", () => {
  const THIRD = "third@example.com";
  it("引き継ぐアカウントのトークンを返し、ほかのアカウントを付け替え、ログアウトしたアカウントの行を消す", async () => {
    const fake = createFakeD1();
    const db = fake as unknown as Db;
    await store.saveLinkedAccount(db, ME, LINKED, tokens);
    await store.saveLinkedAccount(db, ME, THIRD, { ...tokens, refreshToken: "rt-3", name: "サード" });
    const got = await store.promoteLinkedAccount(db, ME, LINKED);
    expect(got).toEqual({ refreshToken: "rt-1", accessToken: "at-1", expiresAt: 1, name: "セカンド", picture: "https://example.com/p.png" });
    // ログアウトしたアカウントには何も残らない
    expect(await store.listLinkedAccounts(db, ME)).toEqual([]);
    // 3つ目のアカウントは、引き継いだアカウントに付いている（トークンもそのまま使える）
    const list = await store.listLinkedAccounts(db, LINKED);
    expect(list.map(a => a.account_email)).toEqual([THIRD]);
    expect(list[0].name).toBe("サード");
    const third = await store.findLinkedAccount(db, LINKED, THIRD);
    expect(third).not.toBeNull();
    expect(JSON.stringify(fake.dump("linked_accounts"))).not.toMatch(/example\.com|rt-3|サード/);
  });

  it("付いていないアカウント・再ログインが必要なアカウントには引き継がない（何も変えない）", async () => {
    const fake = createFakeD1();
    const db = fake as unknown as Db;
    await store.saveLinkedAccount(db, ME, LINKED, tokens);
    expect(await store.promoteLinkedAccount(db, ME, THIRD)).toBeNull();
    fake.prepare("UPDATE linked_accounts SET needs_reauth = 1").exec();
    expect(await store.promoteLinkedAccount(db, ME, LINKED)).toBeNull();
    expect((await store.listLinkedAccounts(db, ME)).length).toBe(1);
  });
});

describe("listLinkedAccountEmails（設定の読み書きのたびに使う、アドレスだけの一覧）", () => {
  it("アドレスだけを重複なく返す", async () => {
    const fake = createFakeD1();
    const db = fake as unknown as Db;
    await store.saveLinkedAccount(db, ME, LINKED, tokens);
    await store.saveLinkedAccount(db, ME, "third@example.com", tokens);
    const emails = await store.listLinkedAccountEmails(db, ME);
    expect(emails.map(e => e.toLowerCase()).sort()).toEqual([LINKED.toLowerCase(), "third@example.com"].sort());
    expect(await store.listLinkedAccountEmails(db, "nobody@example.com")).toEqual([]);
  });
});
