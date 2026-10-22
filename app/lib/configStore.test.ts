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

describe("saveGlobalSettings（どの端末でも共通の設定）", () => {
  it("ほかの値を残したまま書き換え、読み直すと同じ値が返る。行は暗号化され、アドレスは D1 に残らない", async () => {
    const fake = createFakeD1();
    stage.hashed = true;
    // 以前の形（平文のアドレス・平文の JSON）の行
    fake.prepare("INSERT INTO chat_configs (user_email, account_email, chat_id, custom_name) VALUES (?, ?, ?, ?)")
      .bind("user@example.com", "", "__GLOBAL_SETTINGS__", JSON.stringify({ inbox: false, limit: 50 })).exec();
    const db = fake as unknown as Db;

    const saved = await store.saveGlobalSettings(db, "user@example.com", { alwaysLoadImages: true, accounts: { "work@example.com": false }, extra: "x" });
    expect(saved).toEqual({ inbox: false, alwaysLoadImages: true, accounts: { "work@example.com": false } });
    const rows = fake.dump("chat_configs");
    expect(rows).toHaveLength(1);
    expect(String(rows[0].custom_name)).toMatch(/^encv1:/);
    expect(JSON.stringify(rows)).not.toContain("example.com");

    // 読み込み（GET）と同じ道筋で、元の値に戻る
    const opened = await store.openAndMigrateConfigs(db, "user@example.com");
    const g = opened.find(o => o.chat_id === store.GLOBAL_SETTINGS_CHAT_ID);
    expect(g?.account_email).toBe("");
    expect(await store.openGlobalSettings(g?.custom_name)).toEqual(saved);

    // 一部だけ書き換える
    expect(await store.saveGlobalSettings(db, "user@example.com", { alwaysLoadImages: false })).toEqual({ ...saved, alwaysLoadImages: false });
    expect(fake.dump("chat_configs")).toHaveLength(1);
  });

  it("壊れた値が入っていても作り直して保存できる", async () => {
    const fake = createFakeD1();
    stage.hashed = true;
    const db = fake as unknown as Db;
    await store.saveGlobalSettings(db, "user@example.com", { iconLabels: true });
    fake.prepare("UPDATE chat_configs SET custom_name = ?").bind("encv1:壊れた:値").exec();
    expect(await store.saveGlobalSettings(db, "user@example.com", { iconLabels: false })).toEqual({ iconLabels: false });
  });

  it("鍵が無く暗号化できないときは、アドレスを含む値を保存しない", async () => {
    const fake = createFakeD1();
    const key = process.env.TOKEN_ENCRYPTION_KEY;
    delete process.env.TOKEN_ENCRYPTION_KEY;
    try {
      const saved = await store.saveGlobalSettings(fake as unknown as Db, "user@example.com", { inbox: true, accounts: { "work@example.com": true } });
      expect(saved).toEqual({ inbox: true });
      expect(JSON.stringify(fake.dump("chat_configs"))).not.toContain("work@example.com");
    } finally {
      process.env.TOKEN_ENCRYPTION_KEY = key;
    }
  });
});
