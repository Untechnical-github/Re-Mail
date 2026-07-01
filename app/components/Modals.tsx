import { useState } from "react";
import { BodyWithLinks } from "./ui";

// 選択アイテムを場所別チェックボックス（件数表示）で確認させる中間モーダル
function CategorizedActionSelect({ app, modal }: { app: any; modal: NonNullable<any> }) {
  const action = modal.action as "pin" | "hide" | "delete" | "move";
  const targetMode = modal.targetMode as "chat" | "msg";
  const targets = modal.targets as string[];

  const { groupedEmails, allUniqueEmails } = app.computed;
  const { setModal, setSelectedIds, safeBack, executeBatchMove } = app.actions;
  const { revealedCrossPrompts, checkInbox, checkArchive, checkSpam, checkTrash, checkSent } = app.state;

  const BOX_LABELS: Record<string, string> = {
    INBOX: "受信箱", ARCHIVE: "アーカイブ", SENT: "送信済み", SPAM: "迷惑メール", TRASH: "ゴミ箱"
  };
  const MOVE_DEST_BOXES = ["INBOX", "ARCHIVE", "SPAM", "TRASH"];
  const BOX_ORDER = ["INBOX", "ARCHIVE", "SENT", "SPAM", "TRASH"];

  const isBoxRestricted = (box: string): boolean => {
    if (action === "pin" || action === "hide") return box === "TRASH" || box === "SPAM" || box === "SENT";
    if (action === "delete") return box === "TRASH" || box === "SENT";
    if (action === "move") return box === "SENT";
    return false;
  };

  // 送信済みメールは場所に関係なくSENTとして分類（D1と同じ優先度）
  const getEmailBox = (email: any): string => {
    if (email.labelIds?.includes("SENT") || email.isMe) return "SENT";
    if (email.labelIds?.includes("TRASH")) return "TRASH";
    if (email.labelIds?.includes("SPAM")) return "SPAM";
    if (email.labelIds?.includes("INBOX")) return "INBOX";
    return "ARCHIVE";
  };

  // ボタン状態（未読み込み）の他の場所のメールを除外: 現在のフィルターに合うか明示的に読み込んだものだけ対象
  const isRevealedEmail = (email: any): boolean => {
    const box = getEmailBox(email);
    const isCurrentBox =
      box === "SENT" ? checkSent :
      box === "TRASH" ? checkTrash :
      box === "SPAM" ? checkSpam :
      box === "INBOX" ? checkInbox : checkArchive;
    return isCurrentBox || (revealedCrossPrompts as string[]).includes(email.id);
  };

  // 場所ごとの件数と対象IDを計算
  const boxCounts: Record<string, number> = {};
  const boxChatIds: Record<string, string[]> = {};
  const boxMsgIds: Record<string, string[]> = {};

  if (targetMode === "chat") {
    targets.forEach(chatId => {
      const emails = groupedEmails[chatId] || [];
      const seen = new Set<string>();
      emails.filter(isRevealedEmail).forEach((email: any) => {
        const box = getEmailBox(email);
        if (!boxCounts[box]) { boxCounts[box] = 0; boxChatIds[box] = []; }
        boxCounts[box]++;
        if (!seen.has(box)) { seen.add(box); boxChatIds[box].push(chatId); }
      });
    });
  } else {
    targets.forEach(msgId => {
      const msg = allUniqueEmails.find((e: any) => e.id === msgId);
      if (!msg) return;
      const box = getEmailBox(msg);
      if (!boxCounts[box]) { boxCounts[box] = 0; boxMsgIds[box] = []; }
      boxCounts[box]++;
      boxMsgIds[box].push(msgId);
    });
  }

  const availableBoxes = BOX_ORDER.filter(b => (boxCounts[b] || 0) > 0);

  const [checkedBoxes, setCheckedBoxes] = useState<string[]>(() =>
    availableBoxes.filter(b => !isBoxRestricted(b))
  );
  // 移動アクション用: 場所ごとの移動先（key=source box, value=destination box）
  const [boxDestinations, setBoxDestinations] = useState<Record<string, string>>({});

  const toggleBox = (box: string) => {
    if (isBoxRestricted(box)) return;
    setCheckedBoxes(prev => prev.includes(box) ? prev.filter(b => b !== box) : [...prev, box]);
  };

  const setBoxDest = (box: string, dest: string) => {
    setBoxDestinations(prev => ({ ...prev, [box]: dest }));
  };

  const getFilteredTargets = (): string[] => {
    if (targetMode === "chat") {
      const chatSet = new Set<string>();
      checkedBoxes.forEach(box => (boxChatIds[box] || []).forEach(id => chatSet.add(id)));
      return Array.from(chatSet);
    } else {
      const ids: string[] = [];
      checkedBoxes.forEach(box => ids.push(...(boxMsgIds[box] || [])));
      return ids;
    }
  };

  const totalCheckedCount = checkedBoxes.reduce((sum, b) => sum + (boxCounts[b] || 0), 0);
  const moveReady = action !== "move" || checkedBoxes.filter(b => !isBoxRestricted(b)).every(b => !!boxDestinations[b]);
  const canProceed = totalCheckedCount > 0 && moveReady;

  const handleNext = () => {
    if (!canProceed) return;
    const filteredTargets = getFilteredTargets();
    setSelectedIds(filteredTargets);

    if (action === "move") {
      // 場所別移動先でグループ化し、直接実行
      const destGroups: Record<string, string[]> = {};
      checkedBoxes.forEach(box => {
        const dest = boxDestinations[box];
        if (!dest) return;
        if (!destGroups[dest]) destGroups[dest] = [];
        if (targetMode === "msg") {
          destGroups[dest].push(...(boxMsgIds[box] || []));
        } else {
          (boxChatIds[box] || []).forEach((chatId: string) => {
            const emails = groupedEmails[chatId] || [];
            emails.filter((e: any) => getEmailBox(e) === box && isRevealedEmail(e)).forEach((e: any) => {
              destGroups[dest].push(e.id);
            });
          });
        }
      });
      const groups = Object.entries(destGroups).map(([destination, ids]) => ({ ids, destination }));
      executeBatchMove(groups);
      return;
    }

    if (action === "pin") {
      setModal({ type: "select_pin_type", targetMode, targets: filteredTargets } as any);
    } else if (action === "hide") {
      setModal({ type: "confirm_hide", targetMode, targets: filteredTargets });
    } else if (action === "delete") {
      setModal({ type: "confirm_delete", targetMode, targets: filteredTargets });
    }
  };

  const actionTitle: Record<string, string> = {
    pin: "ピン留めするメールを選択",
    hide: "非表示にするメールを選択",
    delete: "削除するメールを選択",
    move: "移動するメールを選択",
  };

  return (
    <div className="flex flex-col max-h-[80vh]">
      <div className="p-4 border-b border-[#1E1F22]">
        <h2 className="text-lg font-bold text-white">{actionTitle[action]}</h2>
        <p className="text-xs text-gray-400 mt-1">
          {targetMode === "chat" ? "選択チャット内の読み込み済みメール" : "選択メッセージ"}を場所ごとに表示しています
        </p>
      </div>

      <div className="overflow-y-auto flex-1 p-3 space-y-2">
        {availableBoxes.map(box => {
          const restricted = isBoxRestricted(box);
          const checked = checkedBoxes.includes(box);
          const count = boxCounts[box] || 0;
          const selectedDest = boxDestinations[box];
          return (
            <div
              key={box}
              className={`rounded transition border
                ${restricted
                  ? "opacity-40 border-transparent bg-[#1E1F22]"
                  : checked
                    ? "border-[#5865F2] bg-[#5865F2]/10"
                    : "border-[#35373C] bg-[#1E1F22]"
                }`}
            >
              <label className={`flex items-center justify-between gap-3 p-3 ${restricted ? "cursor-not-allowed" : "cursor-pointer"}`}>
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={restricted}
                    onChange={() => toggleBox(box)}
                    className="accent-[#5865F2] w-4 h-4 flex-shrink-0"
                  />
                  <span className={`text-sm font-bold ${restricted ? "text-gray-600" : "text-gray-200"}`}>
                    {BOX_LABELS[box]}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-sm font-bold ${restricted ? "text-gray-600" : "text-[#5865F2]"}`}>
                    {count}件
                  </span>
                  {restricted && <span className="text-xs text-gray-600">対象外</span>}
                </div>
              </label>

              {/* 移動アクションでチェック済みの場合: 移動先ボタンを表示 */}
              {action === "move" && checked && !restricted && (
                <div className="px-3 pb-3 flex flex-wrap gap-1.5">
                  <span className="text-xs text-gray-500 w-full mb-0.5">移動先:</span>
                  {MOVE_DEST_BOXES.map(dest => {
                    const isSame = dest === box;
                    const isSelected = selectedDest === dest;
                    return (
                      <button
                        key={dest}
                        disabled={isSame}
                        onClick={() => setBoxDest(box, dest)}
                        className={`px-2.5 py-1 rounded text-xs font-bold border transition
                          ${isSame
                            ? "bg-[#1E1F22] border-[#1E1F22] text-gray-600 cursor-not-allowed"
                            : isSelected
                              ? "bg-[#5865F2] border-[#5865F2] text-white"
                              : "bg-[#2B2D31] border-[#35373C] text-gray-400 hover:border-[#5865F2] hover:text-white"
                          }`}
                      >
                        {BOX_LABELS[dest]}
                      </button>
                    );
                  })}
                  {!selectedDest && (
                    <span className="text-xs text-yellow-500/80 w-full mt-0.5">移動先を選んでください</span>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {availableBoxes.length === 0 && (
          <div className="text-gray-500 text-sm text-center py-4">読み込まれたメールがありません</div>
        )}
      </div>

      <div className="p-4 border-t border-[#1E1F22] flex justify-end gap-3">
        <button onClick={() => safeBack()} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
        <button
          onClick={handleNext}
          disabled={!canProceed}
          className="px-4 py-2 bg-[#5865F2] text-white rounded text-sm font-bold hover:bg-[#4752C4] disabled:bg-[#3f4147] disabled:text-gray-500 transition"
        >
          {action === "move" ? `実行 (${totalCheckedCount}件)` : `次へ (${totalCheckedCount}件)`}
        </button>
      </div>
    </div>
  );
}

function ChatHideConfirm({ app, modal }: { app: any; modal: NonNullable<any> }) {
  const [unhideOnNew, setUnhideOnNew] = useState(false);
  const { safeBack, exitAfterAction, updateChatConfig, setSelectedSender } = app.actions;
  const { selectedSender } = app.state;

  const handleExecute = () => {
    modal.targets.forEach((target: string) => {
      updateChatConfig(target, { isHidden: true, hiddenAtDate: new Date().toISOString(), unhideOnNew });
    });
    if (modal.targets.includes(selectedSender)) setSelectedSender(null);
    exitAfterAction();
  };

  return (
    <div className="p-5">
      <h2 className="text-lg font-bold text-white mb-2">非表示(Re:Mailのみ)</h2>
      <p className="text-sm text-gray-300 mb-4 leading-relaxed">
        選択した{modal.targets.length}件のチャットをRe:Mailの画面上から隠します。
      </p>
      <label className="flex items-center gap-3 cursor-pointer hover:bg-[#2B2D31] p-2 rounded transition mb-6 text-sm text-gray-200">
        <input
          type="checkbox"
          checked={unhideOnNew}
          onChange={(e) => setUnhideOnNew(e.target.checked)}
          className="accent-[#5865F2] w-4 h-4"
        />
        新着メッセージがあった際に自動で非表示を解除する
      </label>
      <div className="flex justify-end gap-3">
        <button onClick={() => safeBack()} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
        <button onClick={handleExecute} className="px-4 py-2 bg-[#5865F2] text-white rounded text-sm font-bold hover:bg-[#4752C4]">非表示にする</button>
      </div>
    </div>
  );
}

function prepareHtml(raw: string): string {
  const inject =
    '<base target="_blank">' +
    '<style>*{box-sizing:border-box;max-width:100%!important;}img{height:auto;}body{margin:0;padding:16px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;word-break:break-word;}</style>';
  if (/<head[\s>]/i.test(raw)) {
    return raw.replace(/(<head[^>]*>)/i, `$1${inject}`);
  }
  return `<!DOCTYPE html><html><head>${inject}</head><body>${raw}</body></html>`;
}


export function EmailModal({ app }: { app: any }) {
  const { emailModal } = app.state;
  const { closeEmailModal } = app.actions;

  if (!emailModal) return null;

  const { email, htmlBody, isLoading } = emailModal;
  const showHtml = !isLoading && !!htmlBody;
  const showText = !isLoading && !htmlBody;

  return (
    <div
      className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-2 sm:p-4"
      onClick={closeEmailModal}
    >
      <div
        className="bg-[#2B2D31] rounded-lg shadow-2xl w-full max-w-3xl flex flex-col border border-[#1E1F22]"
        style={{ height: "92dvh" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ヘッダー */}
        <div className="flex items-start gap-3 p-4 border-b border-[#1E1F22] flex-shrink-0">
          <div className="flex-1 min-w-0">
            <div className="font-bold text-white text-sm leading-snug break-words">
              {email.subject || "(件名なし)"}
            </div>
            <div className="text-[11px] text-gray-400 mt-1 truncate">{email.from}</div>
            <div className="text-[11px] text-gray-500">
              {new Date(email.date).toLocaleString("ja-JP")}
            </div>
          </div>
          <button
            onClick={closeEmailModal}
            className="text-gray-400 hover:text-white text-xl font-bold flex-shrink-0 leading-none"
          >
            ×
          </button>
        </div>

        {/* コンテンツ - 両モードとも h-full で同一高さ */}
        <div className="flex-1 min-h-0">
          {isLoading && (
            <div className="flex items-center justify-center h-full text-gray-400 text-sm">
              読み込み中...
            </div>
          )}
          {showHtml && (
            <iframe
              srcDoc={prepareHtml(htmlBody!)}
              sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin"
              className="w-full h-full border-none block bg-white"
              title="メール本文"
            />
          )}
          {showText && (
            <div className="overflow-y-auto h-full p-4">
              <pre className="text-gray-200 text-sm whitespace-pre-wrap break-words font-sans leading-relaxed select-text">
                <BodyWithLinks text={email.body || ""} />
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function Modals({ app }: { app: any }) {
  const { modal, renameInput, moveDestination, resetOptions, chatConfigs, selectedIds, selectedSender, checkTrash, checkSpam, checkInbox, checkArchive, checkSent, revealedCrossPrompts } = app.state;
  const { setModal, executeConfirmedAction, executePin, setRenameInput, setMoveDestination, setSelectionMode, setSelectedIds, setResetOptions, updateChatConfig, safeBack } = app.actions;
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

        {modal.type === "confirm_pin" && (() => {
          const isChatMode = modal.targetMode === "chat";
          const existingForcePinnedChats = Object.keys(chatConfigs).filter(k =>
            !chatConfigs[k]?.roomId && chatConfigs[k]?.isPinned && chatConfigs[k]?.forceFetch
          );
          const existingPinnedMsgCount = Object.keys(chatConfigs).filter(k =>
            chatConfigs[k]?.roomId && chatConfigs[k]?.isPinned && chatConfigs[k]?.forceFetch
          ).length;
          const newToPin = isChatMode
            ? modal.targets.filter((t: string) => !existingForcePinnedChats.includes(t))
            : modal.targets;
          const willExceedLimit = isChatMode
            ? existingForcePinnedChats.length + newToPin.length > 10
            : existingPinnedMsgCount + newToPin.length > 100;
          const limitText = isChatMode
            ? `現在 ${existingForcePinnedChats.length} 件 / 上限 10 件`
            : `現在 ${existingPinnedMsgCount} 件 / 上限 100 件`;

          return (
            <div className="p-5">
              <h2 className="text-lg font-bold text-white mb-2">ピン留め（永続読み込み）</h2>
              <p className="text-sm text-gray-300 mb-2 leading-relaxed">
                選択した {modal.targets.length} 件の{isChatMode ? "チャット" : "メッセージ"}を永続読み込みでピン留めします。
              </p>
              <p className="text-xs text-gray-400 mb-6">{limitText}</p>
              {willExceedLimit && (
                <p className="text-xs text-[#DA373C] mb-4">
                  上限を超えるため実行できません。既存のピン留めを解除してください。
                </p>
              )}
              <div className="flex justify-end gap-3">
                <button onClick={() => safeBack()} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
                <button
                  onClick={() => executePin()}
                  disabled={willExceedLimit}
                  className={`px-4 py-2 rounded text-sm font-bold text-white transition ${willExceedLimit ? 'bg-[#3f4147] text-gray-500 cursor-not-allowed' : 'bg-[#5865F2] hover:bg-[#4752C4]'}`}
                >
                  ピン留めする
                </button>
              </div>
            </div>
          );
        })()}

        {modal.type === "confirm_unpin" && (
          <div className="p-5">
            <h2 className="text-lg font-bold text-white mb-2">ピン留めを解除</h2>
            <p className="text-sm text-gray-300 mb-6 leading-relaxed">
              選択した {modal.targets.length} 件の{modal.targetMode === "chat" ? "チャット" : "メッセージ"}のピン留めを解除しますか？
            </p>
            <div className="flex justify-end gap-3">
              <button onClick={() => safeBack()} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
              <button onClick={executeConfirmedAction} className="px-4 py-2 bg-[#5865F2] text-white rounded text-sm font-bold hover:bg-[#4752C4]">解除する</button>
            </div>
          </div>
        )}

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
          if (modal.targetMode === "chat") {
            return <ChatHideConfirm app={app} modal={modal} />;
          }
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

        {modal.type === "rename" && (
          <div className="p-5">
            <h2 className="text-lg font-bold text-white mb-4">名前の変更</h2>
            <input
              type="text"
              value={renameInput}
              onChange={(e) => setRenameInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  updateChatConfig(modal.targets[0], { customName: renameInput.trim() || undefined });
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
                  updateChatConfig(modal.targets[0], { customName: renameInput.trim() || undefined });
                  safeBack();
                }}
                className="px-4 py-2 bg-[#5865F2] text-white rounded text-sm font-bold hover:bg-[#4752C4]"
              >
                変更する
              </button>
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
              <div className="border-t border-[#1E1F22] my-1" />
              <label className="flex items-center gap-3 cursor-pointer hover:bg-[#2B2D31] p-2 rounded transition">
                <input type="checkbox" checked={resetOptions.crossBox} onChange={(e) => setResetOptions({...resetOptions, crossBox: e.target.checked})} className="accent-[#5865F2] w-4 h-4" />
                <span>他の場所のメールの読み込みをリセット<span className="block text-xs text-gray-400">現在のフィルター対象外のメールを読み込みボタンに戻す</span></span>
              </label>
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={() => safeBack()} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
              <button onClick={executeConfirmedAction} disabled={!resetOptions.pin && !resetOptions.hide && !resetOptions.name && !resetOptions.crossBox} className="px-4 py-2 bg-[#DA373C] text-white rounded text-sm font-bold hover:bg-[#a1282c] disabled:bg-[#3f4147] disabled:text-gray-500">リセットする</button>
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

                  // 「すべてが移動先に存在するか」の判定（送信済みを除外して計算）
                  const isAllInDest = modal.targetMode === "chat"
                    ? modal.targets.length > 0 && modal.targets.every((tId: string) => {
                        const chatEmails = (groupedEmails[tId] || []).filter((e: any) => !e.labelIds?.includes("SENT") && !e.isMe);
                        if (chatEmails.length === 0) return false;
                        if (dest === "ARCHIVE") return chatEmails.every((e: any) => !e.labelIds?.includes("INBOX") && !e.labelIds?.includes("TRASH") && !e.labelIds?.includes("SPAM"));
                        return chatEmails.every((e: any) => e.labelIds?.includes(dest));
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
          const destName = moveDestination === "INBOX" ? "受信箱" : moveDestination === "ARCHIVE" ? "アーカイブ" : moveDestination === "SPAM" ? "迷惑メール" : "ゴミ箱";
          return (
            <div className="p-5">
              <h2 className="text-lg font-bold text-white mb-2">移動の確認</h2>
              <p className="text-sm text-gray-300 mb-6 leading-relaxed">
                選択したアイテム ({targetEmails.length}件) を「{destName}」へ移動します。
              </p>
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