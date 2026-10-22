// 連携アカウント（linked_accounts）の読み書き。自分のアドレス（user_email・account_email）は「a1:」＋HMAC に置き換え、
// 元の連携アカウントのアドレス・表示名・プロフィール画像の URL は暗号化して保存する（絶対ルール1）。
// 移行の途中は平文の行と置き換えた行が混ざるので、読むときは両方を探す（app/lib/addressStage.ts）
import { addressKeyFor, isAddressKey, normalizeAddress } from "./addressKey";
import { WRITE_HASHED_ADDRESS } from "./addressStage";
import { decryptSecret, encryptSecret, hmacId, isEncrypted } from "./tokenCrypto";
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

async function keysOf(email: string): Promise<[string, string]> {
  return [email, (await addressKeyFor(email, hmacId)) || email];
}

// 保存に使うキー（段階1では平文のまま）
async function targetKeys(userEmail: string, accountEmail: string): Promise<{ user: string; account: string }> {
  if (!WRITE_HASHED_ADDRESS) return { user: userEmail, account: accountEmail };
  return {
    user: (await addressKeyFor(userEmail, hmacId)) || userEmail,
    account: (await addressKeyFor(accountEmail, hmacId)) || accountEmail,
  };
}

// 新しい形の行ほど優先する（同じ連携アカウントが古い形と新しい形の両方にあるとき）
function rankOf(row: LinkedAccountRow): number {
  return (isAddressKey(row.user_email) ? 2 : 0) + (isAddressKey(row.account_email) ? 1 : 0);
}

// 1つの連携アカウントの行（トークンを取り出すため）。見つかった行のキーもそのまま返すので、更新はその行に対して行う
export async function findLinkedAccount(db: Db, userEmail: string, accountEmail: string): Promise<LinkedAccountRow | null> {
  const [u1, u2] = await keysOf(userEmail);
  const [a1, a2] = await keysOf(accountEmail);
  const { results } = await db.prepare(
    "SELECT * FROM linked_accounts WHERE user_email IN (?, ?) AND account_email IN (?, ?)"
  ).bind(u1, u2, a1, a2).all();
  const rows = (results || []) as LinkedAccountRow[];
  return rows.sort((x, y) => rankOf(y) - rankOf(x))[0] || null;
}

// 本人の連携アカウントの一覧（画面に出すため、アドレス・表示名・画像 URL は元に戻して返す）。
// 段階2では、古い形の行をここで新しい形に置き換える
export async function listLinkedAccounts(db: Db, userEmail: string): Promise<{ account_email: string; needs_reauth: number | null; name: string | null; picture: string | null }[]> {
  const [u1, u2] = await keysOf(userEmail);
  const { results } = await db.prepare("SELECT * FROM linked_accounts WHERE user_email IN (?, ?)").bind(u1, u2).all();
  const rows = (results || []) as LinkedAccountRow[];

  const byAccount = new Map<string, { row: LinkedAccountRow; accountEmail: string; name: string | null; picture: string | null }>();
  const duplicates: LinkedAccountRow[] = [];
  for (const row of rows) {
    let accountEmail = row.account_email;
    let name: string | null = null;
    let picture: string | null = null;
    try {
      if (isAddressKey(row.account_email)) {
        if (!row.account_enc) { logError("accounts.openRow.noAccount", {}); continue; }
        accountEmail = await decryptSecret(row.account_enc);
      }
      name = row.name ? await decryptSecret(row.name) : null;
      picture = row.picture ? await decryptSecret(row.picture) : null;
    } catch (e) {
      // 開けない行は消さずに残す（鍵の問題なら、直せばまた読めるため）
      logError("accounts.openRow", {}, e);
      continue;
    }
    const key = normalizeAddress(accountEmail);
    const prev = byAccount.get(key);
    if (prev && rankOf(prev.row) >= rankOf(row)) { duplicates.push(row); continue; }
    if (prev) duplicates.push(prev.row);
    byAccount.set(key, { row, accountEmail, name, picture });
  }

  if (WRITE_HASHED_ADDRESS) {
    try {
      const stmts = [];
      for (const { row, accountEmail, name, picture } of byAccount.values()) {
        const t = await targetKeys(userEmail, accountEmail);
        const done = row.user_email === t.user && row.account_email === t.account && !!row.account_enc
          && (!row.name || row.name.startsWith("encv1:")) && (!row.picture || row.picture.startsWith("encv1:"));
        if (done) continue;
        stmts.push(db.prepare(INSERT_SQL).bind(
          t.user, t.account, await encryptSecret(accountEmail), row.refresh_token, row.access_token, row.expires_at, row.created_at ?? null,
          row.needs_reauth ?? 0, name ? await encryptSecret(name) : null, picture ? await encryptSecret(picture) : null,
        ));
        if (row.user_email !== t.user || row.account_email !== t.account) {
          stmts.push(db.prepare("DELETE FROM linked_accounts WHERE user_email = ? AND account_email = ?").bind(row.user_email, row.account_email));
        }
      }
      for (const row of duplicates) stmts.push(db.prepare("DELETE FROM linked_accounts WHERE user_email = ? AND account_email = ?").bind(row.user_email, row.account_email));
      if (stmts.length > 0) {
        await db.batch(stmts);
        logInfo("accounts.migrateRows", { count: stmts.length });
      }
    } catch (e) {
      logError("accounts.migrateRows", {}, e);
    }
  }

  return Array.from(byAccount.values()).map(({ row, accountEmail, name, picture }) => ({ account_email: accountEmail, needs_reauth: row.needs_reauth, name, picture }));
}

// 連携した（し直した）アカウントを保存する。同じアカウントの古い形の行は消す
export async function saveLinkedAccount(db: Db, userEmail: string, accountEmail: string, v: { refreshToken: string; accessToken: string | null; expiresAt: number | null; name: string | null; picture: string | null }): Promise<void> {
  const t = await targetKeys(userEmail, accountEmail);
  const hashed = WRITE_HASHED_ADDRESS;
  const [u1, u2] = await keysOf(userEmail);
  const [a1, a2] = await keysOf(accountEmail);
  await db.batch([
    db.prepare(INSERT_SQL).bind(
      t.user, t.account, hashed ? await encryptSecret(accountEmail) : null,
      await encryptSecret(v.refreshToken), v.accessToken ? await encryptSecret(v.accessToken) : null, v.expiresAt, new Date().toISOString(), 0,
      // 表示名・画像 URL は段階2から暗号化する（段階1より前のコードは、暗号化した値をそのまま画面に出してしまうため）
      v.name ? (hashed ? await encryptSecret(v.name) : v.name) : null,
      v.picture ? (hashed ? await encryptSecret(v.picture) : v.picture) : null,
    ),
    db.prepare("DELETE FROM linked_accounts WHERE user_email IN (?, ?) AND account_email IN (?, ?) AND NOT (user_email = ? AND account_email = ?)")
      .bind(u1, u2, a1, a2, t.user, t.account),
  ]);
}

// 連携を解除する（古い形・新しい形のどちらで保存されていても消す）
export async function deleteLinkedAccount(db: Db, userEmail: string, accountEmail: string): Promise<void> {
  const [u1, u2] = await keysOf(userEmail);
  const [a1, a2] = await keysOf(accountEmail);
  await db.prepare("DELETE FROM linked_accounts WHERE user_email IN (?, ?) AND account_email IN (?, ?)").bind(u1, u2, a1, a2).run();
}

// ログイン中のアカウント（from）だけをログアウトし、残りのアカウントの1つ（to）にログインを引き継ぐ。
// - to のトークン・表示名・画像を返す（ログインのセッションを to のものに置き換えるため）
// - from に付いていたほかのアカウントは、to に付け替える（暗号化した値は持ち主に関係なく同じ鍵で読めるので、そのまま写す）
// - from の行はすべて消す（ログアウトしたアカウントのトークンを残さない）
// to が from に付いていない・再ログインが必要なときは null（何も変えない）
export async function promoteLinkedAccount(db: Db, from: string, to: string): Promise<{ refreshToken: string; accessToken: string | null; expiresAt: number | null; name: string | null; picture: string | null } | null> {
  const target = await findLinkedAccount(db, from, to);
  if (!target || target.needs_reauth) return null;
  const open = async (v: string | null | undefined) => (v ? (isEncrypted(v) ? await decryptSecret(v) : v) : null);
  const refreshToken = await open(target.refresh_token);
  if (!refreshToken) return null;

  const [u1, u2] = await keysOf(from);
  const { results } = await db.prepare("SELECT * FROM linked_accounts WHERE user_email IN (?, ?)").bind(u1, u2).all();
  const rows = (results || []) as LinkedAccountRow[];
  const [t1, t2] = await keysOf(to);
  const stmts = [];
  for (const row of rows) {
    // 引き継ぐアカウント自身の行は写さない（自分自身に自分は付けない）
    if (row.account_email === t1 || row.account_email === t2) continue;
    const accountEmail = isAddressKey(row.account_email) ? (row.account_enc ? await decryptSecret(row.account_enc) : null) : row.account_email;
    if (!accountEmail || normalizeAddress(accountEmail) === normalizeAddress(from)) continue;
    const k = await targetKeys(to, accountEmail);
    stmts.push(db.prepare(INSERT_SQL).bind(
      k.user, k.account, row.account_enc ?? (WRITE_HASHED_ADDRESS ? await encryptSecret(accountEmail) : null), row.refresh_token, row.access_token, row.expires_at,
      row.created_at ?? new Date().toISOString(), row.needs_reauth ?? 0, row.name ?? null, row.picture ?? null,
    ));
  }
  stmts.push(db.prepare("DELETE FROM linked_accounts WHERE user_email IN (?, ?)").bind(u1, u2));
  // 写すのと消すのは同じバッチで行う（途中で失われないように）
  await db.batch(stmts);
  logInfo("accounts.promote", { count: stmts.length - 1 });
  return {
    refreshToken,
    accessToken: await open(target.access_token),
    expiresAt: target.expires_at,
    name: await open(target.name ?? null),
    picture: await open(target.picture ?? null),
  };
}


// 一緒にログインしているアカウントのアドレスだけ（設定の読み書きのたびに使う）。
// listLinkedAccounts と違い、表示名・画像は復号せず、行の書き直しもしない（アドレスの列だけを読む）
export async function listLinkedAccountEmails(db: Db, userEmail: string): Promise<string[]> {
  const [u1, u2] = await keysOf(userEmail);
  const { results } = await db.prepare("SELECT account_email, account_enc FROM linked_accounts WHERE user_email IN (?, ?)").bind(u1, u2).all();
  const out: string[] = [];
  for (const row of (results || []) as { account_email: string; account_enc: string | null }[]) {
    try {
      const email = isAddressKey(row.account_email) ? (row.account_enc ? await decryptSecret(row.account_enc) : "") : row.account_email;
      if (email && !out.some(e => normalizeAddress(e) === normalizeAddress(email))) out.push(email);
    } catch (e) {
      // 開けない行は飛ばす（ほかのアカウントの設定は読めるように）
      logError("accounts.listEmails", {}, e);
    }
  }
  return out;
}
