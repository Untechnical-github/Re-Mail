import { useSession, signOut } from "next-auth/react";
import { useState, useEffect, useMemo, useRef } from "react";
import localforage from "localforage";
import { ChatConfig, MessageConfig, SelectionMode, ModalState, GroupMode } from "../types/mail";
import { Email } from "../types/email";
import { getCachedAttachment, setCachedAttachment } from "../lib/attachmentCache";
import { isMineEmail, getFindBarBoxKey, FindBarBoxKey, FilterCriteria, messageMatchesFilter, ChatListTab, chatConfigTab } from "../lib/filterMatch";
import { groupEmailsByRoom, mergeAccountGroups, applyFilterGroups } from "../lib/groupEmails";
import { LocalKey, RoomKeyStr, asLocalKey, encodeRoomKey, decodeRoomKey, keysOf } from "../lib/roomKey";

function getSavedBoxSettings(): { inbox?: boolean; archive?: boolean; spam?: boolean; trash?: boolean; sent?: boolean } | null {
  if (typeof window === "undefined") return null;
  try {
    const saved = localStorage.getItem("remail_box_settings");
    return saved ? JSON.parse(saved) : null;
  } catch {
    return null;
  }
}

// グループチャットの「送信済みメール」判定用: DBには何も永続化せず、Toヘッダーの宛先セットが
// メンバー全員と完全一致するかどうかだけで、その都度判定する（送信履歴が増えてもD1を圧迫しない）
function parseAddressSet(field: string): Set<string> {
  const set = new Set<string>();
  (field || "").split(",").forEach((part: string) => {
    const match = part.match(/<([^>]+)>/);
    const addr = (match ? match[1] : part).trim().toLowerCase();
    if (addr) set.add(addr);
  });
  return set;
}
function sameAddressSet(a: Set<string>, b: Set<string>): boolean {
  return a.size > 0 && a.size === b.size && [...a].every(addr => b.has(addr));
}

// グループのメンバーの実メールアドレス集合を求める。作成時に確定させて保存した値を正とし、
// （古い形式のグループ等で）保存が無い場合のみ、そのメンバーの個別チャットの受信メールから推定する
function resolveGroupMemberAddresses(cfg: ChatConfig, roomLookup: Record<string, any[]>, myEmail: string): Set<string> {
  const members = cfg.groupMembers || [];
  const addresses = (cfg.groupMemberAddresses && cfg.groupMemberAddresses.length === members.length)
    ? cfg.groupMemberAddresses
    : members.map((m: string) => {
        const msgs = roomLookup[m];
        const partner = msgs?.find((e: any) => !isMineEmail(e, myEmail));
        const raw = partner ? partner.from : "";
        const match = (raw || "").match(/<([^>]+)>/);
        const resolved = ((match ? match[1] : raw) || "").trim().toLowerCase();
        return resolved || m.trim().toLowerCase();
      });
  return new Set(addresses.map((a: string) => a.toLowerCase()).filter(Boolean));
}

// 大文字小文字を無視して、text内にkwが出現する回数を数える（検索バーの「1件名あたり複数ヒット」対応用）
function countOccurrences(text: string, kwLower: string): number {
  if (!kwLower) return 0;
  const lower = text.toLowerCase();
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = lower.indexOf(kwLower, pos);
    if (idx === -1) break;
    count++;
    pos = idx + kwLower.length;
  }
  return count;
}

export function useMailApp() {
  const { data: session, status } = useSession();
  const [emails, setEmails] = useState<Email[]>([]);
  const [persistedEmails, setPersistedEmails] = useState<Email[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedSender, setSelectedSender] = useState<RoomKeyStr | null>(() => {
    if (typeof window === "undefined") return null;
    // リロードやタブを閉じても開いていたメッセージ画面を復元できるよう localStorage に保存する
    const saved = localStorage.getItem("remail_selected_sender");
    if (!saved) return null;
    try {
      decodeRoomKey(saved);
      return saved as RoomKeyStr;
    } catch {
      // 複合roomKey導入前の古い形式（生のローカルキーのまま保存されていた）は復元できないため破棄する
      localStorage.removeItem("remail_selected_sender");
      return null;
    }
  });
  const [chatConfigs, setChatConfigs] = useState<Record<RoomKeyStr, ChatConfig>>({} as Record<RoomKeyStr, ChatConfig>);
  // 個別メッセージ単位の設定（ピン留め・非表示）。room単位のchatConfigsとはキー空間が異なる
  // （chatConfigsのキーは相手名/group:xxxxのようなroom、こちらはGmailメッセージIDそのもの）
  const [messageConfigs, setMessageConfigs] = useState<Record<RoomKeyStr, MessageConfig>>({} as Record<RoomKeyStr, MessageConfig>);

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
  
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  // メッセージ画面上部に表示するCtrl+F風の検索バー（キーワードのハイライト・上下移動を兼ねる）。
  // 検索モーダルの結果からジャンプして開く場合と、メッセージ画面の検索ボタンから直接開く場合がある
  const [findBarOpen, setFindBarOpen] = useState(false);
  const [findBarKeyword, setFindBarKeyword] = useState("");
  const [findBarMatchIndex, setFindBarMatchIndex] = useState(-1);
  // 検索バーの対象フィールド（件名/本文）。両方ONなら両方、片方だけなら片方の中のみを検索・ハイライト対象にする
  const [findBarSearchSubject, setFindBarSearchSubjectState] = useState(true);
  const [findBarSearchBody, setFindBarSearchBodyState] = useState(true);
  // 検索バー独自の場所フィルター（既存のチェックボックスとは非同期＝別管理）。件名/本文の絞り込みとは別枠で表示する
  const [findBarBoxFilter, setFindBarBoxFilter] = useState<Record<"inbox" | "archive" | "sent" | "spam" | "trash", boolean>>({
    inbox: true, archive: true, sent: true, spam: true, trash: true,
  });
  const skipFindBarAutoCloseRef = useRef(false);
  const hasPushedFindBarRef = useRef(false);
  const [checkInbox, setCheckInbox] = useState<boolean>(() => getSavedBoxSettings()?.inbox ?? true);
  const [checkArchive, setCheckArchive] = useState<boolean>(() => getSavedBoxSettings()?.archive ?? true);
  const [checkSpam, setCheckSpam] = useState<boolean>(() => getSavedBoxSettings()?.spam ?? false);
  const [checkTrash, setCheckTrash] = useState<boolean>(() => getSavedBoxSettings()?.trash ?? false);
  const [checkSent, setCheckSent] = useState<boolean>(() => getSavedBoxSettings()?.sent ?? false);
  // チャット画面のタブ（個人チャット / グループチャット / フィルター）。フィルターのチェックボックスと同様、
  // この端末のブラウザにだけ保存する（D1には保存しない＝他の端末には同期されない）ので、
  // リロード・タブを閉じる・ログアウトをまたいでも維持されるが、別端末には影響しない
  const [activeChatTab, setActiveChatTab] = useState<ChatListTab>(() => {
    if (typeof window === "undefined") return "individual";
    const saved = localStorage.getItem("remail_active_chat_tab");
    return saved === "group" || saved === "filter" ? saved : "individual";
  });
  useEffect(() => {
    if (typeof window !== "undefined") localStorage.setItem("remail_active_chat_tab", activeChatTab);
  }, [activeChatTab]);

  // タブ（個人/グループ/フィルター）ごとに一覧のスクロール位置を独立して保持する。
  // 切り替え前に必ず「今表示しているタブ」のスクロール位置を保存してから切り替える
  // （切り替え後に読み取ると、DOMは既に新タブの中身になっており、スクロール量も
  //   短い一覧に合わせてブラウザ側でクランプされてしまっていることがあるため）
  const changeChatTab = (newTab: ChatListTab) => {
    if (newTab === activeChatTab) return;
    if (typeof window !== "undefined") {
      const asideEl = document.querySelector("aside > div.flex-1.overflow-y-auto");
      if (asideEl) localStorage.setItem(`remail_scroll_aside_${activeChatTab}`, (asideEl as HTMLElement).scrollTop.toString());
    }
    setActiveChatTab(newTab);
  };

  // 切り替え後、そのタブ自身の保存済みスクロール位置を復元する
  useEffect(() => {
    if (typeof window === "undefined") return;
    requestAnimationFrame(() => {
      const saved = localStorage.getItem(`remail_scroll_aside_${activeChatTab}`);
      const asideEl = document.querySelector("aside > div.flex-1.overflow-y-auto");
      if (asideEl) (asideEl as HTMLElement).scrollTop = saved ? parseInt(saved, 10) : 0;
    });
  }, [activeChatTab]);

  // 開いているメッセージ画面が個人/グループ/フィルターのどれかに応じて、
  // チャット一覧のタブも自動的に合わせる（一覧から今開いているチャットが消えないように）
  useEffect(() => {
    if (!selectedSender) return;
    const wantTab = chatConfigTab(chatConfigs[selectedSender]);
    if (wantTab !== activeChatTab) changeChatTab(wantTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSender, chatConfigs]);
  // アカウントごとのGmail一覧取得ページトークン。キーはaccountEmail、値がnullならそのアカウントは
  // 読み込み終わり（トークン未取得＝まだ読み込んでいないアカウントとは区別する）
  const [currentNextPageTokens, setCurrentNextPageTokens] = useState<Record<string, string | null>>({});

  const [chatNextPageToken, setChatNextPageToken] = useState<string | null>("FIRST_PAGE");

  const [chatStatusMessage, setChatStatusMessage] = useState<string | null>(null);
  const [msgStatusMessage, setMsgStatusMessage] = useState<string | null>(null);
  const [isLoadingMoreChats, setIsLoadingMoreChats] = useState(false);

  const loadingMoreChatsRef = useRef(false);
  const loadingMoreMsgRef = useRef(false);
  const currentNextPageTokensRef = useRef<Record<string, string | null>>({});

  // 連携済みアカウントのメールアドレス一覧（メインアカウント自身は含まない）
  const [linkedAccounts, setLinkedAccounts] = useState<string[]>([]);
  const linkedAccountsRef = useRef<string[]>([]);
  useEffect(() => { linkedAccountsRef.current = linkedAccounts; }, [linkedAccounts]);

  const [replySubject, setReplySubject] = useState("");
  const [replyBody, setReplyBody] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [replyToMessage, setReplyToMessage] = useState<any | null>(null);

  const [hasMouse, setHasMouse] = useState(true);
  const [isMobile, setIsMobile] = useState(false);
  const [selectionMode, setSelectionMode] = useState<SelectionMode>("none");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [modal, setModal] = useState<ModalState>(null);
  const [renameInput, setRenameInput] = useState("");
  const touchTimer = useRef<NodeJS.Timeout | null>(null);
  const [resetOptions, setResetOptions] = useState({ pin: true, hide: true, name: true, crossBox: false });
  const [moveDestination, setMoveDestination] = useState<"INBOX" | "ARCHIVE" | "SPAM" | "TRASH" | null>(null);
  const [revealedCrossPrompts, setRevealedCrossPrompts] = useState<string[]>([]);
  // 返信元メッセージへジャンプしようとして見つからなかった場合のトースト表示
  const [replyNotFoundToast, setReplyNotFoundToast] = useState(false);
  const isJumpingToReplyRef = useRef(false);

  // メッセージ折りたたみ・モーダル関連
  // collapseLinesCount: null = 折りたたまない（設定画面から変更予定）
  const [collapseLinesCount] = useState<number | null>(null);
  const [expandedMsgIds, setExpandedMsgIds] = useState<string[]>([]);
  const [emailModal, setEmailModal] = useState<{
    email: any;
    htmlBody: string | null;
    isLoading: boolean;
  } | null>(null);

  const [attachmentModal, setAttachmentModal] = useState<{
    filename: string;
    mimeType: string;
    size: number;
    attachmentId: string;
    messageId: string;
    cacheKey?: string;
    base64: string | null;
    isLoading: boolean;
  } | null>(null);

  const [boxColors, setBoxColors] = useState({
    inbox: "#5865F2", 
    archive: "#95A5A6",
    spam: "#FEE75C",  
    trash: "#DA373C",
    sent: "#1ABC9C"
  });

  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const hasPushedSelectRef = useRef(false);
  const activeLoadRef = useRef<number>(0);
  const signingOutRef = useRef(false);
  const isInitialFilterRun = useRef(true); 
  const chatConfigsRef = useRef(chatConfigs);
  useEffect(() => { chatConfigsRef.current = chatConfigs; }, [chatConfigs]);
  const messageConfigsRef = useRef(messageConfigs);
  useEffect(() => { messageConfigsRef.current = messageConfigs; }, [messageConfigs]);

  const emailsRef = useRef(emails);
  useEffect(() => { emailsRef.current = emails; }, [emails]);

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

  // チャットを閉じたら展開状態をリセット
  useEffect(() => { setExpandedMsgIds([]); }, [selectedSender]);
  useEffect(() => { currentNextPageTokensRef.current = currentNextPageTokens; }, [currentNextPageTokens]);

  // チャット単位の LRU キャッシュ（チャット切り替え時に復元）
  const [chatCacheLimit, _setChatCacheLimit] = useState<number>(() => {
    if (typeof window === "undefined") return 10;
    const s = localStorage.getItem("remail_chat_cache_limit");
    return s ? Math.max(0, parseInt(s, 10)) : 10;
  });
  const chatCacheLimitRef = useRef<number>(chatCacheLimit);
  const setChatCacheLimit = (n: number) => {
    const v = Math.max(0, n);
    chatCacheLimitRef.current = v;
    _setChatCacheLimit(v);
    if (typeof window !== "undefined") localStorage.setItem("remail_chat_cache_limit", String(v));
    const cache = chatCacheRef.current;
    const sorted = [...cache.entries()].sort(([, a], [, b]) => a.lruTime - b.lruTime);
    while (cache.size > v) cache.delete(sorted.shift()![0]);
  };
  const chatCacheRef = useRef<Map<string, { emails: Email[]; chatNextPageToken: string | null; lruTime: number }>>(new Map());
  const chatNextPageTokenRef = useRef<string | null>("FIRST_PAGE");
  useEffect(() => { chatNextPageTokenRef.current = chatNextPageToken; }, [chatNextPageToken]);

  // フィルター単位のキャッシュ（フィルター切り替え時に復元）
  const filterCacheRef = useRef<Map<string, { emails: Email[]; currentNextPageTokens: Record<string, string | null> }>>(new Map());
  const filterKeyRef = useRef<string>("true-true-false-false-false");
  // emails state が実際にどのフィルターの取得結果を反映しているかを示す。
  // フィルターを連続で切り替えると、直前の取得がキャンセルされ emails が更新されないまま
  // filterKeyRef だけ次のキーに進んでしまうことがある。その状態でキャッシュへ書き込むと
  // 「まだ何も取得していない新フィルター」に「古いフィルターの中身」が誤って紐付いてしまい、
  // 次にそのフィルターへ戻ったときに空(または無関係)なキャッシュが復元される不具合になるため、
  // 実際に取得が完了したフィルターキーと filterKeyRef が一致する場合のみキャッシュを書き込む
  const emailsFilterKeyRef = useRef<string>(filterKeyRef.current);

  useEffect(() => {
    const handleStateSave = () => {
      const asideEl = document.querySelector("aside > div.flex-1");
      const mainEl = document.querySelector("main > div.flex-1");
      if (asideEl) localStorage.setItem(`remail_scroll_aside_${activeChatTab}`, asideEl.scrollTop.toString());
      if (mainEl) localStorage.setItem("remail_scroll_main", mainEl.scrollTop.toString());

      // 表示中のモーダル・選択中の内容・作成中の返信もリロード/タブを閉じた後に復元できるよう保存する。
      // emailModal/replyToMessage はデータ再取得後に同じメッセージを探し直すのではなく、
      // 表示に必要な内容そのものを保存しておく（再取得タイミングに依存させないため）
      const uiState = {
        selectionMode,
        selectedIds,
        modal,
        renameInput,
        resetOptions,
        moveDestination,
        replySubject,
        replyBody,
        replyToMessage: replyToMessage ?? null,
        emailModalEmail: emailModal?.email ?? null,
        attachmentModal: attachmentModal ? {
          filename: attachmentModal.filename,
          mimeType: attachmentModal.mimeType,
          size: attachmentModal.size,
          attachmentId: attachmentModal.attachmentId,
          messageId: attachmentModal.messageId,
          cacheKey: attachmentModal.cacheKey,
        } : null,
      };
      try { localStorage.setItem("remail_ui_state", JSON.stringify(uiState)); } catch {}
    };
    const handleVisibilityHidden = () => {
      if (document.visibilityState === "hidden") handleStateSave();
    };

    // beforeunload はタブを閉じる際やモバイルで発火しないことがあるため、
    // pagehide / visibilitychange も併用して確実に保存する
    window.addEventListener("beforeunload", handleStateSave);
    window.addEventListener("pagehide", handleStateSave);
    document.addEventListener("visibilitychange", handleVisibilityHidden);
    return () => {
      window.removeEventListener("beforeunload", handleStateSave);
      window.removeEventListener("pagehide", handleStateSave);
      document.removeEventListener("visibilitychange", handleVisibilityHidden);
    };
  }, [selectedSender, selectionMode, selectedIds, modal, renameInput, resetOptions, moveDestination, replySubject, replyBody, replyToMessage, emailModal, attachmentModal, activeChatTab]);

  const allUniqueEmails = useMemo(() => {
    const map = new Map();
    persistedEmails.forEach(e => map.set(e.id, e));
    emails.forEach(e => map.set(e.id, e));
    return Array.from(map.values());
  }, [emails, persistedEmails]);

  const loadD1Configs = async (): Promise<{ globalSettings: { limit?: number; inbox?: boolean; archive?: boolean; spam?: boolean; trash?: boolean } | null; formatted: Record<RoomKeyStr, ChatConfig> }> => {
    let globalSettings: { limit?: number; inbox?: boolean; archive?: boolean; spam?: boolean; trash?: boolean } | null = null;
    const formatted: Record<RoomKeyStr, ChatConfig> = {} as Record<RoomKeyStr, ChatConfig>;
    const formattedMessages: Record<RoomKeyStr, MessageConfig> = {} as Record<RoomKeyStr, MessageConfig>;
    try {
      const res = await fetch("/api/config");
      if (res.ok) {
        const data = await res.json();
        const pMsgs: any[] = [];
        data.configs?.forEach((c: any) => {
          if (c.chat_id === "__GLOBAL_SETTINGS__" && c.custom_name) {
            try { globalSettings = JSON.parse(c.custom_name); } catch (e) {} return;
          }
          if (c.chat_id === "__KNOWN_BOXES__") { return; }
          let customNameVal = c.custom_name || undefined;
          let forceFetchVal = false;
          let pData = null;
          let roomIdVal = undefined;
          let isGroupVal = undefined;
          let groupMembersVal = undefined;
          let groupMemberAddressesVal = undefined;
          let groupModeVal = undefined;
          let groupHiddenMembersVal = undefined;
          let filterCriteriaVal = undefined;
          let filterHideOriginalVal = undefined;
          let filterActionVal = undefined;
          let filterContinuousVal = undefined;
          let filterDestinationVal = undefined;
          let filterCreatedAtVal = undefined;
          let filterLastAppliedAtVal = undefined;
          let filterIncludeExistingVal = undefined;
          if (customNameVal && customNameVal.startsWith('{')) {
            try {
              const parsed = JSON.parse(customNameVal);
              customNameVal = parsed.name; forceFetchVal = parsed.forceFetch; pData = parsed.data; roomIdVal = parsed.roomId;
              isGroupVal = parsed.isGroup; groupMembersVal = parsed.groupMembers; groupModeVal = parsed.groupMode;
              groupMemberAddressesVal = parsed.groupMemberAddresses; groupHiddenMembersVal = parsed.groupHiddenMembers;
              filterCriteriaVal = parsed.filterCriteria; filterHideOriginalVal = parsed.filterHideOriginal;
              filterActionVal = parsed.filterAction; filterContinuousVal = parsed.filterContinuous; filterDestinationVal = parsed.filterDestination;
              filterCreatedAtVal = parsed.filterCreatedAt; filterLastAppliedAtVal = parsed.filterLastAppliedAt;
              filterIncludeExistingVal = parsed.filterIncludeExisting;
              if (pData) {
                // ★修正: 過去のバグで保存された「送信済みメールのINBOXラベル」をロード時に強制消去する
                const cleanData = (Array.isArray(pData) ? pData : [pData]).map(e => {
                  if ((e.isMe || e.from?.includes(session?.user?.email || "")) && e.labelIds?.includes("INBOX")) {
                     return { ...e, labelIds: e.labelIds.filter((l: string) => l !== "INBOX") };
                  }
                  return e;
                });
                pMsgs.push(...cleanData);
              }
            } catch (e) {}
          }
          // roomIdの有無で、room単位の設定かメッセージ単位の設定かを振り分ける
          // （メッセージ単位はGmailメッセージIDそのものがchat_idに入っており、roomIdフィールドで
          // どのroomに属するかを示す。room単位の行にはroomIdは存在しない）。
          // stateのキーは常にencodeRoomKey済みの複合roomKeyに揃える（D1のaccount_email列 + chat_id列）
          const stateKey = encodeRoomKey(c.account_email || session?.user?.email || "", c.chat_id as LocalKey);
          if (roomIdVal !== undefined) {
            formattedMessages[stateKey] = { isPinned: c.is_pinned === 1, isHidden: c.is_hidden === 1, hiddenAtDate: c.hidden_at_date || undefined, unhideOnNew: c.unhide_on_new === 1, forceFetch: forceFetchVal, persistedData: pData, roomId: roomIdVal };
          } else {
            formatted[stateKey] = { customName: customNameVal, isPinned: c.is_pinned === 1, isHidden: c.is_hidden === 1, hiddenAtDate: c.hidden_at_date || undefined, unhideOnNew: c.unhide_on_new === 1, forceFetch: forceFetchVal, persistedData: pData, isGroup: isGroupVal, groupMembers: groupMembersVal, groupMemberAddresses: groupMemberAddressesVal, groupMode: groupModeVal, groupHiddenMembers: groupHiddenMembersVal, filterCriteria: filterCriteriaVal, filterHideOriginal: filterHideOriginalVal, filterAction: filterActionVal, filterContinuous: filterContinuousVal, filterDestination: filterDestinationVal, filterCreatedAt: filterCreatedAtVal, filterLastAppliedAt: filterLastAppliedAtVal, filterIncludeExisting: filterIncludeExistingVal };
          }
        });
        setChatConfigs(formatted); setMessageConfigs(formattedMessages); setPersistedEmails(pMsgs);
      }
    } catch (e) { console.error(e); }
    return { globalSettings, formatted };
  };

  const saveGlobalSettings = async (inbox: boolean, archive: boolean, spam: boolean, trash: boolean, sent: boolean) => {
    if (typeof window !== "undefined") {
      localStorage.setItem("remail_box_settings", JSON.stringify({ inbox, archive, spam, trash, sent }));
    }
  };

  // targetId は常に「D1のchat_id列にそのまま入る生のローカルキー」（相手名やgroup:xxxx等）を渡してもらい、
  // accountEmail は別引数で明示的に渡す（フェーズ2〜4で実際の複数アカウントが導入されるまでは、
  // 呼び出し側は常に自分自身のアカウント=session.user.emailを渡す）。
  // state（chatConfigs）上のキーだけ、ここでencodeRoomKeyして複合化する
  // （groupedEmails・selectedSenderと同じ複合roomKey空間に揃えるため。D1のchat_id自体は生のまま）
  const updateChatConfig = async (targetId: LocalKey, updates: Partial<ChatConfig>, accountEmail: string) => {
    const stateKey = encodeRoomKey(accountEmail, targetId);
    const nextConfig = { ...chatConfigsRef.current[stateKey], ...updates };
    setChatConfigs(prev => ({ ...prev, [stateKey]: nextConfig }));
    let nameToSave = nextConfig.customName || "";
    if (nextConfig.forceFetch || nextConfig.isGroup || nextConfig.filterAction) {
      nameToSave = JSON.stringify({
        name: nextConfig.customName, forceFetch: nextConfig.forceFetch, data: nextConfig.persistedData,
        isGroup: nextConfig.isGroup, groupMembers: nextConfig.groupMembers, groupMemberAddresses: nextConfig.groupMemberAddresses, groupMode: nextConfig.groupMode,
        groupHiddenMembers: nextConfig.groupHiddenMembers,
        filterCriteria: nextConfig.filterCriteria, filterHideOriginal: nextConfig.filterHideOriginal,
        filterAction: nextConfig.filterAction, filterContinuous: nextConfig.filterContinuous, filterDestination: nextConfig.filterDestination,
        filterCreatedAt: nextConfig.filterCreatedAt, filterLastAppliedAt: nextConfig.filterLastAppliedAt,
        filterIncludeExisting: nextConfig.filterIncludeExisting,
      });
    }
    try { await fetch("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: targetId, account_email: accountEmail, custom_name: nameToSave, is_pinned: nextConfig.isPinned, is_hidden: nextConfig.isHidden, hidden_at_date: nextConfig.hiddenAtDate, unhide_on_new: nextConfig.unhideOnNew }) }); } catch (e) { console.error(e); }
  };

  // メッセージ単位の設定（ピン留め・非表示）。room単位のupdateChatConfigとはstate/キー空間が別
  // （どちらもD1の chat_configs テーブル自体は共有しており、chat_id列に room名 か メッセージID かの
  // どちらが入るかだけが違う。custom_name列にroomId等をJSONで詰める形式もroom側と共通）。
  // targetIdは生のGmailメッセージID、stateキーだけencodeRoomKeyで複合化する
  const updateMessageConfig = async (targetId: LocalKey, updates: Partial<MessageConfig>, accountEmail: string) => {
    const stateKey = encodeRoomKey(accountEmail, targetId);
    const nextConfig = { ...messageConfigsRef.current[stateKey], ...updates };
    setMessageConfigs(prev => ({ ...prev, [stateKey]: nextConfig }));
    let nameToSave = "";
    if (nextConfig.forceFetch || nextConfig.roomId) {
      nameToSave = JSON.stringify({ forceFetch: nextConfig.forceFetch, data: nextConfig.persistedData, roomId: nextConfig.roomId });
    }
    try { await fetch("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: targetId, account_email: accountEmail, custom_name: nameToSave, is_pinned: nextConfig.isPinned, is_hidden: nextConfig.isHidden, hidden_at_date: nextConfig.hiddenAtDate, unhide_on_new: nextConfig.unhideOnNew }) }); } catch (e) { console.error(e); }
  };

  // グループチャットの削除: 設定行そのものを消すだけで、メンバーの個別チャットや実際のメールには一切触れない
  const deleteChatConfig = async (targetId: LocalKey, accountEmail: string) => {
    const stateKey = encodeRoomKey(accountEmail, targetId);
    // グループを削除する場合、そのグループの作成によって非表示にした個別チャットは表示に戻す
    const cfg = chatConfigsRef.current[stateKey];
    if (cfg?.isGroup && cfg.groupHiddenMembers?.length) {
      cfg.groupHiddenMembers.forEach(member => {
        updateChatConfig(asLocalKey(member), { isHidden: false }, accountEmail);
      });
    }

    setChatConfigs(prev => {
      const next = { ...prev };
      delete next[stateKey];
      return next;
    });
    // ピン留めされていた場合、ローカルにキャッシュしていたメッセージのコピーも消しておく
    // （D1側の行は削除で一括して消えるが、ローカルstateはそれとは別に残ってしまうため）
    setPersistedEmails(prev => prev.filter((e: any) => e.senderRoom !== targetId));
    if (selectedSender === stateKey) {
      setSelectedSender(null);
      if (typeof window !== "undefined") {
        localStorage.removeItem("remail_selected_sender");
        localStorage.removeItem("remail_scroll_main");
      }
    }
    try { await fetch(`/api/config?chat_id=${encodeURIComponent(targetId)}&account_email=${encodeURIComponent(accountEmail)}`, { method: "DELETE" }); } catch (e) { console.error(e); }
  };

  // UI層（Modals.tsx等）はチャットの識別子として常に複合キー（RoomKeyStr、chatConfigsのstateキーと同じもの）
  // だけを扱う。roomKeyの直接パース（decodeRoomKey）をこのファイル以外に書かないというルールを守るため、
  // UI側から呼ぶ場合は生のupdateChatConfig/deleteChatConfigではなく必ずこちらを経由する
  const updateChatConfigByRoomKey = (room: RoomKeyStr, updates: Partial<ChatConfig>) => {
    const { accountEmail, localKey } = decodeRoomKey(room);
    return updateChatConfig(localKey, updates, accountEmail);
  };
  const deleteChatConfigByRoomKey = (room: RoomKeyStr) => {
    const { accountEmail, localKey } = decodeRoomKey(room);
    return deleteChatConfig(localKey, accountEmail);
  };

  const syncConfigs =(latestEmails: any[], currentChatConfigs: Record<RoomKeyStr, ChatConfig>, currentMessageConfigs: Record<RoomKeyStr, MessageConfig>) => {
    const pMsgs: any[] = [];
    const chatUpdatesToD1: { id: LocalKey, accountEmail: string, updates: Partial<ChatConfig> }[] = [];
    const msgUpdatesToD1: { id: LocalKey, accountEmail: string, updates: Partial<MessageConfig> }[] = [];

    // room単位: ピン留め（全メッセージの永続表示を最新化）・非表示（unhideOnNewでの自動解除）
    keysOf(currentChatConfigs).forEach(stateKey => {
      const { accountEmail, localKey: targetId } = decodeRoomKey(stateKey);
      const config = currentChatConfigs[stateKey];
      let hasUpdate = false;
      let newConfig: Partial<ChatConfig> = { ...config };

      if (config?.isPinned && config.forceFetch) {
        const chatEmails = latestEmails.filter(e => {
           const room = e.senderRoom || (e.from.split("<")[0].replace(/"/g, "").trim() || "Unknown");
           return room === targetId && !e.labelIds?.includes("TRASH") && !e.labelIds?.includes("SPAM");
        }).map(e => ({...e, senderRoom: targetId}));

        const oldIds = (config.persistedData || []).map((e:any)=>e.id).join(",");
        const newIds = chatEmails.map((e:any)=>e.id).join(",");
        if (oldIds !== newIds) {
           newConfig.persistedData = chatEmails.length > 0 ? chatEmails : null; hasUpdate = true;
        }
        pMsgs.push(...chatEmails);
      }

      // unhideOnNew が有効な場合のみ、非表示日時より新しいメールがあれば自動解除
      if (config?.isHidden && config.unhideOnNew) {
        const hiddenDate = config.hiddenAtDate ? new Date(config.hiddenAtDate) : new Date(0);
        const hasNewEmail = latestEmails.some(e => {
          const room = e.senderRoom || (e.from.split("<")[0].replace(/"/g, "").trim() || "Unknown");
          return room === targetId &&
                 !e.labelIds?.includes("TRASH") &&
                 !e.labelIds?.includes("SPAM") &&
                 new Date(e.date) > hiddenDate;
        });
        if (hasNewEmail) {
          newConfig.isHidden = false; newConfig.hiddenAtDate = undefined; newConfig.unhideOnNew = false; hasUpdate = true;
        }
      }

      if (hasUpdate) chatUpdatesToD1.push({ id: targetId, accountEmail, updates: newConfig });
    });

    // メッセージ単位: ピン留めしたメッセージがゴミ箱/迷惑メールへ移動されたら自動解除、
    // forceFetchがONならそのメッセージ自身を永続表示の対象に含める
    keysOf(currentMessageConfigs).forEach(stateKey => {
      const { accountEmail, localKey: targetId } = decodeRoomKey(stateKey);
      const config = currentMessageConfigs[stateKey];
      let hasUpdate = false;
      let newConfig: Partial<MessageConfig> = { ...config };

      if (config?.isPinned) {
        const msg = latestEmails.find(e => e.id === targetId);
        if (!msg || msg.labelIds?.includes("TRASH") || msg.labelIds?.includes("SPAM")) {
          newConfig.isPinned = false; newConfig.forceFetch = false; newConfig.persistedData = null; hasUpdate = true;
        } else if (config.forceFetch) {
          pMsgs.push({ ...msg, senderRoom: config.roomId });
        }
      }

      if (config?.isHidden) {
        const msg = latestEmails.find(e => e.id === targetId);
        if (!msg || msg.labelIds?.includes("TRASH") || msg.labelIds?.includes("SPAM")) {
          newConfig.isHidden = false; newConfig.hiddenAtDate = undefined; newConfig.roomId = undefined; hasUpdate = true;
        }
      }

      if (hasUpdate) msgUpdatesToD1.push({ id: targetId, accountEmail, updates: newConfig });
    });

    chatUpdatesToD1.forEach(u => updateChatConfig(u.id, u.updates, u.accountEmail));
    msgUpdatesToD1.forEach(u => updateMessageConfig(u.id, u.updates, u.accountEmail));
    return pMsgs;
  };

  useEffect(() => {
    const mediaQuery = window.matchMedia('(pointer: fine)');
    setHasMouse(mediaQuery.matches);
    const handler = (e: MediaQueryListEvent) => setHasMouse(e.matches);
    mediaQuery.addEventListener('change', handler);
    const resizeHandler = () => setIsMobile(window.innerWidth < 768);
    resizeHandler();
    window.addEventListener('resize', resizeHandler);
    return () => { mediaQuery.removeEventListener('change', handler); window.removeEventListener('resize', resizeHandler); };
  }, []);

  // リロード/タブ復元で selectedSender が localStorage から直接セットされた場合や、
  // PC表示（両ペイン表示、履歴を積まない）でチャットを開いた後に画面幅が縮んでスマホ表示に
  // 切り替わった場合、openChat() の pushState を経由していないため history に "#chat" が積まれていない。
  // その状態のままモバイルの戻るボタン(safeBack)を押すと history.state に
  // 何も入っていないため「チャット画面を閉じる」が発火せず、画面が固定されてしまう。
  // isMobile・selectedSender のどちらが変化しても、その都度 history 側をチャットが開いている
  // 状態に揃え直す（safeBack 側のフォールバックと二重の保険にする）
  useEffect(() => {
    if (isMobile && selectedSender && window.location.hash !== '#chat') {
      window.history.pushState({ chat: selectedSender }, '', '#chat');
    }
  }, [isMobile, selectedSender]);

  useEffect(() => {
    const handlePopState = (e: PopStateEvent) => {
      const state = e.state;
      setModal(null);
      setEmailModal(null);
      setAttachmentModal(null);
      if (!state || state.action !== "select") { setSelectionMode("none"); setSelectedIds([]); hasPushedSelectRef.current = false; } else { hasPushedSelectRef.current = true; }
      if (!state || state.action !== "findbar") {
        setFindBarOpen(false); setFindBarKeyword(""); setFindBarMatchIndex(-1); hasPushedFindBarRef.current = false;
      } else { hasPushedFindBarRef.current = true; }
      if (window.innerWidth < 768 && window.location.hash !== '#chat') {
        setSelectedSender(null);
        localStorage.removeItem("remail_selected_sender");
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    if (!selectedSender && isMobile) {
      setTimeout(() => {
        const asideScroll = localStorage.getItem(`remail_scroll_aside_${activeChatTab}`);
        const asideEl = document.querySelector("aside > div.flex-1");
        if (asideScroll && asideEl) {
          asideEl.scrollTop = parseInt(asideScroll, 10);
        }
      }, 50);
    }
  }, [selectedSender, isMobile, activeChatTab]);

  // メイン+連携済みの全アカウント分を並行して取得し、1つの配列にマージする。
  // pageToken は常にnull（先頭ページ取得専用。追加読み込みはhandleLoadMoreChatsが個別に担う）のため
  // 実質未使用。limitはアカウント数で按分し、合算でおおよそtargetLimit件になるようにする
  const fetchEmails = async (limit = 100, query = "", flags = { inbox: true, archive: true, spam: false, trash: false, sent: false }, pageToken: string | null = null, isLoadMore = false, isSilent = false, currentEmailsState = emailsRef.current, getIsCancelled = () => false, isInitLoad = false) => {
    // ★修正: flags.sent も判定に含めることで、「送信済みのみ」チェック時にAPIが空振りするのを防ぐ
    if (!flags.inbox && !flags.archive && !flags.spam && !flags.trash && !flags.sent) {
      setEmails([]); if (!isSilent) setIsLoading(false); return { success: false, emails: [] };
    }
    if (!isSilent) setIsLoading(true);
    const targetLimit = limit;

    try {
      let qParts = [];
      let useIncludeTrash = "false";

      if (flags.trash || flags.spam) {
        useIncludeTrash = "true";
      }
      // 送信済みはGmailの「送信済みフォルダ」だけでなく全場所の送信メールを対象とする
      if (flags.sent) {
        useIncludeTrash = "true";
      }

      if (flags.archive) {
        if (!flags.inbox) qParts.push("-in:inbox");
      } else {
        let orLabels = [];
        if (flags.inbox) orLabels.push("in:inbox");
        if (flags.sent) orLabels.push("from:me"); // in:sent → from:me (全場所の送信メール)
        if (flags.spam) orLabels.push("in:spam");
        if (flags.trash) orLabels.push("in:trash");
        if (orLabels.length > 0) qParts.push(`(${orLabels.join(" OR ")})`);
      }

      if (query) qParts.push(query);
      const q = qParts.join(" ").trim();

      const myEmail = session?.user?.email || "";
      const accounts = [myEmail, ...linkedAccountsRef.current];
      const perAccountLimit = Math.max(1, Math.ceil(targetLimit / accounts.length));

      const results = await Promise.all(accounts.map(async (accountEmail) => {
        const params = new URLSearchParams({ maxResults: perAccountLimit.toString(), q, includeTrash: useIncludeTrash });
        if (accountEmail !== myEmail) params.append("accountEmail", accountEmail);
        params.append("_t", Date.now().toString());
        try {
          const res = await fetch(`/api/emails?${params.toString()}`);
          return { accountEmail, res };
        } catch {
          return { accountEmail, res: null as Response | null };
        }
      }));

      // 認証切れの強制サインアウトはメインアカウントの失効時のみ行う。連携アカウントのトークン
      // 失効はそのアカウント分だけ黙って読み込めない扱いにし、メインアカウントの利用は継続させる
      const mainResult = results.find(r => r.accountEmail === myEmail);
      if (mainResult?.res && (mainResult.res.status === 401 || mainResult.res.status === 403)) {
        if (!signingOutRef.current) {
          signingOutRef.current = true;
          await localforage.clear();
          // signOut のサーバー側処理（セッションCookie破棄）が終わる前に遷移すると、
          // 古いセッションが残ったままリロードされ無限ループになるため必ず完了を待つ
          await signOut({ redirect: false });
          window.location.href = "/";
        }
        return { success: false, emails: currentEmailsState };
      }

      if (getIsCancelled()) return { success: false, emails: currentEmailsState };

      const newMessages: any[] = [];
      const nextTokens: Record<string, string | null> = {};
      let anyOk = false;
      for (const { accountEmail, res } of results) {
        if (!res || !res.ok) continue;
        const data = await res.json();
        // res.json() 待機中に新しいフィルターへ切り替えられている可能性があるため再チェック。
        // ここで弾かないと、古いフィルターの結果が新しいフィルターの結果を上書きしてしまう
        if (getIsCancelled()) return { success: false, emails: currentEmailsState };
        anyOk = true;
        (data.messages || []).forEach((m: any) => newMessages.push({ ...m, accountId: accountEmail }));
        nextTokens[accountEmail] = data.nextPageToken || null;
      }
      if (!anyOk) return { success: false, emails: currentEmailsState };

      const map = new Map(currentEmailsState.map((e: any) => [e.id, e]));
      newMessages.forEach((m: any) => map.set(m.id, m));
      const updatedEmails = Array.from(map.values()).sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime());

      const nextPMsgs = syncConfigs(updatedEmails, chatConfigsRef.current, messageConfigsRef.current);
      setPersistedEmails(nextPMsgs);
      setEmails(updatedEmails);

      if (!isSilent || updatedEmails.length <= targetLimit) setCurrentNextPageTokens(nextTokens);
      return { success: true, emails: updatedEmails };
    } catch (error) {
      return { success: false, emails: currentEmailsState };
    } finally {
      if (!isSilent && !getIsCancelled()) setIsLoading(false);
    }
  };

  const initLoadDoneRef = useRef(false);
  // 初回のメール取得が完了するまでは senderList が空のまま（未取得なだけ）なので、
  // 「フィルターでチャットが消えた」判定を初回取得完了まで抑止するためのフラグ
  const hasLoadedOnceRef = useRef(false);

  useEffect(() => {
    if (session && !initLoadDoneRef.current) {
      initLoadDoneRef.current = true;
      const initLoad = async () => {
        try {
          setIsLoading(true);
          const [{ formatted: loadedConfigs }, linkedAccountsRes] = await Promise.all([
            loadD1Configs(),
            fetch("/api/accounts").then(r => r.ok ? r.json() : { accounts: [] }).catch(() => ({ accounts: [] })),
          ]);
          // fetchEmails等が読む前に、ref側は同期的に確定させておく（state更新の再レンダリングを待たない）
          const linkedEmails: string[] = ((linkedAccountsRes.accounts || []) as any[]).map((a: any) => a.account_email).filter(Boolean);
          linkedAccountsRef.current = linkedEmails;
          setLinkedAccounts(linkedEmails);

          // チェックボックスの状態はマウント時点で localStorage から同期的に復元済みなので、
          // ここでは読み直さず現在の state をそのまま使う（読み込み中に見た目が切り替わるのを防ぐ）
          const initInbox = checkInbox;
          const initArchive = checkArchive;
          const initSpam = checkSpam;
          const initTrash = checkTrash;
          const initSent = checkSent;
          filterKeyRef.current = `${initInbox}-${initArchive}-${initSpam}-${initTrash}-${initSent}`;
          isInitialFilterRun.current = false;

          setEmails([]);

          let res = await fetchEmails(100, "", { inbox: initInbox, archive: initArchive, spam: initSpam, trash: initTrash, sent: initSent }, null, false, false, [], () => false, true);
          if (!res.success) {
            // デプロイ直後の再起動やネットワーク瞬断でここが失敗すると、全体一覧が空のまま
            // fetchChatCrossbox（開いていたチャットだけの取得）が成功してしまい、
            // 「そのチャットしか表示されない」ように見える不具合になるため1回だけ再試行する
            await new Promise(r => setTimeout(r, 1500));
            res = await fetchEmails(100, "", { inbox: initInbox, archive: initArchive, spam: initSpam, trash: initTrash, sent: initSent }, null, false, false, [], () => false, true);
          }
          emailsFilterKeyRef.current = filterKeyRef.current;

          if (selectedSender && res.success) {
            // await せずに進むと、復元したチャットのメッセージがまだ senderList に
            // 反映される前に hasLoadedOnceRef が立ってしまい、「チャットが消えた」と
            // 誤判定されて selectedSender がクリアされてしまう（＝復元直後に一瞬だけ
            // 「チャットを選択してください」画面に戻ってしまう不具合の原因だった）
            const restoredConfig = loadedConfigs[selectedSender];
            const { accountEmail: restoredAccountEmail, localKey: restoredLocalKey } = decodeRoomKey(selectedSender);
            if (restoredConfig?.isGroup) {
              // グループのルームキーはGmail検索語にならないため、メンバーごとに個別取得する
              await Promise.all((restoredConfig.groupMembers || []).map(m => fetchChatCrossbox(asLocalKey(m), restoredAccountEmail, false, res.emails).catch(() => {})));
            } else {
              await fetchChatCrossbox(restoredLocalKey, restoredAccountEmail, false, res.emails);
            }
          }

          // 表示中のモーダル・選択中の内容・作成中の返信を復元する。
          // 表示に必要な内容そのものを保存してあるため、データの再取得完了を待たずに復元できる
          try {
            const savedUiState = localStorage.getItem("remail_ui_state");
            if (savedUiState) {
              const ui = JSON.parse(savedUiState);
              if (ui.selectionMode && ui.selectionMode !== "none" && Array.isArray(ui.selectedIds) && ui.selectedIds.length > 0) {
                setSelectionMode(ui.selectionMode);
                setSelectedIds(ui.selectedIds);
              }
              if (ui.modal) setModal(ui.modal);
              if (ui.renameInput) setRenameInput(ui.renameInput);
              if (ui.resetOptions) setResetOptions(ui.resetOptions);
              if (ui.moveDestination) setMoveDestination(ui.moveDestination);
              if (ui.replySubject) setReplySubject(ui.replySubject);
              if (ui.replyBody) setReplyBody(ui.replyBody);
              if (ui.replyToMessage) setReplyToMessage(ui.replyToMessage);
              if (ui.emailModalEmail) openEmailModal(ui.emailModalEmail);
              if (ui.attachmentModal) openAttachmentModal(ui.attachmentModal);
            }
          } catch (e) { console.error(e); }

          setTimeout(() => {
            const asideScroll = localStorage.getItem(`remail_scroll_aside_${activeChatTab}`);
            const mainScroll = localStorage.getItem("remail_scroll_main");
            const asideEl = document.querySelector("aside > div.flex-1");
            const mainEl = document.querySelector("main > div.flex-1");
            if (asideScroll && asideEl) asideEl.scrollTop = parseInt(asideScroll, 10);
            if (mainScroll && mainEl) mainEl.scrollTop = parseInt(mainScroll, 10);
          }, 150);

        } catch (err) { console.error(err); } finally { setIsLoading(false); hasLoadedOnceRef.current = true; }
      };
      initLoad();
    }
  }, [session]);

  // sender は必ず生のローカルキー（相手の表示名/アドレス）。Gmail検索クエリに直接埋め込むため、
  // 複合roomKeyを渡すと壊れる（"from:\"account name\"" のような無意味な検索になる）。
  // accountEmail はこの相手が所属するアカウント（roomKeyのアカウント部分）で、どの連携アカウントの
  // Gmailから取得するかを決める
  const fetchChatCrossbox = async (sender: LocalKey, accountEmail: string, isLoadMore = false, knownEmails = emailsRef.current, skipToken = false) => {
    try {
      // ref を使う: state(chatNextPageToken)は連続でループ呼び出しした場合に
      // 再レンダリング前の古い値を参照し続けてしまう（同じページを取得し続ける）ことがあるため
      if (isLoadMore && chatNextPageTokenRef.current?.startsWith("END")) {
        return { found: false, nextToken: chatNextPageTokenRef.current, messages: [] };
      }

      const addrSet = new Set<string>();
      knownEmails.forEach(e => {
        if (e.from.includes(sender) || (e.to && e.to.includes(sender)) || e.senderRoom === sender) {
          if (!e.isMe) {
            const match = e.from.match(/<([^>]+)>/);
            if (match) addrSet.add(match[1].trim());
          }
        }
      });
      let q = `(from:"${sender}" OR to:"${sender}")`;
      if (addrSet.size > 0) {
         const addrs = Array.from(addrSet).map(a => `from:${a} OR to:${a}`).join(" OR ");
         q = `(${q} OR ${addrs})`;
      }

      const params = new URLSearchParams({ maxResults: "100", q, includeTrash: "true" });
      if (accountEmail && accountEmail !== (session?.user?.email || "")) params.append("accountEmail", accountEmail);
      const tokenToUse = isLoadMore ? (chatNextPageTokenRef.current === "FIRST_PAGE" ? null : chatNextPageTokenRef.current) : null;
      if (tokenToUse) params.append("pageToken", tokenToUse);
      params.append("_t", Date.now().toString());

      const res = await fetch(`/api/emails?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        const validMessages = (data.messages || []).map((m: any) => ({ ...m, accountId: accountEmail }));
        let nextToken = data.nextPageToken || "END_ALL";
        if (!skipToken) { setChatNextPageToken(nextToken); chatNextPageTokenRef.current = nextToken; }

        if (validMessages.length > 0) {
          setEmails(prev => {
            const map = new Map(prev.map(e => [e.id, e]));
            validMessages.forEach((m: any) => map.set(m.id, m));
            return Array.from(map.values());
          });
        }

        return { found: validMessages.length > 0, nextToken, messages: validMessages };
      }
    } catch(e) { console.error(e); }
    return { found: false, nextToken: isLoadMore ? chatNextPageTokenRef.current : "FIRST_PAGE", messages: [] };
  };

  // ルームの履歴を取得する。グループチャットの場合はルームキー自体がGmail検索語にならないため、
  // メンバーそれぞれのアドレスで個別に取得する
  const fetchCrossboxForRoom = async (room: RoomKeyStr, knownEmails = emailsRef.current) => {
    const cfg = chatConfigsRef.current[room];
    const { accountEmail, localKey } = decodeRoomKey(room);
    if (cfg?.isGroup) {
      await Promise.all((cfg.groupMembers || []).map(m => fetchChatCrossbox(asLocalKey(m), accountEmail, false, knownEmails).catch(() => {})));
    } else {
      await fetchChatCrossbox(localKey, accountEmail, false, knownEmails);
    }
  };

  useEffect(() => {
    if (!session) return;

    if (isInitialFilterRun.current) {
      isInitialFilterRun.current = false;
      return;
    }

    const newFilterKey = `${checkInbox}-${checkArchive}-${checkSpam}-${checkTrash}-${checkSent}`;
    const isFilterChange = filterKeyRef.current !== newFilterKey;

    if (isFilterChange) {
      // 旧フィルターの状態をキャッシュに保存する。ただし emails が本当に「旧フィルターの取得結果」を
      // 反映している場合に限る（連続切り替えで直前の取得がキャンセルされていた場合、emails は
      // さらに古いフィルターのデータのままなので、それを誤って旧フィルター名義でキャッシュしない）
      if (emailsFilterKeyRef.current === filterKeyRef.current) {
        filterCacheRef.current.set(filterKeyRef.current, {
          emails: emailsRef.current,
          currentNextPageTokens: currentNextPageTokensRef.current,
        });
      }
      filterKeyRef.current = newFilterKey;
      // 他場所の表示リセット
      setRevealedCrossPrompts([]);
    }

    let isCancelled = false;
    activeLoadRef.current += 1;

    const handleFilterChange = async () => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
      searchTimeoutRef.current = setTimeout(async () => {
        await saveGlobalSettings(checkInbox, checkArchive, checkSpam, checkTrash, checkSent);

        // フィルター切り替えでキャッシュあり → 即復元
        const cached = isFilterChange ? filterCacheRef.current.get(newFilterKey) : null;
        if (cached) {
          if (!isCancelled) {
            setEmails(cached.emails);
            setCurrentNextPageTokens(cached.currentNextPageTokens);
            currentNextPageTokensRef.current = cached.currentNextPageTokens;
            setChatStatusMessage(null);
            setIsLoading(false);
            emailsFilterKeyRef.current = newFilterKey;
          }
          if (selectedSender && !isCancelled) {
            fetchCrossboxForRoom(selectedSender, cached.emails);
          }
        } else {
          if (!isCancelled) { setEmails([]); setChatStatusMessage(null); }
          const res = await fetchEmails(100, "", { inbox: checkInbox, archive: checkArchive, spam: checkSpam, trash: checkTrash, sent: checkSent }, null, false, false, [], () => isCancelled, true);
          if (!isCancelled) { setChatStatusMessage(null); emailsFilterKeyRef.current = newFilterKey; }
          if (selectedSender && !isCancelled && res.success) {
            fetchCrossboxForRoom(selectedSender, res.emails);
          }
        }
      }, 0);
    };
    handleFilterChange();
    return () => { isCancelled = true; if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current); };
  }, [checkInbox, checkArchive, checkSpam, checkTrash, checkSent]);

  // フィルター変化時（チャットタブの切り替えを含む）に選択をキャンセル
  useEffect(() => {
    if (selectionMode === "none") return;
    setSelectionMode("none");
    setSelectedIds([]);
    if (hasPushedSelectRef.current) {
      hasPushedSelectRef.current = false;
      if (typeof window !== "undefined" && window.history.state?.action === "select") {
        window.history.back();
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkInbox, checkArchive, checkSpam, checkTrash, checkSent, activeChatTab]);

  // チャットを切り替えたら検索バーを閉じる。ただし検索結果からのジャンプ直後は消さない
  // （jumpToSearchResult が selectedSender を変えると同時に検索バーを開くため）
  // ここでは履歴操作はせず状態のリセットのみ行う（履歴側は closeFindBar / 戻る操作で整理される）
  useEffect(() => {
    if (skipFindBarAutoCloseRef.current) { skipFindBarAutoCloseRef.current = false; return; }
    if (findBarOpen) {
      setFindBarOpen(false);
      setFindBarKeyword("");
      setFindBarMatchIndex(-1);
      hasPushedFindBarRef.current = false;
    }
  }, [selectedSender]);

  useEffect(() => {
    if (!session) return;
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        fetchEmails(100, "", { inbox: checkInbox, archive: checkArchive, spam: checkSpam, trash: checkTrash, sent: checkSent }, null, false, true, emailsRef.current, () => false, false);
      }
    }, 60000);

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        if (emailsRef.current.length === 0) {
          fetchEmails(100, "", { inbox: checkInbox, archive: checkArchive, spam: checkSpam, trash: checkTrash, sent: checkSent }, null, false, false, [], () => false, true);
        } else {
          fetchEmails(100, "", { inbox: checkInbox, archive: checkArchive, spam: checkSpam, trash: checkTrash, sent: checkSent }, null, false, true, emailsRef.current, () => false, false);
        }
      }
    };
    const handleOnline = () => {
      fetchEmails(100, "", { inbox: checkInbox, archive: checkArchive, spam: checkSpam, trash: checkTrash, sent: checkSent }, null, false, true, emailsRef.current, () => false, false);
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("online", handleOnline);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("online", handleOnline);
    };
  }, [session, checkInbox, checkArchive, checkSpam, checkTrash, checkSent]);

  // 実際のグルーピングロジックは app/lib/groupEmails.ts の純粋関数に切り出してある
  // （副作用のない形でユニットテストできるようにするため）。groupedEmails・chatConfigs・
  // selectedSender は常に encodeRoomKey 済みの複合roomKey（RoomKeyStr）をキーとする。
  // chatConfigsは既に複合キーなので、groupEmailsByRoom（1アカウント分・ローカルキー前提の
  // 純粋関数）に渡す前に対象アカウント分だけローカルキーへ戻し、結果をmergeAccountGroupsで
  // 複合キーへ戻す。allUniqueEmailsも同様に、そのアカウント自身のメール（e.accountId一致）だけに
  // 絞り込んでから渡す（絞り込まないと、他アカウント宛のメールまでこのアカウントの相手名で
  // 誤ってグルーピングされてしまう）。accountId未設定（導入前のデータ・送信直後のローカルfake等）は
  // メインアカウント名義として扱う
  const groupedEmails = useMemo(() => {
    const myEmail = session?.user?.email || "";
    const accounts = [myEmail, ...linkedAccounts];
    const perAccountGroups = accounts.map(accountEmail => {
      const localChatConfigs: Record<LocalKey, ChatConfig> = {} as Record<LocalKey, ChatConfig>;
      keysOf(chatConfigs).forEach(key => {
        try {
          const decoded = decodeRoomKey(key);
          if (decoded.accountEmail === accountEmail) localChatConfigs[decoded.localKey] = chatConfigs[key];
        } catch { /* 複合roomKeyでない古いデータ（移行前の残り等）は無視する */ }
      });
      const accountEmails = allUniqueEmails.filter(e => (e.accountId || myEmail) === accountEmail);
      return { accountEmail, groups: groupEmailsByRoom(accountEmails, accountEmail, localChatConfigs) };
    });
    const merged = mergeAccountGroups(perAccountGroups);
    // フィルターグループ（filterCriteria持ち）は受信専用のため、上のアカウント単位の集約を
    // 対象外にしてある（groupEmailsByRoom側）。ここで全アカウント分のメールをまたいで
    // 別途集約する（criteria.accountEmailで対象アカウントを絞り込める）
    return applyFilterGroups(merged, chatConfigs, allUniqueEmails, myEmail);
  }, [allUniqueEmails, session, chatConfigs, linkedAccounts]);

  const groupedEmailsRef = useRef(groupedEmails);
  useEffect(() => { groupedEmailsRef.current = groupedEmails; }, [groupedEmails]);

  // UI表示用: 複合キーからアカウント内のローカルな識別子（表示名など）だけを取り出す。
  // customNameが無いチャットのフォールバック表示など、Modals.tsx側で複合キーをそのまま
  // 画面に出してしまわないようにするために使う（roomKeyの直接パースを一元化するルールのため、
  // UI側はこのヘルパー経由でのみローカル部分を取得する）
  const roomLocalKey = (room: string): string => {
    try { return decodeRoomKey(room).localKey; } catch { return room; }
  };

  // UI表示用: 複合キーが属するアカウントのメールアドレスを取り出す（アカウントバッジ表示用）
  const roomAccountEmail = (room: string): string => {
    try { return decodeRoomKey(room).accountEmail; } catch { return session?.user?.email || ""; }
  };

  // アカウント連携の解除。D1のlinked_accounts行だけを消す（chat_configsは再連携時に復元できるようあえて残す。
  // /api/accounts のDELETEハンドラ自体の方針と同じ）。ローカル側はそのアカウント分のメールを一覧から
  // 即座に取り除き、開いていたチャットがそのアカウントのものだった場合は閉じる
  const unlinkAccount = async (accountEmail: string) => {
    const myEmail = session?.user?.email || "";
    setLinkedAccounts(prev => prev.filter(a => a !== accountEmail));
    linkedAccountsRef.current = linkedAccountsRef.current.filter(a => a !== accountEmail);
    setEmails(prev => prev.filter((e: any) => (e.accountId || myEmail) !== accountEmail));
    setCurrentNextPageTokens(prev => {
      const next = { ...prev };
      delete next[accountEmail];
      return next;
    });
    if (selectedSender) {
      try {
        if (decodeRoomKey(selectedSender).accountEmail === accountEmail) {
          setSelectedSender(null);
          if (typeof window !== "undefined") {
            localStorage.removeItem("remail_selected_sender");
            localStorage.removeItem("remail_scroll_main");
          }
        }
      } catch { /* 複合キーでない古いデータは無視 */ }
    }
    try { await fetch(`/api/accounts?account_email=${encodeURIComponent(accountEmail)}`, { method: "DELETE" }); } catch (e) { console.error(e); }
  };

  // メッセージID → 所属ルームキーの逆引き。フィルターツールで複数ルームにまたがる
  // メッセージを一括非表示/ピン留めする際、各メッセージ自身の本来のルームを正しく特定するために使う
  const emailRoomMap = useMemo(() => {
    const map = new Map<string, RoomKeyStr>();
    keysOf(groupedEmails).forEach(room => (groupedEmails[room] || []).forEach((e: any) => map.set(e.id, room)));
    return map;
  }, [groupedEmails]);

  // メッセージが実際にどのアカウントに属するかを解決する。
  // 1) 既にそのメッセージの設定行が存在すればそのアカウントを最優先で再利用する
  //    （非表示化した後にメールデータがローカルから消えても、unhide時に同じキーへ確実に書き戻すため）
  // 2) groupedEmailsのroomキー（既に正しいアカウントで複合化済み）
  // 3) メール自身のaccountId
  // 4) どれも無ければメインアカウントにフォールバック
  const resolveMessageAccountEmail = (messageId: string): string => {
    const existingKey = keysOf(messageConfigsRef.current).find(k => decodeRoomKey(k).localKey === (messageId as LocalKey));
    if (existingKey) {
      try { return decodeRoomKey(existingKey).accountEmail; } catch { /* 複合キーでない古いデータは無視 */ }
    }
    const room = emailRoomMap.get(messageId);
    if (room) {
      try { return decodeRoomKey(room).accountEmail; } catch { /* 複合キーでない古いデータは無視 */ }
    }
    const found = allUniqueEmails.find((e: any) => e.id === messageId);
    return found?.accountId || session?.user?.email || "";
  };

  // メッセージ単位の設定（messageConfigs）を引くための複合キーを作る。そのメッセージが
  // 実際に属するアカウントで複合化するため、連携アカウントをまたいでメッセージIDが
  // 衝突しても互いの非表示/ピン留め状態が混ざらない
  const messageConfigKey = (messageId: string): RoomKeyStr => encodeRoomKey(resolveMessageAccountEmail(messageId), messageId as LocalKey);

  // ルーム内の相手メールアドレスを推定する（「作成」機能での重複チャット判定・検索に使用）
  const getRoomAddress = (room: RoomKeyStr): string => {
    const msgs = groupedEmails[room] || [];
    const partner = msgs.find((e: any) => !isMineEmail(e, session?.user?.email || ""));
    const raw = partner ? partner.from : (msgs.find((e: any) => e.to)?.to || "");
    const match = (raw || "").match(/<([^>]+)>/);
    return ((match ? match[1] : raw) || "").trim().toLowerCase();
  };

  // 「作成」モーダルの「候補」一覧（下書き中の空チャット・グループ自体は除く）。
  // ボックスのチェックボックス状態には影響されず（groupedEmails自体が非フィルター済みのため）、
  // 現在のフィルターに関わらず常に最新のやり取り順（時系列順）で並べる
  const contactDirectory = useMemo(() => {
    return keysOf(groupedEmails)
      .filter(room => (groupedEmails[room] || []).length > 0 && !chatConfigs[room]?.isGroup)
      .map(room => {
        const decoded = decodeRoomKey(room);
        return {
          room,
          label: chatConfigs[room]?.customName || decoded.localKey,
          address: getRoomAddress(room),
          accountEmail: decoded.accountEmail,
          latestDate: groupedEmails[room][0]?.date ? new Date(groupedEmails[room][0].date).getTime() : 0,
        };
      })
      .sort((a, b) => b.latestDate - a.latestDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupedEmails, chatConfigs, session]);

  // グループチャットの「返信先を選択」用プール: 表示モードに関わらず、
  // 自分がグループから送信したメール + メンバー全員からの受信メールを常に候補にする
  // （送信専用モードでもスレッドには出てこない相手の発言を選んで返信できるようにするため）
  const groupReplyPools = useMemo(() => {
    const pools: Record<string, any[]> = {};
    keysOf(chatConfigs).forEach(room => {
      const cfg = chatConfigs[room];
      if (!cfg?.isGroup) return;
      const myEmail = session?.user?.email || "";
      const { accountEmail } = decodeRoomKey(room);
      // groupMembers はローカルキーで保存されているため、groupedEmails（複合キー）を引く前に
      // このグループ自身のアカウントで複合化した、ローカルキーだけの部分集合を作る
      const localMemberLookup: Record<string, any[]> = {};
      (cfg.groupMembers || []).forEach(m => { localMemberLookup[m] = groupedEmails[encodeRoomKey(accountEmail, m as LocalKey)] || []; });
      const memberAddresses = resolveGroupMemberAddresses(cfg, localMemberLookup, myEmail);
      const sentViaGroup = allUniqueEmails.filter((e: any) => isMineEmail(e, myEmail) && sameAddressSet(parseAddressSet(e.to || ""), memberAddresses));
      const received = allUniqueEmails.filter((e: any) => {
        if (isMineEmail(e, myEmail)) return false;
        const addrMatch = (e.from || "").match(/<([^>]+)>/);
        const addr = (addrMatch ? addrMatch[1] : e.from || "").trim().toLowerCase();
        return memberAddresses.has(addr);
      });
      pools[room] = [...sentViaGroup, ...received].sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime());
    });
    return pools;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allUniqueEmails, chatConfigs, groupedEmails, session]);

  // 下書きチャットから他のチャットへ離脱した際、まだ何も送信していなければ破棄する
  // （リロード/タブ復元では selectedSender が変化しないのでここは発火せず維持される）
  const prevDraftCheckSenderRef = useRef<RoomKeyStr | null>(selectedSender);
  useEffect(() => {
    const prev = prevDraftCheckSenderRef.current;
    if (prev && prev !== selectedSender && draftChatsRef.current.includes(prev)) {
      const stillEmpty = !groupedEmailsRef.current[prev] || groupedEmailsRef.current[prev].length === 0;
      if (stillEmpty) removeDraftChat(prev);
    }
    prevDraftCheckSenderRef.current = selectedSender;
  }, [selectedSender]);

  const senderList = useMemo<RoomKeyStr[]>(() => {

    const getLatestValidDate = (sender: RoomKeyStr): number => {
      const allEmails = groupedEmails[sender] || [];
      const config = chatConfigs[sender];

      const validEmails = allEmails.filter((e: any) => {
        const isTrash = e.labelIds?.includes("TRASH");
        const isSpam = e.labelIds?.includes("SPAM");
        const isInbox = e.labelIds?.includes("INBOX");
        const isSent = e.labelIds?.includes("SENT") || e.isMe;
        const isArchive = !isTrash && !isSpam && !isInbox && !isSent;

        if ((isInbox || isArchive || isSent) && (config?.isHidden || messageConfigs[messageConfigKey(e.id)]?.isHidden)) return false;

        // ★修正: 送信済みの「絶対権限（他のラベルを無視）」を適用
        let isCurrentBox = false;
        if (isSent) {
            isCurrentBox = checkSent;
        } else {
            isCurrentBox = (isTrash && checkTrash) || (isSpam && checkSpam) || (isInbox && checkInbox) || (isArchive && checkArchive);
        }

        return isCurrentBox || revealedCrossPrompts.includes(e.id);
      });

      return validEmails[0] ? new Date(validEmails[0].date).getTime() : 0;
    };

    const allRoomKeys = Array.from(new Set([...keysOf(groupedEmails), ...draftChats])) as RoomKeyStr[];

    return allRoomKeys.filter((sender: RoomKeyStr) => {
      const config = chatConfigs[sender];
      if (config?.isHidden) return false;

      // 「作成」で作った未送信の下書きチャットは、送信するまで無条件で一覧に表示する
      if (draftChats.includes(sender) && (!groupedEmails[sender] || groupedEmails[sender].length === 0)) return true;

      const hasDisplayableEmail = (groupedEmails[sender] || []).some((e: any) => {
        const isTrash = e.labelIds?.includes("TRASH");
        const isSpam = e.labelIds?.includes("SPAM");
        const isInbox = e.labelIds?.includes("INBOX");
        const isSent = e.labelIds?.includes("SENT") || e.isMe;
        const isArchive = !isTrash && !isSpam && !isInbox && !isSent;

        if ((isInbox || isArchive || isSent) && (config?.isHidden || messageConfigs[messageConfigKey(e.id)]?.isHidden)) return false;

        if (revealedCrossPrompts.includes(e.id)) return true;

        // ★修正: 送信済みの判定を最初に持ってくることで絶対的な権限を持たせる
        if (isSent) return checkSent;
        if (isTrash) return checkTrash;
        if (isSpam) return checkSpam;
        if (isArchive) return checkArchive;
        return checkInbox;
      });

      if (!hasDisplayableEmail && !config?.isPinned) return false;
      return true;

    }).sort((a: RoomKeyStr, b: RoomKeyStr): number => {
      // 作成直後の下書きチャットは通常のチャットと同様、一番上（ピン留めより上）に表示する
      const isDraftA = draftChats.includes(a) && (!groupedEmails[a] || groupedEmails[a].length === 0) ? 1 : 0;
      const isDraftB = draftChats.includes(b) && (!groupedEmails[b] || groupedEmails[b].length === 0) ? 1 : 0;
      if (isDraftA !== isDraftB) return isDraftB - isDraftA;

      const pinA = chatConfigs[a]?.isPinned ? 1 : 0;
      const pinB = chatConfigs[b]?.isPinned ? 1 : 0;
      if (pinA !== pinB) return pinB - pinA;

      const timeA = getLatestValidDate(a);
      const timeB = getLatestValidDate(b);
      return (isNaN(timeB) ? 0 : timeB) - (isNaN(timeA) ? 0 : timeA);
    });
  }, [groupedEmails, chatConfigs, messageConfigs, checkSent, checkInbox, checkArchive, checkSpam, checkTrash, revealedCrossPrompts, draftChats]);

  const hiddenChats = keysOf(chatConfigs).filter(k => chatConfigs[k]?.isHidden);
  // messageConfigsは複合キーだが、他所（Modals.tsx等）との互換のため各要素のidは生のメッセージIDのまま返す
  const hiddenMsgs = keysOf(messageConfigs).filter(k => messageConfigs[k]?.isHidden).map(stateKey => {
    const { localKey: id } = decodeRoomKey(stateKey);
    return allUniqueEmails.find(e => e.id === id) || { id, subject: "過去のメッセージ", date: new Date().toISOString() };
  });

  // senderList からチャットが消えたら（フィルター変更・非表示化など）メッセージ画面を自動クローズ
  // ただし初回のメール取得が終わるまでは senderList が「まだ空なだけ」なので判定しない。
  // また、「作成」で候補から直接開いたチャットのように、そもそも現在のフィルターで
  // 一覧に表示される対象ではないチャットまで閉じてしまわないよう、
  // 過去に一度でも一覧に表示されていた（＝本当に消えた）場合のみクローズする
  const prevSenderListRef = useRef<string[]>(senderList);
  useEffect(() => {
    if (hasLoadedOnceRef.current && !isLoading && selectedSender) {
      const wasVisible = prevSenderListRef.current.includes(selectedSender);
      const isVisible = senderList.includes(selectedSender);
      if (wasVisible && !isVisible) {
        setSelectedSender(null);
        if (typeof window !== "undefined") {
          localStorage.removeItem("remail_selected_sender");
          localStorage.removeItem("remail_scroll_main");
        }
      }
    }
    prevSenderListRef.current = senderList;
  }, [senderList, isLoading]);

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
      const { localKey: prevLocal } = decodeRoomKey(prevSender);
      const senderEmails = emailsRef.current.filter((e: any) => {
        if (e.senderRoom === prevLocal) return true;
        const room = e.from?.split("<")[0].replace(/"/g, "").trim() || "Unknown";
        return room === prevLocal || e.from?.includes(prevLocal) || e.to?.includes(prevLocal);
      });
      chatCacheRef.current.set(prevSender, {
        emails: senderEmails,
        chatNextPageToken: chatNextPageTokenRef.current,
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
    setReplyToMessage(null);
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
      setEmails(prev => {
        const map = new Map(prev.map((e: any) => [e.id, e]));
        cached.emails.forEach((e: any) => map.set(e.id, e));
        return Array.from(map.values());
      });
      setChatNextPageToken(cached.chatNextPageToken || "FIRST_PAGE");
    } else {
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
  const createOrOpenChat = async (identifier: string, accountEmail?: string) => {
    const trimmed = identifier.trim();
    if (!trimmed) return;
    const myEmail = session?.user?.email || "";
    const targetAccountEmail = accountEmail || myEmail;
    // contactDirectory の候補選択は既に複合キー（room）そのものが渡ってくる。
    // 新規入力のメールアドレス/表示名は区切り文字を含まないので、選択されたアカウント名義で複合化する
    let directKey: RoomKeyStr;
    try {
      decodeRoomKey(trimmed);
      directKey = trimmed as RoomKeyStr;
    } catch {
      directKey = encodeRoomKey(targetAccountEmail, asLocalKey(trimmed));
    }

    let existingRoom: RoomKeyStr | null = null;
    if (groupedEmails[directKey] && !chatConfigs[directKey]?.isGroup) {
      existingRoom = directKey;
    } else {
      const idLower = trimmed.toLowerCase();
      existingRoom = keysOf(groupedEmails).find(room => !chatConfigs[room]?.isGroup && getRoomAddress(room) === idLower) || null;
    }

    if (existingRoom) {
      await openChat(existingRoom);
    } else {
      addDraftChat(directKey);
      await openChat(directKey);
    }
  };

  // 「作成」モーダルで複数の宛先を選んだ場合のグループチャット作成。
  // members/hideMemberIndividualChats は contactDirectory 由来の複合キーと、新規入力の生アドレスが混在する。
  // accountEmail はこのグループ自身をどのアカウント名義で作るか（「作成」モーダルのアカウント選択UIから
  // 渡される。未指定時はメインアカウント）
  const createGroupChat = async (name: string, members: string[], memberAddresses: string[], mode: GroupMode, hideMemberIndividualChats: string[], accountEmail?: string) => {
    const myEmail = accountEmail || session?.user?.email || "";
    const groupRoomLocal = asLocalKey(`group:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    const groupRoom = encodeRoomKey(myEmail, groupRoomLocal);

    const toMemberKey = (m: string): RoomKeyStr => {
      try { decodeRoomKey(m); return m as RoomKeyStr; } catch { return encodeRoomKey(myEmail, asLocalKey(m)); }
    };
    const localMembers = members.map(m => decodeRoomKey(toMemberKey(m)).localKey);

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
    setReplyToMessage(null); setReplySubject(""); setReplyBody("");
    if (isMobile) window.history.pushState({ chat: groupRoom }, '', '#chat');

    // 各メンバーの過去のやり取りを読み込んでおく（作成直後からグループの内容が見えるように）
    await Promise.all(localMembers.map(m => fetchChatCrossbox(m, myEmail, false).catch(() => {})));
  };

  // フィルターツールで作成するグループ。宛先の集合ではなく条件（FilterCriteria）でメッセージを
  // 動的に集約する。新着メールも条件に合えば自動的に含まれ続ける。常に受信専用チャットとして扱う
  const createFilterGroup = async (name: string, filterCriteria: FilterCriteria, hideOriginal: boolean, includeExisting: boolean = true) => {
    const myEmail = session?.user?.email || "";
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
    setReplyToMessage(null); setReplySubject(""); setReplyBody("");
    if (isMobile) window.history.pushState({ chat: groupRoom }, '', '#chat');
  };

  const enterSelectionMode = (type: "chat" | "msg", id: string) => {
    const mode: SelectionMode = type === "chat" ? "chat_select" : "msg_select";
    setSelectionMode(mode);
    setSelectedIds([id]);
    if (type === "chat") {
      const { accountEmail, localKey } = decodeRoomKey(id);
      fetchChatCrossbox(localKey, accountEmail, false, emailsRef.current, true);
    }
    // 重複して積まない（既にselect履歴エントリがある場合はスキップ）
    if (!hasPushedSelectRef.current && window.history.state?.action !== "select") {
      window.history.pushState({ action: "select" }, "", window.location.href);
      hasPushedSelectRef.current = true;
    } else if (window.history.state?.action === "select") {
      hasPushedSelectRef.current = true;
    }
  };

  const handleMenuBarClick = (mode: string) => {
    const targetMode = mode.startsWith("chat") ? "chat" : "msg";
    const act = mode.replace("chat_", "").replace("msg_", "");
    const inSelection = selectionMode === `${targetMode}_select`;

    if (act === "reset") {
      if (!inSelection || selectedIds.length === 0) return;
      setResetOptions({ pin: true, hide: true, name: true, crossBox: false });
      setModal({ type: "confirm_reset", targetMode: "specific_chat", targets: [...selectedIds] });
      window.history.pushState({ action: "modal" }, "", window.location.href);
      return;
    }

    if (!inSelection || selectedIds.length === 0) return;

    if (act === "pin") {
      if (targetMode === "chat") {
        setModal({ type: "confirm_pin", targetMode: "chat", targets: [...selectedIds] });
      } else {
        setModal({ type: "categorized_action_select", targetMode: "msg", targets: [...selectedIds], action: "pin" } as any);
      }
    } else if (act === "unpin") {
      setModal({ type: "confirm_unpin", targetMode: targetMode as any, targets: [...selectedIds] });
    } else if (act === "hide") {
      if (targetMode === "chat") {
        setModal({ type: "confirm_hide", targetMode: "chat", targets: [...selectedIds] });
      } else {
        setModal({ type: "categorized_action_select", targetMode: "msg", targets: [...selectedIds], action: "hide" } as any);
      }
    } else if (act === "delete") {
      // 選択がすべてグループチャットの場合は、実メールを一切触らない専用の削除フローにする
      if (targetMode === "chat" && selectedIds.every(id => chatConfigsRef.current[id as RoomKeyStr]?.isGroup)) {
        setModal({ type: "confirm_delete_group", targetMode: "chat", targets: [...selectedIds] });
      } else {
        setModal({ type: "categorized_action_select", targetMode: targetMode as any, targets: [...selectedIds], action: "delete" } as any);
      }
    } else if (act === "move") {
      setModal({ type: "categorized_action_select", targetMode: targetMode as any, targets: [...selectedIds], action: "move" } as any);
    }
    window.history.pushState({ action: "modal" }, "", window.location.href);
  };

  const handleBackgroundClick = () => {
    if (selectionMode !== "none") safeBack();
  };

  const toggleSelection = (id: string) => {
    const isAdding = !selectedIds.includes(id);
    const next = isAdding ? [...selectedIds, id] : selectedIds.filter(i => i !== id);
    setSelectedIds(next);
    if (isAdding && selectionMode.startsWith("chat_")) {
      const { accountEmail, localKey } = decodeRoomKey(id);
      fetchChatCrossbox(localKey, accountEmail, false, emailsRef.current, true);
    }
    if (next.length === 0) {
      setSelectionMode("none");
      if (hasPushedSelectRef.current) {
        hasPushedSelectRef.current = false;
        // 選択用の履歴エントリを取り除く
        if (window.history.state?.action === "select") {
          window.history.back();
        }
      }
    }
  };

  const openEmailModal = async (email: any) => {
    // メッセージをクリックした瞬間にブラウザのピンチズームを無効化（useLayoutEffect より前に実行）
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (meta) meta.content = 'width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no';
    setEmailModal({ email, htmlBody: null, isLoading: true });
    window.history.pushState({ action: "modal" }, "", window.location.href);
    if (email.id.startsWith("fake-")) {
      setEmailModal({ email, htmlBody: null, isLoading: false });
      return;
    }
    try {
      // キャッシュされた古いレスポンス（引用除去ロジック更新前のもの等）を掴まないよう、
      // 毎回ユニークなURLになるキャッシュバスターを付ける
      const htmlParams = new URLSearchParams({ messageId: email.id, html: "true", _t: Date.now().toString() });
      const emailAccountEmail = email.accountId || session?.user?.email || "";
      if (emailAccountEmail !== (session?.user?.email || "")) htmlParams.append("accountEmail", emailAccountEmail);
      const res = await fetch(`/api/emails?${htmlParams.toString()}`);
      if (res.ok) {
        const data = await res.json();
        setEmailModal(prev => prev ? { ...prev, htmlBody: data.htmlBody || null, isLoading: false } : null);
      } else {
        setEmailModal(prev => prev ? { ...prev, isLoading: false } : null);
      }
    } catch {
      setEmailModal(prev => prev ? { ...prev, isLoading: false } : null);
    }
  };

  const closeEmailModal = () => {
    // このモーダルを開いた際に積んだ履歴が残ったままだと、閉じた直後にブラウザバックしても
    // その履歴を消費するだけの「何も起きない1回」になってしまう（もう1回押してようやく
    // チャット画面から戻れる、という不具合の原因）。履歴が残っていればここで消費しておく
    const state = window.history.state;
    if (state && (state.action || state.chat)) {
      window.history.back(); // popstate側で emailModal のクリアも行われる
    } else {
      setEmailModal(null);
    }
  };

  const openAttachmentModal = async (
    attachment: { filename: string; mimeType: string; size: number; attachmentId: string; messageId: string; accountId?: string; cacheKey?: string },
    prefetchedBase64?: string
  ) => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (meta) meta.content = 'width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no';
    window.history.pushState({ action: "modal" }, "", window.location.href);
    if (prefetchedBase64) {
      setAttachmentModal({ ...attachment, base64: prefetchedBase64, isLoading: false });
      return;
    }
    setAttachmentModal({ ...attachment, base64: null, isLoading: true });
    const cacheKey = attachment.cacheKey || `${attachment.messageId}:${attachment.attachmentId}`;
    const cached = await getCachedAttachment(cacheKey);
    if (cached) {
      setAttachmentModal(prev => prev ? { ...prev, base64: cached, isLoading: false } : null);
      return;
    }
    try {
      const attParams = new URLSearchParams({ messageId: attachment.messageId, attachmentId: attachment.attachmentId });
      if (attachment.accountId) attParams.append("accountEmail", attachment.accountId);
      const res = await fetch(`/api/emails?${attParams.toString()}`);
      if (res.ok) {
        const { data } = await res.json();
        if (data) {
          const base64 = (data as string).replace(/-/g, '+').replace(/_/g, '/');
          setCachedAttachment(cacheKey, base64);
          setAttachmentModal(prev => prev ? { ...prev, base64, isLoading: false } : null);
        } else {
          setAttachmentModal(prev => prev ? { ...prev, isLoading: false } : null);
        }
      } else {
        setAttachmentModal(prev => prev ? { ...prev, isLoading: false } : null);
      }
    } catch {
      setAttachmentModal(prev => prev ? { ...prev, isLoading: false } : null);
    }
  };

  const closeAttachmentModal = () => {
    // closeEmailModal と同じ理由で、開いた際に積んだ履歴が残っていればここで消費する
    const state = window.history.state;
    if (state && (state.action || state.chat)) {
      window.history.back(); // popstate側で attachmentModal のクリアも行われる
      return;
    }
    setAttachmentModal(null);
  };

  const toggleMsgExpand = (id: string) => {
    setExpandedMsgIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const handleSend = async () => {
    if (!selectedSender || !replyBody.trim()) return;
    const groupCfg = chatConfigs[selectedSender];
    if (groupCfg?.isGroup && (groupCfg.groupMode === "inbound_only" || groupCfg.filterCriteria)) return; // 受信専用・フィルターグループは送信不可
    setIsSending(true);
    try {
      // 送信元アカウントはチャット自身の複合キーから決める（開いているチャットがどの連携アカウント
      // 宛のやり取りかによって、送信に使うGmailアカウントを切り替えるため）
      const { accountEmail: sendAccountEmail, localKey: sendLocalKey } = decodeRoomKey(selectedSender);
      let actualTo: string;
      if (groupCfg?.isGroup) {
        // グループチャット: メンバー全員へ1通のメールとして一斉送信する
        actualTo = Array.from(resolveGroupMemberAddresses(groupCfg, groupedEmails, sendAccountEmail)).join(", ");
      } else {
        const targetEmails = groupedEmails[selectedSender] || [];
        const partnerEmail = targetEmails.find((e: any) => !e.isMe && !e.from.includes(sendAccountEmail));
        actualTo = partnerEmail ? partnerEmail.from : (targetEmails[0]?.to || sendLocalKey);
      }
      
      // ★修正: re:mail上の表示はDiscordのように「どのメッセージへの返信か」をチップで
      // 表示する方式にしたが、送信するメール本体には従来通りの引用文を付ける。
      // 受信側の表示は本文から自動で引用文を取り除くロジック(stripQuotedReply)が
      // 常にかかるため、Gmail等で開いたときは従来通りの引用付き表示のまま、
      // re:mail側ではチップ表示、の両方が両立する
      let finalBody = replyBody; let bodyToSend = replyBody; let threadId = undefined; let finalSubject = replySubject; let inReplyTo: string | undefined = undefined;
      if (replyToMessage) {
        threadId = replyToMessage.threadId;
        inReplyTo = replyToMessage.messageIdHeader;
        if (!finalSubject) finalSubject = replyToMessage.subject.startsWith("Re:") ? replyToMessage.subject : `Re: ${replyToMessage.subject}`;
        if (replyToMessage.body) {
          const d = new Date(replyToMessage.date);
          const weekday = ["日", "月", "火", "水", "木", "金", "土"][d.getDay()];
          const quoteHeader = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日(${weekday}) ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")} ${replyToMessage.from}:`;
          bodyToSend = `${replyBody}\n\n${quoteHeader}\n${(replyToMessage.body as string).split("\n").map((l: string) => `> ${l}`).join("\n")}`;
        }
      }

      const res = await fetch("/api/emails", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "send", to: actualTo, subject: finalSubject, body: bodyToSend, threadId, inReplyTo, accountEmail: sendAccountEmail })
      });

      if (res.ok) {
        // Gmailが実際に採番したIDを使う（リロード後の再取得でも同じメールとして同一視できるようにするため）。
        // 取得できなかった場合のみ、その場限りのフェイクIDにフォールバックする
        const sentData = await res.json().catch(() => ({} as any));
        const sentId: string = sentData.id || `fake-${Date.now()}`;
        const sentFake = {
          id: sentId,
          threadId: sentData.threadId || threadId || "",
          subject: finalSubject || "(件名なし)",
          from: sendAccountEmail || "自分",
          to: actualTo,
          date: new Date().toUTCString(),
          body: finalBody,
          snippet: finalBody.slice(0, 60),
          senderRoom: sendLocalKey,
          isMe: true,
          labelIds: ["SENT"],
          inReplyTo: replyToMessage?.messageIdHeader,
          replyToId: replyToMessage?.id,
          accountId: sendAccountEmail,
        };
        setEmails([sentFake, ...emails]); setReplySubject(""); setReplyBody(""); setReplyToMessage(null);
        // 送信できたので下書きチャットではなくなった（送信済みメールにより通常のチャットとして表示される）
        if (selectedSender && draftChatsRef.current.includes(selectedSender)) removeDraftChat(selectedSender);
      } else {
        const errData = await res.json().catch(() => ({}));
        console.error("Failed to send:", errData);
        alert("メールの送信に失敗しました。宛先が正しいか確認してください。");
      }
    } catch (error) { console.error(error); } finally { setIsSending(false); }
  };

  // メッセージを任意の宛先（既存のチャットに限らず、新規アドレスも含む）へ転送する。
  // 現在開いているチャットとは無関係に送信できるようにするため handleSend とは独立させている
  const forwardMessageTo = async (message: any, recipientIds: string[]) => {
    if (!message || recipientIds.length === 0) return;
    const myEmail = session?.user?.email || "";
    // 転送は元メッセージを受信したのと同じアカウントから送る（reply同様、相手から見て自然な送信元にするため）
    const sendAccountEmail = message.accountId || myEmail;
    // recipientIds は contactDirectory 由来の複合キーと、新規入力の生アドレスが混在する
    const toRoomKey = (id: string): RoomKeyStr => {
      try { decodeRoomKey(id); return id as RoomKeyStr; } catch { return encodeRoomKey(myEmail, asLocalKey(id)); }
    };
    const recipientRoomKeys = recipientIds.map(toRoomKey);
    const addresses = recipientRoomKeys
      .map((room, i) => (groupedEmails[room] ? getRoomAddress(room) : recipientIds[i].trim().toLowerCase()))
      .filter(Boolean);
    const to = addresses.join(", ");
    if (!to) return;

    const subject = (message.subject || "").startsWith("Fwd:") ? message.subject : `Fwd: ${message.subject || ""}`;

    // Gmailの転送と同じヘッダー体裁（この定型文言自体もGmail準拠。日本語版Gmailでもこの部分は英語のまま）
    const forwardHeaderText = `---------- Forwarded message ---------\nFrom: ${message.from || ""}\nDate: ${new Date(message.date).toLocaleString("ja-JP")}\nSubject: ${message.subject || ""}\nTo: ${message.to || ""}\n\n\n`;

    // cleanseBodyで加工済みのテキスト本文だと情報が欠落するため、転送時は元のHTML本文を取り直して
    // そのまま使う（Gmailの転送が体裁・内容を保ったまま転送できているのと同じにするため）
    let originalHtml: string | null = null;
    if (typeof message.id === "string" && !message.id.startsWith("fake-")) {
      try {
        const htmlParams = new URLSearchParams({ messageId: message.id, html: "true", _t: Date.now().toString() });
        if (sendAccountEmail !== myEmail) htmlParams.append("accountEmail", sendAccountEmail);
        const htmlRes = await fetch(`/api/emails?${htmlParams.toString()}`);
        if (htmlRes.ok) {
          const data = await htmlRes.json();
          originalHtml = data.htmlBody || null;
        }
      } catch (e) { console.error(e); }
    }

    const bodyText = forwardHeaderText + (message.body || "");
    const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    // 元のHTMLメールは <html><head>...</head><body>...</body></html> という
    // 完全なドキュメントであることが多い。これをそのまま<div>の中に入れ子にすると
    // 不正なHTML構造になり、背景色などのスタイルが正しく反映されなくなるため、
    // body要素の中身と属性（背景色など）だけを取り出して使う
    const extractBodyContent = (html: string): { inner: string; attrs: string } => {
      const bodyMatch = html.match(/<body([^>]*)>([\s\S]*)<\/body>/i);
      if (bodyMatch) return { inner: bodyMatch[2], attrs: bodyMatch[1] };
      const htmlMatch = html.match(/<html[^>]*>([\s\S]*)<\/html>/i);
      if (htmlMatch) return { inner: htmlMatch[1], attrs: "" };
      return { inner: html, attrs: "" };
    };

    let bodyHtml: string | undefined;
    if (originalHtml) {
      const { inner, attrs } = extractBodyContent(originalHtml);
      bodyHtml = `<div>${escapeHtml(forwardHeaderText).replace(/\n/g, "<br>")}</div><div${attrs}>${inner}</div>`;
    }

    try {
      const res = await fetch("/api/emails", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "send", to, subject, body: bodyText, bodyHtml, accountEmail: sendAccountEmail }),
      });

      if (!res.ok) {
        console.error("Failed to forward:", await res.json().catch(() => ({})));
        alert("メールの転送に失敗しました。宛先が正しいか確認してください。");
        return;
      }

      const sentData = await res.json().catch(() => ({} as any));
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
    } catch (e) {
      console.error(e);
      alert("メールの転送に失敗しました。宛先が正しいか確認してください。");
    }
  };

  // メッセージ単位の非表示のコア処理。modal状態に依存しないため、確認モーダル経由の実行と
  // 継続フィルターの自動適用エンジンの両方から呼べる
  const applyHideToIds = (ids: string[]) => {
    ids.forEach(id => updateMessageConfig(asLocalKey(id), { isHidden: true, hiddenAtDate: new Date().toISOString(), roomId: emailRoomMap.get(id) }, resolveMessageAccountEmail(id)));
  };

  // メッセージ単位のピン留めのコア処理。modal状態に依存しないため、確認モーダル経由の実行と
  // 継続フィルターの自動適用エンジンの両方から呼べる（合計上限100件、TRASH/SPAMは対象外）
  const applyPinToIds = (ids: string[]) => {
    const existingPinnedMsgCount = keysOf(messageConfigsRef.current).filter(k =>
      messageConfigsRef.current[k]?.isPinned && messageConfigsRef.current[k]?.forceFetch
    ).length;
    const capped = ids.slice(0, Math.max(0, 100 - existingPinnedMsgCount));
    const pMsgs: any[] = [];
    capped.forEach((targetId: string) => {
      const found = allUniqueEmails.find((e: any) => e.id === targetId);
      if (found && !found.labelIds?.includes("TRASH") && !found.labelIds?.includes("SPAM")) {
        // フィルターツール等、複数ルームにまたがるメッセージを対象にする場合があるため、
        // 常に selectedSender を使うのではなく、そのメッセージ自身の本来のルームを優先する
        const room = emailRoomMap.get(targetId) || selectedSender || undefined;
        const pData = { ...found, senderRoom: room ? decodeRoomKey(room).localKey : undefined };
        pMsgs.push(pData);
        updateMessageConfig(asLocalKey(targetId), { isPinned: true, forceFetch: true, persistedData: pData, roomId: room }, resolveMessageAccountEmail(targetId));
      }
    });
    if (pMsgs.length > 0) setPersistedEmails(prev => [...prev, ...pMsgs]);
  };

  const executePin = () => {
    if (!modal) return;
    const isChatMode = modal.targetMode === "chat";

    if (isChatMode) {
      // チャットピン留め: 常に永続読み込み、上限10件
      const pMsgs = [...persistedEmails];
      const existingForcePinned = keysOf(chatConfigs).filter(k =>
        chatConfigs[k]?.isPinned && chatConfigs[k]?.forceFetch
      );
      const targets = modal.targets as RoomKeyStr[];
      const newToPin = targets.filter((t) => !existingForcePinned.includes(t));
      if (existingForcePinned.length + newToPin.length > 10) return;

      targets.forEach((targetId) => {
        const localId = decodeRoomKey(targetId).localKey;
        const pData = (groupedEmails[targetId] || []).map((e: any) => ({ ...e, senderRoom: localId }));
        pMsgs.push(...pData);
        updateChatConfigByRoomKey(targetId, { isPinned: true, forceFetch: true, persistedData: pData });
      });
      setPersistedEmails(pMsgs);
    } else {
      // メッセージピン留め: 常に永続読み込み、合計上限100件
      applyPinToIds(modal.targets);
    }

    exitAfterAction();
  };

  const getActionableEmails = (targets: string[], targetMode: string) => {
    let result: any[] = [];
    if (targetMode === "chat") {
      targets.forEach((chat: string) => {
        const chatEmails = groupedEmails[chat as RoomKeyStr] || [];
        result.push(...chatEmails.filter((e: any) => {
          const isTrash = e.labelIds?.includes("TRASH");
          const isSpam = e.labelIds?.includes("SPAM");
          const isInbox = e.labelIds?.includes("INBOX");
          const isSent = e.labelIds?.includes("SENT") || e.isMe; 
          const isArchive = !isTrash && !isSpam && !isInbox && !isSent; 
          
          // ★修正: モーダルでも送信済みの絶対権限を適用する
          let isCurrentBox = false;
          if (isSent) {
              isCurrentBox = checkSent;
          } else {
              isCurrentBox = (isTrash && checkTrash) || (isSpam && checkSpam) || (isInbox && checkInbox) || (isArchive && checkArchive);
          }
          return isCurrentBox || revealedCrossPrompts.includes(e.id);
        }));
      });
    } else {
      result = allUniqueEmails.filter((e: any) => targets.includes(e.id));
    }
    return result;
  };

  // 削除のコア処理（TRASH・SENT以外の「移動可能なメール」のみをゴミ箱へ移動）。modal状態に依存しないため、
  // 確認モーダル経由の実行と継続フィルターの自動適用エンジンの両方から呼べる
  const applyDeleteToIds = (ids: string[]) => {
    const deleteEmails = allUniqueEmails.filter((e: any) => ids.includes(e.id));
    const trashIds = deleteEmails.filter(e => !e.labelIds?.includes("TRASH") && !e.labelIds?.includes("SENT") && !e.isMe).map(e => e.id);
    if (trashIds.length === 0) return;
    try {
      const applyTrashLabels = (e: any) => {
        if (trashIds.includes(e.id)) {
          let newLabels = (e.labelIds || []).filter((l: string) => l !== "INBOX" && l !== "SPAM");
          if (!newLabels.includes("TRASH")) newLabels.push("TRASH");
          return { ...e, labelIds: newLabels };
        }
        return e;
      };

      const nextEmails = emails.map(applyTrashLabels);
      const nextPersisted = persistedEmails.map(applyTrashLabels);

      const combined = new Map();
      nextPersisted.forEach(e => combined.set(e.id, e));
      nextEmails.forEach(e => combined.set(e.id, e));

      const nextPMsgs = syncConfigs(Array.from(combined.values()), chatConfigsRef.current, messageConfigsRef.current);

      setEmails(nextEmails);
      setPersistedEmails(nextPMsgs);
      setRevealedCrossPrompts(prev => prev.filter(id => !trashIds.includes(id)));

      fetch("/api/emails", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "delete", trashIds }) }).catch(e => console.error(e));
    } catch (e) { console.error(e); }
  };

  const executeConfirmedAction = async () => {
    if (!modal) return;
    const { type, targets, targetMode } = modal;
    
    if (type === "confirm_delete") {
      const deleteEmails = getActionableEmails(targets, targetMode);
      applyDeleteToIds(deleteEmails.map((e: any) => e.id));
      if (targetMode === "chat" && targets.includes(selectedSender)) setSelectedSender(null);
    }
    else if (type === "confirm_move") {
      let emailsToMove = getActionableEmails(targets, targetMode);
      
      if (moveDestination === "SPAM" || moveDestination === "ARCHIVE") {
        emailsToMove = emailsToMove.filter(e => !e.isMe && !e.labelIds?.includes("SENT"));
      }
      
      const idsToMove = emailsToMove.filter(e => !e.labelIds?.includes(moveDestination!)).map(e => e.id);
      
      if (idsToMove.length > 0) {
        try {
          const applyNewLabels = (e: any) => {
            if (idsToMove.includes(e.id)) { 
              let newLabels = (e.labelIds || []).filter((l: string) => l !== "INBOX" && l !== "TRASH" && l !== "SPAM"); 
              if (moveDestination !== "ARCHIVE") { 
                newLabels.push(moveDestination); 
              }
              return { ...e, labelIds: newLabels }; 
            }
            return e;
          };
          
          const nextEmails = emails.map(applyNewLabels);
          const nextPersisted = persistedEmails.map(applyNewLabels);
          
          const combined = new Map();
          nextPersisted.forEach(e => combined.set(e.id, e));
          nextEmails.forEach(e => combined.set(e.id, e));
          
          const nextPMsgs = syncConfigs(Array.from(combined.values()), chatConfigsRef.current, messageConfigsRef.current);
          
          setEmails(nextEmails); 
          setPersistedEmails(nextPMsgs);
          setRevealedCrossPrompts(prev => prev.filter(id => !idsToMove.includes(id)));

          if (targetMode === "chat" && targets.includes(selectedSender)) setSelectedSender(null);

          fetch("/api/emails", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "move", ids: idsToMove, destination: moveDestination === "ARCHIVE" ? undefined : moveDestination }) }).catch(e => console.error(e));
        } catch (e) { console.error(e); }
      }
    }
    else if (type === "confirm_hide") {
      if (targetMode === "msg") {
        applyHideToIds(targets);
      } else {
        (targets as RoomKeyStr[]).forEach(target => updateChatConfigByRoomKey(target, { isHidden: true, hiddenAtDate: new Date().toISOString() }));
        if (targets.includes(selectedSender)) setSelectedSender(null);
      }
    }
    else if (type === "confirm_reset") {
      const { pin, hide, name, crossBox } = resetOptions;
      // メッセージ単位の設定がどのroomに属するか（複合キーで返す）。roomIdが未設定の古いデータを
      // 救済するため、実メールデータから所属チャットを逆引きするフォールバックも残す
      const getMsgRoom = (stateKey: RoomKeyStr): RoomKeyStr | undefined => {
        const cfg = messageConfigs[stateKey];
        if (cfg?.roomId !== undefined) return cfg.roomId;
        const { accountEmail, localKey } = decodeRoomKey(stateKey);
        const email = allUniqueEmails.find((e: any) => e.id === localKey);
        if (!email) return undefined;
        const local = email.senderRoom || (email.from?.split("<")[0].replace(/"/g, "").trim() || "Unknown");
        return encodeRoomKey(accountEmail, asLocalKey(local));
      };

      let roomKeysToProcess = keysOf(chatConfigs);
      let msgKeysToProcess = keysOf(messageConfigs);
      if (targetMode === "current_chat") {
        roomKeysToProcess = roomKeysToProcess.filter(k => k === targets[0]);
        msgKeysToProcess = msgKeysToProcess.filter(k => getMsgRoom(k) === targets[0]);
      } else if (targetMode === "specific_chat") {
        roomKeysToProcess = roomKeysToProcess.filter(k => targets.includes(k));
        msgKeysToProcess = msgKeysToProcess.filter(k => targets.some((t: string) => getMsgRoom(k) === t));
      }

      roomKeysToProcess.forEach(target => {
        const updates: Partial<ChatConfig> = {};
        if (pin) { updates.isPinned = false; updates.forceFetch = false; updates.persistedData = null; }
        if (hide) { updates.isHidden = false; updates.hiddenAtDate = undefined; updates.unhideOnNew = false; }
        if (name) updates.customName = undefined;
        if (Object.keys(updates).length > 0) updateChatConfigByRoomKey(target, updates);
      });
      msgKeysToProcess.forEach(stateKey => {
        const currentConfig = messageConfigs[stateKey]; const updates: Partial<MessageConfig> = {};
        // roomId欠落を検知したらここで書き戻し、次回以降のリセットで漏れないよう自己修復する
        if (currentConfig?.roomId === undefined) {
          const resolvedRoom = getMsgRoom(stateKey);
          if (resolvedRoom !== undefined) updates.roomId = resolvedRoom;
        }
        if (pin) { updates.isPinned = false; updates.forceFetch = false; updates.persistedData = null; }
        if (hide) { updates.isHidden = false; updates.hiddenAtDate = undefined; updates.unhideOnNew = false; }
        if (Object.keys(updates).length > 0) {
          const { accountEmail, localKey } = decodeRoomKey(stateKey);
          updateMessageConfig(localKey, updates, accountEmail);
        }
      });

      // persistedEmails/revealedCrossPromptsとの突き合わせは、e.id・e.senderRoomが常にローカルキー
      // （アカウント内の生の識別子）であるのに対し、roomKeysToProcess/msgKeysToProcessは複合キーのため、
      // ローカルキーに変換してから比較する
      const localRoomKeys = roomKeysToProcess.map(k => decodeRoomKey(k).localKey);
      const localMsgIds = msgKeysToProcess.map(k => decodeRoomKey(k).localKey);
      if (pin) setPersistedEmails(prev => prev.filter(e => !localMsgIds.includes(e.id as LocalKey) && !(e.senderRoom && localRoomKeys.includes(e.senderRoom as LocalKey))));

      // 他の場所の読み込みリセット: メールを消さずに revealedCrossPrompts を消してボタンに戻す
      if (crossBox) {
        const affectedSenders = new Set(localRoomKeys);
        setRevealedCrossPrompts((prev: string[]) => prev.filter(id => {
          const email = emailsRef.current.find((e: any) => e.id === id);
          if (!email) return false;
          const room = email.senderRoom || (email.from?.split("<")[0].replace(/"/g, "").trim() || "Unknown");
          if (!affectedSenders.has(room as LocalKey)) return true;
          const isTrash = email.labelIds?.includes("TRASH");
          const isSpam  = email.labelIds?.includes("SPAM");
          const isInbox = email.labelIds?.includes("INBOX");
          const isSent  = email.labelIds?.includes("SENT") || email.isMe;
          const inFilter = isSent ? checkSent : (isTrash ? checkTrash : (isSpam ? checkSpam : (isInbox ? checkInbox : checkArchive)));
          return inFilter;
        }));
      }
    }
    else if (type === "confirm_unpin") {
      if (targetMode === "chat") {
        const chatTargets = targets as RoomKeyStr[];
        chatTargets.forEach(targetId => updateChatConfigByRoomKey(targetId, { isPinned: false, forceFetch: false, persistedData: null }));
        const localTargets = chatTargets.map(t => decodeRoomKey(t).localKey);
        setPersistedEmails(prev => prev.filter(e => !(e.senderRoom && localTargets.includes(e.senderRoom as LocalKey))));
      } else {
        (targets as string[]).forEach(targetId => updateMessageConfig(asLocalKey(targetId), { isPinned: false, forceFetch: false, persistedData: null }, resolveMessageAccountEmail(targetId)));
        setPersistedEmails(prev => prev.filter(e => !targets.includes(e.id)));
      }
    }
    else if (type === "confirm_unhide") {
      if (targetMode === "chat") {
        (targets as RoomKeyStr[]).forEach(target => updateChatConfigByRoomKey(target, { isHidden: false }));
      } else {
        (targets as string[]).forEach(target => updateMessageConfig(asLocalKey(target), { isHidden: false }, resolveMessageAccountEmail(target)));
      }
    }

    exitAfterAction();
  };

  // 場所ごとに異なる移動先へバッチ移動
  // 移動のコア処理。modal状態に依存せず exitAfterAction() も呼ばないため、
  // 継続フィルターの自動適用エンジン（バックグラウンド、モーダルもhistoryも関与しない）からも安全に呼べる
  const applyMoveToIds = (groups: { ids: string[], destination: string }[]) => {
    const allIds = groups.flatMap(g => g.ids);
    if (allIds.length === 0) return;

    const getDestForId = (id: string) => groups.find(g => g.ids.includes(id))?.destination;

    const applyNewLabels = (e: any) => {
      const dest = getDestForId(e.id);
      if (!dest) return e;
      const newLabels = (e.labelIds || []).filter((l: string) => l !== "INBOX" && l !== "TRASH" && l !== "SPAM");
      if (dest !== "ARCHIVE") newLabels.push(dest);
      return { ...e, labelIds: newLabels };
    };

    const nextEmails = emails.map(applyNewLabels);
    const nextPersisted = persistedEmails.map(applyNewLabels);
    const combined = new Map();
    nextPersisted.forEach((e: any) => combined.set(e.id, e));
    nextEmails.forEach((e: any) => combined.set(e.id, e));
    const nextPMsgs = syncConfigs(Array.from(combined.values()), chatConfigsRef.current, messageConfigsRef.current);

    setEmails(nextEmails);
    setPersistedEmails(nextPMsgs);
    setRevealedCrossPrompts((prev: string[]) => prev.filter(id => !allIds.includes(id)));

    groups.forEach(({ ids, destination }) => {
      if (ids.length === 0) return;
      fetch("/api/emails", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "move", ids, destination: destination === "ARCHIVE" ? undefined : destination })
      }).catch((e: any) => console.error(e));
    });
  };

  const executeBatchMove = async (groups: { ids: string[], destination: string }[]) => {
    applyMoveToIds(groups);
    exitAfterAction();
  };

  // 継続フィルター（非表示/ピン留め/移動/削除）の自動適用エンジン。
  // allUniqueEmails が更新される（新着メール取得・タブ復帰時の再取得など）たびに、各継続フィルターの
  // filterLastAppliedAt より新しい日時のメールだけを対象に、1回だけ自動的にアクションを適用する
  // （Gmail自身のフィルター機能と同じ考え方）。手動で元に戻した（非表示解除等）メッセージは
  // カットオフより古い日時のまま残るため、次回以降の自動走査で再び対象になることはない
  useEffect(() => {
    keysOf(chatConfigsRef.current).forEach(stateKey => {
      const cfg = chatConfigsRef.current[stateKey];
      if (!cfg?.filterAction || !cfg.filterContinuous || !cfg.filterCriteria) return;
      const { accountEmail, localKey } = decodeRoomKey(stateKey);
      const cutoff = new Date(cfg.filterLastAppliedAt || cfg.filterCreatedAt || 0).getTime();
      const newMatches = allUniqueEmails.filter((e: any) => {
        const t = new Date(e.date).getTime();
        return !isNaN(t) && t > cutoff && messageMatchesFilter(e, cfg.filterCriteria!, accountEmail);
      });
      if (newMatches.length === 0) return;
      const ids = newMatches.map((e: any) => e.id);
      if (cfg.filterAction === "hide") {
        applyHideToIds(ids);
      } else if (cfg.filterAction === "pin") {
        applyPinToIds(ids);
      } else if (cfg.filterAction === "move") {
        applyMoveToIds([{ ids, destination: cfg.filterDestination! }]);
      } else if (cfg.filterAction === "delete") {
        applyDeleteToIds(ids);
      }
      updateChatConfig(localKey, { filterLastAppliedAt: new Date().toISOString() }, accountEmail);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allUniqueEmails]);

  const handleLoadMoreChats = async () => {
    const liveTokens = currentNextPageTokensRef.current;
    const myEmail = session?.user?.email || "";
    const accountsToLoad = Object.keys(liveTokens).filter(a => liveTokens[a]);
    if (loadingMoreChatsRef.current || accountsToLoad.length === 0) {
        if (accountsToLoad.length === 0 && !chatStatusMessage) setChatStatusMessage("すべてのメールを読み込みました");
        return;
    }
    loadingMoreChatsRef.current = true;
    setIsLoadingMoreChats(true);
    setChatStatusMessage(null);

    try {
      let qParts = [];
      let useIncludeTrash = "false";

      if (checkTrash || checkSpam) { useIncludeTrash = "true"; }
      if (checkSent) { useIncludeTrash = "true"; }
      if (checkArchive) {
        if (!checkInbox) qParts.push("-in:inbox");
      } else {
        let orLabels = [];
        if (checkInbox) orLabels.push("in:inbox");
        if (checkSent) orLabels.push("from:me");
        if (checkSpam) orLabels.push("in:spam");
        if (checkTrash) orLabels.push("in:trash");
        if (orLabels.length > 0) qParts.push(`(${orLabels.join(" OR ")})`);
      }
      const baseQuery = qParts.join(" ").trim();

      // アカウントごとに独立したページトークンで、まだ続きがあるアカウント分だけ並行して1ページ取得する
      const results = await Promise.all(accountsToLoad.map(async (accountEmail) => {
        const params = new URLSearchParams({ maxResults: "100", q: baseQuery, includeTrash: useIncludeTrash, pageToken: liveTokens[accountEmail]! });
        if (accountEmail !== myEmail) params.append("accountEmail", accountEmail);
        params.append("_t", Date.now().toString());
        try {
          const res: Response = await fetch(`/api/emails?${params.toString()}`);
          if (!res.ok) return { accountEmail, ok: false, messages: [] as any[], nextToken: liveTokens[accountEmail] };
          const data: any = await res.json();
          return { accountEmail, ok: true, messages: (data.messages || []).map((m: any) => ({ ...m, accountId: accountEmail })), nextToken: data.nextPageToken || null };
        } catch {
          return { accountEmail, ok: false, messages: [] as any[], nextToken: liveTokens[accountEmail] };
        }
      }));

      const rawMessages = results.flatMap(r => r.messages);
      const nextTokens: Record<string, string | null> = { ...liveTokens };
      let anyOk = false;
      results.forEach(r => { if (r.ok) { anyOk = true; nextTokens[r.accountEmail] = r.nextToken; } });

      if (!anyOk) {
        setChatStatusMessage("メールが読み込めませんでした。");
        return;
      }

      if (rawMessages.length > 0) {
        setEmails(prev => {
          const map = new Map(prev.map((e: any) => [e.id, e]));
          rawMessages.forEach((m: any) => map.set(m.id, m));
          return Array.from(map.values());
        });
      }

      // tokenを更新→currentNextPageTokens変化→useEffectが次ページを判断
      setCurrentNextPageTokens(nextTokens);
      if (!Object.values(nextTokens).some(t => t)) setChatStatusMessage("すべてのメールを読み込みました");

    } catch (error) {
      setChatStatusMessage("エラーが発生しました。");
    } finally {
      setIsLoadingMoreChats(false);
      loadingMoreChatsRef.current = false;
    }
  };

  const handleLoadMoreMessage = async () => {
    if (loadingMoreMsgRef.current || chatNextPageToken?.startsWith("END")) {
        if (chatNextPageToken === "END_LIMIT") setMsgStatusMessage("re:mailの読み込み上限に達しました");
        else if (chatNextPageToken === "END_ALL") setMsgStatusMessage("すべてのメールを読み込みました");
        return;
    }
    loadingMoreMsgRef.current = true;
    setIsLoadingMore(true); 
    setMsgStatusMessage(null);
    
    const { accountEmail: loadMoreAccountEmail, localKey: loadMoreLocalKey } = decodeRoomKey(selectedSender!);
    const result = await fetchChatCrossbox(loadMoreLocalKey, loadMoreAccountEmail, true);
    
    if (result.nextToken === "END_LIMIT") {
        setMsgStatusMessage("re:mailの読み込み上限に達しました");
    } else if (result.nextToken === "END_ALL") {
        setMsgStatusMessage("すべてのメールを読み込みました");
    }
    
    setIsLoadingMore(false);
    loadingMoreMsgRef.current = false;
  };

  // field/fieldIndex: 同じメッセージ内に複数のハイライト箇所がある場合、
  // どのフィールド（件名/本文）の何番目（0始まり）にスクロールするか指定する（省略時は最初に見つかったmark）
  const scrollToMsg = (id: string, field?: "subject" | "body", fieldIndex?: number) => {
    // 読み込み直後は要素がまだDOMに反映されていない、あるいはレイアウトが確定していないことがあるため、
    // 2フレーム待ってから実行する（1フレームだけだとスクロール位置がずれてボタンを通り過ぎることがあった）
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const container = document.getElementById(`msg-${id}`);
        let target: Element | null | undefined = container;
        if (field !== undefined && fieldIndex !== undefined) {
          target = container?.querySelector(`mark[data-field="${field}"][data-match-index="${fieldIndex}"]`) || container?.querySelector("mark") || container;
        } else {
          target = container?.querySelector("mark") || container;
        }
        target?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    });
  };

  // 検索バー用: 現在開いているチャット内でキーワードに一致する「箇所」の一覧
  // （画面表示順＝時系列の古い順。groupedEmails自体は新しい順なので反転させる）
  // 同じメッセージ内に複数回キーワードが出現する場合、それぞれを別カウントの一致として扱う。
  // fieldIndex はそのフィールド（件名/本文）内での出現番号（0始まり）で、
  // HighlightText/BodyWithLinksが振るdata-match-indexと対応させる
  // 件名/本文のチェックボックス、および場所フィルター（受信箱/アーカイブ等）で絞り込む
  const findBarMatches = useMemo(() => {
    if (!findBarOpen || !selectedSender) return [];
    const kw = findBarKeyword.trim().toLowerCase();
    if (!kw || (!findBarSearchSubject && !findBarSearchBody)) return [];
    const msgs = groupedEmails[selectedSender] || [];
    const result: { id: string; field: "subject" | "body"; fieldIndex: number }[] = [];
    [...msgs].reverse().forEach((e: any) => {
      if (!findBarBoxFilter[getFindBarBoxKey(e)]) return;
      if (findBarSearchSubject) {
        const count = countOccurrences(e.subject || "", kw);
        for (let i = 0; i < count; i++) result.push({ id: e.id, field: "subject", fieldIndex: i });
      }
      if (findBarSearchBody) {
        const count = countOccurrences(e.body || "", kw);
        for (let i = 0; i < count; i++) result.push({ id: e.id, field: "body", fieldIndex: i });
      }
    });
    return result;
  }, [findBarOpen, findBarKeyword, selectedSender, groupedEmails, findBarSearchSubject, findBarSearchBody, findBarBoxFilter]);

  const goToFindMatch = (index: number) => {
    if (findBarMatches.length === 0) return;
    const wrapped = ((index % findBarMatches.length) + findBarMatches.length) % findBarMatches.length;
    setFindBarMatchIndex(wrapped);
    const target = findBarMatches[wrapped];
    // 現在のフィルターでは他の場所に隠れている可能性があるため、reveal 済み扱いにする
    setRevealedCrossPrompts(prev => prev.includes(target.id) ? prev : [...prev, target.id]);
    scrollToMsg(target.id, target.field, target.fieldIndex);
  };

  const goToNextFindMatch = () => {
    if (findBarMatchIndex === -1) goToFindMatch(0);
    else goToFindMatch(findBarMatchIndex + 1);
  };

  const goToPrevFindMatch = () => {
    if (findBarMatchIndex === -1) goToFindMatch(findBarMatches.length - 1);
    else goToFindMatch(findBarMatchIndex - 1);
  };

  const updateFindBarKeyword = (val: string) => {
    setFindBarKeyword(val);
    setFindBarMatchIndex(-1);
  };

  const setFindBarSearchSubject = (checked: boolean) => {
    setFindBarSearchSubjectState(checked);
    setFindBarMatchIndex(-1);
  };

  const setFindBarSearchBody = (checked: boolean) => {
    setFindBarSearchBodyState(checked);
    setFindBarMatchIndex(-1);
  };

  const setFindBarBox = (key: "inbox" | "archive" | "sent" | "spam" | "trash", checked: boolean) => {
    setFindBarBoxFilter(prev => ({ ...prev, [key]: checked }));
    setFindBarMatchIndex(-1);
  };

  const closeFindBar = () => {
    setFindBarOpen(false);
    setFindBarKeyword("");
    setFindBarMatchIndex(-1);
    if (hasPushedFindBarRef.current) {
      hasPushedFindBarRef.current = false;
      if (window.history.state?.action === "findbar") {
        window.history.back();
      }
    }
  };

  // メッセージ画面の検索ボタンから、モーダルを介さず直接検索バーを開く
  const openFindBar = () => {
    if (!selectedSender) return;
    setFindBarKeyword("");
    setFindBarMatchIndex(-1);
    setFindBarSearchSubjectState(true);
    setFindBarSearchBodyState(true);
    // 既存のチェックボックスとは非同期（別管理）だが、開いた時点の状態を初期値として引き継ぐ
    setFindBarBoxFilter({ inbox: checkInbox, archive: checkArchive, sent: checkSent, spam: checkSpam, trash: checkTrash });
    setFindBarOpen(true);
    if (typeof window !== "undefined" && window.history.state?.action !== "findbar") {
      window.history.pushState({ action: "findbar" }, "", window.location.href);
      hasPushedFindBarRef.current = true;
    }
  };

  // 検索モーダルの件名/本文タブから結果をクリックしたときのジャンプ処理。
  // 検索結果は既に読み込み済みのデータ（allUniqueEmails）から生成されているため、
  // jumpToReplyTarget と異なりGmailへの再取得は不要で、チャットを開いてメッセージ画面上部に
  // Ctrl+F風の検索バー（ハイライト・次/前の一致への移動）を表示する。
  //
  // 注意: モーダルを閉じる際、exitAfterAction()（内部で window.history.go(-N) を使う）は使わない。
  // go()/back() は非同期に処理されるため、その直後に同期的に pushState を重ねると、
  // go() が実行される頃には履歴の位置がずれてしまい、意図しないエントリ（検索バー用など）を
  // 消費してポップされてしまう（＝開いた直後に検索バーが消える不具合の原因だった）。
  // そのため、検索モーダル用のエントリはここで同期的に replaceState で上書きし、
  // go()/back() を一切使わずに済ませる。
  const jumpToSearchResult = (sender: RoomKeyStr, msgId: string, keyword: string, field: "subject" | "body") => {
    setModal(null);
    setSelectionMode("none");
    setSelectedIds([]);
    // 現在のフィルターでは他の場所（アーカイブ等）に隠れている可能性があるため、reveal 済み扱いにする
    setRevealedCrossPrompts(prev => prev.includes(msgId) ? prev : [...prev, msgId]);
    skipFindBarAutoCloseRef.current = true;
    // 検索モーダルで実際にクリックした結果（件名タブ/本文タブ）を検索バーにもそのまま引き継ぐ
    setFindBarSearchSubjectState(field === "subject");
    setFindBarSearchBodyState(field === "body");
    // 検索バー独自の場所フィルターは、ジャンプ先のメッセージを誤って除外しないよう全てONにリセットする
    // （検索モーダル側の場所フィルターは既に別に適用済みのため、ここでは絞り込みは引き継がない）
    setFindBarBoxFilter({ inbox: true, archive: true, sent: true, spam: true, trash: true });

    const cameFromModal = typeof window !== "undefined" && window.history.state?.action === "modal";
    // モバイルでは openChat 自身が {chat: sender} を積む。検索モーダルのエントリは
    // そのままそのチャット用エントリへ置き換える（新規に積まない）
    openChat(sender, { replaceHistory: cameFromModal });
    // デスクトップは openChat がチャット用の履歴操作をしないため、ここで検索モーダルの
    // エントリをそのまま検索バー用エントリへ置き換える
    if (!isMobile && cameFromModal) {
      window.history.replaceState({ action: "findbar" }, "", window.location.href);
      hasPushedFindBarRef.current = true;
    }
    // 検索モーダルの結果はメッセージ単位（そのメッセージ内の何番目の出現かは指定されない）なので、
    // 該当メッセージの中では先頭（0番目）の出現位置へスクロールする
    scrollToMsg(msgId, field, 0);

    const kw = keyword.trim().toLowerCase();
    const occurrences: { id: string }[] = [];
    [...(groupedEmails[sender] || [])].reverse().forEach((e: any) => {
      const count = countOccurrences(field === "subject" ? (e.subject || "") : (e.body || ""), kw);
      for (let i = 0; i < count; i++) occurrences.push({ id: e.id });
    });
    const idx = occurrences.findIndex((o) => o.id === msgId);

    setFindBarKeyword(keyword);
    setFindBarOpen(true);
    setFindBarMatchIndex(idx);

    if (isMobile) {
      // モバイルは openChat が積んだ {chat: sender} の上に、検索バー用エントリを新たに積む
      // （戻るボタンを押すと検索バーだけ閉じ、チャットは開いたままになる）
      window.history.pushState({ action: "findbar" }, "", window.location.href);
      hasPushedFindBarRef.current = true;
    } else if (!cameFromModal) {
      window.history.pushState({ action: "findbar" }, "", window.location.href);
      hasPushedFindBarRef.current = true;
    }
  };

  const showReplyNotFoundToast = () => {
    setReplyNotFoundToast(true);
    setTimeout(() => setReplyNotFoundToast(false), 2000);
  };

  // Discord風の返信チップをクリックしたときのジャンプ処理。
  // ①今のフィルターで表示中 → そのままスクロール
  // ②読み込み済みだが他の場所（アーカイブ等）にあり「〜が含まれています」のプロンプトになっている → そのボタンへスクロール
  // ③まだ読み込んでいない過去のメール、またはローカルのラベル情報が古い可能性がある場合 →
  //   Message-IDを指定してGmailに直接問い合わせ（rfc822msgid: 検索）、最新の状態で上書きする
  // ④見つからない（削除済み等） → 「このメールは存在しません」をトースト表示
  const jumpToReplyTarget = async (email: any) => {
    if (!selectedSender || isJumpingToReplyRef.current) return;
    const targetId = email.replyToId as string | undefined;
    const targetHeader = email.inReplyTo as string | undefined;
    if (!targetId && !targetHeader) return;

    const matches = (m: any) => (!!targetId && m.id === targetId) || (!!targetHeader && !!m.messageIdHeader && m.messageIdHeader === targetHeader);
    // 返信元は同じスレッド上のメッセージなので、返信メール自身と同じアカウントに属する
    const lookupAccountEmail = email.accountId || session?.user?.email || "";
    const lookupParams = new URLSearchParams({ lookupByMessageId: targetHeader || "" });
    if (lookupAccountEmail !== (session?.user?.email || "")) lookupParams.append("accountEmail", lookupAccountEmail);

    const already = emailsRef.current.find(matches);
    // 移動などの楽観的更新がこのメッセージに正しく反映されていない場合に備え、
    // 見つかった場合もすぐ確定させず、裏で最新状態を取得して上書きする（表示は先にスクロールする）
    if (already) { scrollToMsg(already.id); }

    if (!targetHeader) {
      if (!already) showReplyNotFoundToast();
      return;
    }

    if (already && !isJumpingToReplyRef.current) {
      // 既存表示は崩さず、裏で静かに最新情報へ更新するだけ（見つからなくてもトーストは出さない）
      fetch(`/api/emails?${lookupParams.toString()}`)
        .then(res => (res.ok ? res.json() : null))
        .then(data => {
          if (data?.found && data.email) {
            const taggedEmail = { ...data.email, accountId: lookupAccountEmail };
            setEmails(prev => {
              const idx = prev.findIndex(e => e.id === taggedEmail.id);
              if (idx === -1) return prev;
              const next = [...prev];
              next[idx] = taggedEmail;
              return next;
            });
          }
        })
        .catch(() => {});
      return;
    }

    isJumpingToReplyRef.current = true;
    try {
      const res = await fetch(`/api/emails?${lookupParams.toString()}`);
      const data = res.ok ? await res.json() : { found: false };
      if (data.found && data.email) {
        const taggedEmail = { ...data.email, accountId: lookupAccountEmail };
        setEmails(prev => {
          const idx = prev.findIndex(e => e.id === taggedEmail.id);
          if (idx === -1) return [...prev, taggedEmail];
          const next = [...prev];
          next[idx] = taggedEmail; // ローカルに古い情報が残っていた場合に備え、最新の内容で上書きする
          return next;
        });
        scrollToMsg(taggedEmail.id);
      } else {
        showReplyNotFoundToast();
      }
    } catch {
      showReplyNotFoundToast();
    } finally {
      isJumpingToReplyRef.current = false;
    }
  };

  // サイドバー: senderList や currentNextPageTokens が変化するたびに即座にチェック
  // → スクロールバーが出るまで（または全件読み込みまで）自動でチャットを追加読み込みする
  const hasMoreChatsToLoad = Object.values(currentNextPageTokens).some(t => t);
  useEffect(() => {
    if (isLoading || loadingMoreChatsRef.current || chatStatusMessage) return;
    if (!hasMoreChatsToLoad && senderList.length === 0) return;
    const asideEl = document.querySelector("aside > div.flex-1.overflow-y-auto");
    if (!asideEl) return;
    const { scrollHeight, clientHeight, scrollTop } = asideEl as HTMLElement;
    if (scrollHeight - Math.abs(scrollTop) - clientHeight < 100) {
      handleLoadMoreChats();
    }
  }, [isLoading, senderList, chatStatusMessage, hasMoreChatsToLoad, checkInbox, checkArchive, checkSpam, checkTrash, checkSent]);

  // メッセージスレッド: chatNextPageToken やメッセージ件数が変化するたびに即座にチェック
  // → スクロールバーが出るまで（または全件読み込みまで）自動でメッセージを追加読み込みする
  const currentChatLength = selectedSender ? (groupedEmails[selectedSender] || []).length : 0;
  useEffect(() => {
    if (loadingMoreMsgRef.current || msgStatusMessage || !chatNextPageToken || chatNextPageToken === "FIRST_PAGE" || chatNextPageToken.startsWith("END")) return;
    const mainEl = document.querySelector("main > div.flex-1.overflow-y-auto");
    if (!mainEl) return;
    const { scrollHeight, clientHeight, scrollTop } = mainEl as HTMLElement;
    if (scrollHeight - Math.abs(scrollTop) - clientHeight < 100) {
      handleLoadMoreMessage();
    }
  }, [chatNextPageToken, msgStatusMessage, currentChatLength, selectedSender]);

  const pinnedMsgsInChat = (checkInbox || checkArchive || checkSent) ? (groupedEmails[selectedSender!] || []).filter(e => messageConfigs[messageConfigKey(e.id)]?.isPinned && !e.labelIds?.includes("TRASH") && !e.labelIds?.includes("SPAM")) : [];

  return {
    auth: { session, status },
    state: {
      emails, persistedEmails, isLoading, selectedSender, chatConfigs, messageConfigs,
      isLoadingMore, checkInbox, checkArchive, checkSpam, checkTrash, checkSent,
      currentNextPageTokens, chatStatusMessage, msgStatusMessage, isLoadingMoreChats, linkedAccounts,
      replySubject, replyBody, isSending, replyToMessage,
      hasMouse, isMobile, selectionMode, selectedIds, modal, renameInput,
      resetOptions, moveDestination, revealedCrossPrompts, boxColors,
      chatCacheLimit,
      collapseLinesCount, expandedMsgIds, emailModal, attachmentModal,
      replyNotFoundToast, draftChats, activeChatTab,
      findBarOpen, findBarKeyword, findBarMatchIndex, findBarSearchSubject, findBarSearchBody, findBarBoxFilter,
    },
    actions: {
      setCheckInbox, setCheckArchive, setCheckSpam, setCheckTrash, setCheckSent, changeChatTab,
      setReplySubject, setReplyBody, setReplyToMessage, setSelectionMode, setSelectedIds, setModal, setRenameInput,
      setResetOptions, setMoveDestination, setRevealedCrossPrompts, updateChatConfig, setSelectedSender,
      handleMenuBarClick, handleBackgroundClick, toggleSelection,
      jumpToSearchResult, updateFindBarKeyword, goToNextFindMatch, goToPrevFindMatch, closeFindBar, openFindBar,
      setFindBarSearchSubject, setFindBarSearchBody, setFindBarBox,
      handleSend, executePin, executeConfirmedAction, applyPinToIds, applyDeleteToIds, applyMoveToIds, applyHideToIds,
      openChat, handleLoadMoreChats, handleLoadMoreMessage, safeBack, exitAfterAction, enterSelectionMode, executeBatchMove,
      setChatCacheLimit,
      openEmailModal, closeEmailModal, toggleMsgExpand,
      openAttachmentModal, closeAttachmentModal,
      jumpToReplyTarget, createOrOpenChat, createGroupChat, createFilterGroup, deleteChatConfig, forwardMessageTo,
      updateChatConfigByRoomKey, deleteChatConfigByRoomKey, messageConfigKey, roomLocalKey, roomAccountEmail,
      unlinkAccount,
    },
    computed: { allUniqueEmails, groupedEmails, senderList, hiddenChats, hiddenMsgs, pinnedMsgsInChat, contactDirectory, groupReplyPools, findBarMatches, emailRoomMap },
    refs: { touchTimer, hasPushedSelectRef, activeLoadRef, searchTimeoutRef }
  };
}

export type MailAppHook = ReturnType<typeof useMailApp>;