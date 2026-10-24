import type { RoomKeyStr } from "../../lib/roomKey";
import type { MailAppHook } from "../../hooks/useMailApp";
import type { Email } from "../../types/email";
import type { ModalState } from "../../types/mail";

// リセット（非表示・ピン留め・名前変更を元に戻す）の項目選び
export function ResetSelectModal({ app, modal }: { app: MailAppHook; modal: NonNullable<ModalState> }) {
  const { chatConfigs, messageConfigs, selectedIds } = app.state;
  const { safeBack, exitAfterAction } = app.actions;
  const { hiddenChats, hiddenMsgs, pinnedChats, pinnedMsgs, nameChangedChats } = app.computed;
  const scope = modal.resetScope || "all";
  const targetChatIds = new Set(modal.targets as string[]);
  const inScope = (roomId: string | undefined) => scope === "all" || (roomId !== undefined && targetChatIds.has(roomId));

  // 選択中チャットが非表示ということはあり得ない（非表示チャットはそもそも一覧に出ず選べない）ため、
  // specificスコープでは「非表示のチャット」欄は出さず、メッセージのみを対象にする
  const hideChatItems: string[] = scope === "all" ? hiddenChats : [];
  const hideMsgItems = (hiddenMsgs as Email[]).filter((m) => inScope(messageConfigs[app.actions.messageConfigKey(m.id)]?.roomId));
  const pinChatItems: string[] = scope === "all" ? pinnedChats : pinnedChats.filter((c: string) => targetChatIds.has(c));
  const pinMsgItems = (pinnedMsgs as Email[]).filter((m) => inScope(messageConfigs[app.actions.messageConfigKey(m.id)]?.roomId));
  const nameChatItems: string[] = scope === "all" ? nameChangedChats : nameChangedChats.filter((c: string) => targetChatIds.has(c));

  const key = (category: string, level: string, id: string) => `${category}:${level}:${id}`;
  const totalCount = hideChatItems.length + hideMsgItems.length + pinChatItems.length + pinMsgItems.length + nameChatItems.length;

  const renderChatRow = (category: string, c: string) => (
    <label key={key(category, "chat", c)} className="flex items-center gap-3 p-2 hover:bg-[#2B2D31] rounded cursor-pointer">
      <input type="checkbox" checked={selectedIds.includes(key(category, "chat", c))} onChange={() => app.actions.toggleSelection(key(category, "chat", c))} className="accent-[#5865F2]" />
      <span className="text-sm truncate">{chatConfigs[c as RoomKeyStr]?.customName || app.actions.roomLocalKey(c)}</span>
    </label>
  );
  const renderMsgRow = (category: string, m: Email) => {
    const roomId = messageConfigs[app.actions.messageConfigKey(m.id)]?.roomId;
    const chatName = roomId ? (chatConfigs[roomId]?.customName || app.actions.roomLocalKey(roomId)) : "不明なチャット";
    return (
      <label key={key(category, "msg", m.id)} className="flex items-center gap-3 p-2 hover:bg-[#2B2D31] rounded cursor-pointer">
        <input type="checkbox" checked={selectedIds.includes(key(category, "msg", m.id))} onChange={() => app.actions.toggleSelection(key(category, "msg", m.id))} className="accent-[#5865F2]" />
        <div className="text-sm truncate flex-1 flex flex-col gap-0.5">
          <span className="text-[11px] text-[#5865F2] font-bold truncate">{chatName}</span>
          <div className="text-gray-200 truncate">
            <span className="text-gray-400 text-xs mr-2">{new Date(m.date).toLocaleDateString()}</span>
            {m.subject || m.snippet || "(件名なし)"}
          </div>
        </div>
      </label>
    );
  };

  return (
    <div className="flex flex-col max-h-[80vh]">
      <div className="p-4 border-b border-[#1E1F22]">
        <h2 className="text-lg font-bold text-white">設定のリセット</h2>
        <p className="text-xs text-gray-400 mt-1">
          {scope === "all" ? "すべてのチャット・メッセージが対象です" : `選択した${targetChatIds.size}件のチャットが対象です`}
        </p>
      </div>
      <div className="p-2 overflow-y-auto flex-1 space-y-4">
        <div>
          <div className="text-xs font-bold text-gray-400 mb-1.5 px-2">非表示</div>
          {hideChatItems.length > 0 && (
            <div className="mb-2">
              <div className="text-[10px] font-bold text-gray-500 mb-1 px-2">チャット</div>
              {hideChatItems.map((c: string) => renderChatRow("hide", c))}
            </div>
          )}
          {hideMsgItems.length > 0 && (
            <div>
              <div className="text-[10px] font-bold text-gray-500 mb-1 px-2">メッセージ</div>
              {hideMsgItems.map((m) => renderMsgRow("hide", m))}
            </div>
          )}
          {hideChatItems.length === 0 && hideMsgItems.length === 0 && <div className="text-gray-500 text-xs p-2 px-4">対象はありません</div>}
        </div>
        <div className="border-t border-[#1E1F22]/50 pt-2">
          <div className="text-xs font-bold text-gray-400 mb-1.5 px-2">ピン留め</div>
          {pinChatItems.length > 0 && (
            <div className="mb-2">
              <div className="text-[10px] font-bold text-gray-500 mb-1 px-2">チャット</div>
              {pinChatItems.map((c: string) => renderChatRow("pin", c))}
            </div>
          )}
          {pinMsgItems.length > 0 && (
            <div>
              <div className="text-[10px] font-bold text-gray-500 mb-1 px-2">メッセージ</div>
              {pinMsgItems.map((m) => renderMsgRow("pin", m))}
            </div>
          )}
          {pinChatItems.length === 0 && pinMsgItems.length === 0 && <div className="text-gray-500 text-xs p-2 px-4">対象はありません</div>}
        </div>
        <div className="border-t border-[#1E1F22]/50 pt-2">
          <div className="text-xs font-bold text-gray-400 mb-1.5 px-2">名前変更（チャットのみ）</div>
          {nameChatItems.map((c: string) => renderChatRow("name", c))}
          {nameChatItems.length === 0 && <div className="text-gray-500 text-xs p-2 px-4">対象はありません</div>}
        </div>
        {totalCount === 0 && <div className="text-gray-500 text-sm p-4 text-center">リセットできる項目がありません</div>}
      </div>
      <div className="p-4 border-t border-[#1E1F22] flex justify-end gap-3">
        <button onClick={() => safeBack()} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
        <button
          disabled={selectedIds.length === 0}
          onClick={() => { app.actions.executeResetSelection(selectedIds); exitAfterAction(); }}
          className="px-4 py-2 bg-[#DA373C] text-white rounded text-sm font-bold hover:bg-[#a1282c] disabled:bg-[#3f4147] disabled:text-gray-500"
        >
          リセットする ({selectedIds.length})
        </button>
      </div>
    </div>
  );
}
