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
  const { selectionMode, selectedIds, checkInbox, checkArchive, checkSent, checkSpam, checkTrash, knownBoxes } = app.state;
  const { handleMenuBarClick, setModal, setSelectedIds, setSelectionMode } = app.actions;

  const isGenericSelect = selectionMode === `${modePrefix}_select`;
  const isAnySelection = selectionMode.startsWith(`${modePrefix}_`);
  const hasItems = selectedIds.length > 0;

  const isOnlySentFilterActive = checkSent && !checkInbox && !checkArchive && !checkSpam && !checkTrash;

  const isMode = (action: string) => selectionMode === `${modePrefix}_${action}`;

  const hasSelectedTarget = selectedIds.some((id: string) => {
    if (isChat) {
      const hasValidFetchedMail = app.computed.groupedEmails[id]?.some((e:any) => !e.labelIds?.includes("TRASH") && !e.labelIds?.includes("SPAM"));
      const kb = knownBoxes?.[id] || [];
      const hasValidKnownMail = (!hasValidFetchedMail && kb.length > 0) ? (
        (kb.includes("INBOX") && checkInbox) ||
        (kb.includes("ARCHIVE") && checkArchive) ||
        (kb.includes("SENT") && checkSent && !kb.includes("TRASH") && !kb.includes("SPAM"))
      ) : false;
      return hasValidFetchedMail || hasValidKnownMail;
    } else {
      const msg = app.computed.allUniqueEmails.find((e:any) => e.id === id);
      return msg && !msg.labelIds?.includes("TRASH") && !msg.labelIds?.includes("SPAM");
    }
  });

  const isSelectedOnlySent = selectedIds.length > 0 && selectedIds.every((id: string) => {
    if (isChat) {
      const kb = knownBoxes?.[id] || [];
      return kb.includes("SENT") && kb.length === 1;
    } else {
      const msg = app.computed.allUniqueEmails.find((e: any) => e.id === id);
      return msg && (msg.labelIds?.includes("SENT") || msg.isMe);
    }
  });

  const isOnlySentOrTrashFilterActive = (!checkInbox && !checkArchive && !checkSpam) && (checkSent || checkTrash);

  let isCurrentChatDeleteRestricted = false;
  if (!isChat && app.state.selectedSender) {
    const emails = app.computed.groupedEmails[app.state.selectedSender] || [];
    isCurrentChatDeleteRestricted = emails.length > 0 && emails.every((e: any) => e.labelIds?.includes("TRASH") || e.labelIds?.includes("SENT") || e.isMe);
  }

  const isSelectedDeleteRestricted = selectedIds.length > 0 && selectedIds.every((id: string) => {
    if (isChat) {
      const kb = knownBoxes?.[id] || [];
      const hasLive = kb.some((b:string) => b !== "TRASH" && b !== "SENT");
      if(kb.length > 0 && !hasLive) return true;
      const emails = app.computed.groupedEmails[id] || [];
      return emails.length > 0 && emails.every((e:any) => e.labelIds?.includes("TRASH") || e.labelIds?.includes("SENT") || e.isMe);
    } else {
      const msg = app.computed.allUniqueEmails.find((e: any) => e.id === id);
      return msg && (msg.labelIds?.includes("TRASH") || msg.labelIds?.includes("SENT") || msg.isMe);
    }
  });

  const hideDeleteButton = isOnlySentOrTrashFilterActive || isCurrentChatDeleteRestricted || isSelectedDeleteRestricted;

  const isDisabled = (action: string) => {
    if (action === "reset") return false;
    if (selectionMode === "none") return true;
    if (isGenericSelect) return !hasItems;
    if (selectionMode !== `${modePrefix}_${action}`) return true;
    if (action === "pin" && !hasSelectedTarget) return true;
    if (action === "hide" && !hasSelectedTarget) return true;
    return false;
  };

  const btnBase = isChat
    ? "flex-1 min-w-[70px] py-1.5 text-[11px] font-bold rounded transition"
    : "px-3 py-1 text-xs font-bold rounded transition";

  const getBtnClass = (action: string, activeBg: string) => {
    let active: string;
    if (isGenericSelect && hasItems) {
      active = `bg-[#2B2D31] text-gray-200 border border-[#4752C4] hover:${activeBg} hover:text-white`;
    } else if (isMode(action)) {
      active = `${activeBg} text-white`;
    } else {
      active = "bg-[#1E1F22] text-gray-400 hover:bg-[#3f4147] hover:text-gray-200";
    }
    const disabled = isDisabled(action) ? "opacity-30 pointer-events-none grayscale" : "";
    return `${btnBase} ${active} ${disabled}`;
  };

  const renderText = (action: string, text: string) => {
    if (isMode(action)) return `実行(${selectedIds.length})`;
    if (isGenericSelect && hasItems) return `${text}(${selectedIds.length})`;
    return text;
  };

  const containerClass = isChat
    ? "flex flex-wrap p-2 gap-1 border-b border-[#1E1F22] bg-[#2B2D31] cursor-default"
    : "flex flex-wrap px-4 py-2 gap-2 border-b border-[#1E1F22] bg-[#2B2D31] cursor-default";

  const showAction = checkInbox || checkArchive;

  // 選択モード中の件数バナー
  const showBanner = isAnySelection && hasItems;

  return (
    <div className={containerClass} onClick={(e) => e.stopPropagation()}>
      {showBanner && (
        <div className="w-full text-center text-[11px] text-[#5865F2] font-bold py-0.5">
          {selectedIds.length}件選択中
        </div>
      )}

      {showAction && (
        <button onClick={() => handleMenuBarClick(`${modePrefix}_pin`)} className={getBtnClass("pin", "bg-[#5865F2]")}>
          {renderText("pin", "ピン留め")}
        </button>
      )}

      {(!isOnlySentFilterActive && !(isGenericSelect && isSelectedOnlySent)) && (
        <button onClick={() => handleMenuBarClick(`${modePrefix}_move`)} className={getBtnClass("move", "bg-[#5865F2]")}>
          {renderText("move", "移動")}
        </button>
      )}

      {showAction && (
        <button onClick={() => handleMenuBarClick(`${modePrefix}_hide`)} className={getBtnClass("hide", "bg-[#5865F2]")}>
          {renderText("hide", "非表示(Re:Mail)")}
        </button>
      )}

      {!hideDeleteButton && (
        <button onClick={() => handleMenuBarClick(`${modePrefix}_delete`)} className={getBtnClass("delete", "bg-[#DA373C]")}>
          {renderText("delete", "削除(Gmail)")}
        </button>
      )}

      <button onClick={() => handleMenuBarClick(`${modePrefix}_reset`)} className={getBtnClass("reset", "bg-[#DA373C]")}>
        リセット
      </button>

      {showAction && (
        <button
          onClick={() => {
            setModal({ type: "unhide_select", targetMode: modePrefix, targets: [] });
            setSelectedIds([]); setSelectionMode("none"); window.history.pushState({ action: "modal" }, "", window.location.href);
          }}
          className={`${btnBase} bg-[#1E1F22] text-gray-400 hover:bg-[#3f4147] hover:text-gray-200 ${isAnySelection && !isGenericSelect ? 'opacity-30 pointer-events-none' : ''}`}
        >
          非表示解除
        </button>
      )}
    </div>
  );
}
