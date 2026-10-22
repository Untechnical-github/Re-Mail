// アカウントごとの置き場所（configStore.ts の openSessionConfigs ほか）のテスト。本物の SQL（node:sqlite）で確かめる
import { describe, it, expect, vi, beforeAll } from "vitest";
import { createFakeD1 } from "./fakeD1.testutil";

vi.mock("./addressStage", () => ({ WRITE_HASHED_ADDRESS: true }));
const stage = vi.hoisted(() => ({ legacy: true }));
vi.mock("./configStage", () => ({ get WRITE_LEGACY_LINKED_COPY() { return stage.legacy; } }));

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
  it("連携アカウントのチャットの設定は、そのアカウントの置き場所に保存され、そのアカウントだけでログインしても見える", async () => {
    const fake = createFakeD1(); const db = fake as unknown as Db;
    stage.legacy = true;
    await store.saveSessionConfig(db, P, [L], input(L, "Alice", "仕事のAlice", { is_pinned: true }));
    // 連携アカウントで直接ログインしたとき
    const alone = await store.openSessionConfigs(db, L, []);
    expect(find(alone.configs, L, "Alice")).toMatchObject({ custom_name: "仕事のAlice", is_pinned: 1 });
    // 段階1：古いコードに戻しても見えるよう、メインアカウントの置き場所にも同じものがある
    expect(find(await store.openAndMigrateConfigs(db, P), L, "Alice")).toMatchObject({ custom_name: "仕事のAlice" });
    // 2つ同時にログインしているときは1つにまとまって返る
    const both = await store.openSessionConfigs(db, P, [L]);
    expect(both.configs.filter(r => r.chat_id === "Alice")).toHaveLength(1);
    // D1 にアドレス・名前が平文で残らない
    expect(JSON.stringify(fake.dump("chat_configs"))).not.toMatch(/example\.com|Alice/);
  });

  it("段階2では以前の置き場所に書かない", async () => {
    const fake = createFakeD1(); const db = fake as unknown as Db;
    stage.legacy = false;
    await store.saveSessionConfig(db, P, [L], input(L, "Bob", "B"));
    expect(find(await store.openAndMigrateConfigs(db, P), L, "Bob")).toBeUndefined();
    expect(find(await store.openAndMigrateConfigs(db, L), L, "Bob")).toBeDefined();
    stage.legacy = true;
  });

  it("以前の置き場所（メインアカウント）にだけある連携アカウントの設定は、読んだときにそのアカウントの置き場所へ写す", async () => {
    const fake = createFakeD1(); const db = fake as unknown as Db;
    // 以前のコードの保存のしかた
    await store.saveConfig(db, P, input(L, "Carol", "C", { is_hidden: true }));
    expect(find(await store.openAndMigrateConfigs(db, L), L, "Carol")).toBeUndefined();
    const both = await store.openSessionConfigs(db, P, [L]);
    expect(find(both.configs, L, "Carol")).toMatchObject({ is_hidden: 1 });
    expect(find(await store.openAndMigrateConfigs(db, L), L, "Carol")).toMatchObject({ custom_name: "C", is_hidden: 1 });
  });

  it("自分の置き場所の値が、以前の置き場所の値より優先される", async () => {
    const fake = createFakeD1(); const db = fake as unknown as Db;
    await store.saveConfig(db, P, input(L, "Dan", "古い名前"));
    await store.saveConfig(db, L, input(L, "Dan", "新しい名前"));
    const both = await store.openSessionConfigs(db, P, [L]);
    expect(find(both.configs, L, "Dan")?.custom_name).toBe("新しい名前");
  });

  it("すべてのアカウントが対象のフィルターは、アカウントごとの別々のフィルターに分かれる（一番新しい写しをもとにする）", async () => {
    const fake = createFakeD1(); const db = fake as unknown as Db;
    const v1 = JSON.stringify({ name: "請求書", shared: true, updatedAt: 100, filterAction: "pin", filterCriteria: { conditionSets: [] } });
    await store.saveSessionConfig(db, P, [L], input(P, "filter:abc", v1), "shared");
    // 連携アカウントだけでログインして編集した（新しい）写し
    const v2 = JSON.stringify({ name: "請求書2", shared: true, updatedAt: 200, filterAction: "pin", filterCriteria: { conditionSets: [] } });
    await store.saveSessionConfig(db, L, [], input(L, "filter:abc", v2), "shared");
    const both = await store.openSessionConfigs(db, P, [L]);
    const rows = both.configs.filter(r => r.chat_id === "filter:abc");
    expect(rows).toHaveLength(2);
    const pRow = JSON.parse(find(rows, P, "filter:abc")!.custom_name!);
    const lRow = JSON.parse(find(rows, L, "filter:abc")!.custom_name!);
    expect(pRow).toMatchObject({ name: "請求書2", filterCriteria: { accountEmail: P } });
    expect(lRow).toMatchObject({ name: "請求書2", filterCriteria: { accountEmail: L } });
    expect(pRow.shared).toBeUndefined();
    // 分けたあとは別々：片方だけ変えても、もう片方は変わらない
    await store.saveSessionConfig(db, P, [L], input(L, "filter:abc", JSON.stringify({ ...lRow, name: "Lだけ" })));
    const again = await store.openSessionConfigs(db, P, [L]);
    expect(JSON.parse(find(again.configs, P, "filter:abc")!.custom_name!).name).toBe("請求書2");
    expect(JSON.parse(find(again.configs, L, "filter:abc")!.custom_name!).name).toBe("Lだけ");
    // それぞれ単独でログインしても、自分のフィルターとして見える
    expect(JSON.parse(find((await store.openSessionConfigs(db, L, [])).configs, L, "filter:abc")!.custom_name!).name).toBe("Lだけ");
    // 片方を消しても、もう片方は残る
    await store.deleteSessionConfig(db, P, [L], "filter:abc", L);
    const after = await store.openSessionConfigs(db, P, [L]);
    expect(find(after.configs, L, "filter:abc")).toBeUndefined();
    expect(find(after.configs, P, "filter:abc")).toBeDefined();
  });

  it("アカウントを決めていない以前のフィルターも、アカウントが2つ以上ならアカウントごとに分ける", async () => {
    const fake = createFakeD1(); const db = fake as unknown as Db;
    const f = JSON.stringify({ name: "古い", isGroup: true, filterCriteria: { conditionSets: [] } });
    await store.saveConfig(db, P, input(P, "group:old", f));
    // 1つのアカウントだけなら、そのまま
    expect(JSON.parse(find((await store.openSessionConfigs(db, P, [])).configs, P, "group:old")!.custom_name!).filterCriteria.accountEmail).toBeUndefined();
    const both = await store.openSessionConfigs(db, P, [L]);
    expect(JSON.parse(find(both.configs, P, "group:old")!.custom_name!).filterCriteria.accountEmail).toBe(P);
    expect(JSON.parse(find(both.configs, L, "group:old")!.custom_name!).filterCriteria.accountEmail).toBe(L);
  });

  it("以前メインアカウント名義で保存した「連携アカウントだけが対象のフィルター」は、そのアカウントへ移す", async () => {
    const fake = createFakeD1(); const db = fake as unknown as Db;
    const f = JSON.stringify({ name: "L用", filterAction: "hide", filterCriteria: { conditionSets: [], accountEmail: L } });
    await store.saveConfig(db, P, input(P, "filter:xyz", f));
    const both = await store.openSessionConfigs(db, P, [L]);
    expect(find(both.configs, L, "filter:xyz")?.custom_name).toBe(f);
    expect(find(both.configs, P, "filter:xyz")).toBeUndefined();
    expect(find((await store.openSessionConfigs(db, L, [])).configs, L, "filter:xyz")?.custom_name).toBe(f);
  });

  it("連携を解除したアカウントの行は、これまでどおりメインアカウントの分として返す", async () => {
    const fake = createFakeD1(); const db = fake as unknown as Db;
    await store.saveConfig(db, P, input(M, "Eve", "E"));
    const res = await store.openSessionConfigs(db, P, [L]);
    expect(find(res.configs, M, "Eve")?.custom_name).toBe("E");
  });

  it("グループの削除は、そのアカウントの置き場所と以前の置き場所の両方から消す", async () => {
    const fake = createFakeD1(); const db = fake as unknown as Db;
    await store.saveSessionConfig(db, P, [L], input(L, "group:g1", JSON.stringify({ name: "G", isGroup: true })));
    await store.deleteSessionConfig(db, P, [L], "group:g1", L);
    expect(find(await store.openAndMigrateConfigs(db, P), L, "group:g1")).toBeUndefined();
    expect(find(await store.openAndMigrateConfigs(db, L), L, "group:g1")).toBeUndefined();
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

  it("アカウント設定はアカウントごとに分かれ、無ければ以前の共通設定の値を初期値にする", async () => {
    const fake = createFakeD1(); const db = fake as unknown as Db;
    // 以前の共通設定に「外部の画像を毎回読み込む」があった
    await store.saveGlobalSettings(db, P, { alwaysLoadImages: true });
    let res = await store.openSessionConfigs(db, P, [L]);
    expect(res.accountSettings[P]).toEqual({ alwaysLoadImages: true });
    expect(res.accountSettings[L]).toEqual({ alwaysLoadImages: true });
    // 連携アカウントだけ「押したときだけ」に変える
    await store.saveAccountSettings(db, L, { alwaysLoadImages: false, other: 1 });
    res = await store.openSessionConfigs(db, P, [L]);
    expect(res.accountSettings[P]).toEqual({ alwaysLoadImages: true });
    expect(res.accountSettings[L]).toEqual({ alwaysLoadImages: false });
    expect((await store.openSessionConfigs(db, L, [])).accountSettings[L]).toEqual({ alwaysLoadImages: false });
    expect(JSON.stringify(fake.dump("chat_configs"))).not.toContain("example.com");
  });
});

describe("configMeta", () => {
  it("shared・updatedAt・フィルターの対象アカウントを読み、壊れた値では既定にする", () => {
    expect(store.configMeta(JSON.stringify({ shared: true, updatedAt: 5, filterCriteria: { accountEmail: L } }))).toEqual({ shared: true, updatedAt: 5, filterAccount: L });
    expect(store.configMeta("普通の名前")).toEqual({ shared: false, updatedAt: 0 });
    expect(store.configMeta("{壊れた")).toEqual({ shared: false, updatedAt: 0 });
    expect(store.configMeta(null)).toEqual({ shared: false, updatedAt: 0 });
  });
});
