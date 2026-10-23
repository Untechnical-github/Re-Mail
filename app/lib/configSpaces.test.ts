// アカウントごとの置き場所（configStore.ts の openSessionConfigs ほか）のテスト。本物の SQL（node:sqlite）で確かめる
import { describe, it, expect, beforeAll } from "vitest";
import { createFakeD1 } from "./fakeD1.testutil";

type Store = typeof import("./configStore");
let store: Store;
type Db = Parameters<Store["saveSessionConfig"]>[0];

const P = "main@example.com";
const L = "linked@example.com";
const M = "third@example.com";

beforeAll(async () => {
  // テスト用の鍵（本物の鍵ではない）
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  store = await import("./configStore");
});

const input = (account: string, chat: string, custom: string | null = null, extra: Partial<{ is_pinned: boolean; is_hidden: boolean }> = {}) =>
  ({ chat_id: chat, account_email: account, custom_name: custom, ...extra });
const find = <T extends { account_email: string; chat_id: string }>(rows: T[], account: string, chat: string): T | undefined =>
  rows.find(r => r.account_email.toLowerCase() === account.toLowerCase() && r.chat_id === chat);

describe("アカウントごとの置き場所", () => {
  it("一緒にログインしているアカウントのチャットの設定は、そのアカウントの置き場所だけに保存され、そのアカウントだけでログインしても見える", async () => {
    const fake = createFakeD1(); const db = fake as unknown as Db;
    await store.saveSessionConfig(db, P, [L], input(L, "Alice", "仕事のAlice", { is_pinned: true }));
    expect(fake.dump("chat_configs")).toHaveLength(1);
    expect(find(await store.openConfigs(db, P), L, "Alice")).toBeUndefined();
    const alone = await store.openSessionConfigs(db, L, []);
    expect(find(alone.configs, L, "Alice")).toMatchObject({ custom_name: "仕事のAlice", is_pinned: 1 });
    const both = await store.openSessionConfigs(db, P, [L]);
    expect(both.configs.filter(r => r.chat_id === "Alice")).toHaveLength(1);
    expect(JSON.stringify(fake.dump("chat_configs"))).not.toMatch(/example\.com|Alice/);
  });

  it("同じ相手でもアカウントが違えば別の設定になる", async () => {
    const fake = createFakeD1(); const db = fake as unknown as Db;
    await store.saveSessionConfig(db, P, [L], input(P, "Bob", "Pの名前"));
    await store.saveSessionConfig(db, P, [L], input(L, "Bob", "Lの名前"));
    const both = await store.openSessionConfigs(db, P, [L]);
    expect(find(both.configs, P, "Bob")?.custom_name).toBe("Pの名前");
    expect(find(both.configs, L, "Bob")?.custom_name).toBe("Lの名前");
    await store.deleteSessionConfig(db, P, [L], "Bob", L);
    const after = await store.openSessionConfigs(db, P, [L]);
    expect(find(after.configs, L, "Bob")).toBeUndefined();
    expect(find(after.configs, P, "Bob")?.custom_name).toBe("Pの名前");
  });

  it("フィルターはそのアカウントの置き場所にだけあり、ほかのアカウントには写らない", async () => {
    const fake = createFakeD1(); const db = fake as unknown as Db;
    const f = JSON.stringify({ name: "請求書", filterAction: "pin", filterCriteria: { conditionSets: [], accountEmail: L } });
    await store.saveSessionConfig(db, P, [L], input(L, "filter:abc", f));
    const both = await store.openSessionConfigs(db, P, [L]);
    expect(both.configs.filter(r => r.chat_id === "filter:abc")).toEqual([expect.objectContaining({ account_email: L, custom_name: f })]);
    expect((await store.openSessionConfigs(db, P, [])).configs.find(r => r.chat_id === "filter:abc")).toBeUndefined();
  });

  it("ログイン中でないアカウントの設定は保存も削除もしない（UnknownAccountError）", async () => {
    const fake = createFakeD1(); const db = fake as unknown as Db;
    await expect(store.saveSessionConfig(db, P, [L], input(M, "Eve", "E"))).rejects.toBeInstanceOf(store.UnknownAccountError);
    await expect(store.deleteSessionConfig(db, P, [L], "Eve", M)).rejects.toBeInstanceOf(store.UnknownAccountError);
    expect(fake.dump("chat_configs")).toHaveLength(0);
  });

  it("ある置き場所に別のアカウントの行があっても返さない（アカウントを取り違えない）", async () => {
    const fake = createFakeD1(); const db = fake as unknown as Db;
    await store.saveConfig(db, P, input(L, "Carol", "C"));
    const both = await store.openSessionConfigs(db, P, [L]);
    expect(find(both.configs, L, "Carol")).toBeUndefined();
  });
});

describe("共通設定とアカウント設定", () => {
  it("共通設定は全アカウントに書かれ、どちらでログインしても同じになる", async () => {
    const fake = createFakeD1(); const db = fake as unknown as Db;
    await store.saveCommonSettings(db, P, [L], { inbox: false, iconLabels: true }, 1000);
    const alone = await store.openSessionConfigs(db, L, []);
    const g = alone.configs.find(c => c.chat_id === store.GLOBAL_SETTINGS_CHAT_ID);
    expect(JSON.parse(g!.custom_name!)).toEqual({ inbox: false, iconLabels: true, updatedAt: 1000 });
  });

  it("あとから足したアカウントにも、一番新しい共通設定を写す", async () => {
    const fake = createFakeD1(); const db = fake as unknown as Db;
    await store.saveCommonSettings(db, P, [], { trash: true }, 1000);
    // M は以前に単独で使っていて、古い共通設定を持っている
    await store.saveCommonSettings(db, M, [], { trash: false }, 500);
    const res = await store.openSessionConfigs(db, P, [M]);
    expect(JSON.parse(res.configs.find(c => c.chat_id === store.GLOBAL_SETTINGS_CHAT_ID)!.custom_name!)).toMatchObject({ trash: true, updatedAt: 1000 });
    const mAlone = await store.openSessionConfigs(db, M, []);
    expect(JSON.parse(mAlone.configs.find(c => c.chat_id === store.GLOBAL_SETTINGS_CHAT_ID)!.custom_name!)).toMatchObject({ trash: true });
  });

  it("共通設定が無ければ共通設定の行は返さない", async () => {
    const fake = createFakeD1(); const db = fake as unknown as Db;
    expect((await store.openSessionConfigs(db, P, [L])).configs).toEqual([]);
  });

  it("アカウント設定はアカウントごとに分かれ、無ければ空", async () => {
    const fake = createFakeD1(); const db = fake as unknown as Db;
    let res = await store.openSessionConfigs(db, P, [L]);
    expect(res.accountSettings).toEqual({ [P]: {}, [L]: {} });
    await store.saveAccountSettings(db, L, { alwaysLoadImages: true, other: 1 });
    res = await store.openSessionConfigs(db, P, [L]);
    expect(res.accountSettings[P]).toEqual({});
    expect(res.accountSettings[L]).toEqual({ alwaysLoadImages: true });
    expect((await store.openSessionConfigs(db, L, [])).accountSettings[L]).toEqual({ alwaysLoadImages: true });
    expect(JSON.stringify(fake.dump("chat_configs"))).not.toContain("example.com");
  });
});
