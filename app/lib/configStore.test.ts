// 設定の保存の形（configStore.ts）のテスト。本物の SQL（node:sqlite）で確かめる
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { createFakeD1, type FakeD1 } from "./fakeD1.testutil";

type Store = typeof import("./configStore");
let store: Store;
type Db = Parameters<Store["saveConfig"]>[0];

// テスト用の鍵（本物の鍵ではない）
const TEST_KEY = Buffer.alloc(32, 5).toString("base64");
const U = "user@example.com";

beforeAll(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY;
  store = await import("./configStore");
});
beforeEach(() => { process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY; });

const insertRaw = (fake: FakeD1, user: string, account: string, chat: string, custom: string | null) =>
  fake.prepare("INSERT INTO chat_configs (user_email, account_email, chat_id, custom_name, is_pinned, is_hidden, hidden_at_date, unhide_on_new) VALUES (?, ?, ?, ?, 1, 0, NULL, 0)")
    .bind(user, account, chat, custom).exec();

describe("saveConfig / openConfigs / deleteConfig", () => {
  it("保存した値が元どおりに読め、D1 にはアドレス・相手名・名前が平文で残らない", async () => {
    const fake = createFakeD1(); const db = fake as unknown as Db;
    const custom = JSON.stringify({ name: "田中さん", forceFetch: true, ids: ["18c2f0a1b2c3d4e5"] });
    await store.saveConfig(db, U, { chat_id: "田中太郎", account_email: U, custom_name: custom, is_pinned: true });
    expect(await store.openConfigs(db, U)).toEqual([{ account_email: U, chat_id: "田中太郎", custom_name: custom, is_pinned: 1, is_hidden: 0, hidden_at_date: null, unhide_on_new: 0 }]);
    const raw = fake.dump("chat_configs");
    expect(raw).toHaveLength(1);
    expect(String(raw[0].user_email)).toMatch(/^a1:/);
    expect(String(raw[0].account_email)).toMatch(/^a1:/);
    expect(String(raw[0].chat_id)).toMatch(/^h1:/);
    expect(String(raw[0].custom_name)).toMatch(/^encv1:/);
    expect(JSON.stringify(raw)).not.toMatch(/example\.com|田中/);

    await store.deleteConfig(db, U, "田中太郎", U);
    expect(fake.dump("chat_configs")).toHaveLength(0);
  });

  it("ピン留めの本体（data）が送られてきても保存しない", async () => {
    const fake = createFakeD1(); const db = fake as unknown as Db;
    await store.saveConfig(db, U, { chat_id: "田中太郎", account_email: U, custom_name: JSON.stringify({ forceFetch: true, ids: ["18c2f0a1b2c3d4e5"], data: [{ id: "18c2f0a1b2c3d4e5", body: "本文" }] }) });
    const [row] = await store.openConfigs(db, U);
    expect(JSON.parse(row.custom_name!)).toEqual({ forceFetch: true, ids: ["18c2f0a1b2c3d4e5"] });
  });

  it("古い形式の行（平文のアドレス・平文の chat_id・アカウントを持たない中身）は読まず、例外にもしない。今の形式の行は読める", async () => {
    const fake = createFakeD1(); const db = fake as unknown as Db;
    await store.saveConfig(db, U, { chat_id: "今の形", account_email: U, custom_name: "名前" });
    const userKey = String(fake.dump("chat_configs")[0].user_email);
    insertRaw(fake, U, U, "平文の行", "古い名前");                            // 平文のアドレス
    insertRaw(fake, userKey, U, "平文の chat_id", "古い名前");                // 平文の chat_id
    insertRaw(fake, userKey, "a1:xxx", "h1:yyy", "encv1:broken");            // 壊れた暗号文
    const rows = await store.openConfigs(db, U);
    expect(rows.map(r => r.chat_id)).toEqual(["今の形"]);
  });

  it("鍵が無いと保存せずに例外にする（平文では書かない）", async () => {
    const fake = createFakeD1(); const db = fake as unknown as Db;
    delete process.env.TOKEN_ENCRYPTION_KEY;
    await expect(store.saveConfig(db, U, { chat_id: "田中太郎", account_email: U, custom_name: "田中さん" })).rejects.toThrow();
    await expect(store.saveCommonSettings(db, U, [], { inbox: true, accounts: { "work@example.com": true } })).rejects.toThrow();
    await expect(store.saveAccountSettings(db, U, { alwaysLoadImages: true })).rejects.toThrow();
    expect(fake.dump("chat_configs")).toHaveLength(0);
  });
});

describe("共通設定・アカウント設定の中身", () => {
  it("暗号化した中身だけを読み、古い平文の JSON は読まない（空として扱う）", async () => {
    expect(await store.openGlobalSettings(JSON.stringify({ inbox: false }))).toEqual({});
    expect(await store.openAccountSettings(JSON.stringify({ alwaysLoadImages: true }))).toEqual({});
    expect(await store.openGlobalSettings("encv1:broken")).toEqual({});
    expect(await store.openGlobalSettings(null)).toEqual({});
  });

  it("共通設定は決まった名前だけを保存し、alwaysLoadImages（今はアカウント設定）は共通設定に入れない", async () => {
    const fake = createFakeD1(); const db = fake as unknown as Db;
    const saved = await store.saveCommonSettings(db, U, [], { inbox: false, alwaysLoadImages: true, accounts: { "work@example.com": false }, extra: "x" }, 1000);
    expect(saved).toEqual({ inbox: false, accounts: { "work@example.com": false }, updatedAt: 1000 });
    const rows = fake.dump("chat_configs");
    expect(rows).toHaveLength(1);
    expect(String(rows[0].custom_name)).toMatch(/^encv1:/);
    expect(JSON.stringify(rows)).not.toContain("example.com");
  });
});
