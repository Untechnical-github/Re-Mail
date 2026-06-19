import { useSession, signOut } from "next-auth/react";
import { useState, useEffect, useMemo, useRef } from "react";
import localforage from "localforage";
import { ChatConfig, SelectionMode, ContextMenuState, ModalState } from "../types/mail";

export function useMailApp() {
  const { data: session, status } = useSession();
  const [emails, setEmails] = useState<any[]>([]);
  const [persistedEmails, setPersistedEmails] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedSender, setSelectedSender] = useState<string | null>(() => {
    if (typeof window !== "undefined") {
      return sessionStorage.getItem("remail_selected_sender");
    }
    return null;
  });
  const [chatConfigs, setChatConfigs] = useState<Record<string, ChatConfig>>({});

  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState("");
  const [checkInbox, setCheckInbox] = useState<boolean>(true);
  const [checkSpam, setCheckSpam] = useState<boolean>(false);
  const [checkTrash, setCheckTrash] = useState<boolean>(false);
  const [checkHasSent, setCheckHasSent] = useState<boolean>(false);
  const [currentNextPageToken, setCurrentNextPageToken] = useState<string | null>(null);
  
  // ★修正: 初期状態、フェッチ中、全件読込完了の状態を厳密に区別するため "FIRST_PAGE" で初期化
  const [chatNextPageToken, setChatNextPageToken] = useState<string | null>("FIRST_PAGE");
  
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
  const [moveDestination, setMoveDestination] = useState<"INBOX" | "SPAM" | "TRASH" | null>(null);
  const [revealedCrossPrompts, setRevealedCrossPrompts] = useState<string[]>([]);
  const [pinType, setPinType] = useState<boolean | null>(null);

  const [boxColors, setBoxColors] = useState({
    inbox: "#5865F2", 
    spam: "#FEE75C",  
    trash: "#DA373C"  
  });

  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const hasPushedSearchRef = useRef(false);
  const hasPushedSelectRef = useRef(false);
  const activeLoadRef = useRef<number>(0);
  
  const chatConfigsRef = useRef(chatConfigs);
  useEffect(() => { chatConfigsRef.current = chatConfigs; }, [chatConfigs]);

  const emailsRef = useRef(emails);
  useEffect(() => { emailsRef.current = emails; }, [emails]);

  const getCacheKey = (flags: { inbox: boolean; spam: boolean; trash: boolean }) => {
    return `remail_feed_cache_v2_i${flags.inbox ? 1 : 0}s${flags.spam ? 1 : 0}t${flags.trash ? 1 : 0}`;
  };

  useEffect(() => {
    const handleScrollSave = () => {
      const asideEl = document.querySelector("aside > div.flex-1");
      const mainEl = document.querySelector("main > div.flex-1");
      if (asideEl) sessionStorage.setItem("remail_scroll_aside", asideEl.scrollTop.toString());
      if (mainEl) sessionStorage.setItem("remail_scroll_main", mainEl.scrollTop.toString());
    };

    window.addEventListener("beforeunload", handleScrollSave);
    return () => window.removeEventListener("beforeunload", handleScrollSave);
  }, [selectedSender]);

  const allUniqueEmails = useMemo(() => {
    const map = new Map();
    const isDisplayable = (e: any) => {
      const isForceFetched = checkInbox && (chatConfigs[e.id]?.forceFetch || (e.senderRoom && chatConfigs[e.senderRoom]?.forceFetch));
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
            try { globalSettings = JSON.parse(c.custom_name); } catch (e) {} return;
          }
          let customNameVal = c.custom_name || undefined;
          let forceFetchVal = false;
          let pData = null;
          let roomIdVal = undefined;
          if (customNameVal && customNameVal.startsWith('{')) {
            try {
              const parsed = JSON.parse(customNameVal);
              customNameVal = parsed.name; forceFetchVal = parsed.forceFetch; pData = parsed.data; roomIdVal = parsed.roomId;
              if (pData) { if (Array.isArray(pData)) pMsgs.push(...pData); else pMsgs.push(pData); }
            } catch (e) {}
          }
          formatted[c.chat_id] = { customName: customNameVal, isPinned: c.is_pinned === 1, isHidden: c.is_hidden === 1, hiddenAtDate: c.hidden_at_date || undefined, unhideOnNew: c.unhide_on_new === 1, forceFetch: forceFetchVal, persistedData: pData, roomId: roomIdVal };
        });
        setChatConfigs(formatted); setPersistedEmails(pMsgs);
      }
    } catch (e) { console.error(e); }
    return globalSettings;
  };

  const saveGlobalSettings = async (inbox: boolean, spam: boolean, trash: boolean) => {
    try { await fetch("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: "__GLOBAL_SETTINGS__", custom_name: JSON.stringify({ inbox, spam, trash }) }) }); } catch (e) { console.error(e); }
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
          if (!msg || !msg.labelIds?.includes("INBOX")) {
            newConfig.isPinned = false; newConfig.forceFetch = false; newConfig.persistedData = null; hasUpdate = true;
          } else if (config.forceFetch) {
            pMsgs.push({ ...msg, senderRoom: config.roomId });
          }
        } else {
          if (config.forceFetch) {
            const chatEmails = latestEmails.filter(e => {
               const room = e.senderRoom || (e.from.split("<")[0].replace(/"/g, "").trim() || "Unknown");
               return room === targetId && e.labelIds?.includes("INBOX");
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
          if (!msg || !msg.labelIds?.includes("INBOX")) {
            newConfig.isHidden = false; newConfig.hiddenAtDate = undefined; newConfig.roomId = undefined; hasUpdate = true;
          }
        } else {
          const hasInbox = latestEmails.some(e => {
             const room = e.senderRoom || (e.from.split("<")[0].replace(/"/g, "").trim() || "Unknown");
             return room === targetId && e.labelIds?.includes("INBOX");
          });
          if (!hasInbox) {
            newConfig.isHidden = false; newConfig.hiddenAtDate = undefined; hasUpdate = true;
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
    const closeContextMenu = () => setContextMenu(null);
    window.addEventListener('click', closeContextMenu);
    return () => { mediaQuery.removeEventListener('change', handler); window.removeEventListener('resize', resizeHandler); window.removeEventListener('click', closeContextMenu); };
  }, []);

  useEffect(() => {
    const handlePopState = (e: PopStateEvent) => {
      const state = e.state;
      setModal(null); setContextMenu(null);
      if (!state || state.action !== "select") { setSelectionMode("none"); setSelectedIds([]); hasPushedSelectRef.current = false; } else { hasPushedSelectRef.current = true; }
      if (!state || state.action !== "search") { setSearchKeyword(""); hasPushedSearchRef.current = false; } else { hasPushedSearchRef.current = true; }
      if (window.innerWidth < 768 && window.location.hash !== '#chat') {
        setSelectedSender(null);
        sessionStorage.removeItem("remail_selected_sender");
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const fetchEmails = async (limit = 100, query = "", flags = { inbox: true, spam: false, trash: false }, pageToken: string | null = null, isLoadMore = false, isSilent = false, currentEmailsState = emails, getIsCancelled = () => false) => {
    if (!flags.inbox && !flags.spam && !flags.trash) { setEmails([]); if (!isSilent) setIsLoading(false); return { success: false, emails: [] }; }
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
        const knownIds = currentEmailsState.slice(0, targetLimit).map(e => e.id).join(",");
        params.append("knownIds", knownIds);
      }

      const res = await fetch(`/api/emails?${params.toString()}`);
      if (res.status === 401 || res.status === 403) {
        await localforage.clear();
        signOut({ callbackUrl: "/" });
        return { success: false, emails: currentEmailsState };
      }

      if (res.ok) {
        if (getIsCancelled()) return { success: false, emails: currentEmailsState };
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
          const emailMap = new Map(currentEmailsState.map(e => [e.id, e]));
          newMessages.forEach((m: any) => emailMap.set(m.id, m));
          updatedEmails = Array.from(emailMap.values());
        }
        
        const nextPMsgs = syncConfigs(updatedEmails, chatConfigsRef.current);
        setPersistedEmails(nextPMsgs);
        setEmails(updatedEmails);
        
        if (!isSilent || updatedEmails.length <= targetLimit) setCurrentNextPageToken(data.nextPageToken || null);
        if (isCacheTarget) await localforage.setItem(getCacheKey(flags), { emails: updatedEmails.slice(0, 100), flags: flags });
        return { success: true, emails: updatedEmails };
      }
      return { success: false, emails: currentEmailsState };
    } catch (error) { 
      return { success: false, emails: currentEmailsState }; 
    } finally { 
      if (!isSilent && !getIsCancelled()) setIsLoading(false); 
    }
  };

  // ★修正: トークンの受け渡しパラメータを安全な判定構造へ刷新（バグ②の修正）
  const fetchChatCrossbox = async (sender: string, isLoadMore = false) => {
    try {
      if (isLoadMore && chatNextPageToken === "END") {
        setMsgStatusMessage("すべてのメールを読み込みました");
        return { found: false, nextToken: "END" };
      }

      const addrSet = new Set<string>();
      emailsRef.current.forEach(e => {
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
      
      const params = new URLSearchParams({ maxResults: "50", q, includeTrash: "true" });
      
      const tokenToUse = isLoadMore ? (chatNextPageToken === "FIRST_PAGE" ? null : chatNextPageToken) : null;
      if (tokenToUse) params.append("pageToken", tokenToUse);

      const res = await fetch(`/api/emails?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        const newMsgs = data.messages || [];
        const nextToken = data.nextPageToken || "END";
        
        setChatNextPageToken(nextToken); 
        
        if (newMsgs.length > 0) {
          setEmails(prev => {
            const map = new Map(prev.map(e => [e.id, e]));
            newMsgs.forEach((m: any) => map.set(m.id, m));
            const updated = Array.from(map.values());
            
            // 一本釣りしたメール情報（ボタンの存在）を現在のボックスのローカルキャッシュに即時マージ
            localforage.setItem(getCacheKey({ inbox: checkInbox, spam: checkSpam, trash: checkTrash }), { 
              emails: updated.slice(0, 100), 
              flags: { inbox: checkInbox, spam: checkSpam, trash: checkTrash } 
            }).catch(err => console.error("Cache merge error:", err));
            
            return updated;
          });
        }

        // ★修正: 実際にメールが尽きた場合にのみ、終了メッセージをセットする（誤検知の破壊）
        if (isLoadMore && newMsgs.length === 0 && nextToken === "END") {
          setMsgStatusMessage("すべてのメールを読み込みました");
        }
        
        return { found: newMsgs.length > 0, nextToken };
      }
    } catch(e) { console.error(e); }
    return { found: false, nextToken: isLoadMore ? chatNextPageToken : "FIRST_PAGE" };
  };

  useEffect(() => {
    if (session) {
      const initLoad = async () => {
        try {
          setIsLoading(true);
          const settings = await loadD1Configs();
          const initInbox = settings?.inbox ?? true; const initSpam = settings?.spam ?? false; const initTrash = settings?.trash ?? false;
          setCheckInbox(initInbox); setCheckSpam(initSpam); setCheckTrash(initTrash);
          let snapshot: any = null;
          try { 
            snapshot = await localforage.getItem(getCacheKey({ inbox: initInbox, spam: initSpam, trash: initTrash })); 
            if (snapshot && snapshot.emails && snapshot.emails.length > 0 && !snapshot.emails[0].labelIds) { await localforage.clear(); snapshot = null; }
          } catch (e) {}
          if (snapshot && snapshot.emails && snapshot.emails.length > 0) setEmails(snapshot.emails);
          
          const res = await fetchEmails(100, "", { inbox: initInbox, spam: initSpam, trash: initTrash }, null, false, true);
          if (!res.success && status === "authenticated") {
             setEmails([]);
             await localforage.clear();
          }

          // ★修正: リロード完了後、確定したメールプールを元に「一本釣り」をバグを挟まず1回だけクリーンに実行
          if (selectedSender && res.success) {
            fetchChatCrossbox(selectedSender, false);
          }

          setTimeout(() => {
            const asideScroll = sessionStorage.getItem("remail_scroll_aside");
            const mainScroll = sessionStorage.getItem("remail_scroll_main");
            const asideEl = document.querySelector("aside > div.flex-1");
            const mainEl = document.querySelector("main > div.flex-1");
            if (asideScroll && asideEl) asideEl.scrollTop = parseInt(asideScroll, 10);
            if (mainScroll && mainEl) mainEl.scrollTop = parseInt(mainScroll, 10);
          }, 150);

        } catch (err) { console.error(err); } finally { setIsLoading(false); }
      };
      initLoad();
    }
  }, [session]);

  const handleSearchChange = (val: string) => {
    if (!searchKeyword && val && !hasPushedSearchRef.current) { window.history.pushState({ action: "search" }, ""); hasPushedSearchRef.current = true; } 
    else if (searchKeyword && !val && hasPushedSearchRef.current) { safeBack(); hasPushedSearchRef.current = false; return; }
    setSearchKeyword(val);
  };

  useEffect(() => {
    if (!session) return;
    let isCancelled = false; 
    activeLoadRef.current += 1;

    const handleFilterChange = async () => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
      searchTimeoutRef.current = setTimeout(async () => {
        await saveGlobalSettings(checkInbox, checkSpam, checkTrash);
        let loadedEmails = emails;
        if (!searchKeyword) {
          let snapshot: any = null;
          try { snapshot = await localforage.getItem(getCacheKey({ inbox: checkInbox, spam: checkSpam, trash: checkTrash })); } catch (e) {}
          
          const protectedEmails = emails.filter(e => {
             if (revealedCrossPrompts.includes(e.id)) return true;
             if (selectedSender) {
                const sLower = selectedSender.toLowerCase();
                if (e.senderRoom === selectedSender) return true;
                if (e.from.toLowerCase().includes(sLower) || (e.to && e.to.toLowerCase().includes(sLower))) return true;
             }
             return false;
          });
          
          if (snapshot && snapshot.emails) { 
             const map = new Map(protectedEmails.map(e => [e.id, e]));
             snapshot.emails.forEach((e: any) => { if (!map.has(e.id)) map.set(e.id, e); });
             loadedEmails = Array.from(map.values());
             if (!isCancelled) setEmails(loadedEmails); 
          } else { 
             loadedEmails = protectedEmails; 
             if (!isCancelled) setEmails(protectedEmails); 
          }
        }
        
        if (!isCancelled) setChatStatusMessage(null);
        const res = await fetchEmails(100, searchKeyword, { inbox: checkInbox, spam: checkSpam, trash: checkTrash }, null, false, false, loadedEmails, () => isCancelled);
        
        if (selectedSender && !isCancelled && res.success) {
           fetchChatCrossbox(selectedSender, false);
        }
      }, searchKeyword ? 300 : 0);
    };
    handleFilterChange();
    return () => { isCancelled = true; if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current); };
  }, [checkInbox, checkSpam, checkTrash, searchKeyword]);

  useEffect(() => {
    if (!session) return;
    const interval = setInterval(() => { 
      if (document.visibilityState === 'visible') { 
        fetchEmails(100, searchKeyword, { inbox: checkInbox, spam: checkSpam, trash: checkTrash }, null, false, true); 
      }
    }, 60000);

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        fetchEmails(100, searchKeyword, { inbox: checkInbox, spam: checkSpam, trash: checkTrash }, null, false, true);
      }
    };
    const handleOnline = () => {
      fetchEmails(100, searchKeyword, { inbox: checkInbox, spam: checkSpam, trash: checkTrash }, null, false, true);
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("online", handleOnline);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("online", handleOnline);
    };
  }, [session, searchKeyword, checkInbox, checkSpam, checkTrash]);

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

  const senderList = useMemo(() => {
    return Object.keys(groupedEmails).filter((sender) => {
      const config = chatConfigs[sender];

      const hasDisplayableEmail = groupedEmails[sender].some((e: any) => {
        const isTrash = e.labelIds?.includes("TRASH");
        const isSpam = e.labelIds?.includes("SPAM");
        const isInbox = !isTrash && !isSpam;

        if (isInbox && (config?.isHidden || chatConfigs[e.id]?.isHidden)) return false;

        if (revealedCrossPrompts.includes(e.id)) return true;
        if (isTrash) return checkTrash;
        if (isSpam) return checkSpam;
        return checkInbox;
      });

      if (!hasDisplayableEmail && (!config?.isPinned || !checkInbox)) return false;

      if (checkHasSent) {
        const hasSent = groupedEmails[sender].some((e: any) => e.isMe || e.labelIds?.includes("SENT"));
        if (!hasSent) return false;
      }
      return true;
    }).sort((a, b) => {
      const pinA = (chatConfigs[a]?.isPinned && checkInbox) ? 1 : 0; 
      const pinB = (chatConfigs[b]?.isPinned && checkInbox) ? 1 : 0; 
      if (pinA !== pinB) return pinB - pinA;
      const timeA = new Date(groupedEmails[a][0].date).getTime(); 
      const timeB = new Date(groupedEmails[b][0].date).getTime(); 
      return (isNaN(timeB) ? 0 : timeB) - (isNaN(timeA) ? 0 : timeA);
    });
  }, [groupedEmails, chatConfigs, checkHasSent, checkInbox, checkSpam, checkTrash, revealedCrossPrompts]); 

  const hiddenChats = Object.keys(chatConfigs).filter(k => chatConfigs[k]?.isHidden && chatConfigs[k]?.roomId === undefined); 
  const hiddenMsgs = Object.keys(chatConfigs).filter(k => chatConfigs[k]?.isHidden && chatConfigs[k]?.roomId !== undefined).map(id => allUniqueEmails.find(e => e.id === id) || { id, subject: "過去のメッセージ", date: new Date().toISOString() });

  const safeBack = () => {
    const state = window.history.state;
    if (state && (state.action || state.chat)) {
      window.history.back();
    } else {
      setModal(null); setContextMenu(null); setSelectionMode("none"); setSelectedIds([]);
    }
  };

  const openChat = async (sender: string) => {
    setSelectedSender(sender);
    if (typeof window !== "undefined") {
      sessionStorage.setItem("remail_selected_sender", sender);
    }
    setSelectionMode("none");
    setSelectedIds([]);
    setReplyToMessage(null);
    setMsgStatusMessage(null); 
    setChatNextPageToken("FIRST_PAGE"); // トークン初期化
    if (isMobile) window.history.pushState({ chat: sender }, '', `#chat`);
    fetchChatCrossbox(sender, false); // 即座に1ページ目を展開
  };

  const handleMenuBarClick = (mode: SelectionMode) => {
    if (mode === "chat_reset" || mode === "msg_reset") {
      setResetOptions({ pin: true, hide: true, name: true });
      setModal({ type: "confirm_reset", targetMode: mode.startsWith("chat") ? "all_chats" : "current_chat", targets: mode === "msg_reset" ? [selectedSender!] : [] });
      setSelectionMode("none"); 
      window.history.pushState({ action: "modal" }, "", window.location.href); 
      return;
    }

    if (selectionMode === mode) {
      if (selectedIds.length === 0) { safeBack(); return; } 
      const targetMode = mode.startsWith("chat") ? "chat" : "msg";
      let actionType: any = "confirm_hide";
      if (mode.includes("delete")) actionType = "confirm_delete"; 
      if (mode.includes("pin")) actionType = "confirm_pin_execute"; 
      if (mode.includes("move")) actionType = "confirm_move";
      
      setModal({ type: actionType, targetMode, targets: selectedIds });
      window.history.replaceState({ action: "modal" }, "", window.location.href); 
    } else {
      if (mode.includes("move")) { 
        setModal({ type: "select_move_dest", targetMode: mode.startsWith("chat") ? "chat" : "msg", targets: [] }); 
        window.history.pushState({ action: "modal" }, "", window.location.href); 
        return; 
      }
      if (mode.includes("pin")) { 
        setModal({ type: "select_pin_type" as any, targetMode: mode.startsWith("chat") ? "chat" : "msg", targets: [] }); 
        window.history.pushState({ action: "modal" }, "", window.location.href); 
        return; 
      }
      setSelectionMode(mode); setSelectedIds([]);
      if (!hasPushedSelectRef.current) { 
        window.history.pushState({ action: "select" }, "", window.location.href); 
        hasPushedSelectRef.current = true; 
      }
    }
  };

  const handleBackgroundClick = () => { 
    if (modal || contextMenu) return; 
    if (selectionMode !== "none") safeBack(); 
  };

  const toggleSelection = (id: string) => setSelectedIds(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]);

  const handleSend = async () => {
    if (!selectedSender || !replyBody.trim()) return;
    setIsSending(true);
    try {
      const targetEmails = groupedEmails[selectedSender]; const actualTo = targetEmails ? targetEmails[0]?.from : selectedSender;
      let finalBody = replyBody; let threadId = undefined; let finalSubject = replySubject;
      if (replyToMessage) { finalBody = `${replyBody}\n\n> ${replyToMessage.body.replace(/\n/g, "\n> ")}`; threadId = replyToMessage.threadId; if (!finalSubject) finalSubject = replyToMessage.subject.startsWith("Re:") ? replyToMessage.subject : `Re: ${replyToMessage.subject}`; }
      const res = await fetch("/api/emails", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "send", to: actualTo, subject: finalSubject, body: finalBody, threadId })
      });
      if (res.ok) {
        const sentFake = { id: `fake-${Date.now()}`, threadId: threadId || "", subject: finalSubject || "(件名なし)", from: session?.user?.email || "自分", date: new Date().toUTCString(), body: finalBody, snippet: finalBody.slice(0, 60), senderRoom: selectedSender, isMe: true, labelIds: ["SENT"] };
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
                pData = (groupedEmails[targetId] || [])
                           .filter(e => e.labelIds?.includes("INBOX"))
                           .map(e => ({ ...e, senderRoom: targetId })); 
                pMsgs.push(...pData); 
            } 
            else { 
                const found = allUniqueEmails.find(e => e.id === targetId); 
                if (found && found.labelIds?.includes("INBOX")) { 
                    pData = { ...found, senderRoom: selectedSender }; 
                    pMsgs.push(pData); 
                } 
            }
        }
        updateChatConfig(targetId, { isPinned: true, forceFetch, persistedData: pData });
    });
    setPersistedEmails(pMsgs); safeBack(); 
  };

  const getActionableEmails = (targets: string[], targetMode: string) => {
    let result: any[] = [];
    if (targetMode === "chat") {
      targets.forEach((chat: string) => {
        const chatEmails = groupedEmails[chat] || [];
        result.push(...chatEmails.filter((e: any) => {
          const isTrash = e.labelIds?.includes("TRASH");
          const isSpam = e.labelIds?.includes("SPAM");
          const isInbox = !isTrash && !isSpam;
          const isCurrentBox = (isTrash && checkTrash) || (isSpam && checkSpam) || (isInbox && checkInbox);
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
      const permanentIds = deleteEmails.filter(e => e.labelIds?.includes("TRASH")).map(e => e.id);
      const trashIds = deleteEmails.filter(e => !e.labelIds?.includes("TRASH")).map(e => e.id);

      if (permanentIds.length > 0 || trashIds.length > 0) {
        try {
          const applyTrashLabels = (e: any) => {
            if (trashIds.includes(e.id)) {
              let newLabels = (e.labelIds || []).filter((l: string) => l !== "INBOX" && l !== "SPAM");
              if (!newLabels.includes("TRASH")) newLabels.push("TRASH");
              return { ...e, labelIds: newLabels };
            }
            return e;
          };
          
          const nextEmails = emails.map(applyTrashLabels).filter(e => !permanentIds.includes(e.id));
          const nextPersisted = persistedEmails.map(applyTrashLabels).filter(e => !permanentIds.includes(e.id));
          
          const combined = new Map();
          nextPersisted.forEach(e => combined.set(e.id, e));
          nextEmails.forEach(e => combined.set(e.id, e));
          
          const nextPMsgs = syncConfigs(Array.from(combined.values()), chatConfigsRef.current);
          
          setEmails(nextEmails); 
          setPersistedEmails(nextPMsgs);
          setRevealedCrossPrompts(prev => prev.filter(id => !permanentIds.includes(id) && !trashIds.includes(id)));

          localforage.setItem(getCacheKey({ inbox: checkInbox, spam: checkSpam, trash: checkTrash }), { emails: nextEmails.slice(0, 100), flags: { inbox: checkInbox, spam: checkSpam, trash: checkTrash } });
          if (targetMode === "chat" && targets.includes(selectedSender)) setSelectedSender(null);
          
          fetch("/api/emails", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "delete", permanentIds, trashIds }) }).catch(e => console.error(e));
        } catch (e) { console.error(e); }
      }
    } 
    else if (type === "confirm_move") {
      const emailsToMove = getActionableEmails(targets, targetMode);
      const idsToMove = emailsToMove.filter(e => !e.labelIds?.includes(moveDestination!)).map(e => e.id);
      
      if (idsToMove.length > 0) {
        try {
          const applyNewLabels = (e: any) => {
            if (idsToMove.includes(e.id)) { let newLabels = (e.labelIds || []).filter((l: string) => l !== "INBOX" && l !== "TRASH" && l !== "SPAM"); newLabels.push(moveDestination); return { ...e, labelIds: newLabels }; }
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

          localforage.setItem(getCacheKey({ inbox: checkInbox, spam: checkSpam, trash: checkTrash }), { emails: nextEmails.slice(0, 100), flags: { inbox: checkInbox, spam: checkSpam, trash: checkTrash } });
          if (targetMode === "chat" && targets.includes(selectedSender)) setSelectedSender(null);

          fetch("/api/emails", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "move", ids: idsToMove, destination: moveDestination }) }).catch(e => console.error(e));
        } catch (e) { console.error(e); }
      }
    }
    else if (type === "confirm_hide") {
      targets.forEach(target => updateChatConfig(target, { isHidden: true, hiddenAtDate: new Date().toISOString(), roomId: targetMode === "msg" ? selectedSender! : undefined }));
      if (targetMode === "chat" && targets.includes(selectedSender)) setSelectedSender(null);
    }
    else if (type === "confirm_reset") {
      const { pin, hide, name } = resetOptions; const specificTarget = targets[0]; let keysToProcess = Object.keys(chatConfigs);
      if (targetMode === "current_chat" || targetMode === "specific_chat") keysToProcess = keysToProcess.filter(k => k === specificTarget || chatConfigs[k]?.roomId === specificTarget);
      keysToProcess.forEach(target => {
        const currentConfig = chatConfigs[target]; const updates: Partial<ChatConfig> = {};
        if (pin) { updates.isPinned = false; updates.forceFetch = false; updates.persistedData = null; }
        if (hide) { updates.isHidden = false; updates.hiddenAtDate = undefined; updates.unhideOnNew = false; }
        if (name && currentConfig?.roomId === undefined) updates.customName = undefined;
        if (Object.keys(updates).length > 0) updateChatConfig(target, updates);
      });
      if (pin) setPersistedEmails(prev => prev.filter(e => !keysToProcess.includes(e.id) && !keysToProcess.includes(e.senderRoom)));
    }
    else if (type === "confirm_unhide") { targets.forEach(target => updateChatConfig(target, { isHidden: false })); }
    
    safeBack(); 
  };

  const handleContextMenuAction = (action: string, target: any) => {
    setContextMenu(null);
    const mode = contextMenu?.type || "chat"; const targetId = typeof target === "string" ? target : target.id;
    let newModal = null;
    if (action === "hide") newModal = { type: "confirm_hide", targetMode: mode, targets: [targetId] };
    if (action === "delete") newModal = { type: "confirm_delete", targetMode: mode, targets: [targetId] };
    if (action === "pin") newModal = { type: "confirm_pin", targetMode: mode, targets: [targetId] };
    if (action === "move") newModal = { type: "select_move_dest_context", targetMode: mode, targets: [targetId] };
    if (action === "reset") { setResetOptions({ pin: true, hide: true, name: true }); newModal = { type: "confirm_reset", targetMode: "specific_chat", targets: [targetId] }; }
    if (action === "rename") { setRenameInput(chatConfigs[targetId]?.customName || targetId); newModal = { type: "rename", targetMode: mode, targets: [targetId] }; }
    
    if (newModal) { setModal(newModal as ModalState); window.history.pushState({ action: "modal" }, "", window.location.href); }
    if (action === "unpin") { updateChatConfig(targetId, { isPinned: false, forceFetch: false, persistedData: null }); setPersistedEmails(prev => prev.filter(e => e.id !== targetId && e.senderRoom !== targetId)); }
    if (action === "reply") setReplyToMessage(target);
    if (action === "copy") navigator.clipboard.writeText(target.body);
    if (action === "forward") { setReplyBody(`【転送メッセージ】\n${target.body}`); setReplySubject("Fwd:"); }
  };

  const handleLoadMoreChats = async () => {
    if (isLoadingMoreChats || !currentNextPageToken) { if (!currentNextPageToken) setChatStatusMessage("すべてのメールを読み込みました"); return; }
    setIsLoadingMoreChats(true); setChatStatusMessage(null);
    let tempToken = currentNextPageToken; let hasNewSender = false; let loopCount = 0; const maxLoops = 5; 
    const currentLoadId = activeLoadRef.current;

    try {
      const currentSenders = new Set(Object.keys(groupedEmails));
      while (!hasNewSender && tempToken && loopCount < maxLoops) {
        if (activeLoadRef.current !== currentLoadId) break;
        loopCount++; let qParts = []; let orLabels = [];
        if (checkInbox) orLabels.push("in:inbox", "in:sent"); if (checkSpam) orLabels.push("in:spam"); if (checkTrash) orLabels.push("in:trash");
        if (orLabels.length > 0) qParts.push(`(${orLabels.join(" OR ")})`); if (searchKeyword) qParts.push(searchKeyword);

        const params = new URLSearchParams({ maxResults: "100", q: qParts.join(" ").trim(), includeTrash: "true", pageToken: tempToken });
        const res = await fetch(`/api/emails?${params.toString()}`);
        if (!res.ok) { setChatStatusMessage("メールが読み込めませんでした。しばらくしてからもう一度お試しください。"); break; }

        const data = await res.json(); const newMessages = data.messages || []; tempToken = data.nextPageToken || null;
        if (newMessages.length === 0) { setChatStatusMessage("すべてのメールを読み込みました"); setCurrentNextPageToken(null); break; }

        const hasNew = newMessages.some((email: any) => {
          if (chatConfigs[email.id]?.isHidden) return false;
          if (email.senderRoom) return !currentSenders.has(email.senderRoom);
          const isMe = email.isMe || email.from.includes(session?.user?.email || "");
          if (!isMe) { const roomName = email.from.split("<")[0].replace(/"/g, "").trim() || "Unknown"; return !currentSenders.has(roomName); } 
          else { const toClean = email.to ? email.to.split(",")[0].split("<")[0].replace(/"/g, "").trim() : ""; return toClean && !currentSenders.has(toClean); }
        });

        setEmails(prev => [...prev, ...newMessages]); setCurrentNextPageToken(tempToken);
        if (hasNew) { hasNewSender = true; }
      }
      if (loopCount >= maxLoops && !hasNewSender) setChatStatusMessage("APIの上限に達しました。しばらくしてからもう一度お試しください。");
      else if (!tempToken && !hasNewSender) setChatStatusMessage("すべてのメールを読み込みました");
    } catch (error) { setChatStatusMessage("エラーが発生しました。"); } finally { setIsLoadingMoreChats(false); }
  };

  // ★修正: リレー処理の破綻を解消し、完全に読み込みが終わるまでボタンを表示（バグ②の修正）
  const handleLoadMoreMessage = async () => {
    if (isLoadingMore || chatNextPageToken === "END") {
        setMsgStatusMessage("すべてのメールを読み込みました");
        return;
    }
    setIsLoadingMore(true); 
    setMsgStatusMessage(null);
    
    const result = await fetchChatCrossbox(selectedSender!, true);
    if (result.nextToken === "END") {
        setMsgStatusMessage("すべてのメールを読み込みました");
    }
    setIsLoadingMore(false);
  };

  const pinnedMsgsInChat = checkInbox ? (groupedEmails[selectedSender!] || []).filter(e => chatConfigs[e.id]?.isPinned && e.labelIds?.includes("INBOX")) : [];

  return {
    auth: { session, status },
    state: {
      emails, persistedEmails, isLoading, selectedSender, chatConfigs,
      isLoadingMore, searchKeyword, checkInbox, checkSpam, checkTrash, checkHasSent,
      currentNextPageToken, chatStatusMessage, msgStatusMessage, isLoadingMoreChats,
      replySubject, replyBody, isSending, replyToMessage,
      hasMouse, isMobile, selectionMode, selectedIds, contextMenu, modal, renameInput,
      resetOptions, moveDestination, revealedCrossPrompts, boxColors, pinType
    },
    actions: {
      setSearchKeyword, setCheckInbox, setCheckSpam, setCheckTrash, setCheckHasSent,
      setReplySubject, setReplyBody, setReplyToMessage, setSelectionMode, setSelectedIds, setContextMenu, setModal, setRenameInput,
      setResetOptions, setMoveDestination, setRevealedCrossPrompts, updateChatConfig,
      handleSearchChange, handleMenuBarClick, handleBackgroundClick, toggleSelection,
      handleSend, executePin, executeConfirmedAction, handleContextMenuAction,
      openChat, handleLoadMoreChats, handleLoadMoreMessage, safeBack, setPinType
    },
    computed: { allUniqueEmails, groupedEmails, senderList, hiddenChats, hiddenMsgs, pinnedMsgsInChat },
    refs: { touchTimer, hasPushedSelectRef, hasPushedSearchRef, activeLoadRef, searchTimeoutRef }
  };
}

export type MailAppHook = ReturnType<typeof useMailApp>;