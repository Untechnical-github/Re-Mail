"use client";

import { useRef, useState, useEffect } from "react";
import { getCachedAttachment, setCachedAttachment, memCache, getCachedVideoThumb, setCachedVideoThumb, videoThumbMemCache, attachmentCacheKey } from "./lib/attachmentCache";
import { generateVideoThumbnail } from "./lib/videoThumbnail";
import { signIn } from "next-auth/react";
import { useMailApp } from "./hooks/useMailApp";
import { HighlightText, ActionBar, BodyWithLinks } from "./components/ui";
import { Modals, EmailModal, AttachmentModal, SearchModal } from "./components/Modals";
import { getFileIcon, formatFileSize } from "./components/ui";

function InlineAttachmentImage({ attachment, messageId, cacheKey, onOpen }: {
  attachment: { filename: string; mimeType: string; size: number; attachmentId: string };
  messageId: string;
  cacheKey: string;
  onOpen: (base64: string) => void;
}) {
  // Synchronous check of in-memory cache for instant display on remount
  const [base64, setBase64] = useState<string | null>(() => memCache.get(cacheKey) ?? null);
  const [loading, setLoading] = useState(() => !memCache.has(cacheKey));

  useEffect(() => {
    if (memCache.has(cacheKey)) return;
    let cancelled = false;
    (async () => {
      // L2: check IndexedDB (fast, survives page reload)
      const cached = await getCachedAttachment(cacheKey);
      if (cancelled) return;
      if (cached) { setBase64(cached); setLoading(false); return; }
      // L3: fetch from API
      try {
        const res = await fetch(`/api/emails?messageId=${encodeURIComponent(messageId)}&attachmentId=${encodeURIComponent(attachment.attachmentId)}`);
        if (cancelled) return;
        if (res.ok) {
          const { data } = await res.json();
          if (!cancelled && data) {
            const b64 = (data as string).replace(/-/g, '+').replace(/_/g, '/');
            setCachedAttachment(cacheKey, b64); // fire and forget
            setBase64(b64);
          }
        }
      } catch {}
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [cacheKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return (
    <div className="w-40 h-24 rounded-xl bg-black/20 flex items-center justify-center">
      <div className="w-4 h-4 border-2 border-gray-500 border-t-white rounded-full animate-spin" />
    </div>
  );
  if (!base64) return null;

  return (
    <img
      src={`data:${attachment.mimeType};base64,${base64}`}
      alt={attachment.filename}
      className="max-w-[280px] max-h-52 rounded-xl cursor-pointer object-contain block hover:brightness-90 transition"
      onClick={(e) => { e.stopPropagation(); onOpen(base64); }}
      draggable={false}
    />
  );
}

const VIDEO_CHIP_MAX_W = 220;
const VIDEO_CHIP_MAX_H = 260;

function fitBox(ratio: number, maxW: number, maxH: number) {
  let w = maxW;
  let h = w / ratio;
  if (h > maxH) { h = maxH; w = h * ratio; }
  return { w: Math.round(w), h: Math.round(h) };
}

function VideoAttachmentChip({ attachment, messageId, cacheKey, onOpen }: {
  attachment: { filename: string; mimeType: string; size: number; attachmentId: string };
  messageId: string;
  cacheKey: string;
  onOpen: () => void;
}) {
  const [thumb, setThumb] = useState<{ dataUrl: string; ratio: number } | null>(() => videoThumbMemCache.get(cacheKey) ?? null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (thumb || videoThumbMemCache.has(cacheKey)) return;
    let cancelled = false;
    (async () => {
      const cachedThumb = await getCachedVideoThumb(cacheKey);
      if (cancelled) return;
      if (cachedThumb) { setThumb(cachedThumb); return; }

      // 再生時と同じキャッシュを共有するので、後で開いたときに二重ダウンロードにならない
      let base64 = await getCachedAttachment(cacheKey);
      if (!base64) {
        try {
          const res = await fetch(`/api/emails?messageId=${encodeURIComponent(messageId)}&attachmentId=${encodeURIComponent(attachment.attachmentId)}`);
          if (res.ok) {
            const { data } = await res.json();
            if (data) {
              base64 = (data as string).replace(/-/g, '+').replace(/_/g, '/');
              setCachedAttachment(cacheKey, base64);
            }
          }
        } catch {}
      }
      if (cancelled) return;
      if (!base64) { setFailed(true); return; }

      const generated = await generateVideoThumbnail(base64, attachment.mimeType);
      if (cancelled) return;
      if (generated) {
        setThumb(generated);
        setCachedVideoThumb(cacheKey, generated);
      } else {
        setFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [cacheKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const { w, h } = fitBox(thumb?.ratio || 16 / 9, VIDEO_CHIP_MAX_W, VIDEO_CHIP_MAX_H);

  return (
    <div
      className="relative rounded-xl overflow-hidden cursor-pointer group select-none flex-shrink-0 bg-black"
      style={{ width: w, height: h }}
      onClick={(e) => { e.stopPropagation(); onOpen(); }}
    >
      {thumb ? (
        <img src={thumb.dataUrl} alt="" className="absolute inset-0 w-full h-full object-cover" draggable={false} />
      ) : (
        <div className="absolute inset-0 bg-gradient-to-br from-[#1a1a2e] to-[#2d1b69] flex items-center justify-center">
          {!failed && <div className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />}
        </div>
      )}
      <div className="absolute inset-0 flex items-center justify-center bg-black/10 group-hover:bg-black/25 transition">
        <div className="w-12 h-12 bg-white/90 rounded-full flex items-center justify-center shadow-xl group-hover:scale-110 transition-transform">
          <span className="text-black text-base ml-0.5">▶</span>
        </div>
      </div>
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-2.5 pb-1.5 pt-4">
        <div className="text-xs text-white font-medium truncate">{attachment.filename}</div>
        <div className="text-[10px] text-white/50">{formatFileSize(attachment.size)}</div>
      </div>
    </div>
  );
}

export default function Home() {
  const app = useMailApp();
  const { auth, state, actions, computed, refs } = app;

  // Shift+クリック範囲選択用の最終クリックインデックス
  const lastChatIdxRef = useRef<number>(-1);
  const lastMsgIdxRef = useRef<number>(-1);

  if (auth.status === "loading") return <div className="flex h-screen items-center justify-center bg-[#313338] text-gray-400 font-bold">読み込み中...</div>;
  if (!auth.session || (auth.session as any).error === "RefreshAccessTokenError") return (
    <div className="flex h-screen flex-col items-center justify-center bg-[#313338] text-white">
      <h1 className="mb-8 text-5xl font-extrabold text-[#5865F2]">Re:Mail</h1>
      <button onClick={() => signIn("google", { callbackUrl: "/" })} className="rounded bg-[#5865F2] px-8 py-3 font-bold shadow transition hover:bg-[#4752C4] active:scale-95">Googleでログインして始める</button>
    </div>
  );

  const showChatList = !state.isMobile || !state.selectedSender;
  const showTalk = !state.isMobile || state.selectedSender;

  const selectedGroupConfig = state.selectedSender ? state.chatConfigs[state.selectedSender] : undefined;
  const isInboundOnlyGroup = !!(selectedGroupConfig?.isGroup && selectedGroupConfig.groupMode === "inbound_only");
  const isOutboundOnlyGroup = !!(selectedGroupConfig?.isGroup && selectedGroupConfig.groupMode === "outbound_only");
  const subjectFindHighlight = state.findBarOpen && state.findBarSearchSubject ? state.findBarKeyword : "";
  const bodyFindHighlight = state.findBarOpen && state.findBarSearchBody ? state.findBarKeyword : "";

  // メッセージが属する場所（受信箱・送信済み等）に応じた色を返す（返信元チップの色分けにも使う）
  const getMsgColor = (msg: any) => {
    const isTrash = msg.labelIds?.includes("TRASH");
    const isSpam = msg.labelIds?.includes("SPAM");
    const isInbox = msg.labelIds?.includes("INBOX");
    const isSent = msg.labelIds?.includes("SENT") || msg.isMe;
    const isArchive = !isTrash && !isSpam && !isInbox && !isSent;
    return isSent ? state.boxColors.sent : isTrash ? state.boxColors.trash : isSpam ? state.boxColors.spam : isArchive ? state.boxColors.archive : state.boxColors.inbox;
  };

  return (
    <div className="flex h-[100dvh] w-full bg-[#313338] overflow-hidden text-gray-200 relative select-none" onClick={actions.handleBackgroundClick}>
<Modals app={app} />
<SearchModal app={app} />
<EmailModal app={app} />
<AttachmentModal app={app} />
{state.replyNotFoundToast && (
  <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[80] bg-[#2B2D31] text-white text-sm font-bold px-4 py-2 rounded-full shadow-lg border border-[#4752C4] pointer-events-none">
    このメールは存在しません
  </div>
)}

      {showChatList && (
        <aside className={`${state.isMobile ? 'w-full' : 'w-[320px] border-r'} border-[#1E1F22] bg-[#2B2D31] flex flex-col h-full min-h-0 cursor-pointer`}>
          <div className="p-4 border-b border-[#1E1F22] shadow-sm flex items-center justify-between cursor-default">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 flex items-center justify-center">
                {state.selectionMode !== "none" && (
                  <button onClick={(e) => { e.stopPropagation(); actions.safeBack(); }} className="text-gray-400 hover:text-white font-bold text-lg transition active:scale-90">←</button>
                )}
              </div>
              <h1 className="text-xl font-extrabold text-white tracking-wide">Re:Mail</h1>
            </div>
            <div className="flex items-center gap-3">
              <button onClick={(e) => { e.stopPropagation(); actions.setModal({ type: "search", targetMode: "all_chats", targets: [] }); window.history.pushState({ action: "modal" }, "", window.location.href); }} className="text-gray-400 hover:text-white transition" title="検索">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z" clipRule="evenodd" /></svg>
              </button>
              <button onClick={(e) => { e.stopPropagation(); actions.setModal({ type: "account_menu", targetMode: "all_chats", targets: [] }); window.history.pushState({ action: "modal" }, "", window.location.href); }} className="flex-shrink-0" title="アカウント">
                <img
                  src={auth.session?.user?.image || `/api/avatar?name=${encodeURIComponent(auth.session?.user?.name || "U")}`}
                  alt=""
                  referrerPolicy="no-referrer"
                  className="w-7 h-7 rounded-full"
                />
              </button>
            </div>
          </div>

          <div className="p-3 border-b border-[#1E1F22] bg-[#232428] cursor-default">
             <div className="flex flex-wrap gap-1 text-[11px] font-bold">
                <label onClick={(e) => e.stopPropagation()} className="flex items-center gap-1 cursor-pointer bg-[#313338] px-2 py-1.5 rounded flex-1 justify-center hover:bg-[#3f4147]"><input type="checkbox" checked={state.checkInbox} onChange={(e) => actions.setCheckInbox(e.target.checked)} className="accent-[#5865F2]" /> 受信箱</label>
                <label onClick={(e) => e.stopPropagation()} className="flex items-center gap-1 cursor-pointer bg-[#313338] px-2 py-1.5 rounded flex-1 justify-center hover:bg-[#3f4147]"><input type="checkbox" checked={state.checkArchive} onChange={(e) => actions.setCheckArchive(e.target.checked)} className="accent-[#95A5A6]" /> アーカイブ</label>
                {/* ★修正: 送信済みチェックボックスを並列で追加 */}
                <label onClick={(e) => e.stopPropagation()} className="flex items-center gap-1 cursor-pointer bg-[#313338] px-2 py-1.5 rounded flex-1 justify-center hover:bg-[#3f4147]"><input type="checkbox" checked={state.checkSent} onChange={(e) => actions.setCheckSent(e.target.checked)} className="accent-[#1ABC9C]" /> 送信済</label>
                <label onClick={(e) => e.stopPropagation()} className="flex items-center gap-1 cursor-pointer bg-[#313338] px-2 py-1.5 rounded flex-1 justify-center hover:bg-[#3f4147]"><input type="checkbox" checked={state.checkSpam} onChange={(e) => actions.setCheckSpam(e.target.checked)} className="accent-[#FEE75C]" /> 迷惑</label>
                <label onClick={(e) => e.stopPropagation()} className="flex items-center gap-1 cursor-pointer bg-[#313338] px-2 py-1.5 rounded flex-1 justify-center hover:bg-[#3f4147]"><input type="checkbox" checked={state.checkTrash} onChange={(e) => actions.setCheckTrash(e.target.checked)} className="accent-[#DA373C]" /> ゴミ箱</label>
             </div>
          </div>

          <div className="flex gap-1 px-3 pt-2 bg-[#232428] border-b border-[#1E1F22] cursor-default" onClick={(e) => e.stopPropagation()}>
            {([["individual", "個人チャット"], ["group", "グループチャット"]] as const).map(([tab, label]) => (
              <button
                key={tab}
                onClick={() => actions.changeChatTab(tab)}
                className={`flex-1 py-1.5 mb-2 rounded text-xs font-bold transition ${state.activeChatTab === tab ? "bg-[#5865F2] text-white" : "bg-[#313338] text-gray-400 hover:bg-[#3f4147]"}`}
              >
                {label}
              </button>
            ))}
          </div>

          <ActionBar app={app} isChat={true} />

          <div
            className="flex-1 overflow-y-auto p-2 space-y-0.5 min-h-0 cursor-default"
            onScroll={(e) => {
              const { scrollTop, clientHeight, scrollHeight } = e.currentTarget;
              if (scrollHeight - Math.abs(scrollTop) - clientHeight < 50 && !state.isLoadingMoreChats && !state.chatStatusMessage) {
                actions.handleLoadMoreChats();
              }
            }}
          >
             {state.isLoading && <div className="text-xs text-[#5865F2] font-bold p-2 text-center animate-pulse">読み込み中...</div>}
             {computed.senderList.filter((sender: string) => !!state.chatConfigs[sender]?.isGroup === (state.activeChatTab === "group")).map((sender) => {
              const allEmails = computed.groupedEmails[sender] || [];
              const config = state.chatConfigs[sender];

              const visibleEmails = allEmails.filter((e: any) => {
                 const isTrash = e.labelIds?.includes("TRASH");
                 const isSpam = e.labelIds?.includes("SPAM");
                 const isInbox = e.labelIds?.includes("INBOX");
                 const isSent = e.labelIds?.includes("SENT") || e.isMe; 
                 const isArchive = !isTrash && !isSpam && !isInbox && !isSent; 
                 
                 if ((isInbox || isArchive || isSent) && (config?.isHidden || state.chatConfigs[e.id]?.isHidden)) return false;

                 // ★修正: 送信済みチェックを「絶対優先」に書き換え
                 let isCurrentBox = false;
                 if (isSent) {
                     isCurrentBox = state.checkSent;
                 } else {
                     isCurrentBox = (isTrash && state.checkTrash) || (isSpam && state.checkSpam) || (isInbox && state.checkInbox) || (isArchive && state.checkArchive);
                 }

                 if (!isCurrentBox && !state.revealedCrossPrompts.includes(e.id)) return false;
                 return true;
              });

              const isDraft = state.draftChats.includes(sender) && allEmails.length === 0;
              const latestEmail = visibleEmails[0];
              if (!latestEmail && !isDraft) return null;

              const isSelected = state.selectedIds.includes(sender);
              const isOpened = state.selectedSender === sender && !state.isMobile;
              const count = visibleEmails.length;
              const latestDate = latestEmail ? new Date(latestEmail.date).toLocaleString("ja-JP", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";

              const previewSubject = latestEmail ? (latestEmail.subject || "No Subject") : "";

              const isChatOnlySent = allEmails.every((e: any) => (e.labelIds?.includes("SENT") || e.isMe) && !e.labelIds?.includes("TRASH"));

              const isMoveGrayedOut = state.selectionMode === "chat_move" && (
                 isChatOnlySent ||
                 (state.moveDestination &&
                   visibleEmails.length > 0 && visibleEmails.every((e: any) => e.labelIds?.includes(state.moveDestination!) || (state.moveDestination === "ARCHIVE" && !e.labelIds?.includes("TRASH") && !e.labelIds?.includes("SPAM") && !e.labelIds?.includes("INBOX") && !e.labelIds?.includes("SENT") && !e.isMe))
                 )
              );

              // ★修正: ピン留め/非表示の対象(INBOXかARCHIVE)がいるか判定
              const hasValidFetchedMail = visibleEmails.some((e: any) => !e.labelIds?.includes("TRASH") && !e.labelIds?.includes("SPAM"));
              
              const hasLiveTarget = hasValidFetchedMail;
              
              const isPinGrayedOut = state.selectionMode === "chat_pin" && !hasLiveTarget;
              const isHideGrayedOut = state.selectionMode === "chat_hide" && !hasLiveTarget;

              const isDeleteGrayedOut = state.selectionMode === "chat_delete" &&
                visibleEmails.length > 0 && visibleEmails.every((e: any) => e.labelIds?.includes("TRASH") || e.labelIds?.includes("SENT") || e.isMe);

              const isActionGrayedOut = isMoveGrayedOut || isPinGrayedOut || isHideGrayedOut || isDeleteGrayedOut;

              // グラデーション色を計算（SENTを最優先：ゴミ箱内の送信済みも緑扱い）
              const colorsSet = new Set<string>();
              allEmails.forEach((e: any) => {
                const isSentE = e.labelIds?.includes("SENT") || e.isMe;
                const isTrashE = !isSentE && e.labelIds?.includes("TRASH");
                const isSpamE  = !isSentE && e.labelIds?.includes("SPAM");
                const isInboxE = !isSentE && !isTrashE && !isSpamE && e.labelIds?.includes("INBOX");
                if (isSentE && (state.checkSent || isChatOnlySent)) colorsSet.add(state.boxColors.sent);
                else if (isTrashE && state.checkTrash) colorsSet.add(state.boxColors.trash);
                else if (isSpamE  && state.checkSpam)  colorsSet.add(state.boxColors.spam);
                else if (isInboxE && state.checkInbox) colorsSet.add(state.boxColors.inbox);
                else if (!isSentE && !isTrashE && !isSpamE && !isInboxE && state.checkArchive) colorsSet.add(state.boxColors.archive);
              });
              const colors = Array.from(colorsSet);
              
              let wrapperStyle: React.CSSProperties = { borderRadius: '0.5rem' };
              let innerClass = `flex items-center px-2 py-2 rounded cursor-pointer transition ${isActionGrayedOut ? 'opacity-30 pointer-events-none grayscale' : ''} ${state.selectionMode.startsWith("chat_") ? (isSelected ? 'bg-[rgba(88,101,242,0.2)]' : 'hover:bg-[#35373C]') : (isOpened ? 'bg-[#404249] text-white' : 'hover:bg-[#35373C] text-gray-400 hover:text-gray-200')}`;
              let innerStyle: React.CSSProperties = {};

              if (colors.length === 1) {
                  wrapperStyle = { ...wrapperStyle, border: `2px solid ${colors[0]}` };
              } else if (colors.length > 1) {
                  wrapperStyle = { ...wrapperStyle, background: `linear-gradient(45deg, ${colors.join(', ')})`, padding: '2px', border: 'none' };
                  innerClass = innerClass.replace('px-2 py-2', 'px-2 py-1.5'); 
                  innerStyle = { borderRadius: '0.4rem', backgroundColor: isOpened ? '#404249' : '#2B2D31', width: '100%', height: '100%' };
              } else {
                  wrapperStyle = { ...wrapperStyle, border: `2px solid transparent` };
              }

              const senderIdx = computed.senderList.indexOf(sender);
              return (
                <div key={sender} style={wrapperStyle} className="mb-1" data-chat-id={sender}>
                  <div
                    onClick={(e) => {
                      e.stopPropagation();
                      if (isActionGrayedOut) return;
                      if (state.selectionMode.startsWith("chat_")) {
                        if (e.shiftKey && lastChatIdxRef.current >= 0) {
                          const min = Math.min(senderIdx, lastChatIdxRef.current);
                          const max = Math.max(senderIdx, lastChatIdxRef.current);
                          const rangeIds = computed.senderList.slice(min, max + 1);
                          actions.setSelectedIds((prev: string[]) => [...new Set([...prev, ...rangeIds])]);
                        } else {
                          actions.toggleSelection(sender);
                          lastChatIdxRef.current = senderIdx;
                        }
                      } else {
                        actions.openChat(sender);
                      }
                    }}
                    onContextMenu={(e) => { e.preventDefault(); }}
                    onTouchStart={() => {
                      if (!state.hasMouse) {
                        refs.touchTimer.current = setTimeout(() => {
                          if (!state.selectionMode.startsWith("chat_")) {
                            actions.enterSelectionMode("chat", sender);
                          } else {
                            actions.toggleSelection(sender);
                          }
                        }, 500);
                      }
                    }}
                    onTouchMove={() => {
                      if (refs.touchTimer.current) { clearTimeout(refs.touchTimer.current); refs.touchTimer.current = null; }
                    }}
                    onTouchEnd={() => {
                      if (refs.touchTimer.current) { clearTimeout(refs.touchTimer.current); refs.touchTimer.current = null; }
                    }}
                    className={innerClass}
                    style={innerStyle}
                  >
                    {/* チェックボックス: 常時表示 */}
                    <div
                      className={`flex-shrink-0 w-4 h-4 mr-3 rounded-sm flex items-center justify-center border cursor-pointer flex-shrink-0
                        ${isSelected ? 'bg-[#5865F2] border-[#5865F2]' : 'border-gray-500'}
                      `}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (isActionGrayedOut) return;
                        if (e.shiftKey && lastChatIdxRef.current >= 0 && state.selectionMode.startsWith("chat_")) {
                          // Shift+クリックで範囲選択
                          const min = Math.min(senderIdx, lastChatIdxRef.current);
                          const max = Math.max(senderIdx, lastChatIdxRef.current);
                          const rangeIds = computed.senderList.slice(min, max + 1);
                          actions.setSelectedIds((prev: string[]) => [...new Set([...prev, ...rangeIds])]);
                        } else {
                          if (!state.selectionMode.startsWith("chat_")) {
                            actions.enterSelectionMode("chat", sender);
                          } else {
                            actions.toggleSelection(sender);
                          }
                          lastChatIdxRef.current = senderIdx;
                        }
                      }}
                    >
                      {isSelected && <div className="w-2 h-2 bg-white rounded-sm"></div>}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between items-baseline">
                        <div className="flex items-center gap-1 truncate pr-2">
                          {config?.isPinned && <span className="text-[#FEE75C] text-[10px]">📌</span>}
                          <span className="font-bold text-sm truncate">{config?.customName || sender}</span>
                        </div>
                        <span className="text-[10px] text-gray-500 flex-shrink-0">{latestDate}</span>
                      </div>
                      <div className="text-[10px] text-[#5865F2] font-bold mt-0.5">{isDraft ? "新規作成中" : `${count}件のメッセージ`}</div>
                      <div className="text-xs text-gray-500 truncate mt-0.5">
                        {isDraft ? "まだメッセージがありません" : previewSubject}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
             {computed.senderList.length > 0 && (
              <div className="flex flex-col items-center p-3 mt-2 border-t border-[#1E1F22]/50">
                {state.chatStatusMessage ? (
                  <span className="text-xs text-gray-500 font-medium px-2 py-1 bg-[#232428] rounded text-center">{state.chatStatusMessage}</span>
                ) : state.isLoadingMoreChats ? (
                  <span className="text-xs text-[#5865F2] font-medium animate-pulse">チャットを追加読み込み中...</span>
                ) : state.isLoading ? (
                  <span className="text-xs text-[#5865F2] font-medium animate-pulse">初期データ読み込み中...</span>
                ) : null}
              </div>
             )}
          </div>
        </aside>
      )}

      {showTalk && (
        <main className={`${state.isMobile ? 'w-full' : 'flex-1'} flex flex-col bg-[#313338] relative cursor-pointer`}>
          {state.selectedSender && ((computed.groupedEmails[state.selectedSender!] && computed.groupedEmails[state.selectedSender!].length > 0) || state.draftChats.includes(state.selectedSender!)) ? (
            <>
              <header className="px-4 py-3 bg-[#313338] border-b border-[#1E1F22] shadow-sm z-10 flex items-center gap-3 cursor-default">
                {state.isMobile && (
                  <button onClick={(e) => { e.stopPropagation(); actions.safeBack(); }} className="text-gray-400 hover:text-white font-bold p-1 text-lg transition active:scale-90">←</button>
                )}
                <div className="flex-1 min-w-0 flex items-baseline gap-2">
                  <h2 className="font-bold text-base truncate text-white">{state.chatConfigs[state.selectedSender!]?.customName || state.selectedSender}</h2>
                  {selectedGroupConfig?.isGroup ? (
                    <span className="text-xs text-gray-500 truncate">
                      グループ・{(selectedGroupConfig.groupMembers || []).length}人
                      {isInboundOnlyGroup ? "・受信専用" : isOutboundOnlyGroup ? "・送信専用" : ""}
                    </span>
                  ) : (() => {
                    const firstPartner = (computed.groupedEmails[state.selectedSender!] || []).find((e: any) => !e.isMe && !e.from.includes(auth.session?.user?.email || ""));
                    if (!firstPartner) return null;
                    const addrMatch = firstPartner.from.match(/<([^>]+)>/);
                    const addr = addrMatch ? addrMatch[1].trim() : firstPartner.from.trim();
                    return <span className="text-xs text-gray-500 truncate">{addr}</span>;
                  })()}
                </div>
                <button onClick={(e) => { e.stopPropagation(); actions.openFindBar(); }} className="text-gray-400 hover:text-white transition flex-shrink-0" title="検索">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z" clipRule="evenodd" /></svg>
                </button>
                {state.isMobile && (
                  <button onClick={(e) => { e.stopPropagation(); actions.setModal({ type: "account_menu", targetMode: "all_chats", targets: [] }); window.history.pushState({ action: "modal" }, "", window.location.href); }} className="flex-shrink-0" title="アカウント">
                    <img
                      src={auth.session?.user?.image || `/api/avatar?name=${encodeURIComponent(auth.session?.user?.name || "U")}`}
                      alt=""
                      referrerPolicy="no-referrer"
                      className="w-7 h-7 rounded-full"
                    />
                  </button>
                )}
              </header>

              {state.findBarOpen && (
                <div className="px-3 py-2 bg-[#2B2D31] border-b border-[#1E1F22] flex-shrink-0 cursor-default" onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center gap-2">
                    <input
                      autoFocus
                      type="text"
                      value={state.findBarKeyword}
                      onChange={(e) => actions.updateFindBarKeyword(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          if (e.shiftKey) actions.goToPrevFindMatch(); else actions.goToNextFindMatch();
                        }
                      }}
                      placeholder="キーワードで検索..."
                      className="flex-1 min-w-0 bg-[#1E1F22] text-sm text-gray-200 px-3 py-1.5 rounded focus:outline-none focus:ring-1 focus:ring-[#5865F2]"
                    />
                    <span className="text-xs text-gray-500 flex-shrink-0 min-w-[36px] text-center select-none">
                      {computed.findBarMatches.length > 0 ? `${state.findBarMatchIndex >= 0 ? state.findBarMatchIndex + 1 : "-"}/${computed.findBarMatches.length}` : "0/0"}
                    </span>
                    <button onClick={() => actions.goToPrevFindMatch()} disabled={computed.findBarMatches.length === 0} className="text-gray-400 hover:text-white disabled:opacity-30 disabled:hover:text-gray-400 transition p-1 flex-shrink-0" title="前の一致">▲</button>
                    <button onClick={() => actions.goToNextFindMatch()} disabled={computed.findBarMatches.length === 0} className="text-gray-400 hover:text-white disabled:opacity-30 disabled:hover:text-gray-400 transition p-1 flex-shrink-0" title="次の一致">▼</button>
                    <button onClick={() => actions.closeFindBar()} className="text-gray-400 hover:text-white font-bold text-lg px-1 transition flex-shrink-0">×</button>
                  </div>
                  <div className="flex gap-3 mt-1.5 text-[11px] font-bold text-gray-400">
                    <label className="flex items-center gap-1 cursor-pointer">
                      <input type="checkbox" checked={state.findBarSearchSubject} onChange={(e) => actions.setFindBarSearchSubject(e.target.checked)} className="accent-[#5865F2]" /> 件名
                    </label>
                    <label className="flex items-center gap-1 cursor-pointer">
                      <input type="checkbox" checked={state.findBarSearchBody} onChange={(e) => actions.setFindBarSearchBody(e.target.checked)} className="accent-[#5865F2]" /> 本文
                    </label>
                  </div>
                  <div className="flex flex-wrap gap-1 mt-2 pt-2 border-t border-[#1E1F22]/70 text-[11px] font-bold">
                    {([["inbox", "受信箱"], ["archive", "アーカイブ"], ["sent", "送信済"], ["spam", "迷惑"], ["trash", "ゴミ箱"]] as const).map(([key, label]) => (
                      <label key={key} className="flex items-center gap-1 cursor-pointer bg-[#1E1F22] px-2 py-1 rounded text-gray-500 hover:bg-[#35373C] hover:text-gray-300 transition">
                        <input type="checkbox" checked={state.findBarBoxFilter[key]} onChange={(e) => actions.setFindBarBox(key, e.target.checked)} className="accent-[#95A5A6]" /> {label}
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <ActionBar app={app} isChat={false} />

              {computed.pinnedMsgsInChat.length > 0 && (
                <div className="bg-[#2B2D31] border-b border-[#1E1F22] px-4 py-1.5 flex gap-2 overflow-x-auto scrollbar-none items-center shadow-inner cursor-default">
                   <span className="text-xs text-[#FEE75C] font-bold">📌</span>
                   {computed.pinnedMsgsInChat.map((m: any) => (
                      <button key={`pin-${m.id}`} onClick={(e) => { e.stopPropagation(); document.getElementById(`msg-${m.id}`)?.scrollIntoView({behavior: 'smooth', block: 'center'}); }} className="text-xs bg-[#1E1F22] text-gray-300 px-3 py-1.5 rounded-full truncate max-w-[200px] hover:text-white border border-[#35373C] flex-shrink-0 transition active:scale-95">
                         {m.subject || m.snippet}
                      </button>
                   ))}
                </div>
              )}

              <div 
                key={state.selectedSender} // ★追加: 宛先が変わるたびにスクロール枠を完全に作り直し、位置を一番下へリセットする
                className="flex-1 overflow-y-auto px-4 py-6 flex flex-col-reverse scrollbar-thin cursor-default"
                onScroll={(e) => {
                  const { scrollTop, clientHeight, scrollHeight } = e.currentTarget;
                  if (scrollHeight - Math.abs(scrollTop) - clientHeight < 50 && !state.isLoadingMore && !state.msgStatusMessage) {
                    actions.handleLoadMoreMessage();
                  }
                }}
              >
                {(computed.groupedEmails[state.selectedSender!] || []).length === 0 && (
                  <div className="flex-1 flex items-center justify-center text-gray-500 text-sm cursor-default">
                    まだメッセージがありません。最初のメッセージを送信しましょう。
                  </div>
                )}
                {(computed.groupedEmails[state.selectedSender!] || []).map((email: any) => {
                    const isTrash = email.labelIds?.includes("TRASH");
                    const isSpam = email.labelIds?.includes("SPAM");
                    const isInbox = email.labelIds?.includes("INBOX");
                    const isSent = email.labelIds?.includes("SENT") || email.isMe; 
                    const isArchive = !isTrash && !isSpam && !isInbox && !isSent; 

                    if ((isInbox || isArchive || isSent) && (state.chatConfigs[state.selectedSender!]?.isHidden || state.chatConfigs[email.id]?.isHidden)) return null;

                    const isMe = email.isMe || email.from.includes(auth.session?.user?.email || "");
                    const isSelected = state.selectedIds.includes(email.id);
                    
                    // ★修正: 送信済みチェックを「絶対優先」に書き換え
                    let isCurrentBox = false;
                    if (isSent) {
                        isCurrentBox = state.checkSent;
                    } else {
                        isCurrentBox = (isTrash && state.checkTrash) || (isSpam && state.checkSpam) || (isInbox && state.checkInbox) || (isArchive && state.checkArchive);
                    }

                    // ★修正: ボックス名と色に送信済みを追加
                    const boxName = isTrash ? "ゴミ箱" : isSpam ? "迷惑メール" : isSent ? "送信済み" : isArchive ? "アーカイブ" : "受信箱";
                    const boxColor = isTrash ? state.boxColors.trash : isSpam ? state.boxColors.spam : isSent ? state.boxColors.sent : isArchive ? state.boxColors.archive : state.boxColors.inbox;

                    if (!isCurrentBox && !state.revealedCrossPrompts.includes(email.id)) {
                        const roundedClass = isMe ? 'rounded-2xl rounded-tr-sm' : 'rounded-2xl rounded-tl-sm';
                        return (
                          <div id={`msg-${email.id}`} key={`prompt-${email.id}`} className={`flex w-full mb-6 cursor-default transition ${isMe ? 'justify-end' : 'justify-start'}`}>
                            {!isMe && !state.selectionMode.startsWith("msg_") && (
                               <img src={`/api/avatar?name=${encodeURIComponent(email.from.split("<")[0].replace(/"/g, "").trim() || "Unknown")}`} alt="" className="w-9 h-9 rounded-full mr-3 flex-shrink-0 mt-1 shadow-sm select-none pointer-events-none opacity-80" />
                            )}
                            
                            <div className={`flex flex-col max-w-[75%] ${isMe ? 'items-end' : 'items-start'}`}>
                               <div className="flex items-center gap-2 mb-1.5 mx-1 text-[11px] text-gray-400 select-none">
                                  {!isMe && <span className="font-bold text-gray-300">{email.from.split("<")[0].replace(/"/g, "").trim() || "Unknown"}</span>}
                                  <span>{new Date(email.date).toLocaleString("ja-JP", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                               </div>
                               
                               <button 
                                  onClick={(e) => { e.stopPropagation(); actions.setRevealedCrossPrompts(p => [...p, email.id]); }} 
                                  style={{ borderColor: boxColor, color: boxColor }} 
                                  className={`bg-[#2B2D31] px-5 py-3 ${roundedClass} text-[13px] font-bold border-2 hover:bg-[#35373C] transition shadow-sm animate-fade-in`}
                               >
                                  {boxName}のメールが含まれています。読み込みますか？
                               </button>
                            </div>
                            
                            {isMe && !state.selectionMode.startsWith("msg_") && (
                               <img src={`/api/avatar?name=${encodeURIComponent(auth.session?.user?.name || "Me")}`} alt="" className="w-9 h-9 rounded-full ml-3 flex-shrink-0 mt-1 shadow-sm select-none pointer-events-none opacity-80" />
                            )}
                          </div>
                        );
                    }

                    const currentFindMatch = state.findBarOpen && state.findBarMatchIndex >= 0 ? computed.findBarMatches[state.findBarMatchIndex] : undefined;
                    const isCurrentFindTarget = currentFindMatch?.id === email.id;
                    const activeFindField = isCurrentFindTarget ? currentFindMatch!.field : undefined;
                    const activeFindIndex = isCurrentFindTarget ? currentFindMatch!.fieldIndex : undefined;

                    const isMoveGrayedOut = state.selectionMode === "msg_move" && state.moveDestination && (email.labelIds?.includes(state.moveDestination) || (state.moveDestination === "ARCHIVE" && isArchive));
                    const isSentMailMoveRestricted = state.selectionMode === "msg_move" && isSent;

                    // ★追加: 個別メッセージがゴミ箱または迷惑メールにあるか判定
                    const isTrashOrSpamMsg = isTrash || isSpam;
                    // ★修正: ゴミ箱や迷惑メールにあるメッセージ（送信済み含む）はピン留め・非表示の選択モード時に強制グレーアウト
                    const isMsgPinGrayedOut = state.selectionMode === "msg_pin" && (isTrashOrSpamMsg || !(isInbox || isArchive || isSent));
                    const isMsgHideGrayedOut = state.selectionMode === "msg_hide" && (isTrashOrSpamMsg || !(isInbox || isArchive || isSent));
                    
                    // ★追加: 削除モード時、ゴミ箱にあるメールと送信済みメールはグレーアウトして選択不能にする
                    const isDeleteGrayedOut = state.selectionMode === "msg_delete" && (isTrash || isSent);
                    
                    const isActionGrayedOut = isMoveGrayedOut || isMsgPinGrayedOut || isMsgHideGrayedOut || isSentMailMoveRestricted || isDeleteGrayedOut;
                    
                    // 送信済みを最優先（ゴミ箱内の送信済みも緑で表示）
                    const msgColor = isSent ? state.boxColors.sent : isTrash ? state.boxColors.trash : isSpam ? state.boxColors.spam : isArchive ? state.boxColors.archive : state.boxColors.inbox;

                    const msgIdx = computed.groupedEmails[state.selectedSender!].indexOf(email);
                    const isCollapsed = state.collapseLinesCount !== null && !state.expandedMsgIds.includes(email.id);
                    // Discord風の「返信先」チップ用: このメッセージがどのメッセージへの返信かを解決する
                    const replyTarget = (email.replyToId || email.inReplyTo)
                      ? computed.allUniqueEmails.find((e: any) => (email.replyToId && e.id === email.replyToId) || (email.inReplyTo && e.messageIdHeader === email.inReplyTo))
                      : null;
                    const displaySubject = (email.subject || "").trim();
                    const hasVisibleSubject = !!displaySubject;
                    const hasBody = !!email.body && !!email.body.trim();
                    return (
                      <div
                        id={`msg-${email.id}`}
                        key={email.id}
                        data-msg-id={email.id}
                        className={`flex w-full mb-6 cursor-default transition ${isActionGrayedOut ? 'opacity-30 pointer-events-none grayscale' : ''} ${isMe ? 'justify-end' : 'justify-start'}`}
                      >
                        {/* チェックボックス列: 常時表示 */}
                        <div className="flex-shrink-0 w-8 flex justify-center pt-3 mr-2">
                          <div
                            className={`w-5 h-5 rounded-sm flex items-center justify-center border cursor-pointer ${isSelected ? 'bg-[#5865F2] border-[#5865F2]' : 'border-gray-500 bg-[#2B2D31]'}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (isActionGrayedOut) return;
                              if (e.shiftKey && lastMsgIdxRef.current >= 0 && state.selectionMode.startsWith("msg_")) {
                                const allMsgs = computed.groupedEmails[state.selectedSender!] || [];
                                const min = Math.min(msgIdx, lastMsgIdxRef.current);
                                const max = Math.max(msgIdx, lastMsgIdxRef.current);
                                const rangeIds = allMsgs.slice(min, max + 1).map((m: any) => m.id);
                                actions.setSelectedIds((prev: string[]) => [...new Set([...prev, ...rangeIds])]);
                              } else {
                                if (!state.selectionMode.startsWith("msg_")) {
                                  actions.enterSelectionMode("msg", email.id);
                                } else {
                                  actions.toggleSelection(email.id);
                                }
                                lastMsgIdxRef.current = msgIdx;
                              }
                            }}
                          >
                            {isSelected && <div className="w-2.5 h-2.5 bg-white rounded-sm"></div>}
                          </div>
                        </div>

                        {!isMe && !state.selectionMode.startsWith("msg_") && (
                           <img src={`/api/avatar?name=${encodeURIComponent(email.from.split("<")[0].replace(/"/g, "").trim() || "Unknown")}`} alt="" className="w-9 h-9 rounded-full mr-3 flex-shrink-0 mt-1 shadow-sm select-none pointer-events-none" />
                        )}

                        <div className={`flex flex-col max-w-[75%] ${isMe ? 'items-end' : 'items-start'}`}>
                           {(email.replyToId || email.inReplyTo) && (
                             <button
                               onClick={(e) => { e.stopPropagation(); actions.jumpToReplyTarget(email); }}
                               className={`flex items-center gap-2 mb-1 max-w-[85%] pl-3 pr-4 py-2 rounded-lg bg-black/20 border-l-4 hover:bg-black/30 transition text-left ${isMe ? 'self-end' : 'self-start'}`}
                               style={{ borderColor: replyTarget ? getMsgColor(replyTarget) : '#6B7280' /* 未解決時は色分けと紛らわしくないグレーにする */ }}
                             >
                               <span className="text-sm flex-shrink-0 opacity-70">↩</span>
                               <span className="text-sm text-gray-300">{replyTarget ? (replyTarget.subject || "(件名なし)") : "元のメッセージ"}</span>
                             </button>
                           )}
                           <div className="flex items-center gap-2 mb-1.5 mx-1 text-[11px] text-gray-400 select-none">
                              {!isMe && <span className="font-bold text-gray-300">{email.from.split("<")[0].replace(/"/g, "").trim() || "Unknown"}</span>}
                              <span>{new Date(email.date).toLocaleString("ja-JP", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                           </div>
                           <div
                              className={`p-3.5 text-[15px] leading-relaxed whitespace-pre-wrap select-text shadow-sm transition-all cursor-pointer ${isSelected ? 'ring-2 ring-white scale-[0.98]' : ''} ${isMe ? 'bg-[#5865F2] text-white rounded-2xl rounded-tr-sm' : 'bg-[#2B2D31] text-gray-200 rounded-2xl rounded-tl-sm hover:bg-[#35373C]'}`}
                              style={{ wordBreak: 'break-word', overflowWrap: 'anywhere', border: `2px solid ${msgColor}` }}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (isActionGrayedOut) return;
                                if (state.selectionMode.startsWith("msg_")) {
                                  if (e.shiftKey && lastMsgIdxRef.current >= 0) {
                                    const allMsgs = computed.groupedEmails[state.selectedSender!] || [];
                                    const min = Math.min(msgIdx, lastMsgIdxRef.current);
                                    const max = Math.max(msgIdx, lastMsgIdxRef.current);
                                    const rangeIds = allMsgs.slice(min, max + 1).map((m: any) => m.id);
                                    actions.setSelectedIds((prev: string[]) => [...new Set([...prev, ...rangeIds])]);
                                  } else {
                                    actions.toggleSelection(email.id);
                                    lastMsgIdxRef.current = msgIdx;
                                  }
                                } else {
                                  // 折りたたみ時はまず展開、展開済みならモーダルを開く
                                  if (isCollapsed) {
                                    actions.toggleMsgExpand(email.id);
                                  } else {
                                    actions.openEmailModal(email);
                                  }
                                }
                              }}
                              onTouchStart={() => {
                                if (!state.hasMouse) {
                                  refs.touchTimer.current = setTimeout(() => {
                                    if (!state.selectionMode.startsWith("msg_")) {
                                      actions.enterSelectionMode("msg", email.id);
                                    } else {
                                      actions.toggleSelection(email.id);
                                    }
                                  }, 500);
                                }
                              }}
                              onTouchMove={() => {
                                if (refs.touchTimer.current) { clearTimeout(refs.touchTimer.current); refs.touchTimer.current = null; }
                              }}
                              onTouchEnd={() => {
                                if (refs.touchTimer.current) { clearTimeout(refs.touchTimer.current); refs.touchTimer.current = null; }
                              }}
                           >
                              {state.chatConfigs[email.id]?.isPinned && <span className="text-[#FEE75C] text-xs mr-2 select-none">📌</span>}
                              {hasVisibleSubject && (
                                <div className="font-bold text-sm mb-1.5 pb-1.5 border-b border-black/10"><HighlightText text={displaySubject} highlight={subjectFindHighlight} field="subject" activeField={activeFindField} activeIndex={activeFindIndex} /></div>
                              )}
                              <div
                                style={isCollapsed && state.collapseLinesCount ? {
                                  display: '-webkit-box',
                                  WebkitLineClamp: state.collapseLinesCount,
                                  WebkitBoxOrient: 'vertical',
                                  overflow: 'hidden',
                                } : undefined}
                              >
                                {hasVisibleSubject || hasBody ? (
                                  <BodyWithLinks text={email.body} highlight={bodyFindHighlight} htmlLinks={email.htmlLinks} field="body" activeField={activeFindField} activeIndex={activeFindIndex} />
                                ) : (
                                  <span>(件名なし)</span>
                                )}
                              </div>
                              {isCollapsed && (
                                <div className="text-xs mt-1.5 opacity-60">もっと見る...</div>
                              )}
                           </div>
                           {email.attachments && email.attachments.length > 0 && (
                             <div className={`flex flex-wrap gap-2 mt-2 mx-1 ${isMe ? 'justify-end' : 'justify-start'}`}>
                               {email.attachments.map((att: any, attIdx: number) => {
                                 // attachmentId は再取得のたびに変わることがあるため、
                                 // 添付順+ファイル名+サイズで安定したキャッシュキーを作る
                                 const cacheKey = attachmentCacheKey(email.id, attIdx, att.filename, att.size);
                                 if (att.mimeType.startsWith('image/')) {
                                   return (
                                     <InlineAttachmentImage
                                       key={cacheKey}
                                       attachment={att}
                                       messageId={email.id}
                                       cacheKey={cacheKey}
                                       onOpen={(base64) => actions.openAttachmentModal({ ...att, messageId: email.id, cacheKey }, base64)}
                                     />
                                   );
                                 }
                                 if (att.mimeType.startsWith('video/')) {
                                   return (
                                     <VideoAttachmentChip
                                       key={cacheKey}
                                       attachment={att}
                                       messageId={email.id}
                                       cacheKey={cacheKey}
                                       onOpen={() => actions.openAttachmentModal({ ...att, messageId: email.id, cacheKey })}
                                     />
                                   );
                                 }
                                 return (
                                   <button
                                     key={cacheKey}
                                     onClick={(e) => { e.stopPropagation(); actions.openAttachmentModal({ ...att, messageId: email.id, cacheKey }); }}
                                     className="flex items-center gap-2 px-3 py-2 rounded-xl bg-black/20 border border-white/10 hover:bg-black/30 transition text-left max-w-[200px]"
                                   >
                                     <span className="text-xl flex-shrink-0">{getFileIcon(att.mimeType)}</span>
                                     <div className="min-w-0">
                                       <div className="text-xs font-bold truncate text-gray-200">{att.filename}</div>
                                       <div className="text-[10px] text-gray-400">{formatFileSize(att.size)}</div>
                                     </div>
                                   </button>
                                 );
                               })}
                             </div>
                           )}
                        </div>

                        {isMe && !state.selectionMode.startsWith("msg_") && (
                           <img src={`/api/avatar?name=${encodeURIComponent(auth.session?.user?.name || "Me")}`} alt="" className="w-9 h-9 rounded-full ml-3 flex-shrink-0 mt-1 shadow-sm select-none pointer-events-none" />
                        )}
                      </div>
                    );
                })}
                
                {computed.groupedEmails[state.selectedSender!] && (
                  <div className="flex justify-center my-4 w-full">
                    {state.msgStatusMessage ? (
                      <span className="text-xs text-gray-500 font-medium px-3 py-1.5 bg-[#2B2D31] rounded-full border border-[#1E1F22]/10">{state.msgStatusMessage}</span>
                    ) : state.isLoadingMore ? (
                      <span className="text-xs text-[#5865F2] font-medium animate-pulse">過去のメッセージを読み込み中...</span>
                    ) : null}
                  </div>
                )}
              </div>

              <div className="p-4 bg-[#313338] cursor-default" onClick={(e) => e.stopPropagation()}>
                <div className={`bg-[#383A40] rounded-lg p-3 border border-[#1E1F22] ${isInboundOnlyGroup ? "opacity-40 pointer-events-none grayscale" : ""}`}>
                  {isInboundOnlyGroup && (
                    <div className="text-[11px] text-gray-400 mb-2">受信専用のグループチャットのため、送信・返信はできません</div>
                  )}
                  <div className="flex items-center gap-2 bg-[#2B2D31] text-gray-300 p-2 rounded text-xs mb-2 border-l-4 border-[#5865F2]">
                    <span className="text-gray-400 flex-shrink-0">返信先:</span>
                    <span className={`truncate flex-1 ${state.replyToMessage ? "" : "text-gray-500"}`}>
                      {state.replyToMessage ? (state.replyToMessage.subject || state.replyToMessage.snippet || "(件名なし)") : "未選択"}
                    </span>
                    <button
                      disabled={isInboundOnlyGroup}
                      onClick={(e) => {
                        e.stopPropagation();
                        actions.setModal({ type: "select_reply_target", targetMode: "current_chat", targets: [] });
                        window.history.pushState({ action: "modal" }, "", window.location.href);
                      }}
                      className="font-bold px-2 text-[#5865F2] hover:text-white flex-shrink-0"
                    >
                      {state.replyToMessage ? "返信先を変更" : "返信先を選択"}
                    </button>
                    {state.replyToMessage && (
                      <button onClick={(e) => { e.stopPropagation(); actions.setReplyToMessage(null); }} className="font-bold px-1 hover:text-white flex-shrink-0">×</button>
                    )}
                  </div>
                  <input disabled={isInboundOnlyGroup} type="text" placeholder="件名 (省略可)" value={state.replySubject} onChange={(e) => actions.setReplySubject(e.target.value)} onClick={(e) => e.stopPropagation()} className="w-full text-sm px-2 py-1 mb-2 bg-transparent text-white focus:outline-none placeholder-gray-500 font-medium border-b border-[#2B2D31]" />
                  <div className="flex items-end gap-2">
                    <textarea disabled={isInboundOnlyGroup} placeholder={`Message to ${state.chatConfigs[state.selectedSender!]?.customName || state.selectedSender}`} rows={state.isMobile ? 1 : 2} value={state.replyBody} onChange={(e) => actions.setReplyBody(e.target.value)} onClick={(e) => e.stopPropagation()} className="flex-1 resize-none text-[15px] bg-transparent text-white px-2 py-1 focus:outline-none placeholder-gray-500" />
                    <button onClick={(e) => { e.stopPropagation(); actions.handleSend(); }} disabled={isInboundOnlyGroup || state.isSending || !state.replyBody.trim()} className="text-white px-4 py-2 rounded font-bold text-sm bg-[#5865F2] hover:bg-[#4752C4] transition disabled:bg-[#3f4147] disabled:text-gray-500 active:scale-95">
                      {state.isSending ? "..." : "送信"}
                    </button>
                  </div>
                </div>
              </div>
            </>
          ) : state.selectedSender ? (
            // リロード直後・タブ復元直後などデータ読み込み中は、
            // 「チャットを選択してください」ではなくメッセージ画面のUIを先に出す
            <>
              <header className="px-4 py-3 bg-[#313338] border-b border-[#1E1F22] shadow-sm z-10 flex items-center gap-3 cursor-default">
                {state.isMobile && (
                  <button onClick={(e) => { e.stopPropagation(); actions.safeBack(); }} className="text-gray-400 hover:text-white font-bold p-1 text-lg transition active:scale-90">←</button>
                )}
                <div className="flex-1 min-w-0">
                  <h2 className="font-bold text-base truncate text-white">{state.chatConfigs[state.selectedSender]?.customName || state.selectedSender}</h2>
                </div>
              </header>
              <div className="flex flex-1 items-center justify-center text-gray-500 text-sm cursor-default">
                読み込み中...
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-gray-500 font-bold cursor-default">
              左のリストからチャットを選択してください
            </div>
          )}
        </main>
      )}
    </div>
  );
}