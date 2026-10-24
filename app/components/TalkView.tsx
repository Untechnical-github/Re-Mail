"use client";

import type { MutableRefObject, ReactNode } from "react";
import type { MailAppHook } from "../hooks/useMailApp";
import type { Email } from "../types/email";
import type { ChatConfig } from "../types/mail";
import { HighlightText, ActionBar, BodyWithLinks, getFileIcon, formatFileSize, PinIcon, WarningIcon } from "./ui";
import { InlineAttachmentImage, VideoAttachmentChip } from "./AttachmentChips";
import { isMineEmail } from "../lib/filterMatch";
import { sentRecipientCounts, receivedRole } from "../lib/composeRecipients";
import { attachmentCacheKey } from "../lib/attachmentCache";

// トーク画面（見出し・ページ内検索・ピン留め・メッセージ一覧。入力欄は composer として受け取って下に置く）。page.tsx から分けたもの（動きは同じ）
export function TalkView({ app, lastMsgIdxRef, collapseCompose, selectedGroupConfig, isFilterGroup, isInboundOnlyGroup, isOutboundOnlyGroup, subjectFindHighlight, bodyFindHighlight, getMsgColor, composer }: {
  app: MailAppHook;
  lastMsgIdxRef: MutableRefObject<number>;
  collapseCompose: () => void;
  selectedGroupConfig: ChatConfig | undefined;
  isFilterGroup: boolean;
  isInboundOnlyGroup: boolean;
  isOutboundOnlyGroup: boolean;
  subjectFindHighlight: string;
  bodyFindHighlight: string;
  getMsgColor: (msg: Email) => string;
  composer: ReactNode;
}) {
  const { auth, state, actions, computed, refs } = app;
  return (
        <main className={`${state.isMobile ? 'w-full' : 'flex-1'} flex flex-col bg-[#313338] relative cursor-pointer`}>
          {state.selectedSender && ((computed.groupedEmails[state.selectedSender!] && computed.groupedEmails[state.selectedSender!].length > 0) || state.draftChats.includes(state.selectedSender!)) ? (
            <>
              <header className="px-4 py-3 bg-[#313338] border-b border-[#1E1F22] shadow-sm z-10 flex items-center gap-3 cursor-default">
                {state.isMobile && (
                  <button onClick={(e) => { e.stopPropagation(); actions.safeBack(); }} className="text-gray-400 hover:text-white font-bold p-1 text-lg transition active:scale-90">←</button>
                )}
                <div className="flex-1 min-w-0 flex items-baseline gap-2">
                  <h2 className="font-bold text-base truncate text-white">{state.chatConfigs[state.selectedSender!]?.customName || actions.roomLocalKey(state.selectedSender!)}</h2>
                  {state.linkedAccounts.length > 0 && (() => {
                    const acct = actions.roomAccountEmail(state.selectedSender!);
                    const needsReauth = state.reauthNeededAccounts.includes(acct);
                    return (
                      <span
                        title={needsReauth ? `${acct}（ログインが切れています。再ログインしてください）` : acct}
                        className={`text-[9px] font-bold px-1 py-0.5 rounded flex-shrink-0 leading-none flex items-center ${needsReauth ? "bg-red-500/25 text-red-400" : "bg-[#5865F2]/25 text-[#5865F2]"}`}
                      >
                        {needsReauth ? <WarningIcon className="w-2.5 h-2.5" /> : (acct[0]?.toUpperCase() || "?")}
                      </span>
                    );
                  })()}
                  {selectedGroupConfig?.isGroup ? (
                    <span className="text-xs text-gray-500 truncate">
                      {isFilterGroup ? "フィルターグループ" : `グループ・${(selectedGroupConfig.groupMembers || []).length}人`}
                      {isInboundOnlyGroup ? "・受信専用" : isOutboundOnlyGroup ? "・送信専用" : ""}
                    </span>
                  ) : (() => {
                    const firstPartner = (computed.groupedEmails[state.selectedSender!] || []).find((e) => !isMineEmail(e, actions.roomAccountEmail(state.selectedSender!)));
                    if (!firstPartner) return null;
                    const addrMatch = firstPartner.from.match(/<([^>]+)>/);
                    const addr = addrMatch ? addrMatch[1].trim() : firstPartner.from.trim();
                    return <span className="text-xs text-gray-500 truncate">{addr}</span>;
                  })()}
                </div>
                {state.isMobile && (
                  <button onClick={(e) => { e.stopPropagation(); actions.setModal({ type: "filter_tool", targetMode: "all_chats", targets: [] }); window.history.pushState({ action: "modal" }, "", window.location.href); }} className="text-gray-400 hover:text-white transition flex-shrink-0" title="フィルター">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M2.628 1.601C5.028 1.206 7.49 1 10 1s4.973.206 7.372.601a.75.75 0 01.628.74v2.288a2.25 2.25 0 01-.659 1.59l-4.682 4.683a2.25 2.25 0 00-.659 1.59v3.037c0 .684-.31 1.33-.844 1.757l-1.937 1.55A.75.75 0 018 18.25v-5.757a2.25 2.25 0 00-.659-1.591L2.659 6.22A2.25 2.25 0 012 4.629V2.34a.75.75 0 01.628-.74z" clipRule="evenodd" /></svg>
                  </button>
                )}
                <button onClick={(e) => { e.stopPropagation(); actions.openFindBar(); }} className="text-gray-400 hover:text-white transition flex-shrink-0" title="検索">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z" clipRule="evenodd" /></svg>
                </button>
                {state.isMobile && (
                  <>
                    <button onClick={(e) => { e.stopPropagation(); actions.setModal({ type: "settings", targetMode: "all_chats", targets: [] }); window.history.pushState({ action: "modal" }, "", window.location.href); }} className="text-gray-400 hover:text-white transition flex-shrink-0" title="設定">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor"><path fillRule="evenodd" d="M11.078 2.25c-.917 0-1.699.663-1.85 1.567L9.05 4.889c-.02.12-.115.26-.297.348a7.493 7.493 0 00-.986.57c-.166.115-.334.126-.45.083L6.3 5.508a1.875 1.875 0 00-2.282.819l-.922 1.597a1.875 1.875 0 00.432 2.385l.84.692c.095.078.17.229.154.43a7.598 7.598 0 000 1.139c.015.2-.059.352-.153.43l-.841.692a1.875 1.875 0 00-.432 2.385l.922 1.597a1.875 1.875 0 002.282.818l1.019-.382c.115-.043.283-.031.45.082.312.214.641.405.985.57.182.088.277.228.297.35l.178 1.071c.151.904.933 1.567 1.85 1.567h1.844c.916 0 1.699-.663 1.85-1.567l.178-1.072c.02-.12.114-.26.297-.349.344-.165.673-.356.985-.57.167-.114.335-.125.45-.082l1.02.382a1.875 1.875 0 002.28-.819l.923-1.597a1.875 1.875 0 00-.432-2.385l-.84-.692c-.095-.078-.17-.229-.154-.43a7.614 7.614 0 000-1.139c-.016-.2.059-.352.153-.43l.84-.692c.708-.582.891-1.59.433-2.385l-.922-1.597a1.875 1.875 0 00-2.282-.818l-1.02.382c-.114.043-.282.031-.449-.083a7.49 7.49 0 00-.985-.57c-.183-.087-.277-.227-.297-.348l-.179-1.072a1.875 1.875 0 00-1.85-1.567h-1.843ZM12 15.75a3.75 3.75 0 100-7.5 3.75 3.75 0 000 7.5Z" clipRule="evenodd" /></svg>
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); actions.setModal({ type: "account_menu", targetMode: "all_chats", targets: [] }); window.history.pushState({ action: "modal" }, "", window.location.href); }} className="flex-shrink-0" title="アカウント">
                      <img
                        src={auth.session?.user?.image || `/api/avatar?name=${encodeURIComponent(auth.session?.user?.name || "U")}`}
                        alt=""
                        referrerPolicy="no-referrer"
                        className="w-7 h-7 rounded-full"
                      />
                    </button>
                  </>
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
                   <PinIcon className="w-3.5 h-3.5 text-[#FEE75C] flex-shrink-0" />
                   {computed.pinnedMsgsInChat.map((m) => (
                      <button key={`pin-${m.id}`} onClick={(e) => { e.stopPropagation(); document.getElementById(`msg-${m.id}`)?.scrollIntoView({behavior: 'smooth', block: 'center'}); }} className="text-xs bg-[#1E1F22] text-gray-300 px-3 py-1.5 rounded-full truncate max-w-[200px] hover:text-white border border-[#35373C] flex-shrink-0 transition active:scale-95">
                         {m.subject || m.snippet}
                      </button>
                   ))}
                </div>
              )}

              <div 
                key={state.selectedSender} // ★追加: 宛先が変わるたびにスクロール枠を完全に作り直し、位置を一番下へリセットする
                className="flex-1 overflow-y-auto px-4 py-6 flex flex-col-reverse scrollbar-thin cursor-default"
                onWheel={collapseCompose}
                onTouchMove={collapseCompose}
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
                {(computed.groupedEmails[state.selectedSender!] || []).map((email) => {
                    const isTrash = email.labelIds?.includes("TRASH");
                    const isSpam = email.labelIds?.includes("SPAM");
                    const isInbox = email.labelIds?.includes("INBOX");
                    const isSent = email.labelIds?.includes("SENT") || email.isMe; 
                    const isArchive = !isTrash && !isSpam && !isInbox && !isSent; 

                    if ((isInbox || isArchive || isSent) && (state.chatConfigs[state.selectedSender!]?.isHidden || state.messageConfigs[actions.messageConfigKey(email.id)]?.isHidden)) return null;
                    if (!actions.isAccountVisible(email.accountId)) return null;
                    // ピン留めしていたが Gmail 側で削除されたメール。黙って消さず、存在しないことを示す
                    if (email.isMissing) {
                      return (
                        <div id={`msg-${email.id}`} key={`missing-${email.id}`} className="flex justify-center w-full my-3 cursor-default">
                          <span className="text-xs text-gray-400 px-3 py-1.5 bg-[#2B2D31] rounded-full border border-[#FEE75C]/40 flex items-center gap-1.5">
                            <PinIcon className="w-3 h-3 text-[#FEE75C]" /> このメールは存在しません（ピン留め中）
                          </span>
                        </div>
                      );
                    }

                    // ★修正: 連携アカウントのチャットでは「自分」がメインアカウントとは限らないため、
                    // このルーム自身が属するアカウントのメールアドレスで判定する
                    // （メインアカウントのメールアドレスで判定すると、連携アカウント側の受信メールが
                    // 差出人＝メインアカウントの場合に誤って「自分が送った」扱いになってしまう）
                    const isMe = isMineEmail(email, actions.roomAccountEmail(state.selectedSender!));
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
                               <img src={`/api/avatar?name=${encodeURIComponent((() => {
                                 // 自分が送ったメールの頭文字は、そのチャットのアカウントの名前から作る（どのアカウントも同じ扱いにする）
                                 const acct = actions.roomAccountEmail(state.selectedSender!);
                                 if (acct === (auth.session?.user?.email || "")) return auth.session?.user?.name || acct || "Me";
                                 return state.linkedAccountProfiles[acct]?.name || acct || "Me";
                               })())}`} alt="" className="w-9 h-9 rounded-full ml-3 flex-shrink-0 mt-1 shadow-sm select-none pointer-events-none opacity-80" />
                            )}
                          </div>
                        );
                    }

                    const currentFindMatch = state.findBarOpen && state.findBarMatchIndex >= 0 ? computed.findBarMatches[state.findBarMatchIndex] : undefined;
                    const isCurrentFindTarget = currentFindMatch?.id === email.id;
                    const activeFindField = isCurrentFindTarget ? currentFindMatch!.field : undefined;
                    const activeFindIndex = isCurrentFindTarget ? currentFindMatch!.fieldIndex : undefined;

                    const isSentMailMoveRestricted = state.selectionMode === "msg_move" && isSent;

                    // ★追加: 個別メッセージがゴミ箱または迷惑メールにあるか判定
                    const isTrashOrSpamMsg = isTrash || isSpam;
                    // ★修正: ゴミ箱や迷惑メールにあるメッセージ（送信済み含む）はピン留め・非表示の選択モード時に強制グレーアウト
                    const isMsgPinGrayedOut = state.selectionMode === "msg_pin" && (isTrashOrSpamMsg || !(isInbox || isArchive || isSent));
                    const isMsgHideGrayedOut = state.selectionMode === "msg_hide" && (isTrashOrSpamMsg || !(isInbox || isArchive || isSent));
                    
                    // ★追加: 削除モード時、ゴミ箱にあるメールと送信済みメールはグレーアウトして選択不能にする
                    const isDeleteGrayedOut = state.selectionMode === "msg_delete" && (isTrash || isSent);
                    
                    const isActionGrayedOut = isMsgPinGrayedOut || isMsgHideGrayedOut || isSentMailMoveRestricted || isDeleteGrayedOut;
                    
                    // 送信済みを最優先（ゴミ箱内の送信済みも緑で表示）
                    const msgColor = isSent ? state.boxColors.sent : isTrash ? state.boxColors.trash : isSpam ? state.boxColors.spam : isArchive ? state.boxColors.archive : state.boxColors.inbox;

                    const msgIdx = computed.groupedEmails[state.selectedSender!].indexOf(email);
                    const isCollapsed = state.collapseLinesCount !== null && !state.expandedMsgIds.includes(email.id);
                    // Discord風の「返信先」チップ用: このメッセージがどのメッセージへの返信かを解決する
                    const replyTarget = (email.replyToId || email.inReplyTo)
                      ? computed.allUniqueEmails.find((e) => (email.replyToId && e.id === email.replyToId) || (email.inReplyTo && e.messageIdHeader === email.inReplyTo))
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
                                const rangeIds = allMsgs.slice(min, max + 1).map((m) => m.id);
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
                              {/* 宛先の表示設定（共通設定・既定オフ）。送ったメールは人数、受け取ったメールは自分がどの欄で受け取ったか */}
                              {isMe && state.showSentRecipients && (() => {
                                const counts = sentRecipientCounts(email);
                                return counts ? <span className="px-1.5 rounded bg-black/20 text-gray-300">{counts}</span> : null;
                              })()}
                              {!isMe && state.showReceivedRecipients && (
                                <span className="px-1.5 rounded bg-black/20 text-gray-300">{receivedRole(email, actions.myAddressesFor(email.accountId || actions.roomAccountEmail(state.selectedSender!)))}</span>
                              )}
                           </div>
                           <div
                              className={`p-3.5 text-[15px] leading-relaxed whitespace-pre-wrap select-text shadow-sm transition-all cursor-pointer ${email.labelIds?.includes("UNREAD") ? 'font-semibold' : ''} ${isSelected ? 'ring-2 ring-white scale-[0.98]' : ''} ${isMe ? 'bg-[#5865F2] text-white rounded-2xl rounded-tr-sm' : 'bg-[#2B2D31] text-gray-200 rounded-2xl rounded-tl-sm hover:bg-[#35373C]'}`}
                              style={{ wordBreak: 'break-word', overflowWrap: 'anywhere', border: `2px solid ${msgColor}` }}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (isActionGrayedOut) return;
                                if (state.selectionMode.startsWith("msg_")) {
                                  if (e.shiftKey && lastMsgIdxRef.current >= 0) {
                                    const allMsgs = computed.groupedEmails[state.selectedSender!] || [];
                                    const min = Math.min(msgIdx, lastMsgIdxRef.current);
                                    const max = Math.max(msgIdx, lastMsgIdxRef.current);
                                    const rangeIds = allMsgs.slice(min, max + 1).map((m) => m.id);
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
                              {state.messageConfigs[actions.messageConfigKey(email.id)]?.isPinned && <PinIcon className="w-3.5 h-3.5 text-[#FEE75C] mr-2 flex-shrink-0 inline-block align-text-bottom" />}
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
                               {email.attachments.map((att, attIdx) => {
                                 // attachmentId は再取得のたびに変わることがあるため、
                                 // 添付順+ファイル名+サイズで安定したキャッシュキーを作る
                                 const cacheKey = attachmentCacheKey(email.accountId || auth.session?.user?.email || "", email.id, attIdx, att.filename, att.size);
                                 if (att.mimeType.startsWith('image/')) {
                                   return (
                                     <InlineAttachmentImage
                                       key={cacheKey}
                                       attachment={att}
                                       messageId={email.id}
                                       accountId={email.accountId}
                                       cacheKey={cacheKey}
                                       onOpen={(base64) => actions.openAttachmentModal({ ...att, messageId: email.id, accountId: email.accountId, cacheKey }, base64)}
                                     />
                                   );
                                 }
                                 if (att.mimeType.startsWith('video/')) {
                                   return (
                                     <VideoAttachmentChip
                                       key={cacheKey}
                                       attachment={att}
                                       messageId={email.id}
                                       accountId={email.accountId}
                                       cacheKey={cacheKey}
                                       onOpen={() => actions.openAttachmentModal({ ...att, messageId: email.id, accountId: email.accountId, cacheKey })}
                                     />
                                   );
                                 }
                                 return (
                                   <button
                                     key={cacheKey}
                                     onClick={(e) => { e.stopPropagation(); actions.openAttachmentModal({ ...att, messageId: email.id, accountId: email.accountId, cacheKey }); }}
                                     className="flex items-center gap-2 px-3 py-2 rounded-xl bg-black/20 border border-white/10 hover:bg-black/30 transition text-left max-w-[200px]"
                                   >
                                     <span className="flex-shrink-0">{getFileIcon(att.mimeType, "w-5 h-5")}</span>
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

              {composer}
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
                  <h2 className="font-bold text-base truncate text-white">{state.chatConfigs[state.selectedSender]?.customName || actions.roomLocalKey(state.selectedSender!)}</h2>
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
  );
}
