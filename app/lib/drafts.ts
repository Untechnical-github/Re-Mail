// 入力中の返信（本文・件名・返信先・添付）を、チャットごとに端末の IndexedDB に置いておく。
// 送信の失敗・通信断・再読み込み・チャットの切り替えで入力を失わないため（絶対ルール3）。
// キーはチャットの複合キー（アカウント＋相手）なので、連携解除・ログアウトでアカウントごとに消せる
import localforage from "localforage";
import type { Email } from "../types/email";
import { decodeRoomKey } from "./roomKey";

export type ComposeDraft = {
  subject: string;
  body: string;
  replyToMessage: Email | null;
  attachments: { filename: string; mimeType: string; size: number; data: string }[];
  updatedAt: number;
};

const store = localforage.createInstance({ name: "remail", storeName: "drafts" });

export function isEmptyDraft(d: Pick<ComposeDraft, "subject" | "body" | "replyToMessage" | "attachments">): boolean {
  return !d.subject.trim() && !d.body.trim() && !d.replyToMessage && d.attachments.length === 0;
}

export async function loadDraft(room: string): Promise<ComposeDraft | null> {
  try {
    const d = await store.getItem<ComposeDraft>(room);
    if (!d || typeof d !== "object") return null;
    return {
      subject: typeof d.subject === "string" ? d.subject : "",
      body: typeof d.body === "string" ? d.body : "",
      replyToMessage: d.replyToMessage && typeof d.replyToMessage === "object" ? d.replyToMessage : null,
      attachments: Array.isArray(d.attachments) ? d.attachments : [],
      updatedAt: typeof d.updatedAt === "number" ? d.updatedAt : 0,
    };
  } catch {
    return null;
  }
}

// 中身が空なら消す（空の下書きを溜めない）
export async function saveDraft(room: string, draft: ComposeDraft): Promise<boolean> {
  try {
    if (isEmptyDraft(draft)) await store.removeItem(room);
    else await store.setItem(room, draft);
    return true;
  } catch {
    // 端末の容量不足などで保存できなかった（呼び出し側で利用者に伝える）
    return false;
  }
}

export async function removeDraft(room: string): Promise<void> {
  try { await store.removeItem(room); } catch { /* 消せなくても、次に保存するときに上書きされる */ }
}

export async function removeAccountDrafts(account: string): Promise<void> {
  const target = account.trim().toLowerCase();
  try {
    const keys = await store.keys();
    await Promise.all(keys.filter(k => {
      try { return decodeRoomKey(k).accountEmail.toLowerCase() === target; } catch { return false; }
    }).map(k => store.removeItem(k)));
  } catch { /* 消せなかった分は次のログアウトでまとめて消える */ }
}

export async function clearDrafts(): Promise<void> {
  try { await store.clear(); } catch { /* 同上 */ }
}
