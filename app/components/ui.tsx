"use client";

import React, { useState } from "react";
import { chatConfigTab } from "../lib/filterMatch";

// field/matchCountBefore/activeField/activeIndex は、メッセージ画面の検索バーで
// 「今対象として表示されている一致箇所」だけをオレンジにするための仕組み。
// matchCountBefore はこの text より前（同じfield内の前のセグメント）に何件既に一致があったかを表し、
// 各 <mark> のグローバルな出現番号 = matchCountBefore + このtext内でのローカルな出現番号 で判定する
export const HighlightText = ({ text, highlight, field, matchCountBefore = 0, activeField, activeIndex }: {
  text: string;
  highlight: string;
  field?: "subject" | "body";
  matchCountBefore?: number;
  activeField?: "subject" | "body";
  activeIndex?: number;
}) => {
  if (!highlight) return <>{text}</>;
  const parts = text.split(new RegExp(`(${highlight})`, 'gi'));
  let localMatchIdx = 0;
  return (
    <>
      {parts.map((part, i) => {
        if (part.toLowerCase() !== highlight.toLowerCase()) return part;
        const globalIdx = matchCountBefore + localMatchIdx;
        localMatchIdx++;
        const isActive = field !== undefined && activeField === field && activeIndex === globalIdx;
        return (
          <mark
            key={i}
            data-field={field}
            data-match-index={globalIdx}
            className={isActive ? "bg-[#FFA500] text-black font-bold px-0.5 rounded-sm" : "bg-[#FEE75C] text-black font-bold px-0.5 rounded-sm"}
          >
            {part}
          </mark>
        );
      })}
    </>
  );
};

// text内でhighlightが大文字小文字区別なく出現する回数を数える（BodyWithLinksでのセグメントごとの件数集計用）
function countHighlightOccurrences(text: string, highlight: string): number {
  if (!highlight) return 0;
  const lower = text.toLowerCase();
  const kw = highlight.toLowerCase();
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = lower.indexOf(kw, pos);
    if (idx === -1) break;
    count++;
    pos = idx + kw.length;
  }
  return count;
}

export function BodyWithLinks({ text, highlight, htmlLinks, field, activeField, activeIndex }: {
  text: string;
  highlight?: string;
  htmlLinks?: Array<{ text: string; href: string }>;
  field?: "subject" | "body";
  activeField?: "subject" | "body";
  activeIndex?: number;
}) {
  const [preview, setPreview] = useState<{ url: string; x: number; y: number } | null>(null);

  const src = text || "";

  // クリック可能な範囲を収集
  type Range =
    | { kind: "url"; start: number; end: number; rawEnd: number; url: string; trailing: string }
    | { kind: "html"; start: number; end: number; href: string; linkText: string };

  const ranges: Range[] = [];

  // 生URLの範囲を収集
  const urlRe = /https?:\/\/[^\s<>"]+/g;
  let um: RegExpExecArray | null;
  while ((um = urlRe.exec(src)) !== null) {
    const url = um[0].replace(/[.,;:!?)\]>'"。、，；：！？）]+$/, "");
    if (url) {
      ranges.push({ kind: "url", start: um.index, end: um.index + url.length, rawEnd: um.index + um[0].length, url, trailing: um[0].slice(url.length) });
    }
  }

  // HTML リンクの範囲を収集（既存範囲と重複しない最初の出現箇所）
  if (htmlLinks?.length) {
    const isUsed = (s: number, e: number) =>
      ranges.some(r => r.start < e && (r.kind === "url" ? r.rawEnd : r.end) > s);
    for (const { text: lt, href } of htmlLinks) {
      if (!lt) continue;
      let from = 0;
      while (from < src.length) {
        const idx = src.indexOf(lt, from);
        if (idx === -1) break;
        const end = idx + lt.length;
        if (!isUsed(idx, end)) {
          ranges.push({ kind: "html", start: idx, end, href, linkText: lt });
          break;
        }
        from = idx + 1;
      }
    }
  }

  ranges.sort((a, b) => a.start - b.start);

  const parts: React.ReactNode[] = [];
  let lastIdx = 0;
  // 分割された各セグメントより前に既に何件一致したかを追跡する（オレンジ表示位置の判定用）
  let matchesSoFar = 0;

  for (const r of ranges) {
    if (r.start < lastIdx) continue;
    if (r.start > lastIdx) {
      const seg = src.slice(lastIdx, r.start);
      parts.push(highlight ? <HighlightText key={`t-${lastIdx}`} text={seg} highlight={highlight} field={field} matchCountBefore={matchesSoFar} activeField={activeField} activeIndex={activeIndex} /> : seg);
      if (highlight) matchesSoFar += countHighlightOccurrences(seg, highlight);
    }
    if (r.kind === "url") {
      const url = r.url;
      parts.push(
        <a key={`u-${r.start}`} href={url} target="_blank" rel="noopener noreferrer"
          className="text-[#5865F2] underline underline-offset-2 hover:text-[#7289DA] break-all"
          onClick={(e) => e.stopPropagation()}
          onMouseEnter={(e) => {
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const y = (window.innerHeight - rect.bottom) > 130 ? rect.bottom + 8 : rect.top - 128;
            setPreview({ url, x: Math.max(8, Math.min(rect.left, window.innerWidth - 296)), y });
          }}
          onMouseLeave={() => setPreview(null)}
        >
          {highlight ? <HighlightText text={url} highlight={highlight} field={field} matchCountBefore={matchesSoFar} activeField={activeField} activeIndex={activeIndex} /> : url}
        </a>
      );
      if (highlight) matchesSoFar += countHighlightOccurrences(url, highlight);
      if (r.trailing) parts.push(r.trailing);
      lastIdx = r.rawEnd;
    } else {
      // HTMLリンク: 下線+クリック+プレビュー
      const hrefForPreview = r.href;
      parts.push(
        <a key={`h-${r.start}`} href={r.href} target="_blank" rel="noopener noreferrer"
          className="text-[#5865F2] underline underline-offset-2 hover:text-[#7289DA]"
          onClick={(e) => e.stopPropagation()}
          onMouseEnter={(e) => {
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const y = (window.innerHeight - rect.bottom) > 130 ? rect.bottom + 8 : rect.top - 128;
            setPreview({ url: hrefForPreview, x: Math.max(8, Math.min(rect.left, window.innerWidth - 296)), y });
          }}
          onMouseLeave={() => setPreview(null)}
        >
          {highlight ? <HighlightText text={r.linkText} highlight={highlight} field={field} matchCountBefore={matchesSoFar} activeField={activeField} activeIndex={activeIndex} /> : r.linkText}
        </a>
      );
      if (highlight) matchesSoFar += countHighlightOccurrences(r.linkText, highlight);
      lastIdx = r.end;
    }
  }

  if (lastIdx < src.length) {
    const remaining = src.slice(lastIdx);
    parts.push(highlight ? <HighlightText key="t-tail" text={remaining} highlight={highlight} field={field} matchCountBefore={matchesSoFar} activeField={activeField} activeIndex={activeIndex} /> : remaining);
  }

  let domain = "";
  if (preview) { try { domain = new URL(preview.url).hostname; } catch {} }

  return (
    <>
      {parts}
      {preview && (
        <div className="fixed z-[70] pointer-events-none" style={{ top: preview.y, left: preview.x }}>
          <div className="bg-[#1E1F22] border border-[#404249] rounded-lg shadow-2xl p-3 w-72">
            <div className="flex items-center gap-1.5 mb-1">
              <span className="text-[11px]">🔗</span>
              <span className="text-xs font-bold text-gray-200 truncate">{domain}</span>
            </div>
            <div className="text-[11px] text-gray-500 break-all leading-relaxed"
              style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" } as React.CSSProperties}>
              {preview.url}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// 絵文字はOS/フォントによって見た目が大きく異なる（Windows/Mac/Androidで別デザインになる）ため、
// ピン留め・添付ファイル関連のアイコンは既存の設定/フィルターボタンと同じ単色SVGに統一する

export function PinIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z" />
    </svg>
  );
}

export function PaperclipIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.31 2.69 6 6 6s6-2.69 6-6V6h-2.5z" />
    </svg>
  );
}

export function WarningIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" />
    </svg>
  );
}

function ImageFileIcon({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z" />
    </svg>
  );
}

function AudioFileIcon({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
    </svg>
  );
}

function VideoFileIcon({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z" />
    </svg>
  );
}

function GenericFileIcon({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M6 2c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6H6zm7 7V3.5L18.5 9H13z" />
    </svg>
  );
}

export function getFileIcon(mimeType: string, className: string = "w-5 h-5"): React.ReactNode {
  if (mimeType.startsWith('image/')) return <ImageFileIcon className={className} />;
  if (mimeType.startsWith('audio/')) return <AudioFileIcon className={className} />;
  if (mimeType.startsWith('video/')) return <VideoFileIcon className={className} />;
  return <GenericFileIcon className={className} />;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export function ActionBar({ app, isChat }: { app: any, isChat: boolean }) {
  const modePrefix = isChat ? "chat" : "msg";
  const { selectionMode, selectedIds } = app.state;
  const { handleMenuBarClick, setModal, setSelectedIds, setRenameInput,
          setReplySubject, setReplyBody, setReplyToMessage, safeBack, enterSelectionMode } = app.actions;

  const [showCopiedToast, setShowCopiedToast] = useState(false);

  const isAnySelection = selectionMode === `${modePrefix}_select`;
  const hasItems = selectedIds.length > 0;

  // チャットのピン留め・非表示は制限なし。メッセージは従来通り
  const isActionRestrictedForAll = (action: string): boolean => {
    if (!hasItems) return false;
    return selectedIds.every((id: string) => {
      if (isChat) {
        if (action === "pin" || action === "hide") return false;
        const chatEmails: any[] = app.computed.groupedEmails[id] || [];
        if (chatEmails.length === 0) return false;
        if (action === "delete")
          return chatEmails.every((e: any) => e.labelIds?.includes("TRASH") || e.labelIds?.includes("SENT") || e.isMe);
        if (action === "move")
          return chatEmails.every((e: any) => e.labelIds?.includes("SENT") || e.isMe);
      } else {
        const msg = app.computed.allUniqueEmails.find((e: any) => e.id === id);
        if (!msg) return true;
        const isTrash = msg.labelIds?.includes("TRASH");
        const isSpam = msg.labelIds?.includes("SPAM");
        const isSent = msg.labelIds?.includes("SENT") || msg.isMe;
        // ピン留め・非表示は送信済みメールも対象にできる（ゴミ箱・迷惑メールのみ対象外）
        if (action === "pin" || action === "hide") return isTrash || isSpam;
        if (action === "delete") return isTrash || isSent;
        if (action === "move") return isSent;
      }
      return false;
    });
  };

  const hasSelectedTarget = selectedIds.some((id: string) => {
    if (isChat) return true; // チャットは常に対象
    const msg = app.computed.allUniqueEmails.find((e: any) => e.id === id);
    return msg && !msg.labelIds?.includes("TRASH") && !msg.labelIds?.includes("SPAM");
  });

  const isDisabled = (action: string): boolean => {
    // リセットは常に有効（このボタン自体はチャット画面にしか描画されない）。無選択時は
    // 全チャット/メッセージから選ぶ画面を開く
    if (action === "reset") return false;
    if (!isAnySelection || !hasItems) return true;
    if ((action === "pin" || action === "hide") && !isChat && !hasSelectedTarget) return true;
    return isActionRestrictedForAll(action);
  };

  const btnBase = isChat
    ? "flex-1 min-w-[54px] py-1.5 text-[10px] font-bold rounded transition"
    : "px-2.5 py-1 text-xs font-bold rounded transition";

  const getBtnClass = (action: string, danger = false) => {
    const disabled = isDisabled(action);
    const hoverClass = danger ? "hover:bg-[#DA373C]" : "hover:bg-[#5865F2]";
    const colorClass = !disabled
      ? `bg-[#2B2D31] text-gray-200 border border-[#4752C4] ${hoverClass} hover:text-white`
      : "bg-[#1E1F22] text-gray-400";
    return `${btnBase} ${colorClass} ${disabled ? "opacity-30 pointer-events-none grayscale" : ""}`;
  };

  const renderText = (text: string) => {
    if (isAnySelection && hasItems) return `${text}(${selectedIds.length})`;
    return text;
  };

  const containerClass = isChat
    ? "flex flex-wrap p-2 gap-1 border-b border-[#1E1F22] bg-[#2B2D31] cursor-default"
    : "flex flex-wrap px-3 py-2 gap-1.5 border-b border-[#1E1F22] bg-[#2B2D31] cursor-default";

  const handleSelectAll = () => {
    if (isChat) {
      // 現在表示中のタブ（個人 / グループ / フィルター）に含まれるチャットだけを対象にする
      const allIds = (app.computed.senderList as string[]).filter(
        (id: string) => chatConfigTab(app.state.chatConfigs[id]) === app.state.activeChatTab
      );
      if (!isAnySelection) enterSelectionMode("chat", allIds[0]);
      setSelectedIds(allIds);
    } else {
      const allIds = ((app.computed.groupedEmails[app.state.selectedSender] || []) as any[]).map((e: any) => e.id);
      if (!isAnySelection) enterSelectionMode("msg", allIds[0]);
      setSelectedIds(allIds);
    }
  };

  const selectedMsg = !isChat && selectedIds.length === 1
    ? app.computed.allUniqueEmails.find((e: any) => e.id === selectedIds[0])
    : null;

  const allPinned = isAnySelection && hasItems && selectedIds.every((id: string) =>
    isChat ? app.state.chatConfigs[id]?.isPinned : app.state.messageConfigs[app.actions.messageConfigKey(id)]?.isPinned
  );

  const showBanner = isAnySelection && hasItems;

  // グループは1つのアカウントから送信する前提のため、複数アカウントのチャットを
  // またいで選択している場合は「作成」（選択チャットをメンバーにしたグループ作成）を無効化する
  const selectedSpansMultipleAccounts = isChat && isAnySelection && hasItems &&
    new Set(selectedIds.map((id: string) => app.actions.roomAccountEmail(id))).size > 1;

  // グループチャットの表示モードによるアクションバー制限
  const selectedGroupConfig = !isChat ? app.state.chatConfigs[app.state.selectedSender] : undefined;
  const isInboundOnlyGroupBar = !!(selectedGroupConfig?.isGroup && selectedGroupConfig.groupMode === "inbound_only");
  const isOutboundOnlyGroupBar = !!(selectedGroupConfig?.isGroup && selectedGroupConfig.groupMode === "outbound_only");

  return (
    <>
      {showCopiedToast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[80] bg-[#2B2D31] text-white text-sm font-bold px-4 py-2 rounded-full shadow-lg border border-[#4752C4] animate-fade-in pointer-events-none">
          コピーしました
        </div>
      )}
      <div className={`${containerClass} ${isOutboundOnlyGroupBar ? "opacity-30 pointer-events-none grayscale" : ""}`} onClick={(e) => e.stopPropagation()}>
      {showBanner && (
        <div className="w-full text-center text-[10px] text-[#5865F2] font-bold py-0.5">
          {selectedIds.length}件選択中
        </div>
      )}

      {/* 全選択 */}
      <button onClick={handleSelectAll} className={`${btnBase} bg-[#1E1F22] text-gray-400 hover:bg-[#3f4147] hover:text-gray-200`}>
        全選択
      </button>

      {/* キャンセル */}
      <button
        onClick={() => { if (isAnySelection) safeBack(); }}
        className={`${btnBase} bg-[#1E1F22] text-gray-400 hover:bg-[#3f4147] hover:text-gray-200 ${!isAnySelection ? "opacity-30 pointer-events-none grayscale" : ""}`}
      >
        キャンセル
      </button>

      {/* チャット: 作成（未選択なら通常通り新規作成、選択中ならそのチャットを選択済みの状態でモーダルを開く） */}
      {isChat && (
        <button
          onClick={() => {
            if (selectedSpansMultipleAccounts) return;
            const preSelected = isAnySelection && hasItems
              ? selectedIds.filter((id: string) => !app.state.chatConfigs[id]?.isGroup)
              : [];
            // 選択モードの履歴(select)の上にモーダルの履歴を重ねて積む。
            // ここで先に selectionMode を終了しようとすると（history.back 等）、
            // それによる popstate が非同期で後から発火し、直後に開いたこのモーダルを
            // 巻き込んで setModal(null) してしまう（一瞬で閉じて見える不具合の原因）ため、
            // 選択の終了はモーダル側の完了処理（exitAfterAction）にまとめて任せる
            setModal({ type: "compose_new_chat", targetMode: "current_chat", targets: preSelected });
            window.history.pushState({ action: "modal" }, "", window.location.href);
          }}
          title={selectedSpansMultipleAccounts ? "複数のアカウントにまたがるチャットからはグループを作成できません" : undefined}
          className={`${btnBase} bg-[#1E1F22] text-gray-400 hover:bg-[#3f4147] hover:text-gray-200 ${selectedSpansMultipleAccounts ? "opacity-30 pointer-events-none grayscale" : ""}`}
        >
          作成
        </button>
      )}

      {/* チャット: 名前変更（チャット選択モードで1件選択時のみ有効。selectedIds はメッセージ選択と
          共有のstateのため、selectionMode 自体もチェックしないとメッセージを1件選択しただけで
          このボタンが（メッセージIDを対象に）押せてしまっていた */}
      {isChat && (
        <button
          onClick={() => {
            if (!isAnySelection || selectedIds.length !== 1) return;
            const id = selectedIds[0];
            setRenameInput(app.state.chatConfigs[id]?.customName || app.actions.roomLocalKey(id));
            setModal({ type: "rename", targetMode: "chat", targets: [id] });
            window.history.pushState({ action: "modal" }, "", window.location.href);
          }}
          className={`${btnBase} bg-[#1E1F22] text-gray-400 hover:bg-[#3f4147] hover:text-gray-200 ${!isAnySelection || selectedIds.length !== 1 ? "opacity-30 pointer-events-none grayscale" : ""}`}
        >
          名前変更
        </button>
      )}

      {/* メッセージ: 転送・リプライ・コピー（1件選択時のみ有効） */}
      {!isChat && (
        <>
          <button
            onClick={() => {
              if (!selectedMsg) return;
              // 「作成」と同じ宛先選択モーダルを転送モードで開く。選択モードの履歴の上に
              // モーダルの履歴を重ねるだけにし、選択の終了はモーダル側の完了処理に任せる
              // （先にここで選択を終了すると、その非同期popstateがモーダルを巻き込んで閉じてしまうため）
              setModal({ type: "compose_new_chat", targetMode: "current_chat", targets: [], composeMode: "forward", forwardMessage: selectedMsg } as any);
              window.history.pushState({ action: "modal" }, "", window.location.href);
            }}
            className={`${btnBase} bg-[#1E1F22] text-gray-400 hover:bg-[#3f4147] hover:text-gray-200 ${!selectedMsg ? "opacity-30 pointer-events-none grayscale" : ""}`}
          >
            転送
          </button>
          <button
            onClick={() => {
              if (!selectedMsg || isInboundOnlyGroupBar) return;
              setReplyToMessage(selectedMsg);
              setReplySubject(selectedMsg.subject?.startsWith("Re:") ? selectedMsg.subject : `Re: ${selectedMsg.subject || ""}`);
              if (isAnySelection) safeBack();
            }}
            className={`${btnBase} bg-[#1E1F22] text-gray-400 hover:bg-[#3f4147] hover:text-gray-200 ${(!selectedMsg || isInboundOnlyGroupBar) ? "opacity-30 pointer-events-none grayscale" : ""}`}
          >
            リプライ
          </button>
          <button
            onClick={() => {
              if (!selectedMsg) return;
              navigator.clipboard.writeText(selectedMsg.body || "").then(() => {
                setShowCopiedToast(true);
                setTimeout(() => setShowCopiedToast(false), 1500);
              }).catch(() => {});
              if (isAnySelection) safeBack();
            }}
            className={`${btnBase} bg-[#1E1F22] text-gray-400 hover:bg-[#3f4147] hover:text-gray-200 ${!selectedMsg ? "opacity-30 pointer-events-none grayscale" : ""}`}
          >
            コピー
          </button>
        </>
      )}

      {/* ピン留め / ピン解除 */}
      <button onClick={() => handleMenuBarClick(`${modePrefix}_${allPinned ? "unpin" : "pin"}`)} className={getBtnClass("pin")}>
        {renderText(allPinned ? "ピン解除" : "ピン留め")}
      </button>

      {/* 移動 */}
      <button onClick={() => handleMenuBarClick(`${modePrefix}_move`)} className={getBtnClass("move")}>
        {renderText("移動")}
      </button>

      {/* 非表示 */}
      <button onClick={() => handleMenuBarClick(`${modePrefix}_hide`)} className={getBtnClass("hide")}>
        {renderText("非表示")}
      </button>

      {/* 削除 */}
      <button onClick={() => handleMenuBarClick(`${modePrefix}_delete`)} className={getBtnClass("delete", true)}>
        {renderText("削除")}
      </button>

      {/* リセット: チャット画面のみ。選択チャットがあればその範囲、無ければ全体から選ぶ画面を開く */}
      {isChat && (
        <button onClick={() => handleMenuBarClick("chat_reset")} className={getBtnClass("reset", true)}>
          {renderText("リセット")}
        </button>
      )}
      </div>
    </>
  );
}
