import type { RoomKeyStr } from "../../lib/roomKey";
import type { MailAppHook } from "../../hooks/useMailApp";
import type { ModalState } from "../../types/mail";

// チャットの名前の変更
export function RenameModal({ app, modal }: { app: MailAppHook; modal: NonNullable<ModalState> }) {
  const { renameInput } = app.state;
  const { setRenameInput, updateChatConfigByRoomKey, safeBack } = app.actions;
  return (
    <div className="p-5">
      <h2 className="text-lg font-bold text-white mb-4">名前の変更</h2>
      <input
        type="text"
        value={renameInput}
        onChange={(e) => setRenameInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            updateChatConfigByRoomKey(modal.targets[0] as RoomKeyStr, { customName: renameInput.trim() || undefined });
            safeBack();
          }
        }}
        className="w-full bg-[#1E1F22] text-white px-3 py-2 rounded focus:outline-none focus:ring-1 focus:ring-[#5865F2] mb-4"
        autoFocus
        placeholder="カスタム名を入力..."
      />
      <div className="flex justify-end gap-3">
        <button onClick={() => safeBack()} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
        <button
          onClick={() => {
            updateChatConfigByRoomKey(modal.targets[0] as RoomKeyStr, { customName: renameInput.trim() || undefined });
            safeBack();
          }}
          className="px-4 py-2 bg-[#5865F2] text-white rounded text-sm font-bold hover:bg-[#4752C4]"
        >
          変更する
        </button>
      </div>
    </div>
  );
}
