// Gmail の下書きとの同期で使う純粋関数（保存するか・消すか・送った結果をどう扱うか）。
// 端末に置くのは Gmail の下書き ID・メッセージ ID・同期の状態だけ（中身は今までどおりの端末の下書き。drafts.ts）
import type { Email } from "../types/email";
import type { ComposeRecipient } from "./composeRecipients";
import { isComposeBodyEmpty } from "./composeHtml";

// 端末の下書きに足す、Gmail の下書きとの同期の状態
export type GmailDraftLink = {
  // Gmail の下書き ID（まだ保存していなければ null）
  draftId: string | null;
  // 最後に同期したときの下書きのメッセージ ID（Gmail は下書きを更新するたびに変える。ほかで書き換えられたかの判定に使う）
  messageId: string | null;
  // 下書きに付ける Message-ID ヘッダー（保存のたびに同じものを付ける）。Gmail は下書きの保存と送信のときに付け替えるので、
  // 送ったあとの照合は宛先・件名・時刻・本文の冒頭で行う（rfc822msgid では見つからない）
  messageIdHeader: string | null;
  // 最後に Gmail に保存した中身の指紋。今の中身の指紋と違えば「まだ保存していない変更がある（dirty）」
  syncedFingerprint: string | null;
  // 新しく作ろうとして結果を受け取れなかった（タブを閉じたときの保存など）。次は同じ中身の下書きを探してから作る
  createAttempted?: boolean;
};

export const EMPTY_LINK: GmailDraftLink = { draftId: null, messageId: null, messageIdHeader: null, syncedFingerprint: null };

// 壊れた値は捨てる（端末に残っていた値を読み戻すとき）
export function readGmailLink(v: unknown): GmailDraftLink | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const str = (x: unknown, re: RegExp) => (typeof x === "string" && re.test(x) ? x : null);
  return {
    draftId: str(o.draftId, /^[A-Za-z0-9_-]{1,64}$/),
    messageId: str(o.messageId, /^[0-9a-f]{6,32}$/i),
    messageIdHeader: str(o.messageIdHeader, /^<[A-Za-z0-9._+=-]{1,190}@[A-Za-z0-9.-]{1,100}>$/),
    syncedFingerprint: str(o.syncedFingerprint, /^[0-9a-z]{1,40}$/),
    createAttempted: o.createAttempted === true || undefined,
  };
}

// 同期の判断に使う中身
export type DraftContent = {
  subject: string;
  html: string;
  images?: { cid: string; size: number; mimeType: string }[];
  attachments: { filename: string; size: number; mimeType: string }[];
  replyToMessage: Pick<Email, "id"> | null;
  recipients?: ComposeRecipient[] | null;
};

// FNV-1a（32ビット）を2本。中身が同じかどうかを見るだけなので暗号のハッシュは要らない（端末の中だけで使う）
function fnv(text: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// 中身の指紋。本文中の画像・添付は中身でなく ID・名前・大きさで見る（入れ直すと cid が変わる）
export function draftFingerprint(d: DraftContent): string {
  const text = JSON.stringify([
    d.subject, d.html,
    (d.images || []).map(i => [i.cid, i.size, i.mimeType]),
    d.attachments.map(a => [a.filename, a.size, a.mimeType]),
    d.replyToMessage?.id || null,
    d.recipients ? d.recipients.map(r => [r.role, r.address.toLowerCase(), r.name || ""]) : null,
  ]);
  return fnv(text, 0x811c9dc5).toString(36) + fnv(text, 0x01234567).toString(36);
}

// 入力が既定のまま（件名・本文・添付が無く、送信先と返信元も既定）。drafts.ts の isEmptyDraft と同じ決まり
export function isDefaultContent(d: DraftContent): boolean {
  return !d.subject.trim() && (!d.html || isComposeBodyEmpty(d.html)) && !d.replyToMessage && d.attachments.length === 0 && !d.recipients;
}

export type SavePlan = "skip" | "save" | "delete" | "forget";

// 保存のときに何をするか。
// - skip: 何もしない（同期しない・変わっていない・送信先が無い）
// - save: drafts.create / update
// - delete: 中身が既定に戻ったので drafts.delete（純正の「下書きを破棄」と同じ）
// - forget: 中身が既定に戻ったが Gmail の下書きはまだ無い（指紋だけ進める）
export function planDraftSave(input: {
  enabled: boolean;
  isGroup: boolean;
  content: DraftContent;
  link: GmailDraftLink;
  recipientCount: number;
}): SavePlan {
  if (!input.enabled || input.isGroup) return "skip";
  if (draftFingerprint(input.content) === input.link.syncedFingerprint) return "skip";
  if (isDefaultContent(input.content)) return input.link.draftId ? "delete" : "forget";
  // 送信先が1人もいない書きかけは Gmail に保存しない
  if (input.recipientCount === 0) return "skip";
  return "save";
}

// タブを閉じるとき（pagehide）の keepalive で送れる大きさ（ブラウザの上限は全体で 64KB。余裕をみる）
export const KEEPALIVE_MAX_BYTES = 60_000;
export function fitsKeepalive(json: string): boolean {
  return new TextEncoder().encode(json).length <= KEEPALIVE_MAX_BYTES;
}

// 保存に失敗したとき、間をあけて送り直す回数と待ち時間（ミリ秒）。429・5xx・通信断だけ
export const SAVE_RETRY_DELAYS_MS = [15_000, 60_000, 180_000];
export function isRetryableSaveStatus(status: number | null): boolean {
  return status === null || status === 429 || status >= 500;
}

// 下書きを送った（drafts.send）結果を、画面でどう扱うかに直す
export type DraftSendVerdict =
  | { kind: "sent"; id?: string; threadId?: string }
  // ほかで送信済み（送信済みに同じメールがあった）
  | { kind: "alreadySent" }
  // 下書きがほかで削除・送信されていて、送信済みにも見つからない → 新しいメールとして送るか聞く
  | { kind: "askNew" }
  // 送れたか分からないが、下書きが残っている → 送られていない。再送するか聞く
  | { kind: "askResend" }
  // 送れたか分からず、下書きも無く、送信済みにも見つからない
  | { kind: "unverified" }
  | { kind: "failed"; status: number; code?: string; reason?: string };

export function judgeDraftSend(res: { status: number | null; error?: string; reason?: string; id?: string; threadId?: string; verify?: { found: boolean; id?: string; threadId?: string; draftExists?: boolean } | null }): DraftSendVerdict {
  // ブラウザと Worker の通信が切れたときは、照合の結果で決める
  if (res.status === null) {
    if (!res.verify) return { kind: "unverified" };
    if (res.verify.found) return { kind: "sent", id: res.verify.id, threadId: res.verify.threadId };
    return res.verify.draftExists ? { kind: "askResend" } : { kind: "unverified" };
  }
  if (res.status >= 200 && res.status < 300) return { kind: "sent", id: res.id, threadId: res.threadId };
  if (res.error === "DRAFT_ALREADY_SENT") return { kind: "alreadySent" };
  if (res.error === "DRAFT_GONE") return { kind: "askNew" };
  if (res.error === "SEND_UNCONFIRMED") return { kind: "askResend" };
  if (res.error === "SEND_UNVERIFIED") return { kind: "unverified" };
  return { kind: "failed", status: res.status, code: res.error, reason: res.reason };
}
