import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { createFakeD1 } from "../../lib/fakeD1.testutil";

// ログインと D1 の接続だけを差し替える（SQL は本物の SQLite で動かす）
const ME = "owner@example.com";
const ctx = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../../../auth", () => ({ auth: async () => ({ user: { email: "owner@example.com" } }) }));
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: () => ({ env: { DB: ctx.db } }) }));

type Route = typeof import("./route");
let route: Route;

// テスト用の鍵（本物の鍵ではない）
const TEST_KEY = Buffer.alloc(32, 5).toString("base64");
beforeAll(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY;
  route = await import("./route");
});
beforeEach(() => { process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY; });

const get = async () => ((await (await route.GET(new Request("https://x/api/config"))).json()) as { configs: Record<string, unknown>[] }).configs;
const post = (body: Record<string, unknown>) => route.POST(new Request("https://x/api/config", { method: "POST", body: JSON.stringify(body) }));
const del = (chatId: string, account: string) => route.DELETE(new Request(`https://x/api/config?chat_id=${encodeURIComponent(chatId)}&account_email=${encodeURIComponent(account)}`, { method: "DELETE" }));

describe("/api/config", () => {
  it("保存・上書き・削除ができ、D1 に平文のアドレス・相手名が残らない", async () => {
    const fake = createFakeD1();
    ctx.db = fake;
    expect((await post({ chat_id: "田中太郎", account_email: ME, custom_name: "名前を変えた", is_pinned: true })).status).toBe(200);
    expect((await post({ global_settings: { inbox: false } })).status).toBe(200);
    let configs = await get();
    expect(configs.find((c) => c.chat_id === "田中太郎")).toMatchObject({ custom_name: "名前を変えた", is_pinned: 1, account_email: ME });
    expect(JSON.parse(String(configs.find((c) => c.chat_id === "__GLOBAL_SETTINGS__")?.custom_name))).toMatchObject({ inbox: false });
    expect(JSON.stringify(fake.dump("chat_configs"))).not.toMatch(/example\.com|田中|名前を変えた/);

    await del("田中太郎", ME);
    configs = await get();
    expect(configs.find((c) => c.chat_id === "田中太郎")).toBeUndefined();
  });

  it("ログイン中でないアカウントの設定は 400（保存しない）", async () => {
    const fake = createFakeD1();
    ctx.db = fake;
    expect((await post({ chat_id: "田中太郎", account_email: "stranger@example.com", custom_name: "x" })).status).toBe(400);
    expect((await del("田中太郎", "stranger@example.com")).status).toBe(400);
    expect(fake.dump("chat_configs")).toHaveLength(0);
  });

  it("鍵が無いと 500 を返し、D1 に何も書かない", async () => {
    const fake = createFakeD1();
    ctx.db = fake;
    delete process.env.TOKEN_ENCRYPTION_KEY;
    expect((await post({ chat_id: "田中太郎", account_email: ME, custom_name: "名前" })).status).toBe(500);
    expect((await post({ global_settings: { inbox: false } })).status).toBe(500);
    expect((await route.GET(new Request("https://x/api/config"))).status).toBe(500);
    expect(fake.dump("chat_configs")).toHaveLength(0);
  });
});
