"use client";

import React, { useState } from "react";

export const HighlightText = ({ text, highlight }: { text: string, highlight: string }) => {
  if (!highlight) return <>{text}</>;
  const parts = text.split(new RegExp(`(${highlight})`, 'gi'));
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === highlight.toLowerCase()
          ? <mark key={i} className="bg-[#FEE75C] text-black font-bold px-0.5 rounded-sm">{part}</mark>
          : part
      )}
    </>
  );
};

export function BodyWithLinks({ text, highlight, htmlLinks }: {
  text: string;
  highlight?: string;
  htmlLinks?: Array<{ text: string; href: string }>;
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

  for (const r of ranges) {
    if (r.start < lastIdx) continue;
    if (r.start > lastIdx) {
      const seg = src.slice(lastIdx, r.start);
      parts.push(highlight ? <HighlightText key={`t-${lastIdx}`} text={seg} highlight={highlight} /> : seg);
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
          {highlight ? <HighlightText text={url} highlight={highlight} /> : url}
        </a>
      );
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
          {highlight ? <HighlightText text={r.linkText} highlight={highlight} /> : r.linkText}
        </a>
      );
      lastIdx = r.end;
    }
  }

  if (lastIdx < src.length) {
    const remaining = src.slice(lastIdx);
    parts.push(highlight ? <HighlightText key="t-tail" text={remaining} highlight={highlight} /> : remaining);
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

export function getFileIcon(mimeType: string): string {
  if (mimeType.startsWith('image/')) return '🖼️';
  if (mimeType === 'application/pdf') return '📄';
  if (mimeType.startsWith('audio/')) return '🎵';
  if (mimeType.startsWith('video/')) return '🎬';
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel')) return '📊';
  if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return '📊';
  if (mimeType.includes('document') || mimeType.includes('word')) return '📝';
  if (mimeType.startsWith('text/')) return '📝';
  if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('compressed') || mimeType.includes('archive')) return '🗜️';
  return '📎';
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export function ActionBar({ app, isChat }: { app: any, isChat: boolean }) {
  const modePrefix = isChat ? "chat" : "msg";
  const { selectionMode, selectedIds } = app.state;
  const { handleMenuBarClick, setModal, setSelectedIds, setSelectionMode, setRenameInput,
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
        if (action === "pin" || action === "hide") return isTrash || isSpam || isSent;
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
    if (action === "reset") return !isAnySelection || !hasItems;
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
      const allIds = app.computed.senderList as string[];
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
    app.state.chatConfigs[id]?.isPinned
  );

  const showBanner = isAnySelection && hasItems;

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

      {/* チャット: 名前変更（1件選択時のみ有効） */}
      {isChat && (
        <button
          onClick={() => {
            if (selectedIds.length !== 1) return;
            const id = selectedIds[0];
            setRenameInput(app.state.chatConfigs[id]?.customName || id);
            setModal({ type: "rename", targetMode: "chat", targets: [id] });
            window.history.pushState({ action: "modal" }, "", window.location.href);
          }}
          className={`${btnBase} bg-[#1E1F22] text-gray-400 hover:bg-[#3f4147] hover:text-gray-200 ${selectedIds.length !== 1 ? "opacity-30 pointer-events-none grayscale" : ""}`}
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
              setReplyToMessage(null);
              setReplySubject(`Fwd: ${selectedMsg.subject || ""}`);
              setReplyBody(`\n\n--- 転送メッセージ ---\n差出人: ${selectedMsg.from}\n件名: ${selectedMsg.subject || ""}\n日時: ${new Date(selectedMsg.date).toLocaleString("ja-JP")}\n\n${selectedMsg.body || ""}`);
              if (isAnySelection) safeBack();
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

      {/* リセット: チャット画面のみ、選択時のみ有効 */}
      {isChat && (
        <button onClick={() => handleMenuBarClick("chat_reset")} className={getBtnClass("reset", true)}>
          {renderText("リセット")}
        </button>
      )}

      {/* 非表示解除 */}
      <button
        onClick={() => {
          setModal({ type: "unhide_select", targetMode: modePrefix as any, targets: [] });
          setSelectedIds([]);
          setSelectionMode("none");
          window.history.pushState({ action: "modal" }, "", window.location.href);
        }}
        className={`${btnBase} bg-[#1E1F22] text-gray-400 hover:bg-[#3f4147] hover:text-gray-200`}
      >
        非表示解除
      </button>
      </div>
    </>
  );
}
