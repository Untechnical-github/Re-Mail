// テスト専用：D1 と同じ使い方（prepare → bind → all / run、batch）ができる、メモリ上の SQLite。
// 移行の SQL を本物の SQLite で動かして確かめるために使う（Node 標準の node:sqlite を使い、依存は増やさない）
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

type SqliteStatement = { all: (...args: unknown[]) => unknown[]; run: (...args: unknown[]) => unknown };
type SqliteDb = { exec: (sql: string) => void; prepare: (sql: string) => SqliteStatement };

export type FakeStatement = { bind: (...args: unknown[]) => FakeStatement; all: () => Promise<{ results: unknown[] }>; run: () => Promise<{ success: boolean }>; exec: () => void };
export type FakeD1 = { prepare: (sql: string) => FakeStatement; batch: (stmts: FakeStatement[]) => Promise<unknown[]>; dump: (table: string) => Record<string, unknown>[]; applyMigration: (file: string) => void };

export const MIGRATIONS = ["0001_initial.sql", "0002_linked_accounts_account_enc.sql", "0003_drop_legacy_rows.sql"];
const readMigration = (f: string) => readFileSync(new URL(`../../migrations/${f}`, import.meta.url), "utf8");

// migrations に当てるマイグレーションを渡せる（途中まで当て、データを入れてから残りを当てる、を確かめるため）
export function createFakeD1(migrations: string[] = MIGRATIONS): FakeD1 {
  // node:sqlite は @types/node のこの版には型が無いので、使う分だけの型で受け取る
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (path: string) => SqliteDb };
  const db = new DatabaseSync(":memory:");
  for (const f of migrations) db.exec(readMigration(f));
  const prepare = (sql: string): FakeStatement => {
    let args: unknown[] = [];
    const stmt: FakeStatement = {
      bind: (...a: unknown[]) => { args = a; return stmt; },
      all: async () => ({ results: db.prepare(sql).all(...args) }),
      run: async () => { db.prepare(sql).run(...args); return { success: true }; },
      exec: () => { db.prepare(sql).run(...args); },
    };
    return stmt;
  };
  return {
    prepare,
    // D1 の batch と同じく、まとめて成功するか、まとめて取り消す
    batch: async (stmts) => {
      db.exec("BEGIN");
      try { for (const s of stmts) s.exec(); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; }
      return [];
    },
    applyMigration: (file) => db.exec(readMigration(file)),
    dump: (table) => db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[],
  };
}
