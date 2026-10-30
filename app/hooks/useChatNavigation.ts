// チャットを開く・戻る：チャットを開く（前のチャットを端末内に置いておき、戻ったらすぐ出す）・相手やグループのチャットを作る・
// 送信元のアカウントを切り替える・モバイルの戻る。useMailApp.ts から分けた（動きは変えない）
import type { MutableRefObject } from "react";
import type { Session } from "next-auth";
import type { ChatConfig, ModalState, SelectionMode, GroupMode } from "../types/mail";
import type { Email } from "../types/email";
import { isComposeBodyEmpty, withQuote } from "../lib/composeHtml";
import type { InlineImage } from "../lib/composeEditor";
import type { ComposeRecipient } from "../lib/composeRecipients";
import type { FilterCriteria, ChatListTab } from "../lib/filterMatch";
import { type RoomKeyStr, asLocalKey, encodeRoomKey, decodeRoomKey, keysOf } from "../lib/roomKey";
import { mergeEmails } from "../lib/historySync";
import type { useMailSync } from "./useMailSync";
import type { useDrafts, CarriedDraft, Attachment } from "./useDrafts";
import type { SetState, ConfigsApi } from "./mailAppTypes";

type MailSyncApi = ReturnType<typeof useMailSync>;

export function useChatNavigation({
  session, isMobile, setEmails, emailsRef, selectedSender, setSelectedSender, groupedEmails, chatConfigs, chatConfigsRef, activeChatTab, getRoomAddress, updateChatConfig,
  setModal, setSelectionMode, setSelectedIds, hasPushedSelectRef, chatCacheRef, chatCacheLimitRef, chatNextPageTokenRef, setChatNextPageToken, groupMemberTokensRef,
  setMsgStatusMessage, fetchCrossboxForRoom, fetchChatCrossbox, addDraftChat, carryDraftRef, currentCompose, insertedSignatureRef,
  replyAttachments, replyToMessage, setReplyToMessage, replySubject, setReplySubject, recipients, showInfoToast,
}: {
  session: Session | null;
  isMobile: boolean;
  setEmails: SetState<Email[]>;
  emailsRef: MutableRefObject<Email[]>;
  selectedSender: RoomKeyStr | null;
  setSelectedSender: SetState<RoomKeyStr | null>;
  groupedEmails: Record<RoomKeyStr, Email[]>;
  chatConfigs: Record<RoomKeyStr, ChatConfig>;
  chatConfigsRef: MutableRefObject<Record<RoomKeyStr, ChatConfig>>;
  activeChatTab: ChatListTab;
  getRoomAddress: (room: RoomKeyStr) => string;
  updateChatConfig: ConfigsApi["updateChatConfig"];
  setModal: SetState<ModalState>;
  setSelectionMode: SetState<SelectionMode>;
  setSelectedIds: SetState<string[]>;
  hasPushedSelectRef: MutableRefObject<boolean>;
  chatCacheRef: MutableRefObject<Map<string, { emails: Email[]; chatNextPageToken: string | null; groupMemberTokens?: Record<string, string>; lruTime: number }>>;
  chatCacheLimitRef: MutableRefObject<number>;
  chatNextPageTokenRef: MutableRefObject<string | null>;
  setChatNextPageToken: SetState<string | null>;
  groupMemberTokensRef: MutableRefObject<Record<string, string>>;
  setMsgStatusMessage: SetState<string | null>;
  fetchCrossboxForRoom: MailSyncApi["fetchCrossboxForRoom"];
  fetchChatCrossbox: MailSyncApi["fetchChatCrossbox"];
  addDraftChat: ReturnType<typeof useDrafts>["addDraftChat"];
  carryDraftRef: MutableRefObject<CarriedDraft | null>;
  currentCompose: () => { html: string; images: InlineImage[] };
  insertedSignatureRef: MutableRefObject<string | null>;
  replyAttachments: Attachment[];
  replyToMessage: Email | null;
  setReplyToMessage: SetState<Email | null>;
  replySubject: string;
  setReplySubject: SetState<string>;
  recipients: ComposeRecipient[] | null;
  showInfoToast: (message: string | null, durationMs?: number) => void;
}) {
  const safeBack = () => {
    const state = window.history.state;
    if (state && (state.action || state.chat)) {
      window.history.back();
    } else if (isMobile && selectedSender) {
      // スマホ表示でメッセージ画面が開いているのに、履歴側に「チャットを開いた」記録が無いケース
      // （PC表示で開いた後に画面幅が縮んでスマホ表示に切り替わった場合など）へのフォールバック。
      // history.back() 任せだと戻れずメッセージ画面に固定されてしまうため、直接チャット一覧に戻す
      setSelectedSender(null);
      localStorage.removeItem("remail_selected_sender");
      setModal(null); setSelectionMode("none"); setSelectedIds([]);
    } else {
      setModal(null); setSelectionMode("none"); setSelectedIds([]);
    }
  };

  // アクション実行後: モーダルと選択モードを両方終了し履歴も整理する
  const exitAfterAction = () => {
    setModal(null);
    setSelectionMode("none");
    setSelectedIds([]);
    const steps = hasPushedSelectRef.current ? 2 : 1;
    hasPushedSelectRef.current = false;
    window.history.go(-steps);
  };

  const openChat = async (sender: RoomKeyStr, opts?: { replaceHistory?: boolean }) => {
    // 現在のチャットを LRU キャッシュに保存
    const prevSender = selectedSender;
    if (prevSender && prevSender !== sender && chatCacheLimitRef.current > 0) {
      // senderRoom はローカルキー（自分のアドレス入り）、From / To と比べるのは相手の部分
      const { localKey: prevKey, partnerKey: prevLocal } = decodeRoomKey(prevSender);
      const senderEmails = emailsRef.current.filter((e) => {
        if (e.senderRoom === prevKey) return true;
        const room = e.from?.split("<")[0].replace(/"/g, "").trim() || "Unknown";
        return room === prevLocal || e.from?.includes(prevLocal) || e.to?.includes(prevLocal);
      });
      chatCacheRef.current.set(prevSender, {
        emails: senderEmails,
        chatNextPageToken: chatNextPageTokenRef.current,
        groupMemberTokens: chatConfigsRef.current[prevSender]?.isGroup ? { ...groupMemberTokensRef.current } : undefined,
        lruTime: Date.now(),
      });
      // LRU 上限を超えた古いエントリを削除
      if (chatCacheRef.current.size > chatCacheLimitRef.current) {
        const sorted = [...chatCacheRef.current.entries()].sort(([, a], [, b]) => a.lruTime - b.lruTime);
        chatCacheRef.current.delete(sorted[0][0]);
      }
    }

    setSelectedSender(sender);
    if (typeof window !== "undefined") {
      localStorage.setItem("remail_selected_sender", sender);
      localStorage.removeItem("remail_scroll_main");
      const asideEl = document.querySelector("aside > div.flex-1");
      if (asideEl) localStorage.setItem(`remail_scroll_aside_${activeChatTab}`, asideEl.scrollTop.toString());
    }
    // 返信元はここでは外さない。チャットを切り替えたら、下書きの読み戻しが移り先の下書きの返信元を入れ直す。
    // ここで外すと、開いているチャットを一覧でもう一度押しただけで返信元が外れ、本文と件名「Re:」だけ残って
    // スレッドの分かれた新しいメールとして送られてしまう（実機で起きた）
    setMsgStatusMessage(null);
    if (isMobile) {
      // 検索結果からのジャンプなど、現在の履歴エントリ(検索モーダル用)を新規に積まず
      // その場でチャット用エントリに置き換えたい場合に replaceHistory を使う
      // （go()/back() は非同期のため、直後に別のpushStateを行うと競合してしまう。
      //   replaceStateは同期的なのでこの問題が起きない）
      if (opts?.replaceHistory) window.history.replaceState({ chat: sender }, '', `#chat`);
      else window.history.pushState({ chat: sender }, '', `#chat`);
    }

    // キャッシュがあれば復元、なければ通常フェッチ
    const cached = chatCacheRef.current.get(sender);
    if (cached) {
      cached.lruTime = Date.now();
      setEmails(prev => mergeEmails(prev, cached.emails, session?.user?.email || ""));
      groupMemberTokensRef.current = cached.groupMemberTokens ? { ...cached.groupMemberTokens } : {};
      setChatNextPageToken(cached.chatNextPageToken || "FIRST_PAGE");
      chatNextPageTokenRef.current = cached.chatNextPageToken || "FIRST_PAGE";
    } else {
      groupMemberTokensRef.current = {};
      setChatNextPageToken("FIRST_PAGE");
      await fetchCrossboxForRoom(sender);
    }
    // 追加読み込みはuseEffectベースの自動トリガー（chatNextPageToken変化で発火）に委ねる
  };

  // 「作成」モーダルの確定操作: 既にやり取りのある宛先ならそのチャットを開き、
  // 初めての宛先なら未送信の下書きチャットとして新規に開く
  // accountEmail は新規アドレスを複合化する際にだけ使う（「作成」モーダルのアカウント選択UIから渡される。
  // 未指定時はメインアカウント）。既存の宛先（contactDirectory由来の複合キー）を選んだ場合は
  // そのままそのアカウントで開くため、accountEmailは無視される
  // 宛先とアカウントから、開くチャット（既存ならそのチャット、無ければ新しいチャットのキー）を決める
  // ownAddress はチャットの自分のアドレス（新しいチャットの差出人。未指定は主アドレス）。同じ相手でも自分のアドレスが違えば別のチャット
  const resolveDirectRoom = (identifier: string, accountEmail?: string, ownAddress?: string): { room: RoomKeyStr; existing: boolean } | null => {
    const trimmed = identifier.trim();
    if (!trimmed) return null;
    const myEmail = session?.user?.email || "";
    const targetAccountEmail = accountEmail || myEmail;
    const targetOwn = (ownAddress || targetAccountEmail).trim().toLowerCase();
    // contactDirectory の候補選択は既に複合キー（room）そのものが渡ってくる。
    // 新規入力のメールアドレス/表示名は区切り文字を含まないので、選択されたアカウント名義で複合化する
    let directKey: RoomKeyStr;
    try {
      decodeRoomKey(trimmed);
      directKey = trimmed as RoomKeyStr;
    } catch {
      directKey = encodeRoomKey(targetAccountEmail, asLocalKey(trimmed), targetOwn);
    }

    let existingRoom: RoomKeyStr | null = null;
    if (groupedEmails[directKey] && !chatConfigs[directKey]?.isGroup) {
      existingRoom = directKey;
    } else {
      const idLower = trimmed.toLowerCase();
      // 対象アカウント（targetAccountEmail）が一致するルームだけを既存チャットの候補にする。
      // これを見ないと、別アカウントに同じアドレスの相手がいる場合、そちらのチャットを
      // 誤って開いてしまう（新規に選んだアカウントではなく既存のアカウント側が開かれる）
      existingRoom = keysOf(groupedEmails).find(room =>
        !chatConfigs[room]?.isGroup &&
        decodeRoomKey(room).accountEmail === targetAccountEmail &&
        decodeRoomKey(room).ownAddress === targetOwn &&
        getRoomAddress(room) === idLower
      ) || null;
    }

    return existingRoom ? { room: existingRoom, existing: true } : { room: directKey, existing: false };
  };

  const createOrOpenChat = async (identifier: string, accountEmail?: string, opts?: { replaceHistory?: boolean }, ownAddress?: string): Promise<RoomKeyStr | null> => {
    const target = resolveDirectRoom(identifier, accountEmail, ownAddress);
    if (!target) return null;
    if (!target.existing) addDraftChat(target.room);
    await openChat(target.room, opts);
    return target.room;
  };

  // 返信欄の「送信元」を別のアカウントに切り替える。切り替え先のアカウントで、同じ相手との既存のチャット
  // （無ければ新しいチャット）を開く。入力中の本文・添付・送信先は切り替え先へ持っていく。
  // 返信元は外す（スレッドはアカウントごとのため、別のアカウントのメールには返信できない）
  const switchSendAccount = async (target: string) => {
    const room = selectedSender;
    setModal(null);
    const cameFromModal = typeof window !== "undefined" && window.history.state?.action === "modal";
    const closeModalEntry = () => { if (cameFromModal) window.history.replaceState(isMobile && room ? { chat: room } : {}, "", window.location.href); };
    if (!room) { closeModalEntry(); return; }
    const { accountEmail: current, partnerKey } = decodeRoomKey(room);
    if (current.toLowerCase() === target.toLowerCase()) { closeModalEntry(); return; }
    // 切り替え先では主アドレスのチャット（自分のアドレスはアカウントごとなので持っていかない）
    const address = getRoomAddress(room) || partnerKey;
    const now = currentCompose();
    const hasInput = !!(!isComposeBodyEmpty(now.html) || replyAttachments.length || (!replyToMessage && replySubject) || recipients);
    const dest = resolveDirectRoom(address, target);
    if (!dest) { closeModalEntry(); return; }
    // 開く前に決めておく（開いた直後に下書きの読み戻しが走るため）。
    // 持っていった内容は、切り替え先で読み戻せたら切り替え元の下書きから消す（両方に残って二重に送られないように）
    if (hasInput) {
      carryDraftRef.current = {
        room: dest.room, fromRoom: room, subject: replyToMessage ? "" : replySubject, html: replyToMessage ? withQuote(now.html, null) : now.html, images: now.images,
        insertedSignature: insertedSignatureRef.current, attachments: replyAttachments,
        recipients, recipientsBase: null, replyToMessage: null,
      };
    }
    if (!dest.existing) addDraftChat(dest.room);
    await openChat(dest.room, { replaceHistory: cameFromModal });
    if (!isMobile && cameFromModal) window.history.replaceState({}, "", window.location.href);
    showInfoToast(`送信元を ${target} に切り替えました`, 2500);
  };

  // 「作成」モーダルで複数の宛先を選んだ場合のグループチャット作成。
  // members/hideMemberIndividualChats は contactDirectory 由来の複合キーと、新規入力の生アドレスが混在する。
  // accountEmail はこのグループ自身をどのアカウント名義で作るか（「作成」モーダルのアカウント選択UIから
  // 渡される。未指定時はメインアカウント）
  // ownAddress はグループの自分のアドレス（差出人）。未指定なら、既存のチャットから選んだメンバーがみな同じ自分のアドレスならそれ、違えば主アドレス
  const createGroupChat = async (name: string, members: string[], memberAddresses: string[], mode: GroupMode, hideMemberIndividualChats: string[], accountEmail?: string, ownAddress?: string) => {
    const myEmail = accountEmail || session?.user?.email || "";
    const memberOwns = new Set(members.map(m => { try { return decodeRoomKey(m).ownAddress; } catch { return ""; } }).filter(Boolean));
    const groupOwn = (ownAddress || (memberOwns.size === 1 ? [...memberOwns][0] : myEmail)).trim().toLowerCase();
    // グループの設定はローカルキー（自分のアドレス入り）で保存する。メンバーは同じ自分のアドレスの中の相手（partnerKey）
    const groupRoom = encodeRoomKey(myEmail, asLocalKey(`group:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`), groupOwn);
    const groupRoomLocal = decodeRoomKey(groupRoom).localKey;

    const toMemberKey = (m: string): RoomKeyStr => {
      try { decodeRoomKey(m); return m as RoomKeyStr; } catch { return encodeRoomKey(myEmail, asLocalKey(m), groupOwn); }
    };
    const localMembers = members.map(m => decodeRoomKey(toMemberKey(m)).partnerKey);

    // グループ作成によって新たに非表示にするメンバーだけを記録する（既に非表示だったものは対象外。
    // グループ削除時にこの一覧の分だけ非表示を解除するため）
    const groupHiddenMembers = hideMemberIndividualChats
      .map(toMemberKey)
      .filter(member => groupedEmails[member] && !chatConfigsRef.current[member]?.isHidden)
      .map(member => decodeRoomKey(member).localKey);

    await updateChatConfig(groupRoomLocal, {
      customName: name, isGroup: true, groupMembers: localMembers, groupMemberAddresses: memberAddresses, groupMode: mode,
      groupHiddenMembers,
    }, myEmail);

    groupHiddenMembers.forEach(member => {
      // unhideOnNew は明示的に false にする（新着があっても自動で表示に戻らないようにするため）
      updateChatConfig(member, { isHidden: true, hiddenAtDate: new Date().toISOString(), unhideOnNew: false }, myEmail);
    });

    setSelectedSender(groupRoom);
    if (typeof window !== "undefined") {
      localStorage.setItem("remail_selected_sender", groupRoom);
      localStorage.removeItem("remail_scroll_main");
    }
    setReplyToMessage(null); setReplySubject("");
    if (isMobile) window.history.pushState({ chat: groupRoom }, '', '#chat');

    // 各メンバーの過去のやり取りを読み込んでおく（作成直後からグループの内容が見えるように）
    await Promise.all(localMembers.map(m => fetchChatCrossbox(m, myEmail, false).catch(() => {})));
  };

  // フィルターツールで作成するグループ。宛先の集合ではなく条件（FilterCriteria）でメッセージを
  // 動的に集約する。新着メールも条件に合えば自動的に含まれ続ける。常に受信専用チャットとして扱う
  const createFilterGroup = async (name: string, filterCriteria: FilterCriteria, hideOriginal: boolean, includeExisting: boolean = true) => {
    // フィルターは必ずどれか1つのアカウントのもの。そのアカウントの名義で作る（そのアカウントだけでログインしても使えるように）
    const myEmail = filterCriteria.accountEmail || session?.user?.email || "";
    const groupRoomLocal = asLocalKey(`group:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    const groupRoom = encodeRoomKey(myEmail, groupRoomLocal);
    await updateChatConfig(groupRoomLocal, {
      customName: name, isGroup: true, filterCriteria, filterHideOriginal: hideOriginal, groupMode: "inbound_only",
      filterIncludeExisting: includeExisting, filterCreatedAt: new Date().toISOString(),
    }, myEmail);
    setSelectedSender(groupRoom);
    if (typeof window !== "undefined") {
      localStorage.setItem("remail_selected_sender", groupRoom);
      localStorage.removeItem("remail_scroll_main");
    }
    setReplyToMessage(null); setReplySubject("");
    if (isMobile) window.history.pushState({ chat: groupRoom }, '', '#chat');
  };

  return { safeBack, exitAfterAction, openChat, resolveDirectRoom, createOrOpenChat, switchSendAccount, createGroupChat, createFilterGroup };
}
