"use client";

import { useRef, useState, useEffect } from "react";
import { getCachedAttachment, setCachedAttachment, memCache, getCachedVideoThumb, setCachedVideoThumb, videoThumbMemCache, attachmentCacheKey } from "./lib/attachmentCache";
import { generateVideoThumbnail } from "./lib/videoThumbnail";
import { signIn } from "next-auth/react";
import { useMailApp } from "./hooks/useMailApp";
import { ChatList } from "./components/ChatList";
import { Composer } from "./components/Composer";
import { HighlightText, ActionBar, BodyWithLinks } from "./components/ui";
import { Modals, EmailModal, AttachmentModal, SearchModal, FilterToolModal } from "./components/Modals";
import { getFileIcon, formatFileSize, PinIcon, WarningIcon } from "./components/ui";
import { isMineEmail } from "./lib/filterMatch";
import type { Email } from "./types/email";
import { sentRecipientCounts, receivedRole } from "./lib/composeRecipients";

function InlineAttachmentImage({ attachment, messageId, accountId, cacheKey, onOpen }: {
  attachment: { filename: string; mimeType: string; size: number; attachmentId?: string };
  messageId: string;
  accountId?: string;
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
      // 送信直後のローカルのメールは attachmentId を持たない（中身は送信時にキャッシュへ書き込み済み）。
      // 問い合わせても取得できないので、取得失敗と同じ扱いにする
      if (!attachment.attachmentId) { if (!cancelled) setLoading(false); return; }
      try {
        const attParams = new URLSearchParams({ messageId, attachmentId: attachment.attachmentId });
        if (accountId) attParams.append("accountEmail", accountId);
        const res = await fetch(`/api/emails?${attParams.toString()}`);
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

function VideoAttachmentChip({ attachment, messageId, accountId, cacheKey, onOpen }: {
  attachment: { filename: string; mimeType: string; size: number; attachmentId?: string };
  messageId: string;
  accountId?: string;
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
      if (!base64 && attachment.attachmentId) {
        try {
          const attParams = new URLSearchParams({ messageId, attachmentId: attachment.attachmentId });
          if (accountId) attParams.append("accountEmail", accountId);
          const res = await fetch(`/api/emails?${attParams.toString()}`);
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
  const showComposeExtras = !state.composeBodyEmpty || state.composeActive || composeModalOpen;
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
      )}
    </div>
  );
}