import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from "react";
import { BodyWithLinks, getFileIcon, formatFileSize, HighlightText } from "./ui";

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
    // ピン留め・非表示は送信済みメールも対象にできる（ゴミ箱・迷惑メールのみ対象外）
    if (action === "pin" || action === "hide") return box === "TRASH" || box === "SPAM";
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

// 「作成」モーダル: 過去にやり取りした宛先の選択・検索・新規アドレス追加を行い、チャットを作成/オープンする
function ComposeNewChatModal({ app, modal }: { app: any; modal: any }) {
  const { contactDirectory } = app.computed;
  const { safeBack, createOrOpenChat, createGroupChat, forwardMessageTo, exitAfterAction } = app.actions;
  const isForward = modal?.composeMode === "forward";

  const [step, setStep] = useState<"select" | "group_setup">("select");
  const [search, setSearch] = useState("");
  // アクションバーでチャットを選択した状態から開いた場合、それらを選択済みの状態にしておく
  const [selected, setSelected] = useState<string[]>(() => (modal?.targets as string[]) || []);

  const [groupName, setGroupName] = useState("");
  const [groupMode, setGroupMode] = useState<"normal" | "inbound_only" | "outbound_only">("normal");
  const [memberVisible, setMemberVisible] = useState<Record<string, boolean>>({});

  const isValidEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

  const getLabel = (id: string) => {
    const contact = (contactDirectory as any[]).find(c => c.room === id);
    return contact ? contact.label : id;
  };

  const availableContacts = (contactDirectory as any[]).filter(c => !selected.includes(c.room));
  const trimmedSearch = search.trim();
  const query = trimmedSearch.toLowerCase();
  const filteredContacts = query
    ? availableContacts.filter(c => c.label.toLowerCase().includes(query) || c.address.toLowerCase().includes(query))
    : availableContacts;

  // 検索欄に英数字(メールアドレスを構成しうる文字)だけが入力されている場合、
  // それを候補の一番上に「新しい宛先」として表示する。メアド形式になるまではクリックできない
  const looksLikeAddressInput = /^[A-Za-z0-9._%+-]+@?[A-Za-z0-9.-]*$/.test(trimmedSearch);
  const newAddressCandidate = (trimmedSearch.length > 0 && looksLikeAddressInput && !selected.includes(trimmedSearch)
    && !availableContacts.some(c => c.address.toLowerCase() === query))
    ? trimmedSearch : null;

  const addSelected = (id: string) => setSelected(prev => (prev.includes(id) ? prev : [...prev, id]));
  const removeSelected = (id: string) => setSelected(prev => prev.filter(x => x !== id));

  // 転送モード: 単数・複数を問わず、選択した宛先へその場で転送する（新規チャットは開かない）。
  // 通常モード: 単数選択は従来通りその場でチャットを開く/作成する。複数選択はグループ設定画面へ進む
  const handleNext = () => {
    if (selected.length === 0) return;
    if (isForward) {
      // 履歴の戻し方はメッセージ選択モードの終了も兼ねる exitAfterAction に統一する
      exitAfterAction();
      forwardMessageTo(modal.forwardMessage, selected);
      return;
    }
    if (selected.length === 1) {
      const target = selected[0];
      // 履歴のpushStateはopenChat内（モバイル時）でも行われるため、
      // 先にモーダルを閉じてから作成/オープンする（順序が逆だと履歴操作が競合する）。
      // アクションバーの選択状態から開いた場合はその選択も一緒に終了させる必要があるため、
      // safeBack（モーダルの履歴だけ1つ戻す）ではなく exitAfterAction を使う
      exitAfterAction();
      createOrOpenChat(target);
      return;
    }
    setMemberVisible(Object.fromEntries(selected.map(id => [id, true])));
    setGroupName("");
    setGroupMode("normal");
    setStep("group_setup");
  };

  const allMembersVisible = selected.every(id => memberVisible[id]);

  const resolveAddress = (id: string) => {
    const contact = (contactDirectory as any[]).find(c => c.room === id);
    return (contact ? contact.address : id).toLowerCase();
  };

  const handleCreateGroup = () => {
    const name = groupName.trim();
    if (!name) return;
    const hideMembers = selected.filter(id => !memberVisible[id]);
    // メンバーの実メールアドレスは今この画面で分かっている情報から確定させておく
    // （リロード直後などデータが揃っていないタイミングで送信済みメールとの照合に失敗しないようにするため）
    const memberAddresses = selected.map(resolveAddress);
    exitAfterAction();
    createGroupChat(name, selected, memberAddresses, groupMode, hideMembers);
  };

  if (step === "group_setup") {
    const MODE_OPTIONS: { value: "normal" | "inbound_only" | "outbound_only"; label: string; desc: string }[] = [
      { value: "normal", label: "通常", desc: "複数の宛先からのメールと、グループで送信したメールを表示します" },
      { value: "inbound_only", label: "受信専用", desc: "送信・返信はできません。自分が送信したメールも表示されません" },
      { value: "outbound_only", label: "送信専用", desc: "自分がグループで送信したメールのみ表示します。返信先は相手のメールからも選べます" },
    ];
    return (
      <div className="flex flex-col max-h-[80vh]">
        <div className="p-4 border-b border-[#1E1F22] flex items-center gap-3">
          <button onClick={() => setStep("select")} className="text-gray-400 hover:text-white font-bold text-lg transition">←</button>
          <h2 className="text-lg font-bold text-white">グループチャットの設定</h2>
        </div>

        <div className="overflow-y-auto flex-1 p-4 space-y-5">
          <div>
            <label className="text-xs font-bold text-gray-400 mb-1.5 block">チャット名</label>
            <input
              type="text"
              autoFocus
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              placeholder="グループ名を入力"
              className="w-full bg-[#1E1F22] text-sm text-white px-3 py-2 rounded focus:outline-none focus:ring-1 focus:ring-[#5865F2]"
            />
          </div>

          <div>
            <label className="text-xs font-bold text-gray-400 mb-1.5 block">表示モード</label>
            <div className="flex flex-col gap-1.5">
              {MODE_OPTIONS.map(opt => (
                <label key={opt.value} className="flex items-start gap-3 cursor-pointer hover:bg-[#2B2D31] p-2 rounded transition">
                  <input
                    type="radio"
                    name="groupMode"
                    checked={groupMode === opt.value}
                    onChange={() => setGroupMode(opt.value)}
                    className="accent-[#5865F2] w-4 h-4 mt-0.5 flex-shrink-0"
                  />
                  <span>
                    <span className="block text-sm font-bold text-gray-200">{opt.label}</span>
                    <span className="block text-xs text-gray-500">{opt.desc}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-bold text-gray-400">個別チャットの表示設定</label>
              <button
                onClick={() => {
                  const next = !allMembersVisible;
                  setMemberVisible(Object.fromEntries(selected.map(id => [id, next])));
                }}
                className={`text-xs font-bold px-2.5 py-1 rounded-full border transition ${allMembersVisible ? "bg-[#2B2D31] border-[#4752C4] text-[#5865F2]" : "bg-[#1E1F22] border-[#1E1F22] text-gray-500"}`}
              >
                {allMembersVisible ? "すべて表示" : "すべて非表示"}
              </button>
            </div>
            <div className="text-xs text-gray-500 mb-2">オンにすると、その宛先の個別チャットも一覧に表示されたままになります</div>
            <div className="flex flex-col gap-1">
              {selected.map(id => (
                <div key={id} className="flex items-center justify-between gap-2 p-2 hover:bg-[#2B2D31] rounded">
                  <span className="text-sm text-gray-200 truncate">{getLabel(id)}</span>
                  <button
                    onClick={() => setMemberVisible(prev => ({ ...prev, [id]: !prev[id] }))}
                    className={`text-xs font-bold px-2.5 py-1 rounded-full border transition flex-shrink-0 ${memberVisible[id] ? "bg-[#2B2D31] border-[#4752C4] text-[#5865F2]" : "bg-[#1E1F22] border-[#1E1F22] text-gray-500"}`}
                  >
                    {memberVisible[id] ? "表示" : "非表示"}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="p-4 border-t border-[#1E1F22] flex justify-end gap-3">
          <button onClick={() => safeBack()} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
          <button
            disabled={!groupName.trim()}
            onClick={handleCreateGroup}
            className="px-4 py-2 bg-[#5865F2] text-white rounded text-sm font-bold hover:bg-[#4752C4] disabled:bg-gray-600 disabled:text-gray-400"
          >
            チャットを作成
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col max-h-[80vh]">
      <div className="p-4 border-b border-[#1E1F22]">
        <h2 className="text-lg font-bold text-white">{isForward ? "メールを転送" : "チャットを作成"}</h2>
        {isForward && (
          <p className="text-xs text-gray-400 mt-1 truncate">
            件名: {modal.forwardMessage?.subject || "(件名なし)"}
          </p>
        )}
      </div>

      <div className="p-3 border-b border-[#1E1F22]">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="宛先を検索、またはメールアドレスを入力"
          className="w-full bg-[#1E1F22] text-sm text-gray-200 px-3 py-1.5 rounded focus:outline-none focus:ring-1 focus:ring-[#5865F2]"
          autoFocus
        />
      </div>

      <div
        className="overflow-y-auto flex-1 p-2 space-y-4"
        onScroll={(e) => {
          const { scrollTop, clientHeight, scrollHeight } = e.currentTarget;
          if (scrollHeight - Math.abs(scrollTop) - clientHeight < 50 && !app.state.isLoadingMoreChats && !app.state.chatStatusMessage) {
            app.actions.handleLoadMoreChats();
          }
        }}
      >
        {selected.length > 0 && (
          <div>
            <div className="text-xs font-bold text-gray-400 mb-1.5 px-2">選択中の宛先</div>
            <div className="flex flex-col gap-1">
              {selected.map((id) => (
                <div key={id} className="flex items-center justify-between gap-2 p-2 bg-[rgba(88,101,242,0.15)] rounded">
                  <span className="text-sm text-white truncate">{getLabel(id)}</span>
                  <button onClick={() => removeSelected(id)} className="text-gray-300 hover:text-white font-bold px-2 flex-shrink-0">×</button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div>
          <div className="text-xs font-bold text-gray-400 mb-1.5 px-2">候補</div>
          <div className="flex flex-col gap-1">
            {newAddressCandidate && (
              <button
                onClick={() => { if (isValidEmail(newAddressCandidate)) addSelected(newAddressCandidate); }}
                disabled={!isValidEmail(newAddressCandidate)}
                className={`flex flex-col items-start p-2 rounded text-left transition ${isValidEmail(newAddressCandidate) ? "hover:bg-[#2B2D31]" : "opacity-50 cursor-default"}`}
              >
                <span className="text-sm text-gray-200 truncate w-full">{newAddressCandidate}</span>
                <span className="text-[11px] text-gray-500 truncate w-full">
                  {isValidEmail(newAddressCandidate) ? "クリックしてこの宛先を選択" : "メールアドレスの形式で入力してください"}
                </span>
              </button>
            )}
            {filteredContacts.map((c) => (
              <button
                key={c.room}
                onClick={() => addSelected(c.room)}
                className="flex flex-col items-start p-2 hover:bg-[#2B2D31] rounded text-left transition"
              >
                <span className="text-sm text-gray-200 truncate w-full">{c.label}</span>
                {c.address && c.address !== c.label.toLowerCase() && (
                  <span className="text-[11px] text-gray-500 truncate w-full">{c.address}</span>
                )}
              </button>
            ))}
            {filteredContacts.length === 0 && !newAddressCandidate && (
              <div className="text-gray-500 text-xs p-2 px-2">
                {query ? "一致する宛先が見つかりません" : "やり取りした宛先はありません"}
              </div>
            )}
            {app.state.isLoadingMoreChats && (
              <div className="flex justify-center py-2">
                <span className="text-xs text-[#5865F2] animate-pulse">読み込み中...</span>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="p-4 border-t border-[#1E1F22] flex justify-end gap-3">
        <button onClick={() => safeBack()} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
        <button
          disabled={selected.length === 0}
          onClick={handleNext}
          className="px-4 py-2 bg-[#5865F2] text-white rounded text-sm font-bold hover:bg-[#4752C4] disabled:bg-gray-600 disabled:text-gray-400"
        >
          {isForward ? "転送" : (selected.length > 1 ? "次へ (グループ設定)" : "チャットを作成")}
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
  // max-width:100%!important は削除 — メールを自然な幅でレンダリングし、zoom でフィットさせる
  const inject =
    '<base target="_blank">' +
    '<style>*{box-sizing:border-box;}img{max-width:100%;height:auto;}body{margin:0;padding:16px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;word-break:break-word;opacity:0;transform-origin:0 0;will-change:transform;}</style>';
  if (/<head[\s>]/i.test(raw)) {
    return raw.replace(/(<head[^>]*>)/i, `$1${inject}`);
  }
  return `<!DOCTYPE html><html><head>${inject}</head><body>${raw}</body></html>`;
}


export function EmailModal({ app }: { app: any }) {
  const { emailModal } = app.state;
  const { closeEmailModal } = app.actions;

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  // レンダー直後・ペイント前にビューポートをロック（モーダル開閉と同期）
  useLayoutEffect(() => {
    if (!emailModal) return;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    const original = meta?.content ?? '';
    if (meta) meta.content = 'width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no';
    return () => { if (meta) meta.content = original; };
  }, [!!emailModal]); // eslint-disable-line react-hooks/exhaustive-deps

  // モーダルが閉じたら window リスナーをクリーンアップ
  useEffect(() => {
    if (!emailModal) { cleanupRef.current?.(); cleanupRef.current = null; }
  }, [emailModal]); // eslint-disable-line react-hooks/exhaustive-deps

  // アンマウント時のクリーンアップ
  useEffect(() => { return () => { cleanupRef.current?.(); }; }, []);

  const onIframeLoad = useCallback(() => {
    if (cleanupRef.current) { cleanupRef.current(); cleanupRef.current = null; }

    const iframe = iframeRef.current;
    if (!iframe) return;
    const doc = iframe.contentDocument;
    if (!doc?.body) return;

    const bodyEl = doc.body;
    const htmlEl = doc.documentElement as HTMLElement;

    // ズームのセットアップでどこかが例外を投げても、本文自体は必ず見える状態にする
    // （zoom設定に失敗しただけで本文が真っ暗/非表示のままになるのを防ぐ）
    let fitScale = 1;
    const state = { x: 0, y: 0, scale: 1 };
    let naturalWidth = 1, naturalHeight = 1, frameWidth = 1, frameHeight = 1;
    let clamp = () => {};
    let updateTransform = () => {};

    try {
      // overflow 設定前に自然な寸法を計測（設定後は scrollWidth が clientWidth に変わるため）
      naturalWidth = Math.max(bodyEl.scrollWidth, 1);
      naturalHeight = Math.max(bodyEl.scrollHeight, 1);
      frameWidth = Math.max(iframe.clientWidth, 1);
      frameHeight = Math.max(iframe.clientHeight, 1);

      // body 幅を固定（リフロー防止）。html 自体は元のiframeサイズ（frameWidth/frameHeight）の
      // ままにする。overflow:hidden のクリップはhtmlの実サイズ基準で働くため、htmlを広げなくても
      // transform（scale + translate）で body の任意の位置を映すことができる。
      // ★以前は html を naturalWidth*5 に拡げていたが、レスポンシブなメールテンプレート
      // （メディアクエリでレイアウトを切り替えるもの）だと、この幅の変更でメール内のCSSが
      // 「デスクトップ幅」と誤認して再レイアウトしてしまい、幅を固定したbody内で内容が
      // はみ出す→拡大時に右側が見切れる/欠けるという不具合の原因になっていた
      bodyEl.style.width = naturalWidth + 'px';

      // ネイティブスクロール無効化（transform で制御するため）
      htmlEl.style.overflow = 'hidden';
      bodyEl.style.overflow = 'hidden';
      fitScale = Math.max(0.01, Math.min(1, frameWidth / naturalWidth));
      state.scale = fitScale;

      updateTransform = () => {
        bodyEl.style.transform = `translate3d(${state.x}px,${state.y}px,0) scale(${state.scale})`;
      };

      clamp = () => {
        const cW = naturalWidth * state.scale;
        const cH = naturalHeight * state.scale;
        state.x = cW <= frameWidth ? 0 : Math.max(frameWidth - cW, Math.min(0, state.x));
        state.y = cH <= frameHeight ? 0 : Math.max(frameHeight - cH, Math.min(0, state.y));
      };

      clamp();
      updateTransform();
    } catch (e) {
      console.error(e);
    } finally {
      bodyEl.style.opacity = '1'; // ズーム設定の成否に関わらず必ず表示する（flash 防止 兼 フォールバック）
    }

    // カーソル/ピンチ中心を固定してズーム
    const applyZoom = (newScale: number, pivotX: number, pivotY: number) => {
      const clamped = Math.max(fitScale, Math.min(5, newScale));
      const bpX = (pivotX - state.x) / state.scale;
      const bpY = (pivotY - state.y) / state.scale;
      state.x = pivotX - bpX * clamped;
      state.y = pivotY - bpY * clamped;
      state.scale = clamped;
      clamp();
      updateTransform();
    };

    // ホイール: ctrlKey → ズーム、else → パン（transform で制御、ネイティブスクロールなし）
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey) {
        applyZoom(state.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX, e.clientY);
      } else {
        const d = e.deltaMode === 0 ? 1 : 20;
        state.x -= e.deltaX * d;
        state.y -= e.deltaY * d;
        clamp();
        updateTransform();
      }
    };

    // マウスドラッグ（iframe 外に出ても追跡できるよう window に登録）
    let isDragging = false, iframeOffsetX = 0, iframeOffsetY = 0;
    let dragStartX = 0, dragStartY = 0, dragStartSX = 0, dragStartSY = 0;

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const r = iframe.getBoundingClientRect();
      iframeOffsetX = r.left; iframeOffsetY = r.top;
      isDragging = true;
      dragStartX = e.clientX; dragStartY = e.clientY; // iframe 座標系
      dragStartSX = state.x; dragStartSY = state.y;
      htmlEl.style.cursor = 'grabbing';
    };
    const onWinMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      // ボタンが離されていたらドラッグ終了（iframe 内 mouseup は window に伝播しないため）
      if (!(e.buttons & 1)) { isDragging = false; htmlEl.style.cursor = ''; return; }
      // parent 座標 → iframe 座標に変換してデルタを計算
      state.x = dragStartSX + (e.clientX - iframeOffsetX) - dragStartX;
      state.y = dragStartSY + (e.clientY - iframeOffsetY) - dragStartY;
      clamp();
      updateTransform();
    };
    const onWinMouseUp = () => {
      if (!isDragging) return;
      isDragging = false;
      htmlEl.style.cursor = '';
    };

    // タッチ: 1本指パン・2本指ピンチズーム
    const getDist = (t: TouchList) => {
      const dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY;
      return Math.sqrt(dx * dx + dy * dy);
    };
    const getMid = (t: TouchList) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });

    let isPinching = false, lastTX = 0, lastTY = 0;
    let pinchStartDist = 0, pinchStartScale = 1;
    let pinchStartBodyX = 0, pinchStartBodyY = 0; // ジェスチャー開始時のピンチ中心 (body 座標)

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        lastTX = e.touches[0].clientX; lastTY = e.touches[0].clientY;
      } else if (e.touches.length >= 2) {
        isPinching = true;
        pinchStartDist = getDist(e.touches);
        pinchStartScale = state.scale;
        const startMid = getMid(e.touches);
        pinchStartBodyX = (startMid.x - state.x) / state.scale;
        pinchStartBodyY = (startMid.y - state.y) / state.scale;
        e.preventDefault();
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.cancelable) e.preventDefault();
      if (e.touches.length === 1 && !isPinching) {
        state.x += e.touches[0].clientX - lastTX;
        state.y += e.touches[0].clientY - lastTY;
        clamp();
        updateTransform();
        lastTX = e.touches[0].clientX; lastTY = e.touches[0].clientY;
      } else if (e.touches.length >= 2) {
        const dist = getDist(e.touches), mid = getMid(e.touches);
        // スケール: ジェスチャー開始時からの累積比率
        const newScale = Math.max(fitScale, Math.min(5, pinchStartScale * dist / pinchStartDist));
        // パン: ピンチ開始点 (body 座標固定) が現在のピンチ中心に来るよう offset を更新
        state.x = mid.x - pinchStartBodyX * newScale;
        state.y = mid.y - pinchStartBodyY * newScale;
        state.scale = newScale;
        clamp();
        updateTransform();
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) {
        isPinching = false;
        if (e.touches.length === 1) { lastTX = e.touches[0].clientX; lastTY = e.touches[0].clientY; }
      }
    };

    window.addEventListener('mousemove', onWinMouseMove);
    window.addEventListener('mouseup', onWinMouseUp);
    doc.addEventListener('wheel', onWheel, { passive: false });
    doc.addEventListener('mousedown', onMouseDown);
    doc.addEventListener('mouseup', onWinMouseUp); // iframe 内での mouseup（window には伝播しないため）
    doc.addEventListener('touchstart', onTouchStart, { passive: false });
    doc.addEventListener('touchmove', onTouchMove, { passive: false });
    doc.addEventListener('touchend', onTouchEnd);

    cleanupRef.current = () => {
      window.removeEventListener('mousemove', onWinMouseMove);
      window.removeEventListener('mouseup', onWinMouseUp);
    };
  }, []);

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
              ref={iframeRef}
              srcDoc={prepareHtml(htmlBody!)}
              sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin"
              className="w-full h-full border-none block bg-white"
              title="メール本文"
              onLoad={onIframeLoad}
            />
          )}
          {showText && (
            <div className="overflow-y-auto h-full p-4 bg-white">
              <pre className="text-gray-800 text-sm whitespace-pre-wrap break-words font-sans leading-relaxed select-text">
                <BodyWithLinks text={email.body || ""} />
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function AttachmentModal({ app }: { app: any }) {
  const { attachmentModal } = app.state;
  const { closeAttachmentModal } = app.actions;
  const [textContent, setTextContent] = useState<string | null>(null);
  const [pdfBlobUrl, setPdfBlobUrl] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const imgContainerRef = useRef<HTMLDivElement>(null);
  const imgCleanupRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    if (!attachmentModal?.base64 || !attachmentModal.mimeType.startsWith('text/')) {
      setTextContent(null);
      return;
    }
    try {
      const bytes = Uint8Array.from(atob(attachmentModal.base64), (c: string) => c.charCodeAt(0));
      setTextContent(new TextDecoder().decode(bytes));
    } catch {
      setTextContent(null);
    }
  }, [attachmentModal?.base64, attachmentModal?.mimeType]);

  // PDFは data:URI だと Android Chrome の iframe 内で表示できないことがあるため、
  // blob: URL に変換して渡す（Android Chrome でも埋め込みPDFビューアが起動しやすくなる）
  useEffect(() => {
    if (!attachmentModal?.base64 || attachmentModal.mimeType !== 'application/pdf') {
      setPdfBlobUrl(null);
      return;
    }
    let url: string | null = null;
    try {
      const bytes = Uint8Array.from(atob(attachmentModal.base64), (c: string) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: 'application/pdf' });
      url = URL.createObjectURL(blob);
      setPdfBlobUrl(url);
    } catch {
      setPdfBlobUrl(null);
    }
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [attachmentModal?.base64, attachmentModal?.mimeType]);

  useLayoutEffect(() => {
    if (!attachmentModal) return;
    // PDFはブラウザ標準のビューアにズーム操作ごと任せるため、ビューポートを固定しない
    // （画像プレビューは独自のズーム実装を使うため固定する）
    if (attachmentModal.mimeType === 'application/pdf') return;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    const original = meta?.content ?? '';
    if (meta) meta.content = 'width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no';
    return () => { if (meta) meta.content = original; };
  }, [!!attachmentModal]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup zoom listeners when attachment changes or modal closes
  useEffect(() => {
    return () => { if (imgCleanupRef.current) { imgCleanupRef.current(); imgCleanupRef.current = null; } };
  }, [attachmentModal?.attachmentId ?? '']);

  const onImgLoad = useCallback(() => {
    const img = imgRef.current;
    const container = imgContainerRef.current;
    if (!img || !container) return;
    // Cached images may fire onLoad synchronously before DOM layout
    if (container.clientWidth === 0) {
      requestAnimationFrame(() => { if (imgRef.current && imgContainerRef.current) onImgLoad(); });
      return;
    }
    if (imgCleanupRef.current) { imgCleanupRef.current(); imgCleanupRef.current = null; }

    const cW = container.clientWidth;
    const cH = container.clientHeight;
    const imgW = img.offsetWidth;
    const imgH = img.offsetHeight;

    let scale = 1;
    let x = (cW - imgW) / 2;
    let y = (cH - imgH) / 2;

    // Apply x,y,scale directly — NO clamping during gesture (prevents anchor drift)
    const setTransform = (transition = 'none') => {
      img.style.transition = transition;
      img.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
    };

    // Correct position — called ONLY after gesture ends
    const snap = (transition = 'transform 0.2s ease-out') => {
      const vW = imgW * scale;
      const vH = imgH * scale;
      if (scale <= 1) {
        scale = 1; x = (cW - imgW) / 2; y = (cH - imgH) / 2;
      } else {
        x = vW <= cW ? (cW - vW) / 2 : Math.max(cW - vW, Math.min(0, x));
        y = vH <= cH ? (cH - vH) / 2 : Math.max(cH - vH, Math.min(0, y));
      }
      img.style.transition = transition;
      img.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
    };

    const centerImage = (animated = true) => {
      scale = 1; x = (cW - imgW) / 2; y = (cH - imgH) / 2;
      setTransform(animated ? 'transform 0.2s ease-out' : 'none');
      container.style.cursor = 'grab';
    };

    centerImage(false);
    img.style.opacity = '1';

    // Wheel zoom: anchor from unclamped x,y → zero drift
    let wheelSnapTimer: ReturnType<typeof setTimeout> | null = null;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (wheelSnapTimer) { clearTimeout(wheelSnapTimer); wheelSnapTimer = null; }
      const newScale = scale * (1 + (e.deltaY > 0 ? -1 : 1) * 0.15);
      if (newScale <= 1) { centerImage(); return; }
      const rect = container.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const bx = (mx - x) / scale;
      const by = (my - y) / scale;
      x = mx - bx * newScale;
      y = my - by * newScale;
      scale = newScale;
      setTransform('transform 0.05s ease-out');
      wheelSnapTimer = setTimeout(() => { snap(); wheelSnapTimer = null; }, 300);
    };

    // Mouse drag
    let isDragging = false;
    let dragStartMouseX = 0, dragStartMouseY = 0, dragStartImageX = 0, dragStartImageY = 0;
    let canMoveX = false, canMoveY = false;

    const checkMovability = () => {
      canMoveX = imgW * scale > cW + 1;
      canMoveY = imgH * scale > cH + 1;
    };

    const onMouseDown = (e: MouseEvent) => {
      if (scale <= 1) return;
      e.preventDefault();
      snap('none'); // sync to valid position before drag starts
      isDragging = true;
      checkMovability();
      dragStartMouseX = e.clientX; dragStartMouseY = e.clientY;
      dragStartImageX = x; dragStartImageY = y;
      container.style.cursor = 'grabbing';
      img.style.transition = 'none';
    };
    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      e.preventDefault();
      let dx = e.clientX - dragStartMouseX;
      let dy = e.clientY - dragStartMouseY;
      if (!canMoveX) dx = 0;
      if (!canMoveY) dy = 0;
      x = dragStartImageX + dx;
      y = dragStartImageY + dy;
      setTransform();
    };
    const onMouseUp = () => {
      if (isDragging) {
        isDragging = false;
        container.style.cursor = 'grab';
        snap('transform 0.1s ease-out');
      }
    };

    // Touch: absolute anchor for pinch (zero drift) + incremental for single-touch pan
    let isPinching = false;
    let pinchStartDist = 0, pinchStartScale = 1;
    let pinchStartBodyX = 0, pinchStartBodyY = 0;
    let singleTouching = false;
    let lastTouchX = 0, lastTouchY = 0;

    const getTouchDist = (t: TouchList) => {
      const dx = t[0].clientX - t[1].clientX; const dy = t[0].clientY - t[1].clientY;
      return Math.sqrt(dx * dx + dy * dy);
    };
    const getTouchMid = (t: TouchList) => ({
      x: (t[0].clientX + t[1].clientX) / 2,
      y: (t[0].clientY + t[1].clientY) / 2,
    });

    const onTouchStart = (e: TouchEvent) => {
      e.preventDefault();
      if (e.touches.length === 2) {
        isPinching = true; singleTouching = false;
        const mid = getTouchMid(e.touches);
        pinchStartDist = getTouchDist(e.touches);
        pinchStartScale = scale;
        // Absolute anchor from unclamped x,y — recorded ONCE, used every frame
        pinchStartBodyX = (mid.x - x) / scale;
        pinchStartBodyY = (mid.y - y) / scale;
        img.style.transition = 'none';
      } else if (e.touches.length === 1 && !isPinching) {
        singleTouching = true;
        if (scale > 1) {
          checkMovability();
          lastTouchX = e.touches[0].clientX; lastTouchY = e.touches[0].clientY;
          img.style.transition = 'none';
        }
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.cancelable) e.preventDefault();
      if (e.touches.length === 2 && isPinching) {
        const currentDist = getTouchDist(e.touches);
        const currentMid = getTouchMid(e.touches);
        const newScale = pinchStartScale * currentDist / pinchStartDist;
        if (newScale <= 1) { centerImage(); return; }
        // Recompute from absolute anchor every frame — no incremental error
        scale = newScale;
        x = currentMid.x - pinchStartBodyX * newScale;
        y = currentMid.y - pinchStartBodyY * newScale;
        img.style.transition = 'none';
        setTransform();
      } else if (e.touches.length === 1 && singleTouching && !isPinching && scale > 1) {
        let dx = e.touches[0].clientX - lastTouchX;
        let dy = e.touches[0].clientY - lastTouchY;
        if (!canMoveX) dx = 0;
        if (!canMoveY) dy = 0;
        x += dx; y += dy;
        lastTouchX = e.touches[0].clientX; lastTouchY = e.touches[0].clientY;
        img.style.transition = 'none';
        setTransform();
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) { isPinching = false; }
      if (e.touches.length === 1 && !isPinching) {
        singleTouching = true; checkMovability();
        lastTouchX = e.touches[0].clientX; lastTouchY = e.touches[0].clientY;
        img.style.transition = 'none';
      } else if (e.touches.length === 0) {
        singleTouching = false;
        snap();
      }
    };

    img.addEventListener('wheel', onWheel, { passive: false });
    img.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    img.addEventListener('touchstart', onTouchStart, { passive: false });
    img.addEventListener('touchmove', onTouchMove, { passive: false });
    img.addEventListener('touchend', onTouchEnd);

    imgCleanupRef.current = () => {
      if (wheelSnapTimer) { clearTimeout(wheelSnapTimer); wheelSnapTimer = null; }
      img.removeEventListener('wheel', onWheel);
      img.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      img.removeEventListener('touchstart', onTouchStart);
      img.removeEventListener('touchmove', onTouchMove);
      img.removeEventListener('touchend', onTouchEnd);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!attachmentModal) return null;

  const { filename, mimeType, size, base64, isLoading } = attachmentModal;
  const isImage = mimeType.startsWith('image/');
  const isPdf = mimeType === 'application/pdf';
  const isTextFile = mimeType.startsWith('text/');
  const isAudio = mimeType.startsWith('audio/');
  const isVideo = mimeType.startsWith('video/');
  const canPreview = isImage || isPdf || isTextFile || isAudio || isVideo;
  const dataUrl = base64 ? `data:${mimeType};base64,${base64}` : null;

  const handleDownload = () => {
    if (!dataUrl) return;
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleOpenPdfInNewTab = () => {
    // Android Chrome は iframe に埋め込んだPDFを表示できないことがあるため、
    // 新しいタブで開いてブラウザ標準のPDFビューアに直接表示させる。
    // data:URI だとURL長の上限に引っかかる大きめのPDFもあるため blob: URL を使う
    if (pdfBlobUrl) { window.open(pdfBlobUrl, '_blank'); return; }
    if (dataUrl) window.open(dataUrl, '_blank');
  };

  const handleShare = async () => {
    if (!base64) return;
    try {
      const bytes = Uint8Array.from(atob(base64), (c: string) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: mimeType });
      const file = new File([blob], filename, { type: mimeType });
      if ((navigator as any).canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
        return;
      }
    } catch {}
    handleDownload();
  };

  return (
    <div className="fixed inset-0 bg-black/80 z-[60] flex items-center justify-center p-2 sm:p-4" onClick={closeAttachmentModal}>
      <div
        className="bg-[#2B2D31] rounded-lg shadow-2xl w-full max-w-2xl flex flex-col border border-[#1E1F22]"
        style={{ height: canPreview ? '90dvh' : 'auto' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ヘッダー */}
        <div className="flex items-center gap-3 p-4 border-b border-[#1E1F22] flex-shrink-0">
          <span className="text-2xl flex-shrink-0">{getFileIcon(mimeType)}</span>
          <div className="flex-1 min-w-0">
            <div className="font-bold text-white text-sm truncate">{filename}</div>
            <div className="text-[11px] text-gray-400">{formatFileSize(size)} · {mimeType}</div>
          </div>
          <button onClick={closeAttachmentModal} className="text-gray-400 hover:text-white text-xl font-bold flex-shrink-0 leading-none">×</button>
        </div>

        {/* プレビューエリア */}
        <div className="flex-1 min-h-0 relative overflow-hidden">
          {isLoading && (
            <div className="absolute inset-0 flex items-center justify-center text-gray-400 text-sm">読み込み中...</div>
          )}
          {!isLoading && !base64 && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-gray-500 text-sm p-4 text-center">
              <span className="text-4xl">{getFileIcon(mimeType)}</span>
              <span>ファイルを読み込めませんでした</span>
            </div>
          )}
          {!isLoading && dataUrl && isImage && (
            <div
              ref={imgContainerRef}
              className="w-full h-full overflow-hidden bg-[#111] relative"
              style={{ cursor: 'grab' }}
            >
              <img
                ref={imgRef}
                src={dataUrl}
                alt={filename}
                onLoad={onImgLoad}
                style={{
                  opacity: 0,
                  display: 'block',
                  maxWidth: '100%',
                  maxHeight: '100%',
                  transformOrigin: '0 0',
                  willChange: 'transform',
                  userSelect: 'none',
                }}
                draggable={false}
              />
            </div>
          )}
          {!isLoading && dataUrl && isPdf && (
            <iframe src={dataUrl} className="w-full h-full border-none" title={filename} />
          )}
          {!isLoading && dataUrl && isAudio && (
            <div className="w-full h-full flex items-center justify-center bg-[#1E1F22] p-8">
              <audio controls src={dataUrl} className="w-full max-w-md" />
            </div>
          )}
          {!isLoading && dataUrl && isVideo && (
            <div className="w-full h-full flex items-center justify-center bg-black">
              <video controls src={dataUrl} className="max-w-full max-h-full" />
            </div>
          )}
          {!isLoading && base64 && isTextFile && (
            <div className="w-full h-full overflow-auto p-4 bg-[#1E1F22]">
              <pre className="text-gray-200 text-sm whitespace-pre-wrap break-words font-mono leading-relaxed select-text">
                {textContent ?? '（テキストを読み込めませんでした）'}
              </pre>
            </div>
          )}
          {!isLoading && base64 && !canPreview && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-gray-400 p-8 text-center">
              <span className="text-6xl">{getFileIcon(mimeType)}</span>
              <span className="text-sm font-bold text-gray-300">{filename}</span>
              <span className="text-xs text-gray-500">このファイル形式はプレビューできません</span>
            </div>
          )}
        </div>

        {/* フッター */}
        <div className="p-4 border-t border-[#1E1F22] flex gap-3 flex-shrink-0">
          {isPdf && (
            <button onClick={handleOpenPdfInNewTab} disabled={!base64}
              className="flex-1 py-2.5 bg-[#2B2D31] border border-[#4752C4] hover:bg-[#35373C] disabled:opacity-30 text-gray-200 font-bold rounded text-sm transition">
              新しいタブで開く
            </button>
          )}
          <button onClick={handleDownload} disabled={!base64}
            className="flex-1 py-2.5 bg-[#5865F2] hover:bg-[#4752C4] disabled:bg-[#3f4147] disabled:text-gray-500 text-white font-bold rounded text-sm transition">
            ダウンロード
          </button>
          <button onClick={handleShare} disabled={!base64}
            className="flex-1 py-2.5 bg-[#2B2D31] border border-[#4752C4] hover:bg-[#35373C] disabled:opacity-30 text-gray-200 font-bold rounded text-sm transition">
            共有
          </button>
        </div>
      </div>
    </div>
  );
}

export function Modals({ app }: { app: any }) {
  const { modal, renameInput, moveDestination, resetOptions, chatConfigs, selectedIds, selectedSender, checkTrash, checkSpam, checkInbox, checkArchive, checkSent, revealedCrossPrompts } = app.state;
  const { setModal, executeConfirmedAction, executePin, setRenameInput, setMoveDestination, setSelectionMode, setSelectedIds, setResetOptions, updateChatConfig, safeBack, setReplyToMessage, setReplySubject, openEmailModal, exitAfterAction } = app.actions;
  const { groupedEmails, allUniqueEmails, hiddenChats, hiddenMsgs } = app.computed;

  if (!modal || modal.type === "search") return null;

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

        {modal.type === "compose_new_chat" && (
          <ComposeNewChatModal app={app} modal={modal} />
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

        {modal.type === "confirm_delete_group" && (
          <div className="p-5">
            <h2 className="text-lg font-bold text-white mb-2">グループチャットの削除</h2>
            <p className="text-sm text-gray-300 mb-6 leading-relaxed">
              選択した{modal.targets.length}件のグループチャットのみを削除します。<br/>
              <span className="text-[#5865F2] font-bold">グループに含まれる個別のチャットや、実際のメール自体は削除されません。</span>
            </p>
            <div className="flex justify-end gap-3">
              <button onClick={() => safeBack()} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
              <button
                onClick={() => {
                  modal.targets.forEach((room: string) => app.actions.deleteChatConfig(room));
                  exitAfterAction();
                }}
                className="px-4 py-2 bg-[#DA373C] text-white rounded text-sm font-bold hover:bg-[#a1282c]"
              >
                削除する
              </button>
            </div>
          </div>
        )}

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

        {modal.type === "select_reply_target" && (() => {
          const isGroup = chatConfigs[selectedSender!]?.isGroup;
          const source = isGroup ? (app.computed.groupReplyPools[selectedSender!] || []) : (groupedEmails[selectedSender!] || []);
          const msgs = (source as any[]).slice().sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime());
          return (
            <div className="flex flex-col max-h-[80vh]">
              <div className="p-4 border-b border-[#1E1F22]">
                <h2 className="text-lg font-bold text-white">返信先を選択</h2>
              </div>
              <div className="p-2 overflow-y-auto flex-1 space-y-1">
                {msgs.map((m: any) => (
                  <div key={m.id} className="flex items-center gap-2 p-2 hover:bg-[#2B2D31] rounded">
                    <div className="flex-1 min-w-0 text-sm">
                      <div className="text-gray-400 text-[11px]">{new Date(m.date).toLocaleString("ja-JP")}</div>
                      <div className="text-gray-200 truncate">{m.subject || m.snippet || "(件名なし)"}</div>
                    </div>
                    <button
                      onClick={() => {
                        setReplyToMessage(m);
                        setReplySubject(m.subject?.startsWith("Re:") ? m.subject : `Re: ${m.subject || ""}`);
                        safeBack();
                      }}
                      className="px-3 py-1.5 bg-[#5865F2] hover:bg-[#4752C4] text-white text-xs font-bold rounded flex-shrink-0"
                    >
                      選択
                    </button>
                    <button
                      onClick={() => openEmailModal(m)}
                      className="px-3 py-1.5 bg-[#1E1F22] hover:bg-[#3f4147] text-gray-200 text-xs font-bold rounded flex-shrink-0"
                    >
                      詳細
                    </button>
                  </div>
                ))}
                {msgs.length === 0 && <div className="text-gray-500 text-sm p-4 text-center">このチャットにはまだメッセージがありません</div>}
              </div>
              <div className="p-4 border-t border-[#1E1F22] flex justify-end">
                <button onClick={() => safeBack()} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
              </div>
            </div>
          );
        })()}

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

type SearchTab = "all" | "recipient" | "address" | "subject" | "body";
type SearchSort = "newest" | "oldest" | "kana";
type BoxKey = "inbox" | "archive" | "sent" | "spam" | "trash";

const SEARCH_BOX_LABELS: Record<BoxKey, string> = {
  inbox: "受信箱", archive: "アーカイブ", sent: "送信済み", spam: "迷惑メール", trash: "ゴミ箱",
};

function getSearchBoxInfo(e: any): { key: BoxKey; name: string } {
  const isTrash = e.labelIds?.includes("TRASH");
  const isSpam = e.labelIds?.includes("SPAM");
  const isInbox = e.labelIds?.includes("INBOX");
  const isSent = e.labelIds?.includes("SENT") || e.isMe;
  const isArchive = !isTrash && !isSpam && !isInbox && !isSent;
  const key: BoxKey = isSent ? "sent" : isTrash ? "trash" : isSpam ? "spam" : isInbox ? "inbox" : "archive";
  return { key, name: SEARCH_BOX_LABELS[key] };
}

// 検索結果一覧: チャット画面(すべて/宛先名/アドレス/件名/本文)とメッセージ画面(件名/本文のみ)の
// 両方の検索ボタンから開かれる。既に読み込み済みのデータ(allUniqueEmails/groupedEmails)のみを
// 対象にしたクライアント側検索で、Gmailへの再取得は行わない。
export function SearchModal({ app }: { app: any }) {
  const { modal, chatConfigs, checkInbox, checkArchive, checkSpam, checkTrash, checkSent } = app.state;
  const { setModal, safeBack, exitAfterAction, openChat, jumpToSearchResult } = app.actions;
  const { allUniqueEmails, groupedEmails, contactDirectory } = app.computed;

  const active = modal?.type === "search" ? modal : null;
  const scope: "all" | "current_chat" = active?.searchScope || "all";
  const currentChatRoom: string | undefined = scope === "current_chat" ? active?.targets?.[0] : undefined;

  const [keyword, setKeyword] = useState("");
  const [activeTab, setActiveTab] = useState<SearchTab>(scope === "all" ? "all" : "subject");
  const [sortOrder, setSortOrder] = useState<SearchSort>("newest");
  const [boxFilter, setBoxFilter] = useState<Record<BoxKey, boolean>>({
    inbox: checkInbox, archive: checkArchive, sent: checkSent, spam: checkSpam, trash: checkTrash,
  });

  const inputRef = useRef<HTMLInputElement>(null);

  // モーダルが開いた瞬間にタブとキーワードを初期化し、入力欄にフォーカスする
  useEffect(() => {
    if (!active) return;
    setKeyword("");
    setActiveTab(scope === "all" ? "all" : "subject");
    setSortOrder("newest");
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!active]);

  const kwLower = keyword.trim().toLowerCase();

  const roomInfos = useMemo(() => {
    const infos: { room: string; label: string; address: string | null; isGroup: boolean; latestDate: number }[] = [];
    (contactDirectory as any[]).forEach(c => {
      infos.push({ room: c.room, label: c.label, address: c.address || null, isGroup: false, latestDate: c.latestDate });
    });
    Object.keys(chatConfigs).forEach(room => {
      const cfg = chatConfigs[room];
      if (cfg?.isGroup && (groupedEmails[room] || []).length > 0) {
        infos.push({
          room,
          label: cfg.customName || room,
          address: null,
          isGroup: true,
          latestDate: groupedEmails[room][0]?.date ? new Date(groupedEmails[room][0].date).getTime() : 0,
        });
      }
    });
    return infos;
  }, [contactDirectory, chatConfigs, groupedEmails]);

  const roomInfoMap = useMemo(() => new Map(roomInfos.map(r => [r.room, r])), [roomInfos]);

  const emailRoomMap = useMemo(() => {
    const map = new Map<string, string>();
    Object.keys(groupedEmails).forEach(room => (groupedEmails[room] || []).forEach((e: any) => map.set(e.id, room)));
    return map;
  }, [groupedEmails]);

  const scopedEmails = useMemo(() => {
    if (scope === "current_chat" && currentChatRoom) return groupedEmails[currentChatRoom] || [];
    return allUniqueEmails;
  }, [scope, currentChatRoom, groupedEmails, allUniqueEmails]);

  const recipientMatches = useMemo(() => {
    if (!kwLower) return [];
    return roomInfos.filter(r => r.label.toLowerCase().includes(kwLower));
  }, [roomInfos, kwLower]);

  const addressMatches = useMemo(() => {
    if (!kwLower) return [];
    return roomInfos.filter(r => r.address && r.address.toLowerCase().includes(kwLower));
  }, [roomInfos, kwLower]);

  const subjectMatches = useMemo(() => {
    if (!kwLower) return [];
    return scopedEmails.filter((e: any) => {
      if (!(e.subject || "").toLowerCase().includes(kwLower)) return false;
      return boxFilter[getSearchBoxInfo(e).key];
    });
  }, [scopedEmails, kwLower, boxFilter]);

  const bodyMatches = useMemo(() => {
    if (!kwLower) return [];
    return scopedEmails.filter((e: any) => {
      if (!(e.body || "").toLowerCase().includes(kwLower)) return false;
      return boxFilter[getSearchBoxInfo(e).key];
    });
  }, [scopedEmails, kwLower, boxFilter]);

  const sortRooms = (list: typeof roomInfos, order: SearchSort) => {
    const arr = [...list];
    if (order === "kana") arr.sort((a, b) => a.label.localeCompare(b.label, "ja"));
    else if (order === "oldest") arr.sort((a, b) => a.latestDate - b.latestDate);
    else arr.sort((a, b) => b.latestDate - a.latestDate);
    return arr;
  };
  const sortEmailsByDate = (list: any[], order: "newest" | "oldest") => {
    const arr = [...list];
    arr.sort((a, b) => order === "oldest"
      ? new Date(a.date).getTime() - new Date(b.date).getTime()
      : new Date(b.date).getTime() - new Date(a.date).getTime());
    return arr;
  };

  const emailSortOrder: "newest" | "oldest" = sortOrder === "kana" ? "newest" : sortOrder;
  const sortedRecipients = sortRooms(recipientMatches, sortOrder);
  const sortedAddresses = sortRooms(addressMatches, sortOrder);
  const sortedSubjects = sortEmailsByDate(subjectMatches, emailSortOrder);
  const sortedBodies = sortEmailsByDate(bodyMatches, emailSortOrder);

  const getBodySnippet = (body: string) => {
    const idx = body.toLowerCase().indexOf(kwLower);
    if (idx === -1) return body.slice(0, 60).replace(/\s+/g, " ");
    const start = Math.max(0, idx - 20);
    const end = Math.min(body.length, idx + kwLower.length + 40);
    return (start > 0 ? "…" : "") + body.slice(start, end).replace(/\s+/g, " ") + (end < body.length ? "…" : "");
  };

  const handleClose = () => safeBack();

  const handleOpenChat = (room: string) => {
    exitAfterAction();
    openChat(room);
  };

  const handleJumpToMessage = (room: string, msgId: string) => {
    exitAfterAction();
    jumpToSearchResult(room, msgId, keyword);
  };

  const TABS: [SearchTab, string][] = scope === "all"
    ? [["all", "すべて"], ["recipient", "宛先名"], ["address", "アドレス"], ["subject", "件名"], ["body", "本文"]]
    : [["subject", "件名"], ["body", "本文"]];

  const showKanaSort = activeTab === "recipient" || activeTab === "address";
  const showBoxFilter = activeTab === "subject" || activeTab === "body";

  const renderRoomRow = (info: { room: string; label: string; address: string | null }, primary: "label" | "address") => (
    <button
      key={info.room}
      onClick={() => handleOpenChat(info.room)}
      className="w-full text-left px-3 py-2.5 rounded hover:bg-[#35373C] transition border-b border-[#1E1F22]/50 last:border-0 flex items-center justify-between gap-2"
    >
      {primary === "label" ? (
        <>
          <span className="font-bold text-sm text-white truncate"><HighlightText text={info.label} highlight={keyword} /></span>
          {info.address && <span className="text-xs text-gray-500 truncate flex-shrink-0">{info.address}</span>}
        </>
      ) : (
        <>
          <span className="font-bold text-sm text-white truncate"><HighlightText text={info.address || ""} highlight={keyword} /></span>
          <span className="text-xs text-gray-500 truncate flex-shrink-0">{info.label}</span>
        </>
      )}
    </button>
  );

  const renderEmailRow = (email: any) => {
    const room = emailRoomMap.get(email.id);
    const info = room ? roomInfoMap.get(room) : undefined;
    const boxName = getSearchBoxInfo(email).name;
    const dateStr = new Date(email.date).toLocaleString("ja-JP", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    return (
      <button
        key={email.id}
        onClick={() => room && handleJumpToMessage(room, email.id)}
        className="w-full text-left px-3 py-2.5 rounded hover:bg-[#35373C] transition border-b border-[#1E1F22]/50 last:border-0"
      >
        <div className="font-bold text-sm text-white truncate">
          <HighlightText text={email.subject || "(件名なし)"} highlight={keyword} />
        </div>
        {email.body && (
          <div className="text-xs text-gray-400 truncate mt-0.5">
            <HighlightText text={getBodySnippet(email.body)} highlight={keyword} />
          </div>
        )}
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-[11px] text-gray-500">
          <span className="truncate max-w-[150px]">{info?.label || room}</span>
          {info?.address && <span className="truncate max-w-[150px]">{info.address}</span>}
          <span>{dateStr}</span>
          <span>{boxName}</span>
        </div>
      </button>
    );
  };

  const renderSection = (title: string, count: number, body: React.ReactNode) => count > 0 && (
    <div className="mb-4">
      <div className="text-xs font-bold text-gray-400 px-1 mb-1">{title} ({count}件)</div>
      <div className="bg-[#232428] rounded">{body}</div>
    </div>
  );

  if (!active) return null;

  const currentTabCount = activeTab === "all"
    ? sortedRecipients.length + sortedAddresses.length + sortedSubjects.length + sortedBodies.length
    : activeTab === "recipient" ? sortedRecipients.length
    : activeTab === "address" ? sortedAddresses.length
    : activeTab === "subject" ? sortedSubjects.length
    : sortedBodies.length;
  const noResults = !!kwLower && currentTabCount === 0;

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={handleClose}>
      <div
        className="bg-[#313338] rounded-lg shadow-2xl w-full max-w-2xl flex flex-col border border-[#1E1F22]"
        style={{ maxHeight: "85dvh" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-[#1E1F22] flex items-center gap-3 flex-shrink-0">
          <input
            ref={inputRef}
            type="text"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="キーワードを入力..."
            className="flex-1 bg-[#1E1F22] text-sm text-gray-200 px-3 py-2 rounded focus:outline-none focus:ring-1 focus:ring-[#5865F2]"
          />
          <button onClick={handleClose} className="text-gray-400 hover:text-white text-lg font-bold px-1 transition">×</button>
        </div>

        <div className="flex gap-1 px-3 pt-2 border-b border-[#1E1F22] flex-shrink-0 overflow-x-auto scrollbar-none">
          {TABS.map(([tab, label]) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-3 py-1.5 mb-2 rounded text-xs font-bold transition flex-shrink-0 ${activeTab === tab ? "bg-[#5865F2] text-white" : "bg-[#232428] text-gray-400 hover:bg-[#3f4147]"}`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3 px-3 py-2 border-b border-[#1E1F22] flex-shrink-0 bg-[#232428]">
          <div className="flex gap-1 text-[11px] font-bold">
            <button onClick={() => setSortOrder("newest")} className={`px-2 py-1 rounded ${sortOrder === "newest" ? "bg-[#5865F2] text-white" : "bg-[#313338] text-gray-400 hover:bg-[#3f4147]"}`}>新しい順</button>
            <button onClick={() => setSortOrder("oldest")} className={`px-2 py-1 rounded ${sortOrder === "oldest" ? "bg-[#5865F2] text-white" : "bg-[#313338] text-gray-400 hover:bg-[#3f4147]"}`}>古い順</button>
            {showKanaSort && (
              <button onClick={() => setSortOrder("kana")} className={`px-2 py-1 rounded ${sortOrder === "kana" ? "bg-[#5865F2] text-white" : "bg-[#313338] text-gray-400 hover:bg-[#3f4147]"}`}>あいうえお順</button>
            )}
          </div>
          {showBoxFilter && (
            <div className="flex flex-wrap gap-1 text-[11px] font-bold">
              {(Object.keys(SEARCH_BOX_LABELS) as BoxKey[]).map(key => (
                <label key={key} className="flex items-center gap-1 cursor-pointer bg-[#313338] px-2 py-1 rounded hover:bg-[#3f4147]">
                  <input type="checkbox" checked={boxFilter[key]} onChange={(e) => setBoxFilter(prev => ({ ...prev, [key]: e.target.checked }))} className="accent-[#5865F2]" />
                  {SEARCH_BOX_LABELS[key]}
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-3 min-h-0">
          {!kwLower && (
            <div className="text-center text-sm text-gray-500 py-10">キーワードを入力してください</div>
          )}
          {kwLower && noResults && (
            <div className="text-center text-sm text-gray-500 py-10">見つかりませんでした</div>
          )}
          {kwLower && activeTab === "all" && (
            <>
              {renderSection("宛先名", sortedRecipients.length, sortedRecipients.map(r => renderRoomRow(r, "label")))}
              {renderSection("アドレス", sortedAddresses.length, sortedAddresses.map(r => renderRoomRow(r, "address")))}
              {renderSection("件名", sortedSubjects.length, sortedSubjects.map(renderEmailRow))}
              {renderSection("本文", sortedBodies.length, sortedBodies.map(renderEmailRow))}
            </>
          )}
          {kwLower && activeTab === "recipient" && (
            <div className="bg-[#232428] rounded">{sortedRecipients.map(r => renderRoomRow(r, "label"))}</div>
          )}
          {kwLower && activeTab === "address" && (
            <div className="bg-[#232428] rounded">{sortedAddresses.map(r => renderRoomRow(r, "address"))}</div>
          )}
          {kwLower && activeTab === "subject" && (
            <div className="bg-[#232428] rounded">{sortedSubjects.map(renderEmailRow)}</div>
          )}
          {kwLower && activeTab === "body" && (
            <div className="bg-[#232428] rounded">{sortedBodies.map(renderEmailRow)}</div>
          )}
        </div>
      </div>
    </div>
  );
}