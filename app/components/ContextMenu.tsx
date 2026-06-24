import { MailAppHook } from "../hooks/useMailApp";

export function ContextMenu({ app }: { app: MailAppHook }) {
  // ★修正: checkSent を追加して、下流のコードで使えるようにする
  const { contextMenu, isMobile, chatConfigs, checkInbox, checkArchive, checkSent } = app.state;
  const { setContextMenu, handleContextMenuAction } = app.actions;

  if (!contextMenu) return null;

  return (
    <>
      <div className="fixed inset-0 z-[99]" onClick={(e) => { e.stopPropagation(); setContextMenu(null); }}></div>
      <div 
        className={`fixed z-[100] bg-[#2B2D31] rounded shadow-xl border border-[#1E1F22] overflow-hidden text-sm w-56 text-gray-300 ${isMobile ? 'bottom-0 left-0 w-full rounded-b-none p-2 animate-slide-up' : ''}`}
        style={isMobile ? {} : { top: Math.min(contextMenu.y, window.innerHeight - 300), left: Math.min(contextMenu.x, window.innerWidth - 200) }}
        onClick={(e) => e.stopPropagation()}
      >
        {contextMenu.type === "chat" && (() => {
          const tId = typeof contextMenu.target === "string" ? contextMenu.target : contextMenu.target.id;
          
          const kb = app.state.knownBoxes?.[tId] || [];
          const knownHasTrash = kb.includes("TRASH");
          const knownHasSpam = kb.includes("SPAM");
          const knownHasInbox = kb.includes("INBOX");
          const knownHasArchive = kb.includes("ARCHIVE");
          const knownHasSent = kb.includes("SENT");
          
          // ★復活: 前回のコード提示で私が削ってしまっていた1行です
          const isOnlySentChat = kb.includes("SENT") && kb.length === 1;

          // 実データまたは記憶データから、ゴミ箱・迷惑メールではない生存メールが存在するか厳格に判定
          const hasLiveTarget = app.computed.groupedEmails[tId]?.some((e: any) => !e.labelIds?.includes("TRASH") && !e.labelIds?.includes("SPAM")) ||
                                knownHasInbox || knownHasArchive || (knownHasSent && !knownHasTrash && !knownHasSpam);
          
          // 生存ターゲットがある場合のみアクションボタン（ピン留め・非表示）の表示を許可
          const showAction = (checkInbox || checkArchive || checkSent) && hasLiveTarget;
          
          return (
            <div className="flex flex-col p-1">
              <div className="px-2 py-1.5 text-xs font-bold text-gray-400 truncate border-b border-[#1E1F22] mb-1">{chatConfigs[tId]?.customName || tId}</div>
              <button onClick={() => handleContextMenuAction("rename", contextMenu.target)} className="w-full text-left px-2 py-2 rounded hover:bg-[#4752C4] hover:text-white transition">名前の変更</button>
              {showAction && <button onClick={() => handleContextMenuAction(chatConfigs[tId]?.isPinned ? "unpin" : "pin", contextMenu.target)} className="w-full text-left px-2 py-2 rounded hover:bg-[#4752C4] hover:text-white transition">{chatConfigs[tId]?.isPinned ? "ピン留め解除" : "ピン留めする"}</button>}
              <div className="h-px bg-[#1E1F22] my-1"></div>
              
              {!isOnlySentChat && (
                <button onClick={() => handleContextMenuAction("move", contextMenu.target)} className="w-full text-left px-2 py-2 rounded hover:bg-[#4752C4] hover:text-white transition">移動</button>
              )}
              
              {showAction && <button onClick={() => handleContextMenuAction("hide", contextMenu.target)} className="w-full text-left px-2 py-2 rounded hover:bg-[#DA373C] hover:text-white transition">非表示(Re:Mailのみ)</button>}
              <button onClick={() => handleContextMenuAction("delete", contextMenu.target)} className="w-full text-left px-2 py-2 rounded hover:bg-[#DA373C] hover:text-white transition font-bold">削除(Gmailを含む)</button>
              <div className="h-px bg-[#1E1F22] my-1"></div>
              <button onClick={() => handleContextMenuAction("reset", contextMenu.target)} className="w-full text-left px-2 py-2 rounded hover:bg-[#DA373C] hover:text-white transition text-xs">リセット</button>
            </div>
          );
        })()}
        
        {contextMenu.type === "msg" && (() => {
          const mId = contextMenu.target.id;
          const isTarget = !contextMenu.target.labelIds?.includes("TRASH") && !contextMenu.target.labelIds?.includes("SPAM");
          const showAction = (checkInbox || checkArchive || checkSent) && isTarget;

          // ★追加: 送信済みメッセージか判定
          const isSentMsg = contextMenu.target.labelIds?.includes("SENT") || contextMenu.target.isMe;
          
          return (
            <div className="flex flex-col p-1">
              <button onClick={() => handleContextMenuAction("reply", contextMenu.target)} className="w-full text-left px-2 py-2 rounded hover:bg-[#4752C4] hover:text-white transition">リプライ</button>
              <button onClick={() => handleContextMenuAction("forward", contextMenu.target)} className="w-full text-left px-2 py-2 rounded hover:bg-[#4752C4] hover:text-white transition">転送</button>
              <button onClick={() => handleContextMenuAction("copy", contextMenu.target)} className="w-full text-left px-2 py-2 rounded hover:bg-[#4752C4] hover:text-white transition">テキストをコピー</button>
              {showAction && <button onClick={() => handleContextMenuAction(chatConfigs[mId]?.isPinned ? "unpin" : "pin", contextMenu.target)} className="w-full text-left px-2 py-2 rounded hover:bg-[#4752C4] hover:text-white transition">{chatConfigs[mId]?.isPinned ? "ピン留め解除" : "ピン留めする"}</button>}
              <div className="h-px bg-[#1E1F22] my-1"></div>
              
              {/* ★修正: 送信済みメッセージでなければ「移動」を表示 */}
              {!isSentMsg && (
                <button onClick={() => handleContextMenuAction("move", contextMenu.target)} className="w-full text-left px-2 py-2 rounded hover:bg-[#4752C4] hover:text-white transition">移動</button>
              )}
              
              {showAction && <button onClick={() => handleContextMenuAction("hide", contextMenu.target)} className="w-full text-left px-2 py-2 rounded hover:bg-[#DA373C] hover:text-white transition">非表示(Re:Mailのみ)</button>}
              <button onClick={() => handleContextMenuAction("delete", contextMenu.target)} className="w-full text-left px-2 py-2 rounded hover:bg-[#DA373C] hover:text-white transition font-bold">削除(Gmailを含む)</button>
            </div>
          );
        })()}
      </div>
    </>
  );
}