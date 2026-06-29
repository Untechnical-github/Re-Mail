import { useState } from "react";
import { SelectionMode } from "../types/mail";

// 選択アイテムを場所ごとに振り分けて確認させる中間モーダル
function CategorizedActionSelect({ app, modal }: { app: any; modal: NonNullable<any> }) {
  const action = modal.action as "pin" | "hide" | "delete" | "move";
  const targetMode = modal.targetMode as "chat" | "msg";
  const targets = modal.targets as string[];

  const { knownBoxes, chatConfigs } = app.state;
  const { groupedEmails, allUniqueEmails } = app.computed;
  const { setModal, setMoveDestination, setSelectedIds, safeBack } = app.actions;

  const BOX_LABELS: Record<string, string> = {
    INBOX: "受信箱", ARCHIVE: "アーカイブ", SENT: "送信済み", SPAM: "迷惑メール", TRASH: "ゴミ箱"
  };
  const BOX_ORDER = ["INBOX", "ARCHIVE", "SENT", "SPAM", "TRASH"];

  // アクションごとの制限判定（ゴミ箱/迷惑メール=ピン留め・非表示不可、送信済み=移動不可、ゴミ箱/送信済み=削除不可）
  const isItemRestricted = (id: string): boolean => {
    if (targetMode === "chat") {
      const kb: string[] = knownBoxes?.[id] || [];
      if (action === "pin" || action === "hide")
        return kb.length > 0 && kb.every((b: string) => b === "TRASH" || b === "SPAM");
      if (action === "delete")
        return kb.length > 0 && kb.every((b: string) => b === "TRASH" || b === "SENT");
      if (action === "move")
        return kb.includes("SENT") && kb.length === 1;
    } else {
      const msg = allUniqueEmails.find((e: any) => e.id === id);
      if (!msg) return true;
      const isTrash = msg.labelIds?.includes("TRASH");
      const isSpam = msg.labelIds?.includes("SPAM");
      const isSent = msg.labelIds?.includes("SENT") || msg.isMe;
      if (action === "pin" || action === "hide") return isTrash || isSpam;
      if (action === "delete") return isTrash || isSent;
      if (action === "move") return isSent;
    }
    return false;
  };

  // チェック状態: 制限のないアイテムのみ初期チェック
  const [checkedIds, setCheckedIds] = useState<string[]>(() =>
    targets.filter(id => !isItemRestricted(id))
  );
  const [localDest, setLocalDest] = useState<string | null>(null);

  const toggleCheck = (id: string) => {
    if (isItemRestricted(id)) return;
    setCheckedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const canProceed = checkedIds.length > 0 && (action !== "move" || !!localDest);

  const handleNext = () => {
    if (!canProceed) return;
    setSelectedIds(checkedIds);
    if (action === "move") {
      setMoveDestination(localDest as any);
      setModal({ type: "confirm_move", targetMode, targets: checkedIds });
    } else if (action === "pin") {
      setModal({ type: "select_pin_type", targetMode, targets: checkedIds } as any);
    } else if (action === "hide") {
      setModal({ type: "confirm_hide", targetMode, targets: checkedIds });
    } else if (action === "delete") {
      setModal({ type: "confirm_delete", targetMode, targets: checkedIds });
    }
  };

  const actionTitle: Record<string, string> = {
    pin: "ピン留めするアイテムを選択",
    hide: "非表示にするアイテムを選択",
    delete: "削除するアイテムを選択",
    move: "移動するアイテムを選択",
  };
  const restrictionNote: Record<string, string> = {
    pin: "迷惑メール・ゴミ箱のアイテムは対象外（自動的に外れます）",
    hide: "迷惑メール・ゴミ箱のアイテムは対象外（自動的に外れます）",
    delete: "送信済み・ゴミ箱のアイテムは対象外（自動的に外れます）",
    move: "送信済みメールは移動の対象外（自動的に外れます）",
  };

  // ---- チャットモード: チャット単位で一覧表示 ----
  if (targetMode === "chat") {
    return (
      <div className="flex flex-col max-h-[80vh]">
        <div className="p-4 border-b border-[#1E1F22]">
          <h2 className="text-lg font-bold text-white">{actionTitle[action]}</h2>
          <p className="text-xs text-gray-400 mt-1">{restrictionNote[action]}</p>
        </div>

        {action === "move" && (
          <div className="p-3 border-b border-[#1E1F22]">
            <div className="text-xs font-bold text-gray-400 mb-2">移動先を選択</div>
            <div className="flex flex-wrap gap-2">
              {["INBOX", "ARCHIVE", "SPAM", "TRASH"].map(dest => (
                <button
                  key={dest}
                  onClick={() => setLocalDest(dest)}
                  className={`px-3 py-1.5 rounded text-xs font-bold border transition
                    ${localDest === dest
                      ? "bg-[#5865F2] border-[#5865F2] text-white"
                      : "bg-[#1E1F22] border-[#35373C] text-gray-400 hover:border-[#5865F2] hover:text-white"
                    }`}
                >
                  {BOX_LABELS[dest]}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="overflow-y-auto flex-1 p-2 space-y-1">
          {/* 場所ごとにグループ表示 */}
          {BOX_ORDER.filter(box => targets.some(id => {
            const kb: string[] = knownBoxes?.[id] || [];
            return box === "SENT" ? kb.includes("SENT") :
              box === "INBOX" ? kb.includes("INBOX") :
              box === "ARCHIVE" ? kb.includes("ARCHIVE") :
              box === "SPAM" ? kb.includes("SPAM") :
              box === "TRASH" ? kb.includes("TRASH") : false;
          })).map(box => {
            const boxTargets = targets.filter(id => {
              const kb: string[] = knownBoxes?.[id] || [];
              return kb.includes(box);
            });
            if (boxTargets.length === 0) return null;

            const isBoxRestricted = (() => {
              if (action === "pin" || action === "hide") return box === "TRASH" || box === "SPAM";
              if (action === "delete") return box === "TRASH" || box === "SENT";
              if (action === "move") return box === "SENT";
              return false;
            })();

            return (
              <div key={box} className="mb-2">
                <div className={`flex items-center gap-2 px-2 py-1 text-xs font-bold ${isBoxRestricted ? "text-gray-600" : "text-gray-400"}`}>
                  {BOX_LABELS[box]} ({boxTargets.length}件){isBoxRestricted && <span className="text-gray-700">— 対象外</span>}
                </div>
                {boxTargets.map(id => {
                  const restricted = isItemRestricted(id);
                  const checked = checkedIds.includes(id);
                  const kb: string[] = knownBoxes?.[id] || [];
                  const allBoxes = kb.map((b: string) => BOX_LABELS[b] || b).join("・");
                  return (
                    <label
                      key={id}
                      className={`flex items-center gap-3 px-3 py-2 rounded transition
                        ${restricted ? "opacity-40 cursor-not-allowed" : "hover:bg-[#2B2D31] cursor-pointer"}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={restricted}
                        onChange={() => toggleCheck(id)}
                        className="accent-[#5865F2] flex-shrink-0"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm truncate text-gray-200">{chatConfigs[id]?.customName || id}</div>
                        {allBoxes && <div className="text-xs text-gray-500">{allBoxes}</div>}
                      </div>
                      {restricted && <span className="text-xs text-gray-600 flex-shrink-0">対象外</span>}
                    </label>
                  );
                })}
              </div>
            );
          })}

          {/* knownBoxes に情報がないチャットのフォールバック */}
          {targets.filter(id => {
            const kb: string[] = knownBoxes?.[id] || [];
            return kb.length === 0;
          }).length > 0 && (
            <div className="mb-2">
              <div className="px-2 py-1 text-xs font-bold text-gray-400">その他</div>
              {targets.filter(id => (knownBoxes?.[id] || []).length === 0).map(id => {
                const restricted = isItemRestricted(id);
                const checked = checkedIds.includes(id);
                return (
                  <label
                    key={id}
                    className={`flex items-center gap-3 px-3 py-2 rounded transition
                      ${restricted ? "opacity-40 cursor-not-allowed" : "hover:bg-[#2B2D31] cursor-pointer"}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={restricted}
                      onChange={() => toggleCheck(id)}
                      className="accent-[#5865F2] flex-shrink-0"
                    />
                    <span className="text-sm truncate text-gray-200 flex-1">{chatConfigs[id]?.customName || id}</span>
                  </label>
                );
              })}
            </div>
          )}
        </div>

        <div className="p-4 border-t border-[#1E1F22] flex justify-end gap-3">
          <button onClick={() => safeBack()} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
          <button
            onClick={handleNext}
            disabled={!canProceed}
            className="px-4 py-2 bg-[#5865F2] text-white rounded text-sm font-bold hover:bg-[#4752C4] disabled:bg-[#3f4147] disabled:text-gray-500 transition"
          >
            次へ ({checkedIds.length})
          </button>
        </div>
      </div>
    );
  }

  // ---- メッセージモード: メールを場所ごとにグループ化 ----
  const getBox = (msg: any): string => {
    if (msg.labelIds?.includes("TRASH")) return "TRASH";
    if (msg.labelIds?.includes("SPAM")) return "SPAM";
    if (msg.labelIds?.includes("SENT") || msg.isMe) return "SENT";
    if (msg.labelIds?.includes("INBOX")) return "INBOX";
    return "ARCHIVE";
  };

  const grouped: Record<string, any[]> = {};
  targets.forEach(id => {
    const msg = allUniqueEmails.find((e: any) => e.id === id);
    if (!msg) return;
    const box = getBox(msg);
    if (!grouped[box]) grouped[box] = [];
    grouped[box].push(msg);
  });

  return (
    <div className="flex flex-col max-h-[80vh]">
      <div className="p-4 border-b border-[#1E1F22]">
        <h2 className="text-lg font-bold text-white">{actionTitle[action]}</h2>
        <p className="text-xs text-gray-400 mt-1">{restrictionNote[action]}</p>
      </div>

      {action === "move" && (
        <div className="p-3 border-b border-[#1E1F22]">
          <div className="text-xs font-bold text-gray-400 mb-2">移動先を選択</div>
          <div className="flex flex-wrap gap-2">
            {["INBOX", "ARCHIVE", "SPAM", "TRASH"].map(dest => (
              <button
                key={dest}
                onClick={() => setLocalDest(dest)}
                className={`px-3 py-1.5 rounded text-xs font-bold border transition
                  ${localDest === dest
                    ? "bg-[#5865F2] border-[#5865F2] text-white"
                    : "bg-[#1E1F22] border-[#35373C] text-gray-400 hover:border-[#5865F2] hover:text-white"
                  }`}
              >
                {BOX_LABELS[dest]}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="overflow-y-auto flex-1 p-2">
        {BOX_ORDER.filter(box => grouped[box]?.length > 0).map(box => {
          const msgs = grouped[box];
          const isBoxRestricted = (() => {
            if (action === "pin" || action === "hide") return box === "TRASH" || box === "SPAM";
            if (action === "delete") return box === "TRASH" || box === "SENT";
            if (action === "move") return box === "SENT";
            return false;
          })();

          return (
            <div key={box} className="mb-3">
              <div className={`flex items-center gap-2 px-2 py-1 text-xs font-bold ${isBoxRestricted ? "text-gray-600" : "text-gray-400"}`}>
                {BOX_LABELS[box]} ({msgs.length}件){isBoxRestricted && <span className="text-gray-700">— 対象外</span>}
              </div>
              {msgs.map((msg: any) => {
                const restricted = isBoxRestricted;
                const checked = checkedIds.includes(msg.id);
                return (
                  <label
                    key={msg.id}
                    className={`flex items-center gap-3 px-3 py-2 rounded transition
                      ${restricted ? "opacity-40 cursor-not-allowed" : "hover:bg-[#2B2D31] cursor-pointer"}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={restricted}
                      onChange={() => toggleCheck(msg.id)}
                      className="accent-[#5865F2] flex-shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm truncate text-gray-200">{msg.subject || "(件名なし)"}</div>
                      <div className="text-xs text-gray-500">{new Date(msg.date).toLocaleDateString("ja-JP")}</div>
                    </div>
                    {restricted && <span className="text-xs text-gray-600 flex-shrink-0">対象外</span>}
                  </label>
                );
              })}
            </div>
          );
        })}
      </div>

      <div className="p-4 border-t border-[#1E1F22] flex justify-end gap-3">
        <button onClick={() => safeBack()} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
        <button
          onClick={handleNext}
          disabled={!canProceed}
          className="px-4 py-2 bg-[#5865F2] text-white rounded text-sm font-bold hover:bg-[#4752C4] disabled:bg-[#3f4147] disabled:text-gray-500 transition"
        >
          次へ ({checkedIds.length})
        </button>
      </div>
    </div>
  );
}

export function Modals({ app }: { app: any }) {
  // ★修正: state から knownBoxes を受け取る
  const { modal, renameInput, moveDestination, resetOptions, chatConfigs, selectedIds, selectedSender, pinType, checkTrash, checkSpam, checkInbox, checkArchive, checkSent, revealedCrossPrompts, knownBoxes } = app.state;
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
          const isSent = e.labelIds?.includes("SENT") || e.isMe; // ★追加
          const isArchive = !isTrash && !isSpam && !isInbox && !isSent; // ★修正
          
          // ★修正: checkSent の判定を追加
          const isCurrentBox = (isTrash && checkTrash) || (isSpam && checkSpam) || (isInbox && checkInbox) || (isSent && checkSent) || (isArchive && checkArchive);
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

        {modal.type === "categorized_action_select" && (
          <CategorizedActionSelect app={app} modal={modal} />
        )}

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
                <span className="text-xs text-gray-400">※受信箱、アーカイブ、送信済みのメールが対象となります。</span>
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
          
          // ★修正: 対象となるのは「送信済みでもゴミ箱でもない」メールのみ
          const liveEmails = targetEmails.filter(e => !e.labelIds?.includes("SENT") && !e.isMe && !e.labelIds?.includes("TRASH"));
          
          const inboxCount = liveEmails.filter(e => e.labelIds?.includes("INBOX")).length;
          const spamCount = liveEmails.filter(e => e.labelIds?.includes("SPAM")).length;
          const archiveCount = liveEmails.filter(e => !e.labelIds?.includes("INBOX") && !e.labelIds?.includes("SPAM")).length;
          
          const toTrashCount = inboxCount + archiveCount + spamCount;
          
          return (
            <div className="p-5">
              <h2 className="text-lg font-bold text-white mb-2">削除の確認</h2>
              <p className="text-sm text-gray-300 mb-4 leading-relaxed">
                選択したアイテムを削除します。(対象: 合計 {liveEmails.length} 件)
              </p>
              <div className="bg-[#2B2D31] p-3 rounded border border-[#1E1F22] mb-5 space-y-2 text-[13px] text-gray-300">
                <div className="font-bold text-gray-400 border-b border-[#1E1F22] pb-1 mb-2 text-xs">【処理の内訳】</div>
                {toTrashCount > 0 ? (
                  <div>
                    ・受信箱: {inboxCount}件 / アーカイブ: {archiveCount}件 / 迷惑: {spamCount}件 <br/>
                    <span className="text-[#FEE75C] ml-3">→ ゴミ箱へ移動します。</span>
                  </div>
                ) : (
                  <div className="text-gray-500">削除可能なアイテムがありません。</div>
                )}
              </div>
              <div className="flex justify-end gap-3">
                <button onClick={() => safeBack()} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
                <button onClick={executeConfirmedAction} disabled={toTrashCount === 0} className="px-4 py-2 bg-[#DA373C] text-white rounded text-sm font-bold hover:bg-[#a1282c] disabled:bg-[#3f4147] disabled:text-gray-500">削除する</button>
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
                <span className="text-[#5865F2] font-bold">（対象となる受信箱・アーカイブ・送信済みのメール: {hideableCount}件）</span>
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