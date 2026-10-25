// 送る：送信 API の呼び出し（自動で再試行しない。結果が分からなければ送信済みと照合する）・送る前の確認・返信・転送。
// useMailApp.ts から分けた（動きは変えない。中身は場所を移しただけ）
import type { MutableRefObject } from "react";
import type { Session } from "next-auth";
import type { ChatConfig } from "../types/mail";
import type { Email } from "../types/email";
import { setCachedAttachment, attachmentCacheKey } from "../lib/attachmentCache";
import { removeDraft } from "../lib/drafts";
import { isComposeBodyEmpty, withSignature, withQuote, signatureOf, buildQuoteHtml, hasQuote } from "../lib/composeHtml";
import type { InlineImage } from "../lib/composeEditor";
import { groupMemberAddresses } from "../lib/groupEmails";
import { type RoomKeyStr, asLocalKey, encodeRoomKey, decodeRoomKey } from "../lib/roomKey";
import { makeMessageId, isRateLimitReason } from "../lib/sendVerify";
import { excludesPartner, quoteGoesToOutsiders, type ComposeRecipient } from "../lib/composeRecipients";
import { buildReferences, pickSendAs, formatQuoteHeader, quoteTimeOf, extractHtmlBodyInner, forwardSubjectFor, composeForwardBodies } from "../lib/replyCompose";
import { finalizeOutgoing, headersOf, fromHeaderOf, type SendApiPayload } from "../lib/outgoingMail";
import { judgeDraftSend, type DraftSendVerdict } from "../lib/gmailDrafts";
import { isMineEmail } from "../lib/filterMatch";
import { logError, logWarn } from "../lib/safeLog";
import type { useSendAs } from "./useSendAs";
import type { useDrafts, Attachment } from "./useDrafts";
import type { ComposeDialog } from "./useMailApp";
import type { GmailDraftSyncApi } from "./useGmailDraftSync";
import type { SetState } from "./mailAppTypes";

// unconfirmed: 送れたか分からず、送信済みにも見つからなかった / unverifiable: 送信済みを確かめることもできなかった
type SendApiResult = { ok: true; id?: string; threadId?: string } | { ok: false; reason: "failed" | "unconfirmed" | "unverifiable"; status?: number; code?: string; gmailReason?: string };
// 送る中身（開いているチャットの入力。Gmail の下書きに保存するときは、開いていないチャットの端末の下書き）
export type OutgoingContent = {
  room: RoomKeyStr;
  subject: string;
  html: string;
  images: InlineImage[];
  insertedSignature: string | null;
  replyToMessage: Email | null;
  attachments: Attachment[];
  // 送信先（既定のときは開いているチャットの相手を To に1人）
  recipients: ComposeRecipient[];
  // Gmail から読み込んだ下書きで、返信元のメールが見つからなかったときに残すスレッドの情報
  threadRef?: { threadId?: string; inReplyTo?: string; references?: string };
  // Gmail から読み込んだ下書きの差出人のアドレス（純正で選んだエイリアスのまま保存・送信する）
  fromAddress?: string;
};
export type PreparedOutgoing =
  | { ok: true; payload: SendApiPayload; bodyText: string; subject: string; threadId?: string; to: string; cc: string; bcc: string }
  | { ok: false; kind: "groupNoAddress" | "noSendAs" | "noQuote" | "tooLong" | "tooLarge" };
type SendAsApi = ReturnType<typeof useSendAs>;
type DraftsApi = ReturnType<typeof useDrafts>;

export function useSend({
  session, selectedSender, selectedSenderRef, chatConfigs, chatConfigsRef, groupedEmails, roomAccountEmail, getRoomRecipient, setEmails,
  currentCompose, loadCompose, insertedSignatureRef, effectiveRecipients, partnerAddressOf, askMoveForRecipients, fetchOriginalFull, MAX_TOTAL_ATTACHMENT_BYTES,
  replyToMessage, setReplyToMessage, replySubject, setReplySubject, replyAttachments, setReplyAttachments, setAttachError, setRecipients, setRecipientsBase,
  setComposeDialog, setIsSending, setSendConfirm, myAddressesFor, getSendAs, draftChatsRef, removeDraftChat, showInfoToast, setInfoToast, showErrorToast, gmailDrafts,
}: {
  session: Session | null;
  selectedSender: RoomKeyStr | null;
  selectedSenderRef: MutableRefObject<RoomKeyStr | null>;
  chatConfigs: Record<RoomKeyStr, ChatConfig>;
  chatConfigsRef: MutableRefObject<Record<RoomKeyStr, ChatConfig>>;
  groupedEmails: Record<RoomKeyStr, Email[]>;
  roomAccountEmail: (room: string) => string;
  getRoomRecipient: (room: RoomKeyStr) => string;
  setEmails: SetState<Email[]>;
  currentCompose: () => { html: string; images: InlineImage[] };
  loadCompose: (html: string, images: InlineImage[]) => void;
  insertedSignatureRef: MutableRefObject<string | null>;
  effectiveRecipients: ComposeRecipient[];
  partnerAddressOf: (room: RoomKeyStr | null) => string;
  askMoveForRecipients: (list: ComposeRecipient[]) => void;
  fetchOriginalFull: (message: Email, account: string) => Promise<{ html: string | null; text: string | null; internalDate?: number; receivedAt?: number }>;
  MAX_TOTAL_ATTACHMENT_BYTES: number;
  replyToMessage: Email | null;
  setReplyToMessage: SetState<Email | null>;
  replySubject: string;
  setReplySubject: SetState<string>;
  replyAttachments: Attachment[];
  setReplyAttachments: SetState<Attachment[]>;
  setAttachError: SetState<string | null>;
  setRecipients: SetState<ComposeRecipient[] | null>;
  setRecipientsBase: SetState<ComposeRecipient[] | null>;
  setComposeDialog: SetState<ComposeDialog | null>;
  setIsSending: SetState<boolean>;
  setSendConfirm: SetState<{ message: string; resend: () => Promise<void>; actionLabel?: string } | null>;
  myAddressesFor: SendAsApi["myAddressesFor"];
  getSendAs: SendAsApi["getSendAs"];
  draftChatsRef: DraftsApi["draftChatsRef"];
  removeDraftChat: DraftsApi["removeDraftChat"];
  showInfoToast: (message: string | null, durationMs?: number) => void;
  setInfoToast: SetState<string | null>;
  showErrorToast: (message: string) => void;
  gmailDrafts: GmailDraftSyncApi;
}) {
  // 送信 API を呼ぶ。送信は自動で再試行しない（二重送信になるため）。
  // 結果が分からないとき（ブラウザと Worker の通信断、Worker が途中で落ちた）は送信済みフォルダと照合する
  const postSendApi = async (payload: SendApiPayload, messageId: string): Promise<SendApiResult> => {
    const sentAfterMs = Date.now();
    const verify = async (): Promise<SendApiResult> => {
      try {
        const v = await fetch("/api/emails", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "verifySent", accountEmail: payload.accountEmail, messageId, to: payload.to, cc: payload.cc, bcc: payload.bcc, subject: payload.subject, body: payload.body, sentAfterMs }),
        });
        if (!v.ok) return { ok: false, reason: "unverifiable" };
        const d = (await v.json()) as { found?: boolean; id?: string; threadId?: string };
        return d.found ? { ok: true, id: d.id, threadId: d.threadId } : { ok: false, reason: "unconfirmed" };
      } catch {
        return { ok: false, reason: "unverifiable" };
      }
    };

    let res: Response;
    try {
      res = await fetch("/api/emails", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "send", ...payload, messageId }),
      });
    } catch {
      return verify();
    }
    if (res.ok) {
      const d = (await res.json().catch(() => ({}))) as { id?: string; threadId?: string };
      return { ok: true, id: d.id, threadId: d.threadId };
    }
    const err = (await res.json().catch(() => ({}))) as { error?: string; reason?: string; stage?: string; status?: number };
    if (err.error === "SEND_UNCONFIRMED") return { ok: false, reason: "unconfirmed" };
    // JSON を返さない 5xx は Worker が途中で落ちた可能性があり、送れたかどうか分からないので照合する
    if (res.status >= 500 && !err.error) return verify();
    // 原因を追えるよう、段階・ステータス・Gmail の理由コードだけを残す
    logWarn(`send.failed.${err.stage || "send"}`, { status: err.status ?? res.status, reason: err.reason });
    return { ok: false, reason: "failed", status: res.status, code: err.error, gmailReason: err.reason };
  };

  // 送信して、成功なら onSent、失敗ならトースト、結果が分からなければ再送するかを確認する。
  // 再送するときは同じ Message-ID を使う（最初の分が遅れて届いていた場合に、同じメールとして扱われやすくするため）
  const sendWithConfirm = async (
    payload: SendApiPayload,
    label: "送信" | "転送",
    onSent: (sent: { id?: string; threadId?: string }) => void,
    messageId: string = makeMessageId(crypto.getRandomValues(new Uint8Array(40))),
  ): Promise<void> => {
    const r = await postSendApi(payload, messageId);
    if (r.ok) { onSent(r); return; }
    if (r.reason === "failed") {
      showSendFailure(r, label);
      return;
    }
    const message = r.reason === "unconfirmed"
      ? `${label}されていません。再送しますか？`
      : `${label}できたか確認できませんでした。Gmail の送信済みを確認してから、必要なら再送してください。`;
    setSendConfirm({
      message,
      resend: async () => {
        setSendConfirm(null);
        setIsSending(true);
        try { await sendWithConfirm(payload, label, onSent, messageId); } finally { setIsSending(false); }
      },
    });
  };

  // 送る中身を組み立てる（送信と Gmail の下書きの保存で同じものを使う：絶対ルール2）。
  // 送信元（エイリアス）と署名は Gmail の設定に従い、引用がまだ入っていなければ元のメールから取りにいく。
  // noFetch のときは通信が要る補い（引用の取り直し）をせず、要るなら失敗にする（タブを閉じるときの保存の下ごしらえ用）
  const prepareOutgoing = async (c: OutgoingContent, opts: { allowNoSendAs?: boolean; allowFallbackQuote?: boolean; noFetch?: boolean } = {}): Promise<PreparedOutgoing> => {
    const groupCfg = chatConfigsRef.current[c.room];
    const { accountEmail } = decodeRoomKey(c.room);
    let to: string;
    let cc = "";
    let bcc = "";
    if (groupCfg?.isGroup) {
      // グループチャット: メンバー全員へ1通のメールとして一斉送信する
      to = Array.from(groupMemberAddresses(groupCfg)).join(", ");
      // メンバーのアドレスが保存されていない（壊れた）グループには送らない（宛先なしで送ったり、推測した相手に送ったりしない）
      if (!to) return { ok: false, kind: "groupNoAddress" };
    } else {
      // 宛先は入力欄の送信先そのもの（返信元を選んだときに、純正 Gmail と同じ決まりで初期値を入れてある）
      ({ to, cc, bcc } = headersOf(c.recipients));
    }
    // 送信元（エイリアス）と署名は Gmail の設定に従う。元のメールが自分のエイリアス宛てなら、そのエイリアスから返す
    const sendAsList = await getSendAs(accountEmail);
    // 読めなかったときは、純正と違う形（署名なし・既定の送信元）になる。送信なら送る前に確かめる（絶対ルール2）
    if (sendAsList === null && !opts.allowNoSendAs) return { ok: false, kind: "noSendAs" };
    const base = c.replyToMessage || (groupCfg?.isGroup ? null : (groupedEmails[c.room] || []).find(e => !isMineEmail(e, accountEmail) && !e.isMissing) || null);
    // Gmail から読み込んだ下書きは、純正で選んだ差出人を使う（送信元の設定に無いアドレスなら、いつもの決まりで選ぶ）
    const draftFrom = c.fromAddress?.toLowerCase();
    const draftAlias = draftFrom && sendAsList ? sendAsList.find(s => s.sendAsEmail.toLowerCase() === draftFrom) : undefined;
    const alias = sendAsList ? (draftAlias ?? pickSendAs(sendAsList, base ? `${base.to}, ${base.cc || ""}` : "", accountEmail)) : null;

    // 署名を一度も入れられていない（送信元の設定が今まで読めなかった）のに入力欄に署名が無ければ、ここで入れる
    // （黙って署名なしで送らない。自分で消した署名は入れ直さない）
    let html = c.html;
    if (alias?.signature?.trim() && c.insertedSignature === null && signatureOf(html) === null) {
      html = withSignature(html, alias.signature, c.replyToMessage ? "reply" : "new");
    }
    // 本文・署名・引用は組み立て直さず、入力欄の HTML を純正の形に整えて送る。
    // 引用がまだ入っていない（返信元を選んだときに読み込めなかった）ときは、ここでもう一度取りにいく
    if (c.replyToMessage && !hasQuote(html)) {
      if (opts.noFetch) return { ok: false, kind: "noQuote" };
      const original = await fetchOriginalFull(c.replyToMessage, accountEmail);
      if (!original.html && !original.text && !opts.allowFallbackQuote) return { ok: false, kind: "noQuote" };
      html = withQuote(html, buildQuoteHtml(formatQuoteHeader(quoteTimeOf(c.replyToMessage, original), c.replyToMessage.from), original.html ? extractHtmlBodyInner(original.html).inner : null, original.text || c.replyToMessage.body || ""));
    }
    const r = finalizeOutgoing({
      accountEmail, html, images: c.images, attachments: c.attachments, to, cc, bcc, subject: c.subject,
      replyToMessage: c.replyToMessage, alias, maxTotalBytes: MAX_TOTAL_ATTACHMENT_BYTES, threadRef: c.threadRef,
    });
    if (!r.ok) return { ok: false, kind: r.error };
    return { ok: true, payload: r.payload, bodyText: r.bodyText, subject: r.subject, threadId: r.threadId, to, cc, bcc };
  };

  // 送れなかった理由を伝える（次の行動を添える）
  const showSendFailure = (r: { status?: number; code?: string; gmailReason?: string }, label: "送信" | "転送") => {
    showErrorToast(
      isRateLimitReason(r.gmailReason) || r.status === 429 ? `Gmail の利用上限に一時的に達したため${label}できませんでした。1分ほど待ってからもう一度お試しください。`
      : r.code === "FORWARD_ATTACHMENTS_FAILED" ? "元のメールの添付ファイルを取得できなかったため、転送しませんでした。時間をおいてもう一度お試しください。"
      : r.code === "DRAFT_ATTACHMENTS_FAILED" && r.status === 409 ? "Gmail の下書きにあった添付ファイルを取り出せないため、送信しませんでした。その添付を × で外して、必要なら付け直してから送ってください。本文は入力欄に残っています。"
      : r.code === "DRAFT_ATTACHMENTS_FAILED" ? "下書きの添付ファイルを取得できなかったため、送信しませんでした。時間をおいてもう一度お試しください。本文は入力欄に残っています。"
      : r.status === 401 ? `ログインの有効期限が切れたため${label}できませんでした。再読み込みしてからもう一度お試しください。`
      : r.status === 413 ? `添付ファイルが大きすぎるため${label}できませんでした（合計25MBまで）。`
      : r.code === "NO_RECIPIENTS" ? `送信先がないため${label}できませんでした。送信先を足してからもう一度お試しください。`
      : r.code === "TOO_MANY_RECIPIENTS" ? `送信先が多すぎるため${label}できませんでした（合計500件まで）。`
      : r.code === "INVALID_RECIPIENTS" ? `送信先のメールアドレスに正しくないものがあるため${label}できませんでした。送信先を確認してください。`
      : `メールの${label}に失敗しました。宛先が正しいか確認してください。`
    );
  };

  // Gmail の下書きを送る（drafts.send）。下書きがある入力は必ずこれで送り、失敗しても messages.send に勝手に切り替えない。
  // 最後の保存から変わっていれば今の中身を付けて送る（withContent）。自動では再送しない
  // 中身を付けないときは、最後に読んだ・保存した下書きのメッセージ ID（expectMessageId）を渡し、Gmail 側で書き換えられていたら送らない
  // （画面に無い中身を送らない）
  const postDraftSendApi = async (payload: SendApiPayload, draftId: string, withContent: boolean, messageId: string, expectMessageId: string | null): Promise<DraftSendVerdict> => {
    const sentAfterMs = Date.now();
    // 中身を付けないときは、照合に使う宛先・件名・本文の文字だけを渡す（添付・画像は送らない）
    const body = withContent ? payload : { ...payload, bodyHtml: undefined, attachments: undefined, inlineImages: undefined, draftAttachments: undefined };
    const verify = async () => {
      try {
        const v = await fetch("/api/emails", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "verifySent", accountEmail: payload.accountEmail, draftId, messageId, to: payload.to, cc: payload.cc, bcc: payload.bcc, subject: payload.subject, body: payload.body, sentAfterMs }),
        });
        return v.ok ? ((await v.json()) as { found: boolean; id?: string; threadId?: string; draftExists?: boolean }) : null;
      } catch {
        return null;
      }
    };
    let res: Response;
    try {
      res = await fetch("/api/emails", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "draftSend", ...body, draftId, withContent, messageId, expectMessageId: expectMessageId || undefined }),
      });
    } catch {
      return judgeDraftSend({ status: null, verify: await verify() });
    }
    const d = (await res.json().catch(() => ({}))) as { error?: string; reason?: string; id?: string; threadId?: string };
    // JSON を返さない 5xx は Worker が途中で落ちた可能性があり、送れたかどうか分からないので照合する
    if (res.status >= 500 && !d.error) return judgeDraftSend({ status: null, verify: await verify() });
    const verdict = judgeDraftSend({ status: res.status, error: d.error, reason: d.reason, id: d.id, threadId: d.threadId });
    if (verdict.kind === "failed") logWarn("draft.send.failed", { status: res.status, reason: d.reason });
    return verdict;
  };

  // 下書きを送って、結果に応じて伝える・確かめる。onGone は「ほかで送信済み」のとき（入力欄を空に戻す）
  const sendDraftWithConfirm = async (
    payload: SendApiPayload, draft: { room: RoomKeyStr; draftId: string; withContent: boolean; messageId: string; expectMessageId: string | null },
    onSent: (sent: { id?: string; threadId?: string }) => void, onAlreadySent: () => void,
  ): Promise<void> => {
    gmailDrafts.sendingRoomsRef.current.add(draft.room);
    let v: DraftSendVerdict;
    try { v = await postDraftSendApi(payload, draft.draftId, draft.withContent, draft.messageId, draft.expectMessageId); } finally { gmailDrafts.sendingRoomsRef.current.delete(draft.room); }
    if (v.kind === "sent") { onSent(v); return; }
    if (v.kind === "conflict") {
      showErrorToast("この下書きは Gmail で書き換えられていたため、送信しませんでした。最新の下書きを読み込みますので、内容を確かめてからもう一度送ってください。");
      gmailDrafts.reportConflict(draft.room);
      return;
    }
    if (v.kind === "alreadySent") { showInfoToast("このメールは別の場所から送信済みです", 4000); onAlreadySent(); return; }
    if (v.kind === "failed") { showSendFailure({ status: v.status, code: v.code, gmailReason: v.reason }, "送信"); return; }
    if (v.kind === "askResend") {
      setSendConfirm({
        message: "送信されていません。再送しますか？",
        resend: async () => {
          setSendConfirm(null);
          setIsSending(true);
          try { await sendDraftWithConfirm(payload, draft, onSent, onAlreadySent); } finally { setIsSending(false); }
        },
      });
      return;
    }
    // 下書きが無くなっていた（ほかで削除・送信された）。送信済みに見つからなければ、新しいメールとして送るかを聞く。
    // 送れたか確かめられなかったときも、Gmail の送信済みを見てから決めてもらう。どちらも「送る」のときだけ messages.send
    gmailDrafts.forgetLink(draft.room);
    setSendConfirm({
      message: v.kind === "askNew"
        ? "この下書きは別の場所で削除されたか、送信済みです。本文は入力欄に残っています。新しいメールとして送りますか？"
        : "送信できたか確認できませんでした。Gmail の送信済みを確認してから、必要なら再送してください。",
      actionLabel: v.kind === "askNew" ? "送る" : undefined,
      resend: async () => {
        setSendConfirm(null);
        setIsSending(true);
        // 新しいメールは新しい Message-ID で送る（確かめられなかったときの再送は、同じメールとして扱われやすいよう同じものを使う）
        try { await sendWithConfirm(payload, "送信", onSent, v.kind === "askNew" ? undefined : draft.messageId); } finally { setIsSending(false); }
      },
    });
  };

  const handleSend = async (opts: { allowNoSendAs?: boolean; allowQuoteToOutsiders?: boolean; allowFallbackQuote?: boolean } = {}) => {
    if (!selectedSender) return;
    // 入力欄の今の中身（署名・引用を含む HTML と本文中の画像）。本文が空なら送らない
    const compose = currentCompose();
    if (isComposeBodyEmpty(compose.html)) return;
    const groupCfg = chatConfigs[selectedSender];
    if (groupCfg?.isGroup && (groupCfg.groupMode === "inbound_only" || groupCfg.filterCriteria)) return; // 受信専用・フィルターグループは送信不可
    // 送る直前にも送信先を確かめる（どこかで抜けていても、相手を含まない送信先のまま今のチャットから送らない）
    const sendRecipients = effectiveRecipients;
    if (!groupCfg?.isGroup) {
      if (sendRecipients.length === 0) {
        showErrorToast("送信先がありません。「＋ 送信先を追加」から選んでください。本文は入力欄に残っています。");
        return;
      }
      if (excludesPartner(sendRecipients, partnerAddressOf(selectedSender))) { askMoveForRecipients(sendRecipients); return; }
      // 引用が元のやり取りにいなかった人にだけ届くときは、送る前に確かめる（純正と違う結果になりうるため）
      if (replyToMessage && !opts.allowQuoteToOutsiders && quoteGoesToOutsiders(sendRecipients, replyToMessage, myAddressesFor(roomAccountEmail(selectedSender)))) {
        setComposeDialog({
          kind: "confirm",
          message: "元のメールの内容（引用）が、元のやり取りにいなかった人に届きます。送りますか？",
          confirmLabel: "送る",
          cancelLabel: "やめる",
          onConfirm: () => { void handleSend({ ...opts, allowQuoteToOutsiders: true }); },
        });
        return;
      }
    }
    setIsSending(true);
    try {
      // 送信元アカウントはチャット自身の複合キーから決める（開いているチャットがどの連携アカウント
      // 宛のやり取りかによって、送信に使うGmailアカウントを切り替えるため）
      const { accountEmail: sendAccountEmail, localKey: sendLocalKey } = decodeRoomKey(selectedSender);
      // 返信は純正 Gmail と同じ形にする（threadId・In-Reply-To・References を付け、件名は「Re: 元の件名」に揃える。
      // 件名を変えると Gmail がスレッドを分けてしまうため、返信先を選んでいるときは件名の入力欄を使わない）。
      // 本文の後に署名、その後に引用を付ける。Re:Mail の画面では、受信時の引用除去（stripQuotedReply・
      // stripHtmlQuote）で引用は折りたたまれ、代わりに「どのメッセージへの返信か」のチップで見せる
      const content: OutgoingContent = {
        room: selectedSender, subject: replySubject, html: compose.html, images: compose.images, insertedSignature: insertedSignatureRef.current,
        replyToMessage, attachments: replyAttachments, recipients: sendRecipients, threadRef: gmailDrafts.threadRefFor(selectedSender),
        fromAddress: gmailDrafts.fromAddressFor(selectedSender),
      };
      const prep = await prepareOutgoing(content, opts);
      if (!prep.ok) {
        if (prep.kind === "groupNoAddress") showErrorToast("このグループはメンバーのアドレスが読めないため送信できません。グループを作り直してください。本文は入力欄に残っています。");
        else if (prep.kind === "noSendAs") setSendConfirm({
          message: "署名と送信元の設定を読み込めませんでした。純正 Gmail と違い、署名なし・既定のアドレスで送ることになります。このまま送りますか？",
          actionLabel: "このまま送る",
          resend: async () => { setSendConfirm(null); await handleSend({ ...opts, allowNoSendAs: true }); },
        });
        else if (prep.kind === "noQuote") setSendConfirm({
          message: "元のメールを読み込めなかったため、引用は画面に出ている本文（整形済み）で入れることになります。このまま送りますか？",
          actionLabel: "このまま送る",
          resend: async () => { setSendConfirm(null); await handleSend({ ...opts, allowFallbackQuote: true }); },
        });
        else if (prep.kind === "tooLong") showErrorToast("本文が長すぎるため送れません（本文は100万文字まで）。本文は入力欄に残っています。");
        else showErrorToast(`添付ファイルと本文中の画像が合わせて${Math.round(MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024)}MBを超えるため送れません。本文は入力欄に残っています。`);
        return;
      }
      const { payload, bodyText: finalBody, subject: finalSubject, threadId, to: actualTo, cc: actualCc, bcc: actualBcc } = prep;
      // 再送の確認ダイアログから呼ばれたときにも同じ内容で処理できるよう、送信時点の値を取っておく
      const sentReplyTo = replyToMessage;
      const sentAttachmentsData = replyAttachments;
      const sentRoom = selectedSender;

      // 送れた・ほかで送信済みだったときに、入力欄と端末の下書きを空に戻す。送信中に別のチャットへ移っていたら、そちらの入力欄は消さない
      const clearSentCompose = () => {
        gmailDrafts.markSent(sentRoom, { subject: content.subject, html: content.html, images: content.images, attachments: content.attachments, replyToMessage: content.replyToMessage });
        gmailDrafts.forgetLink(sentRoom);
        void removeDraft(sentRoom);
        if (selectedSenderRef.current === sentRoom) {
          setReplySubject(""); setReplyToMessage(null); setReplyAttachments([]); setAttachError(null); setRecipients(null); setRecipientsBase(null);
          // 入力欄を空にする（署名は下の決まりで入れ直す）
          insertedSignatureRef.current = null;
          loadCompose("", []);
        }
        // 送信できたので下書きチャットではなくなった（送信済みメールにより通常のチャットとして表示される）
        if (sentRoom && draftChatsRef.current.includes(sentRoom)) removeDraftChat(sentRoom);
      };
      const onSent = (sentData: { id?: string; threadId?: string }) => {
        // Gmailが実際に採番したIDを使う（リロード後の再取得でも同じメールとして同一視できるようにするため）。
        // 取得できなかった場合のみ、その場限りのフェイクIDにフォールバックする
        const sentId: string = sentData.id || `fake-${Date.now()}`;
        const sentAttachments = sentAttachmentsData.map(a => ({ filename: a.filename, mimeType: a.mimeType, size: a.size }));
        const sentFake = {
          id: sentId,
          threadId: sentData.threadId || threadId || "",
          subject: finalSubject || "(件名なし)",
          from: sendAccountEmail || "自分",
          to: actualTo,
          cc: actualCc || undefined,
          bcc: actualBcc || undefined,
          date: new Date().toUTCString(),
          body: finalBody,
          snippet: finalBody.slice(0, 60),
          senderRoom: sendLocalKey,
          isMe: true,
          labelIds: ["SENT"],
          inReplyTo: sentReplyTo?.messageIdHeader,
          replyToId: sentReplyTo?.id,
          accountId: sendAccountEmail,
          attachments: sentAttachments,
        };
        // 添付ファイルの中身は既にローカルで持っているため、再取得を待たずに
        // アタッチメントキャッシュへ先回りで書き込んでおく（再取得後の実IDでもキーが一致するように、
        // TalkView.tsx側のattachmentCacheKeyと同じ組み立て方＝messageId+添付順+ファイル名+サイズを使う）
        sentAttachmentsData.forEach((a, idx) => {
          // Gmail の下書きから取り直した添付は中身を持っていないので、先回りのキャッシュには入れない
          if (a.fromDraft) return;
          setCachedAttachment(attachmentCacheKey(sendAccountEmail, sentId, idx, a.filename, a.size), a.data);
        });
        setEmails(prev => [sentFake, ...prev]);
        clearSentCompose();
      };

      // Gmail の下書きがある入力は drafts.send で送る（純正の下書きと二重に残らない・二重に送られないように）。
      // 保存の途中なら終わるのを待ち、送っている間は保存しない
      gmailDrafts.sendingRoomsRef.current.add(sentRoom);
      try {
        await gmailDrafts.waitIdle();
        const link = gmailDrafts.linkForSend(sentRoom);
        // Gmail から読み込んだ下書きは、こちらで付けた Message-ID を持たない（照合に使うだけなので、無ければここで決める）。
        // これが無いと messages.send に回っていた（Gmail の下書きが残り、下書きの添付も付けられずに止まっていた）
        if (link?.draftId) {
          const messageId = link.messageIdHeader || makeMessageId(crypto.getRandomValues(new Uint8Array(40)));
          await sendDraftWithConfirm(payload, { room: sentRoom, draftId: link.draftId, withContent: gmailDrafts.isDirtyNow(sentRoom), messageId, expectMessageId: link.messageId }, onSent, clearSentCompose);
          return;
        }
        await sendWithConfirm(payload, "送信", onSent);
      } finally {
        gmailDrafts.sendingRoomsRef.current.delete(sentRoom);
      }
    } catch (error) { logError("send.reply", {}, error); showErrorToast("メールの送信に失敗しました。通信状況を確認してください。"); } finally { setIsSending(false); }
  };

  // メッセージを任意の宛先（既存のチャットに限らず、新規アドレスも含む）へ転送する。
  // 現在開いているチャットとは無関係に送信できるようにするため handleSend とは独立させている
  // 転送は元のメールの HTML や添付を取り直すので数秒〜十数秒かかる。終わったか分かるよう、
  // その間「転送しています…」を出し、送れたら「転送しました」に変える
  const FORWARDING_MESSAGE = "転送しています…";
  const forwardMessageTo = async (message: Email, recipientIds: string[], opts: { allowNoSendAs?: boolean } = {}) => {
    if (!message || recipientIds.length === 0) return;
    showInfoToast(FORWARDING_MESSAGE);
    try {
      await forwardMessageToInner(message, recipientIds, opts);
    } finally {
      // 送れなかったとき（確認ダイアログを出した・止めた）に「転送しています…」を残さない
      setInfoToast(prev => (prev === FORWARDING_MESSAGE ? null : prev));
    }
  };

  const forwardMessageToInner = async (message: Email, recipientIds: string[], opts: { allowNoSendAs?: boolean }) => {
    const myEmail = session?.user?.email || "";
    // 転送は元メッセージを受信したのと同じアカウントから送る（reply同様、相手から見て自然な送信元にするため）
    const sendAccountEmail = message.accountId || myEmail;
    // recipientIds は contactDirectory 由来の複合キーと、新規入力の生アドレスが混在する
    const toRoomKey = (id: string): RoomKeyStr => {
      try { decodeRoomKey(id); return id as RoomKeyStr; } catch { return encodeRoomKey(myEmail, asLocalKey(id)); }
    };
    const recipientRoomKeys = recipientIds.map(toRoomKey);
    // 既存のチャットの相手には、純正 Gmail と同じく表示名を付けて送る（「髙澤家 <a@example.com>」）
    const addresses = recipientRoomKeys
      .map((room, i) => (groupedEmails[room] ? getRoomRecipient(room) : recipientIds[i].trim().toLowerCase()))
      .filter(Boolean);
    const to = addresses.join(", ");
    if (!to) return;

    const subject = forwardSubjectFor(message.subject || "");

    // 元のメールの添付も一緒に転送する（純正 Gmail と同じ）。送信直後でまだ Gmail の ID が無いメールは
    // 添付を取り直せないので、添付を落として送らずに止める
    const hasAttachments = (message.attachments || []).length > 0;
    if (hasAttachments && (message.id.startsWith("fake-") || message.isMissing)) {
      showErrorToast("送信直後のメールの添付ファイルはまだ転送できません。少し待ってからもう一度お試しください。");
      return;
    }

    // 送信元と署名は返信と同じく Gmail の設定に従う（元のメールが自分のエイリアス宛てなら、そのエイリアスから送る）
    const sendAsList = await getSendAs(sendAccountEmail);
    if (sendAsList === null && !opts.allowNoSendAs) {
      setSendConfirm({
        message: "署名と送信元の設定を読み込めませんでした。純正 Gmail と違い、署名なし・既定のアドレスで送ることになります。このまま送りますか？",
        actionLabel: "このまま送る",
        resend: async () => { setSendConfirm(null); await forwardMessageTo(message, recipientIds, { allowNoSendAs: true }); },
      });
      return;
    }
    const alias = sendAsList ? pickSendAs(sendAsList, `${message.to}, ${message.cc || ""}`, sendAccountEmail) : null;
    const fromHeader = fromHeaderOf(alias);

    // 画面用のテキストは整形済みで情報が欠けるため、元の HTML 本文を取り直してそのまま使う
    const originalFull = await fetchOriginalFull(message, sendAccountEmail);
    const originalHtml = originalFull.html;
    const bodies = composeForwardBodies({
      signatureHtml: alias?.signature,
      original: { from: message.from || "", date: quoteTimeOf(message, originalFull), subject: message.subject || "", to: message.to || "", cc: message.cc, text: originalFull.text || message.body || "", html: originalHtml || undefined },
    });
    const bodyText = bodies.text;
    const bodyHtml = bodies.html;

    // 純正 Gmail の転送は、元のメールへの In-Reply-To / References を付け、送った側では同じスレッドに入れる
    const isRealMessage = !message.id.startsWith("fake-") && !message.isMissing;
    await sendWithConfirm({
      to, subject, body: bodyText, bodyHtml, accountEmail: sendAccountEmail,
      from: fromHeader, replyTo: alias?.replyToAddress || undefined,
      inReplyTo: message.messageIdHeader,
      references: buildReferences(message.references, message.messageIdHeader) || undefined,
      threadId: isRealMessage && message.threadId ? message.threadId : undefined,
      // 本文中の画像（cid:）だけがあるメールでも、サーバーに元のメールから取り直させる
      forwardAttachmentsFrom: isRealMessage && (hasAttachments || /cid:/i.test(originalHtml || "")) ? message.id : undefined,
    }, "転送", (sentData) => {
      // 転送先が既存の個別チャット1件だけの場合は、そのチャットにすぐ反映されるようローカルにも追加する
      // （複数宛先やグループ・新規アドレスの場合は、対応する単一のルームが存在しないため追加しない）
      if (recipientRoomKeys.length === 1 && groupedEmails[recipientRoomKeys[0]] && !chatConfigsRef.current[recipientRoomKeys[0]]?.isGroup) {
        const room = recipientRoomKeys[0];
        const sentFake = {
          id: sentData.id || `fake-${Date.now()}`,
          threadId: sentData.threadId || "",
          subject, from: sendAccountEmail || "自分", to,
          date: new Date().toUTCString(), body: bodyText, snippet: bodyText.slice(0, 60),
          senderRoom: decodeRoomKey(room).localKey, isMe: true, labelIds: ["SENT"],
          accountId: sendAccountEmail,
        };
        setEmails(prev => [sentFake, ...prev]);
      }
      showInfoToast("転送しました", 3000);
    });
  };

  return { handleSend, forwardMessageTo, prepareOutgoing };
}
