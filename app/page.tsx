"use client";

import { useRef, useState, useEffect } from "react";
import { signIn } from "next-auth/react";
import { useMailApp } from "./hooks/useMailApp";
import { ChatList } from "./components/ChatList";
import { Composer } from "./components/Composer";
import { TalkView } from "./components/TalkView";
import { Modals, EmailModal, AttachmentModal, SearchModal, FilterToolModal } from "./components/Modals";
import { WarningIcon } from "./components/ui";
import type { Email } from "./types/email";

export default function Home() {
  const app = useMailApp();
  const { auth, state, actions } = app;

  // Shift+クリック範囲選択用の最終クリックインデックス
  const lastChatIdxRef = useRef<number>(-1);
  const lastMsgIdxRef = useRef<number>(-1);
  // 送信スペース。本文が空で、送信スペースを開いていないときは（PC・スマホ共通）送信元・送信先・返信元・件名を隠して、
  // メッセージを読む場所を広くとる。開くのは送信スペースを押したとき・リプライを押したとき（state.composeActive）
  const composeRef = useRef<HTMLDivElement>(null);
  // 送信先の欄を開いているか（たたんでいるときは1行の要約だけ出す）。開いたチャットを持っておき、ほかのチャットに移ったら自動でたたむ
  const selectedRoom = app.state.selectedSender;
  const [recipientsOpenRoom, setRecipientsOpenRoom] = useState<string | null>(null);
  const recipientsOpen = !!selectedRoom && recipientsOpenRoom === selectedRoom;
  // 「Aa」で開く、すべての書式のバー（送信スペースを開いているときだけ出す）
  const [fullBarOpen, setFullBarOpen] = useState(false);
  // 送信スペース以外を押したらたたむ。確認画面・モーダルの中を押したときはたたまない（送信スペースから開いたものを操作している途中のため）
  const setComposeActive = app.actions.setComposeActive;
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!target || composeRef.current?.contains(target)) return;
      if (target.closest?.('[role="dialog"], .fixed.inset-0')) return;
      setComposeActive(false);
      setRecipientsOpenRoom(null);
      setFullBarOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [setComposeActive]);
  // メッセージ一覧のスクロールが始まったらたたむ（指やホイールで動かしたときだけ。読み込みでの自動のスクロールではたたまない）
  const collapseCompose = () => { setComposeActive(false); setRecipientsOpenRoom(null); setFullBarOpen(false); };

  if (auth.status === "loading") return <div className="flex h-screen items-center justify-center bg-[#313338] text-gray-400 font-bold">読み込み中...</div>;
  if (!auth.session || auth.session.error === "RefreshAccessTokenError") return (
    <div className="flex h-screen flex-col items-center justify-center bg-[#313338] text-white">
      <h1 className="mb-8 text-5xl font-extrabold text-[#5865F2]">Re:Mail</h1>
      <button onClick={() => signIn("google", { callbackUrl: "/" })} className="rounded bg-[#5865F2] px-8 py-3 font-bold shadow transition hover:bg-[#4752C4] active:scale-95">Googleでログインして始める</button>
    </div>
  );

  const showChatList = !state.isMobile || !state.selectedSender;
  const showTalk = !state.isMobile || state.selectedSender;

  const selectedGroupConfig = state.selectedSender ? state.chatConfigs[state.selectedSender] : undefined;
  const isFilterGroup = !!(selectedGroupConfig?.isGroup && selectedGroupConfig.filterCriteria);
  // フィルターグループは常に受信専用チャットとして扱う（保存されているgroupModeの値によらない）
  const isInboundOnlyGroup = !!(selectedGroupConfig?.isGroup && (selectedGroupConfig.groupMode === "inbound_only" || isFilterGroup));
  const isOutboundOnlyGroup = !!(selectedGroupConfig?.isGroup && !isFilterGroup && selectedGroupConfig.groupMode === "outbound_only");
  const isSendDisabled = isInboundOnlyGroup || isFilterGroup;
  // 本文に何か書いてあるか、返信欄にキャレットがあるときだけ、送信元・送信先・返信元・件名を出す（PC・スマホ共通）
  // 送信先の欄を開いている間・入力欄から開いた確認画面や選ぶ画面を出している間も、たたまない（選んでいる途中で消えないように）
  const composeModalOpen = !!state.composeDialog || ["select_recipients", "select_reply_target", "select_send_account"].includes(state.modal?.type || "");
  // 本文が空でも、添付・件名・返信元がある下書き（Gmail で作った添付だけの下書きなど）はたたまない（中身があるのに隠れて見えなくなるため）
  const hasDraftExtras = state.replyAttachments.length > 0 || !!state.replySubject.trim() || !!state.replyToMessage;
  const showComposeExtras = !state.composeBodyEmpty || hasDraftExtras || state.composeActive || composeModalOpen;
  const isGroupChat = !!selectedGroupConfig?.isGroup;
  const noRecipients = !isGroupChat && state.recipients.length === 0;
  const subjectFindHighlight = state.findBarOpen && state.findBarSearchSubject ? state.findBarKeyword : "";
  const bodyFindHighlight = state.findBarOpen && state.findBarSearchBody ? state.findBarKeyword : "";

  // メッセージが属する場所（受信箱・送信済み等）に応じた色を返す（返信元チップの色分けにも使う）
  const getMsgColor = (msg: Email) => {
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
<FilterToolModal app={app} />
<EmailModal app={app} />
<AttachmentModal app={app} />
{state.replyNotFoundToast && (
  <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[80] bg-[#2B2D31] text-white text-sm font-bold px-4 py-2 rounded-full shadow-lg border border-[#4752C4] pointer-events-none">
    このメールは存在しません
  </div>
)}
{state.sendConfirm && (
  <div className="fixed inset-0 bg-black/70 z-[90] flex items-center justify-center p-4" onClick={(e) => e.stopPropagation()}>
    <div className="bg-[#313338] rounded-lg shadow-2xl w-full max-w-sm border border-[#1E1F22] p-5">
      <p className="text-sm text-gray-200 mb-5 leading-relaxed flex items-start gap-1.5">
        <WarningIcon className="w-4 h-4 flex-shrink-0 mt-0.5 text-red-400" /> {state.sendConfirm.message}
      </p>
      <div className="flex justify-end gap-3">
        <button onClick={() => actions.setSendConfirm(null)} className="px-4 py-2 hover:underline text-gray-300 text-sm">閉じる</button>
        <button onClick={() => { void state.sendConfirm?.resend(); }} className="px-4 py-2 bg-[#5865F2] text-white rounded text-sm font-bold hover:bg-[#4752C4]">{state.sendConfirm.actionLabel || "再送する"}</button>
      </div>
    </div>
  </div>
)}
{/* 入力欄の確認画面（送信先を外す・チャットを移る・送信先を置き換える・返信／全員に返信・引用の注意） */}
{state.composeDialog && (() => {
  const d = state.composeDialog;
  const close = () => actions.setComposeDialog(null);
  return (
    <div className="fixed inset-0 bg-black/70 z-[90] flex items-center justify-center p-4" onClick={(e) => { e.stopPropagation(); if (d.kind === "confirm") d.onCancel?.(); close(); }}>
      <div role="dialog" aria-modal="true" className="bg-[#313338] rounded-lg shadow-2xl w-full max-w-sm border border-[#1E1F22] p-5 max-h-[85dvh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        {d.kind === "confirm" ? (
          <>
            <p className="text-sm text-gray-200 mb-5 leading-relaxed">{d.message}</p>
            <div className="flex justify-end gap-3">
              <button onClick={() => { close(); d.onCancel?.(); }} className="px-4 py-2 hover:underline text-gray-300 text-sm">{d.cancelLabel || "やめる"}</button>
              <button onClick={() => { close(); d.onConfirm(); }} className="px-4 py-2 bg-[#5865F2] text-white rounded text-sm font-bold hover:bg-[#4752C4]">{d.confirmLabel}</button>
            </div>
          </>
        ) : d.kind === "draftConflict" ? (
          <>
            <h2 className="text-base font-bold text-white mb-2">この下書きは別の場所でも変更されました。どちらを残しますか？</h2>
            {([["Gmail の下書き", d.gmail], ["この画面の入力", d.local]] as const).map(([label, v]) => (
              <div key={label} className="bg-[#2B2D31] rounded p-3 mb-2">
                <div className="text-xs font-bold text-gray-300 mb-1">{label}<span className="ml-2 font-normal text-gray-500">{new Date(v.date).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" })}</span></div>
                <div className="text-xs text-gray-400 break-words">{v.preview || "（本文なし）"}</div>
              </div>
            ))}
            <p className="text-[11px] text-gray-500 mb-3">「Gmail のほうを使う」にしても、今の入力は1度だけ「元に戻す」で戻せます</p>
            <div className="flex flex-wrap justify-end gap-2">
              <button onClick={() => { close(); d.onUseLocal(); }} className="px-3 py-2 bg-[#4E5058] text-white rounded text-sm font-bold hover:bg-[#6D6F78]">この画面のほうを使う</button>
              <button onClick={() => { close(); d.onUseGmail(); }} className="px-3 py-2 bg-[#5865F2] text-white rounded text-sm font-bold hover:bg-[#4752C4]">Gmail のほうを使う</button>
            </div>
          </>
        ) : d.kind === "draftPicker" ? (
          <>
            <h2 className="text-lg font-bold text-white mb-1">下書きを選ぶ</h2>
            <p className="text-xs text-gray-400 mb-3">選んだ下書きを入力欄に出します。今の入力は Gmail の下書きとして残ります</p>
            {d.items.map(it => (
              <button key={it.key} disabled={it.current} onClick={() => { close(); d.onPick(it.key); }} className={`w-full text-left rounded p-3 mb-2 transition ${it.current ? "bg-[#2B2D31] opacity-70 cursor-default" : "bg-[#2B2D31] hover:bg-[#35373C]"}`}>
                <div className="flex justify-between gap-2 text-[11px] text-gray-500 mb-0.5">
                  <span className="truncate">{it.current ? "今の入力" : it.to ? `To ${it.to}` : "宛先なし"}</span>
                  <span className="flex-shrink-0">{new Date(it.date).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                </div>
                <div className="text-sm font-bold text-white truncate">{it.subject || "(件名なし)"}</div>
                <div className="text-xs text-gray-400 truncate">{it.preview}</div>
              </button>
            ))}
            <div className="flex justify-end">
              <button onClick={close} className="px-4 py-2 hover:underline text-gray-300 text-sm">閉じる</button>
            </div>
          </>
        ) : (
          <>
            <h2 className="text-lg font-bold text-white mb-1">返信のしかた</h2>
            <p className="text-xs text-gray-400 mb-3">返信元のメールには、自分と相手のほかにも宛先があります。どちらで送るか選んでください（あとから送信先の欄で変えられます）</p>
            {([["返信", d.reply], ["全員に返信", d.replyAll]] as const).map(([label, list]) => (
              <button key={label} onClick={() => { close(); d.onPick([...list]); }} className="w-full text-left bg-[#2B2D31] hover:bg-[#35373C] rounded p-3 mb-2 transition">
                <div className="text-sm font-bold text-white mb-1">{label}</div>
                {list.map(r => (
                  <div key={r.address} className="text-[11px] text-gray-300 truncate">
                    <span className="text-gray-500">{r.role === "to" ? "To" : r.role === "cc" ? "Cc" : "Bcc"}　</span>{r.name ? `${r.name} <${r.address}>` : r.address}
                  </div>
                ))}
              </button>
            ))}
            <div className="flex justify-end">
              <button onClick={close} className="px-4 py-2 hover:underline text-gray-300 text-sm">送信先はそのまま</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
})()}
{state.infoToast && !state.errorToast && (
  <div role="status" className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[80] bg-[#2B2D31] text-white text-sm font-bold px-4 py-2.5 rounded-lg shadow-lg border border-[#5865F2] max-w-[90vw] text-center pointer-events-none">
    {state.infoToast}
  </div>
)}
{state.errorToast && (
  <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[80] bg-[#2B2D31] text-white text-sm font-bold px-4 py-2.5 rounded-lg shadow-lg border border-red-500/60 max-w-[90vw] text-center flex items-center justify-center gap-1.5">
    <WarningIcon className="w-4 h-4 flex-shrink-0" /> {state.errorToast}
  </div>
)}

      {showChatList && (
        <ChatList app={app} lastChatIdxRef={lastChatIdxRef} />
      )}

      {showTalk && (
        <TalkView
          app={app}
          lastMsgIdxRef={lastMsgIdxRef}
          collapseCompose={collapseCompose}
          selectedGroupConfig={selectedGroupConfig}
          isFilterGroup={isFilterGroup}
          isInboundOnlyGroup={isInboundOnlyGroup}
          isOutboundOnlyGroup={isOutboundOnlyGroup}
          subjectFindHighlight={subjectFindHighlight}
          bodyFindHighlight={bodyFindHighlight}
          getMsgColor={getMsgColor}
          composer={
            <Composer
              app={app}
              composeRef={composeRef}
              selectedRoom={selectedRoom}
              recipientsOpen={recipientsOpen}
              setRecipientsOpenRoom={setRecipientsOpenRoom}
              fullBarOpen={fullBarOpen}
              setFullBarOpen={setFullBarOpen}
              isFilterGroup={isFilterGroup}
              isSendDisabled={isSendDisabled}
              showComposeExtras={showComposeExtras}
              isGroupChat={isGroupChat}
              noRecipients={noRecipients}
              />
          }
        />
      )}
    </div>
  );
}