"use client";

import { useSession, signIn, signOut } from "next-auth/react";
import { useState, useEffect, useMemo, useRef } from "react";
import localforage from "localforage";

type ChatConfig = {
  customName?: string;
  isPinned?: boolean;
  isHidden?: boolean;
  hiddenAtDate?: string;
  unhideOnNew?: boolean;
  forceFetch?: boolean;
  persistedData?: any;
  roomId?: string;
};

type SelectionMode = "none" | "chat_hide" | "chat_delete" | "msg_hide" | "msg_delete" | "chat_pin" | "msg_pin" | "chat_reset" | "msg_reset";

type ContextMenuState = {
  type: "chat" | "msg";
  target: any;
  x: number;
  y: number;
} | null;

type ModalState = {
  type: "confirm_delete" | "confirm_hide" | "confirm_unhide" | "unhide_select" | "rename" | "confirm_pin" | "confirm_reset";
  targetMode: "chat" | "msg" | "all_chats" | "current_chat" | "specific_chat";
  targets: any[];
} | null;

// ★追加：検索キーワードをハイライト表示する極小コンポーネント
const HighlightText = ({ text, highlight }: { text: string, highlight: string }) => {
  if (!highlight) return <>{text}</>;
  const parts = text.split(new RegExp(`(${highlight})`, 'gi'));
  return (
    <>
      {parts.map((part, i) => 
        part.toLowerCase() === highlight.toLowerCase() 
          ? <mark key={i} className="bg-[#FEE75C] text-black font-bold px-0.5 rounded-sm">{part}</mark> 
          : part
      )}
    </>
  );
};

export default function Home() {
  const { data: session, status } = useSession();
  const [emails, setEmails] = useState<any[]>([]);
  const [persistedEmails, setPersistedEmails] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedSender, setSelectedSender] = useState<string | null>(null);
  const [chatConfigs, setChatConfigs] = useState<Record<string, ChatConfig>>({});

  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState("");
  const [checkInbox, setCheckInbox] = useState<boolean>(true);
  const [checkSpam, setCheckSpam] = useState<boolean>(false);
  const [checkTrash, setCheckTrash] = useState<boolean>(false);
  const [currentNextPageToken, setCurrentNextPageToken] = useState<string | null>(null);
  const [chatStatusMessage, setChatStatusMessage] = useState<string | null>(null);
  const [msgStatusMessage, setMsgStatusMessage] = useState<string | null>(null);
  const [isLoadingMoreChats, setIsLoadingMoreChats] = useState(false);

  const [replySubject, setReplySubject] = useState("");
  const [replyBody, setReplyBody] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [replyToMessage, setReplyToMessage] = useState<any | null>(null);

  const [hasMouse, setHasMouse] = useState(true);
  const [isMobile, setIsMobile] = useState(false);
  const [selectionMode, setSelectionMode] = useState<SelectionMode>("none");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [modal, setModal] = useState<ModalState>(null);
  const [renameInput, setRenameInput] = useState("");
  const touchTimer = useRef<NodeJS.Timeout | null>(null);
  const [resetOptions, setResetOptions] = useState({ pin: true, hide: true, name: true });
  // ★追加：クロスプロンプトで個別に「読み込む」を押したメールのIDを記録する
  const [revealedCrossPrompts, setRevealedCrossPrompts] = useState<string[]>([]);

  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const hasPushedSearchRef = useRef(false);
  const hasPushedSelectRef = useRef(false);
  const activeLoadRef = useRef<number>(0);

  const getCacheKey = (flags: { inbox: boolean; spam: boolean; trash: boolean }) => {
    return `remail_feed_cache_i${flags.inbox ? 1 : 0}s${flags.spam ? 1 : 0}t${flags.trash ? 1 : 0}`;
  };

  // ★改革：APIからどんなデータが混ざってきても、画面描画前に現在の条件で「絶対に弾く」最強フィルター
  const allUniqueEmails = useMemo(() => {
    const map = new Map();

    const isDisplayable = (e: any) => {
      // 1. 永続ピン留めされたデータは条件を無視して強制表示
      if (chatConfigs[e.id]?.forceFetch) return true;
      if (e.senderRoom && chatConfigs[e.senderRoom]?.forceFetch) return true;

      // 2. 検索キーワードの厳密フィルター
      if (searchKeyword) {
        const keywordLower = searchKeyword.toLowerCase();
        const matchesKeyword = e.subject?.toLowerCase().includes(keywordLower) || 
                               e.body?.toLowerCase().includes(keywordLower) || 
                               e.from?.toLowerCase().includes(keywordLower) ||
                               (e.senderRoom && e.senderRoom.toLowerCase().includes(keywordLower));
        if (!matchesKeyword) return false;
      }

      // 3. ボックス（受信箱/迷惑メール/ゴミ箱）の厳密フィルター
      const labels = e.labelIds || [];
      const isTrash = labels.includes("TRASH");
      const isSpam = labels.includes("SPAM");
      const isSent = labels.includes("SENT") || e.isMe;

      // クロスプロンプトとして「読み込みますか？」ボタンに変換されるメールは通過させる
      if (isSent && isTrash && !checkTrash && !revealedCrossPrompts.includes(e.id)) return true;
      if (isSent && !isTrash && checkTrash && !checkInbox && !revealedCrossPrompts.includes(e.id)) return true;
      
      // プロンプトを「読み込む」と許可したメールも通過させる
      if (revealedCrossPrompts.includes(e.id)) return true;

      // 現在のチェックボックスに合致しないものはここで完全に死滅する
      if (isTrash) return checkTrash;
      if (isSpam) return checkSpam;
      
      // 自分が送った通常のメール、相手から来た通常のメールは受信箱扱い
      return checkInbox;
    };

    persistedEmails.forEach(e => {
       if (isDisplayable(e)) map.set(e.id, e);
    });
    emails.forEach(e => {
       if (isDisplayable(e)) map.set(e.id, e);
    });
    
    return Array.from(map.values());
  }, [emails, persistedEmails, searchKeyword, checkInbox, checkSpam, checkTrash, chatConfigs, revealedCrossPrompts]);

  const loadD1Configs = async (): Promise<{ limit?: number; inbox?: boolean; spam?: boolean; trash?: boolean } | null> => {
    let globalSettings: { limit?: number; inbox?: boolean; spam?: boolean; trash?: boolean } | null = null;
    try {
      const res = await fetch("/api/config");
      if (res.ok) {
        const data = await res.json();
        const formatted: Record<string, ChatConfig> = {};
        const pMsgs: any[] = [];

        data.configs?.forEach((c: any) => {
          if (c.chat_id === "__GLOBAL_SETTINGS__" && c.custom_name) {
            try { globalSettings = JSON.parse(c.custom_name); } catch (e) {}
            return;
          }

          let customNameVal = c.custom_name || undefined;
          let forceFetchVal = false;
          let pData = null;
          let roomIdVal = undefined;

          if (customNameVal && customNameVal.startsWith('{')) {
            try {
              const parsed = JSON.parse(customNameVal);
              customNameVal = parsed.name;
              forceFetchVal = parsed.forceFetch;
              pData = parsed.data;
              roomIdVal = parsed.roomId;
              if (pData) {
                if (Array.isArray(pData)) pMsgs.push(...pData);
                else pMsgs.push(pData);
              }
            } catch (e) {}
          }

          formatted[c.chat_id] = {
            customName: customNameVal,
            isPinned: c.is_pinned === 1,
            isHidden: c.is_hidden === 1,
            hiddenAtDate: c.hidden_at_date || undefined,
            unhideOnNew: c.unhide_on_new === 1,
            forceFetch: forceFetchVal,
            persistedData: pData
          };
        });
        setChatConfigs(formatted);
        setPersistedEmails(pMsgs);
      }
    } catch (e) { console.error(e); }
    return globalSettings;
  };

  const saveGlobalSettings = async (inbox: boolean, spam: boolean, trash: boolean) => {
    try {
      await fetch("/api/config", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: "__GLOBAL_SETTINGS__", custom_name: JSON.stringify({ inbox, spam, trash }) })
      });
    } catch (e) { console.error(e); }
  };

  const updateChatConfig = async (targetId: string, updates: Partial<ChatConfig>) => {
    const nextConfig = { ...chatConfigs[targetId], ...updates };
    setChatConfigs(prev => ({ ...prev, [targetId]: nextConfig }));
    
    let nameToSave = nextConfig.customName || "";
    if (nextConfig.forceFetch || nextConfig.roomId) {
      nameToSave = JSON.stringify({ name: nextConfig.customName, forceFetch: nextConfig.forceFetch, data: nextConfig.persistedData, roomId: nextConfig.roomId });
    }

    try {
      await fetch("/api/config", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: targetId, custom_name: nameToSave,
          is_pinned: nextConfig.isPinned, is_hidden: nextConfig.isHidden,
          hidden_at_date: nextConfig.hiddenAtDate, unhide_on_new: nextConfig.unhideOnNew
        })
      });
    } catch (e) { console.error(e); }
  };

  useEffect(() => {
    const mediaQuery = window.matchMedia('(pointer: fine)');
    setHasMouse(mediaQuery.matches);
    const handler = (e: MediaQueryListEvent) => setHasMouse(e.matches);
    mediaQuery.addEventListener('change', handler);
    const resizeHandler = () => setIsMobile(window.innerWidth < 768);
    resizeHandler();
    window.addEventListener('resize', resizeHandler);
    
    const closeContextMenu = () => setContextMenu(null);
    window.addEventListener('click', closeContextMenu);
    
    return () => {
      mediaQuery.removeEventListener('change', handler);
      window.removeEventListener('resize', resizeHandler);
      window.removeEventListener('click', closeContextMenu);
    };
  }, []);

  useEffect(() => {
    const handlePopState = (e: PopStateEvent) => {
      const state = e.state;

      if (!state || state.action !== "select") {
        setSelectionMode("none");
        setSelectedIds([]);
        hasPushedSelectRef.current = false;
      } else {
        hasPushedSelectRef.current = true;
      }

      if (!state || state.action !== "search") {
        setSearchKeyword("");
        hasPushedSearchRef.current = false;
      } else {
        hasPushedSearchRef.current = true;
      }

      // ★修正：スマホ幅(768px未満)の時のみ、チャット画面を閉じる（PC版で戻るを押した時に勝手に閉じないようにする）
      if (window.innerWidth < 768 && window.location.hash !== '#chat') {
        setSelectedSender(null);
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    if (session) {
      const initLoad = async () => {
        try {
          setIsLoading(true);
          const settings = await loadD1Configs();
          const initInbox = settings?.inbox ?? true;
          const initSpam = settings?.spam ?? false;
          const initTrash = settings?.trash ?? false;
          
          setCheckInbox(initInbox); setCheckSpam(initSpam); setCheckTrash(initTrash);

          let snapshot: any = null;
          try { snapshot = await localforage.getItem(getCacheKey({ inbox: initInbox, spam: initSpam, trash: initTrash })); } catch (e) {}

          if (snapshot && snapshot.emails && snapshot.emails.length > 0) {
            setEmails(snapshot.emails);
          }

          await fetchEmails(100, "", { inbox: initInbox, spam: initSpam, trash: initTrash }, null, false, true);
        } catch (err) { console.error(err); } finally { setIsLoading(false); }
      };
      initLoad();
    }
  }, [session]);

  const fetchEmails = async (limit = 100, query = "", flags = { inbox: true, spam: false, trash: false }, pageToken: string | null = null, isLoadMore = false, isSilent = false, currentEmailsState = emails, getIsCancelled = () => false) => {
    if (!flags.inbox && !flags.spam && !flags.trash) { setEmails([]); if (!isSilent) setIsLoading(false); return false; }
    if (!isSilent) setIsLoading(true);
    
    const isCacheTarget = !query && !pageToken && !isLoadMore;
    const targetLimit = isCacheTarget ? 100 : limit;

    try {
      let qParts = []; let orLabels = [];
      if (flags.inbox) orLabels.push("in:inbox", "in:sent");
      if (flags.spam) orLabels.push("in:spam");
      if (flags.trash) orLabels.push("in:trash");
      if (orLabels.length > 0) qParts.push(`(${orLabels.join(" OR ")})`);
      if (query) qParts.push(query);

      const params = new URLSearchParams({ maxResults: targetLimit.toString(), q: qParts.join(" ").trim(), includeTrash: "true" });
      if (pageToken) params.append("pageToken", pageToken);

      if (currentEmailsState.length > 0) {
        // ★修正：検索中であっても無駄な再取得を防ぐため既知のIDを渡す
        const knownIds = currentEmailsState.slice(0, targetLimit).map(e => e.id).join(",");
        params.append("knownIds", knownIds);
      }

      const res = await fetch(`/api/emails?${params.toString()}`);
      if (res.ok) {
        if (getIsCancelled()) return false; // ★通信中にチェックボックスが切り替わっていたら、この結果は捨てる（絶対混ざらない）

        const data = await res.json();
        const newMessages = data.messages || [];
        const topIds = data.topIds || [];
        
        let updatedEmails;
        if (isLoadMore) {
          updatedEmails = [...currentEmailsState, ...newMessages];
        } else if (isCacheTarget && topIds.length > 0) {
          const emailMap = new Map(currentEmailsState.map(e => [e.id, e]));
          newMessages.forEach((m: any) => emailMap.set(m.id, m));
          const existingOldEmails = currentEmailsState.filter(e => !topIds.includes(e.id));
          updatedEmails = [...topIds.map((id: string) => emailMap.get(id)).filter(Boolean), ...existingOldEmails];
        } else {
          // ★修正：検索中などの場合、既存の検索結果に新着の検索結果をマージする（検索が消えるバグを解決）
          const emailMap = new Map(currentEmailsState.map(e => [e.id, e]));
          newMessages.forEach((m: any) => emailMap.set(m.id, m));
          updatedEmails = Array.from(emailMap.values());
        }
        
        setEmails(updatedEmails);
        
        if (!isSilent || updatedEmails.length <= targetLimit) {
           setCurrentNextPageToken(data.nextPageToken || null);
        }

        if (isCacheTarget) {
          const emailsToCache = updatedEmails.slice(0, 100);
          await localforage.setItem(getCacheKey(flags), { emails: emailsToCache, flags: flags });
        }
        return true;
      }
      return false;
    } catch (error) { console.error(error); return false; } finally { if (!isSilent && !getIsCancelled()) setIsLoading(false); }
  };

  useEffect(() => {
    if (!session) return;
    let isCancelled = false; 
    
    // ★ 追加：条件が切り替わった瞬間に世代IDをインクリメント（過去の非同期ループを過去の遺物にする）
    activeLoadRef.current += 1;

    const handleFilterChange = async () => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);

      searchTimeoutRef.current = setTimeout(async () => {
        await saveGlobalSettings(checkInbox, checkSpam, checkTrash);

        let loadedEmails = emails;
        
        // ★修正：検索キーワードが入力された瞬間は、他のボックスのキャッシュと混ざらないよう一旦画面を空にする
        if (searchKeyword) {
          loadedEmails = [];
          if (!isCancelled) setEmails([]);
        } else {
          let snapshot: any = null;
          try { snapshot = await localforage.getItem(getCacheKey({ inbox: checkInbox, spam: checkSpam, trash: checkTrash })); } catch (e) {}
          if (snapshot && snapshot.emails) {
            loadedEmails = snapshot.emails;
            if (!isCancelled) setEmails(loadedEmails);
          } else {
            loadedEmails = [];
            if (!isCancelled) setEmails([]);
          }
        }

        if (!isCancelled) setChatStatusMessage(null);
        await fetchEmails(100, searchKeyword, { inbox: checkInbox, spam: checkSpam, trash: checkTrash }, null, false, false, loadedEmails, () => isCancelled);
      }, searchKeyword ? 300 : 0);
    };

    handleFilterChange();

    return () => {
      isCancelled = true; // ★ユーザーが次の行動を起こした瞬間、実行中の通信をキャンセル扱いにする
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    };
  }, [checkInbox, checkSpam, checkTrash, searchKeyword]);

  const handleSearchChange = (val: string) => {
    if (!searchKeyword && val && !hasPushedSearchRef.current) {
      window.history.pushState({ action: "search" }, "");
      hasPushedSearchRef.current = true;
    } else if (searchKeyword && !val && hasPushedSearchRef.current) {
      window.history.back();
      hasPushedSearchRef.current = false;
      return;
    }
    setSearchKeyword(val);
  };

  useEffect(() => {
    if (!session) return;
    const interval = setInterval(() => {
      fetchEmails(100, searchKeyword, { inbox: checkInbox, spam: checkSpam, trash: checkTrash }, null, false, true);
    }, 60000);
    return () => clearInterval(interval);
  }, [session, searchKeyword, checkInbox, checkSpam, checkTrash]);

  const groupedEmails = useMemo(() => {
    const groups: Record<string, any[]> = {};
    const tempSentEmails: any[] = [];
    allUniqueEmails.forEach((email) => {
      if (chatConfigs[email.id]?.isHidden) return;
      if (email.senderRoom) {
        if (!groups[email.senderRoom]) groups[email.senderRoom] = [];
        groups[email.senderRoom].push(email);
        return;
      }
      const isMe = email.isMe || email.from.includes(session?.user?.email || "");
      if (!isMe) {
        const roomName = email.from.split("<")[0].replace(/"/g, "").trim() || "Unknown";
        if (!groups[roomName]) groups[roomName] = [];
        groups[roomName].push(email);
      } else {
        tempSentEmails.push(email);
      }
    });

    tempSentEmails.forEach((email) => {
      const toClean = email.to ? email.to.toLowerCase() : "";
      let matchedRoom: string | null = null;
      for (const roomName of Object.keys(groups)) {
        const roomNameLower = roomName.toLowerCase();
        const partnerEmail = groups[roomName].find(e => !e.isMe && !e.from.includes(session?.user?.email || ""))?.from.toLowerCase() || "";
        const partnerAddr = (partnerEmail.match(/<([^>]+)>/) || [null, partnerEmail])[1]?.trim() || partnerEmail.trim();
        if ((roomNameLower && toClean.includes(roomNameLower)) || (partnerAddr && toClean.includes(partnerAddr))) {
          matchedRoom = roomName; break;
        }
      }
      
      if (matchedRoom) {
        groups[matchedRoom].push({ ...email, isMe: true });
      } else {
        // ★ 修正：現在のボックス（受信箱/ゴミ箱など）に属していない送信済みメールは、独立したチャットを作らない
        const isTrashed = email.labelIds?.includes("TRASH");
        if (isTrashed && !checkTrash) return;
        if (!isTrashed && !checkInbox && checkTrash) return;

        let newRoomName = "Unknown";
        if (email.to) {
          const toMatch = email.to.split(",")[0]; 
          newRoomName = toMatch.split("<")[0].replace(/"/g, "").trim() || toMatch.replace(/[<>]/g, "").trim();
          if (!newRoomName) newRoomName = "Unknown";
        }
        if (!groups[newRoomName]) groups[newRoomName] = [];
        groups[newRoomName].push({ ...email, isMe: true });
      }
    });

    Object.keys(groups).forEach(sender => groups[sender].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()));
    return groups;
  }, [allUniqueEmails, session, chatConfigs]);

  const senderList = useMemo(() => {
    return Object.keys(groupedEmails).filter((sender) => {
      const config = chatConfigs[sender];
      if (!config?.isHidden) return true;
      if (config.unhideOnNew && config.hiddenAtDate && groupedEmails[sender][0]) {
        const latestTime = new Date(groupedEmails[sender][0].date).getTime();
        const hiddenTime = new Date(config.hiddenAtDate).getTime();
        if (latestTime > hiddenTime) { updateChatConfig(sender, { isHidden: false }); return true; }
      }
      return false;
    }).sort((a, b) => {
      const pinA = chatConfigs[a]?.isPinned ? 1 : 0;
      const pinB = chatConfigs[b]?.isPinned ? 1 : 0;
            if (pinA !== pinB) return pinB - pinA;
      const timeA = new Date(groupedEmails[a][0].date).getTime();
      const timeB = new Date(groupedEmails[b][0].date).getTime();
      return (isNaN(timeB) ? 0 : timeB) - (isNaN(timeA) ? 0 : timeA);
    });
  }, [groupedEmails, chatConfigs]);

  const hiddenChats = Object.keys(chatConfigs).filter(k => chatConfigs[k]?.isHidden && chatConfigs[k]?.roomId === undefined); 
  const hiddenMsgs = Object.keys(chatConfigs)
    .filter(k => chatConfigs[k]?.isHidden && chatConfigs[k]?.roomId !== undefined)
    .map(id => allUniqueEmails.find(e => e.id === id) || { id, subject: "過去のメッセージ(詳細取得待ち)", date: new Date().toISOString() });

  const openChat = (sender: string) => {
    setSelectedSender(sender);
    setSelectionMode("none");
    setSelectedIds([]);
    setReplyToMessage(null);
    setMsgStatusMessage(null); 
    if (isMobile) window.history.pushState({ chat: sender }, '', `#chat`);
  };

  const handleMenuBarClick = (mode: SelectionMode) => {
    if (mode === "chat_reset") {
      setResetOptions({ pin: true, hide: true, name: true });
      setModal({ type: "confirm_reset", targetMode: "all_chats", targets: [] });
      setSelectionMode("none");
      return;
    }
    if (mode === "msg_reset") {
      setResetOptions({ pin: true, hide: true, name: true });
      setModal({ type: "confirm_reset", targetMode: "current_chat", targets: [selectedSender!] });
      setSelectionMode("none");
      return;
    }

    if (selectionMode === mode) {
      if (selectedIds.length === 0) {
        window.history.back();
        return;
      }
      const targetMode = mode.startsWith("chat") ? "chat" : "msg";
      let actionType: any = "confirm_hide";
      if (mode.includes("delete")) actionType = "confirm_delete";
      if (mode.includes("pin")) actionType = "confirm_pin";
      
      setModal({ type: actionType, targetMode, targets: selectedIds });
      window.history.back(); 
    } else {
      setSelectionMode(mode);
      setSelectedIds([]);
      if (!hasPushedSelectRef.current) {
        window.history.pushState({ action: "select" }, "");
        hasPushedSelectRef.current = true;
      }
    }
  };

  const handleBackgroundClick = () => {
    if (selectionMode !== "none") {
      window.history.back();
    }
  };

  const toggleSelection = (id: string) => {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]);
  };

  const handleSend = async () => {
    if (!selectedSender || !replyBody.trim()) return;
    setIsSending(true);
    try {
      const targetEmails = groupedEmails[selectedSender];
      const actualTo = targetEmails ? targetEmails[0]?.from : selectedSender;
      let finalBody = replyBody; let threadId = undefined; let finalSubject = replySubject;
      if (replyToMessage) {
        finalBody = `${replyBody}\n\n> ${replyToMessage.body.replace(/\n/g, "\n> ")}`;
        threadId = replyToMessage.threadId;
        if (!finalSubject) finalSubject = replyToMessage.subject.startsWith("Re:") ? replyToMessage.subject : `Re: ${replyToMessage.subject}`;
      }
      const res = await fetch("/api/emails", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: actualTo, subject: finalSubject, body: finalBody, threadId })
      });
      if (res.ok) {
        const sentFake = {
          id: `fake-${Date.now()}`, threadId: threadId || "", subject: finalSubject || "(件名なし)",
          from: session?.user?.email || "自分", date: new Date().toUTCString(),
          body: finalBody, snippet: finalBody.slice(0, 60), senderRoom: selectedSender, isMe: true, labelIds: ["SENT"]
        };
        setEmails([sentFake, ...emails]); setReplySubject(""); setReplyBody(""); setReplyToMessage(null);
      }
    } catch (error) { console.error(error); } finally { setIsSending(false); }
  };

  const executePin = (forceFetch: boolean) => {
    if (!modal) return;
    const pMsgs = [...persistedEmails];
    modal.targets.forEach(targetId => {
        let pData = null;
        if (forceFetch) {
            if (modal.targetMode === "chat") {
                pData = (groupedEmails[targetId] || []).map(e => ({ ...e, senderRoom: targetId }));
                pMsgs.push(...pData);
            } else {
                const found = allUniqueEmails.find(e => e.id === targetId);
                if (found) {
                  pData = { ...found, senderRoom: selectedSender };
                  pMsgs.push(pData);
                }
            }
        }
        updateChatConfig(targetId, { isPinned: true, forceFetch, persistedData: pData });
    });
    setPersistedEmails(pMsgs);
    setModal(null);
    setSelectedIds([]);
  };

  const executeConfirmedAction = async () => {
    if (!modal) return;
    const { type, targets, targetMode } = modal;
    
    if (type === "confirm_delete") {
      let deleteIds: string[] = [];
      if (targetMode === "chat") {
        targets.forEach(chat => deleteIds.push(...(groupedEmails[chat]?.map(e => e.id) || [])));
      } else {
        deleteIds = targets;
      }
      if (deleteIds.length > 0) {
        try {
          await fetch("/api/emails", {
            method: "DELETE", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids: deleteIds })
          });
          setEmails(emails.filter(e => !deleteIds.includes(e.id)));
          setPersistedEmails(persistedEmails.filter(e => !deleteIds.includes(e.id)));
          if (targetMode === "chat" && targets.includes(selectedSender)) setSelectedSender(null);
        } catch (e) { console.error(e); }
      }
    } 
    else if (type === "confirm_hide") {
      targets.forEach(target => updateChatConfig(target, { 
        isHidden: true, 
        hiddenAtDate: new Date().toISOString(),
        roomId: targetMode === "msg" ? selectedSender! : undefined 
      }));
      if (targetMode === "chat" && targets.includes(selectedSender)) setSelectedSender(null);
    }
    else if (type === "confirm_reset") {
      const { pin, hide, name } = resetOptions;
      const specificTarget = targets[0]; 
      
      let keysToProcess = Object.keys(chatConfigs);

      if (targetMode === "current_chat" || targetMode === "specific_chat") {
         keysToProcess = keysToProcess.filter(k => k === specificTarget || chatConfigs[k]?.roomId === specificTarget);
      }

      keysToProcess.forEach(target => {
        const currentConfig = chatConfigs[target];
        const updates: Partial<ChatConfig> = {};

        if (pin) {
          updates.isPinned = false;
          updates.forceFetch = false;
          updates.persistedData = null;
        }
        if (hide) {
          updates.isHidden = false;
          updates.hiddenAtDate = undefined;
          updates.unhideOnNew = false;
        }
        if (name && currentConfig?.roomId === undefined) {
          updates.customName = undefined;
        }

        if (Object.keys(updates).length > 0) {
          updateChatConfig(target, updates);
        }
      });

      if (pin) {
        setPersistedEmails(prev => prev.filter(e => !keysToProcess.includes(e.id) && !keysToProcess.includes(e.senderRoom)));
      }
    }
    else if (type === "confirm_unhide") {
      targets.forEach(target => updateChatConfig(target, { isHidden: false }));
    }
    
    setModal(null);
    setSelectedIds([]);
  };

  const handleContextMenuAction = (action: string, target: any) => {
    setContextMenu(null);
    const mode = contextMenu?.type || "chat";
    const targetId = typeof target === "string" ? target : target.id;

    if (action === "hide") setModal({ type: "confirm_hide", targetMode: mode, targets: [targetId] });
    if (action === "delete") setModal({ type: "confirm_delete", targetMode: mode, targets: [targetId] });
    if (action === "pin") setModal({ type: "confirm_pin", targetMode: mode, targets: [targetId] });
    if (action === "unpin") {
      updateChatConfig(targetId, { isPinned: false, forceFetch: false, persistedData: null });
      setPersistedEmails(prev => prev.filter(e => e.id !== targetId && e.senderRoom !== targetId));
    }
    if (action === "reset") {
      setResetOptions({ pin: true, hide: true, name: true });
      setModal({ type: "confirm_reset", targetMode: "specific_chat", targets: [targetId] });
    }
    if (action === "rename") { setRenameInput(chatConfigs[targetId]?.customName || targetId); setModal({ type: "rename", targetMode: mode, targets: [targetId] }); }
    if (action === "reply") setReplyToMessage(target);
    if (action === "copy") navigator.clipboard.writeText(target.body);
    if (action === "forward") { setReplyBody(`【転送メッセージ】\n${target.body}`); setReplySubject("Fwd:"); }
  };

  if (status === "loading") return <div className="flex h-screen items-center justify-center bg-gray-100 text-gray-600">読み込み中...</div>;
  if (!session) return (
    <div className="flex h-screen flex-col items-center justify-center bg-[#313338] text-white">
      <h1 className="mb-8 text-5xl font-extrabold text-[#5865F2]">Re:Mail</h1>
      <button onClick={() => signIn("google")} className="rounded bg-[#5865F2] px-8 py-3 font-bold shadow transition hover:bg-[#4752C4] active:scale-95">Googleでログインして始める</button>
    </div>
  );

  const showChatList = !isMobile || !selectedSender;
  const showTalk = !isMobile || selectedSender;

  const pinnedMsgsInChat = (groupedEmails[selectedSender!] || []).filter(e => chatConfigs[e.id]?.isPinned);

  const handleLoadMoreChats = async () => {
    if (isLoadingMoreChats || !currentNextPageToken) {
      if (!currentNextPageToken) setChatStatusMessage("すべてのメールを読み込みました");
      return;
    }
    setIsLoadingMoreChats(true);
    setChatStatusMessage(null);

    let tempToken = currentNextPageToken;
    let hasNewSender = false;
    let loopCount = 0;
    const maxLoops = 5; 

    // ★ 追加：この関数が呼ばれた時の世代IDを記憶
    const currentLoadId = activeLoadRef.current;

    try {
      const currentSenders = new Set(Object.keys(groupedEmails));

      while (!hasNewSender && tempToken && loopCount < maxLoops) {
        // ★ 追加：ループの最中に条件が切り替わっていたら、即座にループを破棄して終了する
        if (activeLoadRef.current !== currentLoadId) break;

        loopCount++;
        let qParts = []; let orLabels = [];
        if (checkInbox) orLabels.push("in:inbox", "in:sent");
        if (checkSpam) orLabels.push("in:spam");
        if (checkTrash) orLabels.push("in:trash");
        if (orLabels.length > 0) qParts.push(`(${orLabels.join(" OR ")})`);
        if (searchKeyword) qParts.push(searchKeyword);

        const params = new URLSearchParams({ maxResults: "100", q: qParts.join(" ").trim(), includeTrash: "true", pageToken: tempToken });
        const res = await fetch(`/api/emails?${params.toString()}`);
        
        if (!res.ok) {
          setChatStatusMessage("メールが読み込めませんでした。しばらくしてからもう一度お試しください。");
          break;
        }

        const data = await res.json();
        const newMessages = data.messages || [];
        tempToken = data.nextPageToken || null;

        if (newMessages.length === 0) {
          setChatStatusMessage("すべてのメールを読み込みました");
          setCurrentNextPageToken(null);
          break;
        }

        const hasNew = newMessages.some((email: any) => {
          if (chatConfigs[email.id]?.isHidden) return false;
          if (email.senderRoom) return !currentSenders.has(email.senderRoom);
          const isMe = email.isMe || email.from.includes(session?.user?.email || "");
          if (!isMe) {
            const roomName = email.from.split("<")[0].replace(/"/g, "").trim() || "Unknown";
            return !currentSenders.has(roomName);
          } else {
             const toClean = email.to ? email.to.split(",")[0].split("<")[0].replace(/"/g, "").trim() : "";
             return toClean && !currentSenders.has(toClean);
          }
        });

        setEmails(prev => [...prev, ...newMessages]);
        setCurrentNextPageToken(tempToken);

        if (hasNew) {
          hasNewSender = true; 
        }
      }

      if (loopCount >= maxLoops && !hasNewSender) {
        setChatStatusMessage("APIの上限に達しました。しばらくしてからもう一度お試しください。");
      } else if (!tempToken && !hasNewSender) {
        setChatStatusMessage("すべてのメールを読み込みました");
      }

    } catch (error) {
      setChatStatusMessage("メールが読み込めませんでした。しばらくしてからもう一度お試しください。");
    } finally {
      setIsLoadingMoreChats(false);
    }
  };

  const handleLoadMoreMessage = async () => {
    if (isLoadingMore || !currentNextPageToken) {
      if (!currentNextPageToken) setMsgStatusMessage("すべてのメールを読み込みました");
      return;
    }
    setIsLoadingMore(true);
    setMsgStatusMessage(null);

    let tempToken = currentNextPageToken;
    let hasFoundTargetMsg = false;
    let loopCount = 0;
    const maxLoops = 5; 

    // ★ 追加：この関数が呼ばれた時の世代IDを記憶
    const currentLoadId = activeLoadRef.current;

    try {
      const targetSenderLower = selectedSender!.toLowerCase();

      while (!hasFoundTargetMsg && tempToken && loopCount < maxLoops) {
        // ★ 追加：ループの最中に条件が切り替わっていたら、即座にループを破棄して終了する
        if (activeLoadRef.current !== currentLoadId) break;

        loopCount++;
        let qParts = []; let orLabels = [];
        if (checkInbox) orLabels.push("in:inbox", "in:sent");
        if (checkSpam) orLabels.push("in:spam");
        if (checkTrash) orLabels.push("in:trash");
        if (orLabels.length > 0) qParts.push(`(${orLabels.join(" OR ")})`);
        if (searchKeyword) qParts.push(searchKeyword);

        const params = new URLSearchParams({ maxResults: "100", q: qParts.join(" ").trim(), includeTrash: "true", pageToken: tempToken });
        const res = await fetch(`/api/emails?${params.toString()}`);
        
        if (!res.ok) {
          setMsgStatusMessage("メールが読み込めませんでした。しばらくしてからもう一度お試しください。");
          break;
        }

        const data = await res.json();
        const newMessages = data.messages || [];
        tempToken = data.nextPageToken || null;

        if (newMessages.length === 0) {
          setMsgStatusMessage("すべてのメールを読み込みました");
          setCurrentNextPageToken(null);
          break;
        }

        const found = newMessages.some((email: any) => {
          if (chatConfigs[email.id]?.isHidden) return false;
          
          const fromName = email.from.split("<")[0].replace(/"/g, "").trim() || "Unknown";
          if (fromName === selectedSender || email.senderRoom === selectedSender) return true;
          
          const isMe = email.isMe || email.from.includes(session?.user?.email || "");
          if (isMe) {
            const toClean = email.to ? email.to.toLowerCase() : "";
            if (toClean.includes(targetSenderLower)) return true;
          }
          return false;
        });

        setEmails(prev => [...prev, ...newMessages]);
        setCurrentNextPageToken(tempToken);

        if (found) {
          hasFoundTargetMsg = true; 
        }
      }

      if (!tempToken) {
        setMsgStatusMessage("すべてのメールを読み込みました");
      }

    } catch (error) {
      setMsgStatusMessage("エラーが発生しました。しばらくしてからもう一度お試しください。");
    } finally {
      setIsLoadingMore(false);
    }
  };

  return (
    <div className="flex h-[100dvh] w-full bg-[#313338] overflow-hidden text-gray-200 relative select-none">
      
      {/* ＝＝＝＝ コンテキストメニュー ＝＝＝＝ */}
      {contextMenu && (
        <div 
          className={`fixed z-[100] bg-[#2B2D31] rounded shadow-xl border border-[#1E1F22] overflow-hidden text-sm w-56 text-gray-300 ${isMobile ? 'bottom-0 left-0 w-full rounded-b-none p-2 animate-slide-up' : ''}`}
          style={isMobile ? {} : { top: Math.min(contextMenu.y, window.innerHeight - 300), left: Math.min(contextMenu.x, window.innerWidth - 200) }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.type === "chat" && (() => {
            const tId = typeof contextMenu.target === "string" ? contextMenu.target : contextMenu.target.id;
            return (
              <div className="flex flex-col p-1">
                <div className="px-2 py-1.5 text-xs font-bold text-gray-400 truncate border-b border-[#1E1F22] mb-1">{chatConfigs[tId]?.customName || tId}</div>
                <button onClick={() => handleContextMenuAction("rename", contextMenu.target)} className="w-full text-left px-2 py-2 rounded hover:bg-[#4752C4] hover:text-white transition">名前の変更</button>
                <button onClick={() => handleContextMenuAction(chatConfigs[tId]?.isPinned ? "unpin" : "pin", contextMenu.target)} className="w-full text-left px-2 py-2 rounded hover:bg-[#4752C4] hover:text-white transition">{chatConfigs[tId]?.isPinned ? "ピン留め解除" : "ピン留めする"}</button>
                <div className="h-px bg-[#1E1F22] my-1"></div>
                <button onClick={() => handleContextMenuAction("hide", contextMenu.target)} className="w-full text-left px-2 py-2 rounded hover:bg-[#DA373C] hover:text-white transition">非表示(Re:Mailのみ)</button>
                <button onClick={() => handleContextMenuAction("delete", contextMenu.target)} className="w-full text-left px-2 py-2 rounded hover:bg-[#DA373C] hover:text-white transition font-bold">削除(Gmailを含む)</button>
                <div className="h-px bg-[#1E1F22] my-1"></div>
                <button onClick={() => handleContextMenuAction("reset", contextMenu.target)} className="w-full text-left px-2 py-2 rounded hover:bg-[#DA373C] hover:text-white transition text-xs">リセット</button>
              </div>
            );
          })()}
          {contextMenu.type === "msg" && (() => {
            const mId = contextMenu.target.id;
            return (
              <div className="flex flex-col p-1">
                <button onClick={() => handleContextMenuAction("reply", contextMenu.target)} className="w-full text-left px-2 py-2 rounded hover:bg-[#4752C4] hover:text-white transition">リプライ</button>
                <button onClick={() => handleContextMenuAction("forward", contextMenu.target)} className="w-full text-left px-2 py-2 rounded hover:bg-[#4752C4] hover:text-white transition">転送</button>
                <button onClick={() => handleContextMenuAction("copy", contextMenu.target)} className="w-full text-left px-2 py-2 rounded hover:bg-[#4752C4] hover:text-white transition">テキストをコピー</button>
                <button onClick={() => handleContextMenuAction(chatConfigs[mId]?.isPinned ? "unpin" : "pin", contextMenu.target)} className="w-full text-left px-2 py-2 rounded hover:bg-[#4752C4] hover:text-white transition">{chatConfigs[mId]?.isPinned ? "ピン留め解除" : "ピン留めする"}</button>
                <div className="h-px bg-[#1E1F22] my-1"></div>
                <button onClick={() => handleContextMenuAction("hide", contextMenu.target)} className="w-full text-left px-2 py-2 rounded hover:bg-[#DA373C] hover:text-white transition">非表示(Re:Mailのみ)</button>
                <button onClick={() => handleContextMenuAction("delete", contextMenu.target)} className="w-full text-left px-2 py-2 rounded hover:bg-[#DA373C] hover:text-white transition font-bold">削除(Gmailを含む)</button>
              </div>
            );
          })()}
        </div>
      )}

      {/* ＝＝＝＝ 確認モーダルシステム ＝＝＝＝ */}
      {modal && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
          <div className="bg-[#313338] rounded-md shadow-2xl w-full max-w-sm border border-[#1E1F22]">
            
            {modal.type === "confirm_delete" && (
              <div className="p-5">
                <h2 className="text-lg font-bold text-white mb-2">削除(Gmailを含む)</h2>
                <p className="text-sm text-gray-300 mb-6 leading-relaxed">選択した{modal.targetMode === "chat" ? "チャット内のすべての" : ""}メッセージを削除します。<br/><span className="text-[#DA373C] font-bold">この操作はGmail本体のゴミ箱に反映されます。</span>よろしいですか？</p>
                <div className="flex justify-end gap-3">
                  <button onClick={() => setModal(null)} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
                  <button onClick={executeConfirmedAction} className="px-4 py-2 bg-[#DA373C] text-white rounded text-sm font-bold hover:bg-[#a1282c]">削除する</button>
                </div>
              </div>
            )}

            {modal.type === "confirm_hide" && (
              <div className="p-5">
                <h2 className="text-lg font-bold text-white mb-2">非表示(Re:Mailのみ)</h2>
                <p className="text-sm text-gray-300 mb-6 leading-relaxed">選択した項目をRe:Mailの画面上から隠します。（Gmailからは削除されません）</p>
                <div className="flex justify-end gap-3">
                  <button onClick={() => setModal(null)} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
                  <button onClick={executeConfirmedAction} className="px-4 py-2 bg-[#5865F2] text-white rounded text-sm font-bold hover:bg-[#4752C4]">非表示にする</button>
                </div>
              </div>
            )}

            {modal.type === "confirm_pin" && (() => {
              const isChatMode = modal.targetMode === "chat";
              const existingForcePinnedChats = Object.keys(chatConfigs).filter(k => !k.includes("-") && chatConfigs[k]?.isPinned && chatConfigs[k]?.forceFetch);
              const newChatsToPin = isChatMode ? modal.targets.filter(t => !existingForcePinnedChats.includes(t)) : [];
              const willExceedLimit = isChatMode && (existingForcePinnedChats.length + newChatsToPin.length > 10);

              return (
                <div className="p-5">
                  <h2 className="text-lg font-bold text-white mb-2">ピン留め</h2>
                  <p className="text-sm text-gray-300 mb-6 leading-relaxed">読み込み対象外（期間外や件数制限など）になった際も、この{modal.targetMode === "chat" ? "チャット" : "メッセージ"}を表示させますか？</p>
                  <div className="flex flex-col gap-2">
                    <button 
                      onClick={() => executePin(true)} 
                      disabled={willExceedLimit}
                      className={`w-full py-2.5 rounded text-sm font-bold transition ${willExceedLimit ? 'bg-[#3f4147] text-gray-500 cursor-not-allowed' : 'bg-[#5865F2] text-white hover:bg-[#4752C4] active:scale-95'}`}
                    >
                      {willExceedLimit ? "永続読み込みは10件までです" : "対象外になっても常に表示する"}
                    </button>
                    <button onClick={() => executePin(false)} className="w-full py-2.5 bg-[#404249] text-white rounded text-sm font-bold hover:bg-[#4f545c] active:scale-95">対象外になった場合は隠す</button>
                    <button onClick={() => setModal(null)} className="w-full py-2 mt-2 hover:underline text-gray-400 text-sm">キャンセル</button>
                  </div>
                </div>
              );
            })()}

            {modal.type === "confirm_unhide" && (
              <div className="p-5">
                <h2 className="text-lg font-bold text-white mb-2">非表示を解除</h2>
                <p className="text-sm text-gray-300 mb-6 leading-relaxed">選択した項目を再び画面に表示しますか？</p>
                <div className="flex justify-end gap-3">
                  <button onClick={() => { setModal({ type: "unhide_select", targetMode: modal.targetMode, targets: [] }); setSelectedIds([]); }} className="px-4 py-2 hover:underline text-gray-300 text-sm">戻る</button>
                  <button onClick={executeConfirmedAction} className="px-4 py-2 bg-[#5865F2] text-white rounded text-sm font-bold hover:bg-[#4752C4]">解除する</button>
                </div>
              </div>
            )}

            {modal.type === "unhide_select" && (
              <div className="flex flex-col max-h-[80vh]">
                <div className="p-4 border-b border-[#1E1F22]">
                  <h2 className="text-lg font-bold text-white">非表示の解除 ({modal.targetMode === "chat" ? "チャット" : "メッセージ"})</h2>
                </div>
                <div className="p-2 overflow-y-auto flex-1 space-y-1">
                  {modal.targetMode === "chat" ? hiddenChats.map(c => (
                    <label key={c} className="flex items-center gap-3 p-2 hover:bg-[#2B2D31] rounded cursor-pointer">
                      <input type="checkbox" checked={selectedIds.includes(c)} onChange={() => toggleSelection(c)} className="accent-[#5865F2]" />
                      <span className="text-sm truncate">{chatConfigs[c]?.customName || c}</span>
                    </label>
                  )) : hiddenMsgs.map(m => {
                    const roomId = chatConfigs[m.id]?.roomId;
                    const chatName = roomId ? (chatConfigs[roomId]?.customName || roomId) : "不明なチャット";

                    return (
                      <label key={m.id} className="flex items-center gap-3 p-2 hover:bg-[#2B2D31] rounded cursor-pointer">
                        <input type="checkbox" checked={selectedIds.includes(m.id)} onChange={() => toggleSelection(m.id)} className="accent-[#5865F2]" />
                        <div className="text-sm truncate flex-1 flex flex-col gap-0.5">
                          <span className="text-[11px] text-[#5865F2] font-bold truncate">{chatName}</span>
                          <div className="text-gray-200 truncate">
                            <span className="text-gray-400 text-xs mr-2">{new Date(m.date).toLocaleDateString()}</span>
                            {m.subject || m.snippet || "(件名なし)"}
                          </div>
                        </div>
                      </label>
                    );
                  })}
                  {(modal.targetMode === "chat" ? hiddenChats : hiddenMsgs).length === 0 && <div className="text-gray-500 text-sm p-4 text-center">非表示の項目はありません</div>}
                </div>
                <div className="p-4 border-t border-[#1E1F22] flex justify-end gap-3">
                  <button onClick={() => { setModal(null); setSelectedIds([]); }} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
                  <button disabled={selectedIds.length === 0} onClick={() => setModal({ type: "confirm_unhide", targetMode: modal.targetMode, targets: selectedIds })} className="px-4 py-2 bg-[#5865F2] text-white rounded text-sm font-bold hover:bg-[#4752C4] disabled:bg-gray-600 disabled:text-gray-400">次へ ({selectedIds.length})</button>
                </div>
              </div>
            )}

            {modal.type === "confirm_reset" && (
              <div className="p-5">
                <h2 className="text-lg font-bold text-white mb-2">設定のリセット</h2>
                <p className="text-sm text-gray-300 mb-4 leading-relaxed bg-[#2B2D31] p-3 rounded border border-[#1E1F22]">
                  {modal.targetMode === "all_chats" && "すべてのチャットとメッセージの設定から、選択した項目を初期化します。"}
                  {modal.targetMode === "current_chat" && `現在のチャット（${chatConfigs[selectedSender!]?.customName || selectedSender}）内のみの設定から、選択した項目を初期化します。`}
                  {modal.targetMode === "specific_chat" && `選択したチャット（${chatConfigs[modal.targets[0]]?.customName || modal.targets[0]}）内のみの設定から、選択した項目を初期化します。`}
                </p>
                <div className="flex flex-col gap-2 mb-6 text-sm text-gray-200">
                  <label className="flex items-center gap-3 cursor-pointer hover:bg-[#2B2D31] p-2 rounded transition">
                    <input type="checkbox" checked={resetOptions.pin} onChange={(e) => setResetOptions({...resetOptions, pin: e.target.checked})} className="accent-[#5865F2] w-4 h-4" /> 
                    ピン留め (通常・永続) を解除
                  </label>
                  <label className="flex items-center gap-3 cursor-pointer hover:bg-[#2B2D31] p-2 rounded transition">
                    <input type="checkbox" checked={resetOptions.hide} onChange={(e) => setResetOptions({...resetOptions, hide: e.target.checked})} className="accent-[#5865F2] w-4 h-4" /> 
                    非表示設定 を解除
                  </label>
                  <label className="flex items-center gap-3 cursor-pointer hover:bg-[#2B2D31] p-2 rounded transition">
                    <input type="checkbox" checked={resetOptions.name} onChange={(e) => setResetOptions({...resetOptions, name: e.target.checked})} className="accent-[#5865F2] w-4 h-4" /> 
                    名前の変更 を初期化
                  </label>
                </div>
                <div className="flex justify-end gap-3">
                  <button onClick={() => setModal(null)} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
                  <button 
                    onClick={executeConfirmedAction} 
                    disabled={!resetOptions.pin && !resetOptions.hide && !resetOptions.name}
                    className="px-4 py-2 bg-[#DA373C] text-white rounded text-sm font-bold hover:bg-[#a1282c] disabled:bg-[#3f4147] disabled:text-gray-500"
                  >
                    リセットする
                  </button>
                </div>
              </div>
            )}

            {modal.type === "rename" && (
              <div className="p-5">
                <h2 className="text-lg font-bold text-white mb-4">チャット名の変更</h2>
                <input type="text" value={renameInput} onChange={(e) => setRenameInput(e.target.value)} className="w-full bg-[#1E1F22] text-gray-200 px-3 py-2 rounded focus:outline-none focus:ring-2 focus:ring-[#5865F2] mb-4" />
                <div className="flex justify-end gap-3">
                  <button onClick={() => setModal(null)} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
                  <button onClick={() => { updateChatConfig(modal.targets[0], { customName: renameInput.trim() }); setModal(null); }} className="px-4 py-2 bg-[#5865F2] text-white rounded text-sm font-bold hover:bg-[#4752C4]">変更</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ＝＝＝＝ 左ペイン：チャットリスト ＝＝＝＝ */}
      {showChatList && (
        <aside 
          onClick={handleBackgroundClick}
          className={`${isMobile ? 'w-full' : 'w-[320px] border-r'} border-[#1E1F22] bg-[#2B2D31] flex flex-col h-full min-h-0 cursor-pointer`}
        >
          <div className="p-4 border-b border-[#1E1F22] shadow-sm flex items-center justify-between cursor-default" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 flex items-center justify-center">
                {(selectionMode !== "none" || searchKeyword !== "") && (
                  <button 
                    onClick={() => window.history.back()} 
                    className="text-gray-400 hover:text-white font-bold text-lg transition active:scale-90"
                  >
                    ←
                  </button>
                )}
              </div>
              <h1 className="text-xl font-extrabold text-white tracking-wide">Re:Mail</h1>
            </div>
            <button onClick={() => signOut()} className="text-xs text-gray-400 hover:text-white transition">ログアウト</button>
          </div>

          <div className="p-3 border-b border-[#1E1F22] bg-[#232428] cursor-default" onClick={(e) => e.stopPropagation()}>
             <div className="relative w-full">
               <input 
                 type="text" 
                 placeholder="キーワード検索..." 
                 className="w-full bg-[#1E1F22] text-sm text-gray-300 pl-3 pr-8 py-1.5 rounded focus:outline-none focus:ring-1 focus:ring-[#5865F2]" 
                 value={searchKeyword} 
                 onChange={(e) => handleSearchChange(e.target.value)} 
               />
               {searchKeyword && (
                 <button 
                   onClick={() => window.history.back()} 
                   className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white text-xs font-bold px-1 transition"
                 >
                   ✕
                 </button>
               )}
             </div>
             
             <div className="flex gap-1 text-xs mt-2">
                <label className="flex items-center gap-1 cursor-pointer bg-[#313338] px-2 py-1.5 rounded flex-1 justify-center hover:bg-[#3f4147]"><input type="checkbox" checked={checkInbox} onChange={(e) => setCheckInbox(e.target.checked)} className="accent-[#5865F2]" /> 受信箱</label>
                <label className="flex items-center gap-1 cursor-pointer bg-[#313338] px-2 py-1.5 rounded flex-1 justify-center hover:bg-[#3f4147]"><input type="checkbox" checked={checkSpam} onChange={(e) => setCheckSpam(e.target.checked)} className="accent-[#5865F2]" /> 迷惑メール</label>
                <label className="flex items-center gap-1 cursor-pointer bg-[#313338] px-2 py-1.5 rounded flex-1 justify-center hover:bg-[#3f4147]"><input type="checkbox" checked={checkTrash} onChange={(e) => setCheckTrash(e.target.checked)} className="accent-[#5865F2]" /> ゴミ箱</label>
             </div>
          </div>

          <div className="flex flex-wrap p-2 gap-1 border-b border-[#1E1F22] bg-[#2B2D31] cursor-default" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => handleMenuBarClick("chat_pin")} className={`flex-1 min-w-[70px] py-1.5 text-[11px] font-bold rounded transition ${selectionMode === "chat_pin" ? 'bg-[#5865F2] text-white' : 'bg-[#1E1F22] text-gray-400 hover:bg-[#3f4147] hover:text-gray-200'} ${selectionMode !== "none" && selectionMode !== "chat_pin" ? 'opacity-30 pointer-events-none' : ''}`}>
              {selectionMode === "chat_pin" ? `実行(${selectedIds.length})` : "ピン留め"}
            </button>
            <button onClick={() => handleMenuBarClick("chat_hide")} className={`flex-1 min-w-[120px] py-1.5 text-[11px] font-bold rounded transition ${selectionMode === "chat_hide" ? 'bg-[#5865F2] text-white' : 'bg-[#1E1F22] text-gray-400 hover:bg-[#3f4147] hover:text-gray-200'} ${selectionMode !== "none" && selectionMode !== "chat_hide" ? 'opacity-30 pointer-events-none' : ''}`}>
              {selectionMode === "chat_hide" ? `実行(${selectedIds.length})` : "非表示(Re:Mailのみ)"}
            </button>
            <button onClick={() => handleMenuBarClick("chat_delete")} className={`flex-1 min-w-[110px] py-1.5 text-[11px] font-bold rounded transition ${selectionMode === "chat_delete" ? 'bg-[#DA373C] text-white' : 'bg-[#1E1F22] text-gray-400 hover:bg-[#3f4147] hover:text-gray-200'} ${selectionMode !== "none" && selectionMode !== "chat_delete" ? 'opacity-30 pointer-events-none' : ''}`}>
              {selectionMode === "chat_delete" ? `実行(${selectedIds.length})` : "削除(Gmailを含む)"}
            </button>
            <button onClick={() => handleMenuBarClick("chat_reset")} className={`flex-1 min-w-[70px] py-1.5 text-[11px] font-bold rounded transition ${selectionMode === "chat_reset" ? 'bg-[#DA373C] text-white' : 'bg-[#1E1F22] text-gray-400 hover:bg-[#3f4147] hover:text-gray-200'} ${selectionMode !== "none" && selectionMode !== "chat_reset" ? 'opacity-30 pointer-events-none' : ''}`}>
              リセット
            </button>
            <button onClick={() => { setModal({ type: "unhide_select", targetMode: "chat", targets: [] }); setSelectedIds([]); setSelectionMode("none"); }} className={`px-3 py-1.5 text-[11px] font-bold rounded bg-[#1E1F22] text-gray-400 hover:bg-[#3f4147] hover:text-gray-200 ${selectionMode.startsWith("chat_") ? 'opacity-30 pointer-events-none' : ''}`}>非表示解除</button>
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-0.5 min-h-0 cursor-default" onClick={(e) => e.stopPropagation()}>
             {isLoading && <div className="text-xs text-[#5865F2] font-bold p-2 text-center animate-pulse">読み込み中...</div>}
             {senderList.map((sender) => {
              const latestEmail = groupedEmails[sender][0];
              const isSelected = selectedIds.includes(sender);
              const isOpened = selectedSender === sender && !isMobile;
              const config = chatConfigs[sender];
              
              // ★追加：チャットリストの追加情報（日付と件数）
              const count = groupedEmails[sender].length;
              const latestDate = new Date(latestEmail.date).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

              return (
                <div 
                  key={sender}
                  onClick={() => {
                    if (selectionMode.startsWith("chat_")) toggleSelection(sender);
                    else openChat(sender);
                  }}
                  onContextMenu={(e) => { e.preventDefault(); setContextMenu({ type: "chat", target: sender, x: e.clientX, y: e.clientY }); }}
                  onTouchStart={(e) => { if (!hasMouse) touchTimer.current = setTimeout(() => { setContextMenu({ type: "chat", target: sender, x: window.innerWidth/2, y: window.innerHeight/2 }); }, 500); }}
                  onTouchEnd={() => touchTimer.current && clearTimeout(touchTimer.current)}
                  onTouchMove={() => touchTimer.current && clearTimeout(touchTimer.current)}
                  className={`flex items-center px-2 py-2 rounded cursor-pointer transition ${selectionMode.startsWith("chat_") ? (isSelected ? 'bg-[rgba(88,101,242,0.2)] border border-[#5865F2]' : 'hover:bg-[#35373C] border border-transparent') : (isOpened ? 'bg-[#404249] text-white' : 'hover:bg-[#35373C] text-gray-400 hover:text-gray-200')}`}
                >
                  {selectionMode.startsWith("chat_") && (
                    <div className={`w-4 h-4 mr-3 rounded-sm flex items-center justify-center border ${isSelected ? 'bg-[#5865F2] border-[#5865F2]' : 'border-gray-500'}`}>
                      {isSelected && <div className="w-2 h-2 bg-white rounded-sm"></div>}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex justify-between items-baseline">
                      <div className="flex items-center gap-1 truncate pr-2">
                        {config?.isPinned && <span className="text-[#FEE75C] text-[10px]">📌</span>}
                        <span className="font-bold text-sm truncate">
                          <HighlightText text={config?.customName || sender} highlight={searchKeyword} />
                        </span>
                      </div>
                      <span className="text-[10px] text-gray-500 flex-shrink-0">{latestDate}</span>
                    </div>
                    <div className="text-[10px] text-[#5865F2] font-bold mt-0.5">{count}件のメッセージ</div>
                    <div className="text-xs text-gray-500 truncate mt-0.5">
                      <HighlightText text={latestEmail.subject || "No Subject"} highlight={searchKeyword} />
                    </div>
                  </div>
                </div>
              );
            })}
             {senderList.length > 0 && (
               <div className="flex flex-col items-center p-3 mt-2 border-t border-[#1E1F22]/50">
                 {chatStatusMessage ? (
                   <span className="text-xs text-gray-500 font-medium px-2 py-1 bg-[#232428] rounded text-center">{chatStatusMessage}</span>
                 ) : (
                   <button 
                     onClick={handleLoadMoreChats} 
                     disabled={isLoadingMoreChats}
                     className="w-full bg-[#1E1F22] hover:bg-[#3f4147] text-gray-400 hover:text-gray-200 py-2 rounded text-xs font-bold transition active:scale-[0.98] disabled:opacity-50"
                   >
                     {isLoadingMoreChats ? "新しいチャットを探索中..." : "さらにチャットを読み込む"}
                   </button>
                 )}
               </div>
             )}
          </div>
        </aside>
      )}

      {/* ＝＝＝＝ 右ペイン：トーク画面 ＝＝＝＝ */}
      {showTalk && (
        <main 
          onClick={handleBackgroundClick}
          className={`${isMobile ? 'w-full' : 'flex-1'} flex flex-col bg-[#313338] relative cursor-pointer`}
        >
          {selectedSender && groupedEmails[selectedSender] && groupedEmails[selectedSender].length > 0 ? (
            <>
              <header className="px-4 py-3 bg-[#313338] border-b border-[#1E1F22] shadow-sm z-10 flex items-center gap-3 cursor-default" onClick={(e) => e.stopPropagation()}>
                {isMobile && (
                  <button 
                    onClick={() => window.history.back()} 
                    className="text-gray-400 hover:text-white font-bold p-1 text-lg transition active:scale-90"
                  >
                    ←
                  </button>
                )}
                <h2 className="font-bold text-base truncate flex-1 text-white">{chatConfigs[selectedSender]?.customName || selectedSender}</h2>
              </header>

              <div className="flex flex-wrap px-4 py-2 gap-2 border-b border-[#1E1F22] bg-[#2B2D31] cursor-default" onClick={(e) => e.stopPropagation()}>
                <button onClick={() => handleMenuBarClick("msg_pin")} className={`px-3 py-1 text-xs font-bold rounded transition ${selectionMode === "msg_pin" ? 'bg-[#5865F2] text-white' : 'bg-[#1E1F22] text-gray-400 hover:bg-[#3f4147] hover:text-gray-200'} ${selectionMode !== "none" && selectionMode !== "msg_pin" ? 'opacity-30 pointer-events-none' : ''}`}>
                  {selectionMode === "msg_pin" ? `実行(${selectedIds.length})` : "ピン留め"}
                </button>
                <button onClick={() => handleMenuBarClick("msg_hide")} className={`px-3 py-1 text-xs font-bold rounded transition ${selectionMode === "msg_hide" ? 'bg-[#5865F2] text-white' : 'bg-[#1E1F22] text-gray-400 hover:bg-[#3f4147] hover:text-gray-200'} ${selectionMode !== "none" && selectionMode !== "msg_hide" ? 'opacity-30 pointer-events-none' : ''}`}>
                  {selectionMode === "msg_hide" ? `実行(${selectedIds.length})` : "非表示(Re:Mailのみ)"}
                </button>
                <button onClick={() => handleMenuBarClick("msg_delete")} className={`px-3 py-1 text-xs font-bold rounded transition ${selectionMode === "msg_delete" ? 'bg-[#DA373C] text-white' : 'bg-[#1E1F22] text-gray-400 hover:bg-[#3f4147] hover:text-gray-200'} ${selectionMode !== "none" && selectionMode !== "msg_delete" ? 'opacity-30 pointer-events-none' : ''}`}>
                  {selectionMode === "msg_delete" ? `実行(${selectedIds.length})` : "削除(Gmailを含む)"}
                </button>
                <button onClick={() => handleMenuBarClick("msg_reset")} className={`px-3 py-1 text-xs font-bold rounded transition ${selectionMode === "msg_reset" ? 'bg-[#DA373C] text-white' : 'bg-[#1E1F22] text-gray-400 hover:bg-[#3f4147] hover:text-gray-200'} ${selectionMode !== "none" && selectionMode !== "msg_reset" ? 'opacity-30 pointer-events-none' : ''}`}>
                  {selectionMode === "msg_reset" ? `実行(${selectedIds.length})` : "リセット"}
                </button>
                <button onClick={() => { setModal({ type: "unhide_select", targetMode: "msg", targets: [] }); setSelectedIds([]); setSelectionMode("none"); }} className={`px-3 py-1 text-xs font-bold rounded bg-[#1E1F22] text-gray-400 hover:bg-[#3f4147] hover:text-gray-200 ${selectionMode.startsWith("msg_") ? 'opacity-30 pointer-events-none' : ''}`}>非表示解除</button>
              </div>

              {pinnedMsgsInChat.length > 0 && (
                <div className="bg-[#2B2D31] border-b border-[#1E1F22] px-4 py-1.5 flex gap-2 overflow-x-auto scrollbar-none items-center shadow-inner cursor-default" onClick={(e) => e.stopPropagation()}>
                   <span className="text-xs text-[#FEE75C] font-bold">📌</span>
                   {pinnedMsgsInChat.map(m => (
                      <button 
                        key={`pin-${m.id}`} 
                        onClick={() => document.getElementById(`msg-${m.id}`)?.scrollIntoView({behavior: 'smooth', block: 'center'})} 
                        className="text-xs bg-[#1E1F22] text-gray-300 px-3 py-1.5 rounded-full truncate max-w-[200px] hover:text-white border border-[#35373C] flex-shrink-0 transition active:scale-95"
                      >
                         {m.subject || m.snippet}
                      </button>
                   ))}
                </div>
              )}

              <div className="flex-1 overflow-y-auto px-4 py-6 flex flex-col-reverse scrollbar-thin">
                {groupedEmails[selectedSender] ? (
                  groupedEmails[selectedSender].map((email) => {
                    const isMe = email.isMe || email.from.includes(session?.user?.email || "");
                    const isSelected = selectedIds.includes(email.id);
                    
                    // ★追加：ゴミ箱と受信箱のクロスプロンプト判定
                    const isTrashed = email.labelIds?.includes("TRASH");
                    const isSent = email.labelIds?.includes("SENT") || email.isMe;

                    // ★ 修正：1件ずつ読み込む仕様に変更（グローバルのチェックボックスは切り替えない）
                    if (isSent && isTrashed && !checkTrash && !revealedCrossPrompts.includes(email.id)) {
                        return (
                            <div key={`prompt-${email.id}`} className="flex w-full justify-center my-4 cursor-default" onClick={(e) => e.stopPropagation()}>
                                <button onClick={() => setRevealedCrossPrompts(p => [...p, email.id])} className="bg-[#2B2D31] text-[#FEE75C] px-4 py-2 rounded-full text-xs font-bold border border-[#1E1F22] hover:bg-[#35373C] transition shadow-sm">
                                    ゴミ箱に自分が返信したメールが含まれています。読み込みますか？
                                </button>
                            </div>
                        );
                    }
                    if (isSent && !isTrashed && checkTrash && !checkInbox && !revealedCrossPrompts.includes(email.id)) {
                        return (
                            <div key={`prompt-${email.id}`} className="flex w-full justify-center my-4 cursor-default" onClick={(e) => e.stopPropagation()}>
                                <button onClick={() => setRevealedCrossPrompts(p => [...p, email.id])} className="bg-[#2B2D31] text-[#5865F2] px-4 py-2 rounded-full text-xs font-bold border border-[#1E1F22] hover:bg-[#35373C] transition shadow-sm">
                                    受信箱に自分が返信したメールが含まれています。読み込みますか？
                                </button>
                            </div>
                        );
                    }

                    return (
                      <div 
                        id={`msg-${email.id}`}
                        key={email.id} 
                        onClick={(e) => e.stopPropagation()}
                        className={`flex w-full mb-6 cursor-default ${isMe ? 'justify-end' : 'justify-start'}`}
                      >
                        {selectionMode.startsWith("msg_") && (
                          <div className="flex-shrink-0 w-8 flex justify-center pt-3 mr-2" onClick={() => toggleSelection(email.id)}>
                            <div className={`w-5 h-5 rounded-sm flex items-center justify-center border cursor-pointer ${isSelected ? 'bg-[#5865F2] border-[#5865F2]' : 'border-gray-500'}`}>
                              {isSelected && <div className="w-2.5 h-2.5 bg-white rounded-sm"></div>}
                            </div>
                          </div>
                        )}
                        
                        {!isMe && !selectionMode.startsWith("msg_") && (
                           <img 
                             src={`/api/avatar?name=${encodeURIComponent(email.from.split("<")[0].replace(/"/g, "").trim() || "Unknown")}`}
                             alt=""
                             className="w-9 h-9 rounded-full mr-3 flex-shrink-0 mt-1 shadow-sm select-none pointer-events-none"
                           />
                        )}

                        <div className={`flex flex-col max-w-[75%] ${isMe ? 'items-end' : 'items-start'}`}>
                          {/* 名前と時間 */}
                          <div className="flex items-center gap-2 mb-1.5 mx-1 text-[11px] text-gray-400 select-none">
                              {!isMe && <span className="font-bold text-gray-300">{email.from.split("<")[0].replace(/"/g, "").trim() || "Unknown"}</span>}
                              {/* 日付と時刻のフォーマットを統一して1箇所に集約 */}
                              <span>{new Date(email.date).toLocaleString("ja-JP", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                          </div>
                          
                          {/* メッセージバブル */}
                          <div 
                            className={`p-3.5 text-[15px] leading-relaxed whitespace-pre-wrap select-text shadow-sm transition-all cursor-pointer ${isSelected ? 'ring-2 ring-white scale-[0.98]' : ''} ${isMe ? 'bg-[#5865F2] text-white rounded-2xl rounded-tr-sm' : 'bg-[#2B2D31] text-gray-200 border border-[#1E1F22] rounded-2xl rounded-tl-sm hover:bg-[#35373C]'}`}
                            style={{ wordBreak: 'break-word', overflowWrap: 'anywhere' }}
                            onClick={() => { if (selectionMode.startsWith("msg_")) toggleSelection(email.id); }}
                            onContextMenu={(e) => { e.preventDefault(); setContextMenu({ type: "msg", target: email, x: e.clientX, y: e.clientY }); }}
                            onTouchStart={(e) => { if (!hasMouse) touchTimer.current = setTimeout(() => { setContextMenu({ type: "msg", target: email, x: window.innerWidth/2, y: window.innerHeight/2 }); }, 500); }}
                            onTouchEnd={() => touchTimer.current && clearTimeout(touchTimer.current)}
                            onTouchMove={() => touchTimer.current && clearTimeout(touchTimer.current)}
                          >
                            {chatConfigs[email.id]?.isPinned && <span className="text-[#FEE75C] text-xs mr-2 select-none">📌</span>}
                            {email.subject && !email.subject.startsWith("Re:") && (
                              <div className="font-bold text-sm mb-1.5 pb-1.5 border-b border-black/10">
                                <HighlightText text={email.subject} highlight={searchKeyword} />
                              </div>
                            )}
                            <HighlightText text={email.body} highlight={searchKeyword} />
                          </div>
                        </div>

                        {isMe && !selectionMode.startsWith("msg_") && (
                           <img 
                             src={`/api/avatar?name=${encodeURIComponent(session?.user?.name || "Me")}`}
                             alt=""
                             className="w-9 h-9 rounded-full ml-3 flex-shrink-0 mt-1 shadow-sm select-none pointer-events-none"
                           />
                        )}
                      </div>
                    );
                  })
                ) : null}
                
                {groupedEmails[selectedSender] && (
                  <div className="flex justify-center my-4 w-full">
                    {msgStatusMessage ? (
                      <span className="text-xs text-gray-500 font-medium px-3 py-1.5 bg-[#2B2D31] rounded-full border border-[#1E1F22]">{msgStatusMessage}</span>
                    ) : (
                      <button 
                        onClick={handleLoadMoreMessage} 
                        disabled={isLoadingMore}
                        className="bg-[#2B2D31] text-gray-300 hover:text-white px-4 py-2 rounded-full text-xs font-bold border border-[#1E1F22] shadow-sm active:scale-95 transition disabled:opacity-50"
                      >
                        {isLoadingMore ? "読み込み中..." : "過去のメッセージを読み込む"}
                      </button>
                    )}
                  </div>
                )}
              </div>

              <div className="p-4 bg-[#313338] cursor-default" onClick={(e) => e.stopPropagation()}>
                <div className="bg-[#383A40] rounded-lg p-3 border border-[#1E1F22]">
                  {replyToMessage && (
                    <div className="flex justify-between items-center bg-[#2B2D31] text-gray-300 p-2 rounded text-xs mb-2 border-l-4 border-[#5865F2]">
                      <span className="truncate">Replying to: {replyToMessage.subject || replyToMessage.snippet}</span>
                      <button onClick={() => setReplyToMessage(null)} className="font-bold px-2 hover:text-white">×</button>
                    </div>
                  )}
                  <input type="text" placeholder="件名 (省略可)" value={replySubject} onChange={(e) => setReplySubject(e.target.value)} className="w-full text-sm px-2 py-1 mb-2 bg-transparent text-white focus:outline-none placeholder-gray-500 font-medium border-b border-[#2B2D31]" />
                  <div className="flex items-end gap-2">
                    <textarea placeholder={`Message to ${chatConfigs[selectedSender]?.customName || selectedSender}`} rows={isMobile ? 1 : 2} value={replyBody} onChange={(e) => setReplyBody(e.target.value)} className="flex-1 resize-none text-[15px] bg-transparent text-white px-2 py-1 focus:outline-none placeholder-gray-500" />
                    <button onClick={handleSend} disabled={isSending || !replyBody.trim()} className="text-white px-4 py-2 rounded font-bold text-sm bg-[#5865F2] hover:bg-[#4752C4] transition disabled:bg-[#3f4147] disabled:text-gray-500 active:scale-95">
                      {isSending ? "..." : "送信"}
                    </button>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-gray-500 font-bold cursor-default" onClick={(e) => e.stopPropagation()}>
              左のリストからチャットを選択してください
            </div>
          )}
        </main>
      )}
    </div>
  );
}