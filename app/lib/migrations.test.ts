// migrations/0003_drop_legacy_rows.sql が、古い形式の行だけを消し、今の形式の連携アカウントを残すことを本物の SQLite で確かめる
import { describe, it, expect, beforeAll } from "vitest";
import { createFakeD1, MIGRATIONS } from "./fakeD1.testutil";

type Store = typeof import("./linkedAccountsStore");
let store: Store;
type Db = Parameters<Store["findLinkedAccount"]>[0];

beforeAll(async () => {
  // テスト用の鍵（本物の鍵ではない）
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 4).toString("base64");
  store = await import("./linkedAccountsStore");
});

const ME = "owner@example.com";

describe("0003_drop_legacy_rows", () => {
  it("chat_configs はすべて消え、linked_accounts は今の形式の行だけが残る（残った行はそのまま使える）", async () => {
    const fake = createFakeD1(MIGRATIONS.filter(f => !f.startsWith("0003")));
    const db = fake as unknown as Db;
    // 今の形式の行（コードで保存したもの）
    await store.saveLinkedAccount(db, ME, "keep@example.com", { refreshToken: "rt", accessToken: "at", expiresAt: 1, name: "残す", picture: null });
    await store.saveLinkedAccount(db, ME, "keep2@example.com", { refreshToken: "rt", accessToken: null, expiresAt: null, name: null, picture: null });
    const good = fake.dump("linked_accounts")[0];
    const insert = (row: Record<string, unknown>) => {
      const r = { ...good, ...row };
      fake.prepare("INSERT INTO linked_accounts (user_email, account_email, account_enc, refresh_token, access_token, expires_at, created_at, needs_reauth, name, picture) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(r.user_email, r.account_email, r.account_enc, r.refresh_token, r.access_token, r.expires_at, r.created_at, r.needs_reauth, r.name, r.picture).exec();
    };
    // 古い形式の行（どれか1つでも当てはまれば消す）
    insert({ user_email: ME, account_email: "a1:x1" });                         // 平文の user_email
    insert({ account_email: "old@example.com" });                              // 平文の account_email
    insert({ account_email: "A1:x3" });                                        // 大文字の印（今の形式ではない）
    insert({ account_email: "a1:x4", account_enc: null });                     // アドレスの暗号文が無い
    insert({ account_email: "a1:x5", account_enc: "old@example.com" });        // アドレスが平文
    insert({ account_email: "a1:x6", refresh_token: "rt-plain" });            // トークンが平文
    insert({ account_email: "a1:x7", access_token: "at-plain" });             // アクセストークンが平文
    insert({ account_email: "a1:x8", name: "平文の名前" });                    // 名前が平文
    insert({ account_email: "a1:x9", picture: "https://example.com/p.png" }); // 画像の URL が平文
    fake.prepare("INSERT INTO chat_configs (user_email, account_email, chat_id, custom_name) VALUES (?, ?, ?, ?)").bind(ME, ME, "田中太郎", "{\"data\":[]}").exec();
    fake.prepare("INSERT INTO chat_configs (user_email, account_email, chat_id, custom_name) VALUES (?, ?, ?, ?)").bind("a1:u", "", "__KNOWN_BOXES__", null).exec();

    fake.applyMigration("0003_drop_legacy_rows.sql");

    expect(fake.dump("chat_configs")).toEqual([]);
    expect(fake.dump("linked_accounts")).toHaveLength(2);
    expect((await store.listLinkedAccounts(db, ME)).map(a => a.account_email).sort()).toEqual(["keep2@example.com", "keep@example.com"]);
    expect((await store.findLinkedAccount(db, ME, "keep@example.com"))?.refresh_token.startsWith("encv1:")).toBe(true);
  });
});
