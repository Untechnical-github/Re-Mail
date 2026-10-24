import { useState } from "react";
import type { RoomKeyStr } from "../../lib/roomKey";
import type { MailAppHook } from "../../hooks/useMailApp";
import type { Email } from "../../types/email";
import type { ModalState } from "../../types/mail";

// 選択アイテムを場所別チェックボックス（件数表示）で確認させる中間モーダル
export function CategorizedActionSelect({ app, modal }: { app: MailAppHook; modal: NonNullable<ModalState> }) {
  const action = modal.action as "pin" | "hide" | "delete" | "move";
  const targetMode = modal.targetMode as "chat" | "msg";
  const targets = modal.targets as string[];

  const { groupedEmails, allUniqueEmails } = app.computed;
  const { setModal, setSelectedIds, safeBack, executeBatchMove, roomAccountEmail } = app.actions;
  const { revealedCrossPrompts, checkInbox, checkArchive, checkSpam, checkTrash, checkSent, linkedAccounts } = app.state;
  const mainEmail: string = app.auth?.session?.user?.email || "";

  const BOX_LABELS: Record<string, string> = {
    INBOX: "受信箱", ARCHIVE: "アーカイブ", SENT: "送信済み", SPAM: "迷惑メール", TRASH: "ゴミ箱"
  };
  const MOVE_DEST_BOXES = ["INBOX", "ARCHIVE", "SPAM", "TRASH"];
  const BOX_ORDER = ["INBOX", "ARCHIVE", "SENT", "SPAM", "TRASH"];
  // アカウント×保存場所を1つのキーにまとめる（このコンポーネント内だけのローカルなUI用キーのため、
  // roomKey.tsのencodeRoomKeyとは無関係の単純な区切り文字で構わない）
  const KEY_SEP = "::";
  const boxKey = (account: string, box: string) => `${account}${KEY_SEP}${box}`;
  const boxOf = (key: string) => key.slice(key.lastIndexOf(KEY_SEP) + KEY_SEP.length);

  const isBoxRestricted = (box: string): boolean => {
    // ピン留め・非表示は送信済みメールも対象にできる（ゴミ箱・迷惑メールのみ対象外）
    if (action === "pin" || action === "hide") return box === "TRASH" || box === "SPAM";
    if (action === "delete") return box === "TRASH" || box === "SENT";
    if (action === "move") return box === "SENT";
    return false;
  };

  // 送信済みメールは場所に関係なくSENTとして分類（D1と同じ優先度）
  const getEmailBox = (email: Email): string => {
    if (email.labelIds?.includes("SENT") || email.isMe) return "SENT";
    if (email.labelIds?.includes("TRASH")) return "TRASH";
    if (email.labelIds?.includes("SPAM")) return "SPAM";
    if (email.labelIds?.includes("INBOX")) return "INBOX";
    return "ARCHIVE";
  };

  // ボタン状態（未読み込み）の他の場所のメールを除外: 現在のフィルターに合うか明示的に読み込んだものだけ対象
  const isRevealedEmail = (email: Email): boolean => {
    const box = getEmailBox(email);
    const isCurrentBox =
      box === "SENT" ? checkSent :
      box === "TRASH" ? checkTrash :
      box === "SPAM" ? checkSpam :
      box === "INBOX" ? checkInbox : checkArchive;
    return isCurrentBox || (revealedCrossPrompts as string[]).includes(email.id);
  };

  // アカウント×場所ごとの件数と対象IDを計算する（連携アカウントのチャット/メッセージが混ざっていても、
  // アカウントごとに独立して保存場所を確認・選択できるようにするため）
  const boxCounts: Record<string, number> = {};
  const boxChatIds: Record<string, string[]> = {};
  const boxMsgIds: Record<string, string[]> = {};
  const seenAccounts = new Set<string>();

  if (targetMode === "chat") {
    targets.forEach(chatId => {
      const account = roomAccountEmail(chatId) || mainEmail;
      seenAccounts.add(account);
      const emails = groupedEmails[chatId as RoomKeyStr] || [];
      const seen = new Set<string>();
      emails.filter(isRevealedEmail).forEach((email) => {
        const key = boxKey(account, getEmailBox(email));
        if (!boxCounts[key]) { boxCounts[key] = 0; boxChatIds[key] = []; }
        boxCounts[key]++;
        if (!seen.has(key)) { seen.add(key); boxChatIds[key].push(chatId); }
      });
    });
  } else {
    targets.forEach(msgId => {
      const msg = allUniqueEmails.find((e) => e.id === msgId);
      if (!msg) return;
      const account = msg.accountId || mainEmail;
      seenAccounts.add(account);
      const key = boxKey(account, getEmailBox(msg));
      if (!boxCounts[key]) { boxCounts[key] = 0; boxMsgIds[key] = []; }
      boxCounts[key]++;
      boxMsgIds[key].push(msgId);
    });
  }

  // メインアカウントを先頭に、連携アカウントは連携順で並べる（対象に含まれるものだけ）
  const accounts = [mainEmail, ...(linkedAccounts as string[])].filter(a => seenAccounts.has(a));
  const availableKeysByAccount: Record<string, string[]> = {};
  accounts.forEach(account => {
    availableKeysByAccount[account] = BOX_ORDER.filter(box => (boxCounts[boxKey(account, box)] || 0) > 0);
  });
  const allAvailableKeys = accounts.flatMap(account => availableKeysByAccount[account]!.map(box => boxKey(account, box)));

  const [checkedBoxes, setCheckedBoxes] = useState<string[]>(() =>
    allAvailableKeys.filter(key => !isBoxRestricted(boxOf(key)))
  );
  // 移動アクション用: アカウント×場所ごとの移動先（key=source、value=destination box）
  const [boxDestinations, setBoxDestinations] = useState<Record<string, string>>({});

  const toggleBox = (key: string) => {
    if (isBoxRestricted(boxOf(key))) return;
    setCheckedBoxes(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);
  };

  const setBoxDest = (key: string, dest: string) => {
    setBoxDestinations(prev => ({ ...prev, [key]: dest }));
  };

  const getFilteredTargets = (): string[] => {
    if (targetMode === "chat") {
      const chatSet = new Set<string>();
      checkedBoxes.forEach(key => (boxChatIds[key] || []).forEach(id => chatSet.add(id)));
      return Array.from(chatSet);
    } else {
      const ids: string[] = [];
      checkedBoxes.forEach(key => ids.push(...(boxMsgIds[key] || [])));
      return ids;
    }
  };

  const totalCheckedCount = checkedBoxes.reduce((sum, key) => sum + (boxCounts[key] || 0), 0);
  const moveReady = action !== "move" || checkedBoxes.filter(key => !isBoxRestricted(boxOf(key))).every(key => !!boxDestinations[key]);
  const canProceed = totalCheckedCount > 0 && moveReady;

  const handleNext = () => {
    if (!canProceed) return;
    const filteredTargets = getFilteredTargets();
    setSelectedIds(filteredTargets);

    if (action === "move") {
      // 場所別移動先でグループ化し、直接実行
      const destGroups: Record<string, string[]> = {};
      checkedBoxes.forEach(key => {
        const dest = boxDestinations[key];
        if (!dest) return;
        if (!destGroups[dest]) destGroups[dest] = [];
        const box = boxOf(key);
        if (targetMode === "msg") {
          destGroups[dest].push(...(boxMsgIds[key] || []));
        } else {
          (boxChatIds[key] || []).forEach((chatId: string) => {
            const emails = groupedEmails[chatId as RoomKeyStr] || [];
            emails.filter((e) => getEmailBox(e) === box && isRevealedEmail(e)).forEach((e) => {
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
      setModal({ type: "confirm_pin", targetMode, targets: filteredTargets });
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

      <div className="overflow-y-auto flex-1 p-3 space-y-4">
        {accounts.map(account => {
          const boxesForAccount = availableKeysByAccount[account];
          if (boxesForAccount.length === 0) return null;
          return (
            <div key={account}>
              {/* 対象が複数アカウントにまたがる場合だけアカウント見出しを表示する（単一アカウントなら従来通り） */}
              {accounts.length > 1 && (
                <div className="text-xs font-bold text-[#5865F2] mb-1.5 px-1 truncate">{account}</div>
              )}
              <div className="space-y-2">
                {boxesForAccount.map(box => {
                  const key = boxKey(account, box);
                  const restricted = isBoxRestricted(box);
                  const checked = checkedBoxes.includes(key);
                  const count = boxCounts[key] || 0;
                  const selectedDest = boxDestinations[key];
                  return (
                    <div
                      key={key}
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
                            onChange={() => toggleBox(key)}
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
                                onClick={() => setBoxDest(key, dest)}
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
              </div>
            </div>
          );
        })}

        {allAvailableKeys.length === 0 && (
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
          {action === "move" ? `移動する (${totalCheckedCount}件)` : `次へ (${totalCheckedCount}件)`}
        </button>
      </div>
    </div>
  );
}
