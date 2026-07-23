import { useSession, signOut } from "next-auth/react";
import { useState, useEffect, useMemo, useRef } from "react";
import localforage from "localforage";
import { ChatConfig, SelectionMode, ModalState, GroupMode } from "../types/mail";
import { getCachedAttachment, setCachedAttachment } from "../lib/attachmentCache";

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

// メールが自分の送信したものかどうかの判定。バックエンドが返す「生の」メールデータには
// isMe フィールドが元々存在せず、送信直後にローカルで作った表示用オブジェクトにだけ isMe:true を
// 付けている。そのオブジェクトが後から（60秒毎の自動更新や再取得で）生データに上書きされると
// isMe が失われるため、From に自分のアドレスが含まれるかどうかのフォールバックを必ず併用する
function isMineEmail(e: any, myEmail: string): boolean {
  return !!e.isMe || !!(myEmail && (e.from || "").includes(myEmail));
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

export function useMailApp() {
  const { data: session, status } = useSession();
  const [emails, setEmails] = useState<any[]>([]);
  const [persistedEmails, setPersistedEmails] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedSender, setSelectedSender] = useState<string | null>(() => {
    if (typeof window !== "undefined") {
      // リロードやタブを閉じても開いていたメッセージ画面を復元できるよう localStorage に保存する
      return localStorage.getItem("remail_selected_sender");
    }
    return null;
  });
  const [chatConfigs, setChatConfigs] = useState<Record<string, ChatConfig>>({});

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
  // 検索モーダルからメッセージへジャンプした際に、メッセージ画面上部に表示する
  // Ctrl+F風の検索バー（キーワードのハイライト・上下移動を兼ねる）
  const [findBarOpen, setFindBarOpen] = useState(false);
  const [findBarKeyword, setFindBarKeyword] = useState("");
  const [findBarMatchIndex, setFindBarMatchIndex] = useState(-1);
  const skipFindBarAutoCloseRef = useRef(false);
  const hasPushedFindBarRef = useRef(false);
  const [checkInbox, setCheckInbox] = useState<boolean>(() => getSavedBoxSettings()?.inbox ?? true);
  const [checkArchive, setCheckArchive] = useState<boolean>(() => getSavedBoxSettings()?.archive ?? true);
  const [checkSpam, setCheckSpam] = useState<boolean>(() => getSavedBoxSettings()?.spam ?? false);
  const [checkTrash, setCheckTrash] = useState<boolean>(() => getSavedBoxSettings()?.trash ?? false);
  const [checkSent, setCheckSent] = useState<boolean>(() => getSavedBoxSettings()?.sent ?? false);
  // チャット画面のタブ（個人チャット / グループチャット）。フィルターのチェックボックスと同様、
  // この端末のブラウザにだけ保存する（D1には保存しない＝他の端末には同期されない）ので、
  // リロード・タブを閉じる・ログアウトをまたいでも維持されるが、別端末には影響しない
  const [activeChatTab, setActiveChatTab] = useState<"individual" | "group">(() => {
    if (typeof window === "undefined") return "individual";
    return localStorage.getItem("remail_active_chat_tab") === "group" ? "group" : "individual";
  });
  useEffect(() => {
    if (typeof window !== "undefined") localStorage.setItem("remail_active_chat_tab", activeChatTab);
  }, [activeChatTab]);
  const [currentNextPageToken, setCurrentNextPageToken] = useState<string | null>(null);
  
  const [chatNextPageToken, setChatNextPageToken] = useState<string | null>("FIRST_PAGE");
  
  const [chatStatusMessage, setChatStatusMessage] = useState<string | null>(null);
  const [msgStatusMessage, setMsgStatusMessage] = useState<string | null>(null);
  const [isLoadingMoreChats, setIsLoadingMoreChats] = useState(false);

  const loadingMoreChatsRef = useRef(false);
  const loadingMoreMsgRef = useRef(false);
  const currentNextPageTokenRef = useRef<string | null>(null);

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
  useEffect(() => { currentNextPageTokenRef.current = currentNextPageToken; }, [currentNextPageToken]);

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
  const chatCacheRef = useRef<Map<string, { emails: any[]; chatNextPageToken: string | null; lruTime: number }>>(new Map());
  const chatNextPageTokenRef = useRef<string | null>("FIRST_PAGE");
  useEffect(() => { chatNextPageTokenRef.current = chatNextPageToken; }, [chatNextPageToken]);

  // フィルター単位のキャッシュ（フィルター切り替え時に復元）
  const filterCacheRef = useRef<Map<string, { emails: any[]; currentNextPageToken: string | null }>>(new Map());
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
      if (asideEl) localStorage.setItem("remail_scroll_aside", asideEl.scrollTop.toString());
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
  }, [selectedSender, selectionMode, selectedIds, modal, renameInput, resetOptions, moveDestination, replySubject, replyBody, replyToMessage, emailModal, attachmentModal]);

  const allUniqueEmails = useMemo(() => {
    const map = new Map();
    persistedEmails.forEach(e => map.set(e.id, e));
    emails.forEach(e => map.set(e.id, e));
    return Array.from(map.values());
  }, [emails, persistedEmails]);

  const loadD1Configs = async (): Promise<{ globalSettings: { limit?: number; inbox?: boolean; archive?: boolean; spam?: boolean; trash?: boolean } | null; formatted: Record<string, ChatConfig> }> => {
    let globalSettings: { limit?: number; inbox?: boolean; archive?: boolean; spam?: boolean; trash?: boolean } | null = null;
    const formatted: Record<string, ChatConfig> = {};
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
          if (customNameVal && customNameVal.startsWith('{')) {
            try {
              const parsed = JSON.parse(customNameVal);
              customNameVal = parsed.name; forceFetchVal = parsed.forceFetch; pData = parsed.data; roomIdVal = parsed.roomId;
              isGroupVal = parsed.isGroup; groupMembersVal = parsed.groupMembers; groupModeVal = parsed.groupMode;
              groupMemberAddressesVal = parsed.groupMemberAddresses; groupHiddenMembersVal = parsed.groupHiddenMembers;
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
          formatted[c.chat_id] = { customName: customNameVal, isPinned: c.is_pinned === 1, isHidden: c.is_hidden === 1, hiddenAtDate: c.hidden_at_date || undefined, unhideOnNew: c.unhide_on_new === 1, forceFetch: forceFetchVal, persistedData: pData, roomId: roomIdVal, isGroup: isGroupVal, groupMembers: groupMembersVal, groupMemberAddresses: groupMemberAddressesVal, groupMode: groupModeVal, groupHiddenMembers: groupHiddenMembersVal };
        });
        setChatConfigs(formatted); setPersistedEmails(pMsgs);
      }
    } catch (e) { console.error(e); }
    return { globalSettings, formatted };
  };

  const saveGlobalSettings = async (inbox: boolean, archive: boolean, spam: boolean, trash: boolean, sent: boolean) => {
    if (typeof window !== "undefined") {
      localStorage.setItem("remail_box_settings", JSON.stringify({ inbox, archive, spam, trash, sent }));
    }
  };

  const updateChatConfig = async (targetId: string, updates: Partial<ChatConfig>) => {
    const nextConfig = { ...chatConfigsRef.current[targetId], ...updates };
    setChatConfigs(prev => ({ ...prev, [targetId]: nextConfig }));
    let nameToSave = nextConfig.customName || "";
    if (nextConfig.forceFetch || nextConfig.roomId || nextConfig.isGroup) {
      nameToSave = JSON.stringify({
        name: nextConfig.customName, forceFetch: nextConfig.forceFetch, data: nextConfig.persistedData, roomId: nextConfig.roomId,
        isGroup: nextConfig.isGroup, groupMembers: nextConfig.groupMembers, groupMemberAddresses: nextConfig.groupMemberAddresses, groupMode: nextConfig.groupMode,
        groupHiddenMembers: nextConfig.groupHiddenMembers,
      });
    }
    try { await fetch("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: targetId, custom_name: nameToSave, is_pinned: nextConfig.isPinned, is_hidden: nextConfig.isHidden, hidden_at_date: nextConfig.hiddenAtDate, unhide_on_new: nextConfig.unhideOnNew }) }); } catch (e) { console.error(e); }
  };

  // グループチャットの削除: 設定行そのものを消すだけで、メンバーの個別チャットや実際のメールには一切触れない
  const deleteChatConfig = async (targetId: string) => {
    // グループを削除する場合、そのグループの作成によって非表示にした個別チャットは表示に戻す
    const cfg = chatConfigsRef.current[targetId];
    if (cfg?.isGroup && cfg.groupHiddenMembers?.length) {
      cfg.groupHiddenMembers.forEach(member => {
        updateChatConfig(member, { isHidden: false });
      });
    }

    setChatConfigs(prev => {
      const next = { ...prev };
      delete next[targetId];
      return next;
    });
    // ピン留めされていた場合、ローカルにキャッシュしていたメッセージのコピーも消しておく
    // （D1側の行は削除で一括して消えるが、ローカルstateはそれとは別に残ってしまうため）
    setPersistedEmails(prev => prev.filter((e: any) => e.senderRoom !== targetId));
    if (selectedSender === targetId) {
      setSelectedSender(null);
      if (typeof window !== "undefined") {
        localStorage.removeItem("remail_selected_sender");
        localStorage.removeItem("remail_scroll_main");
      }
    }
    try { await fetch(`/api/config?chat_id=${encodeURIComponent(targetId)}`, { method: "DELETE" }); } catch (e) { console.error(e); }
  };

  const syncConfigs = (latestEmails: any[], currentConfigs: Record<string, ChatConfig>) => {
    const pMsgs: any[] = [];
    const updatesToD1: {id: string, updates: any}[] = [];

    Object.keys(currentConfigs).forEach(targetId => {
      const config = currentConfigs[targetId];
      let hasUpdate = false;
      let newConfig = { ...config };

      if (config?.isPinned) {
        const isMsgPin = config.roomId !== undefined;
        if (isMsgPin) {
          const msg = latestEmails.find(e => e.id === targetId);
          if (!msg || msg.labelIds?.includes("TRASH") || msg.labelIds?.includes("SPAM")) {
            newConfig.isPinned = false; newConfig.forceFetch = false; newConfig.persistedData = null; hasUpdate = true;
          } else if (config.forceFetch) {
            pMsgs.push({ ...msg, senderRoom: config.roomId });
          }
        } else {
          if (config.forceFetch) {
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
        }
      }

      if (config?.isHidden) {
        const isMsgHide = config.roomId !== undefined;
        if (isMsgHide) {
          const msg = latestEmails.find(e => e.id === targetId);
          if (!msg || msg.labelIds?.includes("TRASH") || msg.labelIds?.includes("SPAM")) {
            newConfig.isHidden = false; newConfig.hiddenAtDate = undefined; newConfig.roomId = undefined; hasUpdate = true;
          }
        } else {
          // unhideOnNew が有効な場合のみ、非表示日時より新しいメールがあれば自動解除
          if (config.unhideOnNew) {
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
        }
      }

      if (hasUpdate) updatesToD1.push({ id: targetId, updates: newConfig });
    });

    updatesToD1.forEach(u => updateChatConfig(u.id, u.updates));
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

  // リロード/タブ復元で selectedSender が localStorage から直接セットされた場合、
  // openChat() を経由していないため history に "#chat" が積まれていない。
  // その状態のままモバイルの戻るボタン(safeBack)を押すと history.state に
  // 何も入っていないため「チャット画面を閉じる」が発火せず、画面が固定されてしまう。
  // isMobile が確定した時点で history 側もチャットが開いている状態に揃えておく
  useEffect(() => {
    if (isMobile && selectedSender && window.location.hash !== '#chat') {
      window.history.pushState({ chat: selectedSender }, '', '#chat');
    }
  }, [isMobile]); // eslint-disable-line react-hooks/exhaustive-deps

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
        const asideScroll = localStorage.getItem("remail_scroll_aside");
        const asideEl = document.querySelector("aside > div.flex-1");
        if (asideScroll && asideEl) {
          asideEl.scrollTop = parseInt(asideScroll, 10);
        }
      }, 50);
    }
  }, [selectedSender, isMobile]);

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

      const params = new URLSearchParams({ maxResults: targetLimit.toString(), q: qParts.join(" ").trim(), includeTrash: useIncludeTrash });
      if (pageToken) params.append("pageToken", pageToken);
      
      params.append("_t", Date.now().toString());

      const res = await fetch(`/api/emails?${params.toString()}`);
      if (res.status === 401 || res.status === 403) {
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

      if (res.ok) {
        if (getIsCancelled()) return { success: false, emails: currentEmailsState };
        const data = await res.json();
        // res.json() 待機中に新しいフィルターへ切り替えられている可能性があるため再チェック。
        // ここで弾かないと、古いフィルターの結果が新しいフィルターの結果を上書きしてしまう
        if (getIsCancelled()) return { success: false, emails: currentEmailsState };
        const newMessages = data.messages || [];
        let updatedEmails;

        if (isInitLoad || currentEmailsState.length === 0) {
          const map = new Map(currentEmailsState.map(e => [e.id, e]));
          newMessages.forEach((m: any) => map.set(m.id, m));
          updatedEmails = Array.from(map.values()).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        } else if (isLoadMore) {
          updatedEmails = [...currentEmailsState, ...newMessages];
          const map = new Map(updatedEmails.map(e => [e.id, e]));
          updatedEmails = Array.from(map.values()).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        } else {
          const emailMap = new Map(currentEmailsState.map(e => [e.id, e]));
          newMessages.forEach((m: any) => emailMap.set(m.id, m));
          updatedEmails = Array.from(emailMap.values()).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        }
        
        const nextPMsgs = syncConfigs(updatedEmails, chatConfigsRef.current);
        setPersistedEmails(nextPMsgs);
        setEmails(updatedEmails);

        if (!isSilent || updatedEmails.length <= targetLimit) setCurrentNextPageToken(data.nextPageToken || null);
        return { success: true, emails: updatedEmails };
      }
      return { success: false, emails: currentEmailsState };
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
          const { formatted: loadedConfigs } = await loadD1Configs();

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
            if (restoredConfig?.isGroup) {
              // グループのルームキーはGmail検索語にならないため、メンバーごとに個別取得する
              await Promise.all((restoredConfig.groupMembers || []).map(m => fetchChatCrossbox(m, false, res.emails).catch(() => {})));
            } else {
              await fetchChatCrossbox(selectedSender, false, res.emails);
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
            const asideScroll = localStorage.getItem("remail_scroll_aside");
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

  const fetchChatCrossbox = async (sender: string, isLoadMore = false, knownEmails = emailsRef.current, skipToken = false) => {
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
      const tokenToUse = isLoadMore ? (chatNextPageTokenRef.current === "FIRST_PAGE" ? null : chatNextPageTokenRef.current) : null;
      if (tokenToUse) params.append("pageToken", tokenToUse);
      params.append("_t", Date.now().toString());

      const res = await fetch(`/api/emails?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        const validMessages = data.messages || [];
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
  const fetchCrossboxForRoom = async (room: string, knownEmails = emailsRef.current) => {
    const cfg = chatConfigsRef.current[room];
    if (cfg?.isGroup) {
      await Promise.all((cfg.groupMembers || []).map(m => fetchChatCrossbox(m, false, knownEmails).catch(() => {})));
    } else {
      await fetchChatCrossbox(room, false, knownEmails);
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
          currentNextPageToken: currentNextPageTokenRef.current,
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
            setCurrentNextPageToken(cached.currentNextPageToken);
            currentNextPageTokenRef.current = cached.currentNextPageToken;
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

  const groupedEmails = useMemo(() => {
    const groups: Record<string, any[]> = {};
    const tempSentEmails: any[] = [];
    allUniqueEmails.forEach((email) => {
      if (email.senderRoom) { if (!groups[email.senderRoom]) groups[email.senderRoom] = []; groups[email.senderRoom].push(email); return; }
      const isMe = email.isMe || email.from.includes(session?.user?.email || "");
      if (!isMe) {
        const roomName = email.from.split("<")[0].replace(/"/g, "").trim() || "Unknown";
        if (!groups[roomName]) groups[roomName] = []; groups[roomName].push(email);
      } else { tempSentEmails.push(email); }
    });

    tempSentEmails.forEach((email) => {
      // ★修正: 実行中メモリ上でも送信済みメールからINBOXを強制剥奪する
      if (email.labelIds?.includes("INBOX")) {
         email.labelIds = email.labelIds.filter((l: string) => l !== "INBOX");
      }
      const toClean = email.to ? email.to.toLowerCase() : "";
      let matchedRoom: string | null = null;
      for (const roomName of Object.keys(groups)) {
        const roomNameLower = roomName.toLowerCase();
        const partnerEmail = groups[roomName].find(e => !e.isMe && !e.from.includes(session?.user?.email || ""))?.from.toLowerCase() || "";
        const partnerAddr = (partnerEmail.match(/<([^>]+)>/) || [null, partnerEmail])[1]?.trim() || partnerEmail.trim();
        if ((roomNameLower && toClean.includes(roomNameLower)) || (partnerAddr && toClean.includes(partnerAddr))) { matchedRoom = roomName; break; }
      }
      if (matchedRoom) { groups[matchedRoom].push({ ...email, isMe: true }); } 
      else {
        let newRoomName = "Unknown";
        if (email.to) {
          const toMatch = email.to.split(",")[0]; 
          newRoomName = toMatch.split("<")[0].replace(/"/g, "").trim() || toMatch.replace(/[<>]/g, "").trim();
          if (!newRoomName) newRoomName = "Unknown";
        }
        if (!groups[newRoomName]) groups[newRoomName] = []; groups[newRoomName].push({ ...email, isMe: true });
      }
    });

    // まだ返信がなく表示名が分からないうちは「アドレスそのもの」がルームキーになるが、
    // 後から返信が来ると差出人の表示名で別のルームが作られてしまい、同じ相手なのに
    // チャットが2つに分裂する（過去に送信しただけのやり取りが宛先アドレス名義のまま
    // 取り残される）。表示名ルームが実在する場合は、アドレス名義のルームをそちらへ
    // 統合する（グループのルームキーは対象外）
    const emailLikeRoom = (room: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(room.trim());
    const resolveRoomPartnerAddr = (room: string): string => {
      const msgs = groups[room];
      if (!msgs || msgs.length === 0) return "";
      const partner = msgs.find((e: any) => !isMineEmail(e, session?.user?.email || ""));
      const raw = partner ? partner.from : (msgs.find((e: any) => e.to)?.to || "");
      const match = (raw || "").match(/<([^>]+)>/);
      return ((match ? match[1] : raw) || "").trim().toLowerCase();
    };
    Object.keys(groups).forEach(room => {
      if (!emailLikeRoom(room)) return;
      const addr = room.trim().toLowerCase();
      const displayRoom = Object.keys(groups).find(other =>
        other !== room && !emailLikeRoom(other) && !chatConfigs[other]?.isGroup && resolveRoomPartnerAddr(other) === addr
      );
      if (displayRoom) {
        const existingIds = new Set(groups[displayRoom].map((e: any) => e.id));
        groups[room].forEach((e: any) => { if (!existingIds.has(e.id)) { groups[displayRoom].push(e); existingIds.add(e.id); } });
        delete groups[room];
      }
    });

    // グループチャット: メンバーからの受信メールと、グループから送信したメールを集約する。
    // 送信メールの判定はDBに何も永続化せず、その都度「宛先セットがメンバー全員と完全一致するか」
    // だけで判定する（Gmail自身が持つToヘッダーの情報だけで完結するため、送信履歴が増えても
    // D1の容量やロード時間を圧迫しない）。一斉送信は1通のメールなので、各メンバー個別チャットにも
    // 同じメールを反映する。
    Object.keys(chatConfigs).forEach(room => {
      const cfg = chatConfigs[room];
      if (!cfg?.isGroup) return;
      const mode = cfg.groupMode || "normal";
      const members = cfg.groupMembers || [];
      const myEmail = session?.user?.email || "";
      const memberAddresses = resolveGroupMemberAddresses(cfg, groups, myEmail);

      // このグループから送信されたメール = 宛先セットがメンバー全員と完全一致する送信済みメール
      const sentViaGroup = allUniqueEmails.filter((e: any) => isMineEmail(e, myEmail) && sameAddressSet(parseAddressSet(e.to || ""), memberAddresses));

      // 一斉送信したメールを各メンバーの個別チャットにも反映する
      sentViaGroup.forEach((sentMsg: any) => {
        members.forEach((member: string) => {
          if (!groups[member]) groups[member] = [];
          if (!groups[member].some((e: any) => e.id === sentMsg.id)) groups[member].push(sentMsg);
        });
      });

      if (mode === "outbound_only") {
        groups[room] = sentViaGroup;
        return;
      }

      const received = allUniqueEmails.filter((e: any) => {
        if (isMineEmail(e, myEmail)) return false;
        const addrMatch = (e.from || "").match(/<([^>]+)>/);
        const addr = (addrMatch ? addrMatch[1] : e.from || "").trim().toLowerCase();
        return memberAddresses.has(addr);
      });

      if (mode === "inbound_only") {
        groups[room] = received;
      } else {
        const merged = [...received];
        const mergedIds = new Set(merged.map((e: any) => e.id));
        sentViaGroup.forEach((e: any) => { if (!mergedIds.has(e.id)) { merged.push(e); mergedIds.add(e.id); } });
        groups[room] = merged;
      }
    });

    Object.keys(groups).forEach(sender => groups[sender].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()));
    return groups;
  }, [allUniqueEmails, session, chatConfigs]);

  const groupedEmailsRef = useRef(groupedEmails);
  useEffect(() => { groupedEmailsRef.current = groupedEmails; }, [groupedEmails]);

  // ルーム内の相手メールアドレスを推定する（「作成」機能での重複チャット判定・検索に使用）
  const getRoomAddress = (room: string): string => {
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
    return Object.keys(groupedEmails)
      .filter(room => (groupedEmails[room] || []).length > 0 && !chatConfigs[room]?.isGroup)
      .map(room => ({
        room,
        label: chatConfigs[room]?.customName || room,
        address: getRoomAddress(room),
        latestDate: groupedEmails[room][0]?.date ? new Date(groupedEmails[room][0].date).getTime() : 0,
      }))
      .sort((a, b) => b.latestDate - a.latestDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupedEmails, chatConfigs, session]);

  // グループチャットの「返信先を選択」用プール: 表示モードに関わらず、
  // 自分がグループから送信したメール + メンバー全員からの受信メールを常に候補にする
  // （送信専用モードでもスレッドには出てこない相手の発言を選んで返信できるようにするため）
  const groupReplyPools = useMemo(() => {
    const pools: Record<string, any[]> = {};
    Object.keys(chatConfigs).forEach(room => {
      const cfg = chatConfigs[room];
      if (!cfg?.isGroup) return;
      const myEmail = session?.user?.email || "";
      const memberAddresses = resolveGroupMemberAddresses(cfg, groupedEmails, myEmail);
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
  const prevDraftCheckSenderRef = useRef<string | null>(selectedSender);
  useEffect(() => {
    const prev = prevDraftCheckSenderRef.current;
    if (prev && prev !== selectedSender && draftChatsRef.current.includes(prev)) {
      const stillEmpty = !groupedEmailsRef.current[prev] || groupedEmailsRef.current[prev].length === 0;
      if (stillEmpty) removeDraftChat(prev);
    }
    prevDraftCheckSenderRef.current = selectedSender;
  }, [selectedSender]);

  const senderList = useMemo<string[]>(() => {

    const getLatestValidDate = (sender: string): number => {
      const allEmails = groupedEmails[sender] || [];
      const config = chatConfigs[sender];
      
      const validEmails = allEmails.filter((e: any) => {
        const isTrash = e.labelIds?.includes("TRASH");
        const isSpam = e.labelIds?.includes("SPAM");
        const isInbox = e.labelIds?.includes("INBOX");
        const isSent = e.labelIds?.includes("SENT") || e.isMe; 
        const isArchive = !isTrash && !isSpam && !isInbox && !isSent; 

        if ((isInbox || isArchive || isSent) && (config?.isHidden || chatConfigs[e.id]?.isHidden)) return false;

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

    const allRoomKeys = Array.from(new Set([...Object.keys(groupedEmails), ...draftChats]));

    return allRoomKeys.filter((sender: string) => {
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

        if ((isInbox || isArchive || isSent) && (config?.isHidden || chatConfigs[e.id]?.isHidden)) return false;

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

    }).sort((a: string, b: string): number => {
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
  }, [groupedEmails, chatConfigs, checkSent, checkInbox, checkArchive, checkSpam, checkTrash, revealedCrossPrompts, draftChats]);

  const hiddenChats = Object.keys(chatConfigs).filter(k => chatConfigs[k]?.isHidden && chatConfigs[k]?.roomId === undefined);
  const hiddenMsgs = Object.keys(chatConfigs).filter(k => chatConfigs[k]?.isHidden && chatConfigs[k]?.roomId !== undefined).map(id => allUniqueEmails.find(e => e.id === id) || { id, subject: "過去のメッセージ", date: new Date().toISOString() });

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

  const openChat = async (sender: string, opts?: { replaceHistory?: boolean }) => {
    // 現在のチャットを LRU キャッシュに保存
    const prevSender = selectedSender;
    if (prevSender && prevSender !== sender && chatCacheLimitRef.current > 0) {
      const senderEmails = emailsRef.current.filter((e: any) => {
        if (e.senderRoom === prevSender) return true;
        const room = e.from?.split("<")[0].replace(/"/g, "").trim() || "Unknown";
        return room === prevSender || e.from?.includes(prevSender) || e.to?.includes(prevSender);
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
      if (asideEl) localStorage.setItem("remail_scroll_aside", asideEl.scrollTop.toString());
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
  const createOrOpenChat = async (identifier: string) => {
    const trimmed = identifier.trim();
    if (!trimmed) return;

    let existingRoom: string | null = null;
    if (groupedEmails[trimmed] && !chatConfigs[trimmed]?.isGroup) {
      existingRoom = trimmed;
    } else {
      const idLower = trimmed.toLowerCase();
      existingRoom = Object.keys(groupedEmails).find(room => !chatConfigs[room]?.isGroup && getRoomAddress(room) === idLower) || null;
    }

    if (existingRoom) {
      await openChat(existingRoom);
    } else {
      addDraftChat(trimmed);
      await openChat(trimmed);
    }
  };

  // 「作成」モーダルで複数の宛先を選んだ場合のグループチャット作成
  const createGroupChat = async (name: string, members: string[], memberAddresses: string[], mode: GroupMode, hideMemberIndividualChats: string[]) => {
    const groupRoom = `group:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    // グループ作成によって新たに非表示にするメンバーだけを記録する（既に非表示だったものは対象外。
    // グループ削除時にこの一覧の分だけ非表示を解除するため）
    const groupHiddenMembers = hideMemberIndividualChats.filter(
      member => groupedEmails[member] && !chatConfigsRef.current[member]?.isHidden
    );

    await updateChatConfig(groupRoom, {
      customName: name, isGroup: true, groupMembers: members, groupMemberAddresses: memberAddresses, groupMode: mode,
      groupHiddenMembers,
    });

    groupHiddenMembers.forEach(member => {
      // unhideOnNew は明示的に false にする（新着があっても自動で表示に戻らないようにするため）
      updateChatConfig(member, { isHidden: true, hiddenAtDate: new Date().toISOString(), unhideOnNew: false });
    });

    setSelectedSender(groupRoom);
    if (typeof window !== "undefined") {
      localStorage.setItem("remail_selected_sender", groupRoom);
      localStorage.removeItem("remail_scroll_main");
    }
    setReplyToMessage(null); setReplySubject(""); setReplyBody("");
    if (isMobile) window.history.pushState({ chat: groupRoom }, '', '#chat');

    // 各メンバーの過去のやり取りを読み込んでおく（作成直後からグループの内容が見えるように）
    await Promise.all(members.map(m => fetchChatCrossbox(m, false).catch(() => {})));
  };

  const enterSelectionMode = (type: "chat" | "msg", id: string) => {
    const mode: SelectionMode = type === "chat" ? "chat_select" : "msg_select";
    setSelectionMode(mode);
    setSelectedIds([id]);
    if (type === "chat") fetchChatCrossbox(id, false, emailsRef.current, true);
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
      if (targetMode === "chat" && selectedIds.every(id => chatConfigsRef.current[id]?.isGroup)) {
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
    if (isAdding && selectionMode.startsWith("chat_")) fetchChatCrossbox(id, false, emailsRef.current, true);
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
      const res = await fetch(`/api/emails?messageId=${email.id}&html=true&_t=${Date.now()}`);
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
    attachment: { filename: string; mimeType: string; size: number; attachmentId: string; messageId: string; cacheKey?: string },
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
      const res = await fetch(`/api/emails?messageId=${encodeURIComponent(attachment.messageId)}&attachmentId=${encodeURIComponent(attachment.attachmentId)}`);
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
    if (groupCfg?.isGroup && groupCfg.groupMode === "inbound_only") return; // 受信専用グループは送信不可
    setIsSending(true);
    try {
      let actualTo: string;
      if (groupCfg?.isGroup) {
        // グループチャット: メンバー全員へ1通のメールとして一斉送信する
        actualTo = Array.from(resolveGroupMemberAddresses(groupCfg, groupedEmails, session?.user?.email || "")).join(", ");
      } else {
        const targetEmails = groupedEmails[selectedSender] || [];
        const partnerEmail = targetEmails.find((e: any) => !e.isMe && !e.from.includes(session?.user?.email || ""));
        actualTo = partnerEmail ? partnerEmail.from : (targetEmails[0]?.to || selectedSender);
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
        body: JSON.stringify({ action: "send", to: actualTo, subject: finalSubject, body: bodyToSend, threadId, inReplyTo })
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
          from: session?.user?.email || "自分",
          to: actualTo,
          date: new Date().toUTCString(),
          body: finalBody,
          snippet: finalBody.slice(0, 60),
          senderRoom: selectedSender,
          isMe: true,
          labelIds: ["SENT"],
          inReplyTo: replyToMessage?.messageIdHeader,
          replyToId: replyToMessage?.id,
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
    const addresses = recipientIds
      .map((id: string) => (groupedEmails[id] ? getRoomAddress(id) : id.trim().toLowerCase()))
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
        const htmlRes = await fetch(`/api/emails?messageId=${encodeURIComponent(message.id)}&html=true&_t=${Date.now()}`);
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
        body: JSON.stringify({ action: "send", to, subject, body: bodyText, bodyHtml }),
      });

      if (!res.ok) {
        console.error("Failed to forward:", await res.json().catch(() => ({})));
        alert("メールの転送に失敗しました。宛先が正しいか確認してください。");
        return;
      }

      const sentData = await res.json().catch(() => ({} as any));
      // 転送先が既存の個別チャット1件だけの場合は、そのチャットにすぐ反映されるようローカルにも追加する
      // （複数宛先やグループ・新規アドレスの場合は、対応する単一のルームが存在しないため追加しない）
      if (recipientIds.length === 1 && groupedEmails[recipientIds[0]] && !chatConfigsRef.current[recipientIds[0]]?.isGroup) {
        const room = recipientIds[0];
        const sentFake = {
          id: sentData.id || `fake-${Date.now()}`,
          threadId: sentData.threadId || "",
          subject, from: session?.user?.email || "自分", to,
          date: new Date().toUTCString(), body: bodyText, snippet: bodyText.slice(0, 60),
          senderRoom: room, isMe: true, labelIds: ["SENT"],
        };
        setEmails(prev => [sentFake, ...prev]);
      }
    } catch (e) {
      console.error(e);
      alert("メールの転送に失敗しました。宛先が正しいか確認してください。");
    }
  };

  const executePin = () => {
    if (!modal) return;
    const isChatMode = modal.targetMode === "chat";
    const pMsgs = [...persistedEmails];

    if (isChatMode) {
      // チャットピン留め: 常に永続読み込み、上限10件
      const existingForcePinned = Object.keys(chatConfigs).filter(k =>
        !chatConfigs[k]?.roomId && chatConfigs[k]?.isPinned && chatConfigs[k]?.forceFetch
      );
      const newToPin = modal.targets.filter((t: string) => !existingForcePinned.includes(t));
      if (existingForcePinned.length + newToPin.length > 10) return;

      modal.targets.forEach((targetId: string) => {
        const pData = (groupedEmails[targetId] || []).map((e: any) => ({ ...e, senderRoom: targetId }));
        pMsgs.push(...pData);
        updateChatConfig(targetId, { isPinned: true, forceFetch: true, persistedData: pData });
      });
    } else {
      // メッセージピン留め: 常に永続読み込み、合計上限100件
      const existingPinnedMsgCount = Object.keys(chatConfigs).filter(k =>
        chatConfigs[k]?.roomId && chatConfigs[k]?.isPinned && chatConfigs[k]?.forceFetch
      ).length;
      if (existingPinnedMsgCount + modal.targets.length > 100) return;

      modal.targets.forEach((targetId: string) => {
        const found = allUniqueEmails.find((e: any) => e.id === targetId);
        if (found && !found.labelIds?.includes("TRASH") && !found.labelIds?.includes("SPAM")) {
          const pData = { ...found, senderRoom: selectedSender };
          pMsgs.push(pData);
          updateChatConfig(targetId, { isPinned: true, forceFetch: true, persistedData: pData, roomId: selectedSender! });
        }
      });
    }

    setPersistedEmails(pMsgs);
    exitAfterAction();
  };

  const getActionableEmails = (targets: string[], targetMode: string) => {
    let result: any[] = [];
    if (targetMode === "chat") {
      targets.forEach((chat: string) => {
        const chatEmails = groupedEmails[chat] || [];
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

  const executeConfirmedAction = async () => {
    if (!modal) return;
    const { type, targets, targetMode } = modal;
    
    if (type === "confirm_delete") {
      const deleteEmails = getActionableEmails(targets, targetMode);
      
      // ★修正: 完全削除(permanentIds)は廃止し、TRASH・SENT以外の「移動可能なメール」のみをゴミ箱へ移動させる
      const trashIds = deleteEmails.filter(e => !e.labelIds?.includes("TRASH") && !e.labelIds?.includes("SENT") && !e.isMe).map(e => e.id);

      if (trashIds.length > 0) {
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
          
          const nextPMsgs = syncConfigs(Array.from(combined.values()), chatConfigsRef.current);
          
          setEmails(nextEmails); 
          setPersistedEmails(nextPMsgs);
          setRevealedCrossPrompts(prev => prev.filter(id => !trashIds.includes(id)));

          if (targetMode === "chat" && targets.includes(selectedSender)) setSelectedSender(null);
          
          fetch("/api/emails", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "delete", trashIds }) }).catch(e => console.error(e));
        } catch (e) { console.error(e); }
      }
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
          
          const nextPMsgs = syncConfigs(Array.from(combined.values()), chatConfigsRef.current);
          
          setEmails(nextEmails); 
          setPersistedEmails(nextPMsgs);
          setRevealedCrossPrompts(prev => prev.filter(id => !idsToMove.includes(id)));

          if (targetMode === "chat" && targets.includes(selectedSender)) setSelectedSender(null);

          fetch("/api/emails", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "move", ids: idsToMove, destination: moveDestination === "ARCHIVE" ? undefined : moveDestination }) }).catch(e => console.error(e));
        } catch (e) { console.error(e); }
      }
    }
    else if (type === "confirm_hide") {
      targets.forEach(target => updateChatConfig(target, { isHidden: true, hiddenAtDate: new Date().toISOString(), roomId: targetMode === "msg" ? selectedSender! : undefined }));
      if (targetMode === "chat" && targets.includes(selectedSender)) setSelectedSender(null);
    }
    else if (type === "confirm_reset") {
      const { pin, hide, name, crossBox } = resetOptions; let keysToProcess = Object.keys(chatConfigs);
      // roomIdが未設定の古いメッセージ設定を救済するため、実メールデータから所属チャットを逆引きする
      const getKeyRoom = (k: string) => {
        const cfg = chatConfigs[k];
        if (cfg?.roomId !== undefined) return cfg.roomId;
        const email = allUniqueEmails.find((e: any) => e.id === k);
        return email ? (email.senderRoom || (email.from?.split("<")[0].replace(/"/g, "").trim() || "Unknown")) : undefined;
      };
      if (targetMode === "current_chat") keysToProcess = keysToProcess.filter(k => k === targets[0] || getKeyRoom(k) === targets[0]);
      else if (targetMode === "specific_chat") keysToProcess = keysToProcess.filter(k => targets.includes(k) || targets.some((t: string) => getKeyRoom(k) === t));
      keysToProcess.forEach(target => {
        const currentConfig = chatConfigs[target]; const updates: Partial<ChatConfig> = {};
        // roomId欠落を検知したらここで書き戻し、次回以降のリセットで漏れないよう自己修復する
        if (currentConfig?.roomId === undefined) {
          const resolvedRoom = getKeyRoom(target);
          if (resolvedRoom !== undefined) updates.roomId = resolvedRoom;
        }
        if (pin) { updates.isPinned = false; updates.forceFetch = false; updates.persistedData = null; }
        if (hide) { updates.isHidden = false; updates.hiddenAtDate = undefined; updates.unhideOnNew = false; }
        if (name && currentConfig?.roomId === undefined) updates.customName = undefined;
        if (Object.keys(updates).length > 0) updateChatConfig(target, updates);
      });
      if (pin) setPersistedEmails(prev => prev.filter(e => !keysToProcess.includes(e.id) && !keysToProcess.includes(e.senderRoom)));

      // 他の場所の読み込みリセット: メールを消さずに revealedCrossPrompts を消してボタンに戻す
      if (crossBox) {
        const affectedSenders = new Set(keysToProcess.filter(k => !chatConfigs[k]?.roomId));
        setRevealedCrossPrompts((prev: string[]) => prev.filter(id => {
          const email = emailsRef.current.find((e: any) => e.id === id);
          if (!email) return false;
          const room = email.senderRoom || (email.from?.split("<")[0].replace(/"/g, "").trim() || "Unknown");
          if (!affectedSenders.has(room)) return true;
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
      targets.forEach((targetId: string) => {
        updateChatConfig(targetId, { isPinned: false, forceFetch: false, persistedData: null });
      });
      if (targetMode === "chat") {
        setPersistedEmails(prev => prev.filter(e => !targets.includes(e.senderRoom)));
      } else {
        setPersistedEmails(prev => prev.filter(e => !targets.includes(e.id)));
      }
    }
    else if (type === "confirm_unhide") { targets.forEach(target => updateChatConfig(target, { isHidden: false })); }

    exitAfterAction();
  };

  // 場所ごとに異なる移動先へバッチ移動
  const executeBatchMove = async (groups: { ids: string[], destination: string }[]) => {
    const allIds = groups.flatMap(g => g.ids);
    if (allIds.length === 0) { exitAfterAction(); return; }

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
    const nextPMsgs = syncConfigs(Array.from(combined.values()), chatConfigsRef.current);

    setEmails(nextEmails);
    setPersistedEmails(nextPMsgs);
    setRevealedCrossPrompts((prev: string[]) => prev.filter(id => !allIds.includes(id)));

    groups.forEach(({ ids, destination }) => {
      if (ids.length === 0) return;
      fetch("/api/emails", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "move", ids, destination: destination === "ARCHIVE" ? undefined : destination })
      }).catch((e: any) => console.error(e));
    });

    exitAfterAction();
  };


  const handleLoadMoreChats = async () => {
    const liveToken = currentNextPageTokenRef.current;
    if (loadingMoreChatsRef.current || !liveToken) {
        if (!liveToken && !chatStatusMessage) setChatStatusMessage("すべてのメールを読み込みました");
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

      // 右パネルと同じ: 1回のAPIコールで1ページ取得し、tokenを更新してuseEffectに次を委ねる
      const params = new URLSearchParams({ maxResults: "100", q: baseQuery, includeTrash: useIncludeTrash, pageToken: liveToken });
      params.append("_t", Date.now().toString());

      const res: Response = await fetch(`/api/emails?${params.toString()}`);
      if (!res.ok) {
        setChatStatusMessage("メールが読み込めませんでした。");
        return;
      }

      const data: any = await res.json();
      const rawMessages = data.messages || [];
      const nextToken: string | null = data.nextPageToken || null;

      if (rawMessages.length > 0) {
        setEmails(prev => {
          const map = new Map(prev.map((e: any) => [e.id, e]));
          rawMessages.forEach((m: any) => map.set(m.id, m));
          return Array.from(map.values());
        });
      }

      // tokenを更新→currentNextPageToken変化→useEffectが次ページを判断
      setCurrentNextPageToken(nextToken);
      if (!nextToken) setChatStatusMessage("すべてのメールを読み込みました");

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
    
    const result = await fetchChatCrossbox(selectedSender!, true);
    
    if (result.nextToken === "END_LIMIT") {
        setMsgStatusMessage("re:mailの読み込み上限に達しました");
    } else if (result.nextToken === "END_ALL") {
        setMsgStatusMessage("すべてのメールを読み込みました");
    }
    
    setIsLoadingMore(false);
    loadingMoreMsgRef.current = false;
  };

  const scrollToMsg = (id: string) => {
    // 読み込み直後は要素がまだDOMに反映されていない、あるいはレイアウトが確定していないことがあるため、
    // 2フレーム待ってから実行する（1フレームだけだとスクロール位置がずれてボタンを通り過ぎることがあった）
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document.getElementById(`msg-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    });
  };

  // 検索バー用: 現在開いているチャット内でキーワードに一致するメッセージ一覧
  // （画面表示順＝時系列の古い順。groupedEmails自体は新しい順なので反転させる）
  const findBarMatches = useMemo(() => {
    if (!findBarOpen || !selectedSender) return [];
    const kw = findBarKeyword.trim().toLowerCase();
    if (!kw) return [];
    const msgs = groupedEmails[selectedSender] || [];
    return [...msgs].reverse().filter((e: any) => (e.subject || "").toLowerCase().includes(kw) || (e.body || "").toLowerCase().includes(kw));
  }, [findBarOpen, findBarKeyword, selectedSender, groupedEmails]);

  const goToFindMatch = (index: number) => {
    if (findBarMatches.length === 0) return;
    const wrapped = ((index % findBarMatches.length) + findBarMatches.length) % findBarMatches.length;
    setFindBarMatchIndex(wrapped);
    const target = findBarMatches[wrapped];
    // 現在のフィルターでは他の場所に隠れている可能性があるため、reveal 済み扱いにする
    setRevealedCrossPrompts(prev => prev.includes(target.id) ? prev : [...prev, target.id]);
    scrollToMsg(target.id);
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
  const jumpToSearchResult = (sender: string, msgId: string, keyword: string) => {
    setModal(null);
    setSelectionMode("none");
    setSelectedIds([]);
    // 現在のフィルターでは他の場所（アーカイブ等）に隠れている可能性があるため、reveal 済み扱いにする
    setRevealedCrossPrompts(prev => prev.includes(msgId) ? prev : [...prev, msgId]);
    skipFindBarAutoCloseRef.current = true;

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
    scrollToMsg(msgId);

    const kw = keyword.trim().toLowerCase();
    const chronological = [...(groupedEmails[sender] || [])].reverse()
      .filter((e: any) => (e.subject || "").toLowerCase().includes(kw) || (e.body || "").toLowerCase().includes(kw));
    const idx = chronological.findIndex((e: any) => e.id === msgId);

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
      fetch(`/api/emails?lookupByMessageId=${encodeURIComponent(targetHeader)}`)
        .then(res => (res.ok ? res.json() : null))
        .then(data => {
          if (data?.found && data.email) {
            setEmails(prev => {
              const idx = prev.findIndex(e => e.id === data.email.id);
              if (idx === -1) return prev;
              const next = [...prev];
              next[idx] = data.email;
              return next;
            });
          }
        })
        .catch(() => {});
      return;
    }

    isJumpingToReplyRef.current = true;
    try {
      const res = await fetch(`/api/emails?lookupByMessageId=${encodeURIComponent(targetHeader)}`);
      const data = res.ok ? await res.json() : { found: false };
      if (data.found && data.email) {
        setEmails(prev => {
          const idx = prev.findIndex(e => e.id === data.email.id);
          if (idx === -1) return [...prev, data.email];
          const next = [...prev];
          next[idx] = data.email; // ローカルに古い情報が残っていた場合に備え、最新の内容で上書きする
          return next;
        });
        scrollToMsg(data.email.id);
      } else {
        showReplyNotFoundToast();
      }
    } catch {
      showReplyNotFoundToast();
    } finally {
      isJumpingToReplyRef.current = false;
    }
  };

  // サイドバー: senderList や currentNextPageToken が変化するたびに即座にチェック
  // → スクロールバーが出るまで（または全件読み込みまで）自動でチャットを追加読み込みする
  useEffect(() => {
    if (isLoading || loadingMoreChatsRef.current || chatStatusMessage) return;
    if (!currentNextPageToken && senderList.length === 0) return;
    const asideEl = document.querySelector("aside > div.flex-1.overflow-y-auto");
    if (!asideEl) return;
    const { scrollHeight, clientHeight, scrollTop } = asideEl as HTMLElement;
    if (scrollHeight - Math.abs(scrollTop) - clientHeight < 100) {
      handleLoadMoreChats();
    }
  }, [isLoading, senderList, chatStatusMessage, currentNextPageToken, checkInbox, checkArchive, checkSpam, checkTrash, checkSent]);

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

  const pinnedMsgsInChat = (checkInbox || checkArchive || checkSent) ? (groupedEmails[selectedSender!] || []).filter(e => chatConfigs[e.id]?.isPinned && !e.labelIds?.includes("TRASH") && !e.labelIds?.includes("SPAM")) : [];

  return {
    auth: { session, status },
    state: {
      emails, persistedEmails, isLoading, selectedSender, chatConfigs,
      isLoadingMore, checkInbox, checkArchive, checkSpam, checkTrash, checkSent,
      currentNextPageToken, chatStatusMessage, msgStatusMessage, isLoadingMoreChats,
      replySubject, replyBody, isSending, replyToMessage,
      hasMouse, isMobile, selectionMode, selectedIds, modal, renameInput,
      resetOptions, moveDestination, revealedCrossPrompts, boxColors,
      chatCacheLimit,
      collapseLinesCount, expandedMsgIds, emailModal, attachmentModal,
      replyNotFoundToast, draftChats, activeChatTab,
      findBarOpen, findBarKeyword, findBarMatchIndex,
    },
    actions: {
      setCheckInbox, setCheckArchive, setCheckSpam, setCheckTrash, setCheckSent, setActiveChatTab,
      setReplySubject, setReplyBody, setReplyToMessage, setSelectionMode, setSelectedIds, setModal, setRenameInput,
      setResetOptions, setMoveDestination, setRevealedCrossPrompts, updateChatConfig, setSelectedSender,
      handleMenuBarClick, handleBackgroundClick, toggleSelection,
      jumpToSearchResult, updateFindBarKeyword, goToNextFindMatch, goToPrevFindMatch, closeFindBar,
      handleSend, executePin, executeConfirmedAction,
      openChat, handleLoadMoreChats, handleLoadMoreMessage, safeBack, exitAfterAction, enterSelectionMode, executeBatchMove,
      setChatCacheLimit,
      openEmailModal, closeEmailModal, toggleMsgExpand,
      openAttachmentModal, closeAttachmentModal,
      jumpToReplyTarget, createOrOpenChat, createGroupChat, deleteChatConfig, forwardMessageTo,
    },
    computed: { allUniqueEmails, groupedEmails, senderList, hiddenChats, hiddenMsgs, pinnedMsgsInChat, contactDirectory, groupReplyPools, findBarMatches },
    refs: { touchTimer, hasPushedSelectRef, activeLoadRef, searchTimeoutRef }
  };
}

export type MailAppHook = ReturnType<typeof useMailApp>;