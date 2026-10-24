import { useState, useRef, useEffect, useMemo } from "react";
import { HighlightText } from "../ui";
import { shouldTriggerServerSearch, markServerSearched } from "../../lib/searchFallback";
import type { RoomKeyStr } from "../../lib/roomKey";
import type { MailAppHook } from "../../hooks/useMailApp";
import type { Email } from "../../types/email";
import { type BoxKey, SEARCH_BOX_LABELS, getSearchBoxInfo } from "./shared";

// 入力欄の「返信元を選択」。上に検索モーダルと同じ形の検索（タブ・並び替え・場所の絞り込み・2文字以上で0件ならサーバー検索。
// 同じ語で二度撃たない）を置き、その下に今のチャットのメールを出す。選べるのは送信元と同じアカウントのメールだけ
// （ほかのチャットのメールも選べる）。選んでも開いているチャットは変わらない
type ReplySearchTab = "all" | "recipient" | "address" | "subject" | "body";
const REPLY_SEARCH_RESULT_LIMIT = 100;

export function ReplyTargetModal({ app }: { app: MailAppHook }) {
  const { selectedSender, chatConfigs, checkInbox, checkArchive, checkSpam, checkTrash, checkSent } = app.state;
  const { safeBack, openEmailModal, chooseReplyTarget, roomAccountEmail, roomLocalKey } = app.actions;
  const { allUniqueEmails, groupedEmails, contactDirectory, emailRoomMap, groupReplyPools } = app.computed;
  const account = selectedSender ? roomAccountEmail(selectedSender) : "";

  const [keyword, setKeyword] = useState("");
  const [tab, setTab] = useState<ReplySearchTab>("all");
  const [sortOrder, setSortOrder] = useState<"newest" | "oldest">("newest");
  const [boxFilter, setBoxFilter] = useState<Record<BoxKey, boolean>>({ inbox: checkInbox, archive: checkArchive, sent: checkSent, spam: checkSpam, trash: checkTrash });
  const [isServerSearching, setIsServerSearching] = useState(false);
  const searchedRef = useRef<Set<string>>(new Set());
  const kw = keyword.trim().toLowerCase();

  // 送信元と同じアカウントのメールだけ
  const accountEmails = useMemo(
    () => (allUniqueEmails as Email[]).filter(e => (e.accountId || app.auth.session?.user?.email || "").toLowerCase() === account.toLowerCase()),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- セッションのアドレスは開いている間は変わらない
    [allUniqueEmails, account],
  );
  const contactOf = useMemo(() => new Map(contactDirectory.map(c => [c.room, c])), [contactDirectory]);
  const roomLabel = (room: RoomKeyStr | undefined) => (room ? (contactOf.get(room)?.label || chatConfigs[room]?.customName || roomLocalKey(room)) : "");
  const roomAddress = (room: RoomKeyStr | undefined) => (room ? contactOf.get(room)?.address || "" : "");

  const matchField = (e: Email, field: Exclude<ReplySearchTab, "all">): boolean => {
    const room = emailRoomMap.get(e.id);
    if (field === "subject") return (e.subject || "").toLowerCase().includes(kw);
    if (field === "body") return (e.body || "").toLowerCase().includes(kw);
    if (field === "recipient") return roomLabel(room).toLowerCase().includes(kw) || (e.from || "").split("<")[0].toLowerCase().includes(kw);
    return roomAddress(room).toLowerCase().includes(kw) || (e.from || "").toLowerCase().includes(kw);
  };
  const results = useMemo(() => {
    if (!kw) return [] as Email[];
    const fields: Exclude<ReplySearchTab, "all">[] = tab === "all" ? ["recipient", "address", "subject", "body"] : [tab];
    const list = accountEmails.filter(e => boxFilter[getSearchBoxInfo(e).key] && fields.some(f => matchField(e, f)));
    list.sort((a, b) => sortOrder === "oldest" ? new Date(a.date).getTime() - new Date(b.date).getTime() : new Date(b.date).getTime() - new Date(a.date).getTime());
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- matchField は描画ごとに作り直されるが、中で使う値は依存に入れてある
  }, [kw, tab, sortOrder, boxFilter, accountEmails, emailRoomMap, contactOf]);

  // 読み込み済みのメールで0件のとき（2文字以上）だけ、送信元のアカウントの Gmail を件名・本文で検索する。同じ語では二度撃たない
  const subjectCount = useMemo(() => (kw ? accountEmails.filter(e => (e.subject || "").toLowerCase().includes(kw)).length : 0), [kw, accountEmails]);
  const bodyCount = useMemo(() => (kw ? accountEmails.filter(e => (e.body || "").toLowerCase().includes(kw)).length : 0), [kw, accountEmails]);
  useEffect(() => {
    if (!kw || kw.length < 2 || !account) return;
    if (tab !== "all" && tab !== "subject" && tab !== "body") return;
    const searchKw = `${account.toLowerCase()}|${kw}`;
    const needSubject = shouldTriggerServerSearch(searchedRef.current, searchKw, "subject", subjectCount);
    const needBody = shouldTriggerServerSearch(searchedRef.current, searchKw, "body", bodyCount);
    if (!needSubject && !needBody) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      if (needSubject) markServerSearched(searchedRef.current, searchKw, "subject");
      if (needBody) markServerSearched(searchedRef.current, searchKw, "body");
      setIsServerSearching(true);
      try {
        await Promise.all([
          needSubject ? app.actions.searchServerSide(keyword, "subject", account) : Promise.resolve([]),
          needBody ? app.actions.searchServerSide(keyword, "body", account) : Promise.resolve([]),
        ]);
      } finally {
        if (!cancelled) setIsServerSearching(false);
      }
    }, 500);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 検索語・タブ・件数が変わったときだけ判定する（searchServerSide は描画ごとに作り直される）
  }, [kw, tab, subjectCount, bodyCount, account]);

  if (!selectedSender) return null;
  const isGroup = chatConfigs[selectedSender]?.isGroup;
  const source = isGroup ? (groupReplyPools[selectedSender] || []) : (groupedEmails[selectedSender] || []);
  const currentMsgs = (source as Email[]).slice().sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const renderRow = (m: Email, showRoom: boolean) => {
    // 送信直後でまだ Gmail の ID が無いメール・読み込めていないメールは返信元にできない（スレッドと引用が作れないため）
    const selectable = !m.id.startsWith("fake-") && !m.isMissing;
    const room = emailRoomMap.get(m.id);
    return (
      <div key={m.id} className="flex items-center gap-2 p-2 hover:bg-[#2B2D31] rounded">
        <div className="flex-1 min-w-0 text-sm">
          <div className="text-gray-400 text-[11px] truncate">
            {new Date(m.date).toLocaleString("ja-JP")}{showRoom && room && room !== selectedSender ? `・${roomLabel(room)}` : ""}・{getSearchBoxInfo(m).name}
          </div>
          <div className="text-gray-200 truncate">{kw ? <HighlightText text={m.subject || m.snippet || "(件名なし)"} highlight={keyword} /> : (m.subject || m.snippet || "(件名なし)")}</div>
          {!selectable && <div className="text-[11px] text-gray-500">送信直後・読み込めていないメールは選べません</div>}
        </div>
        <button
          disabled={!selectable}
          onClick={() => { chooseReplyTarget(m); safeBack(); }}
          className="px-3 py-1.5 bg-[#5865F2] hover:bg-[#4752C4] text-white text-xs font-bold rounded flex-shrink-0 disabled:bg-gray-600 disabled:text-gray-400"
        >
          選択
        </button>
        <button onClick={() => openEmailModal(m)} className="px-3 py-1.5 bg-[#1E1F22] hover:bg-[#3f4147] text-gray-200 text-xs font-bold rounded flex-shrink-0">詳細</button>
      </div>
    );
  };

  const TABS: [ReplySearchTab, string][] = [["all", "すべて"], ["recipient", "宛先名"], ["address", "アドレス"], ["subject", "件名"], ["body", "本文"]];
  return (
    <div className="flex flex-col max-h-[80vh]">
      <div className="p-4 border-b border-[#1E1F22]">
        <h2 className="text-lg font-bold text-white">返信元を選択</h2>
        <p className="text-[11px] text-gray-400 mt-1 truncate">{account} のメールから選べます。選んでも開いているチャットは変わりません</p>
        <input
          type="text"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="ほかのチャットのメールを検索..."
          className="w-full mt-2 bg-[#1E1F22] text-sm text-gray-200 px-3 py-1.5 rounded focus:outline-none focus:ring-1 focus:ring-[#5865F2]"
        />
        {kw && (
          <>
            <div className="flex gap-1 mt-2 overflow-x-auto scrollbar-none">
              {TABS.map(([t, label]) => (
                <button key={t} onClick={() => setTab(t)} className={`px-2.5 py-1 rounded text-xs font-bold transition flex-shrink-0 ${tab === t ? "bg-[#5865F2] text-white" : "bg-[#232428] text-gray-400 hover:bg-[#3f4147]"}`}>{label}</button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-1 mt-2 text-[11px] font-bold">
              <button onClick={() => setSortOrder("newest")} className={`px-2 py-1 rounded ${sortOrder === "newest" ? "bg-[#5865F2] text-white" : "bg-[#232428] text-gray-400 hover:bg-[#3f4147]"}`}>新しい順</button>
              <button onClick={() => setSortOrder("oldest")} className={`px-2 py-1 rounded ${sortOrder === "oldest" ? "bg-[#5865F2] text-white" : "bg-[#232428] text-gray-400 hover:bg-[#3f4147]"}`}>古い順</button>
              {(Object.keys(SEARCH_BOX_LABELS) as BoxKey[]).map(key => (
                <label key={key} className="flex items-center gap-1 cursor-pointer bg-[#232428] px-2 py-1 rounded hover:bg-[#3f4147]">
                  <input type="checkbox" checked={boxFilter[key]} onChange={(e) => setBoxFilter(prev => ({ ...prev, [key]: e.target.checked }))} className="accent-[#5865F2]" />
                  {SEARCH_BOX_LABELS[key]}
                </label>
              ))}
            </div>
          </>
        )}
      </div>
      <div className="p-2 overflow-y-auto flex-1 space-y-1">
        {kw && (
          <div className="mb-3">
            <div className="text-xs font-bold text-gray-400 px-2 mb-1">検索結果 ({results.length}件)</div>
            {isServerSearching && <div className="text-center text-xs text-[#5865F2] font-bold py-1 animate-pulse">Gmail から検索中...</div>}
            {results.slice(0, REPLY_SEARCH_RESULT_LIMIT).map(m => renderRow(m, true))}
            {results.length > REPLY_SEARCH_RESULT_LIMIT && <div className="text-[11px] text-gray-500 px-2">ほか{results.length - REPLY_SEARCH_RESULT_LIMIT}件。語を足して絞り込んでください</div>}
            {results.length === 0 && !isServerSearching && <div className="text-gray-500 text-xs p-2">見つかりませんでした</div>}
          </div>
        )}
        <div className="text-xs font-bold text-gray-400 px-2 mb-1">このチャットのメール</div>
        {currentMsgs.map(m => renderRow(m, false))}
        {currentMsgs.length === 0 && <div className="text-gray-500 text-sm p-4 text-center">このチャットにはまだメッセージがありません</div>}
      </div>
      <div className="p-4 border-t border-[#1E1F22] flex justify-end">
        <button onClick={() => safeBack()} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
      </div>
    </div>
  );
}
