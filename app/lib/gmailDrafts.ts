// Gmail の下書きとの同期で使う純粋関数（保存するか・消すか・送った結果をどう扱うか）。
// 端末に置くのは Gmail の下書き ID・メッセージ ID・同期の状態だけ（中身は今までどおりの端末の下書き。drafts.ts）
import type { Email } from "../types/email";
import { normalizeRecipients, recipientsFromHeader, pickMoveTarget, type ComposeRecipient } from "./composeRecipients";
import { isComposeBodyEmpty, mapImageSources, normalizeComposeHtml } from "./composeHtml";
import { isRateLimitReason } from "./sendVerify";

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
  // Gmail から読み込んだ下書きで、返信元のメールが見つからなかったときに保存し直しても残すスレッドの情報
  threadRef?: { threadId?: string; inReplyTo?: string; references?: string };
  // Gmail から読み込んだばかり（入力欄が整えたあとの中身を「保存済み」とみなす）
  fromGmail?: boolean;
  // Gmail から読み込んだ中身の、HTML を整えたうえでの指紋（入力欄が整えただけで「書き換えた」としないため）
  baseNormFp?: string;
  // Gmail から読み込んだ下書きの署名は入れ替えない（純正で手直しした署名をそのまま残す。開いたときの署名の決まりで1度だけ見る）
  keepSignature?: boolean;
  // 新しく作ろうとして結果を受け取れなかった（タブを閉じたときの保存など）。次は同じ中身の下書きを探してから作る
  createAttempted?: boolean;
  // Gmail から読み込んだ下書きの差出人のアドレス（純正でエイリアスを選んで書いた下書きを、同じ差出人のまま保存・送信する）
  fromAddress?: string;
};

export const EMPTY_LINK: GmailDraftLink = { draftId: null, messageId: null, messageIdHeader: null, syncedFingerprint: null };

function readThreadRef(v: unknown): GmailDraftLink["threadRef"] {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const id = (x: unknown) => (typeof x === "string" && /^<[^<>\s]{1,250}>$/.test(x) ? x : undefined);
  const threadId = typeof o.threadId === "string" && /^[0-9a-f]{6,32}$/i.test(o.threadId) ? o.threadId : undefined;
  const references = typeof o.references === "string" && o.references.length <= 4000 && /^(<[^<>\s]{1,250}>\s*)+$/.test(o.references.trim()) ? o.references.trim() : undefined;
  const r = { threadId, inReplyTo: id(o.inReplyTo), references };
  return r.threadId || r.inReplyTo || r.references ? r : undefined;
}

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
    threadRef: readThreadRef(o.threadRef),
    fromGmail: o.fromGmail === true || undefined,
    baseNormFp: typeof o.baseNormFp === "string" && /^[0-9a-z]{1,40}$/.test(o.baseNormFp) ? o.baseNormFp : undefined,
    keepSignature: o.keepSignature === true || undefined,
    fromAddress: typeof o.fromAddress === "string" && o.fromAddress.length <= 254 && /^[^\s@<>",]+@[^\s@<>",]+$/.test(o.fromAddress) ? o.fromAddress : undefined,
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

// HTML を送るときと同じ形に整えてからの指紋。入力欄に入れると HTML の書き方（空白・属性の並びなど）が変わることがあるので、
// Gmail から読み込んだ下書きを「書き換えていない」と見分けるのに使う
// 改行は LF にそろえる（Gmail の下書きの HTML は CRLF を含むが、入力欄に入れると LF になる。2026-10-26 に実機の下書きで確認）
export function normalizedFingerprint(d: DraftContent): string {
  return draftFingerprint({ ...d, html: d.html ? normalizeComposeHtml(d.html.replace(/\r\n?/g, "\n")) : "" });
}

// 最後に Gmail に保存してから書き換えたか。Gmail から読み込んだばかりで入力欄が整えただけのものは、書き換えたことにしない
// 入力を持って同じアカウントのほかのチャットへ移ったときの、移り先のつながり。移り先が既に下書きとつながっていても
// （本文を消しただけで削除が保留・失敗している、純正で作った本文が空の下書きなど）、持ってきた下書きに差し替える
// （添付を持ってきた下書きから取り出せるように。スレッド・差出人も一緒に移る）。移り先がもとつながっていた別の下書きは消す対象として返す。
// 純正で書き換えられていないかを確かめられない（messageId が分からない）ものは消さない（「ほかに下書きが○件」に出す）
export function planCarriedLink(fromLink: GmailDraftLink, toLink: GmailDraftLink | undefined): {
  link: GmailDraftLink;
  staleDraft: { draftId: string; messageId: string } | null;
} {
  const stale = toLink?.draftId && toLink.messageId && toLink.draftId !== fromLink.draftId ? { draftId: toLink.draftId, messageId: toLink.messageId } : null;
  return { link: { ...fromLink, syncedFingerprint: null }, staleDraft: stale };
}

export function hasUnsavedChanges(content: DraftContent, link: GmailDraftLink): boolean {
  if (draftFingerprint(content) === link.syncedFingerprint) return false;
  return !(link.fromGmail && link.baseNormFp && normalizedFingerprint(content) === link.baseNormFp);
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

// 保存に失敗したとき、間をあけて送り直す回数と待ち時間（ミリ秒）。429・5xx・通信断と、レート制限の 403 だけ
export const SAVE_RETRY_DELAYS_MS = [15_000, 60_000, 180_000];
export function isRetryableSaveStatus(status: number | null, reason?: string): boolean {
  return status === null || status === 429 || status >= 500 || (status === 403 && isRateLimitReason(reason));
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
  // 中身を付けずに送ろうとしたら、Gmail 側で書き換えられていた（画面に無い中身を送らないよう、送っていない）
  | { kind: "conflict" }
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
  if (res.error === "DRAFT_CONFLICT") return { kind: "conflict" };
  if (res.error === "SEND_UNCONFIRMED") return { kind: "askResend" };
  if (res.error === "SEND_UNVERIFIED") return { kind: "unverified" };
  return { kind: "failed", status: res.status, code: res.error, reason: res.reason };
}

// ---- Gmail → Re:Mail（段階B） ----

// Gmail の下書きの一覧の1件と、出し先を決めるための宛先など（中身は入れない）
export type GmailDraftMeta = {
  draftId: string;
  messageId: string;
  threadId?: string;
  internalDate: number;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  snippet: string;
};

// 下書きの宛先（To / Cc / Bcc のヘッダー）から送信先の一覧を作る（壊れた・上限を超えた分は捨てる）
export function draftRecipients(m: Pick<GmailDraftMeta, "to" | "cc" | "bcc">): ComposeRecipient[] {
  return normalizeRecipients([...recipientsFromHeader(m.to, "to"), ...recipientsFromHeader(m.cc, "cc"), ...recipientsFromHeader(m.bcc, "bcc")]).recipients;
}

// どのチャットに出すか：To の最初、無ければ Cc、無ければ Bcc の最初の人（pickMoveTarget）。宛先が無ければ null
export function draftTargetAddress(m: Pick<GmailDraftMeta, "to" | "cc" | "bcc">): string | null {
  return pickMoveTarget(draftRecipients(m))?.address.toLowerCase() || null;
}

// 送信先が「チャットの相手を To に1人」だけなら、既定（null）として扱う（本文を消したときに下書きを消せるように）
export function recipientsOrDefault(list: ComposeRecipient[], partnerAddress: string): ComposeRecipient[] | null {
  if (list.length === 1 && list[0].role === "to" && list[0].address.toLowerCase() === partnerAddress.toLowerCase()) return null;
  return list;
}

export type LocalDraftState = { room: string; draftId: string | null; messageId: string | null; dirty: boolean };

// Gmail の下書きの一覧と、端末の下書き（Gmail の下書きとつながっているもの）を比べる。
// - vanished: 端末ではつながっているのに、一覧から消えた（ほかで送信・削除された）
// - changed: Gmail 側で書き換えられた（メッセージ ID が違う）
// - unknown: 端末のどれともつながっていない下書き
export function planDraftReconcile(gmail: { draftId: string; messageId: string }[], local: LocalDraftState[]): {
  vanished: LocalDraftState[];
  changed: { local: LocalDraftState; draftId: string; messageId: string }[];
  unchanged: string[];
  unknown: { draftId: string; messageId: string }[];
} {
  const byId = new Map(gmail.map(g => [g.draftId, g]));
  const linked = new Map(local.filter(l => l.draftId).map(l => [l.draftId as string, l]));
  const vanished = local.filter(l => l.draftId && !byId.has(l.draftId));
  const changed: { local: LocalDraftState; draftId: string; messageId: string }[] = [];
  const unchanged: string[] = [];
  const unknown: { draftId: string; messageId: string }[] = [];
  for (const g of gmail) {
    const l = linked.get(g.draftId);
    if (!l) unknown.push(g);
    else if (l.messageId !== g.messageId) changed.push({ local: l, draftId: g.draftId, messageId: g.messageId });
    else unchanged.push(g.draftId);
  }
  return { vanished, changed, unchanged, unknown };
}

// 1つのチャットに複数あるときは、一番新しいものを入力欄に出す
export function newestDraft<T extends { internalDate: number }>(list: T[]): T | null {
  return list.reduce<T | null>((a, b) => (!a || b.internalDate > a.internalDate ? b : a), null);
}

// 入力欄が扱う本文中の画像の ID は ii_ で始まる形だけ（drafts.ts・inlineImages.ts）。Gmail の下書きのほかの形の ID は付け替え、
// HTML の参照も合わせて直す。付け替えた対応（元の ID → 新しい ID）を返す
export function normalizeDraftCids(html: string, cids: string[], random: () => string): { html: string; map: Record<string, string> } {
  const map: Record<string, string> = {};
  const byLower = new Map<string, string>();
  for (const cid of cids) {
    const next = /^ii_[0-9a-z]{1,24}$/.test(cid) ? cid : `ii_${random().replace(/[^0-9a-z]/g, "").slice(0, 16) || "x"}`;
    map[cid] = next;
    byLower.set(cid.toLowerCase(), next);
  }
  // 画像の src だけを書き換える（正規表現で HTML 全体を置き換えない）
  const out = mapImageSources(html, (src) => {
    if (!/^cid:/i.test(src)) return src;
    const hit = byLower.get(src.slice(4).toLowerCase());
    return hit ? `cid:${hit}` : src;
  });
  return { html: out, map };
}
