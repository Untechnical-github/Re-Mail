import { describe, it, expect, vi, beforeAll } from "vitest";
import { createFakeD1, type FakeD1 } from "../../lib/fakeD1.testutil";

// ログインと D1 の接続だけを差し替える（SQL は本物の SQLite で動かす）
const ME = "owner@example.com";
const ctx = vi.hoisted(() => ({ db: null as unknown, hashed: false }));
vi.mock("../../../auth", () => ({ auth: async () => ({ user: { email: "owner@example.com" } }) }));
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: () => ({ env: { DB: ctx.db } }) }));
vi.mock("../../lib/addressStage", () => ({ get WRITE_HASHED_ADDRESS() { return ctx.hashed; } }));

type Route = typeof import("./route");
let route: Route;

beforeAll(async () => {
  // テスト用の鍵（本物の鍵ではない）
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
  route = await import("./route");
});

const get = async () => ((await (await route.GET(new Request("https://x/api/config"))).json()) as { configs: Record<string, unknown>[] }).configs;
const post = (body: Record<string, unknown>) => route.POST(new Request("https://x/api/config", { method: "POST", body: JSON.stringify(body) }));
const del = (chatId: string, account: string) => route.DELETE(new Request(`https://x/api/config?chat_id=${encodeURIComponent(chatId)}&account_email=${encodeURIComponent(account)}`, { method: "DELETE" }));
const sorted = (rows: Record<string, unknown>[]) => [...rows].sort((a, b) => `${a.account_email}${a.chat_id}`.localeCompare(`${b.account_email}${b.chat_id}`));

function seedLegacy(fake: FakeD1) {
  // 暗号化を入れる前の形の行（平文の相手名・ピン留めの本体つき）と、予約行
  const insert = (account: string, chatId: string, customName: string | null, pinned = 0) =>
    fake.prepare("INSERT INTO chat_configs (user_email, account_email, chat_id, custom_name, is_pinned, is_hidden, hidden_at_date, unhide_on_new) VALUES (?, ?, ?, ?, ?, 0, NULL, 0)")
      .bind(ME, account, chatId, customName, pinned).exec();
  insert(ME, "田中太郎", JSON.stringify({ name: "田中さん", forceFetch: true, data: [{ id: "aaa111", subject: "件名", body: "本文" }] }), 1);
  insert("linked@example.com", "group:abc", JSON.stringify({ name: "仕事", isGroup: true, groupMembers: ["山田"], groupMemberAddresses: ["yamada@example.com"] }));
  insert("", "__GLOBAL_SETTINGS__", JSON.stringify({ limit: 100 }));
}

describe("/api/config（自分のアドレス・相手名を D1 のキーから外す移行）", () => {
  it("古い形の行を段階2で読むと置き換わり、D1 に平文のアドレス・相手名・本体が残らない。画面に返る値は変わらない（本体だけは消える）", async () => {
    const fake = createFakeD1();
    ctx.db = fake;
    seedLegacy(fake);
    ctx.hashed = false;
    const before = sorted(await get());
    expect(before).toHaveLength(3);
    expect(JSON.stringify(before)).not.toContain("本文"); // 本体は画面にも返さない

    ctx.hashed = true;
    const after = sorted(await get());
    expect(after).toEqual(before);
    const raw = JSON.stringify(fake.dump("chat_configs"));
    for (const s of [ME, "linked@example.com", "田中", "山田", "yamada@example.com", "仕事", "本文"]) expect(raw).not.toContain(s);
    expect(fake.dump("chat_configs")).toHaveLength(3);
    // もう一度読んでも同じで、行も増えない
    expect(sorted(await get())).toEqual(before);
    expect(fake.dump("chat_configs")).toHaveLength(3);

    // 段階1のコードに戻しても読める
    ctx.hashed = false;
    expect(sorted(await get())).toEqual(before);
  });

  it("段階2で保存・上書き・削除ができ、同じ設定の古い形の行は残らない", async () => {
    const fake = createFakeD1();
    ctx.db = fake;
    seedLegacy(fake);
    ctx.hashed = true;
    await post({ chat_id: "田中太郎", account_email: ME, custom_name: "名前を変えた", is_pinned: true });
    let configs = await get();
    expect(configs.find((c) => c.chat_id === "田中太郎")).toMatchObject({ custom_name: "名前を変えた", is_pinned: 1, account_email: ME });
    expect(fake.dump("chat_configs")).toHaveLength(3);

    await del("田中太郎", ME);
    configs = await get();
    expect(configs.find((c) => c.chat_id === "田中太郎")).toBeUndefined();
    expect(fake.dump("chat_configs")).toHaveLength(2);
  });

  it("段階1のまま古い形の行を消せる", async () => {
    const fake = createFakeD1();
    ctx.db = fake;
    seedLegacy(fake);
    ctx.hashed = false;
    await del("group:abc", "linked@example.com");
    expect((await get()).find((c) => c.chat_id === "group:abc")).toBeUndefined();
  });
});
