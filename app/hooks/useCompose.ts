// 入力欄まわり：添付・送信先（To / Cc / Bcc）・返信元と引用・送信元と署名・引用のための元のメールの取り直し。
// useMailApp.ts から分けた（動きは変えない。送ること自体は useSend.ts）
import { useEffect, type MutableRefObject } from "react";
import type { Session } from "next-auth";
import type { ChatConfig } from "../types/mail";
import type { Email } from "../types/email";
import { isMineEmail } from "../lib/filterMatch";
import { type RoomKeyStr, decodeRoomKey } from "../lib/roomKey";
import { withSignature, withQuote, signatureOf, sameSignature, buildQuoteHtml, hasQuote } from "../lib/composeHtml";
import type { InlineImage } from "../lib/composeEditor";
import { normalizeRecipients, excludesPartner, pickMoveTarget, replyChoices, recipientsKey, isValidRecipientAddress, displayRecipientName, type ComposeRecipient } from "../lib/composeRecipients";
import { replySubjectFor, chatSendAs, formatQuoteHeader, quoteTimeOf, extractHtmlBodyInner } from "../lib/replyCompose";
import { logWarn } from "../lib/safeLog";
import type { useSendAs } from "./useSendAs";
import type { CarriedDraft, Attachment } from "./useDrafts";
import type { ComposeDialog } from "./useMailApp";
import type { SetState } from "./mailAppTypes";

type SendAsApi = ReturnType<typeof useSendAs>;

export function useCompose({
  session, selectedSender, selectedSenderRef, chatConfigs, groupedEmails, getRoomPartner, roomAccountEmail, resolveDirectRoom, openChat, ownAddressesFor,
  replyAttachments, setReplyAttachments, setAttachError, replyToMessage, setReplyToMessage, replyToMessageRef, recipients, setRecipients, recipientsBase, setRecipientsBase,
  replySubject, setReplySubject, setComposeDialog, currentCompose, loadCompose, insertedSignatureRef, editorLoad, carryDraftRef, addDraftChat, draftReadyRoom,
  sendAsByAccount, setSendAsByAccount, getSendAs, showInfoToast, showErrorToast, keepSignatureRef,
}: {
  session: Session | null;
  selectedSender: RoomKeyStr | null;
  selectedSenderRef: MutableRefObject<RoomKeyStr | null>;
  chatConfigs: Record<RoomKeyStr, ChatConfig>;
  groupedEmails: Record<RoomKeyStr, Email[]>;
  getRoomPartner: (room: RoomKeyStr) => { name: string; address: string };
  roomAccountEmail: (room: string) => string;
  resolveDirectRoom: (identifier: string, accountEmail?: string, ownAddress?: string) => { room: RoomKeyStr; existing: boolean } | null;
  // そのアカウントの自分のアドレスすべて（主アドレス・sendAs・受信専用アドレス。useSendAs.ts）
  ownAddressesFor: (account: string) => string[];
  openChat: (sender: RoomKeyStr, opts?: { replaceHistory?: boolean }) => Promise<void>;
  replyAttachments: Attachment[];
  setReplyAttachments: SetState<Attachment[]>;
  setAttachError: SetState<string | null>;
  replyToMessage: Email | null;
  setReplyToMessage: SetState<Email | null>;
  replyToMessageRef: MutableRefObject<Email | null>;
  recipients: ComposeRecipient[] | null;
  setRecipients: SetState<ComposeRecipient[] | null>;
  recipientsBase: ComposeRecipient[] | null;
  setRecipientsBase: SetState<ComposeRecipient[] | null>;
  replySubject: string;
  setReplySubject: SetState<string>;
  setComposeDialog: SetState<ComposeDialog | null>;
  currentCompose: () => { html: string; images: InlineImage[] };
  loadCompose: (html: string, images: InlineImage[]) => void;
  insertedSignatureRef: MutableRefObject<string | null>;
  editorLoad: { seq: number; html: string; images: InlineImage[] };
  carryDraftRef: MutableRefObject<CarriedDraft | null>;
  addDraftChat: (room: string) => void;
  draftReadyRoom: string | null;
  sendAsByAccount: SendAsApi["sendAsByAccount"];
  setSendAsByAccount: SendAsApi["setSendAsByAccount"];
  getSendAs: SendAsApi["getSendAs"];
  showInfoToast: (message: string | null, durationMs?: number) => void;
  showErrorToast: (message: string) => void;
  // Gmail から読み込んだ下書きなら true（署名を入れ替えない。useGmailDraftInbound.ts）
  keepSignatureRef: MutableRefObject<((room: string) => boolean) | null>;
}) {
  // 送信APIの上限（app/api/emails/route.tsのMAX_TOTAL_ATTACHMENT_BYTES）と揃えておく
  const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;

  const readFileAsBase64 = (file: File): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // "data:<mime>;base64,xxxx" のうち、base64本体だけを取り出す
      const commaIndex = result.indexOf(",");
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

  // 作成中のメールにファイルを添付する（複数選択・複数回呼び出しの両方に対応。合計サイズの上限を超える分は追加しない）
  const addReplyAttachments = async (files: FileList | File[]) => {
    setAttachError(null);
    const fileArray = Array.from(files);
    const currentTotal = replyAttachments.reduce((sum, a) => sum + a.size, 0);
    let runningTotal = currentTotal;
    const accepted: { filename: string; mimeType: string; size: number; data: string }[] = [];
    const rejected: string[] = [];
    for (const file of fileArray) {
      if (runningTotal + file.size > MAX_TOTAL_ATTACHMENT_BYTES) { rejected.push(file.name); continue; }
      try {
        const data = await readFileAsBase64(file);
        accepted.push({ filename: file.name, mimeType: file.type || "application/octet-stream", size: file.size, data });
        runningTotal += file.size;
      } catch {
        rejected.push(file.name);
      }
    }
    if (accepted.length > 0) setReplyAttachments(prev => [...prev, ...accepted]);
    if (rejected.length > 0) {
      setAttachError(`添付できませんでした（合計${Math.round(MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024)}MBまで）: ${rejected.join(", ")}`);
    }
  };

  const removeReplyAttachment = (index: number) => {
    setReplyAttachments(prev => prev.filter((_, i) => i !== index));
  };

  // 開いている個別チャットで返信するときの宛先の候補。返信先を選んでいればそのメール、
  // なければ相手から届いた最新のメールを元にする（グループチャットは別の決め方なので対象外）
  const getReplyBase = (room: RoomKeyStr | null): Email | null => {
    if (!room || chatConfigs[room]?.isGroup) return null;
    const { accountEmail } = decodeRoomKey(room);
    return replyToMessage || (groupedEmails[room] || []).find(e => !isMineEmail(e, ownAddressesFor(accountEmail)) && !e.isMissing) || null;
  };

  // ---- 送信先（To / Cc / Bcc） ----
  // 開いている個別チャットの相手（To）。アドレスが分からない（形が正しくない）ときは null
  const partnerRecipient = (room: RoomKeyStr | null): ComposeRecipient | null => {
    if (!room || chatConfigs[room]?.isGroup) return null;
    const { partnerKey } = decodeRoomKey(room);
    const { name, address } = getRoomPartner(room);
    // 下書きチャット（まだやり取りが無い）は、ルームのキー（相手の部分）そのものが相手のアドレス
    const addr = address || partnerKey.trim().toLowerCase();
    if (!isValidRecipientAddress(addr)) return null;
    return name ? { address: addr, name, role: "to" } : { address: addr, role: "to" };
  };
  const partnerAddressOf = (room: RoomKeyStr | null): string => partnerRecipient(room)?.address || "";
  // 既定の送信先：開いているチャットの相手を To に1人
  const defaultRecipientsFor = (room: RoomKeyStr | null): ComposeRecipient[] => {
    const p = partnerRecipient(room);
    return p ? [p] : [];
  };
  const effectiveRecipients: ComposeRecipient[] = recipients ?? defaultRecipientsFor(selectedSender);
  // 既定または前回の置き換えから、自分で足した・外したか
  const recipientsCustomized = recipients !== null && recipientsKey(recipients) !== recipientsKey(recipientsBase ?? defaultRecipientsFor(selectedSender));
  const partnerLabel = (room: RoomKeyStr): string => {
    const p = partnerRecipient(room);
    const label = chatConfigs[room]?.customName || p?.name || "";
    return displayRecipientName({ name: label || undefined, address: p?.address || decodeRoomKey(room).partnerKey });
  };

  // 入力中の内容（本文・添付・送信先・返信元・件名）を持って、送信先の人とのチャットへ移る。
  // 同じアカウントにその相手のチャットがあればそこ、無ければ下書きチャットを作る。移り元の下書きは、移り先で読み戻せたら消す
  const moveComposeTo = async (list: ComposeRecipient[]) => {
    const room = selectedSender;
    const target = pickMoveTarget(list);
    if (!room || !target) return;
    // 同じアカウント・同じ自分のアドレスのチャットへ移る（差出人を変えない）
    const { accountEmail, ownAddress } = decodeRoomKey(room);
    const dest = resolveDirectRoom(target.address, accountEmail, ownAddress);
    if (!dest || dest.room === room) { setRecipients(list); return; }
    carryDraftRef.current = {
      room: dest.room, fromRoom: room, subject: replySubject, html: currentCompose().html, images: currentCompose().images, insertedSignature: insertedSignatureRef.current, attachments: replyAttachments,
      recipients: list, recipientsBase, replyToMessage,
    };
    if (!dest.existing) addDraftChat(dest.room);
    await openChat(dest.room);
    showInfoToast(`${displayRecipientName(target)}とのチャットに移りました`, 2500);
  };

  // 今のチャットの相手が送信先から外れるときの確認（「外す確認」と「移る確認」を分けず、この1つだけ出す）
  const askMoveForRecipients = (list: ComposeRecipient[]) => {
    const room = selectedSender;
    const target = pickMoveTarget(list);
    if (!room || !target) return;
    setComposeDialog({
      kind: "confirm",
      message: `${partnerLabel(room)}を外すと、このチャットからは送れません。${displayRecipientName(target)}とのチャットに移って続けますか？ 入力中の本文・添付・送信先・返信元はそのまま持っていきます。`,
      confirmLabel: "移る",
      cancelLabel: "やめる",
      onConfirm: () => { void moveComposeTo(list); },
    });
  };

  // 送信先を変える（足す・外す）。今のチャットの相手が含まれなくなるなら、変える前に移るか確かめる（やめたら変えない）
  const applyRecipients = (next: ComposeRecipient[]) => {
    const room = selectedSender;
    if (!room || chatConfigs[room]?.isGroup) return;
    const list = normalizeRecipients(next).recipients;
    if (excludesPartner(list, partnerAddressOf(room))) { askMoveForRecipients(list); return; }
    setRecipients(list);
  };

  const addComposeRecipients = (additions: ComposeRecipient[]) => {
    const { recipients: list, invalid, overLimit } = normalizeRecipients([...effectiveRecipients, ...additions]);
    if (overLimit > 0) showErrorToast(`送信先は合計${500}件までです。${overLimit}件は足せませんでした。`);
    else if (invalid > 0) showErrorToast(`メールアドレスの形が正しくないため、${invalid}件は足せませんでした。`);
    applyRecipients(list);
  };

  // チップを押したとき：確認を挟んで外す。相手が外れて移ることになるときは、移る確認だけを出す
  const removeComposeRecipient = (address: string) => {
    const room = selectedSender;
    if (!room || chatConfigs[room]?.isGroup) return;
    const key = address.trim().toLowerCase();
    const removed = effectiveRecipients.find(r => r.address.toLowerCase() === key);
    if (!removed) return;
    const next = effectiveRecipients.filter(r => r.address.toLowerCase() !== key);
    if (excludesPartner(next, partnerAddressOf(room))) { askMoveForRecipients(next); return; }
    setComposeDialog({
      kind: "confirm",
      message: `${displayRecipientName(removed)}を送信先から外しますか？`,
      confirmLabel: "外す",
      cancelLabel: "やめる",
      onConfirm: () => setRecipients(next),
    });
  };

  // 返信元を選ぶ。自分と相手以外の宛先があるメールなら「返信」「全員に返信」を選んでもらい、送信先を置き換える。
  // 送信先を自分で変えていたときは、置き換える前に確かめる（やめたら送信先はそのまま）
  // 返信元のメールを取り、入力欄に引用を入れる（純正と同じ「本文 → 引用 → 署名」）。取れなかったら知らせ、送る前にもう一度取りにいく
  const insertQuoteFor = async (m: Email, room: RoomKeyStr) => {
    const original = await fetchOriginalFull(m, roomAccountEmail(room));
    // 待っているあいだにほかのチャットへ移ったり、別のメールを選び直したりしたら入れない
    if (selectedSenderRef.current !== room || replyToMessageRef.current?.id !== m.id) return;
    if (!original.html && !original.text) {
      showErrorToast("引用を読み込めませんでした。送る前にもう一度読み込みます。");
      return;
    }
    const quote = buildQuoteHtml(formatQuoteHeader(quoteTimeOf(m, original), m.from), original.html ? extractHtmlBodyInner(original.html).inner : null, original.text || m.body || "");
    const now = currentCompose();
    loadCompose(withQuote(now.html, quote), now.images);
  };

  // 返信元を外す。引用も消し、返信元を選んだときに自動で入れた件名（Re: 元の件名）も消す（自分で書き換えた件名は残す）
  const clearReplyTarget = () => {
    const m = replyToMessage;
    if (m && replySubject === replySubjectFor(m.subject || "")) setReplySubject("");
    setReplyToMessage(null);
    const now = currentCompose();
    if (hasQuote(now.html)) loadCompose(withQuote(now.html, null), now.images);
  };

  // 送信先の候補から自分のエイリアスを除くため、そのアカウントの送信元の設定が読めるまで待ってから決める
  // （読む前に決めると、自分のエイリアスが送信先に入って自分にも届く）
  const chooseReplyTarget = async (m: Email) => {
    const room = selectedSender;
    if (!room) return;
    setReplyToMessage(m);
    setReplySubject(replySubjectFor(m.subject || ""));
    void insertQuoteFor(m, room);
    if (chatConfigs[room]?.isGroup) return;
    const account = roomAccountEmail(room);
    // 待っているあいだに変わりうるので、押したときの送信先を先に持っておく
    const customizedAtClick = recipientsCustomized;
    const recipientsAtClick = effectiveRecipients;
    let aliases = sendAsByAccount[account];
    if (!aliases) {
      showInfoToast("送信元の設定を読み込んでいます…", 4000);
      const list = await getSendAs(account);
      if (list) { aliases = list; setSendAsByAccount(prev => ({ ...prev, [account]: list })); }
      // 待っているあいだにほかのチャットへ移ったり、別のメールを選び直したりしたら、ここでは何もしない
      if (selectedSenderRef.current !== room || replyToMessageRef.current?.id !== m.id) return;
    }
    const myAddresses = [account, ...(aliases || []).map(a => a.sendAsEmail)].filter(Boolean);
    const choices = replyChoices({ from: m.from, to: m.to, cc: m.cc, replyTo: m.replyTo }, partnerRecipient(room), myAddresses);
    const apply = (list: ComposeRecipient[]) => { setRecipients(list); setRecipientsBase(list); };
    const proceed = () => {
      if (choices.needsChoice) setComposeDialog({ kind: "replyChoice", reply: choices.reply, replyAll: choices.replyAll, onPick: apply });
      else apply(choices.reply);
    };
    const proceedChecked = () => {
      if (customizedAtClick && recipientsKey(recipientsAtClick) !== recipientsKey(choices.reply)) {
        setComposeDialog({
          kind: "confirm",
          message: "送信先を置き換えます。自分で足した人は外れます。",
          confirmLabel: "置き換える",
          cancelLabel: "送信先はそのまま",
          onConfirm: proceed,
        });
        return;
      }
      proceed();
    };
    // 読めなかったときは、送るときの確認（署名なし・既定のアドレス）と同じく、純正と違いうることを伝えて確かめる
    if (!aliases) {
      setComposeDialog({
        kind: "confirm",
        message: "署名と送信元の設定を読み込めませんでした。純正 Gmail と違い、自分のエイリアスが送信先に入ることがあります（そのときは自分にも届きます）。このまま送信先を決めますか？",
        confirmLabel: "このまま決める",
        cancelLabel: "送信先はそのまま",
        onConfirm: proceedChecked,
      });
      return;
    }
    proceedChecked();
  };

  const getSendFrom = (room: RoomKeyStr | null): { account: string; address: string; displayName?: string; isAlias: boolean; cannotSendFrom?: string } | null => {
    if (!room || chatConfigs[room]?.isGroup) return null;
    const account = roomAccountEmail(room);
    const list = sendAsByAccount[account];
    // 差出人はチャットの自分のアドレスで固定（送れないアドレスなら主アドレス。replyCompose.ts の chatSendAs）
    const own = decodeRoomKey(room).ownAddress;
    const alias = list ? chatSendAs(list, own, account) : null;
    const address = alias?.sendAsEmail || account;
    // チャットの自分のアドレスから送れない（受信専用アドレス・確認待ち）ときは、そのアドレス（入力欄に「〇〇から送信されます」と出す）
    // （送信元の設定を読めるまでは分からないので出さない）
    const cannotSendFrom = list && own !== address.toLowerCase() ? own : undefined;
    return { account, address, displayName: alias?.displayName || undefined, isAlias: address.toLowerCase() !== account.toLowerCase(), cannotSendFrom };
  };

  // 署名：送信元（アカウント・エイリアス）の sendAs の署名を入力欄に入れる。送信元が変わったら署名の部分だけを入れ替える（純正と同じ）。
  // 署名を手で書き換えていたら、入れ替える前に確かめる。sendAs が読めるまでは何もしない（読めなければ送る前の確認で伝える）
  const signatureRoom = selectedSender && !chatConfigs[selectedSender]?.isGroup ? selectedSender : null;
  const desiredSignature: string | null | undefined = (() => {
    if (!selectedSender) return undefined;
    const account = roomAccountEmail(selectedSender);
    const list = sendAsByAccount[account];
    if (!list) return undefined;
    // 署名は差出人（チャットの自分のアドレスの sendAs）の署名（今までどおり「差出人の sendAs の署名」）
    const alias = chatSendAs(list, decodeRoomKey(selectedSender).ownAddress, account);
    return alias?.signature?.trim() ? alias.signature : null;
  })();
  const desiredSignatureLabel = (() => {
    const from = getSendFrom(signatureRoom);
    return from ? from.address : "";
  })();
  useEffect(() => {
    const room = selectedSender;
    if (!room || draftReadyRoom !== room || desiredSignature === undefined) return;
    // Gmail から読み込んだ下書きは、純正で手直しした署名（消した署名も）をそのまま残す
    if (keepSignatureRef.current?.(room)) { insertedSignatureRef.current = desiredSignature; return; }
    const now = currentCompose();
    const current = signatureOf(now.html);
    if (sameSignature(current, desiredSignature)) { insertedSignatureRef.current = desiredSignature; return; }
    // 自分で消した署名は入れ直さない（同じ署名のまま）
    if (current === null && insertedSignatureRef.current !== null && sameSignature(insertedSignatureRef.current, desiredSignature)) return;
    const kind = replyToMessageRef.current ? "reply" : "new";
    const apply = () => {
      const latest = currentCompose();
      insertedSignatureRef.current = desiredSignature;
      loadCompose(withSignature(latest.html, desiredSignature, kind), latest.images);
    };
    if (current !== null && insertedSignatureRef.current !== null && !sameSignature(current, insertedSignatureRef.current)) {
      setComposeDialog({
        kind: "confirm",
        message: desiredSignature ? `署名を ${desiredSignatureLabel} の署名に入れ替えます。署名に書き足した内容は消えます。` : `${desiredSignatureLabel} には署名がないため、署名を外します。署名に書き足した内容は消えます。`,
        confirmLabel: desiredSignature ? "入れ替える" : "外す",
        cancelLabel: "今の署名のまま",
        onConfirm: apply,
        // やめたら、今の署名を入れたものとして扱う（何度も聞かない）
        onCancel: () => { insertedSignatureRef.current = desiredSignature; },
      });
      return;
    }
    apply();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- チャット・送信元の署名・入力欄の入れ替えが変わったときだけ見る（入力のたびには動かさない）
  }, [selectedSender, draftReadyRoom, desiredSignature, editorLoad.seq]);

  // 返信・転送で引用するために、元のメールの HTML 本文を取り直す（画面用のテキストは整形済みで情報が欠けるため）。
  // 取れなければ null を返し、呼び出し側はテキスト版を使う
  // 引用・転送に使う元のメールの全体（HTML とテキスト。どちらも引用部分を含み、画面用の整形をしていないもの）
  const fetchOriginalFull = async (message: Email, account: string): Promise<{ html: string | null; text: string | null; internalDate?: number; receivedAt?: number }> => {
    if (typeof message.id !== "string" || message.id.startsWith("fake-") || message.isMissing) return { html: null, text: null };
    try {
      const params = new URLSearchParams({ messageId: message.id, html: "true", full: "true" });
      if (account !== (session?.user?.email || "")) params.append("accountEmail", account);
      // 古い応答を使わないよう、ブラウザのキャッシュを通さない
      const res = await fetch(`/api/emails?${params.toString()}`, { cache: "no-store" });
      if (!res.ok) return { html: null, text: null };
      const data = (await res.json()) as { htmlBody?: string | null; textBody?: string | null; internalDate?: number | null; receivedAt?: number | null };
      // HTML しか無いメールでは textBody に HTML が入るので、テキストとしては使わない
      const text = data.textBody && !/<\/?(html|body|div|p|br)\b/i.test(data.textBody) ? data.textBody : null;
      return { html: data.htmlBody || null, text, internalDate: data.internalDate ?? undefined, receivedAt: data.receivedAt ?? undefined };
    } catch (e) {
      logWarn("original.fetchHtml", {}, e);
      return { html: null, text: null };
    }
  };

  return {
    MAX_TOTAL_ATTACHMENT_BYTES, addReplyAttachments, removeReplyAttachment, getReplyBase, partnerRecipient, partnerAddressOf, effectiveRecipients, recipientsCustomized, partnerLabel,
    askMoveForRecipients, addComposeRecipients, removeComposeRecipient, clearReplyTarget, chooseReplyTarget, getSendFrom, fetchOriginalFull,
  };
}
