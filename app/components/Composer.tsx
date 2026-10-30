"use client";

import type { Dispatch, RefObject, SetStateAction } from "react";
import dynamic from "next/dynamic";
import type { MailAppHook } from "../hooks/useMailApp";
import { getFileIcon, formatFileSize, PaperclipIcon, SendIcon } from "./ui";
import { summarizeRecipients, ROLE_LABELS, ROLE_HINTS } from "../lib/composeRecipients";
// 書式付きの入力欄は、チャットを開いたときに読み込む（最初の表示を遅くしない）
const ComposeEditor = dynamic(() => import("./ComposeEditor").then(m => m.ComposeEditor), { ssr: false, loading: () => <div className="flex-1 h-8" /> });

// 入力欄（送信スペース：送信元・送信先・返信元・件名・添付・書式・本文・送信ボタン）。page.tsx から分けたもの（動きは同じ）。
// 送信スペースの開閉の状態（送信先の欄・書式のバー）と、外を押したらたたむ処理は、チャットを移っても続くよう page.tsx に置いたまま
export function Composer({ app, composeRef, selectedRoom, recipientsOpen, setRecipientsOpenRoom, fullBarOpen, setFullBarOpen, isFilterGroup, isSendDisabled, showComposeExtras, isGroupChat, noRecipients }: {
  app: MailAppHook;
  composeRef: RefObject<HTMLDivElement | null>;
  selectedRoom: MailAppHook["state"]["selectedSender"];
  recipientsOpen: boolean;
  setRecipientsOpenRoom: Dispatch<SetStateAction<string | null>>;
  fullBarOpen: boolean;
  setFullBarOpen: Dispatch<SetStateAction<boolean>>;
  isFilterGroup: boolean;
  isSendDisabled: boolean;
  showComposeExtras: boolean;
  isGroupChat: boolean;
  noRecipients: boolean;
}) {
  const { auth, state, actions, computed, refs } = app;
  return (
              <div
                ref={composeRef}
                className="p-4 bg-[#313338] cursor-default"
                onClick={(e) => e.stopPropagation()}
                onPointerDown={() => actions.setComposeActive(true)}
                onFocus={() => actions.setComposeActive(true)}
              >
                <div
                  className={`bg-[#383A40] rounded-lg p-3 border border-[#1E1F22] ${isSendDisabled ? "opacity-40 pointer-events-none grayscale" : ""}`}
                >
                  {isSendDisabled && (
                    <div className="text-[11px] text-gray-400 mb-2">{isFilterGroup ? "フィルターグループのため、送信・返信はできません" : "受信専用のグループチャットのため、送信・返信はできません"}</div>
                  )}
                  {/* 送信元：実際に使う From（元のメールが自分のエイリアス宛てなら、そのエイリアス）を、アカウントのアイコン・名前と一緒に出す（送り間違えを防ぐ）。
                      押すと送信元のアカウントを選ぶ画面を開く。ログインしているアカウントが1つでエイリアスも無ければ押せない */}
                  {showComposeExtras && computed.sendFrom && (() => {
                    const from = computed.sendFrom!;
                    const me = auth.session?.user?.email || "";
                    const profile = from.account === me ? { name: auth.session?.user?.name || undefined, picture: auth.session?.user?.image || undefined } : state.linkedAccountProfiles[from.account];
                    const canSwitch = ((state.linkedAccounts as string[]) || []).length > 0 || (state.sendAsByAccount[from.account] || []).length > 1;
                    return (
                      <button
                        type="button"
                        disabled={isSendDisabled || !canSwitch}
                        title={canSwitch ? "押すと送信元を変更します" : undefined}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!canSwitch) return;
                          actions.setModal({ type: "select_send_account", targetMode: "current_chat", targets: [] });
                          window.history.pushState({ action: "modal" }, "", window.location.href);
                        }}
                        className={`w-full flex items-center gap-2 bg-[#2B2D31] text-gray-300 p-2 rounded text-xs mb-2 border-l-4 border-[#5865F2] text-left transition ${canSwitch ? "hover:bg-[#35373C]" : "cursor-default"}`}
                      >
                        <span className="text-gray-400 flex-shrink-0">送信元:</span>
                        {/* eslint-disable-next-line @next/next/no-img-element -- アカウントの小さなプロフィール画像。next/image の最適化は Worker の中継が増えるので使わない（ほかのアカウント画像と同じ） */}
                        <img src={profile?.picture || `/api/avatar?name=${encodeURIComponent(profile?.name || from.account)}`} alt="" referrerPolicy="no-referrer" className="w-5 h-5 rounded-full flex-shrink-0" />
                        <span className="truncate flex-1" title={from.address}>
                          {profile?.name && <span className="font-bold text-gray-200 mr-1">{profile.name}</span>}
                          {from.displayName ? `${from.displayName} <${from.address}>` : from.address}
                          {from.isAlias && <span className="text-gray-500">（{from.account} のエイリアス）</span>}
                        </span>
                      </button>
                    );
                  })()}
                  {/* 受信専用アドレス（や確認待ちのアドレス）のチャットでは、そのアドレスからは送れないので主アドレスから送ることを伝える（絶対ルール2） */}
                  {showComposeExtras && computed.sendFrom?.cannotSendFrom && (
                    <div className="text-[11px] text-gray-400 mb-2 px-1">
                      このアドレス（{computed.sendFrom.cannotSendFrom}）からは送信できないため、{computed.sendFrom.address} から送信されます
                    </div>
                  )}
                  {/* 送信先：たたんでいるときは1行の要約。開くと1人ずつのチップ（押すと確認を挟んで外す）と「＋ 送信先を追加」 */}
                  {showComposeExtras && (isGroupChat ? (
                    <div className="flex items-center gap-2 bg-[#2B2D31] text-gray-300 p-2 rounded text-xs mb-2 border-l-4 border-[#5865F2]">
                      <span className="text-gray-400 flex-shrink-0">送信先:</span>
                      <span className="truncate flex-1">グループのメンバー全員に送ります</span>
                    </div>
                  ) : (
                    <div className="bg-[#2B2D31] text-gray-300 rounded text-xs mb-2 border-l-4 border-[#5865F2]">
                      <button
                        type="button"
                        disabled={isSendDisabled}
                        onClick={(e) => { e.stopPropagation(); setRecipientsOpenRoom(recipientsOpen ? null : selectedRoom); }}
                        className="w-full flex items-center gap-2 p-2 text-left hover:bg-[#35373C] rounded transition"
                        aria-expanded={recipientsOpen}
                        title={recipientsOpen ? "押すと送信先をたたみます" : "押すと送信先を1人ずつ表示します"}
                      >
                        <span className="text-gray-400 flex-shrink-0">送信先:</span>
                        <span className={`truncate flex-1 ${noRecipients ? "text-red-400 font-bold" : ""}`}>
                          {noRecipients ? "送信先がありません" : summarizeRecipients(state.recipients)}
                        </span>
                      </button>
                      {recipientsOpen && (
                        <div className="px-2 pb-2 flex flex-col gap-1 max-h-[30dvh] overflow-y-auto">
                          {state.recipients.map(r => (
                            <button
                              key={r.address}
                              type="button"
                              title={`${r.address}（押すと送信先から外します）`}
                              onClick={(e) => { e.stopPropagation(); actions.removeComposeRecipient(r.address); }}
                              className="flex items-center gap-2 px-2 py-1.5 rounded bg-black/20 hover:bg-black/30 border border-white/10 text-left transition"
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element -- 名前から作る小さなアイコン（Re:Mail 自身の /api/avatar。外部には通信しない） */}
                              <img src={`/api/avatar?name=${encodeURIComponent(r.name || r.address)}`} alt="" className="w-5 h-5 rounded-full flex-shrink-0" />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-gray-200 font-bold">{r.name || r.address}</span>
                                <span className="block truncate text-[11px] text-gray-400">
                                  {ROLE_LABELS[r.role]}{ROLE_HINTS[r.role] && <span className="text-gray-500">：{ROLE_HINTS[r.role]}</span>}
                                </span>
                              </span>
                              <span className="text-gray-400 font-bold px-1 flex-shrink-0">×</span>
                            </button>
                          ))}
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              actions.setModal({ type: "select_recipients", targetMode: "current_chat", targets: [] });
                              window.history.pushState({ action: "modal" }, "", window.location.href);
                            }}
                            className="font-bold px-2 py-1.5 text-left text-[#5865F2] hover:text-white"
                          >
                            ＋ 送信先を追加
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                  {showComposeExtras && (
                  <div className="flex items-center bg-[#2B2D31] text-gray-300 rounded text-xs mb-2 border-l-4 border-[#5865F2]">
                    {/* 欄を押すと返信元を選ぶ画面を開く */}
                    <button
                      type="button"
                      disabled={isSendDisabled}
                      title={state.replyToMessage ? "押すと返信元を変更します" : "押すと返信元を選びます"}
                      onClick={(e) => {
                        e.stopPropagation();
                        actions.setModal({ type: "select_reply_target", targetMode: "current_chat", targets: [] });
                        window.history.pushState({ action: "modal" }, "", window.location.href);
                      }}
                      className="flex-1 min-w-0 flex items-center gap-2 p-2 text-left hover:bg-[#35373C] rounded transition"
                    >
                      <span className="text-gray-400 flex-shrink-0">返信元:</span>
                      <span className={`truncate flex-1 ${state.replyToMessage ? "" : "text-gray-500"}`}>
                        {state.replyToMessage ? (state.replyToMessage.subject || state.replyToMessage.snippet || "(件名なし)") : "なし（新しいメール）"}
                      </span>
                    </button>
                    {state.replyToMessage && (
                      <button title="返信元を外す" onClick={(e) => {
                        e.stopPropagation();
                        // 引用と、返信元を選んだときに自動で入れた件名（Re: 元の件名）も一緒に消す。自分で書き換えた件名は残す
                        actions.clearReplyTarget();
                      }} className="font-bold px-2 py-2 hover:text-white flex-shrink-0">×</button>
                    )}
                  </div>
                  )}
                  {/* 件名は返信元が無いとき（新しいメール）だけ。返信の件名はスレッドが分かれないよう元の件名に揃える */}
                  {showComposeExtras && !state.replyToMessage && <input disabled={isSendDisabled} type="text" placeholder="件名 (省略可)" value={state.replySubject} onChange={(e) => actions.setReplySubject(e.target.value)} onClick={(e) => e.stopPropagation()} className="w-full text-sm px-2 py-1 mb-2 bg-transparent text-white focus:outline-none placeholder-gray-500 font-medium border-b border-[#2B2D31]" />}
                  {state.replyAttachments.length > 0 && (
                    <div className="flex flex-wrap gap-2 mb-2">
                      {state.replyAttachments.map((att, idx) => (
                        <div key={`${att.filename}-${idx}`} className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-black/20 border border-white/10 max-w-[220px]">
                          <span className="flex-shrink-0">{getFileIcon(att.mimeType, "w-4 h-4")}</span>
                          <div className="min-w-0">
                            <div className="text-xs font-bold truncate text-gray-200">{att.filename}</div>
                            <div className="text-[10px] text-gray-400">{formatFileSize(att.size)}</div>
                          </div>
                          <button onClick={(e) => { e.stopPropagation(); actions.removeReplyAttachment(idx); }} className="text-gray-400 hover:text-white font-bold px-1 flex-shrink-0">×</button>
                        </div>
                      ))}
                    </div>
                  )}
                  {state.attachError && (
                    <div className="text-xs text-red-400 mb-2">{state.attachError}</div>
                  )}
                  {/* Gmail の下書きとの同期の知らせ（保存できていない・ほかで変更された など）。トーストは出さない。入力は端末に残っている */}
                  {state.gmailDraftNotice && (
                    <div className="text-[11px] text-gray-400 mb-1">
                      {state.gmailDraftNotice.text}
                      {state.gmailDraftNotice.actionLabel && state.gmailDraftNotice.onAction && (
                        <button onClick={(e) => { e.stopPropagation(); state.gmailDraftNotice?.onAction?.(); }} className="ml-2 text-[#5865F2] hover:underline font-bold">{state.gmailDraftNotice.actionLabel}</button>
                      )}
                    </div>
                  )}
                  {/* 同じ相手への Gmail の下書きがほかにもあるとき（押すと一覧から選べる） */}
                  {state.gmailDraftOthers > 0 && (
                    <button onClick={(e) => { e.stopPropagation(); actions.openGmailDraftOthers(); }} className="text-[11px] text-gray-400 hover:text-gray-200 hover:underline mb-1 block">ほかに下書きが{state.gmailDraftOthers}件</button>
                  )}
                  <div className="flex items-end gap-2">
                    <label
                      title="ファイルを添付"
                      className={`flex-shrink-0 text-gray-400 hover:text-white transition p-2 rounded cursor-pointer ${isSendDisabled ? "pointer-events-none opacity-40" : ""}`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        type="file"
                        multiple
                        disabled={isSendDisabled}
                        className="hidden"
                        onChange={(e) => { if (e.target.files && e.target.files.length > 0) actions.addReplyAttachments(e.target.files); e.target.value = ""; }}
                      />
                      {state.useIconLabels ? <PaperclipIcon className="w-5 h-5" /> : <span className="text-xs font-bold">添付</span>}
                    </label>
                    {/* 書式（送信スペースを開いているときだけ出す） */}
                    {showComposeExtras && !isSendDisabled && (
                      <button type="button" title="書式" aria-label="書式" aria-pressed={fullBarOpen} onPointerDown={(e) => e.preventDefault()} onClick={(e) => { e.stopPropagation(); setFullBarOpen(!fullBarOpen); }} className={`flex-shrink-0 px-1.5 py-2 rounded text-sm font-bold transition ${fullBarOpen ? "text-white bg-[#5865F2]" : "text-gray-400 hover:text-white"}`}>
                        Aa
                      </button>
                    )}
                    <ComposeEditor
                      loadSeq={state.editorLoad.seq}
                      loadHtml={state.editorLoad.html}
                      loadImages={state.editorLoad.images}
                      allowRemoteImages={actions.alwaysLoadImagesFor(actions.roomAccountEmail(state.selectedSender!))}
                      disabled={isSendDisabled || !state.isDraftReady}
                      placeholder={`Message to ${state.chatConfigs[state.selectedSender!]?.customName || actions.roomLocalKey(state.selectedSender!)}`}
                      bodyEmpty={state.composeBodyEmpty}
                      fullBarOpen={fullBarOpen && showComposeExtras}
                      apiRef={refs.editorApiRef}
                      onChange={actions.onEditorChange}
                      onFocus={() => actions.setComposeActive(true)}
                      onError={(m) => actions.showErrorToast(m)}
                      onDropFiles={(files) => actions.addReplyAttachments(files)}
                      onOpenFullBar={() => { actions.setComposeActive(true); setFullBarOpen(true); }}
                    />
                    <button title={noRecipients ? "送信先がありません" : "送信"} onClick={(e) => { e.stopPropagation(); actions.handleSend(); }} disabled={isSendDisabled || state.isSending || !state.isDraftReady || state.composeBodyEmpty || noRecipients} className="text-white px-4 py-2 rounded font-bold text-sm bg-[#5865F2] hover:bg-[#4752C4] transition disabled:bg-[#3f4147] disabled:text-gray-500 active:scale-95">
                      {state.isSending ? "..." : (state.useIconLabels ? <SendIcon className="w-4 h-4" /> : "送信")}
                    </button>
                  </div>
                </div>
              </div>
  );
}
