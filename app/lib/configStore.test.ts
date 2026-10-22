import { describe, it, expect, vi, beforeAll } from "vitest";
import { createFakeD1 } from "./fakeD1.testutil";

const stage = vi.hoisted(() => ({ hashed: true }));
vi.mock("./addressStage", () => ({ get WRITE_HASHED_ADDRESS() { return stage.hashed; } }));

type Store = typeof import("./configStore");
let store: Store;
type Db = Parameters<Store["saveGlobalSettings"]>[0];

beforeAll(async () => {
  // テスト用の鍵（本物の鍵ではない）
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
  store = await import("./configStore");
});

describe("sanitizeGlobalSettings", () => {
  it("決まった名前・型の値だけを残す（自由な文字列や知らない名前は入れない）", () => {
    expect(store.sanitizeGlobalSettings({ alwaysLoadImages: true, limit: 50, inbox: "yes", note: "user@example.com", spam: false })).toEqual({ alwaysLoadImages: true, limit: 50, spam: false });
    expect(store.sanitizeGlobalSettings(null)).toEqual({});
    expect(store.sanitizeGlobalSettings([true])).toEqual({});
    expect(store.sanitizeGlobalSettings({ limit: Infinity })).toEqual({});
  });
});

describe("saveGlobalSettings（どの端末でも共通の設定）", () => {
  it("ほかの値を残したまま書き換え、読み直すと画面に同じ値が返る。平文のアドレスは D1 に残さない", async () => {
    const fake = createFakeD1();
    stage.hashed = true;
    // 古い形（平文のアドレス）の行
    fake.prepare("INSERT INTO chat_configs (user_email, account_email, chat_id, custom_name) VALUES (?, ?, ?, ?)")
      .bind("user@example.com", "", "__GLOBAL_SETTINGS__", JSON.stringify({ limit: 50 })).exec();
    const db = fake as unknown as Db;

    expect(await store.saveGlobalSettings(db, "user@example.com", { alwaysLoadImages: true, extra: "x" })).toEqual({ limit: 50, alwaysLoadImages: true });
    const rows = fake.dump("chat_configs");
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain("user@example.com");

    const opened = await store.openAndMigrateConfigs(db, "user@example.com");
    const g = opened.find(o => o.chat_id === "__GLOBAL_SETTINGS__");
    expect(g?.account_email).toBe("");
    expect(JSON.parse(g?.custom_name || "{}")).toEqual({ limit: 50, alwaysLoadImages: true });

    // 元に戻す
    expect(await store.saveGlobalSettings(db, "user@example.com", { alwaysLoadImages: false })).toEqual({ limit: 50, alwaysLoadImages: false });
    expect(fake.dump("chat_configs")).toHaveLength(1);
  });

  it("壊れた値が入っていても作り直して保存できる", async () => {
    const fake = createFakeD1();
    stage.hashed = true;
    const db = fake as unknown as Db;
    await store.saveGlobalSettings(db, "user@example.com", { alwaysLoadImages: true });
    fake.prepare("UPDATE chat_configs SET custom_name = ?").bind("{壊れた").exec();
    expect(await store.saveGlobalSettings(db, "user@example.com", { alwaysLoadImages: true })).toEqual({ alwaysLoadImages: true });
  });
});
