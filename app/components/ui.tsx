import { SelectionMode } from "../types/mail";

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

  // 現在「場所」のチェックがすべて外れていて、「送信済み」だけにチェックが入っているか判定
  const isOnlySentFilterActive = checkSent && !checkInbox && !checkArchive && !checkSpam && !checkTrash;
  const { handleMenuBarClick, setModal, setSelectedIds, setSelectionMode } = app.actions;

  const isMode = (action: string) => selectionMode === `${modePrefix}_${action}`;
  
  const hasSelectedTarget = selectedIds.some((id: string) => {
      if (isChat) {
          const kb = knownBoxes?.[id] || [];
          const knownHasTarget = kb.includes("INBOX") || kb.includes("ARCHIVE") || kb.includes("SENT");
          return knownHasTarget || app.computed.groupedEmails[id]?.some((e:any) => !e.labelIds?.includes("TRASH") && !e.labelIds?.includes("SPAM"));
      } else {
          const msg = app.computed.allUniqueEmails.find((e:any) => e.id === id);
          return msg && !msg.labelIds?.includes("TRASH") && !msg.labelIds?.includes("SPAM");
      }
  });

  // ★追加: 選択されたチャットやメッセージが「送信済みメールのみ」で構成されているか判定
  const isSelectedOnlySent = selectedIds.length > 0 && selectedIds.every((id: string) => {
    if (isChat) {
      const kb = knownBoxes?.[id] || [];
      return kb.includes("SENT") && kb.length === 1;
    } else {
      const msg = app.computed.allUniqueEmails.find((e: any) => e.id === id);
      return msg && (msg.labelIds?.includes("SENT") || msg.isMe);
    }
  });

  const isDisabled = (action: string) => {
      if (selectionMode !== "none" && selectionMode !== `${modePrefix}_${action}`) return true;
      if (action === "pin" && selectionMode === `${modePrefix}_pin` && !hasSelectedTarget) return true;
      if (action === "hide" && selectionMode === `${modePrefix}_hide` && !hasSelectedTarget) return true;
      return false;
  };

  const btnBase = isChat
    ? "flex-1 min-w-[70px] py-1.5 text-[11px] font-bold rounded transition"
    : "px-3 py-1 text-xs font-bold rounded transition";

  const getBtnClass = (action: string, activeBg: string) => {
    const active = isMode(action) ? `${activeBg} text-white` : "bg-[#1E1F22] text-gray-400 hover:bg-[#3f4147] hover:text-gray-200";
    const disabled = isDisabled(action) ? "opacity-30 pointer-events-none grayscale" : "";
    return `${btnBase} ${active} ${disabled}`;
  };

  const renderText = (action: string, text: string) => isMode(action) ? `実行(${selectedIds.length})` : text;

  const containerClass = isChat
    ? "flex flex-wrap p-2 gap-1 border-b border-[#1E1F22] bg-[#2B2D31] cursor-default"
    : "flex flex-wrap px-4 py-2 gap-2 border-b border-[#1E1F22] bg-[#2B2D31] cursor-default";

  const showAction = checkInbox || checkArchive || checkSent;

  return (
    <div className={containerClass} onClick={(e) => e.stopPropagation()}>
      {showAction && <button onClick={() => handleMenuBarClick(`${modePrefix}_pin`)} className={getBtnClass("pin", "bg-[#5865F2]")}>{renderText("pin", "ピン留め")}</button>}
      
      {/* ★修正: 「送信済みのみのフィルタ」または「選択したものが送信済みのみ」の場合、移動ボタンを隠す */}
      {(!isOnlySentFilterActive && !isSelectedOnlySent) && (
        <button onClick={() => handleMenuBarClick(`${modePrefix}_move`)} className={getBtnClass("move", "bg-[#5865F2]")}>{renderText("move", "移動")}</button>
      )}

      {showAction && <button onClick={() => handleMenuBarClick(`${modePrefix}_hide`)} className={getBtnClass("hide", "bg-[#5865F2]")}>{renderText("hide", "非表示(Re:Mail)")}</button>}
      <button onClick={() => handleMenuBarClick(`${modePrefix}_delete`)} className={getBtnClass("delete", "bg-[#DA373C]")}>{renderText("delete", "削除(Gmail)")}</button>
      <button onClick={() => handleMenuBarClick(`${modePrefix}_reset`)} className={getBtnClass("reset", "bg-[#DA373C]")}>リセット</button>
      {showAction && (
        <button
          onClick={() => {
            setModal({ type: "unhide_select", targetMode: modePrefix, targets: [] });
            setSelectedIds([]); setSelectionMode("none"); window.history.pushState({ action: "modal" }, "", window.location.href);
          }}
          className={`${btnBase} bg-[#1E1F22] text-gray-400 hover:bg-[#3f4147] hover:text-gray-200 ${selectionMode.startsWith(modePrefix + "_") ? 'opacity-30 pointer-events-none' : ''}`}
        >
          非表示解除
        </button>
      )}
    </div>
  );
}