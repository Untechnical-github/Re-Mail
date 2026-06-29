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
  const { selectionMode, selectedIds, knownBoxes } = app.state;
  const { handleMenuBarClick, setModal, setSelectedIds, setSelectionMode, setRenameInput,
          setReplySubject, setReplyBody, setReplyToMessage, safeBack } = app.actions;

  const isGenericSelect = selectionMode === `${modePrefix}_select`;
  const isAnySelection = selectionMode.startsWith(`${modePrefix}_`);
  const hasItems = selectedIds.length > 0;
  const isMode = (action: string) => selectionMode === `${modePrefix}_${action}`;

  // 全ての選択アイテムが action の制限対象かどうか
  const isActionRestrictedForAll = (action: string): boolean => {
    if (!hasItems) return false;
    return selectedIds.every((id: string) => {
      if (isChat) {
        const kb: string[] = knownBoxes?.[id] || [];
        if (action === "pin" || action === "hide")
          return kb.length > 0 && kb.every((b: string) => b === "TRASH" || b === "SPAM" || b === "SENT");
        if (action === "delete")
          return kb.length > 0 && kb.every((b: string) => b === "TRASH" || b === "SENT");
        if (action === "move")
          return kb.includes("SENT") && kb.length === 1;
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
    if (isChat) {
      return app.computed.groupedEmails[id]?.some((e: any) =>
        !e.labelIds?.includes("TRASH") && !e.labelIds?.includes("SPAM")
      ) || (knownBoxes?.[id] || []).some((b: string) => b === "INBOX" || b === "ARCHIVE");
    } else {
      const msg = app.computed.allUniqueEmails.find((e: any) => e.id === id);
      return msg && !msg.labelIds?.includes("TRASH") && !msg.labelIds?.includes("SPAM");
    }
  });

  const isDisabled = (action: string): boolean => {
    if (action === "reset") return false;
    if (!isAnySelection) return true;
    if (isGenericSelect) {
      if (!hasItems) return true;
      return isActionRestrictedForAll(action);
    }
    if (selectionMode !== `${modePrefix}_${action}`) return true;
    if ((action === "pin" || action === "hide") && !hasSelectedTarget) return true;
    return false;
  };

  const btnBase = isChat
    ? "flex-1 min-w-[54px] py-1.5 text-[10px] font-bold rounded transition"
    : "px-2.5 py-1 text-xs font-bold rounded transition";

  const getBtnClass = (action: string, activeBg: string) => {
    const disabled = isDisabled(action);
    let colorClass: string;
    if (isMode(action)) {
      colorClass = `${activeBg} text-white`;
    } else if (isGenericSelect && hasItems && !isActionRestrictedForAll(action)) {
      colorClass = `bg-[#2B2D31] text-gray-200 border border-[#4752C4] hover:${activeBg} hover:text-white`;
    } else {
      colorClass = "bg-[#1E1F22] text-gray-400 hover:bg-[#3f4147] hover:text-gray-200";
    }
    return `${btnBase} ${colorClass} ${disabled ? "opacity-30 pointer-events-none grayscale" : ""}`;
  };

  const renderText = (action: string, text: string) => {
    if (isMode(action)) return `実行(${selectedIds.length})`;
    if (isGenericSelect && hasItems) return `${text}(${selectedIds.length})`;
    return text;
  };

  const containerClass = isChat
    ? "flex flex-wrap p-2 gap-1 border-b border-[#1E1F22] bg-[#2B2D31] cursor-default"
    : "flex flex-wrap px-3 py-2 gap-1.5 border-b border-[#1E1F22] bg-[#2B2D31] cursor-default";

  // 全選択
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

  // 選択中のメッセージ取得（msg モード用）
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

      {/* キャンセル: 選択中のみ有効 */}
      <button
        onClick={() => { if (isAnySelection) safeBack(); }}
        className={`${btnBase} bg-[#1E1F22] text-gray-400 hover:bg-[#3f4147] hover:text-gray-200 ${!isAnySelection ? "opacity-30 pointer-events-none grayscale" : ""}`}
      >
        キャンセル
      </button>

      {/* チャット画面: 名前変更（1件選択時のみ有効） */}
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

      {/* メッセージ画面: 転送・リプライ・コピー（1件選択時のみ有効） */}
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
        {renderText("pin", "ピン留め")}
      </button>

      {/* 移動 */}
      <button onClick={() => handleMenuBarClick(`${modePrefix}_move`)} className={getBtnClass("move", "bg-[#5865F2]")}>
        {renderText("move", "移動")}
      </button>

      {/* 非表示 */}
      <button onClick={() => handleMenuBarClick(`${modePrefix}_hide`)} className={getBtnClass("hide", "bg-[#5865F2]")}>
        {renderText("hide", "非表示")}
      </button>

      {/* 削除 */}
      <button onClick={() => handleMenuBarClick(`${modePrefix}_delete`)} className={getBtnClass("delete", "bg-[#DA373C]")}>
        {renderText("delete", "削除")}
      </button>

      {/* リセット */}
      <button onClick={() => handleMenuBarClick(`${modePrefix}_reset`)} className={getBtnClass("reset", "bg-[#DA373C]")}>
        リセット
      </button>

      {/* 非表示解除 */}
      <button
        onClick={() => {
          setModal({ type: "unhide_select", targetMode: modePrefix as any, targets: [] });
          setSelectedIds([]);
          setSelectionMode("none");
          window.history.pushState({ action: "modal" }, "", window.location.href);
        }}
        className={`${btnBase} bg-[#1E1F22] text-gray-400 hover:bg-[#3f4147] hover:text-gray-200 ${isAnySelection && !isGenericSelect ? "opacity-30 pointer-events-none" : ""}`}
      >
        非表示解除
      </button>
    </div>
  );
}
