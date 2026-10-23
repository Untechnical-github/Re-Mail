// 設定（chat_configs）の読み書き。/api/config から使う。
//
// D1 に個人情報を平文で置かない（絶対ルール1）。
// - chat_id（相手の名前・アドレス）は「h1:」＋HMAC、元の chat_id・custom_name（名前変更・グループ・フィルターの語）・
//   アカウントのアドレスはまとめて暗号化して保存する（app/lib/configCrypto.ts）
// - user_email・account_email（自分のアドレス）は「a1:」＋HMAC に置き換える（app/lib/addressKey.ts）
// - 予約行（account_email が空。__GLOBAL_SETTINGS__ / __ACCOUNT_SETTINGS__）は中身を暗号化する
// 鍵が無ければ例外にする（平文で書く道は無い）。画面とのやり取りは元のアドレス・chat_id・custom_name で行う
import { logError, logInfo } from "./safeLog";
import { decryptSecret, encryptSecret, hmacId } from "./tokenCrypto";
import { stripPinnedBodies } from "./pinnedIds";
import { addressKeyFor } from "./addressKey";
import { sanitizeSyncedSettings, sanitizeAccountSettings, newestCommonSettings, syncedSettingsKey, type SyncedSettings, type AccountSettings } from "./syncedSettings";
import { sealRow, openRow, isReservedRow, SEALED_CHAT_ID_PREFIX, type RowCrypto } from "./configCrypto";

type Db = CloudflareEnv["DB"];

const rowCrypto: RowCrypto = { hmac: hmacId, encrypt: encryptSecret, decrypt: decryptSecret };

type Row = {
  user_email: string;
  account_email: string;
  chat_id: string;
  custom_name?: string | null;
  is_pinned?: number | null;
  is_hidden?: number | null;
  hidden_at_date?: string | null;
  unhide_on_new?: number | null;
};

// 画面に返す形（元のアドレス・chat_id・custom_name）
export type OpenedConfig = Omit<Row, "user_email">;

const UPSERT_SQL = `INSERT INTO chat_configs (user_email, account_email, chat_id, custom_name, is_pinned, is_hidden, hidden_at_date, unhide_on_new)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_email, account_email, chat_id) DO UPDATE SET
       custom_name=excluded.custom_name,
       is_pinned=excluded.is_pinned,
       is_hidden=excluded.is_hidden,
       hidden_at_date=excluded.hidden_at_date,
       unhide_on_new=excluded.unhide_on_new`;

const addressKey = (email: string) => addressKeyFor(email, hmacId);

// そのアカウントの置き場所（user_email）にある設定をすべて読み、元の形に戻して返す。
// 開けない行（壊れた・今の形でない）は返さない（ほかの行の表示は止めない）。予約行は暗号化したまま返す
export async function openConfigs(db: Db, userEmail: string): Promise<OpenedConfig[]> {
  const { results } = await db.prepare("SELECT * FROM chat_configs WHERE user_email = ?").bind(await addressKey(userEmail)).all();
  const out: OpenedConfig[] = [];
  for (const row of (results || []) as Row[]) {
    const flags = { is_pinned: row.is_pinned, is_hidden: row.is_hidden, hidden_at_date: row.hidden_at_date, unhide_on_new: row.unhide_on_new };
    if (isReservedRow(row.account_email)) {
      out.push({ account_email: "", chat_id: row.chat_id, custom_name: row.custom_name ?? null, ...flags });
      continue;
    }
    const o = await openRow(row.chat_id, row.custom_name, rowCrypto);
    if (!o) { logError("config.openRow", {}); continue; }
    out.push({ account_email: o.accountEmail, chat_id: o.chatId, custom_name: o.customName, ...flags });
  }
  return out;
}

export type ConfigInput = {
  chat_id: string;
  account_email: string;
  custom_name: string | null;
  is_pinned?: boolean;
  is_hidden?: boolean;
  hidden_at_date?: string | null;
  unhide_on_new?: boolean;
};

// 1つの設定を、userEmail の置き場所に保存する
export async function saveConfig(db: Db, userEmail: string, input: ConfigInput): Promise<void> {
  // メールの中身（ピン留めの本体）は、送られてきても保存しない（絶対ルール1）
  const customName = stripPinnedBodies(input.custom_name) ?? null;
  const sealed = await sealRow(input.chat_id, customName, rowCrypto, input.account_email);
  await db.prepare(UPSERT_SQL).bind(
    await addressKey(userEmail), await addressKey(input.account_email), sealed.chatId, sealed.customName,
    input.is_pinned ? 1 : 0, input.is_hidden ? 1 : 0, input.hidden_at_date || null, input.unhide_on_new ? 1 : 0,
  ).run();
}

// 1つの設定を消す
export async function deleteConfig(db: Db, userEmail: string, chatId: string, accountEmail: string): Promise<void> {
  await db.prepare("DELETE FROM chat_configs WHERE user_email = ? AND account_email = ? AND chat_id = ?")
    .bind(await addressKey(userEmail), await addressKey(accountEmail), SEALED_CHAT_ID_PREFIX + (await hmacId(chatId))).run();
}

// どの端末でも共通の設定（account_email が空の予約行 __GLOBAL_SETTINGS__ に持つ）。
// 入れてよい設定の名前と型は app/lib/syncedSettings.ts で決め、それ以外は捨てる。
// アカウントのアドレスを含むので、行の中身はまとめて暗号化して保存する
export const GLOBAL_SETTINGS_CHAT_ID = "__GLOBAL_SETTINGS__";
export const ACCOUNT_SETTINGS_CHAT_ID = "__ACCOUNT_SETTINGS__";

// 保存されている（暗号化した）中身を設定に戻す。読めなければ空
export async function openGlobalSettings(customName: string | null | undefined): Promise<SyncedSettings> {
  if (!customName) return {};
  try {
    return sanitizeSyncedSettings(JSON.parse(await decryptSecret(customName)));
  } catch {
    return {};
  }
}

export async function openAccountSettings(customName: string | null | undefined): Promise<AccountSettings> {
  if (!customName) return {};
  try {
    return sanitizeAccountSettings(JSON.parse(await decryptSecret(customName)));
  } catch {
    return {};
  }
}

// 予約行（account_email が空）の中身を読む
async function readReservedRow(db: Db, userEmail: string, chatId: string): Promise<string | null> {
  const { results } = await db.prepare("SELECT custom_name FROM chat_configs WHERE user_email = ? AND account_email = '' AND chat_id = ?")
    .bind(await addressKey(userEmail), chatId).all();
  return ((results || []) as { custom_name: string | null }[])[0]?.custom_name ?? null;
}

// 予約行を、渡した値そのもので置き換える（暗号化して書く）
async function writeReservedRow(db: Db, userEmail: string, chatId: string, value: Record<string, unknown>): Promise<void> {
  await db.prepare(UPSERT_SQL).bind(await addressKey(userEmail), "", chatId, await encryptSecret(JSON.stringify(value)), 0, 0, null, 0).run();
}

// ---- アカウントごとの置き場所 ----
// 設定は「そのアカウント自身」の置き場所（user_email = そのアカウント）に保存する。こうすると、そのアカウントだけで
// ログインしても同じ設定で使える（ログインできる＝同じ人とみなす）。
// - アカウント設定・チャットの設定（ピン留め・非表示・名前変更・グループ・フィルター）：そのアカウントの置き場所
// - 共通設定：ログインしている全アカウントの置き場所に同じものを書き、一番新しいもの（updatedAt）を使う

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// ログイン中のアカウント（ログインのセッションを持つアカウント＋一緒にログインしているアカウント）。重複と空を除く
export function sessionAccountList(primary: string, linked: string[]): string[] {
  const out = [primary];
  for (const a of linked) if (a && !out.some(x => sameAddress(x, a))) out.push(a);
  return out;
}

// ログイン中でないアカウントの設定を読み書きしようとした（API は 400 を返す）
export class UnknownAccountError extends Error {
  constructor() {
    super("Unknown account");
    this.name = "UnknownAccountError";
  }
}

export type SessionConfigs = { configs: OpenedConfig[]; accountSettings: Record<string, AccountSettings> };

// ログイン中の全アカウントの設定を読み、画面に返す形にまとめる。
// 共通設定は一番新しい写しを使い、違う写し・無い写しを書き直す（あとから足したアカウントにも写す）
export async function openSessionConfigs(db: Db, primary: string, linked: string[]): Promise<SessionConfigs> {
  const accounts = sessionAccountList(primary, linked);
  const spaces = new Map<string, OpenedConfig[]>();
  for (const a of accounts) spaces.set(a, await openConfigs(db, a));

  // チャットの設定は、その置き場所のアカウントのものだけを返す
  const configs: OpenedConfig[] = [];
  for (const [owner, rows] of spaces) {
    for (const o of rows) {
      if (isReservedRow(o.account_email) || !sameAddress(o.account_email, owner)) continue;
      configs.push({ ...o, account_email: owner });
    }
  }

  const reservedOf = (a: string, chatId: string) => spaces.get(a)?.find(o => isReservedRow(o.account_email) && o.chat_id === chatId);

  // 共通設定：一番新しい写しを使う
  const globalCopies = await Promise.all(accounts.map(async (a) => ({ a, settings: await openGlobalSettings(reservedOf(a, GLOBAL_SETTINGS_CHAT_ID)?.custom_name) })));
  const common = newestCommonSettings(globalCopies.map(c => ({ settings: c.settings, preferred: c.a === primary })));
  const commonKey = syncedSettingsKey(common);
  const globalWrites = Object.keys(common).length > 0 ? globalCopies.filter(c => syncedSettingsKey(c.settings) !== commonKey).map(c => c.a) : [];

  // アカウント設定：そのアカウントの置き場所のもの
  const accountSettings: Record<string, AccountSettings> = {};
  for (const a of accounts) accountSettings[a] = await openAccountSettings(reservedOf(a, ACCOUNT_SETTINGS_CHAT_ID)?.custom_name);

  // 写しの書き直しは失敗しても読み込みは止めない（次に読んだときにまた試す）
  try {
    for (const a of globalWrites) await writeReservedRow(db, a, GLOBAL_SETTINGS_CHAT_ID, common);
    if (globalWrites.length > 0) logInfo("config.syncCommon", { count: globalWrites.length });
  } catch (e) {
    logError("config.syncCommon", {}, e);
  }

  // 共通設定は1行にまとめて返す（中身は復号した JSON）
  if (Object.keys(common).length > 0) configs.unshift({ account_email: "", chat_id: GLOBAL_SETTINGS_CHAT_ID, custom_name: JSON.stringify(common) });
  return { configs, accountSettings };
}

// ログイン中のアカウントのうち、accountEmail と同じもの。無ければ UnknownAccountError
function ownerOf(primary: string, linked: string[], accountEmail: string): string {
  const owner = sessionAccountList(primary, linked).find(a => sameAddress(a, accountEmail));
  if (!owner) throw new UnknownAccountError();
  return owner;
}

// 1つの設定を、そのチャットのアカウント（account_email）の置き場所に保存する
export async function saveSessionConfig(db: Db, primary: string, linked: string[], input: ConfigInput): Promise<void> {
  const owner = ownerOf(primary, linked, input.account_email);
  await saveConfig(db, owner, { ...input, account_email: owner });
}

// 1つの設定を、そのチャットのアカウントの置き場所から消す
export async function deleteSessionConfig(db: Db, primary: string, linked: string[], chatId: string, accountEmail: string): Promise<void> {
  const owner = ownerOf(primary, linked, accountEmail);
  await deleteConfig(db, owner, chatId, owner);
}

// 共通設定を書き換え、ログイン中の全アカウントに同じものを書く（一番新しい写しに、変えた値を重ねる）
export async function saveCommonSettings(db: Db, primary: string, linked: string[], updates: unknown, now = Date.now()): Promise<SyncedSettings> {
  const accounts = sessionAccountList(primary, linked);
  const current = await Promise.all(accounts.map(async (a) => ({ settings: await openGlobalSettings(await readReservedRow(db, a, GLOBAL_SETTINGS_CHAT_ID)), preferred: a === primary })));
  const merged: SyncedSettings = { ...newestCommonSettings(current), ...sanitizeSyncedSettings(updates), updatedAt: now };
  for (const a of accounts) await writeReservedRow(db, a, GLOBAL_SETTINGS_CHAT_ID, merged);
  return merged;
}

// アカウント設定の一部を書き換える（そのアカウントの置き場所に書く）
export async function saveAccountSettings(db: Db, accountEmail: string, updates: unknown): Promise<AccountSettings> {
  const merged: AccountSettings = { ...(await openAccountSettings(await readReservedRow(db, accountEmail, ACCOUNT_SETTINGS_CHAT_ID))), ...sanitizeAccountSettings(updates) };
  await writeReservedRow(db, accountEmail, ACCOUNT_SETTINGS_CHAT_ID, merged);
  return merged;
}
