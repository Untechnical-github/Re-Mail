"use client";

import type { MutableRefObject } from "react";
import type { MailAppHook } from "../hooks/useMailApp";
import { ActionBar, PinIcon, WarningIcon, InboxIcon, ArchiveIcon, SendIcon, SpamIcon, TrashIcon } from "./ui";
import { chatConfigTab } from "../lib/filterMatch";
import { gmailOpenUrl, gmailDraftsUrl } from "../lib/gmailLink";

// チャット一覧（左の列。スマホではチャットを開いていないときの全画面）。page.tsx から分けたもの（動きは同じ）
export function ChatList({ app, lastChatIdxRef }: { app: MailAppHook; lastChatIdxRef: MutableRefObject<number> }) {
  const { auth, state, actions, computed, refs } = app;
  return (
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
              <button onClick={(e) => { e.stopPropagation(); actions.setModal({ type: "filter_tool", targetMode: "all_chats", targets: [] }); window.history.pushState({ action: "modal" }, "", window.location.href); }} className="text-gray-400 hover:text-white transition" title="フィルター">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M2.628 1.601C5.028 1.206 7.49 1 10 1s4.973.206 7.372.601a.75.75 0 01.628.74v2.288a2.25 2.25 0 01-.659 1.59l-4.682 4.683a2.25 2.25 0 00-.659 1.59v3.037c0 .684-.31 1.33-.844 1.757l-1.937 1.55A.75.75 0 018 18.25v-5.757a2.25 2.25 0 00-.659-1.591L2.659 6.22A2.25 2.25 0 012 4.629V2.34a.75.75 0 01.628-.74z" clipRule="evenodd" /></svg>
              </button>
              <button onClick={(e) => { e.stopPropagation(); actions.setModal({ type: "search", targetMode: "all_chats", targets: [] }); window.history.pushState({ action: "modal" }, "", window.location.href); }} className="text-gray-400 hover:text-white transition" title="検索">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z" clipRule="evenodd" /></svg>
              </button>
              <button onClick={(e) => { e.stopPropagation(); actions.setModal({ type: "settings", targetMode: "all_chats", targets: [] }); window.history.pushState({ action: "modal" }, "", window.location.href); }} className="text-gray-400 hover:text-white transition" title="設定">
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
            </div>
          </div>

          <div className="p-3 border-b border-[#1E1F22] bg-[#232428] cursor-default">
             <div className="flex flex-wrap gap-1 text-[11px] font-bold">
                <label title="受信箱" onClick={(e) => e.stopPropagation()} className="flex items-center gap-1 cursor-pointer bg-[#313338] px-2 py-1.5 rounded flex-1 justify-center hover:bg-[#3f4147]"><input type="checkbox" checked={state.checkInbox} onChange={(e) => actions.setCheckInbox(e.target.checked)} className="accent-[#5865F2]" /> {state.useIconLabels ? <InboxIcon className="w-4 h-4" /> : "受信箱"}</label>
                <label title="アーカイブ" onClick={(e) => e.stopPropagation()} className="flex items-center gap-1 cursor-pointer bg-[#313338] px-2 py-1.5 rounded flex-1 justify-center hover:bg-[#3f4147]"><input type="checkbox" checked={state.checkArchive} onChange={(e) => actions.setCheckArchive(e.target.checked)} className="accent-[#95A5A6]" /> {state.useIconLabels ? <ArchiveIcon className="w-4 h-4" /> : "アーカイブ"}</label>
                {/* ★修正: 送信済みチェックボックスを並列で追加 */}
                <label title="送信済" onClick={(e) => e.stopPropagation()} className="flex items-center gap-1 cursor-pointer bg-[#313338] px-2 py-1.5 rounded flex-1 justify-center hover:bg-[#3f4147]"><input type="checkbox" checked={state.checkSent} onChange={(e) => actions.setCheckSent(e.target.checked)} className="accent-[#1ABC9C]" /> {state.useIconLabels ? <SendIcon className="w-4 h-4" /> : "送信済"}</label>
                <label title="迷惑" onClick={(e) => e.stopPropagation()} className="flex items-center gap-1 cursor-pointer bg-[#313338] px-2 py-1.5 rounded flex-1 justify-center hover:bg-[#3f4147]"><input type="checkbox" checked={state.checkSpam} onChange={(e) => actions.setCheckSpam(e.target.checked)} className="accent-[#FEE75C]" /> {state.useIconLabels ? <SpamIcon className="w-4 h-4" /> : "迷惑"}</label>
                <label title="ゴミ箱" onClick={(e) => e.stopPropagation()} className="flex items-center gap-1 cursor-pointer bg-[#313338] px-2 py-1.5 rounded flex-1 justify-center hover:bg-[#3f4147]"><input type="checkbox" checked={state.checkTrash} onChange={(e) => actions.setCheckTrash(e.target.checked)} className="accent-[#DA373C]" /> {state.useIconLabels ? <TrashIcon className="w-4 h-4" /> : "ゴミ箱"}</label>
             </div>
          </div>

          {state.linkedAccounts.length > 0 && (
            <div className="p-3 border-b border-[#1E1F22] bg-[#232428] cursor-default">
               <div className="flex flex-wrap gap-1 text-[11px] font-bold">
                  {[auth.session?.user?.email || "", ...state.linkedAccounts].map((acct) => {
                    const isMain = acct === (auth.session?.user?.email || "");
                    const profile = isMain ? undefined : state.linkedAccountProfiles[acct];
                    const pictureSrc = isMain ? auth.session?.user?.image : profile?.picture;
                    const displayName = isMain ? (auth.session?.user?.name || acct) : (profile?.name || acct);
                    return (
                      <label key={acct} onClick={(e) => e.stopPropagation()} title={acct} className="flex items-center gap-1 cursor-pointer bg-[#313338] px-2 py-1.5 rounded flex-1 justify-center hover:bg-[#3f4147]">
                        <input type="checkbox" checked={state.checkAccounts[acct] !== false} onChange={(e) => actions.setCheckAccounts((prev) => ({ ...prev, [acct]: e.target.checked }))} className="accent-[#5865F2]" />
                        {state.useIconLabels ? (
                          <img src={pictureSrc || `/api/avatar?name=${encodeURIComponent(displayName)}`} alt="" referrerPolicy="no-referrer" className="w-4 h-4 rounded-full flex-shrink-0" />
                        ) : acct.split("@")[0]}
                      </label>
                    );
                  })}
               </div>
            </div>
          )}

          <div className="flex gap-1 px-3 pt-2 bg-[#232428] border-b border-[#1E1F22] cursor-default" onClick={(e) => e.stopPropagation()}>
            {([["individual", "個人チャット"], ["group", "グループチャット"], ["filter", "フィルター"]] as const).map(([tab, label]) => (
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

          {/* 一覧の取得で詳細を読み込めなかったメールがあるとき（レート制限など）。黙って欠けさせずに知らせる */}
          {state.unloadedCount > 0 && (
            <div role="status" className="flex items-center gap-2 px-3 py-2 text-xs text-gray-300 bg-[#232428] border-b border-[#1E1F22] cursor-default" onClick={(e) => e.stopPropagation()}>
              <WarningIcon className="w-3.5 h-3.5 flex-shrink-0 text-[#FEE75C]" />
              <span className="flex-1 min-w-0">{state.unloadedCount} 件のメールを読み込めませんでした</span>
              <button onClick={() => { void actions.retryUnloaded(); }} disabled={state.isRetryingUnloaded} className="flex-shrink-0 font-bold text-[#5865F2] hover:text-white disabled:text-gray-500">{state.isRetryingUnloaded ? "取り直し中…" : "再試行"}</button>
              <a href={gmailOpenUrl(auth.session?.user?.email)} target="_blank" rel="noopener noreferrer" className="flex-shrink-0 font-bold text-[#5865F2] hover:text-white">Gmail で開く</a>
            </div>
          )}

          {/* Gmail の下書きのうち、チャットに出せないもの（宛先がない・100件を超えた分）。押すと Gmail の下書きを開く */}
          {Object.entries(state.gmailDraftOrphans).filter(([account]) => actions.isAccountVisible(account)).flatMap(([account, o]) => [
            o.noRecipient > 0 ? { key: `${account}-none`, account, text: `宛先のない下書きが${o.noRecipient}件あります` } : null,
            o.more > 0 ? { key: `${account}-more`, account, text: `Re:Mail で扱えない下書きが${o.more}件あります` } : null,
          ]).filter((x): x is { key: string; account: string; text: string } => !!x).map(x => (
            <a key={x.key} href={gmailDraftsUrl(x.account)} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-gray-400 hover:text-gray-200 bg-[#232428] border-b border-[#1E1F22]">
              <span className="flex-1 min-w-0 truncate">{x.text}{Object.keys(state.gmailDraftOrphans).length > 1 ? `（${x.account}）` : ""}</span>
              <span className="flex-shrink-0 font-bold text-[#5865F2]">Gmail で開く</span>
            </a>
          ))}

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
             {computed.senderList.filter((sender) => chatConfigTab(state.chatConfigs[sender]) === state.activeChatTab).map((sender) => {
              const allEmails = computed.groupedEmails[sender] || [];
              const config = state.chatConfigs[sender];

              const visibleEmails = allEmails.filter((e) => {
                 const isTrash = e.labelIds?.includes("TRASH");
                 const isSpam = e.labelIds?.includes("SPAM");
                 const isInbox = e.labelIds?.includes("INBOX");
                 const isSent = e.labelIds?.includes("SENT") || e.isMe; 
                 const isArchive = !isTrash && !isSpam && !isInbox && !isSent; 
                 
                 if ((isInbox || isArchive || isSent) && (config?.isHidden || state.messageConfigs[actions.messageConfigKey(e.id, e.accountId)]?.isHidden)) return false;
                 if (!actions.isAccountVisible(e.accountId)) return false;

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
              // 表示されているメールに未読があるチャットは、少し太く・明るく出す（Gmail の未読と同じ）
              const hasUnread = visibleEmails.some((e) => e.labelIds?.includes("UNREAD"));
              const isOpened = state.selectedSender === sender && !state.isMobile;
              const count = visibleEmails.length;
              const latestDate = latestEmail ? new Date(latestEmail.date).toLocaleString("ja-JP", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";

              const previewSubject = latestEmail ? (latestEmail.subject || "No Subject") : "";

              const isChatOnlySent = allEmails.every((e) => (e.labelIds?.includes("SENT") || e.isMe) && !e.labelIds?.includes("TRASH"));

              // 送信済みだけのチャットは移動できない（移動先は場所ごとの確認画面で選ぶ）
              const isMoveGrayedOut = state.selectionMode === "chat_move" && isChatOnlySent;

              // ★修正: ピン留め/非表示の対象(INBOXかARCHIVE)がいるか判定
              const hasValidFetchedMail = visibleEmails.some((e) => !e.labelIds?.includes("TRASH") && !e.labelIds?.includes("SPAM"));
              
              const hasLiveTarget = hasValidFetchedMail;
              
              const isPinGrayedOut = state.selectionMode === "chat_pin" && !hasLiveTarget;
              const isHideGrayedOut = state.selectionMode === "chat_hide" && !hasLiveTarget;

              const isDeleteGrayedOut = state.selectionMode === "chat_delete" &&
                visibleEmails.length > 0 && visibleEmails.every((e) => e.labelIds?.includes("TRASH") || e.labelIds?.includes("SENT") || e.isMe);

              const isActionGrayedOut = isMoveGrayedOut || isPinGrayedOut || isHideGrayedOut || isDeleteGrayedOut;

              // グラデーション色を計算（SENTを最優先：ゴミ箱内の送信済みも緑扱い）
              const colorsSet = new Set<string>();
              allEmails.forEach((e) => {
                if (!actions.isAccountVisible(e.accountId)) return;
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
                          {config?.isPinned && <PinIcon className="w-3 h-3 text-[#FEE75C] flex-shrink-0" />}
                          <span className={`text-sm truncate ${hasUnread ? "font-bold text-white" : "font-semibold"}`}>{config?.customName || actions.roomLocalKey(sender)}</span>
                          {/* ログインしているアカウントが2つ以上なら、どのアカウントのチャットかを全アカウント同じ形で出す */}
                          {state.linkedAccounts.length > 0 && (() => {
                            const acct = actions.roomAccountEmail(sender);
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
                        </div>
                        <span className="text-[10px] text-gray-500 flex-shrink-0">{latestDate}</span>
                      </div>
                      <div className="text-[10px] text-[#5865F2] font-bold mt-0.5">{isDraft ? "新規作成中" : `${count}件のメッセージ`}</div>
                      <div className={`text-xs truncate mt-0.5 ${hasUnread ? "font-semibold text-gray-300" : "text-gray-500"}`}>
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
  );
}
