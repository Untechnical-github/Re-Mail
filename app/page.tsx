"use client";

import { useSession, signIn, signOut } from "next-auth/react";
import { useState, useEffect, useMemo, useRef } from "react";

type ChatConfig = {
  customName?: string;
  isPinned?: boolean;
  isHidden?: boolean;
  hiddenAtDate?: string;
  unhideOnNew?: boolean;
};

type ModalState = {
  type: "chat_menu" | "msg_menu" | "confirm_delete_chat" | "confirm_delete_msg" | "hide_options" | "rename";
  target: any;
};

export default function Home() {
  const { data: session, status } = useSession();
  const [emails, setEmails] = useState<any[]>([]);
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

  // デバイス判定・UI
  const [hasMouse, setHasMouse] = useState(true);
  const [isMobile, setIsMobile] = useState(false);
  const [selectedChats, setSelectedChats] = useState<string[]>([]);
  const [selectedMessages, setSelectedMessages] = useState<string[]>([]);
  const touchTimer = useRef<NodeJS.Timeout | null>(null);

  // カスタムモーダル
  const [modal, setModal] = useState<ModalState | null>(null);
  const [renameInput, setRenameInput] = useState("");

  // D1から設定データをロード（修正：設定データを返すように変更）
  // D1から設定データをロード
  const loadD1Configs = async (): Promise<{ limit?: number; inbox?: boolean; spam?: boolean; trash?: boolean } | null> => {
    let globalSettings: { limit?: number; inbox?: boolean; spam?: boolean; trash?: boolean } | null = null;
    
    try {
      const res = await fetch("/api/config");
      if (res.ok) {
        const data = await res.json();
        const formatted: Record<string, ChatConfig> = {};
        
        data.configs?.forEach((c: any) => {
          if (c.chat_id === "__GLOBAL_SETTINGS__" && c.custom_name) {
            try {
              globalSettings = JSON.parse(c.custom_name);
            } catch (e) { console.error(e); }
            return;
          }

          formatted[c.chat_id] = {
            customName: c.custom_name || undefined,
            isPinned: c.is_pinned === 1,
            isHidden: c.is_hidden === 1,
            hiddenAtDate: c.hidden_at_date || undefined,
            unhideOnNew: c.unhide_on_new === 1,
          };
        });
        setChatConfigs(formatted);
      }
    } catch (e) { console.error(e); }
    return globalSettings;
  };

  // アプリ全体の読み込み条件をD1に保存
  const saveGlobalSettings = async (limit: number, inbox: boolean, spam: boolean, trash: boolean) => {
    try {
      await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: "__GLOBAL_SETTINGS__",
          custom_name: JSON.stringify({ limit, inbox, spam, trash })
        })
      });
    } catch (e) { console.error(e); }
  };

  const updateChatConfig = async (targetId: string, updates: Partial<ChatConfig>) => {
    const nextConfig = { ...chatConfigs[targetId], ...updates };
    setChatConfigs(prev => ({ ...prev, [targetId]: nextConfig }));
    try {
      await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: targetId,
          custom_name: updates.customName,
          is_pinned: updates.isPinned,
          is_hidden: updates.isHidden,
          hidden_at_date: updates.hiddenAtDate,
          unhide_on_new: updates.unhideOnNew
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
    return () => {
      mediaQuery.removeEventListener('change', handler);
      window.removeEventListener('resize', resizeHandler);
    };
  }, []);

  // 修正：ブラウザバックの確実な検知
  useEffect(() => {
    const handlePopState = () => { 
      // URLに #chat が無ければ一覧画面に戻る
      if (window.location.hash !== '#chat') {
        setSelectedSender(null); 
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // 修正：D1から設定をロード「してから」メールを初回読み込みする
  useEffect(() => {
    if (session) {
      const initLoad = async () => {
        setIsLoading(true);
        const settings = await loadD1Configs();
        
        // D1の設定があれば反映、なければデフォルト
        const initLimit = settings?.limit ?? 10;
        const initInbox = settings?.inbox ?? true;
        const initSpam = settings?.spam ?? false;
        const initTrash = settings?.trash ?? false;

        setLimitAmount(initLimit);
        setCheckInbox(initInbox);
        setCheckSpam(initSpam);
        setCheckTrash(initTrash);

        // 同期した設定を使って取得
        await fetchEmails(initLimit, "", { inbox: initInbox, spam: initSpam, trash: initTrash }, null, false, true);
        setIsLoading(false);
      };
      initLoad();
    }
  }, [session]);

  const fetchEmails = async (limit = 10, query = "", flags = { inbox: true, spam: false, trash: false }, pageToken: string | null = null, isLoadMore = false, isSilent = false) => {
    // 修正：何も選択されていない場合はリストを空にする
    if (!flags.inbox && !flags.spam && !flags.trash) {
      setEmails([]);
      if (!isSilent) setIsLoading(false);
      return;
    }
    
    if (!isSilent) setIsLoading(true);
    try {
      let qParts = [];
      let orLabels = [];
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
        const updatedEmails = isLoadMore ? [...emails, ...newMessages] : newMessages;
        
        // 修正：件数に関わらず無条件でリストを上書き更新する
        setEmails(updatedEmails);
        setCurrentNextPageToken(data.nextPageToken);
      }
    } catch (error) { console.error(error); } finally { 
      if (!isSilent) setIsLoading(false); 
    }
  };

  // 新着メッセージの自動受信タイマー (1分ごと)
  useEffect(() => {
    if (!session) return;
    const interval = setInterval(() => {
      const targetLimit = Math.max(limitAmount, emails.length || 10);
      fetchEmails(targetLimit, searchKeyword, { inbox: checkInbox, spam: checkSpam, trash: checkTrash }, null, false, true);
    }, 60000);
    return () => clearInterval(interval);
  }, [session, limitAmount, searchKeyword, checkInbox, checkSpam, checkTrash, emails]);

  const groupedEmails = useMemo(() => {
    const groups: Record<string, any[]> = {};
    const tempSentEmails: any[] = [];

    emails.forEach((email) => {
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
        const roomMessages = groups[roomName];
        const partnerEmail = roomMessages.find(e => !e.isMe && !e.from.includes(session?.user?.email || ""))?.from.toLowerCase() || "";
        const partnerAddrMatch = partnerEmail.match(/<([^>]+)>/) || [null, partnerEmail];
        const partnerAddr = partnerAddrMatch[1] ? partnerAddrMatch[1].trim() : partnerEmail.trim();

        if ((roomNameLower && toClean.includes(roomNameLower)) || (partnerAddr && toClean.includes(partnerAddr))) {
          matchedRoom = roomName;
          break;
        }
      }
      if (matchedRoom) groups[matchedRoom].push({ ...email, isMe: true });
    });

    Object.keys(groups).forEach(sender => {
      groups[sender].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    });

    return groups;
  }, [emails, session, chatConfigs]);

  const senderList = useMemo(() => {
    return Object.keys(groupedEmails).filter((sender) => {
      const config = chatConfigs[sender];
      if (!config?.isHidden) return true;
      if (config.unhideOnNew && config.hiddenAtDate) {
        const latestEmailTime = new Date(groupedEmails[sender][0].date).getTime();
        const hiddenTime = new Date(config.hiddenAtDate).getTime();
        if (latestEmailTime > hiddenTime) {
          updateChatConfig(sender, { isHidden: false });
          return true;
        }
      }
      return false;
    }).sort((a, b) => {
      const pinA = chatConfigs[a]?.isPinned ? 1 : 0;
      const pinB = chatConfigs[b]?.isPinned ? 1 : 0;
      if (pinA !== pinB) return pinB - pinA;
      return new Date(groupedEmails[b][0].date).getTime() - new Date(groupedEmails[a][0].date).getTime();
    });
  }, [groupedEmails, chatConfigs]);

  const openChat = (sender: string) => {
    setSelectedSender(sender);
    setSelectedMessages([]); 
    setReplyToMessage(null);
    if (isMobile) {
      window.history.pushState({ chat: sender }, '', `#chat`);
    }
  };

  const handleSend = async () => {
    if (!selectedSender || !replyBody.trim()) return;
    setIsSending(true);
    try {
      const targetEmails = groupedEmails[selectedSender];
      const actualTo = targetEmails ? targetEmails[0]?.from : selectedSender;
      let finalBody = replyBody;
      let threadId = undefined;
      let finalSubject = replySubject;

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
        setEmails([sentFake, ...emails]);
        setReplySubject(""); setReplyBody(""); setReplyToMessage(null);
      }
    } catch (error) { console.error(error); } finally { setIsSending(false); }
  };

  const commitAction = async (action: string, target: any) => {
    setModal(null);
    if (action === "delete_chat_confirmed") {
      const targetChat = target;
      const deleteIds = groupedEmails[targetChat]?.map(e => e.id) || [];
      if (deleteIds.length === 0) return;
      try {
        const res = await fetch("/api/emails", {
          method: "DELETE", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: deleteIds })
        });
        if (res.ok) {
          setEmails(emails.filter(e => !deleteIds.includes(e.id)));
          if (selectedSender === targetChat) setSelectedSender(null);
        }
      } catch (e) { console.error(e); }
    } 
    else if (action === "delete_msg_confirmed") {
      const msgId = target.id;
      try {
        const res = await fetch("/api/emails", {
          method: "DELETE", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: [msgId] })
        });
        if (res.ok) setEmails(emails.filter(e => e.id !== msgId));
      } catch (e) { console.error(e); }
    } 
    else if (action === "hide_chat_unhide") {
      updateChatConfig(target, { isHidden: true, unhideOnNew: true, hiddenAtDate: new Date().toISOString() });
      if (selectedSender === target) setSelectedSender(null);
    } 
    else if (action === "hide_chat_keep") {
      updateChatConfig(target, { isHidden: true, unhideOnNew: false, hiddenAtDate: new Date().toISOString() });
      if (selectedSender === target) setSelectedSender(null);
    } 
    else if (action === "hide_msg") {
      updateChatConfig(target.id, { isHidden: true });
    } 
    else if (action === "rename_confirmed") {
      if (renameInput.trim()) updateChatConfig(target, { customName: renameInput.trim() });
      setRenameInput("");
    } 
    else if (action === "pin") {
      const isPinned = chatConfigs[target]?.isPinned;
      updateChatConfig(target, { isPinned: !isPinned });
    } 
    else if (action === "reply") {
      setReplyToMessage(target);
    } 
    else if (action === "copy") {
      navigator.clipboard.writeText(target.body);
    } 
    else if (action === "forward") {
      setReplyBody(`【転送メッセージ】\n${target.body}`);
      setReplySubject("Fwd:");
    }
    setSelectedChats([]); setSelectedMessages([]);
  };

  if (status === "loading") return <div className="flex h-screen items-center justify-center bg-gray-100 text-gray-600">読み込み中...</div>;
  if (!session) return (
    <div className="flex h-screen flex-col items-center justify-center bg-gray-50">
      <h1 className="mb-8 text-5xl font-extrabold text-blue-600">Re:Mail</h1>
      <button onClick={() => signIn("google")} className="rounded-full bg-blue-600 px-8 py-4 font-bold text-white shadow-lg transition hover:bg-blue-700 active:scale-95">Googleでログインして始める</button>
    </div>
  );

  const showChatList = !isMobile || !selectedSender;
  const showTalk = !isMobile || selectedSender;

  return (
    <div className="flex h-screen w-full bg-gray-50 overflow-hidden text-gray-800 relative">
      
      {/* ＝＝＝＝ 全OS共通カスタムモーダルシステム ＝＝＝＝ */}
      {modal && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm overflow-hidden animate-scale-in text-sm">
            {modal.type === "chat_menu" && (
              <div className="flex flex-col divide-y divide-gray-100 font-medium">
                <div className="p-4 bg-gray-50 text-center font-bold text-gray-700 truncate">{chatConfigs[modal.target]?.customName || modal.target}</div>
                <button onClick={() => setModal({ type: "hide_options", target: modal.target })} className="w-full py-3.5 text-center text-gray-700 hover:bg-gray-50 active:bg-gray-100">非表示</button>
                <button onClick={() => { setRenameInput(chatConfigs[modal.target]?.customName || modal.target); setModal({ type: "rename", target: modal.target }); }} className="w-full py-3.5 text-center text-gray-700 hover:bg-gray-50 active:bg-gray-100">チャット名変更</button>
                <button onClick={() => commitAction("pin", modal.target)} className="w-full py-3.5 text-center text-gray-700 hover:bg-gray-50 active:bg-gray-100">{chatConfigs[modal.target]?.isPinned ? "ピン留めを解除" : "ピン留めする"}</button>
                <button onClick={() => setModal({ type: "confirm_delete_chat", target: modal.target })} className="w-full py-3.5 text-center text-red-600 font-bold hover:bg-red-50 active:bg-red-100">削除 (Gmail同期)</button>
                <button onClick={() => setModal(null)} className="w-full py-3.5 text-center text-gray-400 hover:bg-gray-50 active:bg-gray-100">閉じる</button>
              </div>
            )}
            {modal.type === "msg_menu" && (
              <div className="flex flex-col divide-y divide-gray-100 font-medium">
                <div className="p-3 bg-gray-50 text-center text-xs text-gray-500 truncate">メッセージ操作</div>
                <button onClick={() => commitAction("reply", modal.target)} className="w-full py-3.5 text-center text-gray-700 hover:bg-gray-50 active:bg-gray-100">リプライ</button>
                <button onClick={() => commitAction("forward", modal.target)} className="w-full py-3.5 text-center text-gray-700 hover:bg-gray-50 active:bg-gray-100">転送</button>
                <button onClick={() => commitAction("copy", modal.target)} className="w-full py-3.5 text-center text-gray-700 hover:bg-gray-50 active:bg-gray-100">コピー</button>
                <button onClick={() => commitAction("hide_msg", modal.target)} className="w-full py-3.5 text-center text-gray-600 hover:bg-gray-50 active:bg-gray-100">非表示 (Re:Mailのみ)</button>
                <button onClick={() => setModal({ type: "confirm_delete_msg", target: modal.target })} className="w-full py-3.5 text-center text-red-600 font-bold hover:bg-red-50 active:bg-red-100">削除 (Gmail同期)</button>
                <button onClick={() => setModal(null)} className="w-full py-3.5 text-center text-gray-400 hover:bg-gray-50 active:bg-gray-100">閉じる</button>
              </div>
            )}
            {modal.type === "confirm_delete_chat" && (
              <div className="p-6 text-center space-y-4">
                <div className="text-base font-bold text-gray-800">チャットを削除しますか？</div>
                <p className="text-xs text-gray-500 leading-relaxed">このチャット内に読み込まれているすべてのメッセージが、Gmail本体のゴミ箱へ移動されます。</p>
                <div className="flex gap-2 pt-2">
                  <button onClick={() => setModal(null)} className="flex-1 py-2.5 bg-gray-100 text-gray-600 rounded-lg font-bold hover:bg-gray-200 active:scale-95 transition">キャンセル</button>
                  <button onClick={() => commitAction("delete_chat_confirmed", modal.target)} className="flex-1 py-2.5 bg-red-600 text-white rounded-lg font-bold hover:bg-red-700 active:scale-95 transition">削除する</button>
                </div>
              </div>
            )}
            {modal.type === "confirm_delete_msg" && (
              <div className="p-6 text-center space-y-4">
                <div className="text-base font-bold text-gray-800">メッセージを削除しますか？</div>
                <p className="text-xs text-gray-500 leading-relaxed">このメッセージはGmail本体のゴミ箱へ移動されます。</p>
                <div className="flex gap-2 pt-2">
                  <button onClick={() => setModal(null)} className="flex-1 py-2.5 bg-gray-100 text-gray-600 rounded-lg font-bold hover:bg-gray-200 active:scale-95 transition">キャンセル</button>
                  <button onClick={() => commitAction("delete_msg_confirmed", modal.target)} className="flex-1 py-2.5 bg-red-600 text-white rounded-lg font-bold hover:bg-red-700 active:scale-95 transition">削除する</button>
                </div>
              </div>
            )}
            {modal.type === "hide_options" && (
              <div className="p-6 space-y-4">
                <div className="text-base font-bold text-gray-800 text-center">チャットの非表示設定</div>
                <p className="text-xs text-gray-500 leading-relaxed text-center">Gmailからは削除されません。Re:Mailの画面上から非表示になります。</p>
                <div className="flex flex-col gap-2 pt-2">
                  <button onClick={() => commitAction("hide_chat_unhide", modal.target)} className="w-full py-3 bg-blue-600 text-white rounded-lg font-bold hover:bg-blue-700 text-center active:scale-95 transition">新着メッセージで解除する</button>
                  <button onClick={() => commitAction("hide_chat_keep", modal.target)} className="w-full py-3 bg-gray-800 text-white rounded-lg font-bold hover:bg-black text-center active:scale-95 transition">非表示を維持する</button>
                  <button onClick={() => setModal(null)} className="w-full py-3 bg-gray-100 text-gray-500 rounded-lg font-bold hover:bg-gray-200 text-center active:scale-95 transition">非表示をやめる</button>
                </div>
              </div>
            )}
            {modal.type === "rename" && (
              <div className="p-6 space-y-4">
                <div className="text-base font-bold text-gray-800 text-center">チャット名の変更</div>
                <input type="text" value={renameInput} onChange={(e) => setRenameInput(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500" placeholder="新しい名前を入力..." />
                <div className="flex gap-2 pt-2">
                  <button onClick={() => setModal(null)} className="flex-1 py-2.5 bg-gray-100 text-gray-600 rounded-lg font-bold hover:bg-gray-200 active:scale-95 transition">キャンセル</button>
                  <button onClick={() => commitAction("rename_confirmed", modal.target)} className="flex-1 py-2.5 bg-blue-600 text-white rounded-lg font-bold hover:bg-blue-700 active:scale-95 transition">変更</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ＝＝＝＝ 作成モーダル ＝＝＝＝ */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md flex flex-col max-h-[80vh]">
            <div className="p-4 border-b border-gray-200">
              <h2 className="text-lg font-bold">新規チャットの作成</h2>
            </div>
            <div className="p-4 flex-1 overflow-y-auto">
              <input type="email" placeholder="email@example.com" value={newAddressInput} onChange={(e) => setNewAddressInput(e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:border-blue-500 text-sm mb-4" />
              <div className="space-y-2 border border-gray-200 p-2 rounded max-h-40 overflow-y-auto">
                {senderList.map((sender) => (
                  <label key={sender} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-gray-50 p-1 rounded">
                    <input type="checkbox" checked={selectedForGroup.includes(sender)} onChange={(e) => {
                      if (e.target.checked) setSelectedForGroup([...selectedForGroup, sender]);
                      else setSelectedForGroup(selectedForGroup.filter(s => s !== sender));
                    }}/>
                    <span className="truncate">{sender}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="p-4 border-t border-gray-200 flex justify-end gap-2">
              <button onClick={() => setIsCreateModalOpen(false)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded active:scale-95 transition">キャンセル</button>
              <button onClick={() => {
                let finalAddresses = [...selectedForGroup];
                if (newAddressInput.trim()) finalAddresses.push(newAddressInput.trim());
                if (finalAddresses.length > 0) {
                  setSelectedSender(finalAddresses.join(", "));
                  setIsCreateModalOpen(false); setSelectedForGroup([]); setNewAddressInput("");
                }
              }} className="px-4 py-2 text-sm bg-blue-600 text-white font-bold rounded hover:bg-blue-700 active:scale-95 transition">チャット開始</button>
            </div>
          </div>
        </div>
      )}

      {/* ＝＝＝＝ 左ペイン：チャット一覧 ＝＝＝＝ */}
      {showChatList && (
        <aside className={`${isMobile ? 'w-full' : 'w-1/3 min-w-[320px] max-w-[420px] border-r'} border-gray-200 bg-white flex flex-col relative`}>
          
          {!hasMouse && selectedChats.length > 0 && (
            <div className="absolute top-0 left-0 w-full h-16 bg-blue-600 z-20 flex items-center justify-between px-4 text-white shadow-md">
              <div className="flex items-center gap-4">
                <button onClick={() => setSelectedChats([])} className="text-xl font-bold active:scale-95">×</button>
                <span className="font-bold">{selectedChats.length}件選択中</span>
              </div>
              <div className="flex items-center gap-4 text-xs font-bold">
                {selectedChats.length === 1 && <button onClick={() => setModal({ type: "chat_menu", target: selectedChats[0] })} className="active:scale-95 bg-white/20 px-3 py-1.5 rounded">メニュー</button>}
              </div>
            </div>
          )}

          <div className="p-4 border-b border-gray-200 bg-gray-50 space-y-3">
            <div className="flex items-center justify-between">
              <h1 className="text-xl font-bold text-blue-600">Re:Mail</h1>
              <button onClick={() => signOut()} className="text-xs text-gray-500 hover:text-red-500 active:scale-95 transition">ログアウト</button>
            </div>
            
            <div className="flex items-center justify-between gap-2">
              <button onClick={() => setIsCreateModalOpen(true)} className="flex-1 bg-blue-600 text-white rounded text-sm py-2 font-bold shadow-sm hover:bg-blue-700 active:scale-95 transition-transform">作成</button>
            </div>

            <div className="flex items-center gap-2 bg-white p-2 border border-gray-200 rounded">
              <label className="text-xs font-bold text-gray-600 min-w-[55px]">件数: {limitAmount}件</label>
              <input type="range" min="1" max="100" value={limitAmount} onChange={(e) => setLimitAmount(Number(e.target.value))} className="flex-1 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer" />
            </div>

            <div className="flex flex-col gap-2 bg-white p-2 border border-gray-200 rounded">
              <span className="text-[10px] font-bold text-gray-400">表示対象（複数選択可）</span>
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-1 text-xs text-gray-600 cursor-pointer"><input type="checkbox" checked={checkInbox} onChange={(e) => setCheckInbox(e.target.checked)} /> 受信箱</label>
                <label className="flex items-center gap-1 text-xs text-gray-600 cursor-pointer"><input type="checkbox" checked={checkSpam} onChange={(e) => setCheckSpam(e.target.checked)} /> 迷惑</label>
                <label className="flex items-center gap-1 text-xs text-gray-600 cursor-pointer"><input type="checkbox" checked={checkTrash} onChange={(e) => setCheckTrash(e.target.checked)} /> ゴミ箱</label>
              </div>
            </div>

            <button 
              onClick={() => {
                fetchEmails(limitAmount, searchKeyword, { inbox: checkInbox, spam: checkSpam, trash: checkTrash }, null, false);
                saveGlobalSettings(limitAmount, checkInbox, checkSpam, checkTrash);
              }} 
              disabled={isLoading}
              className="w-full bg-gray-800 text-white font-bold rounded text-xs px-4 py-2.5 hover:bg-black active:scale-[0.98] transition-transform shadow-sm disabled:bg-gray-400"
            >
              {isLoading ? "読み込み中..." : "読み込み実行"}
            </button>

            <input 
              type="text" placeholder="キーワードで絞り込み..." 
              className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:border-blue-500 bg-white"
              value={searchKeyword} onChange={(e) => setSearchKeyword(e.target.value)}
              onKeyDown={(e) => { 
                if (e.key === 'Enter') {
                  fetchEmails(limitAmount, searchKeyword, { inbox: checkInbox, spam: checkSpam, trash: checkTrash }, null, false);
                  saveGlobalSettings(limitAmount, checkInbox, checkSpam, checkTrash);
                }
              }}
            />

            {hasMouse && senderList.length > 0 && (
              <div className="flex items-center justify-between pt-2 border-t border-gray-100">
                <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer select-none">
                  <input type="checkbox" checked={selectedChats.length === senderList.length && senderList.length > 0} onChange={(e) => setSelectedChats(e.target.checked ? senderList : [])} />
                  全選択
                </label>
                {selectedChats.length > 0 && (
                  <span className="text-xs font-bold text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full">
                    {selectedChats.length} 件選択中
                  </span>
                )}
              </div>
            )}
          </div>

          <div className="flex-1 overflow-y-auto">
             {senderList.map((sender) => {
              const latestEmail = groupedEmails[sender][0];
              const isSelectedChat = selectedChats.includes(sender);
              const isOpened = selectedSender === sender && !isMobile;
              const config = chatConfigs[sender];
              const displayName = config?.customName || sender;

              return (
                <div 
                  key={sender}
                  onTouchStart={() => {
                    if (!hasMouse) touchTimer.current = setTimeout(() => {
                      setModal({ type: "chat_menu", target: sender });
                    }, 500);
                  }}
                  onTouchEnd={() => touchTimer.current && clearTimeout(touchTimer.current)}
                  onTouchMove={() => touchTimer.current && clearTimeout(touchTimer.current)}
                  onClick={() => openChat(sender)}
                  onContextMenu={(e) => {
                    if (hasMouse) {
                      e.preventDefault();
                      setModal({ type: "chat_menu", target: sender });
                    }
                  }}
                  className={`flex items-center p-3 border-b border-gray-100 cursor-pointer transition select-none ${isOpened ? 'bg-blue-50 border-l-4 border-l-blue-600' : 'hover:bg-gray-50 border-l-4 border-l-transparent'}`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex justify-between items-baseline mb-1">
                      <div className="flex items-center gap-1 truncate pr-2">
                        {config?.isPinned && <span className="text-orange-500 text-xs">📌</span>}
                        <span className="font-bold text-sm truncate">{displayName}</span>
                      </div>
                      <span className="text-xs text-gray-400 whitespace-nowrap">{new Date(latestEmail.date).toLocaleDateString("ja-JP", { month: "short", day: "numeric" })}</span>
                    </div>
                    <div className="text-xs text-gray-500 truncate">{latestEmail.subject}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </aside>
      )}

      {/* ＝＝＝＝ 右ペイン：トーク画面 ＝＝＝＝ */}
      {showTalk && (
        <main className={`${isMobile ? 'w-full' : 'flex-1'} flex flex-col bg-[#7494C0] relative`}>
          
          <header className="px-4 py-3 bg-white/90 backdrop-blur shadow-sm z-10 flex items-center gap-3">
            {isMobile && <button onClick={() => window.history.back()} className="p-2 text-gray-600 font-bold active:scale-95 transition">←</button>}
            <h2 className="font-bold text-lg truncate flex-1">{chatConfigs[selectedSender!]?.customName || selectedSender}</h2>
            
            {hasMouse && selectedMessages.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-blue-600 bg-blue-50 px-2 py-1 rounded-md border border-blue-200">
                  {selectedMessages.length} 件のメッセージを選択中
                </span>
                <button 
                  onClick={() => setSelectedMessages([])} 
                  className="text-xs text-gray-400 hover:text-gray-600 font-medium px-1.5 py-1 rounded hover:bg-gray-100 transition active:scale-95"
                >
                  選択解除
                </button>
              </div>
            )}
          </header>

          <div className="flex-1 overflow-y-auto p-4 md:p-6 flex flex-col-reverse space-y-reverse space-y-4">
            {groupedEmails[selectedSender!] ? (
              groupedEmails[selectedSender!].map((email) => {
                const isMe = email.isMe || email.from.includes(session?.user?.email || "");

                return (
                  <div key={email.id} className={`flex flex-col w-full relative ${isMe ? 'items-end' : 'items-start'}`}>
                    <span className="text-xs text-white/80 mb-1 mx-2 select-none">
                      {isMe ? "自分" : email.from.split("<")[0].replace(/"/g, "").trim() || "Unknown"} ・ {new Date(email.date).toLocaleString("ja-JP", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                    </span>
                    
                    <div 
                      onContextMenu={(e) => {
                        if (hasMouse) {
                          e.preventDefault();
                          setModal({ type: "msg_menu", target: email });
                        }
                      }}
                      onTouchStart={() => {
                        if (!hasMouse) touchTimer.current = setTimeout(() => {
                          setModal({ type: "msg_menu", target: email });
                        }, 500);
                      }}
                      onTouchEnd={() => touchTimer.current && clearTimeout(touchTimer.current)}
                      onTouchMove={() => touchTimer.current && clearTimeout(touchTimer.current)}
                      className={`max-w-[85%] rounded-2xl p-4 shadow-sm transition-all ${isMe ? 'bg-green-100 rounded-tr-none text-gray-900' : 'bg-white rounded-tl-none text-gray-800'}`}
                    >
                      <div className="font-bold text-sm border-b border-gray-100/60 pb-2 mb-2">{email.subject}</div>
                      <div className="text-sm whitespace-pre-wrap break-words break-all leading-relaxed overflow-hidden select-text">{email.body}</div>
                    </div>
                  </div>
                );
              })
            ) : null}
          </div>

          <div className="p-3 md:p-4 bg-gray-100 border-t border-gray-300">
            <div className="max-w-4xl mx-auto flex flex-col gap-2 bg-white p-2 md:p-3 rounded-lg shadow-sm">
              {replyToMessage && (
                <div className="flex justify-between items-center bg-blue-50 text-blue-800 p-2 rounded text-xs border border-blue-200">
                  <span className="truncate">引用: {replyToMessage.subject}</span>
                  <button onClick={() => setReplyToMessage(null)} className="font-bold px-2 active:scale-95">×</button>
                </div>
              )}
              <input type="text" placeholder="件名 (省略可)" value={replySubject} onChange={(e) => setReplySubject(e.target.value)} className="w-full text-sm px-2 py-1 focus:outline-none font-medium border-b border-gray-100" />
              <div className="flex items-end gap-2">
                <textarea placeholder="メッセージを入力..." rows={isMobile ? 1 : 2} value={replyBody} onChange={(e) => setReplyBody(e.target.value)} className="flex-1 resize-none text-sm px-2 py-1 focus:outline-none" />
                <button onClick={handleSend} disabled={isSending || !replyBody.trim()} className="bg-blue-600 text-white px-3 md:px-4 py-2 rounded font-bold text-sm hover:bg-blue-700 transition disabled:bg-gray-400 active:scale-95">
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