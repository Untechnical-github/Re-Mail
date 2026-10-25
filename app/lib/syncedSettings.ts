// 設定は2種類ある。どちらもどの端末でも共通で、D1 に暗号化して保存する。
// - 共通設定（SYNCED_SETTING_TYPES）：どのアカウントでログインしても同じ。ログインしている全アカウントの
//   __GLOBAL_SETTINGS__ に同じものを書き、読むときは一番新しいもの（updatedAt）を使う。あとから足したアカウントにも写す
// - アカウント設定（ACCOUNT_SETTING_TYPES）：アカウントごと。そのアカウントの __ACCOUNT_SETTINGS__ に書く
// 新しい設定を足すときは、どちらかの一覧に名前と型を足す（一覧に無い名前の値は保存されずに捨てられる）。
// 画面の状態（開いているタブ・スクロール位置・開いているチャット）と下書きは設定ではないので、ここに入れず端末に置く
export const SYNCED_SETTING_TYPES = {
  // 場所のチェックボックス（受信箱〜ゴミ箱）
  inbox: "boolean",
  archive: "boolean",
  spam: "boolean",
  trash: "boolean",
  sent: "boolean",
  // 送信ボタン・アクションバー・場所の表示を、文字にするかアイコンにするか
  iconLabels: "boolean",
  // 送ったメールの時間の横に「To 1・Cc 2・Bcc 1」を出すか（既定はオフ）
  showSentRecipients: "boolean",
  // 受け取ったメールの時間の横に、自分がどの欄（To / Cc）で受け取ったかを出すか（既定はオフ）
  showReceivedRecipients: "boolean",
  // アカウントごとの表示チェックボックス（キーはアカウントのアドレス。行ごと暗号化するので D1 に平文では残らない）
  accounts: "accountMap",
  // 最後に保存した時刻（ミリ秒）。アカウントごとの写しのうち、どれが一番新しいかを決めるのに使う
  updatedAt: "number",
} as const;

// 画面が持って保存する共通設定の名前（updatedAt は含めない）
export const COMMON_SETTING_KEYS = ["inbox", "archive", "spam", "trash", "sent", "iconLabels", "showSentRecipients", "showReceivedRecipients", "accounts"] as const;

// アカウント設定の一覧（アカウントごとに保存する）
export const ACCOUNT_SETTING_TYPES = {
  // メールの外部の画像を、押さずに毎回読み込むか
  alwaysLoadImages: "boolean",
  // チャットを開いたら、そのチャットに表示されているメールを既読にするか（既定はオフ）
  autoReadOnOpenChat: "boolean",
  // メールを開いたら（詳細を表示したら）、そのメールを既読にするか（既定はオフ）
  autoReadOnOpenMail: "boolean",
  // Re:Mail の書きかけを Gmail の下書きに保存し、Gmail の下書きをチャットの入力欄に出すか（既定はオン。保存していない＝オン）
  gmailDraftSync: "boolean",
} as const;
export type AccountSettings = { -readonly [K in keyof typeof ACCOUNT_SETTING_TYPES]?: boolean };

type SettingType = (typeof SYNCED_SETTING_TYPES)[keyof typeof SYNCED_SETTING_TYPES];
type ValueOf<T extends SettingType> = T extends "boolean" ? boolean : T extends "accountMap" ? Record<string, boolean> : T extends "number" ? number : never;
export type SyncedSettings = { -readonly [K in keyof typeof SYNCED_SETTING_TYPES]?: ValueOf<(typeof SYNCED_SETTING_TYPES)[K]> };

// アカウントの表示チェックボックスに入れてよい件数とアドレスの長さの上限（壊れた・巨大な値を保存しない）
const MAX_ACCOUNTS = 50;
const MAX_ADDRESS_LENGTH = 320;
const ADDRESS_RE = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

// 決まった名前・型の値だけを残す（それ以外は捨てる）
export function sanitizeSyncedSettings(value: unknown): SyncedSettings {
  const out: Record<string, unknown> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, type] of Object.entries(SYNCED_SETTING_TYPES)) {
    const v = (value as Record<string, unknown>)[key];
    if (type === "boolean" && typeof v === "boolean") out[key] = v;
    if (type === "number" && typeof v === "number" && Number.isFinite(v) && v >= 0) out[key] = v;
    if (type === "accountMap" && v && typeof v === "object" && !Array.isArray(v)) {
      const map: Record<string, boolean> = {};
      for (const [addr, on] of Object.entries(v as Record<string, unknown>).slice(0, MAX_ACCOUNTS)) {
        if (typeof on === "boolean" && addr.length <= MAX_ADDRESS_LENGTH && ADDRESS_RE.test(addr)) map[addr] = on;
      }
      out[key] = map;
    }
  }
  return out as SyncedSettings;
}

// 2つの設定が同じかを比べるための文字列（名前の順番に左右されない）
export function syncedSettingsKey(s: SyncedSettings): string {
  const norm = (v: unknown): unknown => v && typeof v === "object" && !Array.isArray(v)
    ? Object.keys(v as Record<string, unknown>).sort().map(k => [k, norm((v as Record<string, unknown>)[k])])
    : v;
  return JSON.stringify(norm(s));
}

// 共通設定のうち、画面が持つ名前だけを取り出す（保存済みかどうかを比べるときに、updatedAt などで食い違わないように）
export function pickCommonSettings(s: SyncedSettings): SyncedSettings {
  const out: Record<string, unknown> = {};
  for (const k of COMMON_SETTING_KEYS) if (s[k] !== undefined) out[k] = s[k];
  return out as SyncedSettings;
}

// アカウント設定の、決まった名前・型の値だけを残す
export function sanitizeAccountSettings(value: unknown): AccountSettings {
  const out: AccountSettings = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const key of Object.keys(ACCOUNT_SETTING_TYPES) as (keyof typeof ACCOUNT_SETTING_TYPES)[]) {
    const v = (value as Record<string, unknown>)[key];
    if (typeof v === "boolean") out[key] = v;
  }
  return out;
}

// アカウントごとの写しのうち一番新しい共通設定を選ぶ（updatedAt が無ければ 0 とみなし、同じならログインのセッションを持つアカウントの分）
export function newestCommonSettings(copies: { settings: SyncedSettings; preferred: boolean }[]): SyncedSettings {
  let best: { settings: SyncedSettings; at: number; preferred: boolean } | null = null;
  for (const c of copies) {
    const at = c.settings.updatedAt ?? 0;
    if (!best || at > best.at || (at === best.at && c.preferred && !best.preferred)) best = { settings: c.settings, at, preferred: c.preferred };
  }
  return best ? best.settings : {};
}
