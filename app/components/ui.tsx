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

export function BodyWithLinks({ text, highlight }: { text: string; highlight?: string }) {
  const [preview, setPreview] = useState<{ url: string; x: number; y: number } | null>(null);

  const src = text || "";
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const re = /https?:\/\/[^\s<>"]+/g;

  while ((match = re.exec(src)) !== null) {
    const rawUrl = match[0].replace(/[.,;:!?)\]>'"。、，；：！？）]+$/, "");
    if (!rawUrl) { lastIndex = match.index + match[0].length; continue; }
    const trailing = match[0].slice(rawUrl.length);

    if (match.index > lastIndex) {
      const seg = src.slice(lastIndex, match.index);
      parts.push(highlight
        ? <HighlightText key={`t-${lastIndex}`} text={seg} highlight={highlight} />
        : seg
      );
    }

    const url = rawUrl;
    parts.push(
      <a
        key={`u-${match.index}`}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[#5865F2] underline underline-offset-2 hover:text-[#7289DA] break-all"
        onClick={(e) => e.stopPropagation()}
        onMouseEnter={(e) => {
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const spaceBelow = window.innerHeight - rect.bottom;
          const y = spaceBelow > 130 ? rect.bottom + 8 : rect.top - 128;
          setPreview({ url, x: Math.max(8, Math.min(rect.left, window.innerWidth - 296)), y });
        }}
        onMouseLeave={() => setPreview(null)}
      >
        {highlight ? <HighlightText text={url} highlight={highlight} /> : url}
      </a>
    );

    if (trailing) parts.push(trailing);
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < src.length) {
    const remaining = src.slice(lastIndex);
    parts.push(highlight
      ? <HighlightText key={`t-tail`} text={remaining} highlight={highlight} />
      : remaining
    );
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
            <div
              className="text-[11px] text-gray-500 break-all leading-relaxed"
              style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" } as React.CSSProperties}
            >
              {preview.url}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export function ActionBar({ app, isChat }: { app: any, isChat: boolean }) {
  const modePrefix = isChat ? "chat" : "msg";
  const { selectionMode, selectedIds } = app.state;
  const { handleMenuBarClick, setModal, setSelectedIds, setSelectionMode, setRenameInput,
          setReplySubject, setReplyBody, setReplyToMessage, safeBack, enterSelectionMode } = app.actions;

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

  return (
    <div className={containerClass} onClick={(e) => e.stopPropagation()}>
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
            }}
            className={`${btnBase} bg-[#1E1F22] text-gray-400 hover:bg-[#3f4147] hover:text-gray-200 ${!selectedMsg ? "opacity-30 pointer-events-none grayscale" : ""}`}
          >
            転送
          </button>
          <button
            onClick={() => {
              if (!selectedMsg) return;
              setReplyToMessage(selectedMsg);
              setReplySubject(`Re: ${selectedMsg.subject || ""}`);
            }}
            className={`${btnBase} bg-[#1E1F22] text-gray-400 hover:bg-[#3f4147] hover:text-gray-200 ${!selectedMsg ? "opacity-30 pointer-events-none grayscale" : ""}`}
          >
            リプライ
          </button>
          <button
            onClick={() => {
              if (!selectedMsg) return;
              navigator.clipboard.writeText(selectedMsg.body || "").catch(() => {});
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
  );
}
