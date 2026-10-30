import { useState, useEffect, useMemo } from "react";
import { FilterCriteria, ConditionSet, TextField, TextRule, DateDirection, FindBarBoxKey, messageMatchesFilter, missingOwnAddresses, isEmptyFilterCriteria, getFindBarBoxKey, isActionBoxRestricted, getConditionSets } from "../../lib/filterMatch";
import { keysOf, asLocalKey, type RoomKeyStr } from "../../lib/roomKey";
import type { MailAppHook } from "../../hooks/useMailApp";
import type { ChatConfig } from "../../types/mail";
import { ModalTabs, accountTabLabel } from "./shared";

type FilterToolAction = "group" | "hide" | "pin" | "move" | "delete" | "read" | "unread";
type FilterToolScreen = "list" | "conditions" | "orList" | "action" | "confirm";
type ThreeWay = "any" | "yes" | "no";

const TEXT_FIELD_LABELS: Record<TextField, string> = {
  recipientName: "相手の名前", recipientAddress: "相手のアドレス", subject: "件名", body: "本文",
};
const FILTER_BOX_LABELS: Record<FindBarBoxKey, string> = {
  inbox: "受信箱", archive: "アーカイブ", sent: "送信済み", spam: "迷惑メール", trash: "ゴミ箱",
};
const FILTER_ACTIONS: [FilterToolAction, string][] = [
  ["group", "作成"], ["hide", "非表示"], ["pin", "ピン留め"], ["move", "移動"], ["delete", "削除"], ["read", "既読"], ["unread", "未読"],
];
const MOVE_DEST_LABELS: Record<string, string> = { INBOX: "受信箱", ARCHIVE: "アーカイブ", SPAM: "迷惑メール", TRASH: "ゴミ箱" };
const FILTER_KIND_LABELS: Record<string, string> = { group: "グループ", hide: "非表示", pin: "ピン留め", move: "移動", delete: "削除", read: "既読", unread: "未読" };
const FILTER_ACTION_VERB: Record<string, string> = { hide: "非表示にする", pin: "ピン留めする", move: "移動する", delete: "削除する", read: "既読にする", unread: "未読にする" };

// chatConfigs の1行が「グループフィルター」か「アクションフィルター（継続のみ保存される）」かを判定する
function filterKindOf(cfg: ChatConfig | undefined): FilterToolAction | null {
  if (!cfg) return null;
  if (cfg.isGroup && cfg.filterCriteria) return "group";
  if (cfg.filterAction) return cfg.filterAction as FilterToolAction;
  return null;
}

// OR一覧画面で、各条件セットの中身を短い日本語で要約する
function summarizeConditionSet(set: ConditionSet): string {
  const parts: string[] = [];
  if (set.direction) parts.push(set.direction === "sent" ? "送信メールのみ" : "受信メールのみ");
  (set.textRules || []).forEach(r => {
    if (!r.keyword.trim()) return;
    const modeLabel = r.mode === "contains" ? "含む" : "含まない";
    parts.push(`${TEXT_FIELD_LABELS[r.field]}が「${r.keyword}」を${modeLabel}`);
  });
  if (set.dateRange) {
    const { from, to } = set.dateRange;
    parts.push(`期間: ${from || "…"}〜${to || "…"}`);
  }
  if (set.hasAttachment !== undefined) parts.push(`添付${set.hasAttachment ? "あり" : "なし"}`);
  if (set.isReply !== undefined) parts.push(`返信メール${set.isReply ? "" : "でない"}`);
  if (set.isForward !== undefined) parts.push(`転送メール${set.isForward ? "" : "でない"}`);
  if (set.format !== undefined) parts.push(set.format === "html" ? "HTMLメール" : "テキストメール");
  if (set.isUnread !== undefined) parts.push(set.isUnread ? "未読" : "既読");
  return parts.length > 0 ? parts.join("、") : "（条件なし＝すべてのメールに一致）";
}

function ThreeWayToggle({ label, value, onChange, yesLabel, noLabel }: {
  label: string; value: ThreeWay; onChange: (v: ThreeWay) => void; yesLabel: string; noLabel: string;
}) {
  return (
    <div>
      <div className="text-xs font-bold text-gray-400 mb-1">{label}</div>
      <div className="flex gap-1 text-[11px] font-bold">
        <button onClick={() => onChange("any")} className={`px-2.5 py-1 rounded ${value === "any" ? "bg-[#5865F2] text-white" : "bg-[#232428] text-gray-400 hover:bg-[#2f3136]"}`}>問わない</button>
        <button onClick={() => onChange("yes")} className={`px-2.5 py-1 rounded ${value === "yes" ? "bg-[#5865F2] text-white" : "bg-[#232428] text-gray-400 hover:bg-[#2f3136]"}`}>{yesLabel}</button>
        <button onClick={() => onChange("no")} className={`px-2.5 py-1 rounded ${value === "no" ? "bg-[#5865F2] text-white" : "bg-[#232428] text-gray-400 hover:bg-[#2f3136]"}`}>{noLabel}</button>
      </div>
    </div>
  );
}

// フィルターツール: 条件（受信/送信・宛先名/アドレス/件名/本文のキーワード・期間・添付有無・
// 返信/転送・HTML/テキスト）を組み合わせた「条件セット」をいくつでも追加でき（OR結合）、
// それとは別に保存場所（AND結合）で絞り込んだ上で、グループ化（常に動的・新着メールにも適用され続ける）、
// または非表示/ピン留め/移動/削除（1回限り、または継続＝Gmailのフィルターと同様に
// 新着メールにも自動で1回だけ適用され続ける）を行う。
// クリックすると、まず保存済みフィルター（グループ・継続アクション）の一覧画面が開き、
// 「作成」または各行の「編集」から、条件→OR一覧→アクション選択→確認、の4画面を進む。
export function FilterToolModal({ app }: { app: MailAppHook }) {
  const { modal, chatConfigs } = app.state;
  const active = modal?.type === "filter_tool" ? modal : null;

  const [screen, setScreen] = useState<FilterToolScreen>("list");
  const [editingId, setEditingId] = useState<RoomKeyStr | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<RoomKeyStr | null>(null);

  const [filterName, setFilterName] = useState("");
  const [action, setAction] = useState<FilterToolAction>("group");

  // OR結合される条件セット一覧（確定済み）と、今まさに編集中の1セット分のドラフト
  const [conditionSets, setConditionSets] = useState<ConditionSet[]>([]);
  const [editingSetIndex, setEditingSetIndex] = useState<number | null>(null);
  const [draftDirection, setDraftDirection] = useState<"any" | DateDirection>("any");
  const [textRules, setTextRules] = useState<TextRule[]>([]);
  const [dateEnabled, setDateEnabled] = useState(false);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [attachmentChoice, setAttachmentChoice] = useState<ThreeWay>("any");
  const [replyChoice, setReplyChoice] = useState<ThreeWay>("any");
  const [forwardChoice, setForwardChoice] = useState<ThreeWay>("any");
  const [formatChoice, setFormatChoice] = useState<"any" | "html" | "text">("any");
  // 未読（yes）か既読（no）か。問わないなら any
  const [unreadChoice, setUnreadChoice] = useState<ThreeWay>("any");

  const [groupBoxEnabled, setGroupBoxEnabled] = useState(false);
  const [groupBoxes, setGroupBoxes] = useState<FindBarBoxKey[]>([]);
  const [actionBoxes, setActionBoxes] = useState<FindBarBoxKey[]>([]);
  const [hideOriginal, setHideOriginal] = useState(false);
  const [continuous, setContinuous] = useState(false);
  const [destination, setDestination] = useState<string>("INBOX");
  const [includeExisting, setIncludeExisting] = useState(true);
  // このフィルターのアカウント。フィルターはアカウントごとに分けて保存し、そのアカウントのメールにだけ効く
  const [filterAccountEmail, setFilterAccountEmail] = useState("");
  // 受け取ったアドレスの条件（そのアカウントの自分のアドレスから複数選ぶ。空＝全アドレス。README §7.7）
  const [ownAddrFilter, setOwnAddrFilter] = useState<string[]>([]);
  // フィルターの一覧で開いているアカウントのタブ（空なら最初のアカウント）
  const [filterTab, setFilterTab] = useState("");

  const myEmail = app.auth?.session?.user?.email || "";
  // メールごとの自分のアドレス（受け取ったアドレスの条件・送受信の判定に使う）
  const ownContextOf = app.actions.ownContextOf;
  const linkedAccounts: string[] = app.state.linkedAccounts || [];

  const existingFilters = useMemo(() => {
    return keysOf(chatConfigs)
      .map(id => ({ id, cfg: chatConfigs[id], kind: filterKindOf(chatConfigs[id]) }))
      .filter(f => f.kind !== null);
  }, [chatConfigs]);

  const clearDraft = () => {
    setDraftDirection("any");
    setTextRules([]);
    setDateEnabled(false); setDateFrom(""); setDateTo("");
    setAttachmentChoice("any"); setReplyChoice("any"); setForwardChoice("any"); setFormatChoice("any"); setUnreadChoice("any");
  };

  const loadDraftFromSet = (set: ConditionSet) => {
    setDraftDirection(set.direction || "any");
    setTextRules(set.textRules ? set.textRules.map(r => ({ ...r })) : []);
    if (set.dateRange) {
      setDateEnabled(true); setDateFrom(set.dateRange.from || ""); setDateTo(set.dateRange.to || "");
    } else {
      setDateEnabled(false); setDateFrom(""); setDateTo("");
    }
    setAttachmentChoice(set.hasAttachment === undefined ? "any" : set.hasAttachment ? "yes" : "no");
    setReplyChoice(set.isReply === undefined ? "any" : set.isReply ? "yes" : "no");
    setForwardChoice(set.isForward === undefined ? "any" : set.isForward ? "yes" : "no");
    setFormatChoice(set.format || "any");
    setUnreadChoice(set.isUnread === undefined ? "any" : set.isUnread ? "yes" : "no");
  };

  const draftToConditionSet = (): ConditionSet => {
    const s: ConditionSet = {};
    if (draftDirection !== "any") s.direction = draftDirection;
    const validRules = textRules.filter(r => r.keyword.trim().length > 0);
    if (validRules.length > 0) s.textRules = validRules;
    if (dateEnabled && (dateFrom || dateTo)) s.dateRange = { from: dateFrom || undefined, to: dateTo || undefined };
    if (attachmentChoice !== "any") s.hasAttachment = attachmentChoice === "yes";
    if (replyChoice !== "any") s.isReply = replyChoice === "yes";
    if (forwardChoice !== "any") s.isForward = forwardChoice === "yes";
    if (formatChoice !== "any") s.format = formatChoice;
    if (unreadChoice !== "any") s.isUnread = unreadChoice === "yes";
    return s;
  };
  const isDraftEmpty = () => {
    const s = draftToConditionSet();
    return !s.direction && !s.textRules && !s.dateRange && s.hasAttachment === undefined && s.isReply === undefined && s.isForward === undefined && s.format === undefined && s.isUnread === undefined;
  };

  const resetBuilderFields = () => {
    setFilterName(`フィルター${existingFilters.length + 1}`);
    setAction("group");
    setConditionSets([]);
    setEditingSetIndex(null);
    clearDraft();
    setGroupBoxEnabled(false); setGroupBoxes([]);
    setActionBoxes([]);
    setHideOriginal(false); setContinuous(false); setDestination("INBOX"); setIncludeExisting(true);
    setFilterAccountEmail("");
    setOwnAddrFilter([]);
  };

  useEffect(() => {
    if (!active) return;
    setScreen("list");
    setEditingId(null);
    setDeleteConfirmId(null);
  }, [!!active]);

  // account：このフィルターを作るアカウント（フィルターの一覧で、どのアカウントの欄から作ったか）
  const openCreate = (account: string) => {
    setEditingId(null);
    resetBuilderFields();
    setFilterAccountEmail(account);
    setScreen("conditions");
  };

  const openEdit = (id: RoomKeyStr) => {
    const cfg = chatConfigs[id];
    if (!cfg) return;
    const kind = filterKindOf(cfg);
    if (!kind) return;
    setEditingId(id);
    setFilterName(cfg.customName || "");
    setAction(kind);
    const crit: FilterCriteria = cfg.filterCriteria || {};
    const sets = getConditionSets(crit);
    setConditionSets(sets.map(s => ({ ...s })));
    setEditingSetIndex(null);
    clearDraft();
    setGroupBoxEnabled(!!(crit.boxes && crit.boxes.length > 0));
    setGroupBoxes(crit.boxes ? [...crit.boxes] : []);
    setActionBoxes(crit.boxes ? [...crit.boxes] : []);
    setHideOriginal(!!cfg.filterHideOriginal);
    setContinuous(!!cfg.filterContinuous);
    setDestination(cfg.filterDestination || "INBOX");
    // フィルターは、それを保存しているアカウント（チャットのキーのアカウント）のもの
    setFilterAccountEmail(app.actions.roomAccountEmail(id));
    setOwnAddrFilter(Array.isArray(crit.ownAddresses) ? crit.ownAddresses.filter((a): a is string => typeof a === "string") : []);
    // 非グループ（1回限り/継続の実行時のみ意味を持つ）は保存していないため常にデフォルトへ戻す。
    // グループは filterIncludeExisting を保存しているのでそれを復元する（未指定なら含める＝デフォルト）
    setIncludeExisting(kind === "group" ? cfg.filterIncludeExisting !== false : true);
    setScreen("orList");
  };

  const handleSelectAction = (a: FilterToolAction) => {
    setAction(a);
    if (a !== "group") {
      setActionBoxes((Object.keys(FILTER_BOX_LABELS) as FindBarBoxKey[]).filter(b => !isActionBoxRestricted(a, b)));
    }
  };

  // 「条件」画面の「次へ」: 編集中のドラフトを確定してOR一覧画面へ
  const commitDraftAndGoToOrList = () => {
    const set = draftToConditionSet();
    const empty = isDraftEmpty();
    setConditionSets(prev => {
      const next = [...prev];
      if (editingSetIndex !== null) {
        if (empty) next.splice(editingSetIndex, 1);
        else next[editingSetIndex] = set;
      } else if (!empty) {
        next.push(set);
      }
      return next;
    });
    setEditingSetIndex(null);
    setScreen("orList");
  };

  const openAddConditionSet = () => {
    clearDraft();
    setEditingSetIndex(null);
    setScreen("conditions");
  };
  const openEditConditionSet = (index: number) => {
    loadDraftFromSet(conditionSets[index]);
    setEditingSetIndex(index);
    setScreen("conditions");
  };
  const deleteConditionSet = (index: number) => {
    setConditionSets(prev => prev.filter((_, i) => i !== index));
  };

  const updateRule = (index: number, updates: Partial<TextRule>) => {
    setTextRules(prev => prev.map((r, i) => (i === index ? { ...r, ...updates } : r)));
  };
  const removeRule = (index: number) => setTextRules(prev => prev.filter((_, i) => i !== index));

  // 保存場所を含まない、内容条件（OR結合された条件セット）＋対象アカウントのみのFilterCriteria。
  // 非グループアクションの保存場所チェックボックスの件数集計に、保存場所以外の条件だけを適用するために使う
  const criteriaWithoutBoxes: FilterCriteria = useMemo(
    () => ({ conditionSets, accountEmail: filterAccountEmail || undefined, ownAddresses: ownAddrFilter.length > 0 ? ownAddrFilter : undefined }),
    [conditionSets, filterAccountEmail, ownAddrFilter]
  );

  const boxCounts = useMemo(() => {
    const counts: Record<string, number> = { inbox: 0, archive: 0, sent: 0, spam: 0, trash: 0 };
    if (action === "group") return counts;
    app.computed.allUniqueEmails.forEach(e => {
      if (!messageMatchesFilter(e, criteriaWithoutBoxes, myEmail, ownContextOf(e))) return;
      const box = getFindBarBoxKey(e);
      counts[box] = (counts[box] || 0) + 1;
    });
    return counts;
  }, [action, criteriaWithoutBoxes, app.computed.allUniqueEmails, myEmail, ownContextOf]);

  const criteria: FilterCriteria = useMemo(() => {
    const c: FilterCriteria = { conditionSets };
    if (filterAccountEmail) c.accountEmail = filterAccountEmail;
    if (ownAddrFilter.length > 0) c.ownAddresses = ownAddrFilter;
    if (action === "group") {
      if (groupBoxEnabled && groupBoxes.length > 0) c.boxes = groupBoxes;
    } else if (actionBoxes.length > 0) {
      c.boxes = actionBoxes;
    }
    return c;
  }, [conditionSets, action, groupBoxEnabled, groupBoxes, actionBoxes, filterAccountEmail, ownAddrFilter]);

  const isNonGroupBoxesEmpty = action !== "group" && actionBoxes.length === 0;
  const isIncludeExistingDisabled = action !== "group" && !continuous;
  const isCriteriaEmpty = isEmptyFilterCriteria(criteria);
  const canExecute = !!filterName.trim() && !isCriteriaEmpty && !isNonGroupBoxesEmpty;

  const matchCount = useMemo(() => {
    if (isCriteriaEmpty) return 0;
    return app.computed.allUniqueEmails.filter(e => messageMatchesFilter(e, criteria, myEmail, ownContextOf(e))).length;
  }, [isCriteriaEmpty, criteria, app.computed.allUniqueEmails, myEmail, ownContextOf]);

  // 実行したとき今あるメールのうち何件に効くか（プレビュー）。削除は送信済み・自分が送ったメール・ゴミ箱のメールを
  // 対象にしない（applyDeleteToIds と同じ）ので、その分を除いて数える
  const affectedNowCount = useMemo(() => {
    if (isCriteriaEmpty || action === "group") return 0;
    if (continuous && !includeExisting) return 0;
    return app.computed.allUniqueEmails.filter(e => {
      if (!messageMatchesFilter(e, criteria, myEmail, ownContextOf(e))) return false;
      if (action === "delete" && (e.labelIds?.includes("TRASH") || e.labelIds?.includes("SENT") || e.isMe)) return false;
      // 既読・未読にするは、いまと違う状態のメールだけを数える（すでに既読のメールは「既読にする」の対象に入れない）
      if (action === "read" && !e.labelIds?.includes("UNREAD")) return false;
      if (action === "unread" && e.labelIds?.includes("UNREAD")) return false;
      return true;
    }).length;
  }, [isCriteriaEmpty, action, continuous, includeExisting, criteria, app.computed.allUniqueEmails, myEmail, ownContextOf]);

  const handleClose = () => app.actions.safeBack();

  const applyNonGroupAction = (ids: string[]) => {
    if (ids.length === 0) return;
    if (action === "hide") app.actions.applyHideToIds(ids);
    else if (action === "pin") app.actions.applyPinToIds(ids);
    else if (action === "move") app.actions.applyMoveToIds([{ ids, destination }]);
    else if (action === "delete") app.actions.applyDeleteToIds(ids);
    else if (action === "read" || action === "unread") app.actions.applyReadToIds(ids, action === "read");
  };

  const handlePrimary = () => {
    if (!canExecute) return;
    const name = filterName.trim();
    const existingKind = editingId ? filterKindOf(chatConfigs[editingId]) : null;
    // 対象アカウントを変えたら、保存する置き場所（そのアカウント）が変わるので、作り直す
    const accountChanged = !!editingId && (chatConfigs[editingId]?.filterCriteria?.accountEmail || "") !== (filterAccountEmail || "");

    if (action === "group") {
      if (editingId && existingKind === "group" && !accountChanged) {
        app.actions.updateChatConfigByRoomKey(editingId, { customName: name, filterCriteria: criteria, filterHideOriginal: hideOriginal, filterIncludeExisting: includeExisting, groupMode: "inbound_only" });
      } else {
        if (editingId) app.actions.deleteChatConfigByRoomKey(editingId);
        app.actions.createFilterGroup(name, criteria, hideOriginal, includeExisting);
      }
      app.actions.exitAfterAction();
      return;
    }

    const matchedIds = app.computed.allUniqueEmails.filter(e => messageMatchesFilter(e, criteria, myEmail, ownContextOf(e))).map(e => e.id);

    if (continuous) {
      const reuseId = !!editingId && existingKind === action && !accountChanged;
      if (editingId && !reuseId) app.actions.deleteChatConfigByRoomKey(editingId);
      const now = new Date().toISOString();
      const createdAt = reuseId ? (chatConfigs[editingId!]?.filterCreatedAt || now) : now;
      const updates = {
        customName: name, filterCriteria: criteria, filterAction: action, filterContinuous: true,
        filterDestination: action === "move" ? destination : undefined,
        filterCreatedAt: createdAt, filterLastAppliedAt: now,
      };
      if (reuseId) {
        // 既存フィルターの編集: chatConfigs のキーと同じ複合キー（editingId）をそのまま使う
        app.actions.updateChatConfigByRoomKey(editingId!, updates);
      } else {
        // 新規のローカルキーで、対象のアカウントの名義で作る（そのアカウントだけでログインしても使える。
        // 既存の複合キーではないため直接updateChatConfigを使う）
        const localId = `filter:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        app.actions.updateChatConfig(asLocalKey(localId), updates, filterAccountEmail || myEmail);
      }
      // 「これまでのメールを含める」がONの時だけ、保存時点で既に一致しているメールに即座に適用する。
      // OFFなら以降に届く新着メールだけが自動適用エンジン（filterLastAppliedAt=now）の対象になる
      if (includeExisting) applyNonGroupAction(matchedIds);
    } else {
      if (editingId) app.actions.deleteChatConfigByRoomKey(editingId);
      applyNonGroupAction(matchedIds);
    }
    app.actions.exitAfterAction();
  };

  if (!active) return null;

  if (screen === "list") {
    return (
      <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={handleClose}>
        <div className="bg-[#313338] rounded-lg shadow-2xl w-full max-w-md flex flex-col border border-[#1E1F22]" style={{ maxHeight: "85dvh" }} onClick={(e) => e.stopPropagation()}>
          <div className="p-4 border-b border-[#1E1F22] flex-shrink-0">
            <h2 className="text-lg font-bold text-white">フィルター</h2>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {/* ログインしているアカウントごとにタブで分ける。フィルターはアカウントごとに別々に保存し、そのアカウントのメールにだけ効く */}
            {(() => {
              const accounts = [myEmail, ...linkedAccounts].filter(Boolean);
              const sameAcc = (x: string, y: string) => x.toLowerCase() === y.toLowerCase();
              const acc = accounts.find(a => sameAcc(a, filterTab)) || accounts[0] || "";
              const filters = existingFilters.filter(f => sameAcc(app.actions.roomAccountEmail(f.id), acc));
              // ログアウトしたアカウントなどに残っているフィルターは、最初のアカウントのタブに出す（消せるように）
              if (acc === accounts[0]) filters.push(...existingFilters.filter(f => !accounts.some(a => sameAcc(app.actions.roomAccountEmail(f.id), a))));
              const profiles = app.state.linkedAccountProfiles as Record<string, { name?: string }>;
              const nameOf = (a: string) => a === myEmail ? (app.auth?.session?.user?.name || undefined) : profiles?.[a]?.name;
              return (
                <>
                  {accounts.length > 1 && (
                    <>
                      <ModalTabs tabs={accounts.map(a => ({ key: a, label: accountTabLabel(a, nameOf(a)), title: a }))} active={acc} onChange={setFilterTab} />
                      <div className="text-[11px] text-gray-500 truncate">{acc} のフィルター（このアカウントのメールにだけ効きます）</div>
                    </>
                  )}
                  <button
                    onClick={() => openCreate(acc)}
                    className="w-full text-left px-3 py-2.5 rounded bg-[#2B2D31] text-sm text-white hover:bg-[#35373C] transition font-bold"
                  >
                    ＋ 新しいフィルターを作成
                  </button>
                  {filters.length === 0 && (
                    <div className="text-xs text-gray-500 text-center py-6">保存されたフィルターはありません</div>
                  )}
                  {filters.map(({ id, cfg, kind }) => (
                    <div key={id} className="flex items-center justify-between gap-2 bg-[#232428] rounded p-2.5">
                      {deleteConfirmId === id ? (
                        <>
                          <span className="text-xs text-gray-300 flex-1">本当に削除しますか？</span>
                          <button onClick={() => { app.actions.deleteChatConfigByRoomKey(id); setDeleteConfirmId(null); }} className="text-xs font-bold text-red-400 hover:text-red-300 px-2 flex-shrink-0">はい</button>
                          <button onClick={() => setDeleteConfirmId(null)} className="text-xs font-bold text-gray-400 hover:text-white px-2 flex-shrink-0">いいえ</button>
                        </>
                      ) : (
                        <>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-bold text-white truncate">{cfg.customName || app.actions.roomLocalKey(id)}</div>
                            <div className="text-[11px] text-gray-500">{kind === "group" ? "グループ" : `${FILTER_KIND_LABELS[kind!]}・継続`}</div>
                          </div>
                          <button onClick={() => openEdit(id)} className="text-xs font-bold text-[#5865F2] hover:text-white px-2 flex-shrink-0">編集</button>
                          <button onClick={() => setDeleteConfirmId(id)} className="text-xs font-bold text-red-400 hover:text-red-300 px-2 flex-shrink-0">削除</button>
                        </>
                      )}
                    </div>
                  ))}
                </>
              );
            })()}
          </div>
          <div className="p-4 border-t border-[#1E1F22] flex justify-end flex-shrink-0">
            <button onClick={handleClose} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
          </div>
        </div>
      </div>
    );
  }

  if (screen === "orList") {
    return (
      <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={handleClose}>
        <div className="bg-[#313338] rounded-lg shadow-2xl w-full max-w-md flex flex-col border border-[#1E1F22]" style={{ maxHeight: "85dvh" }} onClick={(e) => e.stopPropagation()}>
          <div className="p-4 border-b border-[#1E1F22] flex items-center gap-3 flex-shrink-0">
            <button onClick={() => setScreen("list")} className="text-gray-400 hover:text-white font-bold text-lg transition">←</button>
            <h2 className="text-lg font-bold text-white flex-1">条件（OR）</h2>
          </div>

          <div className="px-4 pt-3 flex-shrink-0">
            <label className="text-xs font-bold text-gray-400 mb-1 block">名前</label>
            <input
              type="text"
              value={filterName}
              onChange={(e) => setFilterName(e.target.value)}
              placeholder="フィルター名を入力"
              className="w-full bg-[#1E1F22] text-sm text-white px-3 py-2 rounded focus:outline-none focus:ring-1 focus:ring-[#5865F2]"
            />
          </div>

          {/* フィルターはアカウントごと。どのアカウントのフィルターかを出す（アカウントが2つ以上のときだけ） */}
          {linkedAccounts.length > 0 && (
            <div className="px-4 pt-3 flex-shrink-0 text-[11px] text-gray-500 truncate">{filterAccountEmail} のフィルター（このアカウントのメールにだけ効きます）</div>
          )}
          {/* 受け取ったアドレス：アドレスが2つ以上あるアカウント（か、もう指定してあるとき）だけ出す。
              Gmail 側で消えた・受信専用から外れたアドレスは「見つからないアドレス」と出し、そのアドレスには効かない */}
          {(() => {
            const known = app.actions.ownAddressesFor(filterAccountEmail || myEmail);
            const missing = missingOwnAddresses({ ownAddresses: ownAddrFilter }, known);
            if (known.length < 2 && ownAddrFilter.length === 0) return null;
            const toggle = (addr: string) => setOwnAddrFilter(prev => prev.includes(addr) ? prev.filter(a => a !== addr) : [...prev, addr]);
            return (
              <div className="px-4 pt-3 flex-shrink-0">
                <div className="text-xs font-bold text-gray-400 mb-1">受け取ったアドレス（選ばなければすべてのアドレス）</div>
                <div className="flex flex-wrap gap-1 text-[11px] font-bold">
                  {known.map(addr => (
                    <button
                      key={addr}
                      onClick={() => toggle(addr)}
                      title={addr}
                      className={`px-2 py-1 rounded border transition truncate max-w-[220px] ${ownAddrFilter.includes(addr) ? "bg-[#2B2D31] border-[#4752C4] text-[#5865F2]" : "bg-[#1E1F22] border-[#1E1F22] text-gray-500 hover:text-gray-300"}`}
                    >
                      {addr}
                    </button>
                  ))}
                  {missing.map(addr => (
                    <button
                      key={addr}
                      onClick={() => toggle(addr)}
                      title={`${addr}（見つからないアドレス。押すと条件から外します）`}
                      className="px-2 py-1 rounded border border-red-500/40 bg-red-500/10 text-red-400 truncate max-w-[260px]"
                    >
                      {addr}（見つからないアドレス）
                    </button>
                  ))}
                </div>
              </div>
            );
          })()}

          <div className="flex-1 overflow-y-auto p-4 space-y-2">
            <div className="text-xs font-bold text-gray-400 mb-1">いずれか1つに一致すれば対象になります（OR）</div>
            {conditionSets.length === 0 && (
              <div className="text-xs text-gray-500 text-center py-4">条件がありません（保存場所の条件だけで絞り込む場合はそのままでも構いません）</div>
            )}
            {conditionSets.map((set, i) => (
              <div key={i} className="flex items-start justify-between gap-2 bg-[#232428] rounded p-2.5">
                <div className="text-xs text-gray-300 flex-1 min-w-0">{summarizeConditionSet(set)}</div>
                <div className="flex gap-2 flex-shrink-0">
                  <button onClick={() => openEditConditionSet(i)} className="text-xs font-bold text-[#5865F2] hover:text-white px-1">編集</button>
                  <button onClick={() => deleteConditionSet(i)} className="text-xs font-bold text-red-400 hover:text-red-300 px-1">削除</button>
                </div>
              </div>
            ))}
            <button
              onClick={openAddConditionSet}
              className="w-full text-left px-3 py-2 rounded bg-[#2B2D31] text-xs text-[#5865F2] hover:bg-[#35373C] transition font-bold"
            >
              ＋ 別の条件をOR追加
            </button>
          </div>

          <div className="p-4 border-t border-[#1E1F22] flex justify-end gap-3 flex-shrink-0">
            <button onClick={handleClose} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
            <button
              disabled={!filterName.trim()}
              onClick={() => setScreen("action")}
              className="px-4 py-2 bg-[#5865F2] text-white rounded text-sm font-bold hover:bg-[#4752C4] disabled:bg-[#3f4147] disabled:text-gray-500 transition"
            >
              次へ
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (screen === "action") {
    return (
      <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={handleClose}>
        <div className="bg-[#313338] rounded-lg shadow-2xl w-full max-w-md flex flex-col border border-[#1E1F22]" style={{ maxHeight: "85dvh" }} onClick={(e) => e.stopPropagation()}>
          <div className="p-4 border-b border-[#1E1F22] flex items-center gap-3 flex-shrink-0">
            <button onClick={() => setScreen("orList")} className="text-gray-400 hover:text-white font-bold text-lg transition">←</button>
            <h2 className="text-lg font-bold text-white flex-1">アクションを選択</h2>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            <div className="flex flex-wrap gap-1.5">
              {FILTER_ACTIONS.map(([a, label]) => (
                <button
                  key={a}
                  onClick={() => handleSelectAction(a)}
                  className={`px-3 py-2 rounded text-sm font-bold transition ${action === a ? "bg-[#5865F2] text-white" : "bg-[#232428] text-gray-400 hover:bg-[#2f3136]"}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="p-4 border-t border-[#1E1F22] flex justify-end gap-3 flex-shrink-0">
            <button onClick={handleClose} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
            <button
              onClick={() => setScreen("confirm")}
              className="px-4 py-2 bg-[#5865F2] text-white rounded text-sm font-bold hover:bg-[#4752C4] transition"
            >
              次へ
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (screen === "confirm") {
    const primaryLabel = action === "group" ? (editingId ? "保存" : "チャットを作成する") : FILTER_ACTION_VERB[action];
    return (
      <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={handleClose}>
        <div className="bg-[#313338] rounded-lg shadow-2xl w-full max-w-md flex flex-col border border-[#1E1F22]" style={{ maxHeight: "85dvh" }} onClick={(e) => e.stopPropagation()}>
          <div className="p-4 border-b border-[#1E1F22] flex items-center gap-3 flex-shrink-0">
            <button onClick={() => setScreen("action")} className="text-gray-400 hover:text-white font-bold text-lg transition">←</button>
            <h2 className="text-lg font-bold text-white flex-1">確認</h2>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-5">
            {action === "group" && (
              <>
                <div>
                  <label className="flex items-center gap-2 cursor-pointer mb-1.5">
                    <input type="checkbox" checked={groupBoxEnabled} onChange={(e) => setGroupBoxEnabled(e.target.checked)} className="accent-[#5865F2]" />
                    <span className="text-xs font-bold text-gray-400">保存場所で絞り込む（任意）</span>
                  </label>
                  {groupBoxEnabled && (
                    <div className="flex flex-wrap gap-1 pl-6">
                      {(Object.keys(FILTER_BOX_LABELS) as FindBarBoxKey[]).map(key => (
                        <label key={key} className="flex items-center gap-1 text-[11px] font-bold bg-[#232428] px-2 py-1 rounded cursor-pointer">
                          <input type="checkbox" checked={groupBoxes.includes(key)} onChange={() => setGroupBoxes(prev => prev.includes(key) ? prev.filter(b => b !== key) : [...prev, key])} className="accent-[#5865F2]" />
                          {FILTER_BOX_LABELS[key]}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
                <label className="flex items-center gap-3 cursor-pointer hover:bg-[#2B2D31] p-2 rounded transition text-sm text-gray-200">
                  <input type="checkbox" checked={hideOriginal} onChange={(e) => setHideOriginal(e.target.checked)} className="accent-[#5865F2] w-4 h-4" />
                  元のメッセージを個別チャットから非表示にする
                </label>
                <div className="text-xs text-gray-500">現時点で{matchCount}件のメールがこのグループに含まれます</div>
              </>
            )}

            {action !== "group" && (
              <>
                <div>
                  <div className="text-xs font-bold text-gray-400 mb-1.5">保存場所（対象）</div>
                  <div className="space-y-1">
                    {(Object.keys(FILTER_BOX_LABELS) as FindBarBoxKey[]).map(box => {
                      const restricted = isActionBoxRestricted(action, box);
                      const checked = actionBoxes.includes(box);
                      const count = boxCounts[box] || 0;
                      return (
                        <label
                          key={box}
                          className={`flex items-center justify-between gap-2 p-2 rounded border ${restricted ? "opacity-40 border-transparent bg-[#1E1F22] cursor-not-allowed" : checked ? "border-[#5865F2] bg-[#5865F2]/10 cursor-pointer" : "border-[#35373C] bg-[#1E1F22] cursor-pointer"}`}
                        >
                          <span className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={restricted}
                              onChange={() => setActionBoxes(prev => prev.includes(box) ? prev.filter(b => b !== box) : [...prev, box])}
                              className="accent-[#5865F2] w-4 h-4"
                            />
                            <span className={`text-xs font-bold ${restricted ? "text-gray-600" : "text-gray-200"}`}>{FILTER_BOX_LABELS[box]}</span>
                          </span>
                          <span className={`text-xs font-bold ${restricted ? "text-gray-600" : "text-[#5865F2]"}`}>{restricted ? "対象外" : `${count}件`}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>

                {action === "move" && (
                  <div>
                    <label className="text-xs font-bold text-gray-400 mb-1.5 block">移動先</label>
                    <div className="flex flex-wrap gap-1.5">
                      {(["INBOX", "ARCHIVE", "SPAM", "TRASH"] as const).map(dest => (
                        <button
                          key={dest}
                          onClick={() => setDestination(dest)}
                          className={`px-3 py-1.5 rounded text-sm font-bold ${destination === dest ? "bg-[#5865F2] text-white" : "bg-[#232428] text-gray-400 hover:bg-[#2f3136]"}`}
                        >
                          {MOVE_DEST_LABELS[dest]}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div>
                  <div className="text-xs font-bold text-gray-400 mb-1.5">実行方法</div>
                  <div className="flex gap-1 text-[11px] font-bold">
                    <button onClick={() => setContinuous(false)} className={`px-2.5 py-1 rounded ${!continuous ? "bg-[#5865F2] text-white" : "bg-[#232428] text-gray-400 hover:bg-[#2f3136]"}`}>1回限り</button>
                    <button onClick={() => setContinuous(true)} className={`px-2.5 py-1 rounded ${continuous ? "bg-[#5865F2] text-white" : "bg-[#232428] text-gray-400 hover:bg-[#2f3136]"}`}>継続</button>
                  </div>
                  {continuous && <div className="text-[11px] text-gray-500 mt-1">フィルターとして保存され、新着メールにも自動的に1回だけ適用されます</div>}
                </div>

                <div className={isIncludeExistingDisabled ? "opacity-40 pointer-events-none" : ""}>
                  <div className="text-xs font-bold text-gray-400 mb-1.5">これまでのメール</div>
                  <div className="flex gap-1 text-[11px] font-bold">
                    <button onClick={() => setIncludeExisting(true)} className={`px-2.5 py-1 rounded ${includeExisting ? "bg-[#5865F2] text-white" : "bg-[#232428] text-gray-400 hover:bg-[#2f3136]"}`}>含める</button>
                    <button onClick={() => setIncludeExisting(false)} className={`px-2.5 py-1 rounded ${!includeExisting ? "bg-[#5865F2] text-white" : "bg-[#232428] text-gray-400 hover:bg-[#2f3136]"}`}>含めない</button>
                  </div>
                  <div className="text-[11px] text-gray-500 mt-1">
                    {isIncludeExistingDisabled ? "1回限りの実行では常に、今すでに条件に一致しているメールが対象になります" : "「含めない」を選ぶと、これから届く新着メールだけが対象になります"}
                  </div>
                </div>

                {/* 実行前のプレビュー。「含めない」なら今あるメールには何もしないことを、継続なら新着にも効くことを書く */}
                <div className="text-xs text-gray-500 pt-1 space-y-0.5">
                  {isNonGroupBoxesEmpty ? "保存場所を選択してください" : (
                    <>
                      <div className={affectedNowCount > 0 && action === "delete" ? "text-red-400 font-bold" : ""}>
                        {continuous && !includeExisting
                          ? `今あるメールには何もしません（条件に合うもの: ${matchCount}件）`
                          : `読み込み済みのメールのうち${affectedNowCount}件を${action === "move" ? `${MOVE_DEST_LABELS[destination]}へ` : ""}${FILTER_ACTION_VERB[action]}`}
                      </div>
                      {action === "delete" && <div>削除したメールはゴミ箱へ移ります（送信済みのメールは対象外）</div>}
                      {continuous && <div>これから届く、条件に合うメールも自動で{action === "move" ? `${MOVE_DEST_LABELS[destination]}へ` : ""}{FILTER_ACTION_VERB[action]}</div>}
                    </>
                  )}
                </div>
              </>
            )}
          </div>

          <div className="p-4 border-t border-[#1E1F22] flex justify-end gap-3 flex-shrink-0">
            <button onClick={handleClose} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
            <button
              disabled={!canExecute}
              onClick={handlePrimary}
              className="px-4 py-2 bg-[#5865F2] text-white rounded text-sm font-bold hover:bg-[#4752C4] disabled:bg-[#3f4147] disabled:text-gray-500 transition"
            >
              {primaryLabel}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // screen === "conditions"
  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={handleClose}>
      <div
        className="bg-[#313338] rounded-lg shadow-2xl w-full max-w-2xl flex flex-col border border-[#1E1F22]"
        style={{ maxHeight: "85dvh" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-[#1E1F22] flex items-center gap-3 flex-shrink-0">
          <button onClick={() => setScreen((conditionSets.length > 0 || editingSetIndex !== null) ? "orList" : "list")} className="text-gray-400 hover:text-white font-bold text-lg transition">←</button>
          <h2 className="text-lg font-bold text-white flex-1">{editingSetIndex !== null ? "条件を編集" : "条件を追加"}</h2>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {linkedAccounts.length > 0 && (
            <div className="text-[11px] text-gray-500 truncate">{filterAccountEmail} のフィルター（このアカウントのメールにだけ効きます）</div>
          )}

          {/* 方向: このセット全体を受信/送信メールに絞り込む（テキスト条件・期間などすべてに共通で適用される） */}
          <div>
            <label className="text-xs font-bold text-gray-400 mb-1.5 block">方向</label>
            <div className="flex gap-1 text-[11px] font-bold">
              <button onClick={() => setDraftDirection("any")} className={`px-2.5 py-1 rounded ${draftDirection === "any" ? "bg-[#5865F2] text-white" : "bg-[#232428] text-gray-400 hover:bg-[#2f3136]"}`}>問わない</button>
              <button onClick={() => setDraftDirection("received")} className={`px-2.5 py-1 rounded ${draftDirection === "received" ? "bg-[#5865F2] text-white" : "bg-[#232428] text-gray-400 hover:bg-[#2f3136]"}`}>受信</button>
              <button onClick={() => setDraftDirection("sent")} className={`px-2.5 py-1 rounded ${draftDirection === "sent" ? "bg-[#5865F2] text-white" : "bg-[#232428] text-gray-400 hover:bg-[#2f3136]"}`}>送信</button>
            </div>
            <div className="text-[11px] text-gray-500 mt-1">受信/送信を選ぶと、下のテキスト条件・期間などすべてがそのメールだけに適用されます</div>
          </div>

          {/* テキスト条件 */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-bold text-gray-400">テキスト条件</label>
              <button
                onClick={() => setTextRules(prev => [...prev, { field: "subject", mode: "contains", keyword: "" }])}
                className="text-xs font-bold text-[#5865F2] hover:text-white transition"
              >
                ＋条件を追加
              </button>
            </div>
            <div className="space-y-1.5">
              {textRules.map((rule, i) => (
                <div key={i} className="flex items-center gap-1.5 bg-[#232428] rounded p-2 flex-wrap">
                  <select
                    value={rule.field}
                    onChange={(e) => updateRule(i, { field: e.target.value as TextField })}
                    className="bg-[#1E1F22] text-xs text-gray-200 rounded px-1.5 py-1.5 flex-shrink-0"
                  >
                    {(Object.keys(TEXT_FIELD_LABELS) as TextField[]).map(f => <option key={f} value={f}>{TEXT_FIELD_LABELS[f]}</option>)}
                  </select>
                  <select
                    value={rule.mode}
                    onChange={(e) => updateRule(i, { mode: e.target.value as TextRule["mode"] })}
                    className="bg-[#1E1F22] text-xs text-gray-200 rounded px-1.5 py-1.5 flex-shrink-0"
                  >
                    <option value="contains">含む</option>
                    <option value="not_contains">含まない</option>
                  </select>
                  <input
                    type="text"
                    value={rule.keyword}
                    onChange={(e) => updateRule(i, { keyword: e.target.value })}
                    placeholder="キーワード"
                    className="flex-1 min-w-0 bg-[#1E1F22] text-xs text-gray-200 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-[#5865F2]"
                  />
                  <button onClick={() => removeRule(i)} className="text-gray-500 hover:text-white font-bold px-1 flex-shrink-0">×</button>
                </div>
              ))}
              {textRules.length === 0 && <div className="text-xs text-gray-500 px-1">条件はまだありません</div>}
            </div>
          </div>

          {/* 期間 */}
          <div>
            <label className="flex items-center gap-2 cursor-pointer mb-1.5">
              <input type="checkbox" checked={dateEnabled} onChange={(e) => setDateEnabled(e.target.checked)} className="accent-[#5865F2]" />
              <span className="text-xs font-bold text-gray-400">期間</span>
            </label>
            {dateEnabled && (
              <div className="flex flex-wrap items-center gap-2 pl-6">
                <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="bg-[#1E1F22] text-xs text-gray-200 rounded px-2 py-1.5" />
                <span className="text-xs text-gray-500">〜</span>
                <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="bg-[#1E1F22] text-xs text-gray-200 rounded px-2 py-1.5" />
              </div>
            )}
          </div>

          {/* 添付ファイル・返信・転送・HTML/テキスト */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <ThreeWayToggle label="添付ファイル" value={attachmentChoice} onChange={setAttachmentChoice} yesLabel="あり" noLabel="なし" />
            <ThreeWayToggle label="返信メール" value={replyChoice} onChange={setReplyChoice} yesLabel="はい" noLabel="いいえ" />
            <ThreeWayToggle label="転送メール" value={forwardChoice} onChange={setForwardChoice} yesLabel="はい" noLabel="いいえ" />
            <ThreeWayToggle label="未読・既読" value={unreadChoice} onChange={setUnreadChoice} yesLabel="未読" noLabel="既読" />
            <div>
              <div className="text-xs font-bold text-gray-400 mb-1">形式</div>
              <div className="flex gap-1 text-[11px] font-bold">
                <button onClick={() => setFormatChoice("any")} className={`px-2.5 py-1 rounded ${formatChoice === "any" ? "bg-[#5865F2] text-white" : "bg-[#232428] text-gray-400 hover:bg-[#2f3136]"}`}>問わない</button>
                <button onClick={() => setFormatChoice("html")} className={`px-2.5 py-1 rounded ${formatChoice === "html" ? "bg-[#5865F2] text-white" : "bg-[#232428] text-gray-400 hover:bg-[#2f3136]"}`}>HTML</button>
                <button onClick={() => setFormatChoice("text")} className={`px-2.5 py-1 rounded ${formatChoice === "text" ? "bg-[#5865F2] text-white" : "bg-[#232428] text-gray-400 hover:bg-[#2f3136]"}`}>テキスト</button>
              </div>
            </div>
          </div>
        </div>

        <div className="p-4 border-t border-[#1E1F22] flex justify-end gap-3 flex-shrink-0">
          <button onClick={handleClose} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
          <button
            onClick={commitDraftAndGoToOrList}
            className="px-4 py-2 bg-[#5865F2] text-white rounded text-sm font-bold hover:bg-[#4752C4] transition"
          >
            次へ
          </button>
        </div>
      </div>
    </div>
  );
}
