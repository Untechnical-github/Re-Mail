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
  
  const [knownBoxes, setKnownBoxes] = useState<Record<string, string[]>>({});

  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState("");
  const [checkInbox, setCheckInbox] = useState<boolean>(true);
  const [checkArchive, setCheckArchive] = useState<boolean>(true);
  const [checkSpam, setCheckSpam] = useState<boolean>(false);
  const [checkTrash, setCheckTrash] = useState<boolean>(false);
  const [checkSent, setCheckSent] = useState<boolean>(false);
  const [currentNextPageToken, setCurrentNextPageToken] = useState<string | null>(null);
  
  const [chatNextPageToken, setChatNextPageToken] = useState<string | null>("FIRST_PAGE");
  
  const [chatStatusMessage, setChatStatusMessage] = useState<string | null>(null);
  const [msgStatusMessage, setMsgStatusMessage] = useState<string | null>(null);
  const [isLoadingMoreChats, setIsLoadingMoreChats] = useState(false);

  const loadingMoreChatsRef = useRef(false);
  const loadingMoreMsgRef = useRef(false);

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
  const [moveDestination, setMoveDestination] = useState<"INBOX" | "ARCHIVE" | "SPAM" | "TRASH" | null>(null);
  const [revealedCrossPrompts, setRevealedCrossPrompts] = useState<string[]>([]);
  const [pinType, setPinType] = useState<boolean | null>(null);

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
  const isInitialFilterRun = useRef(true); 
  const knownBoxesTimer = useRef<NodeJS.Timeout | null>(null); 
  
  const chatConfigsRef = useRef(chatConfigs);
  useEffect(() => { chatConfigsRef.current = chatConfigs; }, [chatConfigs]);

  const emailsRef = useRef(emails);
  useEffect(() => { emailsRef.current = emails; }, [emails]);

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
          if (c.chat_id === "__KNOWN_BOXES__" && c.custom_name) {
            try { setKnownBoxes(JSON.parse(c.custom_name)); } catch (e) {} return;
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

  const saveGlobalSettings = async (inbox: boolean, archive: boolean, spam: boolean, trash: boolean, sent: boolean) => {
    if (typeof window !== "undefined") {
      localStorage.setItem("remail_box_settings", JSON.stringify({ inbox, archive, spam, trash, sent }));
    }
  };

  const saveKnownBoxesToD1 = async (boxes: Record<string, string[]>) => {
    try { await fetch("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: "__KNOWN_BOXES__", custom_name: JSON.stringify(boxes) }) }); } catch (e) { console.error(e); }
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
          const hasInboxOrArchive = latestEmails.some(e => {
             const room = e.senderRoom || (e.from.split("<")[0].replace(/"/g, "").trim() || "Unknown");
             return room === targetId && !e.labelIds?.includes("TRASH") && !e.labelIds?.includes("SPAM");
          });
          if (!hasInboxOrArchive) {
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

  useEffect(() => {
    if (!selectedSender && isMobile) {
      setTimeout(() => {
        const asideScroll = sessionStorage.getItem("remail_scroll_aside");
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
      
      if (flags.archive) {
        if (!flags.inbox) qParts.push("-in:inbox");
      } else {
        let orLabels = [];
        if (flags.inbox) orLabels.push("in:inbox");
        if (flags.sent) orLabels.push("in:sent");
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
        await localforage.clear();
        signOut({ callbackUrl: "/" });
        window.location.href = "/";
        return { success: false, emails: currentEmailsState };
      }

      if (res.ok) {
        if (getIsCancelled()) return { success: false, emails: currentEmailsState };
        const data = await res.json();
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

  useEffect(() => {
    if (session && !initLoadDoneRef.current) {
      initLoadDoneRef.current = true;
      const initLoad = async () => {
        try {
          setIsLoading(true);
          await loadD1Configs();
          
          let localSettings: any = null;
          if (typeof window !== "undefined") {
            const saved = localStorage.getItem("remail_box_settings");
            if (saved) {
              try { localSettings = JSON.parse(saved); } catch (e) {}
            }
          }

          const initInbox = localSettings?.inbox ?? true; 
          const initArchive = localSettings?.archive ?? true; 
          const initSpam = localSettings?.spam ?? false; 
          const initTrash = localSettings?.trash ?? false;
          const initSent = localSettings?.sent ?? false;
          setCheckInbox(initInbox); setCheckArchive(initArchive); setCheckSpam(initSpam); setCheckTrash(initTrash); setCheckSent(initSent);
          
          setEmails([]);
          
          const res = await fetchEmails(100, "", { inbox: initInbox, archive: initArchive, spam: initSpam, trash: initTrash, sent: initSent }, null, false, false, [], () => false, true);

          if (selectedSender && res.success) {
            fetchChatCrossbox(selectedSender, false, res.emails);
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

  const fetchChatCrossbox = async (sender: string, isLoadMore = false, knownEmails = emailsRef.current) => {
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
        setChatNextPageToken(nextToken); 
        
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
    
    let isCancelled = false; 
    activeLoadRef.current += 1;

    const handleFilterChange = async () => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
      searchTimeoutRef.current = setTimeout(async () => {
        await saveGlobalSettings(checkInbox, checkArchive, checkSpam, checkTrash, checkSent);
        let loadedEmails = emailsRef.current;
        
        if (!isCancelled) setChatStatusMessage(null);
        const res = await fetchEmails(100, searchKeyword, { inbox: checkInbox, archive: checkArchive, spam: checkSpam, trash: checkTrash, sent: checkSent }, null, false, false, loadedEmails, () => isCancelled, false);
        
        if (selectedSender && !isCancelled && res.success) {
           fetchChatCrossbox(selectedSender, false, res.emails);
        }
      }, searchKeyword ? 300 : 0);
    };
    handleFilterChange();
    return () => { isCancelled = true; if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current); };
  }, [checkInbox, checkArchive, checkSpam, checkTrash, checkSent, searchKeyword]);

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

  useEffect(() => {
    if (Object.keys(groupedEmails).length === 0) return;
    
    setKnownBoxes(prev => {
      const next = { ...prev };
      let hasChanged = false;
      const activeSender = selectedSender;

      Object.keys(groupedEmails).forEach(sender => {
        const emails = groupedEmails[sender];
        const currentBoxes = new Set<string>();
        
        emails.forEach(e => {
          if (e.labelIds?.includes("TRASH")) currentBoxes.add("TRASH");
          else if (e.labelIds?.includes("SPAM")) currentBoxes.add("SPAM");
          else if (e.labelIds?.includes("INBOX")) currentBoxes.add("INBOX");
          else if (e.labelIds?.includes("SENT") || e.isMe) currentBoxes.add("SENT"); 
          else currentBoxes.add("ARCHIVE"); 
        });
        
        const prevBoxes = prev[sender] || [];
        const mergedBoxes = new Set(prevBoxes);
        
        if (sender === activeSender) {
          mergedBoxes.clear();
          currentBoxes.forEach(b => mergedBoxes.add(b));
        } else {
          currentBoxes.forEach(b => mergedBoxes.add(b));
        }
        
        const nextArray = Array.from(mergedBoxes).sort();
        const prevArray = prevBoxes.sort();
        
        if (JSON.stringify(nextArray) !== JSON.stringify(prevArray)) {
          next[sender] = nextArray;
          hasChanged = true;
        }
      });
      
      if (hasChanged) {
        if (knownBoxesTimer.current) clearTimeout(knownBoxesTimer.current);
        knownBoxesTimer.current = setTimeout(() => saveKnownBoxesToD1(next), 2000); 
        return next;
      }
      return prev;
    });
  }, [groupedEmails, selectedSender]);

  const prevFiltersRef = useRef({ checkInbox, checkArchive, checkSpam, checkTrash, checkSent }); 

  useEffect(() => {
    const prev = prevFiltersRef.current;
    const changed = prev.checkInbox !== checkInbox || prev.checkArchive !== checkArchive || prev.checkSpam !== checkSpam || prev.checkTrash !== checkTrash || prev.checkSent !== checkSent; 

    if (changed) {
      prevFiltersRef.current = { checkInbox, checkArchive, checkSpam, checkTrash, checkSent }; 

      if (selectedSender && !isLoading) {
        const targetEmails = groupedEmails[selectedSender] || [];
        const hasVisible = targetEmails.some((e: any) => {
          const isTrash = e.labelIds?.includes("TRASH");
          const isSpam = e.labelIds?.includes("SPAM");
          const isInbox = e.labelIds?.includes("INBOX");
          const isSent = e.labelIds?.includes("SENT") || e.isMe; 
          const isArchive = !isTrash && !isSpam && !isInbox && !isSent; 
          
          let isCurrentBox = false;
          if (isSent) {
            isCurrentBox = checkSent;
          } else {
            isCurrentBox = (isTrash && checkTrash) || (isSpam && checkSpam) || (isInbox && checkInbox) || (isArchive && checkArchive);
          }
          return isCurrentBox || revealedCrossPrompts.includes(e.id);
        });

        if (!hasVisible && !chatConfigs[selectedSender]?.isPinned) {
          setSelectedSender(null);
          if (typeof window !== "undefined") {
            sessionStorage.removeItem("remail_selected_sender");
            sessionStorage.removeItem("remail_scroll_main");
          }
        }
      }
    }
  }, [checkInbox, checkArchive, checkSpam, checkTrash, checkSent, selectedSender, groupedEmails, chatConfigs, revealedCrossPrompts, isLoading]);

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

      let isKnownToDisplay = false;
      if (!hasDisplayableEmail) {
        const kb = knownBoxes[sender] || [];
        const knownHasTrash = kb.includes("TRASH");
        const knownHasSpam = kb.includes("SPAM");
        const knownHasInbox = kb.includes("INBOX");
        const knownHasArchive = kb.includes("ARCHIVE");
        const knownHasSent = kb.includes("SENT");
        
        if (!config?.isHidden || (!knownHasInbox && !knownHasArchive && !knownHasSent)) {
          // 記憶データにも絶対権限を適用
          if (knownHasSent) {
             if (checkSent) isKnownToDisplay = true;
          } else {
             if (knownHasTrash && checkTrash) isKnownToDisplay = true;
             if (knownHasSpam && checkSpam) isKnownToDisplay = true;
             if (knownHasArchive && checkArchive) isKnownToDisplay = true;
             if (knownHasInbox && checkInbox) isKnownToDisplay = true;
          }
        }
      }

      if (!hasDisplayableEmail && !isKnownToDisplay && (!config?.isPinned || (!checkInbox && !checkArchive && !checkSent))) return false;
      return true;
      
    }).sort((a: string, b: string): number => {
      const pinA = (chatConfigs[a]?.isPinned && (checkInbox || checkArchive || checkSent)) ? 1 : 0; 
      const pinB = (chatConfigs[b]?.isPinned && (checkInbox || checkArchive || checkSent)) ? 1 : 0; 
      if (pinA !== pinB) return pinB - pinA;
      
      const timeA = getLatestValidDate(a);
      const timeB = getLatestValidDate(b);
      return (isNaN(timeB) ? 0 : timeB) - (isNaN(timeA) ? 0 : timeA);
    });
  }, [groupedEmails, chatConfigs, checkSent, checkInbox, checkArchive, checkSpam, checkTrash, revealedCrossPrompts, knownBoxes]);

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
      sessionStorage.removeItem("remail_scroll_main"); 
      const asideEl = document.querySelector("aside > div.flex-1");
      if (asideEl) sessionStorage.setItem("remail_scroll_aside", asideEl.scrollTop.toString());
    }
    setSelectionMode("none");
    setSelectedIds([]);
    setReplyToMessage(null);
    setMsgStatusMessage(null); 
    setChatNextPageToken("FIRST_PAGE");
    if (isMobile) window.history.pushState({ chat: sender }, '', `#chat`);
    
    // 初回読み込み
    const result = await fetchChatCrossbox(sender, false); 
    
    // ★追加: メッセージ画面を開いた際、メッセージが少なすぎて画面が埋まらない場合、自動で過去ログをもう1ページ分引っ張ってくる
    if (result && result.found && result.nextToken && !result.nextToken.startsWith("END")) {
      setTimeout(() => {
        handleLoadMoreMessage();
      }, 300);
    }
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

  const executePin = (forceFetch: boolean) => {
    if (!modal) return;
    const pMsgs = [...persistedEmails];
    modal.targets.forEach(targetId => {
        let pData = null;
        if (forceFetch) {
            if (modal.targetMode === "chat") { 
                pData = (groupedEmails[targetId] || [])
                           .filter(e => !e.labelIds?.includes("TRASH") && !e.labelIds?.includes("SPAM"))
                           .map(e => ({ ...e, senderRoom: targetId })); 
                pMsgs.push(...pData); 
            } 
            else { 
                const found = allUniqueEmails.find(e => e.id === targetId); 
                if (found && !found.labelIds?.includes("TRASH") && !found.labelIds?.includes("SPAM")) { 
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
      const permanentIds = deleteEmails.filter(e => e.labelIds?.includes("TRASH") || e.labelIds?.includes("SENT") || e.isMe).map(e => e.id);
      const trashIds = deleteEmails.filter(e => !e.labelIds?.includes("TRASH") && !e.labelIds?.includes("SENT") && !e.isMe).map(e => e.id);

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

          setKnownBoxes(prev => {
            const next = { ...prev };
            modal.targets.forEach(t => { if (targetMode === "chat") next[t] = ["TRASH"]; });
            saveKnownBoxesToD1(next);
            return next;
          });

          if (targetMode === "chat" && targets.includes(selectedSender)) setSelectedSender(null);
          
          fetch("/api/emails", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "delete", permanentIds, trashIds }) }).catch(e => console.error(e));
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

          setKnownBoxes(prev => {
            const next = { ...prev };
            modal.targets.forEach(t => { if (targetMode === "chat") next[t] = [moveDestination === "ARCHIVE" ? "ARCHIVE" : moveDestination!]; });
            saveKnownBoxesToD1(next);
            return next;
          });

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
    if (loadingMoreChatsRef.current || !currentNextPageToken) { 
        if (!currentNextPageToken && !chatStatusMessage) setChatStatusMessage("すべてのメールを読み込みました"); 
        return; 
    }
    loadingMoreChatsRef.current = true;
    setIsLoadingMoreChats(true); 
    setChatStatusMessage(null);

    let tempToken: string | null = currentNextPageToken;
    let loopCount = 0;
    const maxLoops = 15; 
    let reachedYearLimit = false; 
    const accumulatedEmails: any[] = [];
    const currentLoadId = activeLoadRef.current;
    const oneYearAgoMs = new Date().setFullYear(new Date().getFullYear() - 1); 

    try {
      let qParts = []; 
      let useIncludeTrash = "false";
      
      if (checkTrash || checkSpam) { useIncludeTrash = "true"; }
      if (checkArchive) {
        if (!checkInbox) qParts.push("-in:inbox");
      } else {
        let orLabels = [];
        if (checkInbox) orLabels.push("in:inbox");
        if (checkSent) orLabels.push("in:sent");
        if (checkSpam) orLabels.push("in:spam"); 
        if (checkTrash) orLabels.push("in:trash");
        if (orLabels.length > 0) qParts.push(`(${orLabels.join(" OR ")})`);
      }
      if (searchKeyword) qParts.push(searchKeyword);
      const baseQuery = qParts.join(" ").trim();

      // 表示される「有効なチャットの総数」が画面を埋める（15件以上）か、データが尽きるまでループ
      while (tempToken && loopCount < maxLoops) {
        if (activeLoadRef.current !== currentLoadId) break;
        loopCount++;

        const params = new URLSearchParams({ maxResults: "100", q: baseQuery, includeTrash: useIncludeTrash, pageToken: tempToken });
        params.append("_t", Date.now().toString());

        const res: Response = await fetch(`/api/emails?${params.toString()}`);
        if (!res.ok) { 
          setChatStatusMessage("メールが読み込めませんでした。"); 
          break; 
        }

        const data: any = await res.json(); 
        const rawMessages = data.messages || []; 
        tempToken = data.nextPageToken || null;
        const validMessages: any[] = [];

        for (const email of rawMessages) {
          if (new Date(email.date).getTime() < oneYearAgoMs) { reachedYearLimit = true; } 
          else { validMessages.push(email); }
        }

        if (validMessages.length > 0) {
          accumulatedEmails.push(...validMessages);
        }

        // ★修正: 今回取得したメールを含めて、実際に「画面に描画されるチャット」が何件あるかを厳密にシミュレーション検証する
        const virtualEmails = [...emailsRef.current, ...accumulatedEmails];
        const virtualSenders = new Set<string>();
        const tempGroups: Record<string, any[]> = {};

        // 仮想グループ化
        virtualEmails.forEach(e => {
          const room = e.senderRoom || ((e.isMe || e.from.includes(session?.user?.email || "")) ? (e.to ? e.to.split(",")[0].split("<")[0].replace(/"/g, "").trim() : "Unknown") : (e.from.split("<")[0].replace(/"/g, "").trim() || "Unknown"));
          if (!tempGroups[room]) tempGroups[room] = [];
          tempGroups[room].push(e);
        });

        // 各グループが画面上の表示条件を満たしているか精査
        Object.keys(tempGroups).forEach(sender => {
          const config = chatConfigsRef.current[sender];
          const hasDisplayable = tempGroups[sender].some((e: any) => {
            const isTrash = e.labelIds?.includes("TRASH");
            const isSpam = e.labelIds?.includes("SPAM");
            const isInbox = e.labelIds?.includes("INBOX");
            const isSent = e.labelIds?.includes("SENT") || e.isMe;
            const isArchive = !isTrash && !isSpam && !isInbox && !isSent;

            if ((isInbox || isArchive || isSent) && (config?.isHidden || chatConfigsRef.current[e.id]?.isHidden)) return false;
            if (revealedCrossPrompts.includes(e.id)) return true;

            if (isSent) return checkSent;
            if (isTrash) return checkTrash;
            if (isSpam) return checkSpam;
            if (isArchive) return checkArchive;
            return checkInbox;
          });

          if (hasDisplayable || (config?.isPinned && (checkInbox || checkArchive || checkSent))) {
            virtualSenders.add(sender);
          }
        });

        // ★修正: 画面上の有効な総チャット数が15件以上に達したら、十分に画面が埋まったと判断して安全にループ終了
        if (virtualSenders.size >= 15) {
          break;
        }

        if (reachedYearLimit || !tempToken) break;
      }

      if (accumulatedEmails.length > 0) {
        setEmails(prev => {
          const map = new Map(prev.map(e => [e.id, e]));
          accumulatedEmails.forEach((m: any) => map.set(m.id, m));
          return Array.from(map.values());
        });
      }

      setCurrentNextPageToken(tempToken);

      if (reachedYearLimit) { setChatStatusMessage("Re:Mailの読み込み上限に達しました"); } 
      else if (!tempToken) { setChatStatusMessage("すべてのメールを読み込みました"); }

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

  const pinnedMsgsInChat = (checkInbox || checkArchive || checkSent) ? (groupedEmails[selectedSender!] || []).filter(e => chatConfigs[e.id]?.isPinned && !e.labelIds?.includes("TRASH") && !e.labelIds?.includes("SPAM")) : [];

  return {
    auth: { session, status },
    state: {
      emails, persistedEmails, isLoading, selectedSender, chatConfigs,
      isLoadingMore, searchKeyword, checkInbox, checkArchive, checkSpam, checkTrash, checkSent,
      knownBoxes, currentNextPageToken, chatStatusMessage, msgStatusMessage, isLoadingMoreChats, 
      replySubject, replyBody, isSending, replyToMessage,
      hasMouse, isMobile, selectionMode, selectedIds, contextMenu, modal, renameInput,
      resetOptions, moveDestination, revealedCrossPrompts, boxColors, pinType
    },
    actions: {
      setSearchKeyword, setCheckInbox, setCheckArchive, setCheckSpam, setCheckTrash, setCheckSent,
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