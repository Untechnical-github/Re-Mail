import { useSession, signOut } from "next-auth/react";
import { useState, useEffect, useMemo, useRef } from "react";
import localforage from "localforage";
import { ChatConfig, SelectionMode, ModalState } from "../types/mail";
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
  
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState("");
  const [checkInbox, setCheckInbox] = useState<boolean>(() => getSavedBoxSettings()?.inbox ?? true);
  const [checkArchive, setCheckArchive] = useState<boolean>(() => getSavedBoxSettings()?.archive ?? true);
  const [checkSpam, setCheckSpam] = useState<boolean>(() => getSavedBoxSettings()?.spam ?? false);
  const [checkTrash, setCheckTrash] = useState<boolean>(() => getSavedBoxSettings()?.trash ?? false);
  const [checkSent, setCheckSent] = useState<boolean>(() => getSavedBoxSettings()?.sent ?? false);
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
  const hasPushedSearchRef = useRef(false);
  const hasPushedSelectRef = useRef(false);
  const activeLoadRef = useRef<number>(0);
  const signingOutRef = useRef(false);
  const isInitialFilterRun = useRef(true); 
  const chatConfigsRef = useRef(chatConfigs);
  useEffect(() => { chatConfigsRef.current = chatConfigs; }, [chatConfigs]);

  const emailsRef = useRef(emails);
  useEffect(() => { emailsRef.current = emails; }, [emails]);

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
    const isDisplayable = (e: any) => {
      const isForceFetched = (checkInbox || checkArchive || checkSent) && (chatConfigs[e.id]?.forceFetch || (e.senderRoom && chatConfigs[e.senderRoom]?.forceFetch));
      if (isForceFetched) return true;

      if (searchKeyword) {
        const keywordLower = searchKeyword.toLowerCase();
        const matchesKeyword = e.subject?.toLowerCase().includes(keywordLower) || 
                               e.body?.toLowerCase().includes(keywordLower) || 
                               e.from?.toLowerCase().includes(keywordLower) ||
                               e.to?.toLowerCase().includes(keywordLower) ||
                               (e.senderRoom && e.senderRoom.toLowerCase().includes(keywordLower));
        if (!matchesKeyword) return false;
      }
      return true; 
    };

    persistedEmails.forEach(e => { if (isDisplayable(e)) map.set(e.id, e); });
    emails.forEach(e => { if (isDisplayable(e)) map.set(e.id, e); });
    return Array.from(map.values());
  }, [emails, persistedEmails, searchKeyword, checkInbox, checkArchive, checkSpam, checkTrash, checkSent, chatConfigs, revealedCrossPrompts]);

  const loadD1Configs = async (): Promise<{ limit?: number; inbox?: boolean; archive?: boolean; spam?: boolean; trash?: boolean } | null> => {
    let globalSettings: { limit?: number; inbox?: boolean; archive?: boolean; spam?: boolean; trash?: boolean } | null = null;
    try {
      const res = await fetch("/api/config");
      if (res.ok) {
        const data = await res.json();
        const formatted: Record<string, ChatConfig> = {};
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
          if (customNameVal && customNameVal.startsWith('{')) {
            try {
              const parsed = JSON.parse(customNameVal);
              customNameVal = parsed.name; forceFetchVal = parsed.forceFetch; pData = parsed.data; roomIdVal = parsed.roomId;
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
          formatted[c.chat_id] = { customName: customNameVal, isPinned: c.is_pinned === 1, isHidden: c.is_hidden === 1, hiddenAtDate: c.hidden_at_date || undefined, unhideOnNew: c.unhide_on_new === 1, forceFetch: forceFetchVal, persistedData: pData, roomId: roomIdVal };
        });
        setChatConfigs(formatted); setPersistedEmails(pMsgs);
      }
    } catch (e) { console.error(e); }
    return globalSettings;
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
    if (nextConfig.forceFetch || nextConfig.roomId) nameToSave = JSON.stringify({ name: nextConfig.customName, forceFetch: nextConfig.forceFetch, data: nextConfig.persistedData, roomId: nextConfig.roomId });
    try { await fetch("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: targetId, custom_name: nameToSave, is_pinned: nextConfig.isPinned, is_hidden: nextConfig.isHidden, hidden_at_date: nextConfig.hiddenAtDate, unhide_on_new: nextConfig.unhideOnNew }) }); } catch (e) { console.error(e); }
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
      if (!state || state.action !== "search") { setSearchKeyword(""); hasPushedSearchRef.current = false; } else { hasPushedSearchRef.current = true; }
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
          await loadD1Configs();

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
          
          const res = await fetchEmails(100, "", { inbox: initInbox, archive: initArchive, spam: initSpam, trash: initTrash, sent: initSent }, null, false, false, [], () => false, true);

          if (selectedSender && res.success) {
            // await せずに進むと、復元したチャットのメッセージがまだ senderList に
            // 反映される前に hasLoadedOnceRef が立ってしまい、「チャットが消えた」と
            // 誤判定されて selectedSender がクリアされてしまう（＝復元直後に一瞬だけ
            // 「チャットを選択してください」画面に戻ってしまう不具合の原因だった）
            await fetchChatCrossbox(selectedSender, false, res.emails);
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
      if (isLoadMore && chatNextPageToken?.startsWith("END")) {
        return { found: false, nextToken: chatNextPageToken };
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
      const tokenToUse = isLoadMore ? (chatNextPageToken === "FIRST_PAGE" ? null : chatNextPageToken) : null;
      if (tokenToUse) params.append("pageToken", tokenToUse);
      params.append("_t", Date.now().toString());

      const res = await fetch(`/api/emails?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        const validMessages = data.messages || [];
        let nextToken = data.nextPageToken || "END_ALL";
        if (!skipToken) setChatNextPageToken(nextToken);

        if (validMessages.length > 0) {
          setEmails(prev => {
            const map = new Map(prev.map(e => [e.id, e]));
            validMessages.forEach((m: any) => map.set(m.id, m));
            return Array.from(map.values());
          });
        }

        return { found: validMessages.length > 0, nextToken };
      }
    } catch(e) { console.error(e); }
    return { found: false, nextToken: isLoadMore ? chatNextPageToken : "FIRST_PAGE" };
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
      // 旧フィルターの状態をキャッシュに保存（検索中でなければ）
      if (!searchKeyword) {
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

        // フィルター切り替え（検索なし）かつキャッシュあり → 即復元
        const cached = !searchKeyword && isFilterChange ? filterCacheRef.current.get(newFilterKey) : null;
        if (cached) {
          if (!isCancelled) {
            setEmails(cached.emails);
            setCurrentNextPageToken(cached.currentNextPageToken);
            currentNextPageTokenRef.current = cached.currentNextPageToken;
            setChatStatusMessage(null);
            setIsLoading(false);
          }
          if (selectedSender && !isCancelled) {
            fetchChatCrossbox(selectedSender, false, cached.emails);
          }
        } else {
          if (!isCancelled) { setEmails([]); setChatStatusMessage(null); }
          const res = await fetchEmails(100, searchKeyword, { inbox: checkInbox, archive: checkArchive, spam: checkSpam, trash: checkTrash, sent: checkSent }, null, false, false, [], () => isCancelled, true);
          if (!isCancelled) setChatStatusMessage(null);
          if (selectedSender && !isCancelled && res.success) {
            fetchChatCrossbox(selectedSender, false, res.emails);
          }
        }
      }, searchKeyword ? 300 : 0);
    };
    handleFilterChange();
    return () => { isCancelled = true; if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current); };
  }, [checkInbox, checkArchive, checkSpam, checkTrash, checkSent, searchKeyword]);

  // フィルター変化時に選択をキャンセル
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
  }, [checkInbox, checkArchive, checkSpam, checkTrash, checkSent]);

  const handleSearchChange = (val: string) => {
    if (!searchKeyword && val && !hasPushedSearchRef.current) { window.history.pushState({ action: "search" }, ""); hasPushedSearchRef.current = true; } 
    else if (searchKeyword && !val && hasPushedSearchRef.current) { safeBack(); hasPushedSearchRef.current = false; return; }
    setSearchKeyword(val);
  };

  useEffect(() => {
    if (!session) return;
    const interval = setInterval(() => { 
      if (document.visibilityState === 'visible') { 
        fetchEmails(100, searchKeyword, { inbox: checkInbox, archive: checkArchive, spam: checkSpam, trash: checkTrash, sent: checkSent }, null, false, true, emailsRef.current, () => false, false); 
      }
    }, 60000);

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        if (emailsRef.current.length === 0) {
          fetchEmails(100, searchKeyword, { inbox: checkInbox, archive: checkArchive, spam: checkSpam, trash: checkTrash, sent: checkSent }, null, false, false, [], () => false, true);
        } else {
          fetchEmails(100, searchKeyword, { inbox: checkInbox, archive: checkArchive, spam: checkSpam, trash: checkTrash, sent: checkSent }, null, false, true, emailsRef.current, () => false, false);
        }
      }
    };
    const handleOnline = () => {
      fetchEmails(100, searchKeyword, { inbox: checkInbox, archive: checkArchive, spam: checkSpam, trash: checkTrash, sent: checkSent }, null, false, true, emailsRef.current, () => false, false);
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("online", handleOnline);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("online", handleOnline);
    };
  }, [session, searchKeyword, checkInbox, checkArchive, checkSpam, checkTrash, checkSent]);

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

    Object.keys(groups).forEach(sender => groups[sender].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()));
    return groups;
  }, [allUniqueEmails, session, chatConfigs]);


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

    return Object.keys(groupedEmails).filter((sender: string) => {
      const config = chatConfigs[sender];
      if (config?.isHidden) return false;

      const hasDisplayableEmail = groupedEmails[sender].some((e: any) => {
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
      const pinA = chatConfigs[a]?.isPinned ? 1 : 0;
      const pinB = chatConfigs[b]?.isPinned ? 1 : 0;
      if (pinA !== pinB) return pinB - pinA;
      
      const timeA = getLatestValidDate(a);
      const timeB = getLatestValidDate(b);
      return (isNaN(timeB) ? 0 : timeB) - (isNaN(timeA) ? 0 : timeA);
    });
  }, [groupedEmails, chatConfigs, checkSent, checkInbox, checkArchive, checkSpam, checkTrash, revealedCrossPrompts]);

  const hiddenChats = Object.keys(chatConfigs).filter(k => chatConfigs[k]?.isHidden && chatConfigs[k]?.roomId === undefined);
  const hiddenMsgs = Object.keys(chatConfigs).filter(k => chatConfigs[k]?.isHidden && chatConfigs[k]?.roomId !== undefined).map(id => allUniqueEmails.find(e => e.id === id) || { id, subject: "過去のメッセージ", date: new Date().toISOString() });

  // senderList からチャットが消えたら（フィルター変更・非表示化など）メッセージ画面を自動クローズ
  // ただし初回のメール取得が終わるまでは senderList が「まだ空なだけ」なので判定しない
  useEffect(() => {
    if (hasLoadedOnceRef.current && !isLoading && selectedSender && !senderList.includes(selectedSender)) {
      setSelectedSender(null);
      if (typeof window !== "undefined") {
        localStorage.removeItem("remail_selected_sender");
        localStorage.removeItem("remail_scroll_main");
      }
    }
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

  const openChat = async (sender: string) => {
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
    if (isMobile) window.history.pushState({ chat: sender }, '', `#chat`);

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
      await fetchChatCrossbox(sender, false);
    }
    // 追加読み込みはuseEffectベースの自動トリガー（chatNextPageToken変化で発火）に委ねる
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
      setModal({ type: "confirm_pin", targetMode: targetMode as any, targets: [...selectedIds] });
    } else if (act === "unpin") {
      setModal({ type: "confirm_unpin", targetMode: targetMode as any, targets: [...selectedIds] });
    } else if (act === "hide") {
      if (targetMode === "chat") {
        setModal({ type: "confirm_hide", targetMode: "chat", targets: [...selectedIds] });
      } else {
        setModal({ type: "categorized_action_select", targetMode: "msg", targets: [...selectedIds], action: "hide" } as any);
      }
    } else if (act === "delete") {
      setModal({ type: "categorized_action_select", targetMode: targetMode as any, targets: [...selectedIds], action: "delete" } as any);
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
      const res = await fetch(`/api/emails?messageId=${email.id}&html=true`);
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
    setEmailModal(null);
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
    setAttachmentModal(null);
  };

  const toggleMsgExpand = (id: string) => {
    setExpandedMsgIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const handleSend = async () => {
    if (!selectedSender || !replyBody.trim()) return;
    setIsSending(true);
    try {
      const targetEmails = groupedEmails[selectedSender] || []; 
      const partnerEmail = targetEmails.find((e: any) => !e.isMe && !e.from.includes(session?.user?.email || ""));
      
      const actualTo = partnerEmail ? partnerEmail.from : (targetEmails[0]?.to || selectedSender);
      
      let finalBody = replyBody; let threadId = undefined; let finalSubject = replySubject;
      if (replyToMessage) { finalBody = `${replyBody}\n\n> ${replyToMessage.body.replace(/\n/g, "\n> ")}`; threadId = replyToMessage.threadId; if (!finalSubject) finalSubject = replyToMessage.subject.startsWith("Re:") ? replyToMessage.subject : `Re: ${replyToMessage.subject}`; }
      
      const res = await fetch("/api/emails", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "send", to: actualTo, subject: finalSubject, body: finalBody, threadId })
      });
      
      if (res.ok) {
        const sentFake = { 
          id: `fake-${Date.now()}`, 
          threadId: threadId || "", 
          subject: finalSubject || "(件名なし)", 
          from: session?.user?.email || "自分", 
          to: actualTo, 
          date: new Date().toUTCString(), 
          body: finalBody, 
          snippet: finalBody.slice(0, 60), 
          senderRoom: selectedSender, 
          isMe: true, 
          labelIds: ["SENT"]
        };
        setEmails([sentFake, ...emails]); setReplySubject(""); setReplyBody(""); setReplyToMessage(null);
      } else {
        const errData = await res.json().catch(() => ({}));
        console.error("Failed to send:", errData);
        alert("メールの送信に失敗しました。宛先が正しいか確認してください。");
      }
    } catch (error) { console.error(error); } finally { setIsSending(false); }
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
        if (found && !found.labelIds?.includes("TRASH") && !found.labelIds?.includes("SPAM") && !found.isMe) {
          const pData = { ...found, senderRoom: selectedSender };
          pMsgs.push(pData);
          updateChatConfig(targetId, { isPinned: true, forceFetch: true, persistedData: pData });
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
      if (targetMode === "current_chat") keysToProcess = keysToProcess.filter(k => k === targets[0] || chatConfigs[k]?.roomId === targets[0]);
      else if (targetMode === "specific_chat") keysToProcess = keysToProcess.filter(k => targets.includes(k) || targets.some((t: string) => chatConfigs[k]?.roomId === t));
      keysToProcess.forEach(target => {
        const currentConfig = chatConfigs[target]; const updates: Partial<ChatConfig> = {};
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
      if (searchKeyword) qParts.push(searchKeyword);
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
  }, [isLoading, senderList, chatStatusMessage, currentNextPageToken, checkInbox, checkArchive, checkSpam, checkTrash, checkSent, searchKeyword]);

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
      isLoadingMore, searchKeyword, checkInbox, checkArchive, checkSpam, checkTrash, checkSent,
      currentNextPageToken, chatStatusMessage, msgStatusMessage, isLoadingMoreChats,
      replySubject, replyBody, isSending, replyToMessage,
      hasMouse, isMobile, selectionMode, selectedIds, modal, renameInput,
      resetOptions, moveDestination, revealedCrossPrompts, boxColors,
      chatCacheLimit,
      collapseLinesCount, expandedMsgIds, emailModal, attachmentModal,
    },
    actions: {
      setSearchKeyword, setCheckInbox, setCheckArchive, setCheckSpam, setCheckTrash, setCheckSent,
      setReplySubject, setReplyBody, setReplyToMessage, setSelectionMode, setSelectedIds, setModal, setRenameInput,
      setResetOptions, setMoveDestination, setRevealedCrossPrompts, updateChatConfig, setSelectedSender,
      handleSearchChange, handleMenuBarClick, handleBackgroundClick, toggleSelection,
      handleSend, executePin, executeConfirmedAction,
      openChat, handleLoadMoreChats, handleLoadMoreMessage, safeBack, exitAfterAction, enterSelectionMode, executeBatchMove,
      setChatCacheLimit,
      openEmailModal, closeEmailModal, toggleMsgExpand,
      openAttachmentModal, closeAttachmentModal,
    },
    computed: { allUniqueEmails, groupedEmails, senderList, hiddenChats, hiddenMsgs, pinnedMsgsInChat },
    refs: { touchTimer, hasPushedSelectRef, hasPushedSearchRef, activeLoadRef, searchTimeoutRef }
  };
}

export type MailAppHook = ReturnType<typeof useMailApp>;