// 送るメール（と Gmail の下書き）の中身を組み立てる。送信と下書きの保存で同じ関数を通し、
// 「下書きを純正から送っても、Re:Mail から送ったのと同じメール」になるようにする（絶対ルール2）。
// ここは純粋な部分だけ（署名・引用の補い・送信元の選択は useSend.ts の prepareOutgoing）
import type { Email } from "../types/email";
import { normalizeComposeHtml, composeHtmlToText, composeBodyText, imageCids, COMPOSE_LIMITS } from "./composeHtml";
import { recipientsHeader, type ComposeRecipient } from "./composeRecipients";
import { replySubjectFor, buildReferences, type SendAsInfo } from "./replyCompose";

// /api/emails の送信・下書きの API に渡す内容
export type SendApiPayload = {
  to: string;
  cc?: string;
  bcc?: string;
  from?: string;
  replyTo?: string;
  references?: string;
  // 転送のとき、このメッセージ ID のメールの添付をサーバー側で取り直して一緒に送る
  forwardAttachmentsFrom?: string;
  subject: string;
  body: string;
  bodyHtml?: string;
  threadId?: string;
  inReplyTo?: string;
  accountEmail: string;
  attachments?: { filename: string; mimeType: string; data: string }[];
  // 本文中の画像（multipart/related のインライン画像。HTML から cid: で参照する）
  inlineImages?: { contentId: string; filename: string; mimeType: string; data: string }[];
  // Gmail から読み込んだ下書きの添付（中身は持たない）。サーバーが今の下書き（draftId）から取り直して付ける
  draftAttachments?: { filename: string; size: number }[];
};

export type OutgoingImage = { cid: string; filename: string; mimeType: string; size: number; data: string };
// fromDraft は Gmail から読み込んだ下書きの添付（data は空。保存・送信のときにサーバーが下書きから取り直す）
export type OutgoingAttachment = { filename: string; mimeType: string; size: number; data: string; fromDraft?: boolean };

export type FinalizeInput = {
  accountEmail: string;
  // 入力欄の HTML（署名・引用を補ったあと。たたんでいる引用・署名も含む）
  html: string;
  images: OutgoingImage[];
  attachments: OutgoingAttachment[];
  // 宛先（グループは呼び出し側で To を作って渡す）
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  replyToMessage: Pick<Email, "subject" | "threadId" | "messageIdHeader" | "references"> | null;
  alias: Pick<SendAsInfo, "sendAsEmail" | "displayName" | "isPrimary" | "replyToAddress"> | null;
  maxTotalBytes: number;
  // 返信元のメールが見つからない Gmail の下書きで、そのまま残すスレッドの情報（返信元があればそちらを使う）
  threadRef?: { threadId?: string; inReplyTo?: string; references?: string };
};

export type FinalizeResult =
  | { ok: true; payload: SendApiPayload; bodyText: string; subject: string; threadId?: string }
  | { ok: false; error: "tooLong" | "tooLarge" };

// 送信先の一覧から To / Cc / Bcc のヘッダーを作る
export function headersOf(list: ComposeRecipient[]): { to: string; cc: string; bcc: string } {
  return { to: recipientsHeader(list, "to"), cc: recipientsHeader(list, "cc"), bcc: recipientsHeader(list, "bcc") };
}

// 既定のアドレス（primary）から送るときは From を付けず、Gmail に純正と同じ形で入れさせる
export function fromHeaderOf(alias: FinalizeInput["alias"]): string | undefined {
  if (!alias || alias.isPrimary) return undefined;
  return alias.displayName ? `${alias.displayName} <${alias.sendAsEmail}>` : alias.sendAsEmail;
}

// 本文・署名・引用は組み立て直さず、入力欄の HTML を純正の形に整える。本文から参照している画像だけをインライン画像にする
export function finalizeOutgoing(input: FinalizeInput): FinalizeResult {
  const reply = input.replyToMessage;
  // 返信は純正 Gmail と同じ形にする（threadId・In-Reply-To・References を付け、件名は「Re: 元の件名」に揃える）
  const subject = reply ? replySubjectFor(reply.subject) : input.subject;
  const ref = reply ? null : input.threadRef || null;
  const threadId = reply?.threadId || ref?.threadId || undefined;
  const finalHtml = normalizeComposeHtml(input.html, reply ? "reply" : "new");
  if (finalHtml.length > COMPOSE_LIMITS.maxHtmlChars) return { ok: false, error: "tooLong" };
  const usedCids = imageCids(finalHtml);
  const used = input.images.filter(i => usedCids.has(i.cid));
  const totalBytes = input.attachments.reduce((n, a) => n + a.size, 0) + used.reduce((n, i) => n + i.size, 0);
  if (totalBytes > input.maxTotalBytes) return { ok: false, error: "tooLarge" };
  const inlineImages = used.map(i => ({ contentId: i.cid, filename: i.filename, mimeType: i.mimeType, data: i.data }));
  const payload: SendApiPayload = {
    to: input.to, cc: input.cc || undefined, bcc: input.bcc || undefined,
    subject, body: composeHtmlToText(finalHtml), bodyHtml: finalHtml,
    threadId,
    inReplyTo: reply ? reply.messageIdHeader : ref?.inReplyTo,
    references: reply ? buildReferences(reply.references, reply.messageIdHeader) || undefined : ref?.references,
    from: fromHeaderOf(input.alias), replyTo: input.alias?.replyToAddress || undefined,
    accountEmail: input.accountEmail,
    attachments: input.attachments.filter(a => !a.fromDraft).map(a => ({ filename: a.filename, mimeType: a.mimeType, data: a.data })),
    inlineImages: inlineImages.length ? inlineImages : undefined,
  };
  const fromDraft = input.attachments.filter(a => a.fromDraft);
  if (fromDraft.length) payload.draftAttachments = fromDraft.map(a => ({ filename: a.filename, size: a.size }));
  return { ok: true, payload, bodyText: composeBodyText(finalHtml), subject, threadId };
}
