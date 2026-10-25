// 下書き：チャットごとの入力中の内容を端末に保存して読み戻す・送信元や送信先を変えてほかのチャットへ移るときに持っていく・
// まだ1通も送っていない下書きチャット。useMailApp.ts から分けた（動きは変えない）。端末の下書きの中身は app/lib/drafts.ts
import { useState, useEffect, useRef, type Dispatch, type SetStateAction, type MutableRefObject } from "react";
import type { Email } from "../types/email";
import { decodeRoomKey, type RoomKeyStr } from "../lib/roomKey";
import type { InlineImage } from "../lib/composeEditor";
import type { ComposeRecipient } from "../lib/composeRecipients";
import { loadDraft, saveDraft, removeDraft, hasDraftContent, type ComposeDraft } from "../lib/drafts";
import { EMPTY_LINK, type GmailDraftLink } from "../lib/gmailDrafts";
import type { DraftLinkRef } from "./useGmailDraftSync";
import { isComposeBodyEmpty } from "../lib/composeHtml";

// 2つのチャットが同じアカウントのものか
function sameAccountRooms(a: string, b: string): boolean {
  try { return decodeRoomKey(a).accountEmail.toLowerCase() === decodeRoomKey(b).accountEmail.toLowerCase(); } catch { return false; }
}

// fromDraft は Gmail から読み込んだ下書きの添付（data は空。保存・送信のときにサーバーが下書きから取り直す）
export type Attachment = { filename: string; mimeType: string; size: number; data: string; fromDraft?: boolean };
// 送信元の切り替え・送信先の変更でほかのチャットへ移るときに持っていく入力中の内容
export type CarriedDraft = {
  room: string;
  fromRoom: string;
  subject: string;
  // 入力欄の HTML（本文・引用・署名。画像は cid:）と本文中の画像
  html: string;
  images: InlineImage[];
  insertedSignature: string | null;
  attachments: Attachment[];
  recipients: ComposeRecipient[] | null;
  recipientsBase: ComposeRecipient[] | null;
  replyToMessage: Email | null;
};
type SetState<T> = Dispatch<SetStateAction<T>>;

export function useDrafts({
  selectedSender, showErrorToast, setReplySubject, insertedSignatureRef, loadCompose, setReplyToMessage, setReplyAttachments, setRecipients, setRecipientsBase, setAttachError, replySubject, composeHtml, composeImages, replyToMessage, replyAttachments, recipients, recipientsBase,
  linkRef, onCarriedRef,
}: {
  selectedSender: RoomKeyStr | null;
  showErrorToast: (message: string) => void;
  setReplySubject: SetState<string>;
  insertedSignatureRef: MutableRefObject<string | null>;
  loadCompose: (html: string, images: InlineImage[]) => void;
  setReplyToMessage: SetState<Email | null>;
  setReplyAttachments: SetState<Attachment[]>;
  setRecipients: SetState<ComposeRecipient[] | null>;
  setRecipientsBase: SetState<ComposeRecipient[] | null>;
  setAttachError: SetState<string | null>;
  replySubject: string;
  composeHtml: string;
  composeImages: InlineImage[];
  replyToMessage: Email | null;
  replyAttachments: Attachment[];
  recipients: ComposeRecipient[] | null;
  recipientsBase: ComposeRecipient[] | null;
  // 開いているチャットの Gmail の下書きとの同期の状態（useGmailDraftSync.ts と共有する）
  linkRef: DraftLinkRef;
  // 入力中の内容を持ってほかのチャットへ移れたとき（Gmail の下書きを持っていく・消す）
  onCarriedRef: MutableRefObject<((fromRoom: string, toRoom: string, fromLink: GmailDraftLink | undefined, hasDraftAttachments: boolean) => void) | null>;
}) {
  // 「作成」機能で作った、まだ1通も送信していない下書きチャット（未送信のまま離脱すると破棄する）
  // リロード/タブ復元では維持したいので localStorage に保存する
  const [draftChats, setDraftChats] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const saved = localStorage.getItem("remail_draft_chats");
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  // 入力中の返信はチャットごとの下書きとして端末に保存し、チャットを開いたら読み戻す（送信の失敗・通信断・
  // 再読み込みで失わないため。また、別のチャットで書きかけた文が今のチャットに残って誤送信されないため）。
  // draftReadyRoom が今のチャットになるまでは、入力欄と送信ボタンを使えないようにする
  const [draftReadyRoom, setDraftReadyRoom] = useState<string | null>(null);
  // 送信元のアカウントを切り替えたとき・送信先を変えてほかのチャットへ移るときに、移り先のチャットへ持っていく入力中の内容
  const carryDraftRef = useRef<CarriedDraft | null>(null);
  useEffect(() => {
    const room = selectedSender;
    let cancelled = false;
    void (room ? loadDraft(room) : Promise.resolve(null)).then(d => {
      if (cancelled) return;
      const carry = carryDraftRef.current && carryDraftRef.current.room === room ? carryDraftRef.current : null;
      if (carry) carryDraftRef.current = null;
      if (room) linkRef.current = { room, link: d?.gmail ?? { ...EMPTY_LINK } };
      // 移り先に書きかけの下書きが無ければ、移り元で入力していた内容を使い、移り元の下書きは消す（両方に残って二重に送られないように）
      if (carry && (!d?.html || isComposeBodyEmpty(d.html)) && !d?.subject && !d?.attachments?.length && !d?.replyToMessage && !d?.recipients) {
        setReplySubject(carry.subject);
        insertedSignatureRef.current = carry.insertedSignature;
        loadCompose(carry.html, carry.images);
        setReplyToMessage(carry.replyToMessage);
        // Gmail の下書きにしか無い添付は、別のアカウントの下書き・送信には付けられない。外して名前を伝え、元の下書きは Gmail に残す
        const lost = sameAccountRooms(carry.fromRoom, room as string) ? [] : carry.attachments.filter(a => a.fromDraft);
        setReplyAttachments(lost.length ? carry.attachments.filter(a => !a.fromDraft) : carry.attachments);
        if (lost.length) showErrorToast(`Gmail の下書きにあった添付ファイル（${lost.map(a => a.filename).join("、")}）は別のアカウントへ持っていけないため外しました。元のアカウントの Gmail の下書きは残しています。必要なら付け直してください。`);
        setRecipients(carry.recipients);
        setRecipientsBase(carry.recipientsBase);
        setAttachError(null);
        setDraftReadyRoom(room);
        // 移り元の Gmail の下書きは、同じアカウントなら持っていき、違うアカウントなら消す（useGmailDraftSync.ts）
        void loadDraft(carry.fromRoom).then(from => {
          onCarriedRef.current?.(carry.fromRoom, room as string, from?.gmail, carry.attachments.some(a => a.fromDraft));
          return removeDraft(carry.fromRoom);
        });
        return;
      }
      // 移り先にも書きかけがあるときは、どちらも消さずに残す（入力を失わない）
      if (carry) showErrorToast("移り先のチャットに書きかけの内容があったため、入力中の内容は元のチャットに残しました。");
      setReplySubject(d?.subject || "");
      insertedSignatureRef.current = d?.insertedSignature ?? null;
      loadCompose(d?.html || "", d?.images || []);
      setReplyToMessage(d?.replyToMessage || null);
      setReplyAttachments(d?.attachments || []);
      setRecipients(d?.recipients ?? null);
      setRecipientsBase(d?.recipientsBase ?? null);
      setAttachError(null);
      setDraftReadyRoom(room);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 開いているチャットが変わったときだけ読み戻す（useMailApp.ts にあったときと同じ。渡される関数は描画ごとに作り直されるため入れない）
  }, [selectedSender]);
  const draftSaveFailedRef = useRef(false);
  useEffect(() => {
    const room = selectedSender;
    if (!room || draftReadyRoom !== room) return;
    // 打つたびに書き込まないよう、少し待ってからまとめて保存する
    const timer = setTimeout(() => {
      const gmail = linkRef.current?.room === room ? linkRef.current.link : undefined;
      void saveDraft(room, { subject: replySubject, html: composeHtml, images: composeImages, insertedSignature: insertedSignatureRef.current, replyToMessage, attachments: replyAttachments, recipients, recipientsBase, updatedAt: Date.now(), gmail }).then(ok => {
        if (!ok && !draftSaveFailedRef.current) {
          draftSaveFailedRef.current = true;
          showErrorToast("入力中の内容を端末に保存できませんでした。再読み込みすると消えるので、送信するまで画面を閉じないでください。");
        }
      });
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 入力の中身が変わったときだけ保存する（showErrorToast は描画ごとに作り直されるため入れない。ref は入れなくてよい）
  }, [selectedSender, draftReadyRoom, replySubject, composeHtml, composeImages, replyToMessage, replyAttachments, recipients, recipientsBase]);

  const draftChatsRef = useRef(draftChats);
  useEffect(() => { draftChatsRef.current = draftChats; }, [draftChats]);

  const persistDraftChats = (next: string[]) => {
    if (typeof window !== "undefined") localStorage.setItem("remail_draft_chats", JSON.stringify(next));
  };

  const addDraftChat = (room: string) => {
    setDraftChats(prev => {
      if (prev.includes(room)) return prev;
      const next = [...prev, room];
      persistDraftChats(next);
      return next;
    });
  };

  const removeDraftChat = (room: string) => {
    setDraftChats(prev => {
      if (!prev.includes(room)) return prev;
      const next = prev.filter(r => r !== room);
      persistDraftChats(next);
      return next;
    });
  };

  return { draftChats, draftChatsRef, addDraftChat, removeDraftChat, draftReadyRoom, carryDraftRef };
}

export function useDraftChatCleanup({
  selectedSender, selectedSenderRef, draftChatsRef, groupedEmailsRef, carryDraftRef, draftReadyRoom, currentCompose, replySubject, insertedSignatureRef, replyToMessage, replyAttachments, recipients, recipientsBase, removeDraftChat,
}: {
  selectedSender: RoomKeyStr | null;
  selectedSenderRef: MutableRefObject<RoomKeyStr | null>;
  draftChatsRef: MutableRefObject<string[]>;
  groupedEmailsRef: MutableRefObject<Record<RoomKeyStr, Email[]>>;
  carryDraftRef: MutableRefObject<CarriedDraft | null>;
  draftReadyRoom: string | null;
  currentCompose: () => { html: string; images: InlineImage[] };
  replySubject: string;
  insertedSignatureRef: MutableRefObject<string | null>;
  replyToMessage: Email | null;
  replyAttachments: Attachment[];
  recipients: ComposeRecipient[] | null;
  recipientsBase: ComposeRecipient[] | null;
  removeDraftChat: (room: string) => void;
}) {
  // 下書きチャットから他のチャットへ離脱した際、まだ何も送信しておらず、入力中の内容（下書き）も無ければ破棄する
  // （リロード/タブ復元では selectedSender が変化しないのでここは発火せず維持される）。
  // 下書きが残っているのに一覧から消すと、移った先・送信元を切り替えた先に持っていった本文や添付に戻れなくなる
  const prevDraftCheckSenderRef = useRef<RoomKeyStr | null>(selectedSender);
  // メールも下書きも無ければ一覧から消す。開き直していたら消さない
  // 書いた内容（本文・件名・返信元・添付）もやり取りも無ければ、一覧から消す。送信先を変えただけの下書きも一緒に消す。
  // known は離れる直前の入力（保存の待ち時間のうちに消した分を、古い下書きで上書きして判断しないため）。開き直していたら消さない
  const dropDraftChatIfEmpty = async (room: RoomKeyStr, known?: ComposeDraft) => {
    if (!draftChatsRef.current.includes(room)) return;
    if ((groupedEmailsRef.current[room] || []).length > 0) return;
    const d = known ?? await loadDraft(room);
    if (d && hasDraftContent(d)) return;
    if (selectedSenderRef.current === room) return;
    await removeDraft(room);
    removeDraftChat(room);
  };
  useEffect(() => {
    const prev = prevDraftCheckSenderRef.current;
    prevDraftCheckSenderRef.current = selectedSender;
    if (!prev || prev === selectedSender || !draftChatsRef.current.includes(prev)) return;
    // 入力中の内容を持って移ったときは、移り先で読み戻して移り元の下書きを消したあと（少し待ってから）で判断する。
    // 移り先に書きかけがあって持っていけなかったときは、移り元に下書きが残るので消さない
    if (carryDraftRef.current?.fromRoom === prev) { setTimeout(() => { void dropDraftChatIfEmpty(prev); }, 2000); return; }
    if (draftReadyRoom !== prev) { void dropDraftChatIfEmpty(prev); return; }
    // 打ってすぐ（保存の待ち時間のうち）に離れた分も失わないよう、書いた内容があれば今の入力をすぐ保存する（そのチャットは消さない）
    const now = currentCompose();
    const typed: ComposeDraft = { subject: replySubject, html: now.html, images: now.images, insertedSignature: insertedSignatureRef.current, replyToMessage, attachments: replyAttachments, recipients, recipientsBase, updatedAt: Date.now() };
    if (hasDraftContent(typed)) { void saveDraft(prev, typed); return; }
    void dropDraftChatIfEmpty(prev, typed);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 開いているチャットが変わったときだけ見る（入力のたびには動かさない）
  }, [selectedSender]);
}
