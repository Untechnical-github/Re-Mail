// 設定（chat_configs）の読み書き。/api/config と、全行を定期的に置き換える処理（app/lib/backfill.ts）の両方から使う。
//
// D1 に個人情報を平文で置かない（絶対ルール1）。
// - chat_id（相手の名前・アドレス）は「h1:」＋HMAC、元の chat_id と custom_name（名前変更・グループ・フィルターの語）は
//   まとめて暗号化して保存する（app/lib/configCrypto.ts）
// - user_email・account_email（自分のアドレス）は「a1:」＋HMAC に置き換え、元の account_email は暗号化した中身に持たせる
//   （app/lib/addressKey.ts）。Re:Mail をほかの人も使うので、D1 だけが漏れても利用者の一覧が分からないようにする
// 画面とのやり取りは、これまでどおり元のアドレス・chat_id・custom_name で行う。
// 古いコードに戻しても壊れないよう、段階を分けて入れる（段階は app/lib/addressStage.ts で切り替える）
import { logError, logInfo } from "./safeLog";
import { decryptSecret, encryptSecret, hmacId, isEncrypted } from "./tokenCrypto";
import { stripPinnedBodies } from "./pinnedIds";
import { addressKeyFor, isAddressKey } from "./addressKey";
import { WRITE_HASHED_ADDRESS } from "./addressStage";
import { sanitizeSyncedSettings, sanitizeAccountSettings, newestCommonSettings, syncedSettingsKey, type SyncedSettings, type AccountSettings } from "./syncedSettings";
import { WRITE_LEGACY_LINKED_COPY } from "./configStage";
import { sealConfigName, sealRow, openRow, isReservedRow, isSealedChatId, SEALED_CHAT_ID_PREFIX, type RowCrypto } from "./configCrypto";

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
type OpenedRow = OpenedConfig & { source: Row; rank: number };

const UPSERT_SQL = `INSERT INTO chat_configs (user_email, account_email, chat_id, custom_name, is_pinned, is_hidden, hidden_at_date, unhide_on_new)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_email, account_email, chat_id) DO UPDATE SET
       custom_name=excluded.custom_name,
       is_pinned=excluded.is_pinned,
       is_hidden=excluded.is_hidden,
       hidden_at_date=excluded.hidden_at_date,
       unhide_on_new=excluded.unhide_on_new`;

const DELETE_ROW_SQL = "DELETE FROM chat_configs WHERE user_email = ? AND account_email = ? AND chat_id = ?";

// 本人のアドレスの、平文と置き換えた値（移行の途中は両方の行がありうる）
async function userKeys(email: string): Promise<{ plain: string; hashed: string | null }> {
  return { plain: email, hashed: await addressKeyFor(email, hmacId) };
}

// これから保存するときに使う account_email の値（段階1では平文のまま）
async function targetAccountKey(accountEmail: string): Promise<string> {
  if (isReservedRow(accountEmail)) return "";
  if (!WRITE_HASHED_ADDRESS) return accountEmail;
  return (await addressKeyFor(accountEmail, hmacId)) || accountEmail;
}

// 本人の設定をすべて読み、元の形に戻して返す。古い形の行・本体の残っている行は、ここで今の保存の形に置き換える
export async function openAndMigrateConfigs(db: Db, userEmail: string): Promise<OpenedConfig[]> {
  const user = await userKeys(userEmail);
  const targetUser = WRITE_HASHED_ADDRESS && user.hashed ? user.hashed : user.plain;
  const { results } = user.hashed
    ? await db.prepare("SELECT * FROM chat_configs WHERE user_email IN (?, ?)").bind(user.plain, user.hashed).all()
    : await db.prepare("SELECT * FROM chat_configs WHERE user_email = ?").bind(user.plain).all();
  const rows = results as Row[];

  // それぞれの行を元の形に戻す。同じ設定が古い形と新しい形の両方にあれば、新しい形（rank が高い方）を使い、
  // 使わなかった方は「同じ設定の古い行」として後で消す。開けなかった行は消さずにそのまま残す（失わないため）
  const opened = new Map<string, OpenedRow>();
  const duplicates: Row[] = [];
  for (const row of rows) {
    const reserved = isReservedRow(row.account_email);
    let chatId = row.chat_id;
    let customName = row.custom_name ?? null;
    let accountEmail = row.account_email;
    if (!reserved) {
      const o = await openRow(row.chat_id, row.custom_name, rowCrypto);
      if (!o) { logError("config.openRow", {}); continue; }
      chatId = o.chatId;
      customName = o.customName;
      if (isAddressKey(row.account_email)) {
        // アドレスを置き換えた行は、暗号化した中身に元のアドレスを持っている
        if (!o.accountEmail) { logError("config.openRow.noAccount", {}); continue; }
        accountEmail = o.accountEmail;
      }
      // メールの中身を D1 に置かない（絶対ルール1）。以前の形式で残っていた本体は、ここで取り除く
      customName = stripPinnedBodies(customName) ?? null;
    }
    const rank = (isAddressKey(row.user_email) ? 4 : 0) + (isAddressKey(row.account_email) ? 2 : 0) + (isSealedChatId(row.chat_id) ? 1 : 0);
    const key = `${accountEmail}\u0000${chatId}`;
    const prev = opened.get(key);
    if (prev && prev.rank >= rank) { duplicates.push(row); continue; }
    if (prev) duplicates.push(prev.source);
    opened.set(key, {
      account_email: accountEmail, chat_id: chatId, custom_name: customName,
      is_pinned: row.is_pinned, is_hidden: row.is_hidden, hidden_at_date: row.hidden_at_date, unhide_on_new: row.unhide_on_new,
      source: row, rank,
    });
  }

  // 古い形の行・本体の残っている行を、今の保存の形に置き換える（同じバッチで書いて消すので途中で失われない）。
  // 失敗しても読み込みは止めない（次に読んだときにまた試す）
  try {
    const stmts = [];
    let rewritten = 0;
    for (const o of opened.values()) {
      const reserved = isReservedRow(o.account_email);
      const account = await targetAccountKey(o.account_email);
      let chat = o.chat_id;
      let custom = o.custom_name ?? null;
      if (!reserved) {
        const sealed = await sealRow(o.chat_id, o.custom_name, rowCrypto, WRITE_HASHED_ADDRESS ? o.account_email : undefined);
        if (sealed) { chat = sealed.chatId; custom = sealed.customName; }
        else custom = (await sealConfigName(custom, encryptSecret)) ?? null;
      }
      const src = o.source;
      const sameKeys = src.user_email === targetUser && src.account_email === account && src.chat_id === chat;
      // 中身を書き直す必要があるか：本体が残っている、または（段階2で）元のアドレスをまだ中身に持っていない
      let contentStale = false;
      if (!reserved && isSealedChatId(src.chat_id)) {
        const srcOpened = await openRow(src.chat_id, src.custom_name, rowCrypto);
        contentStale = !srcOpened
          || stripPinnedBodies(srcOpened.customName) !== srcOpened.customName
          || (WRITE_HASHED_ADDRESS && !srcOpened.accountEmail);
      } else if (!reserved) {
        contentStale = true; // 平文の chat_id の行は暗号化して置き換える
      }
      if (sameKeys && !contentStale) continue;
      if (!reserved && !isSealedChatId(chat)) continue; // 鍵が無く暗号化できないときは、今の行をそのまま使う
      stmts.push(db.prepare(UPSERT_SQL).bind(targetUser, account, chat, custom, o.is_pinned ?? 0, o.is_hidden ?? 0, o.hidden_at_date ?? null, o.unhide_on_new ?? 0));
      if (!sameKeys) stmts.push(db.prepare(DELETE_ROW_SQL).bind(src.user_email, src.account_email, src.chat_id));
      rewritten++;
    }
    for (const row of duplicates) stmts.push(db.prepare(DELETE_ROW_SQL).bind(row.user_email, row.account_email, row.chat_id));
    if (stmts.length > 0) {
      await db.batch(stmts);
      logInfo("config.migrateRows", { count: rewritten });
    }
  } catch (e) {
    logError("config.migrateRows", { count: rows.length }, e);
  }

  return Array.from(opened.values()).map((o) => ({
    account_email: o.account_email, chat_id: o.chat_id, custom_name: o.custom_name,
    is_pinned: o.is_pinned, is_hidden: o.is_hidden, hidden_at_date: o.hidden_at_date, unhide_on_new: o.unhide_on_new,
  }));
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

// 1つの設定を保存する。同じ設定の古い形の行（平文のアドレス・平文の chat_id）が残っていれば消す
export async function saveConfig(db: Db, userEmail: string, input: ConfigInput): Promise<void> {
  const user = await userKeys(userEmail);
  const targetUser = WRITE_HASHED_ADDRESS && user.hashed ? user.hashed : user.plain;
  // メールの中身（以前の形式のピン留めの本体）は、送られてきても保存しない（絶対ルール1）
  const customName = stripPinnedBodies(input.custom_name) ?? null;
  const flags = [input.is_pinned ? 1 : 0, input.is_hidden ? 1 : 0, input.hidden_at_date || null, input.unhide_on_new ? 1 : 0] as const;

  const account = await targetAccountKey(input.account_email);
  const sealed = await sealRow(input.chat_id, customName, rowCrypto, WRITE_HASHED_ADDRESS ? input.account_email : undefined);
  const chat = sealed ? sealed.chatId : input.chat_id;
  const custom = sealed ? sealed.customName : ((await sealConfigName(customName, encryptSecret)) || null);
  const userKeysList = [user.plain, user.hashed || user.plain];
  const accountKeys = [input.account_email, (await addressKeyFor(input.account_email, hmacId)) || input.account_email];
  const chatKeys = [input.chat_id, chat];
  await db.batch([
    db.prepare(UPSERT_SQL).bind(targetUser, account, chat, custom, ...flags),
    db.prepare(`DELETE FROM chat_configs WHERE user_email IN (?, ?) AND account_email IN (?, ?) AND chat_id IN (?, ?)
                AND NOT (user_email = ? AND account_email = ? AND chat_id = ?)`)
      .bind(...userKeysList, ...accountKeys, ...chatKeys, targetUser, account, chat),
  ]);
}

// 1つの設定を消す（古い形・新しい形のどれで保存されていても消す）
export async function deleteConfig(db: Db, userEmail: string, chatId: string, accountEmail: string): Promise<void> {
  const user = await userKeys(userEmail);
  const sealedChat = await hmacId(chatId);
  const userKeysList = [user.plain, user.hashed || user.plain];
  const accountKeys = [accountEmail, (await addressKeyFor(accountEmail, hmacId)) || accountEmail];
  const chatKeys = [chatId, sealedChat ? `${SEALED_CHAT_ID_PREFIX}${sealedChat}` : chatId];
  await db.prepare("DELETE FROM chat_configs WHERE user_email IN (?, ?) AND account_email IN (?, ?) AND chat_id IN (?, ?)")
    .bind(...userKeysList, ...accountKeys, ...chatKeys).run();
}

// どの端末でも共通の設定（account_email が空の予約行 __GLOBAL_SETTINGS__ に持つ）。
// 入れてよい設定の名前と型は app/lib/syncedSettings.ts で決め、それ以外は捨てる。
// アカウントのアドレスを含むので、行の中身はまとめて暗号化して保存する（以前の平文の JSON も読める）
export const GLOBAL_SETTINGS_CHAT_ID = "__GLOBAL_SETTINGS__";

// 保存されている中身を設定に戻す。暗号化したもの・以前の平文の JSON のどちらも読む。読めなければ空
export async function openGlobalSettings(customName: string | null | undefined): Promise<SyncedSettings> {
  if (!customName) return {};
  try {
    const json = customName.startsWith("encv1:") ? await decryptSecret(customName) : customName;
    return sanitizeSyncedSettings(JSON.parse(json));
  } catch {
    return {};
  }
}

// 予約行（account_email が空）の中身を読む。今の形の行を優先する
async function readReservedRow(db: Db, userEmail: string, chatId: string): Promise<string | null> {
  const user = await userKeys(userEmail);
  const targetUser = WRITE_HASHED_ADDRESS && user.hashed ? user.hashed : user.plain;
  const { results } = await db.prepare("SELECT user_email, custom_name FROM chat_configs WHERE user_email IN (?, ?) AND account_email = '' AND chat_id = ?")
    .bind(user.plain, user.hashed || user.plain, chatId).all();
  const rows = results as { user_email: string; custom_name: string | null }[];
  return (rows.find(r => r.user_email === targetUser) || rows[0])?.custom_name ?? null;
}

// 予約行を、渡した値そのもので置き換える（暗号化して書く）。古い形（平文のアドレス）の行があれば消す。
// 鍵が無く暗号化できないとき（ローカルの開発環境など）は、アドレスを含む値を平文で D1 に置かないよう外して書き、外した値を返す
async function writeReservedRow(db: Db, userEmail: string, chatId: string, value: Record<string, unknown>): Promise<Record<string, unknown>> {
  const user = await userKeys(userEmail);
  const targetUser = WRITE_HASHED_ADDRESS && user.hashed ? user.hashed : user.plain;
  const out = { ...value };
  let sealed = await encryptSecret(JSON.stringify(out));
  if (!isEncrypted(sealed)) {
    delete out.accounts;
    sealed = JSON.stringify(out);
  }
  await db.batch([
    db.prepare(UPSERT_SQL).bind(targetUser, "", chatId, sealed, 0, 0, null, 0),
    db.prepare("DELETE FROM chat_configs WHERE user_email IN (?, ?) AND account_email = '' AND chat_id = ? AND user_email <> ?")
      .bind(user.plain, user.hashed || user.plain, chatId, targetUser),
  ]);
  return out;
}

// 共通の設定の一部を書き換える。ほかの値は残す。古い形（平文のアドレス）の行があれば今の形に移して消す
export async function saveGlobalSettings(db: Db, userEmail: string, updates: unknown): Promise<SyncedSettings> {
  const merged: SyncedSettings = { ...(await openGlobalSettings(await readReservedRow(db, userEmail, GLOBAL_SETTINGS_CHAT_ID))), ...sanitizeSyncedSettings(updates) };
  return (await writeReservedRow(db, userEmail, GLOBAL_SETTINGS_CHAT_ID, merged)) as SyncedSettings;
}

// ---- アカウントごとの置き場所 ----
// 設定は「そのアカウント自身」の置き場所（user_email = そのアカウント）に保存する。こうすると、連携アカウントで
// 直接ログインしても、連携して使っていたときの設定がそのまま使える（ログインできる＝同じ人とみなす）。
// - アカウント設定・チャットの設定（ピン留め・非表示・名前変更・グループ・そのアカウントだけのフィルター）：そのアカウントの置き場所
// - 共通設定・すべてのアカウントが対象のフィルター（shared）：ログインしている全アカウントの置き場所に同じものを書く
// 以前は連携アカウントの設定もメインアカウントの置き場所に書いていた。その行は読んだときに写し、段階1では両方に書く（configStage.ts）

export const ACCOUNT_SETTINGS_CHAT_ID = "__ACCOUNT_SETTINGS__";

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// custom_name の JSON から、すべてのアカウントが対象か（shared）・最後に保存した時刻・フィルターの対象アカウントを読む
export function configMeta(customName: string | null | undefined): { shared: boolean; updatedAt: number; filterAccount?: string; isFilter?: boolean } {
  if (!customName || !customName.startsWith("{")) return { shared: false, updatedAt: 0 };
  try {
    const p = JSON.parse(customName) as { shared?: unknown; updatedAt?: unknown; filterAction?: unknown; isGroup?: unknown; filterCriteria?: { accountEmail?: unknown } };
    const fa = p.filterCriteria?.accountEmail;
    const meta: { shared: boolean; updatedAt: number; filterAccount?: string; isFilter?: boolean } = { shared: p.shared === true, updatedAt: typeof p.updatedAt === "number" ? p.updatedAt : 0 };
    if (typeof fa === "string" && fa) meta.filterAccount = fa;
    if (!!p.filterAction || (!!p.isGroup && !!p.filterCriteria)) meta.isFilter = true;
    return meta;
  } catch {
    return { shared: false, updatedAt: 0 };
  }
}

// フィルターを、指定したアカウントだけのものにする（すべてのアカウントが対象だったものを、アカウントごとに分けるとき）
export function assignFilterAccount(customName: string | null | undefined, account: string): string | null {
  if (!customName) return customName ?? null;
  try {
    const p = JSON.parse(customName) as Record<string, unknown> & { filterCriteria?: Record<string, unknown> };
    delete p.shared;
    p.filterCriteria = { ...(p.filterCriteria || {}), accountEmail: account };
    return JSON.stringify(p);
  } catch {
    return customName;
  }
}

const toInput = (o: OpenedConfig, accountEmail: string): ConfigInput => ({
  chat_id: o.chat_id, account_email: accountEmail, custom_name: o.custom_name ?? null,
  is_pinned: o.is_pinned === 1, is_hidden: o.is_hidden === 1, hidden_at_date: o.hidden_at_date ?? null, unhide_on_new: o.unhide_on_new === 1,
});
// 2つの写しの中身が同じかを比べるための値
const contentKey = (o: OpenedConfig) => JSON.stringify([o.custom_name ?? null, o.is_pinned ? 1 : 0, o.is_hidden ? 1 : 0, o.hidden_at_date ?? null, o.unhide_on_new ? 1 : 0]);

// ログイン中のアカウント（メイン＋連携）。重複と空を除く
export function sessionAccountList(primary: string, linked: string[]): string[] {
  const out = [primary];
  for (const a of linked) if (a && !out.some(x => sameAddress(x, a))) out.push(a);
  return out;
}

export type SessionConfigs = { configs: OpenedConfig[]; accountSettings: Record<string, AccountSettings> };

// ログイン中の全アカウントの設定を読み、画面に返す形にまとめる。足りない写し・以前の置き場所の行は、ここで書き足す
export async function openSessionConfigs(db: Db, primary: string, linked: string[]): Promise<SessionConfigs> {
  const accounts = sessionAccountList(primary, linked);
  const findAccount = (a: string) => accounts.find(x => sameAddress(x, a));
  const spaces = new Map<string, OpenedConfig[]>();
  for (const a of accounts) spaces.set(a, await openAndMigrateConfigs(db, a));

  const result = new Map<string, OpenedConfig>();
  const writes: { owner: string; input: ConfigInput }[] = [];
  const deletes: { owner: string; chatId: string; accountEmail: string }[] = [];
  const key = (account: string, chat: string) => `${account.toLowerCase()}\u0000${chat}`;

  // 1. 自分の置き場所にある、自分のチャットの設定
  for (const [owner, rows] of spaces) {
    for (const o of rows) {
      if (isReservedRow(o.account_email) || !sameAddress(o.account_email, owner)) continue;
      const meta = configMeta(o.custom_name);
      if (meta.shared || (meta.isFilter && !meta.filterAccount && accounts.length > 1)) continue;
      // 以前はほかのアカウントだけが対象のフィルターも、メインアカウント名義で保存していた。対象のアカウントへ移す
      const target = meta.filterAccount ? findAccount(meta.filterAccount) : undefined;
      if (target && !sameAddress(target, owner)) {
        if (!result.has(key(target, o.chat_id))) {
          result.set(key(target, o.chat_id), { ...o, account_email: target });
          writes.push({ owner: target, input: toInput(o, target) });
        }
        deletes.push({ owner, chatId: o.chat_id, accountEmail: owner });
        continue;
      }
      result.set(key(owner, o.chat_id), { ...o, account_email: owner });
    }
  }
  // 2. 以前の置き場所（ほかのアカウントの置き場所）にある、このアカウントのチャットの設定。自分の置き場所に無いものだけ使い、写す
  for (const [space, rows] of spaces) {
    for (const o of rows) {
      if (isReservedRow(o.account_email) || sameAddress(o.account_email, space) || configMeta(o.custom_name).shared) continue;
      const owner = findAccount(o.account_email);
      if (!owner) {
        // 連携を解除したアカウントなどの行は、これまでどおりメインアカウントの置き場所の分だけ返す
        if (space === primary && !result.has(key(o.account_email, o.chat_id))) result.set(key(o.account_email, o.chat_id), o);
        continue;
      }
      if (result.has(key(owner, o.chat_id))) continue;
      result.set(key(owner, o.chat_id), { ...o, account_email: owner });
      writes.push({ owner, input: toInput(o, owner) });
    }
  }
  // 3. すべてのアカウントが対象のフィルター（shared と、アカウントを決めていない以前のフィルター）は、
  //    アカウントごとの別々のフィルターに分ける（フィルターはアカウントごとに保存し、そのアカウントのメールにだけ効く）。
  //    一番新しい写しをもとに、各アカウントの置き場所にそのアカウントだけのフィルターとして書き直す
  if (accounts.length > 1) {
    const best = new Map<string, { o: OpenedConfig; at: number; preferred: boolean }>();
    for (const [space, rows] of spaces) {
      for (const o of rows) {
        if (isReservedRow(o.account_email)) continue;
        const meta = configMeta(o.custom_name);
        const toSplit = meta.shared || (meta.isFilter && !meta.filterAccount && sameAddress(o.account_email, space));
        if (!toSplit) continue;
        const cur = best.get(o.chat_id);
        const preferred = space === primary;
        if (!cur || meta.updatedAt > cur.at || (meta.updatedAt === cur.at && preferred && !cur.preferred)) best.set(o.chat_id, { o, at: meta.updatedAt, preferred });
      }
    }
    for (const [chat, { o }] of best) {
      for (const a of accounts) {
        // 分けたあとにそのアカウントで編集した（アカウントの決まった）フィルターがあれば、そちらを使う
        if (result.has(key(a, chat))) continue;
        const own: OpenedConfig = { ...o, account_email: a, custom_name: assignFilterAccount(o.custom_name, a) };
        result.set(key(a, chat), own);
        writes.push({ owner: a, input: toInput(own, a) });
      }
    }
  } else {
    // 1つのアカウントだけでログインしているときは、そのアカウントのフィルターとしてそのまま返す
    for (const o of spaces.get(primary) || []) {
      if (isReservedRow(o.account_email) || !configMeta(o.custom_name).shared) continue;
      result.set(key(primary, o.chat_id), { ...o, account_email: primary });
    }
  }

  // 4. 共通設定：一番新しい写しを使い、違う写し・無い写しを書き直す（あとから足したアカウントにも写す）
  const reservedOf = (a: string, chatId: string) => spaces.get(a)?.find(o => isReservedRow(o.account_email) && o.chat_id === chatId);
  const globalCopies = await Promise.all(accounts.map(async (a) => ({ a, settings: await openGlobalSettings(reservedOf(a, GLOBAL_SETTINGS_CHAT_ID)?.custom_name) })));
  const common = newestCommonSettings(globalCopies.map(c => ({ settings: c.settings, preferred: c.a === primary })));
  const commonKey = syncedSettingsKey(common);
  const globalWrites = Object.keys(common).length > 0 ? globalCopies.filter(c => syncedSettingsKey(c.settings) !== commonKey).map(c => c.a) : [];

  // 5. アカウント設定：無ければ、以前の共通設定にあった値を初期値にする（書くのは変えたときだけ）
  const accountSettings: Record<string, AccountSettings> = {};
  for (const { a, settings } of globalCopies) {
    const raw = reservedOf(a, ACCOUNT_SETTINGS_CHAT_ID)?.custom_name;
    if (raw) { accountSettings[a] = await openAccountSettings(raw); continue; }
    const legacy = settings.alwaysLoadImages ?? common.alwaysLoadImages;
    accountSettings[a] = legacy === undefined ? {} : { alwaysLoadImages: legacy };
  }

  // 書き足しは失敗しても読み込みは止めない（次に読んだときにまた試す）
  try {
    for (const w of writes) await saveSessionConfig(db, primary, linked, w.input, undefined, w.owner);
    for (const d of deletes) await deleteConfig(db, d.owner, d.chatId, d.accountEmail);
    for (const a of globalWrites) await writeReservedRow(db, a, GLOBAL_SETTINGS_CHAT_ID, common);
    const n = writes.length + deletes.length + globalWrites.length;
    if (n > 0) logInfo("config.syncSpaces", { count: n });
  } catch (e) {
    logError("config.syncSpaces", {}, e);
  }

  // 共通設定は1行にまとめて返す（中身は復号した JSON）。そのほかの予約行はメインアカウントの分だけ
  const reserved: OpenedConfig[] = (spaces.get(primary) || []).filter(o => isReservedRow(o.account_email) && o.chat_id !== GLOBAL_SETTINGS_CHAT_ID && o.chat_id !== ACCOUNT_SETTINGS_CHAT_ID);
  if (accounts.some(a => reservedOf(a, GLOBAL_SETTINGS_CHAT_ID))) reserved.push({ account_email: "", chat_id: GLOBAL_SETTINGS_CHAT_ID, custom_name: JSON.stringify(common) });
  return { configs: [...reserved, ...result.values()], accountSettings };
}

// 1つの設定を、ログイン中のアカウントの置き場所に保存する。
// scope が "shared" なら全アカウントに、そうでなければそのチャットのアカウント（account_email）の置き場所に書く。
// ownerOverride は読むときの書き足し用（その置き場所にだけ書く）
export async function saveSessionConfig(db: Db, primary: string, linked: string[], input: ConfigInput, scope?: "shared", ownerOverride?: string): Promise<void> {
  const accounts = sessionAccountList(primary, linked);
  const legacyCopy = (owner: string) => WRITE_LEGACY_LINKED_COPY && !sameAddress(owner, primary) && !configMeta(input.custom_name).shared;
  if (ownerOverride) {
    await saveConfig(db, ownerOverride, { ...input, account_email: ownerOverride });
    if (legacyCopy(ownerOverride)) await saveConfig(db, primary, { ...input, account_email: ownerOverride });
    return;
  }
  if (scope === "shared") {
    for (const a of accounts) await saveConfig(db, a, { ...input, account_email: a });
    return;
  }
  const owner = accounts.find(a => sameAddress(a, input.account_email));
  // ログイン中のアカウントでなければ（連携を解除したアカウントなど）、これまでどおりメインアカウントの置き場所に書く
  if (!owner) { await saveConfig(db, primary, input); return; }
  await saveConfig(db, owner, { ...input, account_email: owner });
  // 段階1：古いコードに戻しても見えるよう、以前の置き場所にも書く
  if (legacyCopy(owner)) await saveConfig(db, primary, { ...input, account_email: owner });
}

// 1つの設定を消す。shared なら全アカウントの写しを、そうでなければそのアカウントの置き場所と以前の置き場所の行を消す
export async function deleteSessionConfig(db: Db, primary: string, linked: string[], chatId: string, accountEmail: string, scope?: "shared"): Promise<void> {
  const accounts = sessionAccountList(primary, linked);
  if (scope === "shared") {
    for (const a of accounts) await deleteConfig(db, a, chatId, a);
    await deleteConfig(db, primary, chatId, accountEmail);
    return;
  }
  const owner = accounts.find(a => sameAddress(a, accountEmail));
  if (owner && !sameAddress(owner, primary)) await deleteConfig(db, owner, chatId, owner);
  await deleteConfig(db, primary, chatId, accountEmail);
}

// 共通設定を書き換え、ログイン中の全アカウントに同じものを書く（一番新しい写しに、変えた値を重ねる）
export async function saveCommonSettings(db: Db, primary: string, linked: string[], updates: unknown, now = Date.now()): Promise<SyncedSettings> {
  const accounts = sessionAccountList(primary, linked);
  const current = await Promise.all(accounts.map(async (a) => ({ settings: await openGlobalSettings(await readReservedRow(db, a, GLOBAL_SETTINGS_CHAT_ID)), preferred: a === primary })));
  const merged: SyncedSettings = { ...newestCommonSettings(current), ...sanitizeSyncedSettings(updates), updatedAt: now };
  let out: SyncedSettings = merged;
  for (const a of accounts) out = (await writeReservedRow(db, a, GLOBAL_SETTINGS_CHAT_ID, merged)) as SyncedSettings;
  return out;
}

export async function openAccountSettings(customName: string | null | undefined): Promise<AccountSettings> {
  if (!customName) return {};
  try {
    const json = customName.startsWith("encv1:") ? await decryptSecret(customName) : customName;
    return sanitizeAccountSettings(JSON.parse(json));
  } catch {
    return {};
  }
}

// アカウント設定の一部を書き換える（そのアカウントの置き場所に書く）
export async function saveAccountSettings(db: Db, accountEmail: string, updates: unknown): Promise<AccountSettings> {
  const merged: AccountSettings = { ...(await openAccountSettings(await readReservedRow(db, accountEmail, ACCOUNT_SETTINGS_CHAT_ID))), ...sanitizeAccountSettings(updates) };
  return (await writeReservedRow(db, accountEmail, ACCOUNT_SETTINGS_CHAT_ID, merged)) as AccountSettings;
}
