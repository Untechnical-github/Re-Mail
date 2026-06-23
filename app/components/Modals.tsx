import { SelectionMode } from "../types/mail";

export function Modals({ app }: { app: any }) {
  // ★修正: state から knownBoxes を受け取る
  const { modal, renameInput, moveDestination, resetOptions, chatConfigs, selectedIds, selectedSender, pinType, checkTrash, checkSpam, checkInbox, checkArchive, revealedCrossPrompts, knownBoxes } = app.state;
  const { setModal, executeConfirmedAction, executePin, setRenameInput, setMoveDestination, setSelectionMode, setSelectedIds, setResetOptions, updateChatConfig, safeBack, setPinType } = app.actions;
  const { groupedEmails, allUniqueEmails, hiddenChats, hiddenMsgs } = app.computed;

  if (!modal) return null;

  const getActionableEmails = (targets: string[], targetMode: string) => {
    let result: any[] = [];
    if (targetMode === "chat") {
      targets.forEach((chat: string) => {
        const chatEmails = groupedEmails[chat] || [];
        result.push(...chatEmails.filter((e: any) => {
          const isTrash = e.labelIds?.includes("TRASH");
          const isSpam = e.labelIds?.includes("SPAM");
          const isInbox = e.labelIds?.includes("INBOX");
          const isArchive = !isTrash && !isSpam && !isInbox;
          const isCurrentBox = (isTrash && checkTrash) || (isSpam && checkSpam) || (isInbox && checkInbox) || (isArchive && checkArchive);
          return isCurrentBox || revealedCrossPrompts.includes(e.id);
        }));
      });
    } else {
      result = allUniqueEmails.filter((e: any) => targets.includes(e.id));
    }
    return result;
  };

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={(e) => e.stopPropagation()}>
      <div className="bg-[#313338] rounded-md shadow-2xl w-full max-w-sm border border-[#1E1F22]">
        
        {modal.type === "select_pin_type" && (() => {
          const isChatMode = modal.targetMode === "chat";
          const existingForcePinnedChats = Object.keys(chatConfigs).filter(k => !k.includes("-") && chatConfigs[k]?.isPinned && chatConfigs[k]?.forceFetch);
          const willExceedLimit = isChatMode && (existingForcePinnedChats.length >= 10);
          
          return (
            <div className="p-5">
              <h2 className="text-lg font-bold text-white mb-4">ピン留めの種類を選択</h2>
              <div className="flex flex-col gap-2 mb-4">
                <button 
                  disabled={willExceedLimit}
                  onClick={() => { 
                    setPinType(true); 
                    setSelectionMode((modal.targetMode + "_pin") as SelectionMode); 
                    setModal(null); 
                    window.history.replaceState({ action: "select" }, "", window.location.href);
                    app.refs.hasPushedSelectRef.current = true;
                  }} 
                  className={`w-full py-2.5 border rounded text-sm font-bold transition ${willExceedLimit ? 'bg-[#1E1F22] text-gray-500 border-[#1E1F22] cursor-not-allowed' : 'bg-[#2B2D31] hover:bg-[#3f4147] border-[#1E1F22] text-white'}`}
                >
                  {willExceedLimit ? "永続読み込み (上限10件到達)" : "永続読み込み (対象外でも常に表示)"}
                </button>
                <button 
                  onClick={() => { 
                    setPinType(false); 
                    setSelectionMode((modal.targetMode + "_pin") as SelectionMode); 
                    setModal(null); 
                    window.history.replaceState({ action: "select" }, "", window.location.href);
                    app.refs.hasPushedSelectRef.current = true;
                  }} 
                  className="w-full py-2.5 bg-[#2B2D31] hover:bg-[#3f4147] border border-[#1E1F22] rounded text-white text-sm font-bold transition"
                >
                  通常のピン留め (対象外になったら隠す)
                </button>
              </div>
              <button onClick={() => safeBack()} className="w-full py-2 hover:underline text-gray-400 text-sm">キャンセル</button>
            </div>
          );
        })()}

        {modal.type === "confirm_pin_execute" && (() => {
          const isChatMode = modal.targetMode === "chat";
          const existingForcePinnedChats = Object.keys(chatConfigs).filter(k => !k.includes("-") && chatConfigs[k]?.isPinned && chatConfigs[k]?.forceFetch);
          const newChatsToPin = isChatMode ? modal.targets.filter((t: string) => !existingForcePinnedChats.includes(t)) : [];
          const willExceedLimit = isChatMode && pinType && (existingForcePinnedChats.length + newChatsToPin.length > 10);
          
          return (
            <div className="p-5">
              <h2 className="text-lg font-bold text-white mb-2">ピン留めの確認</h2>
              <p className="text-sm text-gray-300 mb-6 leading-relaxed">
                選択したアイテムを<span className="font-bold text-white">{pinType ? "永続読み込み" : "通常の設定"}</span>でピン留めします。よろしいですか？<br/>
                <span className="text-xs text-gray-400">※受信箱またはアーカイブに存在するメールのみが対象となります。</span>
              </p>
              <div className="flex justify-end gap-3">
                <button onClick={() => safeBack()} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
                <button 
                  onClick={() => executePin(pinType!)} 
                  disabled={willExceedLimit}
                  className={`px-4 py-2 rounded text-sm font-bold text-white transition ${willExceedLimit ? 'bg-[#3f4147] text-gray-500 cursor-not-allowed' : 'bg-[#5865F2] hover:bg-[#4752C4]'}`}
                >
                  {willExceedLimit ? "永続読み込みは10件までです" : "ピン留めする"}
                </button>
              </div>
            </div>
          );
        })()}

        {modal.type === "confirm_pin" && (() => {
          const isChatMode = modal.targetMode === "chat";
          const existingForcePinnedChats = Object.keys(chatConfigs).filter(k => !k.includes("-") && chatConfigs[k]?.isPinned && chatConfigs[k]?.forceFetch);
          const newChatsToPin = isChatMode ? modal.targets.filter((t: string) => !existingForcePinnedChats.includes(t)) : [];
          const willExceedLimit = isChatMode && (existingForcePinnedChats.length + newChatsToPin.length > 10);
          return (
            <div className="p-5">
              <h2 className="text-lg font-bold text-white mb-2">ピン留め</h2>
              <p className="text-sm text-gray-300 mb-6 leading-relaxed">
                読み込み対象外（期間外や件数制限など）になった際も、この{modal.targetMode === "chat" ? "チャット" : "メッセージ"}を表示させますか？<br/>
                <span className="text-xs text-gray-400">※受信箱またはアーカイブのメールのみが対象となります。</span>
              </p>
              <div className="flex flex-col gap-2">
                <button onClick={() => executePin(true)} disabled={willExceedLimit} className={`w-full py-2.5 rounded text-sm font-bold transition ${willExceedLimit ? 'bg-[#3f4147] text-gray-500 cursor-not-allowed' : 'bg-[#5865F2] text-white hover:bg-[#4752C4] active:scale-95'}`}>
                  {willExceedLimit ? "永続読み込みは10件までです" : "対象外になっても常に表示する"}
                </button>
                <button onClick={() => executePin(false)} className="w-full py-2.5 bg-[#404249] text-white rounded text-sm font-bold hover:bg-[#4f545c] active:scale-95">対象外になった場合は隠す</button>
                <button onClick={() => safeBack()} className="w-full py-2 mt-2 hover:underline text-gray-400 text-sm">キャンセル</button>
              </div>
            </div>
          );
        })()}

        {modal.type === "confirm_delete" && (() => {
          const targetEmails = getActionableEmails(modal.targets, modal.targetMode);
          const inboxCount = targetEmails.filter(e => e.labelIds?.includes("INBOX")).length;
          const spamCount = targetEmails.filter(e => e.labelIds?.includes("SPAM")).length;
          const trashCount = targetEmails.filter(e => e.labelIds?.includes("TRASH")).length;
          // ★追加: 送信済みメールのカウント
          const sentCount = targetEmails.filter(e => e.labelIds?.includes("SENT") || e.isMe).length;
          // ★修正: アーカイブの計算から送信済み(SENT)を明確に除外
          const archiveCount = targetEmails.filter(e => !e.labelIds?.includes("INBOX") && !e.labelIds?.includes("TRASH") && !e.labelIds?.includes("SPAM") && !e.labelIds?.includes("SENT") && !e.isMe).length;
          
          const toTrashCount = inboxCount + archiveCount + spamCount;
          const toPermanentCount = trashCount + sentCount; // ★追加: 完全削除される数の合計
          
          return (
            <div className="p-5">
              <h2 className="text-lg font-bold text-white mb-2">削除の確認</h2>
              <p className="text-sm text-gray-300 mb-4 leading-relaxed">
                選択したアイテムを削除します。(対象: 合計 {targetEmails.length} 件)
              </p>
              <div className="bg-[#2B2D31] p-3 rounded border border-[#1E1F22] mb-5 space-y-2 text-[13px] text-gray-300">
                <div className="font-bold text-gray-400 border-b border-[#1E1F22] pb-1 mb-2 text-xs">【処理の内訳】</div>
                {toTrashCount > 0 && (
                  <div>
                    ・受信箱: {inboxCount}件 / アーカイブ: {archiveCount}件 / 迷惑メール: {spamCount}件 <br/>
                    <span className="text-[#FEE75C] ml-3">→ ゴミ箱へ移動します。</span>
                  </div>
                )}
                {toPermanentCount > 0 && (
                  <div>
                    {/* ★修正: 送信済みメールが一発で完全削除されることをユーザーに警告する */}
                    ・ゴミ箱: {trashCount}件 / <span className="text-white font-bold">送信済み: {sentCount}件</span> <br/>
                    <span className="text-[#DA373C] font-bold ml-3">→ 完全に削除します（復元不可）。</span>
                  </div>
                )}
              </div>
              <div className="flex justify-end gap-3">
                <button onClick={() => safeBack()} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
                <button onClick={executeConfirmedAction} className="px-4 py-2 bg-[#DA373C] text-white rounded text-sm font-bold hover:bg-[#a1282c]">削除する</button>
              </div>
            </div>
          );
        })()}

        {modal.type === "confirm_hide" && (() => {
          const targetEmails = getActionableEmails(modal.targets, modal.targetMode);
          const hideableCount = targetEmails.filter(e => !e.labelIds?.includes("TRASH") && !e.labelIds?.includes("SPAM")).length;

          return (
            <div className="p-5">
              <h2 className="text-lg font-bold text-white mb-2">非表示(Re:Mailのみ)</h2>
              <p className="text-sm text-gray-300 mb-6 leading-relaxed">
                選択した項目をRe:Mailの画面上から隠します。<br/>
                <span className="text-[#5865F2] font-bold">（対象となる受信箱・アーカイブのメール: {hideableCount}件）</span>
              </p>
              <div className="flex justify-end gap-3">
                <button onClick={() => safeBack()} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
                <button onClick={executeConfirmedAction} className="px-4 py-2 bg-[#5865F2] text-white rounded text-sm font-bold hover:bg-[#4752C4]">非表示にする</button>
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
              <h2 className="text-lg font-bold text-white">
                {modal.targetMode === "chat" ? "非表示の解除" : "非表示メッセージの解除"}
              </h2>
            </div>
            <div className="p-2 overflow-y-auto flex-1 space-y-4">
              {modal.targetMode === "chat" ? (
                <>
                  <div>
                    <div className="text-xs font-bold text-gray-400 mb-1.5 px-2">非表示のチャット</div>
                    {hiddenChats.map((c: string) => (
                      <label key={c} className="flex items-center gap-3 p-2 hover:bg-[#2B2D31] rounded cursor-pointer">
                        <input type="checkbox" checked={selectedIds.includes(c)} onChange={() => app.actions.toggleSelection(c)} className="accent-[#5865F2]" />
                        <span className="text-sm truncate">{chatConfigs[c]?.customName || c}</span>
                      </label>
                    ))}
                    {hiddenChats.length === 0 && <div className="text-gray-500 text-xs p-2 px-4">非表示のチャットはありません</div>}
                  </div>

                  <div className="border-t border-[#1E1F22]/50 pt-2">
                    <div className="text-xs font-bold text-gray-400 mb-1.5 px-2">非表示のメッセージ（すべてのチャットから）</div>
                    {hiddenMsgs.map((m: any) => {
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
                    {hiddenMsgs.length === 0 && <div className="text-gray-500 text-xs p-2 px-4">非表示のメッセージはありません</div>}
                  </div>
                </>
              ) : (
                <div>
                  <div className="text-xs font-bold text-gray-400 mb-1.5 px-2">このチャット内の非表示メッセージ</div>
                  {hiddenMsgs.filter((m: any) => chatConfigs[m.id]?.roomId === selectedSender).map((m: any) => (
                    <label key={m.id} className="flex items-center gap-3 p-2 hover:bg-[#2B2D31] rounded cursor-pointer">
                      <input type="checkbox" checked={selectedIds.includes(m.id)} onChange={() => app.actions.toggleSelection(m.id)} className="accent-[#5865F2]" />
                      <div className="text-sm truncate flex-1 flex flex-col gap-0.5">
                        <div className="text-gray-200 truncate">
                          <span className="text-gray-400 text-xs mr-2">{new Date(m.date).toLocaleDateString()}</span>
                          {m.subject || m.snippet || "(件名なし)"}
                        </div>
                      </div>
                    </label>
                  ))}
                  {hiddenMsgs.filter((m: any) => chatConfigs[m.id]?.roomId === selectedSender).length === 0 && (
                    <div className="text-gray-500 text-sm p-4 text-center">このチャット内に非表示のメッセージはありません</div>
                  )}
                </div>
              )}
            </div>
            <div className="p-4 border-t border-[#1E1F22] flex justify-end gap-3">
              <button onClick={() => safeBack()} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
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
              <button onClick={() => safeBack()} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
              <button onClick={executeConfirmedAction} disabled={!resetOptions.pin && !resetOptions.hide && !resetOptions.name} className="px-4 py-2 bg-[#DA373C] text-white rounded text-sm font-bold hover:bg-[#a1282c] disabled:bg-[#3f4147] disabled:text-gray-500">リセットする</button>
            </div>
          </div>
        )}

        {modal.type === "select_move_dest" && (
          <div className="p-5">
            <h2 className="text-lg font-bold text-white mb-4">移動先の選択</h2>
            <div className="flex flex-col gap-2 mb-4">
              {/* ★追加: アーカイブ移動の選択肢 */}
              {["INBOX", "ARCHIVE", "SPAM", "TRASH"].map(dest => {
                const labels: Record<string, string> = { "INBOX": "受信箱", "ARCHIVE": "アーカイブ", "SPAM": "迷惑メール", "TRASH": "ゴミ箱" };
                return (
                  <button 
                    key={dest} 
                    onClick={() => { 
                      setMoveDestination(dest as any); 
                      setSelectionMode((modal.targetMode + "_move") as SelectionMode); 
                      setModal(null); 
                      window.history.replaceState({ action: "select" }, "", window.location.href);
                      app.refs.hasPushedSelectRef.current = true;
                    }} 
                    className="w-full py-2.5 bg-[#2B2D31] hover:bg-[#3f4147] border border-[#1E1F22] rounded text-white font-bold transition"
                  >
                    {labels[dest]}
                  </button>
                );
              })}
            </div>
            <button onClick={() => safeBack()} className="w-full py-2 hover:underline text-gray-400 text-sm">キャンセル</button>
          </div>
        )}

        {modal.type === "select_move_dest_context" && (() => {
          const targetEmails = getActionableEmails(modal.targets, modal.targetMode);
          
          return (
            <div className="p-5">
              <h2 className="text-lg font-bold text-white mb-4">移動先の選択</h2>
              <div className="flex flex-col gap-2 mb-4">
                {["INBOX", "ARCHIVE", "SPAM", "TRASH"].map(dest => {
                  // ★修正: 以前の if (isMySentMail && ...) のブロックを削除。
                  // 送信済みメールが含まれていても、他の受信メールを移動できるようにするため。

                  // ★修正: 「すべてが移動先に存在するか」の判定から送信済み(SENT)を除外して計算する
                  const isAllInDest = modal.targetMode === "chat" 
                    ? modal.targets.length > 0 && modal.targets.every((tId: string) => {
                        const kb = app.state.knownBoxes?.[tId] || [];
                        const validKb = kb.filter((b: string) => b !== "SENT"); // 送信済みを無視
                        if (validKb.length === 0) return false;
                        if (dest === "ARCHIVE") return validKb.every((b: string) => b === "ARCHIVE");
                        return validKb.every((b: string) => b === dest);
                      })
                    : targetEmails.length > 0 && targetEmails.every((e: any) => {
                        if (e.labelIds?.includes("SENT") || e.isMe) return true; // 送信済みは「すでに移動済み」扱いで無視させる
                        if (dest === "ARCHIVE") return !e.labelIds?.includes("INBOX") && !e.labelIds?.includes("TRASH") && !e.labelIds?.includes("SPAM");
                        return e.labelIds?.includes(dest);
                      });

                  const labels: Record<string, string> = { "INBOX": "受信箱", "ARCHIVE": "アーカイブ", "SPAM": "迷惑メール", "TRASH": "ゴミ箱" };
                  return (
                    <button 
                      key={dest} 
                      disabled={isAllInDest}
                      onClick={() => { setMoveDestination(dest as any); setModal({ type: "confirm_move", targetMode: modal.targetMode, targets: modal.targets }); }} 
                      className={`w-full py-2.5 border rounded font-bold transition flex justify-between px-4 ${isAllInDest ? 'bg-[#1E1F22] text-gray-600 border-[#1E1F22] cursor-not-allowed' : 'bg-[#2B2D31] hover:bg-[#3f4147] border-[#1E1F22] text-white'}`}
                    >
                      <span>{labels[dest]}</span>
                      <span className="text-xs font-normal opacity-70 mt-0.5">{isAllInDest ? "(既に存在します)" : `選択`}</span>
                    </button>
                  );
                })}
              </div>
              <button onClick={() => safeBack()} className="w-full py-2 hover:underline text-gray-400 text-sm">キャンセル</button>
            </div>
          );
        })()}

        {modal.type === "confirm_move" && (() => {
          const targetEmails = getActionableEmails(modal.targets, modal.targetMode);
          const inboxCount = targetEmails.filter(e => e.labelIds?.includes("INBOX")).length;
          const spamCount = targetEmails.filter(e => e.labelIds?.includes("SPAM")).length;
          const trashCount = targetEmails.filter(e => e.labelIds?.includes("TRASH")).length;
          // ★追加・修正: 送信済みのカウントと、アーカイブからの除外
          const mySentCount = targetEmails.filter(e => e.labelIds?.includes("SENT") || e.isMe).length;
          const archiveCount = targetEmails.filter(e => !e.labelIds?.includes("INBOX") && !e.labelIds?.includes("TRASH") && !e.labelIds?.includes("SPAM") && !e.labelIds?.includes("SENT") && !e.isMe).length;
          
          const destName = moveDestination === "INBOX" ? "受信箱" : moveDestination === "ARCHIVE" ? "アーカイブ" : moveDestination === "SPAM" ? "迷惑メール" : "ゴミ箱";

          return (
            <div className="p-5">
              <h2 className="text-lg font-bold text-white mb-2">移動の確認</h2>
              <p className="text-sm text-gray-300 mb-4 leading-relaxed">
                選択したアイテムを「{destName}」へ移動します。(対象: 合計 {targetEmails.length} 件)
              </p>
              
              {/* ★修正: どの箱への移動であっても、送信済みメールが含まれていれば除外の案内文を出す */}
              {mySentCount > 0 && (
                <div className="bg-[#5865F2]/20 border border-[#5865F2] p-3 rounded text-xs text-gray-200 mb-4 leading-relaxed font-bold">
                  ℹ️ 選択されたアイテムに送信済みメールが {mySentCount} 件含まれています。送信済みメールは移動の対象外となるため、これらを除外して移動を実行します。
                </div>
              )}
              
              <div className="bg-[#2B2D31] p-3 rounded border border-[#1E1F22] mb-5 space-y-2 text-[13px] text-gray-300">
                <div className="font-bold text-gray-400 border-b border-[#1E1F22] pb-1 mb-1 text-xs">【移動元の内訳 (送信済みを除く)】</div>
                <div className="flex justify-between items-center px-1"><span>受信箱:</span> <span>{inboxCount} 件</span></div>
                <div className="flex justify-between items-center px-1"><span>アーカイブ:</span> <span>{archiveCount} 件</span></div>
                <div className="flex justify-between items-center px-1"><span>迷惑メール:</span> <span>{spamCount} 件</span></div>
                <div className="flex justify-between items-center px-1"><span>ゴミ箱:</span> <span>{trashCount} 件</span></div>
              </div>
              <div className="flex justify-end gap-3">
                <button onClick={() => safeBack()} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
                <button onClick={executeConfirmedAction} className="px-4 py-2 bg-[#5865F2] text-white rounded text-sm font-bold hover:bg-[#4752C4]">移動する</button>
              </div>
            </div>
          );
        })()}

      </div>
    </div>
  );
}