import { describe, it, expect, vi, beforeAll } from "vitest";
import { createFakeD1 } from "./fakeD1.testutil";

// 段階の切り替え（app/lib/addressStage.ts）をテストの中で変えられるようにする
const stage = vi.hoisted(() => ({ hashed: false }));
vi.mock("./addressStage", () => ({ get WRITE_HASHED_ADDRESS() { return stage.hashed; } }));

type Store = typeof import("./linkedAccountsStore");
let store: Store;
type Db = Parameters<Store["findLinkedAccount"]>[0];

beforeAll(async () => {
  // テスト用の鍵（本物の鍵ではない）
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  store = await import("./linkedAccountsStore");
});

const ME = "owner@example.com";
const LINKED = "Second.Account@example.com";
const tokens = { refreshToken: "rt-1", accessToken: "at-1", expiresAt: 1, name: "セカンド", picture: "https://example.com/p.png" };

describe("linkedAccountsStore（連携アカウントのアドレスを D1 のキーから外す移行）", () => {
  it("段階1で保存した行を、段階2で読むと置き換わり、D1 に平文のアドレス・名前が残らない。値は元どおりに読める", async () => {
    const fake = createFakeD1();
    const db = fake as unknown as Db;
    stage.hashed = false;
    await store.saveLinkedAccount(db, ME, LINKED, tokens);
    expect(JSON.stringify(fake.dump("linked_accounts"))).toContain(ME); // 段階1では平文

    stage.hashed = true;
    const listed = await store.listLinkedAccounts(db, ME);
    expect(listed).toEqual([{ account_email: LINKED, needs_reauth: 0, name: "セカンド", picture: "https://example.com/p.png" }]);
    const raw = JSON.stringify(fake.dump("linked_accounts"));
    for (const s of [ME, LINKED, LINKED.toLowerCase(), "セカンド", "example.com/p.png"]) expect(raw).not.toContain(s);
    expect(fake.dump("linked_accounts")).toHaveLength(1);

    // トークンを取り出せる（大文字小文字が違っても同じ行）
    const row = await store.findLinkedAccount(db, ME, LINKED.toLowerCase());
    expect(row?.account_email.startsWith("a1:")).toBe(true);
    expect(row?.refresh_token).toBeTruthy();
  });

  it("段階2から段階1のコードに戻しても、置き換えた行を読める・消せる", async () => {
    const fake = createFakeD1();
    const db = fake as unknown as Db;
    stage.hashed = true;
    await store.saveLinkedAccount(db, ME, LINKED, tokens);
    stage.hashed = false;
    expect(await store.listLinkedAccounts(db, ME)).toEqual([{ account_email: LINKED, needs_reauth: 0, name: "セカンド", picture: "https://example.com/p.png" }]);
    expect(await store.findLinkedAccount(db, ME, LINKED)).not.toBeNull();
    await store.deleteLinkedAccount(db, ME, LINKED);
    expect(fake.dump("linked_accounts")).toHaveLength(0);
  });

  it("連携し直すと、古い形の行は消えて1行だけになる。ほかの人の行には触れない", async () => {
    const fake = createFakeD1();
    const db = fake as unknown as Db;
    stage.hashed = false;
    await store.saveLinkedAccount(db, ME, LINKED, tokens);
    await store.saveLinkedAccount(db, "other@example.com", LINKED, tokens);
    stage.hashed = true;
    await store.saveLinkedAccount(db, ME, LINKED, { ...tokens, refreshToken: "rt-2" });
    const rows = fake.dump("linked_accounts");
    expect(rows).toHaveLength(2);
    expect(await store.listLinkedAccounts(db, "other@example.com")).toHaveLength(1);
  });
});

describe("promoteLinkedAccount（1つのアカウントだけログアウトし、残りのアカウントに引き継ぐ）", () => {
  const THIRD = "third@example.com";
  it("引き継ぐアカウントのトークンを返し、ほかのアカウントを付け替え、ログアウトしたアカウントの行を消す", async () => {
    const fake = createFakeD1();
    const db = fake as unknown as Db;
    stage.hashed = true;
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
    stage.hashed = true;
    await store.saveLinkedAccount(db, ME, LINKED, tokens);
    expect(await store.promoteLinkedAccount(db, ME, THIRD)).toBeNull();
    fake.prepare("UPDATE linked_accounts SET needs_reauth = 1").exec();
    expect(await store.promoteLinkedAccount(db, ME, LINKED)).toBeNull();
    expect((await store.listLinkedAccounts(db, ME)).length).toBe(1);
  });
});
