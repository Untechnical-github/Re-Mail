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

export function ActionBar({ app, isChat }: { app: any, isChat: boolean }) {
  const modePrefix = isChat ? "chat" : "msg";
  const { selectionMode, selectedIds } = app.state;
  const { handleMenuBarClick, setModal, setSelectedIds, setSelectionMode, setRenameInput,
          setReplySubject, setReplyBody, setReplyToMessage, safeBack } = app.actions;

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

  const getBtnClass = (action: string, activeBg: string) => {
    const disabled = isDisabled(action);
    const colorClass = !disabled
      ? `bg-[#2B2D31] text-gray-200 border border-[#4752C4] hover:${activeBg} hover:text-white`
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
      setSelectedIds(allIds);
      if (!isAnySelection) setSelectionMode("chat_select");
    } else {
      const allIds = ((app.computed.groupedEmails[app.state.selectedSender] || []) as any[]).map((e: any) => e.id);
      setSelectedIds(allIds);
      if (!isAnySelection) setSelectionMode("msg_select");
    }
  };

  const selectedMsg = !isChat && selectedIds.length === 1
    ? app.computed.allUniqueEmails.find((e: any) => e.id === selectedIds[0])
    : null;

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

      {/* ピン留め */}
      <button onClick={() => handleMenuBarClick(`${modePrefix}_pin`)} className={getBtnClass("pin", "bg-[#5865F2]")}>
        {renderText("ピン留め")}
      </button>

      {/* 移動 */}
      <button onClick={() => handleMenuBarClick(`${modePrefix}_move`)} className={getBtnClass("move", "bg-[#5865F2]")}>
        {renderText("移動")}
      </button>

      {/* 非表示 */}
      <button onClick={() => handleMenuBarClick(`${modePrefix}_hide`)} className={getBtnClass("hide", "bg-[#5865F2]")}>
        {renderText("非表示")}
      </button>

      {/* 削除 */}
      <button onClick={() => handleMenuBarClick(`${modePrefix}_delete`)} className={getBtnClass("delete", "bg-[#DA373C]")}>
        {renderText("削除")}
      </button>

      {/* リセット: チャット画面のみ、選択時のみ有効 */}
      {isChat && (
        <button onClick={() => handleMenuBarClick("chat_reset")} className={getBtnClass("reset", "bg-[#DA373C]")}>
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