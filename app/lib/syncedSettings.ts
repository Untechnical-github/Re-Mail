// どの端末でも共通にする設定の一覧（D1 の共通設定の行 __GLOBAL_SETTINGS__ に、まとめて暗号化して保存する）。
// 新しい設定を足すときは、ここに名前と型を足す（ここに無い名前の値は保存されずに捨てられる）。
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
  // メールの外部の画像を、押さずに毎回読み込むか
  alwaysLoadImages: "boolean",
  // アカウントごとの表示チェックボックス（キーはアカウントのアドレス。行ごと暗号化するので D1 に平文では残らない）
  accounts: "accountMap",
} as const;

type SettingType = (typeof SYNCED_SETTING_TYPES)[keyof typeof SYNCED_SETTING_TYPES];
type ValueOf<T extends SettingType> = T extends "boolean" ? boolean : T extends "accountMap" ? Record<string, boolean> : never;
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
