// 入力中の返信（本文・件名・返信元・送信先・添付）を、チャットごとに端末の IndexedDB に置いておく。
// 送信の失敗・通信断・再読み込み・チャットの切り替えで入力を失わないため（絶対ルール3）。
// キーはチャットの複合キー（アカウント＋相手）なので、連携解除・ログアウトでアカウントごとに消せる
import localforage from "localforage";
import type { Email } from "../types/email";
import { decodeRoomKey } from "./roomKey";
import { normalizeRecipients, type ComposeRecipient } from "./composeRecipients";
import { isComposeBodyEmpty, textToComposeHtml, COMPOSE_LIMITS } from "./composeHtml";

// 本文中の画像（cid: で参照する。中身は base64）
export type DraftImage = { cid: string; filename: string; mimeType: string; size: number; data: string };

export type ComposeDraft = {
  subject: string;
  // 入力欄の HTML（整えたもの。本文・引用・署名を1つの HTML のまま持つ。本文中の画像は cid:）
  html: string;
  images?: DraftImage[];
  // 最後に入れた署名（手で書き換えたかを見分けるため）
  insertedSignature?: string | null;
  replyToMessage: Email | null;
  attachments: { filename: string; mimeType: string; size: number; data: string }[];
  // 入力中の送信先。null は「既定（開いているチャットの相手を To に1人）」のまま。
  // recipientsBase は返信元を選んで置き換えたときの内容（自分で変えたかどうかの判定に使う。null は既定）
  recipients?: ComposeRecipient[] | null;
  recipientsBase?: ComposeRecipient[] | null;
  updatedAt: number;
};

const store = localforage.createInstance({ name: "remail", storeName: "drafts" });

// 署名・引用を除いた本文に、文字・画像・表があるか
const hasBody = (html: string) => !!html && !isComposeBodyEmpty(html);

export function isEmptyDraft(d: Pick<ComposeDraft, "subject" | "html" | "replyToMessage" | "attachments" | "recipients">): boolean {
  return !d.subject.trim() && !hasBody(d.html) && !d.replyToMessage && d.attachments.length === 0 && !d.recipients;
}

// 本文・件名・返信元・添付のどれかがあるか（送信先を変えただけの下書きは含めない）。
// 新しいチャットを一覧に残すかの判断に使う（書いた内容が無く、やり取りも無ければチャットは片付ける）
export function hasDraftContent(d: Pick<ComposeDraft, "subject" | "html" | "replyToMessage" | "attachments">): boolean {
  return !!d.subject.trim() || hasBody(d.html) || !!d.replyToMessage || d.attachments.length > 0;
}

// 端末に残っていた本文中の画像を読み戻す（形の正しくないもの・上限を超えた分は捨てる）
function readImages(v: unknown): DraftImage[] {
  if (!Array.isArray(v)) return [];
  return v.filter((i): i is DraftImage => !!i && typeof i === "object"
    && typeof (i as DraftImage).cid === "string" && /^ii_[0-9a-z]{1,24}$/.test((i as DraftImage).cid)
    && typeof (i as DraftImage).data === "string" && typeof (i as DraftImage).mimeType === "string" && /^image\/(png|jpeg|gif|webp|bmp)$/.test((i as DraftImage).mimeType)
    && typeof (i as DraftImage).size === "number" && (i as DraftImage).size <= COMPOSE_LIMITS.maxImageBytes)
    .slice(0, COMPOSE_LIMITS.maxImages)
    .map(i => ({ cid: i.cid, filename: typeof i.filename === "string" ? i.filename : "image.png", mimeType: i.mimeType, size: i.size, data: i.data }));
}

// 端末に残っていた送信先を読み戻す（壊れた値・上限を超えた分は捨てる）
function readRecipients(v: unknown): ComposeRecipient[] | null {
  return Array.isArray(v) ? normalizeRecipients(v).recipients : null;
}

export async function loadDraft(room: string): Promise<ComposeDraft | null> {
  try {
    const d = await store.getItem<ComposeDraft & { body?: unknown }>(room);
    if (!d || typeof d !== "object") return null;
    // 古い形（文字だけの body）の下書きは、純正と同じ行の HTML にする
    const html = typeof d.html === "string" ? d.html.slice(0, COMPOSE_LIMITS.maxHtmlChars) : typeof d.body === "string" && d.body ? textToComposeHtml(d.body) : "";
    return {
      subject: typeof d.subject === "string" ? d.subject : "",
      html,
      images: readImages(d.images),
      insertedSignature: typeof d.insertedSignature === "string" ? d.insertedSignature : null,
      replyToMessage: d.replyToMessage && typeof d.replyToMessage === "object" ? d.replyToMessage : null,
      attachments: Array.isArray(d.attachments) ? d.attachments : [],
      recipients: readRecipients(d.recipients),
      recipientsBase: readRecipients(d.recipientsBase),
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
