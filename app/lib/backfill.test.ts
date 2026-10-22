import { describe, it, expect, vi, beforeAll } from "vitest";
import { createFakeD1 } from "./fakeD1.testutil";

const stage = vi.hoisted(() => ({ hashed: true }));
vi.mock("./addressStage", () => ({ get WRITE_HASHED_ADDRESS() { return stage.hashed; } }));

type Backfill = typeof import("./backfill");
let backfill: Backfill;
type Db = Parameters<Backfill["runBackfill"]>[0];

beforeAll(async () => {
  // テスト用の鍵（本物の鍵ではない）
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString("base64");
  backfill = await import("./backfill");
});

function seed(fake: ReturnType<typeof createFakeD1>) {
  const cfg = (user: string, account: string, chatId: string, customName: string | null) =>
    fake.prepare("INSERT INTO chat_configs (user_email, account_email, chat_id, custom_name) VALUES (?, ?, ?, ?)").bind(user, account, chatId, customName).exec();
  // 二度と Re:Mail を開かない2人の、古い形の行（平文のアドレス・相手名・ピン留めの本体）
  cfg("alice@example.com", "alice@example.com", "田中太郎", JSON.stringify({ forceFetch: true, data: [{ id: "aaa111", body: "秘密の本文" }] }));
  cfg("alice@example.com", "", "__GLOBAL_SETTINGS__", JSON.stringify({ limit: 50 }));
  cfg("bob@example.com", "bob-work@example.com", "group:x", JSON.stringify({ name: "取引先", isGroup: true, groupMemberAddresses: ["client@example.com"] }));
  fake.prepare("INSERT INTO linked_accounts (user_email, account_email, refresh_token, name, picture) VALUES (?, ?, ?, ?, ?)")
    .bind("bob@example.com", "bob-work@example.com", "encv1:x:y", "ボブ仕事用", "https://example.com/b.png").exec();
}

describe("runBackfill（開かれない利用者の行も置き換える）", () => {
  it("全員の行を置き換え、D1 に平文のアドレス・相手名・本文・表示名が残らない。もう一度実行しても何も変えない", async () => {
    const fake = createFakeD1();
    seed(fake);
    stage.hashed = true;
    expect(await backfill.runBackfill(fake as unknown as Db)).toEqual({ configUsers: 2, linkedUsers: 1 });
    const raw = JSON.stringify([fake.dump("chat_configs"), fake.dump("linked_accounts")]);
    for (const s of ["alice@", "bob@", "bob-work@", "client@", "田中", "取引先", "秘密の本文", "ボブ仕事用", "example.com/b.png"]) expect(raw).not.toContain(s);
    expect(fake.dump("chat_configs")).toHaveLength(3);
    expect(fake.dump("linked_accounts")).toHaveLength(1);
    expect(await backfill.runBackfill(fake as unknown as Db)).toEqual({ configUsers: 0, linkedUsers: 0 });
  });

  it("段階1のあいだは何もしない", async () => {
    const fake = createFakeD1();
    seed(fake);
    stage.hashed = false;
    expect(await backfill.runBackfill(fake as unknown as Db)).toEqual({ configUsers: 0, linkedUsers: 0 });
    expect(JSON.stringify(fake.dump("chat_configs"))).toContain("alice@example.com");
  });
});
