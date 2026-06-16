import { MailAppHook } from "../hooks/useMailApp";
import { SelectionMode } from "../types/mail";

export function Modals({ app }: { app: MailAppHook }) {
  const { modal, renameInput, moveDestination, resetOptions, chatConfigs, selectedIds } = app.state;
  const { setModal, executeConfirmedAction, executePin, setRenameInput, setMoveDestination, setSelectionMode, setSelectedIds, setResetOptions, updateChatConfig } = app.actions;
  const { groupedEmails, allUniqueEmails, hiddenChats, hiddenMsgs } = app.computed;

  if (!modal) return null;

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
      <div className="bg-[#313338] rounded-md shadow-2xl w-full max-w-sm border border-[#1E1F22]">
        
        {modal.type === "confirm_delete" && (() => {
          let deleteEmails: any[] = [];
          if (modal.targetMode === "chat") { modal.targets.forEach(chat => deleteEmails.push(...(groupedEmails[chat] || []))); } 
          else { deleteEmails = allUniqueEmails.filter(e => modal.targets.includes(e.id)); }
          const permanentCount = deleteEmails.filter(e => e.labelIds?.includes("TRASH")).length;
          const trashCount = deleteEmails.filter(e => !e.labelIds?.includes("TRASH")).length;
          
          return (
            <div className="p-5">
              <h2 className="text-lg font-bold text-white mb-2">削除の確認</h2>
              <p className="text-sm text-gray-300 mb-6 leading-relaxed">
                選択した{modal.targetMode === "chat" ? "チャット内の" : ""}メッセージを削除します。<br/>
                {trashCount > 0 && <span className="block mt-2 font-bold">・{trashCount}件のメールをゴミ箱へ移動します。</span>}
                {permanentCount > 0 && <span className="block mt-2 text-[#DA373C] font-bold">・{permanentCount}件のメール（既にゴミ箱にあるもの）は完全に削除され、元に戻せません。</span>}
              </p>
              <div className="flex justify-end gap-3">
                <button onClick={() => window.history.back()} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
                <button onClick={executeConfirmedAction} className="px-4 py-2 bg-[#DA373C] text-white rounded text-sm font-bold hover:bg-[#a1282c]">削除する</button>
              </div>
            </div>
          );
        })()}

        {modal.type === "confirm_hide" && (
          <div className="p-5">
            <h2 className="text-lg font-bold text-white mb-2">非表示(Re:Mailのみ)</h2>
            <p className="text-sm text-gray-300 mb-6 leading-relaxed">選択した項目をRe:Mailの画面上から隠します。（Gmailからは削除されません）</p>
            <div className="flex justify-end gap-3">
              <button onClick={() => window.history.back()} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
              <button onClick={executeConfirmedAction} className="px-4 py-2 bg-[#5865F2] text-white rounded text-sm font-bold hover:bg-[#4752C4]">非表示にする</button>
            </div>
          </div>
        )}

        {modal.type === "confirm_pin" && (() => {
          const isChatMode = modal.targetMode === "chat";
          const existingForcePinnedChats = Object.keys(chatConfigs).filter(k => !k.includes("-") && chatConfigs[k]?.isPinned && chatConfigs[k]?.forceFetch);
          const newChatsToPin = isChatMode ? modal.targets.filter(t => !existingForcePinnedChats.includes(t)) : [];
          const willExceedLimit = isChatMode && (existingForcePinnedChats.length + newChatsToPin.length > 10);
          return (
            <div className="p-5">
              <h2 className="text-lg font-bold text-white mb-2">ピン留め</h2>
              <p className="text-sm text-gray-300 mb-6 leading-relaxed">読み込み対象外（期間外や件数制限など）になった際も、この{modal.targetMode === "chat" ? "チャット" : "メッセージ"}を表示させますか？</p>
              <div className="flex flex-col gap-2">
                <button onClick={() => executePin(true)} disabled={willExceedLimit} className={`w-full py-2.5 rounded text-sm font-bold transition ${willExceedLimit ? 'bg-[#3f4147] text-gray-500 cursor-not-allowed' : 'bg-[#5865F2] text-white hover:bg-[#4752C4] active:scale-95'}`}>
                  {willExceedLimit ? "永続読み込みは10件までです" : "対象外になっても常に表示する"}
                </button>
                <button onClick={() => executePin(false)} className="w-full py-2.5 bg-[#404249] text-white rounded text-sm font-bold hover:bg-[#4f545c] active:scale-95">対象外になった場合は隠す</button>
                <button onClick={() => window.history.back()} className="w-full py-2 mt-2 hover:underline text-gray-400 text-sm">キャンセル</button>
              </div>
            </div>
          );
        })()}

        {modal.type === "confirm_unhide" && (
          <div className="p-5">
            <h2 className="text-lg font-bold text-white mb-2">非表示を解除</h2>
            <p className="text-sm text-gray-300 mb-6 leading-relaxed">選択した項目を再び画面に表示しますか？</p>
            <div className="flex justify-end gap-3">
              <button onClick={() => { setModal({ type: "unhide_select", targetMode: modal.targetMode, targets: [] }); setSelectedIds([]); }} className="px-4 py-2 hover:underline text-gray-300 text-sm">戻る</button>
              <button onClick={executeConfirmedAction} className="px-4 py-2 bg-[#5865F2] text-white rounded text-sm font-bold hover:bg-[#4752C4]">解除する</button>
            </div>
          </div>
        )}

        {modal.type === "unhide_select" && (
          <div className="flex flex-col max-h-[80vh]">
            <div className="p-4 border-b border-[#1E1F22]">
              <h2 className="text-lg font-bold text-white">非表示の解除 ({modal.targetMode === "chat" ? "チャット" : "メッセージ"})</h2>
            </div>
            <div className="p-2 overflow-y-auto flex-1 space-y-1">
              {modal.targetMode === "chat" ? hiddenChats.map(c => (
                <label key={c} className="flex items-center gap-3 p-2 hover:bg-[#2B2D31] rounded cursor-pointer">
                  <input type="checkbox" checked={selectedIds.includes(c)} onChange={() => app.actions.toggleSelection(c)} className="accent-[#5865F2]" />
                  <span className="text-sm truncate">{chatConfigs[c]?.customName || c}</span>
                </label>
              )) : hiddenMsgs.map(m => {
                const roomId = chatConfigs[m.id]?.roomId; const chatName = roomId ? (chatConfigs[roomId]?.customName || roomId) : "不明なチャット";
                return (
                  <label key={m.id} className="flex items-center gap-3 p-2 hover:bg-[#2B2D31] rounded cursor-pointer">
                    <input type="checkbox" checked={selectedIds.includes(m.id)} onChange={() => app.actions.toggleSelection(m.id)} className="accent-[#5865F2]" />
                    <div className="text-sm truncate flex-1 flex flex-col gap-0.5">
                      <span className="text-[11px] text-[#5865F2] font-bold truncate">{chatName}</span>
                      <div className="text-gray-200 truncate">
                        <span className="text-gray-400 text-xs mr-2">{new Date(m.date).toLocaleDateString()}</span>
                        {m.subject || m.snippet || "(件名なし)"}
                      </div>
                    </div>
                  </label>
                );
              })}
              {(modal.targetMode === "chat" ? hiddenChats : hiddenMsgs).length === 0 && <div className="text-gray-500 text-sm p-4 text-center">非表示の項目はありません</div>}
            </div>
            <div className="p-4 border-t border-[#1E1F22] flex justify-end gap-3">
              <button onClick={() => window.history.back()} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
              <button disabled={selectedIds.length === 0} onClick={() => setModal({ type: "confirm_unhide", targetMode: modal.targetMode, targets: selectedIds })} className="px-4 py-2 bg-[#5865F2] text-white rounded text-sm font-bold hover:bg-[#4752C4] disabled:bg-gray-600 disabled:text-gray-400">次へ ({selectedIds.length})</button>
            </div>
          </div>
        )}

        {modal.type === "confirm_reset" && (
          <div className="p-5">
            <h2 className="text-lg font-bold text-white mb-2">設定のリセット</h2>
            <div className="flex flex-col gap-2 mb-6 text-sm text-gray-200 mt-4">
              <label className="flex items-center gap-3 cursor-pointer hover:bg-[#2B2D31] p-2 rounded transition">
                <input type="checkbox" checked={resetOptions.pin} onChange={(e) => setResetOptions({...resetOptions, pin: e.target.checked})} className="accent-[#5865F2] w-4 h-4" /> 
                ピン留め (通常・永続) を解除
              </label>
              <label className="flex items-center gap-3 cursor-pointer hover:bg-[#2B2D31] p-2 rounded transition">
                <input type="checkbox" checked={resetOptions.hide} onChange={(e) => setResetOptions({...resetOptions, hide: e.target.checked})} className="accent-[#5865F2] w-4 h-4" /> 
                非表示設定 を解除
              </label>
              <label className="flex items-center gap-3 cursor-pointer hover:bg-[#2B2D31] p-2 rounded transition">
                <input type="checkbox" checked={resetOptions.name} onChange={(e) => setResetOptions({...resetOptions, name: e.target.checked})} className="accent-[#5865F2] w-4 h-4" /> 
                名前の変更 を初期化
              </label>
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={() => window.history.back()} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
              <button onClick={executeConfirmedAction} disabled={!resetOptions.pin && !resetOptions.hide && !resetOptions.name} className="px-4 py-2 bg-[#DA373C] text-white rounded text-sm font-bold hover:bg-[#a1282c] disabled:bg-[#3f4147] disabled:text-gray-500">リセットする</button>
            </div>
          </div>
        )}

        {modal.type === "rename" && (
          <div className="p-5">
            <h2 className="text-lg font-bold text-white mb-4">チャット名の変更</h2>
            <input type="text" value={renameInput} onChange={(e) => setRenameInput(e.target.value)} className="w-full bg-[#1E1F22] text-gray-200 px-3 py-2 rounded focus:outline-none focus:ring-2 focus:ring-[#5865F2] mb-4" />
            <div className="flex justify-end gap-3">
              <button onClick={() => window.history.back()} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
              <button onClick={() => { updateChatConfig(modal.targets[0], { customName: renameInput.trim() }); window.history.back(); }} className="px-4 py-2 bg-[#5865F2] text-white rounded text-sm font-bold hover:bg-[#4752C4]">変更</button>
            </div>
          </div>
        )}

        {modal.type === "select_move_dest" && (
          <div className="p-5">
            <h2 className="text-lg font-bold text-white mb-4">移動先の選択</h2>
            <div className="flex flex-col gap-2 mb-4">
              {["INBOX", "SPAM", "TRASH"].map(dest => {
                const labels: Record<string, string> = { "INBOX": "受信箱", "SPAM": "迷惑メール", "TRASH": "ゴミ箱" };
                return (
                  <button 
                    key={dest} 
                    onClick={() => { 
                      setMoveDestination(dest as any); 
                      setSelectionMode((modal.targetMode + "_move") as SelectionMode); 
                      setModal(null); 
                      window.history.replaceState({ action: "select" }, "", window.location.href); // ★追加
                      app.refs.hasPushedSelectRef.current = true;
                    }}
                    className="w-full py-2.5 bg-[#2B2D31] hover:bg-[#3f4147] border border-[#1E1F22] rounded text-white font-bold transition"
                  >
                    {labels[dest]}
                  </button>
                );
              })}
            </div>
            <button onClick={() => window.history.back()} className="w-full py-2 hover:underline text-gray-400 text-sm">キャンセル</button>
          </div>
        )}

        {modal.type === "select_move_dest_context" && (() => {
          let items = modal.targetMode === "chat" ? groupedEmails[modal.targets[0]] : allUniqueEmails.filter(e => e.id === modal.targets[0]);
          if (!items) items = [];
          return (
            <div className="p-5">
              <h2 className="text-lg font-bold text-white mb-4">移動先の選択</h2>
              <div className="flex flex-col gap-2 mb-4">
                {["INBOX", "SPAM", "TRASH"].map(dest => {
                  const isAllInDest = items.length > 0 && items.every((e: any) => e.labelIds?.includes(dest));
                  const labels: Record<string, string> = { "INBOX": "受信箱", "SPAM": "迷惑メール", "TRASH": "ゴミ箱" };
                  return (
                    <button 
                      key={dest} 
                      disabled={isAllInDest}
                      onClick={() => { setMoveDestination(dest as any); setModal({ type: "confirm_move", targetMode: modal.targetMode, targets: modal.targets }); }} 
                      className={`w-full py-2.5 border rounded font-bold transition ${isAllInDest ? 'bg-[#1E1F22] text-gray-600 border-[#1E1F22] cursor-not-allowed' : 'bg-[#2B2D31] hover:bg-[#3f4147] border-[#1E1F22] text-white'}`}
                    >
                      {labels[dest]} {isAllInDest && "(既に存在します)"}
                    </button>
                  );
                })}
              </div>
              <button onClick={() => window.history.back()} className="w-full py-2 hover:underline text-gray-400 text-sm">キャンセル</button>
            </div>
          );
        })()}

        {modal.type === "confirm_move" && (
          <div className="p-5">
            <h2 className="text-lg font-bold text-white mb-2">移動の確認</h2>
            <p className="text-sm text-gray-300 mb-6 leading-relaxed">
              選択したアイテムを「{moveDestination === "INBOX" ? "受信箱" : moveDestination === "SPAM" ? "迷惑メール" : "ゴミ箱"}」へ移動します。よろしいですか？
            </p>
            <div className="flex justify-end gap-3">
              <button onClick={() => window.history.back()} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
              <button onClick={executeConfirmedAction} className="px-4 py-2 bg-[#5865F2] text-white rounded text-sm font-bold hover:bg-[#4752C4]">移動する</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}