"use client";

import { useSession, signIn, signOut } from "next-auth/react";
import { useState, useEffect, useMemo, useRef } from "react";

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
  targetMode: "chat" | "msg";
  targets: any[];
} | null;

export default function Home() {
  const { data: session, status } = useSession();
  const [emails, setEmails] = useState<any[]>([]);
  const [persistedEmails, setPersistedEmails] = useState<any[]>([]); // ピン留め等で常に保持するデータ
  const [isLoading, setIsLoading] = useState(false);
  const [selectedSender, setSelectedSender] = useState<string | null>(null);
  const [chatConfigs, setChatConfigs] = useState<Record<string, ChatConfig>>({});

  // 読み込み・フィルタリング
  const [limitAmount, setLimitAmount] = useState<number>(10);
  const [startDate, setStartDate] = useState<string>("");
  const [endDate, setEndDate] = useState<string>("");
  const [searchKeyword, setSearchKeyword] = useState("");
  const [checkInbox, setCheckInbox] = useState<boolean>(true);
  const [checkSpam, setCheckSpam] = useState<boolean>(false);
  const [checkTrash, setCheckTrash] = useState<boolean>(false);
  const [currentNextPageToken, setCurrentNextPageToken] = useState<string | null>(null);

  // 送信・作成
  const [replySubject, setReplySubject] = useState("");
  const [replyBody, setReplyBody] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [newAddressInput, setNewAddressInput] = useState("");
  const [selectedForGroup, setSelectedForGroup] = useState<string[]>([]);
  const [replyToMessage, setReplyToMessage] = useState<any | null>(null);

  // UIステート
  const [hasMouse, setHasMouse] = useState(true);
  const [isMobile, setIsMobile] = useState(false);
  const [selectionMode, setSelectionMode] = useState<SelectionMode>("none");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [modal, setModal] = useState<ModalState>(null);
  const [renameInput, setRenameInput] = useState("");
  const touchTimer = useRef<NodeJS.Timeout | null>(null);

  // 全メールデータ（新規取得分 ＋ D1に保存されたピン留め分）を結合して重複を排除
  const allUniqueEmails = useMemo(() => {
    const map = new Map();
    persistedEmails.forEach(e => map.set(e.id, e));
    emails.forEach(e => map.set(e.id, e));
    return Array.from(map.values());
  }, [emails, persistedEmails]);

  // D1から設定データをロード
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

  const saveGlobalSettings = async (limit: number, inbox: boolean, spam: boolean, trash: boolean) => {
    try {
      await fetch("/api/config", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: "__GLOBAL_SETTINGS__", custom_name: JSON.stringify({ limit, inbox, spam, trash }) })
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
    const handlePopState = () => { if (window.location.hash !== '#chat') setSelectedSender(null); };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    if (session) {
      const initLoad = async () => {
        setIsLoading(true);
        const settings = await loadD1Configs();
        const initLimit = settings?.limit ?? 10;
        const initInbox = settings?.inbox ?? true;
        const initSpam = settings?.spam ?? false;
        const initTrash = settings?.trash ?? false;
        setLimitAmount(initLimit); setCheckInbox(initInbox); setCheckSpam(initSpam); setCheckTrash(initTrash);
        await fetchEmails(initLimit, "", { inbox: initInbox, spam: initSpam, trash: initTrash }, null, false, true);
        setIsLoading(false);
      };
      initLoad();
    }
  }, [session]);

  const fetchEmails = async (limit = 10, query = "", flags = { inbox: true, spam: false, trash: false }, pageToken: string | null = null, isLoadMore = false, isSilent = false) => {
    if (!flags.inbox && !flags.spam && !flags.trash) { setEmails([]); if (!isSilent) setIsLoading(false); return; }
    if (!isSilent) setIsLoading(true);
    try {
      let qParts = []; let orLabels = [];
      if (flags.inbox) orLabels.push("in:inbox", "in:sent");
      if (flags.spam) orLabels.push("in:spam");
      if (flags.trash) orLabels.push("in:trash");
      if (orLabels.length > 0) qParts.push(`(${orLabels.join(" OR ")})`);
      if (query) qParts.push(query);
      if (startDate) qParts.push(`after:${startDate}`);
      if (endDate) qParts.push(`before:${endDate}`);

      const params = new URLSearchParams({ maxResults: limit.toString(), q: qParts.join(" ").trim(), includeTrash: "true" });
      if (pageToken) params.append("pageToken", pageToken);

      const res = await fetch(`/api/emails?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        const newMessages = data.messages || [];
        setEmails(isLoadMore ? [...emails, ...newMessages] : newMessages);
        setCurrentNextPageToken(data.nextPageToken);
      }
    } catch (error) { console.error(error); } finally { if (!isSilent) setIsLoading(false); }
  };

  useEffect(() => {
    if (!session) return;
    const interval = setInterval(() => {
      const targetLimit = Math.max(limitAmount, emails.length || 10);
      fetchEmails(targetLimit, searchKeyword, { inbox: checkInbox, spam: checkSpam, trash: checkTrash }, null, false, true);
    }, 60000);
    return () => clearInterval(interval);
  }, [session, limitAmount, searchKeyword, checkInbox, checkSpam, checkTrash, emails]);

  // グルーピングは allUniqueEmails (通常取得 + ピン留め) をベースに行う
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
      if (matchedRoom) groups[matchedRoom].push({ ...email, isMe: true });
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
      return new Date(groupedEmails[b][0].date).getTime() - new Date(groupedEmails[a][0].date).getTime();
    });
  }, [groupedEmails, chatConfigs]);

  const hiddenChats = Object.keys(chatConfigs).filter(k => chatConfigs[k]?.isHidden && chatConfigs[k]?.roomId === undefined); 
  const hiddenMsgs = Object.keys(chatConfigs)
    .filter(k => chatConfigs[k]?.isHidden && chatConfigs[k]?.roomId === selectedSender)
    .map(id => allUniqueEmails.find(e => e.id === id) || { id, subject: "(読み込み範囲外のメッセージ)", date: new Date().toISOString() });

  const openChat = (sender: string) => {
    setSelectedSender(sender);
    setSelectionMode("none");
    setSelectedIds([]);
    setReplyToMessage(null);
    if (isMobile) window.history.pushState({ chat: sender }, '', `#chat`);
  };

  const handleMenuBarClick = (mode: SelectionMode) => {
    if (selectionMode === mode) {
      if (selectedIds.length === 0) { setSelectionMode("none"); return; }
      const targetMode = mode.startsWith("chat") ? "chat" : "msg";
      let actionType: any = "confirm_hide";
      if (mode.includes("delete")) actionType = "confirm_delete";
      if (mode.includes("pin")) actionType = "confirm_pin";
      if (mode.includes("reset")) actionType = "confirm_reset";
      
      setModal({ type: actionType, targetMode, targets: selectedIds });
      setSelectionMode("none");
    } else {
      setSelectionMode(mode);
      setSelectedIds([]);
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
          body: finalBody, snippet: finalBody.slice(0, 60), senderRoom: selectedSender, isMe: true
        };
        setEmails([sentFake, ...emails]); setReplySubject(""); setReplyBody(""); setReplyToMessage(null);
      }
    } catch (error) { console.error(error); } finally { setIsSending(false); }
  };

  // ピン留め実行
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
      targets.forEach(target => {
        updateChatConfig(target, { customName: undefined, isPinned: false, isHidden: false, hiddenAtDate: undefined, unhideOnNew: false, forceFetch: false, persistedData: null, roomId: undefined });
        setPersistedEmails(prev => prev.filter(e => e.id !== target && e.senderRoom !== target));
      });
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
    if (action === "reset") setModal({ type: "confirm_reset", targetMode: mode, targets: [targetId] });
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

  // 現在のチャット内でピン留めされているメッセージ
  const pinnedMsgsInChat = (groupedEmails[selectedSender!] || []).filter(e => chatConfigs[e.id]?.isPinned);

  return (
    <div className="flex h-screen w-full bg-[#313338] overflow-hidden text-gray-200 relative select-none">
      
      {/* ＝＝＝＝ コンテキストメニュー（右クリック / 長押し） ＝＝＝＝ */}
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
                <button onClick={() => handleContextMenuAction("reset", contextMenu.target)} className="w-full text-left px-2 py-2 rounded hover:bg-[#DA373C] hover:text-white transition text-xs">設定をリセット</button>
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
                <div className="h-px bg-[#1E1F22] my-1"></div>
                <button onClick={() => handleContextMenuAction("reset", contextMenu.target)} className="w-full text-left px-2 py-2 rounded hover:bg-[#DA373C] hover:text-white transition text-xs">設定をリセット</button>
              </div>
            );
          })()}
        </div>
      )}

      {/* ＝＝＝＝ 確認モーダルシステム ＝＝＝＝ */}
      {modal && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
          <div className="bg-[#313338] rounded-md shadow-2xl w-full max-w-sm border border-[#1E1F22]">
            
            {/* 削除確認 */}
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

            {/* 非表示確認 */}
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

            {/* ピン留め確認 */}
            {modal.type === "confirm_pin" && (
              <div className="p-5">
                <h2 className="text-lg font-bold text-white mb-2">ピン留め</h2>
                <p className="text-sm text-gray-300 mb-6 leading-relaxed">読み込み対象外（期間外や件数制限など）になった際も、この{modal.targetMode === "chat" ? "チャット" : "メッセージ"}を表示させますか？</p>
                <div className="flex flex-col gap-2">
                  <button onClick={() => executePin(true)} className="w-full py-2.5 bg-[#5865F2] text-white rounded text-sm font-bold hover:bg-[#4752C4]">対象外になっても常に表示する</button>
                  <button onClick={() => executePin(false)} className="w-full py-2.5 bg-[#404249] text-white rounded text-sm font-bold hover:bg-[#4f545c]">対象外になった場合は隠す</button>
                  <button onClick={() => setModal(null)} className="w-full py-2 mt-2 hover:underline text-gray-400 text-sm">キャンセル</button>
                </div>
              </div>
            )}

            {/* 非表示解除確認 */}
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

            {/* 非表示解除 選択画面 */}
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
                  )) : hiddenMsgs.map(m => (
                    <label key={m.id} className="flex items-center gap-3 p-2 hover:bg-[#2B2D31] rounded cursor-pointer">
                      <input type="checkbox" checked={selectedIds.includes(m.id)} onChange={() => toggleSelection(m.id)} className="accent-[#5865F2]" />
                      <div className="text-sm truncate flex-1"><span className="text-gray-400 text-xs mr-2">{new Date(m.date).toLocaleDateString()}</span>{m.subject || m.snippet}</div>
                    </label>
                  ))}
                  {(modal.targetMode === "chat" ? hiddenChats : hiddenMsgs).length === 0 && <div className="text-gray-500 text-sm p-4 text-center">非表示の項目はありません</div>}
                </div>
                <div className="p-4 border-t border-[#1E1F22] flex justify-end gap-3">
                  <button onClick={() => { setModal(null); setSelectedIds([]); }} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
                  <button disabled={selectedIds.length === 0} onClick={() => setModal({ type: "confirm_unhide", targetMode: modal.targetMode, targets: selectedIds })} className="px-4 py-2 bg-[#5865F2] text-white rounded text-sm font-bold hover:bg-[#4752C4] disabled:bg-gray-600 disabled:text-gray-400">次へ ({selectedIds.length})</button>
                </div>
              </div>
            )}

            {/* リセット確認 */}
            {modal.type === "confirm_reset" && (
              <div className="p-5">
                <h2 className="text-lg font-bold text-white mb-2">設定のリセット</h2>
                <p className="text-sm text-gray-300 mb-6 leading-relaxed">ピン留め、非表示、名前変更などの独自設定をすべて初期化します。よろしいですか？</p>
                <div className="flex justify-end gap-3">
                  <button onClick={() => setModal(null)} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
                  <button onClick={executeConfirmedAction} className="px-4 py-2 bg-[#DA373C] text-white rounded text-sm font-bold hover:bg-[#a1282c]">リセットする</button>
                </div>
              </div>
            )}

            {/* 名前変更 */}
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
        <aside className={`${isMobile ? 'w-full' : 'w-[320px] border-r'} border-[#1E1F22] bg-[#2B2D31] flex flex-col`}>
          
          <div className="p-4 border-b border-[#1E1F22] shadow-sm flex items-center justify-between">
            <h1 className="text-xl font-extrabold text-white">Re:Mail</h1>
            <button onClick={() => signOut()} className="text-xs text-gray-400 hover:text-white transition">ログアウト</button>
          </div>

          <div className="p-3 space-y-2 border-b border-[#1E1F22] bg-[#232428]">
             <input type="text" placeholder="キーワード検索..." className="w-full bg-[#1E1F22] text-sm text-gray-300 px-3 py-1.5 rounded focus:outline-none focus:ring-1 focus:ring-[#5865F2]" value={searchKeyword} onChange={(e) => setSearchKeyword(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { fetchEmails(limitAmount, searchKeyword, { inbox: checkInbox, spam: checkSpam, trash: checkTrash }, null, false); saveGlobalSettings(limitAmount, checkInbox, checkSpam, checkTrash); }}} />
             
             <div className="flex items-center gap-1 mt-1">
                <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="bg-[#1E1F22] text-xs text-gray-300 px-2 py-1 rounded flex-1 focus:outline-none" />
                <span className="text-gray-500 text-xs">~</span>
                <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="bg-[#1E1F22] text-xs text-gray-300 px-2 py-1 rounded flex-1 focus:outline-none" />
             </div>

             <div className="flex gap-1 text-xs mt-1">
                <label className="flex items-center gap-1 cursor-pointer bg-[#313338] px-2 py-1.5 rounded flex-1 justify-center hover:bg-[#3f4147]"><input type="checkbox" checked={checkInbox} onChange={(e) => setCheckInbox(e.target.checked)} className="accent-[#5865F2]" /> 受信箱</label>
                <label className="flex items-center gap-1 cursor-pointer bg-[#313338] px-2 py-1.5 rounded flex-1 justify-center hover:bg-[#3f4147]"><input type="checkbox" checked={checkSpam} onChange={(e) => setCheckSpam(e.target.checked)} className="accent-[#5865F2]" /> 迷惑メール</label>
                <label className="flex items-center gap-1 cursor-pointer bg-[#313338] px-2 py-1.5 rounded flex-1 justify-center hover:bg-[#3f4147]"><input type="checkbox" checked={checkTrash} onChange={(e) => setCheckTrash(e.target.checked)} className="accent-[#5865F2]" /> ゴミ箱</label>
             </div>
             
             <div className="flex items-center gap-2 mt-2">
               <span className="text-[10px] font-bold text-gray-500 w-8">{limitAmount}件</span>
               <input type="range" min="1" max="100" value={limitAmount} onChange={(e) => setLimitAmount(Number(e.target.value))} className="flex-1 h-1 bg-[#1E1F22] rounded appearance-none" />
               <button onClick={() => { fetchEmails(limitAmount, searchKeyword, { inbox: checkInbox, spam: checkSpam, trash: checkTrash }, null, false); saveGlobalSettings(limitAmount, checkInbox, checkSpam, checkTrash); }} disabled={isLoading} className="text-xs bg-[#5865F2] text-white px-3 py-1.5 rounded font-bold hover:bg-[#4752C4]">読込</button>
             </div>
          </div>

          {/* チャット用 アクションバー */}
          <div className="flex flex-wrap p-2 gap-1 border-b border-[#1E1F22] bg-[#2B2D31]">
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
              {selectionMode === "chat_reset" ? `実行(${selectedIds.length})` : "リセット"}
            </button>
            <button onClick={() => { setModal({ type: "unhide_select", targetMode: "chat", targets: [] }); setSelectedIds([]); setSelectionMode("none"); }} className={`px-3 py-1.5 text-[11px] font-bold rounded bg-[#1E1F22] text-gray-400 hover:bg-[#3f4147] hover:text-gray-200 ${selectionMode.startsWith("chat_") ? 'opacity-30 pointer-events-none' : ''}`}>非表示解除</button>
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
             {senderList.map((sender) => {
              const latestEmail = groupedEmails[sender][0];
              const isSelected = selectedIds.includes(sender);
              const isOpened = selectedSender === sender && !isMobile;
              const config = chatConfigs[sender];

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
                        <span className="font-bold text-sm truncate">{config?.customName || sender}</span>
                      </div>
                    </div>
                    <div className="text-xs text-gray-500 truncate mt-0.5">{latestEmail.subject || "No Subject"}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </aside>
      )}

      {/* ＝＝＝＝ 右ペイン：トーク画面 ＝＝＝＝ */}
      {showTalk && (
        <main className={`${isMobile ? 'w-full' : 'flex-1'} flex flex-col bg-[#313338] relative`}>
          
          <header className="px-4 py-3 bg-[#313338] border-b border-[#1E1F22] shadow-sm z-10 flex items-center gap-3">
            {isMobile && <button onClick={() => { window.history.back(); setSelectionMode("none"); }} className="text-gray-400 hover:text-white font-bold p-1">←</button>}
            <h2 className="font-bold text-base truncate flex-1 text-white">{chatConfigs[selectedSender!]?.customName || selectedSender}</h2>
          </header>

          {/* メッセージ用 アクションバー */}
          <div className="flex flex-wrap px-4 py-2 gap-2 border-b border-[#1E1F22] bg-[#2B2D31]">
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

          {/* ピン留めメッセージのリスト（LINE風 上部ぶら下がり） */}
          {pinnedMsgsInChat.length > 0 && (
            <div className="bg-[#2B2D31] border-b border-[#1E1F22] px-4 py-1.5 flex gap-2 overflow-x-auto scrollbar-none items-center shadow-inner">
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

          {/* メッセージ一覧 (LINE風の左/右レイアウトを採用しつつ、Discordのダークテーマ) */}
          <div className="flex-1 overflow-y-auto px-4 py-6 flex flex-col-reverse scrollbar-thin">
            {groupedEmails[selectedSender!] ? (
              groupedEmails[selectedSender!].map((email) => {
                const isMe = email.isMe || email.from.includes(session?.user?.email || "");
                const isSelected = selectedIds.includes(email.id);

                return (
                  <div 
                    id={`msg-${email.id}`}
                    key={email.id} 
                    className={`flex w-full mb-6 ${isMe ? 'justify-end' : 'justify-start'}`}
                  >
                    {/* 左側のチェックボックス (選択モード時) */}
                    {selectionMode.startsWith("msg_") && (
                      <div className="flex-shrink-0 w-8 flex justify-center pt-3 mr-2" onClick={() => toggleSelection(email.id)}>
                        <div className={`w-5 h-5 rounded-sm flex items-center justify-center border cursor-pointer ${isSelected ? 'bg-[#5865F2] border-[#5865F2]' : 'border-gray-500'}`}>
                          {isSelected && <div className="w-2.5 h-2.5 bg-white rounded-sm"></div>}
                        </div>
                      </div>
                    )}
                    
                    {/* 相手のアイコン */}
                    {!isMe && !selectionMode.startsWith("msg_") && (
                       <div className="w-9 h-9 rounded-full bg-[#DA373C] text-white flex items-center justify-center text-sm font-bold mr-3 flex-shrink-0 mt-1 shadow-sm select-none">
                         {email.from.charAt(0).toUpperCase()}
                       </div>
                    )}

                    <div className={`flex flex-col max-w-[75%] ${isMe ? 'items-end' : 'items-start'}`}>
                       {/* 名前と時間 */}
                       <div className="flex items-center gap-2 mb-1.5 mx-1 text-[11px] text-gray-400 select-none">
                          {!isMe && <span className="font-bold text-gray-300">{email.from.split("<")[0].replace(/"/g, "").trim() || "Unknown"}</span>}
                          <span>{new Date(email.date).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}</span>
                       </div>
                       
                       {/* メッセージバブル */}
                       <div 
                          className={`p-3.5 text-[15px] leading-relaxed break-words whitespace-pre-wrap select-text shadow-sm transition-all cursor-pointer ${isSelected ? 'ring-2 ring-white scale-[0.98]' : ''} ${isMe ? 'bg-[#5865F2] text-white rounded-2xl rounded-tr-sm' : 'bg-[#2B2D31] text-gray-200 border border-[#1E1F22] rounded-2xl rounded-tl-sm hover:bg-[#35373C]'}`}
                          onClick={() => { if (selectionMode.startsWith("msg_")) toggleSelection(email.id); }}
                          onContextMenu={(e) => { e.preventDefault(); setContextMenu({ type: "msg", target: email, x: e.clientX, y: e.clientY }); }}
                          onTouchStart={(e) => { if (!hasMouse) touchTimer.current = setTimeout(() => { setContextMenu({ type: "msg", target: email, x: window.innerWidth/2, y: window.innerHeight/2 }); }, 500); }}
                          onTouchEnd={() => touchTimer.current && clearTimeout(touchTimer.current)}
                          onTouchMove={() => touchTimer.current && clearTimeout(touchTimer.current)}
                       >
                          {chatConfigs[email.id]?.isPinned && <span className="text-[#FEE75C] text-xs mr-2 select-none">📌</span>}
                          {email.subject && !email.subject.startsWith("Re:") && <div className="font-bold text-sm mb-1.5 pb-1.5 border-b border-black/10">{email.subject}</div>}
                          {email.body}
                       </div>
                    </div>

                    {/* 自分のアイコン */}
                    {isMe && !selectionMode.startsWith("msg_") && (
                       <div className="w-9 h-9 rounded-full bg-[#5865F2] text-white flex items-center justify-center text-sm font-bold ml-3 flex-shrink-0 mt-1 shadow-sm select-none">
                         自
                       </div>
                    )}
                  </div>
                );
              })
            ) : null}
          </div>

          <div className="p-4 bg-[#313338]">
            <div className="bg-[#383A40] rounded-lg p-3 border border-[#1E1F22]">
              {replyToMessage && (
                <div className="flex justify-between items-center bg-[#2B2D31] text-gray-300 p-2 rounded text-xs mb-2 border-l-4 border-[#5865F2]">
                  <span className="truncate">Replying to: {replyToMessage.subject || replyToMessage.snippet}</span>
                  <button onClick={() => setReplyToMessage(null)} className="font-bold px-2 hover:text-white">×</button>
                </div>
              )}
              <input type="text" placeholder="件名 (省略可)" value={replySubject} onChange={(e) => setReplySubject(e.target.value)} className="w-full text-sm px-2 py-1 mb-2 bg-transparent text-white focus:outline-none placeholder-gray-500 font-medium border-b border-[#2B2D31]" />
              <div className="flex items-end gap-2">
                <textarea placeholder={`Message to ${chatConfigs[selectedSender!]?.customName || selectedSender}`} rows={isMobile ? 1 : 2} value={replyBody} onChange={(e) => setReplyBody(e.target.value)} className="flex-1 resize-none text-[15px] bg-transparent text-white px-2 py-1 focus:outline-none placeholder-gray-500" />
                <button onClick={handleSend} disabled={isSending || !replyBody.trim()} className="text-white px-4 py-2 rounded font-bold text-sm bg-[#5865F2] hover:bg-[#4752C4] transition disabled:bg-[#3f4147] disabled:text-gray-500 active:scale-95">
                  {isSending ? "..." : "送信"}
                </button>
              </div>
            </div>
          </div>
        </main>
      )}
    </div>
  );
}