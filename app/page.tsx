"use client";

import { signIn, signOut } from "next-auth/react";
import { useMailApp } from "./hooks/useMailApp";
import { HighlightText, ActionBar } from "./components/ui";
import { ContextMenu } from "./components/ContextMenu";
import { Modals } from "./components/Modals";

export default function Home() {
  const app = useMailApp();
  const { auth, state, actions, computed, refs } = app;

  if (auth.status === "loading") return <div className="flex h-screen items-center justify-center bg-[#313338] text-gray-400 font-bold">読み込み中...</div>;
  if (!auth.session) return (
    <div className="flex h-screen flex-col items-center justify-center bg-[#313338] text-white">
      <h1 className="mb-8 text-5xl font-extrabold text-[#5865F2]">Re:Mail</h1>
      <button onClick={() => signIn("google", { callbackUrl: "/" })} className="rounded bg-[#5865F2] px-8 py-3 font-bold shadow transition hover:bg-[#4752C4] active:scale-95">Googleでログインして始める</button>
    </div>
  );

  const showChatList = !state.isMobile || !state.selectedSender;
  const showTalk = !state.isMobile || state.selectedSender;

  return (
    <div className="flex h-[100dvh] w-full bg-[#313338] overflow-hidden text-gray-200 relative select-none" onClick={actions.handleBackgroundClick}>
      <ContextMenu app={app} />
      <Modals app={app} />

      {showChatList && (
        <aside className={`${state.isMobile ? 'w-full' : 'w-[320px] border-r'} border-[#1E1F22] bg-[#2B2D31] flex flex-col h-full min-h-0 cursor-pointer`}>
          <div className="p-4 border-b border-[#1E1F22] shadow-sm flex items-center justify-between cursor-default">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 flex items-center justify-center">
                {(state.selectionMode !== "none" || state.searchKeyword !== "") && (
                  <button onClick={(e) => { e.stopPropagation(); actions.safeBack(); }} className="text-gray-400 hover:text-white font-bold text-lg transition active:scale-90">←</button>
                )}
              </div>
              <h1 className="text-xl font-extrabold text-white tracking-wide">Re:Mail</h1>
            </div>
            <button onClick={(e) => { e.stopPropagation(); signOut({ callbackUrl: "/" }); }} className="text-xs text-gray-400 hover:text-white transition">ログアウト</button>
          </div>

          <div className="p-3 border-b border-[#1E1F22] bg-[#232428] cursor-default">
             <div className="relative w-full">
               <input onClick={(e) => e.stopPropagation()} type="text" placeholder="キーワード検索 (アドレス・件名・本文)..." className="w-full bg-[#1E1F22] text-sm text-gray-300 pl-3 pr-8 py-1.5 rounded focus:outline-none focus:ring-1 focus:ring-[#5865F2]" value={state.searchKeyword} onChange={(e) => actions.handleSearchChange(e.target.value)} />
               {state.searchKeyword && <button onClick={(e) => { e.stopPropagation(); actions.safeBack(); }} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white text-xs font-bold px-1 transition">✕</button>}
             </div>
             
             <div className="flex flex-wrap gap-1 text-[11px] mt-2 font-bold">
                <label onClick={(e) => e.stopPropagation()} className="flex items-center gap-1 cursor-pointer bg-[#313338] px-2 py-1.5 rounded flex-1 justify-center hover:bg-[#3f4147]"><input type="checkbox" checked={state.checkInbox} onChange={(e) => actions.setCheckInbox(e.target.checked)} className="accent-[#5865F2]" /> 受信箱</label>
                <label onClick={(e) => e.stopPropagation()} className="flex items-center gap-1 cursor-pointer bg-[#313338] px-2 py-1.5 rounded flex-1 justify-center hover:bg-[#3f4147]"><input type="checkbox" checked={state.checkArchive} onChange={(e) => actions.setCheckArchive(e.target.checked)} className="accent-[#95A5A6]" /> アーカイブ</label>
                {/* ★修正: 送信済みチェックボックスを並列で追加 */}
                <label onClick={(e) => e.stopPropagation()} className="flex items-center gap-1 cursor-pointer bg-[#313338] px-2 py-1.5 rounded flex-1 justify-center hover:bg-[#3f4147]"><input type="checkbox" checked={state.checkSent} onChange={(e) => actions.setCheckSent(e.target.checked)} className="accent-[#1ABC9C]" /> 送信済</label>
                <label onClick={(e) => e.stopPropagation()} className="flex items-center gap-1 cursor-pointer bg-[#313338] px-2 py-1.5 rounded flex-1 justify-center hover:bg-[#3f4147]"><input type="checkbox" checked={state.checkSpam} onChange={(e) => actions.setCheckSpam(e.target.checked)} className="accent-[#FEE75C]" /> 迷惑</label>
                <label onClick={(e) => e.stopPropagation()} className="flex items-center gap-1 cursor-pointer bg-[#313338] px-2 py-1.5 rounded flex-1 justify-center hover:bg-[#3f4147]"><input type="checkbox" checked={state.checkTrash} onChange={(e) => actions.setCheckTrash(e.target.checked)} className="accent-[#DA373C]" /> ゴミ箱</label>
             </div>
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
             {computed.senderList.map((sender) => {
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

              const latestEmail = visibleEmails[0];
              if (!latestEmail) return null;

              const isSelected = state.selectedIds.includes(sender);
              const isOpened = state.selectedSender === sender && !state.isMobile;
              const count = visibleEmails.length;
              const latestDate = new Date(latestEmail.date).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

              let previewSubject = latestEmail.subject || "No Subject";
              let previewSnippet = "";
              
              if (state.searchKeyword) {
                 const kwLower = state.searchKeyword.toLowerCase();
                 const matched = visibleEmails.find((e: any) => e.subject?.toLowerCase().includes(kwLower) || e.body?.toLowerCase().includes(kwLower) || e.from?.toLowerCase().includes(kwLower) || e.to?.toLowerCase().includes(kwLower));
                 if (matched) {
                    previewSubject = matched.subject || "No Subject";
                    const bodyStr = matched.body || "";
                    const idx = bodyStr.toLowerCase().indexOf(kwLower);
                    if (idx !== -1 && !matched.subject?.toLowerCase().includes(kwLower)) {
                        const start = Math.max(0, idx - 15);
                        previewSnippet = (start > 0 ? "..." : "") + bodyStr.substring(start, idx + kwLower.length + 20).replace(/\s+/g, " ") + "...";
                    }
                 }
              }

              // ★追加: オンデマンド学習した「記憶」を呼び出す
              const kb = state.knownBoxes?.[sender] || [];
              const knownHasTrash = kb.includes("TRASH");
              const knownHasSpam = kb.includes("SPAM");
              const knownHasInbox = kb.includes("INBOX");
              const knownHasArchive = kb.includes("ARCHIVE");
              const knownHasSent = kb.includes("SENT"); // ★追加

              // ★修正: 送信済み「のみ」のチャットは移動モード時に強制グレーアウト
              const isChatOnlySent = knownHasSent && kb.length === 1;

              // ★修正: 移動の無効化判定に記憶データを合流させる（SENTも考慮）
              const isMoveGrayedOut = state.selectionMode === "chat_move" && (
                 isChatOnlySent || 
                 (state.moveDestination && 
                   (visibleEmails.length > 0 && visibleEmails.every((e: any) => e.labelIds?.includes(state.moveDestination!) || (state.moveDestination === "ARCHIVE" && !e.labelIds?.includes("TRASH") && !e.labelIds?.includes("SPAM") && !e.labelIds?.includes("INBOX") && !e.labelIds?.includes("SENT") && !e.isMe))) &&
                   (kb.length === 0 || kb.every((b: string) => b === state.moveDestination || (state.moveDestination === "ARCHIVE" && b === "ARCHIVE")))
                 )
              );

              // ★修正: ピン留め/非表示の対象(INBOXかARCHIVE)がいるか判定
              const hasValidFetchedMail = visibleEmails.some((e: any) => !e.labelIds?.includes("TRASH") && !e.labelIds?.includes("SPAM"));
              
              // ★修正: 記憶データを「現在のチェックボックスの状態」と照らし合わせて厳格に判定
              const hasValidKnownMail = (!hasValidFetchedMail && kb.length > 0) ? (
                  (knownHasInbox && state.checkInbox) ||
                  (knownHasArchive && state.checkArchive) ||
                  (knownHasSent && state.checkSent && !knownHasTrash && !knownHasSpam)
              ) : false;

              const hasLiveTarget = hasValidFetchedMail || hasValidKnownMail;
              
              const isPinGrayedOut = state.selectionMode === "chat_pin" && !hasLiveTarget;
              const isHideGrayedOut = state.selectionMode === "chat_hide" && !hasLiveTarget;

              // ★追加: 削除モード時、ゴミ箱と送信済みだけのチャットはグレーアウトして選択不能にする
              const isDeleteGrayedOut = state.selectionMode === "chat_delete" && 
                (kb.length > 0 ? kb.every((b: string) => b === "TRASH" || b === "SENT") : 
                 (visibleEmails.length > 0 && visibleEmails.every((e: any) => e.labelIds?.includes("TRASH") || e.labelIds?.includes("SENT") || e.isMe)));

              const isActionGrayedOut = isMoveGrayedOut || isPinGrayedOut || isHideGrayedOut || isDeleteGrayedOut;

              // ★修正: グラデーション色の判定に送信済みカラー(sent)を追加
              const colorsSet = new Set<string>();
              if (knownHasTrash && state.checkTrash) colorsSet.add(state.boxColors.trash);
              if (knownHasSpam && state.checkSpam) colorsSet.add(state.boxColors.spam);
              if (knownHasArchive && state.checkArchive) colorsSet.add(state.boxColors.archive);
              if (knownHasInbox && state.checkInbox) colorsSet.add(state.boxColors.inbox);
              if (knownHasSent && state.checkSent) colorsSet.add(state.boxColors.sent); // ★追加

              visibleEmails.forEach((e: any) => {
                 const isTrash = e.labelIds?.includes("TRASH");
                 const isSpam = e.labelIds?.includes("SPAM");
                 const isInbox = e.labelIds?.includes("INBOX");
                 const isSent = e.labelIds?.includes("SENT") || e.isMe; // ★追加
                 const isArchive = !isTrash && !isSpam && !isInbox && !isSent; // ★修正

                 if (isTrash) colorsSet.add(state.boxColors.trash);
                 else if (isSpam) colorsSet.add(state.boxColors.spam);
                 else if (isInbox) colorsSet.add(state.boxColors.inbox);
                 else if (isSent) colorsSet.add(state.boxColors.sent); // ★追加
                 else colorsSet.add(state.boxColors.archive);
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

              return (
                <div key={sender} style={wrapperStyle} className="mb-1">
                  <div 
                    onClick={(e) => {
                      e.stopPropagation();
                      if (isActionGrayedOut) return;
                      if (state.selectionMode.startsWith("chat_")) actions.toggleSelection(sender);
                      else actions.openChat(sender);
                    }}
                    onContextMenu={(e) => { e.preventDefault(); actions.setContextMenu({ type: "chat", target: sender, x: e.clientX, y: e.clientY }); }}
                    onTouchStart={(e) => { if (!state.hasMouse) refs.touchTimer.current = setTimeout(() => { actions.setContextMenu({ type: "chat", target: sender, x: window.innerWidth/2, y: window.innerHeight/2 }); }, 500); }}
                    onTouchEnd={() => refs.touchTimer.current && clearTimeout(refs.touchTimer.current)}
                    onTouchMove={() => refs.touchTimer.current && clearTimeout(refs.touchTimer.current)}
                    className={innerClass}
                    style={innerStyle}
                  >
                    {state.selectionMode.startsWith("chat_") && (
                      <div className={`w-4 h-4 mr-3 rounded-sm flex items-center justify-center border ${isSelected ? 'bg-[#5865F2] border-[#5865F2]' : 'border-gray-500'}`}>
                        {isSelected && <div className="w-2 h-2 bg-white rounded-sm"></div>}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between items-baseline">
                        <div className="flex items-center gap-1 truncate pr-2">
                          {config?.isPinned && (state.checkInbox || state.checkArchive || state.checkSent) && <span className="text-[#FEE75C] text-[10px]">📌</span>}
                          <span className="font-bold text-sm truncate"><HighlightText text={config?.customName || sender} highlight={state.searchKeyword} /></span>
                        </div>
                        <span className="text-[10px] text-gray-500 flex-shrink-0">{latestDate}</span>
                      </div>
                      <div className="text-[10px] text-[#5865F2] font-bold mt-0.5">{count}件のメッセージ</div>
                      <div className="text-xs text-gray-500 truncate mt-0.5">
                        <HighlightText text={previewSubject} highlight={state.searchKeyword} />
                        {previewSnippet && <span className="ml-1 text-gray-400">- <HighlightText text={previewSnippet} highlight={state.searchKeyword} /></span>}
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
          {state.selectedSender && computed.groupedEmails[state.selectedSender!] && computed.groupedEmails[state.selectedSender!].length > 0 ? (
            <>
              <header className="px-4 py-3 bg-[#313338] border-b border-[#1E1F22] shadow-sm z-10 flex items-center gap-3 cursor-default">
                {state.isMobile && (
                  <button onClick={(e) => { e.stopPropagation(); actions.safeBack(); }} className="text-gray-400 hover:text-white font-bold p-1 text-lg transition active:scale-90">←</button>
                )}
                <div className="flex-1 min-w-0 flex items-baseline gap-2">
                  <h2 className="font-bold text-base truncate text-white">{state.chatConfigs[state.selectedSender!]?.customName || state.selectedSender}</h2>
                  {(() => {
                    const firstPartner = computed.groupedEmails[state.selectedSender!].find((e: any) => !e.isMe && !e.from.includes(auth.session?.user?.email || ""));
                    if (!firstPartner) return null;
                    const addrMatch = firstPartner.from.match(/<([^>]+)>/);
                    const addr = addrMatch ? addrMatch[1].trim() : firstPartner.from.trim();
                    return <span className="text-xs text-gray-500 truncate">{addr}</span>;
                  })()}
                </div>
              </header>

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
                {computed.groupedEmails[state.selectedSender!].map((email: any) => {
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
                          <div key={`prompt-${email.id}`} className={`flex w-full mb-6 cursor-default transition ${isMe ? 'justify-end' : 'justify-start'}`}>
                            {!isMe && !state.selectionMode.startsWith("msg_") && (
                               <img src={`/api/avatar?name=${encodeURIComponent(email.from.split("<")[0].replace(/"/g, "").trim() || "Unknown")}`} alt="" className="w-9 h-9 rounded-full mr-3 flex-shrink-0 mt-1 shadow-sm select-none pointer-events-none opacity-80" />
                            )}
                            
                            <div className={`flex flex-col max-w-[75%] ${isMe ? 'items-end' : 'items-start'}`}>
                               <div className="flex items-center gap-2 mb-1.5 mx-1 text-[11px] text-gray-400 select-none">
                                  {!isMe && <span className="font-bold text-gray-300">{email.from.split("<")[0].replace(/"/g, "").trim() || "Unknown"}</span>}
                                  <span>{new Date(email.date).toLocaleString("ja-JP", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
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
                    
                    // ★修正: メッセージの枠色にも送信済みを反映
                    const msgColor = isTrash ? state.boxColors.trash : isSpam ? state.boxColors.spam : isSent ? state.boxColors.sent : isArchive ? state.boxColors.archive : state.boxColors.inbox;

                    return (
                      <div 
                        id={`msg-${email.id}`}
                        key={email.id} 
                        onClick={(e) => {
                          e.stopPropagation(); 
                          if (isActionGrayedOut) return;
                          if (state.selectionMode.startsWith("msg_")) actions.toggleSelection(email.id);
                        }}
                        className={`flex w-full mb-6 cursor-default transition ${isActionGrayedOut ? 'opacity-30 pointer-events-none grayscale' : ''} ${isMe ? 'justify-end' : 'justify-start'}`}
                      >
                        {state.selectionMode.startsWith("msg_") && (
                          <div className="flex-shrink-0 w-8 flex justify-center pt-3 mr-2">
                            <div className={`w-5 h-5 rounded-sm flex items-center justify-center border cursor-pointer ${isSelected ? 'bg-[#5865F2] border-[#5865F2]' : 'border-gray-500'}`}>
                              {isSelected && <div className="w-2.5 h-2.5 bg-white rounded-sm"></div>}
                            </div>
                          </div>
                        )}
                        
                        {!isMe && !state.selectionMode.startsWith("msg_") && (
                           <img src={`/api/avatar?name=${encodeURIComponent(email.from.split("<")[0].replace(/"/g, "").trim() || "Unknown")}`} alt="" className="w-9 h-9 rounded-full mr-3 flex-shrink-0 mt-1 shadow-sm select-none pointer-events-none" />
                        )}

                        <div className={`flex flex-col max-w-[75%] ${isMe ? 'items-end' : 'items-start'}`}>
                           <div className="flex items-center gap-2 mb-1.5 mx-1 text-[11px] text-gray-400 select-none">
                              {!isMe && <span className="font-bold text-gray-300">{email.from.split("<")[0].replace(/"/g, "").trim() || "Unknown"}</span>}
                              <span>{new Date(email.date).toLocaleString("ja-JP", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                           </div>
                           <div 
                              className={`p-3.5 text-[15px] leading-relaxed whitespace-pre-wrap select-text shadow-sm transition-all cursor-pointer ${isSelected ? 'ring-2 ring-white scale-[0.98]' : ''} ${isMe ? 'bg-[#5865F2] text-white rounded-2xl rounded-tr-sm' : 'bg-[#2B2D31] text-gray-200 rounded-2xl rounded-tl-sm hover:bg-[#35373C]'}`}
                              style={{ wordBreak: 'break-word', overflowWrap: 'anywhere', border: `2px solid ${msgColor}` }}
                              onContextMenu={(e) => { e.preventDefault(); actions.setContextMenu({ type: "msg", target: email, x: e.clientX, y: e.clientY }); }}
                              onTouchStart={(e) => { if (!state.hasMouse) refs.touchTimer.current = setTimeout(() => { actions.setContextMenu({ type: "msg", target: email, x: window.innerWidth/2, y: window.innerHeight/2 }); }, 500); }}
                              onTouchEnd={() => refs.touchTimer.current && clearTimeout(refs.touchTimer.current)}
                              onTouchMove={() => refs.touchTimer.current && clearTimeout(refs.touchTimer.current)}
                           >
                              {state.chatConfigs[email.id]?.isPinned && (state.checkInbox || state.checkArchive || state.checkSent) && <span className="text-[#FEE75C] text-xs mr-2 select-none">📌</span>}
                              {email.subject && !email.subject.startsWith("Re:") && (
                                <div className="font-bold text-sm mb-1.5 pb-1.5 border-b border-black/10"><HighlightText text={email.subject} highlight={state.searchKeyword} /></div>
                              )}
                              <HighlightText text={email.body} highlight={state.searchKeyword} />
                           </div>
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
                <div className="bg-[#383A40] rounded-lg p-3 border border-[#1E1F22]">
                  {state.replyToMessage && (
                    <div className="flex justify-between items-center bg-[#2B2D31] text-gray-300 p-2 rounded text-xs mb-2 border-l-4 border-[#5865F2]">
                      <span className="truncate">Replying to: {state.replyToMessage.subject || state.replyToMessage.snippet}</span>
                      <button onClick={(e) => { e.stopPropagation(); actions.setReplyToMessage(null); }} className="font-bold px-2 hover:text-white">×</button>
                    </div>
                  )}
                  <input type="text" placeholder="件名 (省略可)" value={state.replySubject} onChange={(e) => actions.setReplySubject(e.target.value)} onClick={(e) => e.stopPropagation()} className="w-full text-sm px-2 py-1 mb-2 bg-transparent text-white focus:outline-none placeholder-gray-500 font-medium border-b border-[#2B2D31]" />
                  <div className="flex items-end gap-2">
                    <textarea placeholder={`Message to ${state.chatConfigs[state.selectedSender!]?.customName || state.selectedSender}`} rows={state.isMobile ? 1 : 2} value={state.replyBody} onChange={(e) => actions.setReplyBody(e.target.value)} onClick={(e) => e.stopPropagation()} className="flex-1 resize-none text-[15px] bg-transparent text-white px-2 py-1 focus:outline-none placeholder-gray-500" />
                    <button onClick={(e) => { e.stopPropagation(); actions.handleSend(); }} disabled={state.isSending || !state.replyBody.trim()} className="text-white px-4 py-2 rounded font-bold text-sm bg-[#5865F2] hover:bg-[#4752C4] transition disabled:bg-[#3f4147] disabled:text-gray-500 active:scale-95">
                      {state.isSending ? "..." : "送信"}
                    </button>
                  </div>
                </div>
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