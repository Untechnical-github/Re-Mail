// 送る：送信 API の呼び出し（自動で再試行しない。結果が分からなければ送信済みと照合する）・送る前の確認・返信・転送。
// useMailApp.ts から分けた（動きは変えない。中身は場所を移しただけ）
import type { MutableRefObject } from "react";
import type { Session } from "next-auth";
import type { ChatConfig } from "../types/mail";
import type { Email } from "../types/email";
import { setCachedAttachment, attachmentCacheKey } from "../lib/attachmentCache";
import { removeDraft } from "../lib/drafts";
import { isComposeBodyEmpty, normalizeComposeHtml, composeHtmlToText, composeBodyText, withSignature, withQuote, signatureOf, buildQuoteHtml, hasQuote, imageCids, COMPOSE_LIMITS } from "../lib/composeHtml";
import type { InlineImage } from "../lib/composeEditor";
import { groupMemberAddresses } from "../lib/groupEmails";
import { type RoomKeyStr, asLocalKey, encodeRoomKey, decodeRoomKey } from "../lib/roomKey";
import { makeMessageId, isRateLimitReason } from "../lib/sendVerify";
import { recipientsHeader, excludesPartner, quoteGoesToOutsiders, type ComposeRecipient } from "../lib/composeRecipients";
import { replySubjectFor, buildReferences, pickSendAs, formatQuoteHeader, quoteTimeOf, extractHtmlBodyInner, forwardSubjectFor, composeForwardBodies } from "../lib/replyCompose";
import { logError, logWarn } from "../lib/safeLog";
import type { useSendAs } from "./useSendAs";
import type { useDrafts, Attachment } from "./useDrafts";
import type { ComposeDialog } from "./useMailApp";
import type { SetState } from "./mailAppTypes";

// /api/emails の送信 API に渡す内容と、その結果
type SendApiPayload = {
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
};
// unconfirmed: 送れたか分からず、送信済みにも見つからなかった / unverifiable: 送信済みを確かめることもできなかった
type SendApiResult = { ok: true; id?: string; threadId?: string } | { ok: false; reason: "failed" | "unconfirmed" | "unverifiable"; status?: number; code?: string; gmailReason?: string };
type SendAsApi = ReturnType<typeof useSendAs>;
type DraftsApi = ReturnType<typeof useDrafts>;

export function useSend({
  session, selectedSender, selectedSenderRef, chatConfigs, chatConfigsRef, groupedEmails, roomAccountEmail, getRoomRecipient, setEmails,
  currentCompose, loadCompose, insertedSignatureRef, effectiveRecipients, partnerAddressOf, askMoveForRecipients, getReplyBase, fetchOriginalFull, MAX_TOTAL_ATTACHMENT_BYTES,
  replyToMessage, setReplyToMessage, replySubject, setReplySubject, replyAttachments, setReplyAttachments, setAttachError, setRecipients, setRecipientsBase,
  setComposeDialog, setIsSending, setSendConfirm, myAddressesFor, getSendAs, draftChatsRef, removeDraftChat, showInfoToast, setInfoToast, showErrorToast,
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
  getReplyBase: (room: RoomKeyStr | null) => Email | null;
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
      showErrorToast(
        isRateLimitReason(r.gmailReason) || r.status === 429 ? `Gmail の利用上限に一時的に達したため${label}できませんでした。1分ほど待ってからもう一度お試しください。`
        : r.code === "FORWARD_ATTACHMENTS_FAILED" ? "元のメールの添付ファイルを取得できなかったため、転送しませんでした。時間をおいてもう一度お試しください。"
        : r.status === 401 ? `ログインの有効期限が切れたため${label}できませんでした。再読み込みしてからもう一度お試しください。`
        : r.status === 413 ? `添付ファイルが大きすぎるため${label}できませんでした（合計25MBまで）。`
        : r.code === "NO_RECIPIENTS" ? `送信先がないため${label}できませんでした。送信先を足してからもう一度お試しください。`
        : r.code === "TOO_MANY_RECIPIENTS" ? `送信先が多すぎるため${label}できませんでした（合計500件まで）。`
        : r.code === "INVALID_RECIPIENTS" ? `送信先のメールアドレスに正しくないものがあるため${label}できませんでした。送信先を確認してください。`
        : `メールの${label}に失敗しました。宛先が正しいか確認してください。`
      );
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
      let actualTo: string;
      let actualCc = "";
      let actualBcc = "";
      if (groupCfg?.isGroup) {
        // グループチャット: メンバー全員へ1通のメールとして一斉送信する
        actualTo = Array.from(groupMemberAddresses(groupCfg)).join(", ");
        if (!actualTo) {
          // メンバーのアドレスが保存されていない（壊れた）グループには送らない（宛先なしで送ったり、推測した相手に送ったりしない）
          showErrorToast("このグループはメンバーのアドレスが読めないため送信できません。グループを作り直してください。本文は入力欄に残っています。");
          return;
        }
      } else {
        // 宛先は入力欄の送信先そのもの（返信元を選んだときに、純正 Gmail と同じ決まりで初期値を入れてある）
        actualTo = recipientsHeader(sendRecipients, "to");
        actualCc = recipientsHeader(sendRecipients, "cc");
        actualBcc = recipientsHeader(sendRecipients, "bcc");
      }
      
      // 返信は純正 Gmail と同じ形にする（threadId・In-Reply-To・References を付け、件名は「Re: 元の件名」に揃える。
      // 件名を変えると Gmail がスレッドを分けてしまうため、返信先を選んでいるときは件名の入力欄を使わない）。
      // 本文の後に署名、その後に引用を付ける。Re:Mail の画面では、受信時の引用除去（stripQuotedReply・
      // stripHtmlQuote）で引用は折りたたまれ、代わりに「どのメッセージへの返信か」のチップで見せる
      let threadId: string | undefined = undefined;
      let inReplyTo: string | undefined = undefined;
      let references: string | undefined = undefined;
      let finalSubject = replySubject;
      if (replyToMessage) {
        threadId = replyToMessage.threadId || undefined;
        inReplyTo = replyToMessage.messageIdHeader;
        references = buildReferences(replyToMessage.references, replyToMessage.messageIdHeader) || undefined;
        finalSubject = replySubjectFor(replyToMessage.subject);
      }

      // 送信元（エイリアス）と署名は Gmail の設定に従う。元のメールが自分のエイリアス宛てなら、そのエイリアスから返す
      const sendAsList = await getSendAs(sendAccountEmail);
      // 読めなかったときは、純正と違う形（署名なし・既定の送信元）になることを送る前に伝えて確かめる（絶対ルール2）
      if (sendAsList === null && !opts.allowNoSendAs) {
        setSendConfirm({
          message: "署名と送信元の設定を読み込めませんでした。純正 Gmail と違い、署名なし・既定のアドレスで送ることになります。このまま送りますか？",
          actionLabel: "このまま送る",
          resend: async () => { setSendConfirm(null); await handleSend({ ...opts, allowNoSendAs: true }); },
        });
        return;
      }
      const base = getReplyBase(selectedSender);
      const alias = sendAsList ? pickSendAs(sendAsList, base ? `${base.to}, ${base.cc || ""}` : "", sendAccountEmail) : null;
      // 既定のアドレス（primary）から送るときは From を付けず、Gmail に純正と同じ形で入れさせる
      const fromHeader = alias && !alias.isPrimary ? (alias.displayName ? `${alias.displayName} <${alias.sendAsEmail}>` : alias.sendAsEmail) : undefined;

      // 署名を一度も入れられていない（送信元の設定が今まで読めなかった）のに入力欄に署名が無ければ、ここで入れる
      // （黙って署名なしで送らない。自分で消した署名は入れ直さない）
      let composed = compose.html;
      if (alias?.signature?.trim() && insertedSignatureRef.current === null && signatureOf(composed) === null) {
        composed = withSignature(composed, alias.signature, replyToMessage ? "reply" : "new");
      }

      // 本文・署名・引用は組み立て直さず、入力欄の HTML を純正の形に整えて送る。
      // 引用がまだ入っていない（返信元を選んだときに読み込めなかった）ときは、ここでもう一度取りにいく
      let html = composed;
      if (replyToMessage && !hasQuote(html)) {
        const original = await fetchOriginalFull(replyToMessage, sendAccountEmail);
        if (!original.html && !original.text && !opts.allowFallbackQuote) {
          setSendConfirm({
            message: "元のメールを読み込めなかったため、引用は画面に出ている本文（整形済み）で入れることになります。このまま送りますか？",
            actionLabel: "このまま送る",
            resend: async () => { setSendConfirm(null); await handleSend({ ...opts, allowFallbackQuote: true }); },
          });
          return;
        }
        html = withQuote(html, buildQuoteHtml(formatQuoteHeader(quoteTimeOf(replyToMessage, original), replyToMessage.from), original.html ? extractHtmlBodyInner(original.html).inner : null, original.text || replyToMessage.body || ""));
      }
      const finalHtml = normalizeComposeHtml(html, replyToMessage ? "reply" : "new");
      if (finalHtml.length > COMPOSE_LIMITS.maxHtmlChars) {
        showErrorToast("本文が長すぎるため送れません（本文は100万文字まで）。本文は入力欄に残っています。");
        return;
      }
      const finalText = composeHtmlToText(finalHtml);
      const finalBody = composeBodyText(finalHtml);
      // 本文から参照している画像だけを、インライン画像として付ける
      const usedCids = imageCids(finalHtml);
      const inlineImages = compose.images.filter(i => usedCids.has(i.cid)).map(i => ({ contentId: i.cid, filename: i.filename, mimeType: i.mimeType, data: i.data }));
      const totalBytes = replyAttachments.reduce((n, a) => n + a.size, 0) + compose.images.filter(i => usedCids.has(i.cid)).reduce((n, i) => n + i.size, 0);
      if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
        showErrorToast(`添付ファイルと本文中の画像が合わせて${Math.round(MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024)}MBを超えるため送れません。本文は入力欄に残っています。`);
        return;
      }

      const attachmentsToSend = replyAttachments.map(a => ({ filename: a.filename, mimeType: a.mimeType, data: a.data }));

      const payload: SendApiPayload = {
        to: actualTo, cc: actualCc || undefined, bcc: actualBcc || undefined, subject: finalSubject, body: finalText, bodyHtml: finalHtml,
        threadId, inReplyTo, references, from: fromHeader, replyTo: alias?.replyToAddress || undefined,
        accountEmail: sendAccountEmail, attachments: attachmentsToSend, inlineImages: inlineImages.length ? inlineImages : undefined,
      };
      // 再送の確認ダイアログから呼ばれたときにも同じ内容で処理できるよう、送信時点の値を取っておく
      const sentReplyTo = replyToMessage;
      const sentAttachmentsData = replyAttachments;
      const sentRoom = selectedSender;

      await sendWithConfirm(payload, "送信", (sentData) => {
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
          setCachedAttachment(attachmentCacheKey(sendAccountEmail, sentId, idx, a.filename, a.size), a.data);
        });
        setEmails(prev => [sentFake, ...prev]);
        // 送れた分の下書きを消す。送信中に別のチャットへ移っていたら、そちらの入力欄は消さない
        void removeDraft(sentRoom);
        if (selectedSenderRef.current === sentRoom) {
          setReplySubject(""); setReplyToMessage(null); setReplyAttachments([]); setAttachError(null); setRecipients(null); setRecipientsBase(null);
          // 入力欄を空にする（署名は下の決まりで入れ直す）
          insertedSignatureRef.current = null;
          loadCompose("", []);
        }
        // 送信できたので下書きチャットではなくなった（送信済みメールにより通常のチャットとして表示される）
        if (sentRoom && draftChatsRef.current.includes(sentRoom)) removeDraftChat(sentRoom);
      });
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
    const fromHeader = alias && !alias.isPrimary ? (alias.displayName ? `${alias.displayName} <${alias.sendAsEmail}>` : alias.sendAsEmail) : undefined;

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

  return { handleSend, forwardMessageTo };
}
