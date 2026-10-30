import { useState } from "react";
import { formatFileSize, WarningIcon } from "../ui";
import type { RoomKeyStr } from "../../lib/roomKey";
import type { MailAppHook } from "../../hooks/useMailApp";
import type { ModalState } from "../../types/mail";
import { ROLE_LABELS, ROLE_HINTS, originalParticipants, type ComposeRecipient, type RecipientRole } from "../../lib/composeRecipients";

// 「作成」モーダル: 過去にやり取りした宛先の選択・検索・新規アドレス追加を行い、チャットを作成/オープンする。
// 入力欄の「＋ 送信先を追加」（select_recipients）でも同じ画面を使う。そのときは候補を送信元と同じアカウントの相手に絞り、
// 選んだ人ごとに To / Cc / Bcc を選べるようにし、返信元があれば「元のメールに入っていた人」を一番上に出す
export function ComposeNewChatModal({ app, modal }: { app: MailAppHook; modal: NonNullable<ModalState> }) {
  const { contactDirectory } = app.computed;
  const { safeBack, createOrOpenChat, createGroupChat, forwardMessageTo, exitAfterAction } = app.actions;
  const isForward = modal?.composeMode === "forward";
  const isRecipients = modal.type === "select_recipients";
  const sendAccount = isRecipients && app.state.selectedSender ? app.actions.roomAccountEmail(app.state.selectedSender) : "";
  // 転送では元のメールの添付も一緒に送る。純正 Gmail と同じ 25MB を超える場合は、送る前に止める
  const forwardAttachments = isForward ? (modal.forwardMessage?.attachments || []) : [];
  const forwardAttachmentBytes = forwardAttachments.reduce((sum, a) => sum + (a.size || 0), 0);
  const forwardTooLarge = forwardAttachmentBytes > 25 * 1024 * 1024;

  const mainEmail: string = app.auth?.session?.user?.email || "";
  const linkedAccounts: string[] = app.state.linkedAccounts || [];
  // 新規の宛先・グループをどのアカウント名義で作るか（既存の宛先を選んだ場合はそのアカウントのまま開く
  // ため無視される）。連携アカウントが無ければ選択肢を出す意味がないので常にメインアカウントになる
  const [account, setAccount] = useState(sendAccount || mainEmail);
  // 新しいチャット・グループの差出人（自分のアドレス）。差出人に使えるアドレス（確認済みの sendAs）から選ぶ。既定は Gmail の既定（isDefault）。
  // チャットは自分のアドレスごとに分かれるので、選んだアドレスのチャットを開く・作る（README §7.7）
  const [fromChoice, setFromChoice] = useState<Record<string, string>>({});
  const sendable = app.state.sendAsByAccount[account] || [];
  const showFromPicker = !isForward && !isRecipients && sendable.length > 1;
  const fromAddress = showFromPicker
    ? (fromChoice[account] || sendable.find(s => s.isDefault)?.sendAsEmail || account).toLowerCase()
    : account.toLowerCase();
  // 送信先を選ぶとき：選んだ人ごとの立場（既定は To）
  const [roles, setRoles] = useState<Record<string, RecipientRole>>({});
  const currentRecipients: ComposeRecipient[] = isRecipients ? app.state.recipients : [];
  const currentKeys = new Set(currentRecipients.map(r => r.address.toLowerCase()));
  // 返信元のメールの差出人（Reply-To 優先）・To・Cc。自分のアドレスとエイリアスは除く
  const replySource = isRecipients ? app.state.replyToMessage : null;
  const participants: ComposeRecipient[] = replySource
    ? originalParticipants({ from: replySource.from, to: replySource.to, cc: replySource.cc, replyTo: replySource.replyTo }, app.actions.myAddressesFor(account)).filter(p => !currentKeys.has(p.address.toLowerCase()))
    : [];
  const participantOf = (id: string) => participants.find(p => p.address.toLowerCase() === id.toLowerCase());

  const [step, setStep] = useState<"select" | "group_setup">("select");
  const [search, setSearch] = useState("");
  // アクションバーでチャットを選択した状態から開いた場合、それらを選択済みの状態にしておく
  const [selected, setSelected] = useState<string[]>(() => (modal?.targets as string[]) || []);

  const [groupName, setGroupName] = useState("");
  const [groupMode, setGroupMode] = useState<"normal" | "inbound_only" | "outbound_only">("normal");
  const [memberVisible, setMemberVisible] = useState<Record<string, boolean>>({});

  const isValidEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

  const getLabel = (id: string) => {
    const contact = contactDirectory.find(c => c.room === id);
    if (contact) return contact.label;
    const p = participantOf(id);
    return p?.name ? `${p.name} <${p.address}>` : id;
  };

  // 候補は選択中のアカウントのものだけを表示する（アカウント選択を切り替えると候補も切り替わる）。
  // 送信先を選ぶときは、もう送信先に入っている人は出さない
  // 差出人を選べるときは、その自分のアドレスのチャットだけを候補にする（別のアドレスのチャットを開いて差出人が変わらないように）
  const availableContacts = contactDirectory.filter(c => !selected.includes(c.room) && c.accountEmail === account && !(isRecipients && currentKeys.has(c.address.toLowerCase())) && (!showFromPicker || c.ownAddress === fromAddress));
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

  const addSelected = (id: string, role?: RecipientRole) => {
    if (role) setRoles(prev => ({ ...prev, [id]: role }));
    setSelected(prev => (prev.includes(id) ? prev : [...prev, id]));
  };
  const removeSelected = (id: string) => setSelected(prev => prev.filter(x => x !== id));

  // 転送モード: 単数・複数を問わず、選択した宛先へその場で転送する（新規チャットは開かない）。
  // 通常モード: 単数選択は従来通りその場でチャットを開く/作成する。複数選択はグループ設定画面へ進む
  const handleNext = () => {
    if (selected.length === 0) return;
    if (isRecipients) {
      const list = selected.map((id): ComposeRecipient | null => {
        const role = roles[id] || "to";
        if (contactDirectory.some(c => c.room === id)) {
          const r = app.actions.recipientForRoom(id as RoomKeyStr);
          return r ? { ...r, role } : null;
        }
        const p = participantOf(id);
        return p?.name ? { address: p.address, name: p.name, role } : { address: id.trim(), role };
      }).filter((r): r is ComposeRecipient => !!r);
      if (list.length < selected.length) app.actions.showErrorToast("アドレスが分からない相手がいたため、その人は足せませんでした。");
      safeBack();
      app.actions.addComposeRecipients(list);
      return;
    }
    if (isForward && modal.forwardMessage) {
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
      createOrOpenChat(target, account, undefined, fromAddress);
      return;
    }
    setMemberVisible(Object.fromEntries(selected.map(id => [id, true])));
    setGroupName("");
    setGroupMode("normal");
    setStep("group_setup");
  };

  const allMembersVisible = selected.every(id => memberVisible[id]);

  const resolveAddress = (id: string) => {
    const contact = contactDirectory.find(c => c.room === id);
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
    createGroupChat(name, selected, memberAddresses, groupMode, hideMembers, account, fromAddress);
  };

  // 連携アカウントがある場合のみ表示する、新規の宛先/グループをどのアカウント名義で作るかの選択UI。
  // 転送は転送元メッセージ自身のアカウントから送るため、ここでの選択は関係なく出さない
  const accountPicker = (linkedAccounts.length > 0 || showFromPicker) && !isForward && !isRecipients ? (
    <div className="px-3 pt-2 pb-2 border-b border-[#1E1F22]">
      {linkedAccounts.length > 0 && (
        <>
          <div className="text-[11px] font-bold text-gray-500 mb-1.5">新規の宛先・グループを作成するアカウント</div>
          <div className="flex flex-wrap gap-1.5">
            {[mainEmail, ...linkedAccounts].map(a => (
              <button
                key={a}
                onClick={() => setAccount(a)}
                className={`text-xs font-bold px-2.5 py-1 rounded-full border transition truncate max-w-[220px] ${account === a ? "bg-[#2B2D31] border-[#4752C4] text-[#5865F2]" : "bg-[#1E1F22] border-[#1E1F22] text-gray-500 hover:text-gray-300"}`}
              >
                {a}
              </button>
            ))}
          </div>
        </>
      )}
      {showFromPicker && (
        <>
          <div className={`text-[11px] font-bold text-gray-500 mb-1.5 ${linkedAccounts.length > 0 ? "mt-2" : ""}`}>差出人</div>
          <div className="flex flex-wrap gap-1.5">
            {sendable.map(sa => {
              const addr = sa.sendAsEmail.toLowerCase();
              return (
                <button
                  key={addr}
                  title={sa.displayName ? `${sa.displayName} <${sa.sendAsEmail}>` : sa.sendAsEmail}
                  onClick={() => setFromChoice(prev => ({ ...prev, [account]: addr }))}
                  className={`text-xs font-bold px-2.5 py-1 rounded-full border transition truncate max-w-[220px] ${fromAddress === addr ? "bg-[#2B2D31] border-[#4752C4] text-[#5865F2]" : "bg-[#1E1F22] border-[#1E1F22] text-gray-500 hover:text-gray-300"}`}
                >
                  {sa.sendAsEmail}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  ) : null;

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
        {accountPicker}

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
            チャットを作成する
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col max-h-[80vh]">
      <div className="p-4 border-b border-[#1E1F22]">
        <h2 className="text-lg font-bold text-white">{isRecipients ? "送信先を追加" : isForward ? "メールを転送" : "チャットを作成"}</h2>
        {isRecipients && <p className="text-xs text-gray-400 mt-1 truncate">{sendAccount} でやり取りした相手から選べます</p>}
        {isForward && (
          <p className="text-xs text-gray-400 mt-1 truncate">
            件名: {modal.forwardMessage?.subject || "(件名なし)"}
          </p>
        )}
        {forwardAttachments.length > 0 && (
          <p className={`text-xs mt-1 flex items-center gap-1 ${forwardTooLarge ? "text-red-400" : "text-gray-400"}`}>
            {forwardTooLarge && <WarningIcon className="w-3.5 h-3.5 flex-shrink-0" />}
            {forwardTooLarge
              ? `添付ファイルが合計25MBを超えるため転送できません（${formatFileSize(forwardAttachmentBytes)}）`
              : `添付ファイル ${forwardAttachments.length}件（${formatFileSize(forwardAttachmentBytes)}）も一緒に転送します`}
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
      {accountPicker}

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
                <div key={id} className="p-2 bg-[rgba(88,101,242,0.15)] rounded">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm text-white truncate">{getLabel(id)}</span>
                    <button onClick={() => removeSelected(id)} className="text-gray-300 hover:text-white font-bold px-2 flex-shrink-0">×</button>
                  </div>
                  {isRecipients && (
                    <div className="mt-1.5">
                      <select
                        value={roles[id] || "to"}
                        onChange={(e) => setRoles(prev => ({ ...prev, [id]: e.target.value as RecipientRole }))}
                        className="bg-[#1E1F22] text-xs text-gray-200 rounded px-1.5 py-1.5 max-w-full"
                      >
                        {(Object.keys(ROLE_LABELS) as RecipientRole[]).map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                      </select>
                      {ROLE_HINTS[roles[id] || "to"] && <div className="text-[11px] text-gray-400 mt-1">{ROLE_HINTS[roles[id] || "to"]}</div>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {participants.filter(p => !selected.includes(p.address)).length > 0 && (
          <div>
            <div className="text-xs font-bold text-gray-400 mb-1.5 px-2">元のメールに入っていた人</div>
            <div className="flex flex-col gap-1">
              {participants.filter(p => !selected.includes(p.address)).map(p => (
                <button
                  key={p.address}
                  onClick={() => addSelected(p.address, p.role)}
                  className="flex flex-col items-start p-2 hover:bg-[#2B2D31] rounded text-left transition"
                >
                  <span className="text-sm text-gray-200 truncate w-full">{p.name || p.address}</span>
                  <span className="text-[11px] text-gray-500 truncate w-full">{p.name ? `${p.address}・` : ""}元は {p.role === "cc" ? "Cc" : "To"}</span>
                </button>
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
            {!app.state.isLoadingMoreChats && app.state.chatStatusMessage && (
              <div className="flex justify-center py-2">
                <span className="text-xs text-gray-500">{app.state.chatStatusMessage}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="p-4 border-t border-[#1E1F22] flex justify-end gap-3">
        <button onClick={() => safeBack()} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
        <button
          disabled={selected.length === 0 || forwardTooLarge}
          onClick={handleNext}
          className="px-4 py-2 bg-[#5865F2] text-white rounded text-sm font-bold hover:bg-[#4752C4] disabled:bg-gray-600 disabled:text-gray-400"
        >
          {isRecipients ? "追加" : isForward ? "転送" : (selected.length > 1 ? "次へ (グループ設定)" : "チャットを作成する")}
        </button>
      </div>
    </div>
  );
}
