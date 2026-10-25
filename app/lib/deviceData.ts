// 端末（ブラウザ）に置いた Re:Mail のデータを、ログアウト・連携解除のときに消す（絶対ルール1）。
// 共有の PC で別の人がログインしても、前の人のメールの中身・宛先・下書きが残らないようにする
import localforage from "localforage";
import { clearAttachmentCaches, removeAccountAttachmentCaches } from "./attachmentCache";
import { clearPinnedCache, removePinnedCache } from "./pinnedCache";
import { clearDrafts, removeAccountDrafts } from "./drafts";
import { decodeRoomKey } from "./roomKey";

// 個人の情報を含まない見た目の設定だけは、ログアウトしても残す
const KEEP_ON_LOGOUT = new Set(["remail_use_icon_labels", "remail_box_settings", "remail_chat_cache_limit"]);

// この端末で最後に使った人。別の人がログインしたら、前の人のデータを消す
export const DEVICE_OWNER_KEY = "remail_device_owner";

function removeKeys(storage: Storage, keep: Set<string>) {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k && k.startsWith("remail_") && !keep.has(k)) keys.push(k);
  }
  keys.forEach(k => storage.removeItem(k));
}

// ログアウトしたとき（自分で押した・認証切れ）に、すべてを消す
export async function clearDeviceData(): Promise<void> {
  try { removeKeys(localStorage, KEEP_ON_LOGOUT); } catch { /* 使えない環境では何も残っていない */ }
  try { removeKeys(sessionStorage, new Set()); } catch { /* 同上 */ }
  await Promise.all([
    clearAttachmentCaches(),
    clearPinnedCache(),
    clearDrafts(),
    localforage.clear().catch(() => {}),
  ]);
}

// 連携を解除したアカウントの分だけを消す
export async function clearAccountDeviceData(account: string): Promise<void> {
  const target = account.trim().toLowerCase();
  const isTargetRoom = (key: unknown) => {
    try { return typeof key === "string" && decodeRoomKey(key).accountEmail.toLowerCase() === target; } catch { return false; }
  };
  try {
    const settings = JSON.parse(localStorage.getItem("remail_account_settings") || "null") as Record<string, boolean> | null;
    if (settings && typeof settings === "object") {
      Object.keys(settings).forEach(k => { if (k.toLowerCase() === target) delete settings[k]; });
      localStorage.setItem("remail_account_settings", JSON.stringify(settings));
    }
    const drafts = JSON.parse(localStorage.getItem("remail_draft_chats") || "null") as unknown[] | null;
    if (Array.isArray(drafts)) localStorage.setItem("remail_draft_chats", JSON.stringify(drafts.filter(k => !isTargetRoom(k))));
    const pending = JSON.parse(localStorage.getItem("remail_draft_pending_creates") || "null") as unknown[] | null;
    if (Array.isArray(pending)) localStorage.setItem("remail_draft_pending_creates", JSON.stringify(pending.filter(k => !isTargetRoom(k))));
    if (isTargetRoom(localStorage.getItem("remail_selected_sender"))) {
      localStorage.removeItem("remail_selected_sender");
      localStorage.removeItem("remail_scroll_main");
    }
    // 開いていた画面の状態（開いていたメール・選択など）は、そのアカウントのものかを見分けにくいので丸ごと消す
    localStorage.removeItem("remail_ui_state");
  } catch { /* 読めない・壊れた値は無視する */ }
  await Promise.all([removeAccountAttachmentCaches(account), removePinnedCache(account), removeAccountDrafts(account)]);
}
