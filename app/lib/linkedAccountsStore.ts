// 連携アカウント（linked_accounts）の読み書き。自分のアドレス（user_email・account_email）は「a1:」＋HMAC に置き換え、
// 元の連携アカウントのアドレス・トークン・表示名・プロフィール画像の URL は暗号化して保存する（絶対ルール1）。
// 鍵が無ければ例外にする（平文で書く道は無い）
import { addressKeyFor, normalizeAddress } from "./addressKey";
import { decryptSecret, encryptSecret, hmacId } from "./tokenCrypto";
import { logError, logInfo } from "./safeLog";

type Db = CloudflareEnv["DB"];

export type LinkedAccountRow = {
  user_email: string;
  account_email: string;
  account_enc?: string | null;
  refresh_token: string;
  access_token: string | null;
  expires_at: number | null;
  created_at?: string | null;
  needs_reauth: number | null;
  name?: string | null;
  picture?: string | null;
};

const INSERT_SQL = `INSERT INTO linked_accounts (user_email, account_email, account_enc, refresh_token, access_token, expires_at, created_at, needs_reauth, name, picture)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_email, account_email) DO UPDATE SET
       account_enc=excluded.account_enc, refresh_token=excluded.refresh_token, access_token=excluded.access_token,
       expires_at=excluded.expires_at, needs_reauth=excluded.needs_reauth, name=excluded.name, picture=excluded.picture`;

const addressKey = (email: string) => addressKeyFor(email, hmacId);
const openOptional = async (v: string | null | undefined) => (v ? await decryptSecret(v) : null);

// 1つの連携アカウントの行（トークンを取り出すため）。更新はこの行のキーに対して行う
export async function findLinkedAccount(db: Db, userEmail: string, accountEmail: string): Promise<LinkedAccountRow | null> {
  const { results } = await db.prepare("SELECT * FROM linked_accounts WHERE user_email = ? AND account_email = ?")
    .bind(await addressKey(userEmail), await addressKey(accountEmail)).all();
  return ((results || []) as LinkedAccountRow[])[0] || null;
}

async function rowsOf(db: Db, userEmail: string): Promise<LinkedAccountRow[]> {
  const { results } = await db.prepare("SELECT * FROM linked_accounts WHERE user_email = ?").bind(await addressKey(userEmail)).all();
  return (results || []) as LinkedAccountRow[];
}

// 本人の連携アカウントの一覧（画面に出すため、アドレス・表示名・画像 URL は元に戻して返す）。
// 開けない行は飛ばす（ほかのアカウントは使えるように）
export async function listLinkedAccounts(db: Db, userEmail: string): Promise<{ account_email: string; needs_reauth: number | null; name: string | null; picture: string | null }[]> {
  const out: { account_email: string; needs_reauth: number | null; name: string | null; picture: string | null }[] = [];
  for (const row of await rowsOf(db, userEmail)) {
    try {
      const accountEmail = await decryptSecret(row.account_enc);
      if (!accountEmail) { logError("accounts.openRow.noAccount", {}); continue; }
      out.push({ account_email: accountEmail, needs_reauth: row.needs_reauth, name: await openOptional(row.name), picture: await openOptional(row.picture) });
    } catch (e) {
      logError("accounts.openRow", {}, e);
    }
  }
  return out;
}

// 連携した（し直した）アカウントを保存する
export async function saveLinkedAccount(db: Db, userEmail: string, accountEmail: string, v: { refreshToken: string; accessToken: string | null; expiresAt: number | null; name: string | null; picture: string | null }): Promise<void> {
  await db.prepare(INSERT_SQL).bind(
    await addressKey(userEmail), await addressKey(accountEmail), await encryptSecret(accountEmail),
    await encryptSecret(v.refreshToken), v.accessToken ? await encryptSecret(v.accessToken) : null, v.expiresAt, new Date().toISOString(), 0,
    v.name ? await encryptSecret(v.name) : null,
    v.picture ? await encryptSecret(v.picture) : null,
  ).run();
}

// 連携を解除する
export async function deleteLinkedAccount(db: Db, userEmail: string, accountEmail: string): Promise<void> {
  await db.prepare("DELETE FROM linked_accounts WHERE user_email = ? AND account_email = ?")
    .bind(await addressKey(userEmail), await addressKey(accountEmail)).run();
}

// ログイン中のアカウント（from）だけをログアウトし、残りのアカウントの1つ（to）にログインを引き継ぐ。
// - to のトークン・表示名・画像を返す（ログインのセッションを to のものに置き換えるため）
// - from に付いていたほかのアカウントは、to に付け替える（暗号化した値は持ち主に関係なく同じ鍵で読めるので、そのまま写す）
// - from の行はすべて消す（ログアウトしたアカウントのトークンを残さない）
// to が from に付いていない・再ログインが必要なときは null（何も変えない）
export async function promoteLinkedAccount(db: Db, from: string, to: string): Promise<{ refreshToken: string; accessToken: string | null; expiresAt: number | null; name: string | null; picture: string | null } | null> {
  const target = await findLinkedAccount(db, from, to);
  if (!target || target.needs_reauth) return null;
  const refreshToken = await openOptional(target.refresh_token);
  if (!refreshToken) return null;

  const fromKey = await addressKey(from);
  const toKey = await addressKey(to);
  const stmts = [];
  for (const row of await rowsOf(db, from)) {
    // 引き継ぐアカウント自身の行は写さない（自分自身に自分は付けない）
    if (row.account_email === toKey || !row.account_enc) continue;
    const accountEmail = await decryptSecret(row.account_enc);
    if (!accountEmail || normalizeAddress(accountEmail) === normalizeAddress(from)) continue;
    stmts.push(db.prepare(INSERT_SQL).bind(
      toKey, row.account_email, row.account_enc, row.refresh_token, row.access_token, row.expires_at,
      row.created_at ?? new Date().toISOString(), row.needs_reauth ?? 0, row.name ?? null, row.picture ?? null,
    ));
  }
  stmts.push(db.prepare("DELETE FROM linked_accounts WHERE user_email = ?").bind(fromKey));
  // 写すのと消すのは同じバッチで行う（途中で失われないように）
  await db.batch(stmts);
  logInfo("accounts.promote", { count: stmts.length - 1 });
  return {
    refreshToken,
    accessToken: await openOptional(target.access_token),
    expiresAt: target.expires_at,
    name: await openOptional(target.name ?? null),
    picture: await openOptional(target.picture ?? null),
  };
}

// 一緒にログインしているアカウントのアドレスだけ（設定の読み書きのたびに使う）。
// listLinkedAccounts と違い、表示名・画像は復号しない
export async function listLinkedAccountEmails(db: Db, userEmail: string): Promise<string[]> {
  const { results } = await db.prepare("SELECT account_enc FROM linked_accounts WHERE user_email = ?").bind(await addressKey(userEmail)).all();
  const out: string[] = [];
  for (const row of (results || []) as { account_enc: string | null }[]) {
    try {
      const email = await decryptSecret(row.account_enc);
      if (email && !out.some(e => normalizeAddress(e) === normalizeAddress(email))) out.push(email);
    } catch (e) {
      // 開けない行は飛ばす（ほかのアカウントの設定は読めるように）
      logError("accounts.listEmails", {}, e);
    }
  }
  return out;
}
