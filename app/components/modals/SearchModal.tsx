import { useState, useRef, useEffect, useMemo } from "react";
import { HighlightText } from "../ui";
import { shouldTriggerServerSearch, markServerSearched } from "../../lib/searchFallback";
import { encodeRoomKey, decodeRoomKey, keysOf, type RoomKeyStr } from "../../lib/roomKey";
import type { MailAppHook } from "../../hooks/useMailApp";
import type { Email } from "../../types/email";
import { type BoxKey, SEARCH_BOX_LABELS, getSearchBoxInfo } from "./shared";

type SearchTab = "all" | "recipient" | "address" | "subject" | "body";
type SearchSort = "newest" | "oldest" | "kana";

// 検索結果一覧: チャット画面の検索ボタンから開かれる（すべて/宛先名/アドレス/件名/本文の5タブ）。
// メッセージ画面の検索は、このモーダルを経由せずメッセージ画面上部の検索バー（Ctrl+F風）で直接行う。
// 既に読み込み済みのデータ(allUniqueEmails/groupedEmails)のみを対象にしたクライアント側検索で、
// Gmailへの再取得は行わない。
export function SearchModal({ app }: { app: MailAppHook }) {
  const { modal, chatConfigs, messageConfigs, checkInbox, checkArchive, checkSpam, checkTrash, checkSent, checkAccounts, linkedAccounts, linkedAccountProfiles, useIconLabels } = app.state;
  const { setModal, safeBack, openChat, jumpToSearchResult, messageConfigKey } = app.actions;
  const { allUniqueEmails, groupedEmails, contactDirectory } = app.computed;
  const { session } = app.auth;

  const active = modal?.type === "search" ? modal : null;
  const mainEmail = session?.user?.email || "";
  const searchAccountList: string[] = [mainEmail, ...linkedAccounts];

  const [keyword, setKeyword] = useState("");
  const [activeTab, setActiveTab] = useState<SearchTab>("all");
  const [sortOrder, setSortOrder] = useState<SearchSort>("newest");
  const [boxFilter, setBoxFilter] = useState<Record<BoxKey, boolean>>({
    inbox: checkInbox, archive: checkArchive, sent: checkSent, spam: checkSpam, trash: checkTrash,
  });
  // タブごとに独立させず、検索モーダル内で共有するアカウント別チェックボックス（宛先名/アドレス/件名/本文いずれの
  // 絞り込みにも同じ集合を使う）。開いた瞬間は現在のサイドバーの表示設定を初期値として引き継ぐ
  const [accountFilter, setAccountFilter] = useState<Record<string, boolean>>(checkAccounts);
  const isAccountFilterVisible = (acct?: string) => accountFilter[acct || mainEmail] !== false;
  // すべてタブで各カテゴリー6件目以降を折りたたむかどうか（カテゴリーキーごと）
  const [expandedAllSections, setExpandedAllSections] = useState<Record<string, boolean>>({});

  const inputRef = useRef<HTMLInputElement>(null);
  // サーバー検索フォールバックを既に試した「キーワード::対象フィールド」の組み合わせを記録する。
  // subjectMatches/bodyMatchesは0件のままでも、allUniqueEmailsが（このサーバー検索以外の理由、例:
  // 60秒ごとのバックグラウンド再取得で）更新されるたびに新しい配列参照になり useEffect の依存配列
  // （.lengthは変わらなくても念のため）を再評価しうるため、同じキーワードに対してGmailへの
  // クォータを消費する検索を何度も撃たないよう、実行済みの組み合わせはここで確実にスキップする
  const searchedServerKeywordsRef = useRef<Set<string>>(new Set());

  // モーダルが開いた瞬間にタブとキーワードを初期化し、入力欄にフォーカスする
  useEffect(() => {
    if (!active) return;
    setKeyword("");
    setActiveTab("all");
    setSortOrder("newest");
    setExpandedAllSections({});
    setAccountFilter(checkAccounts);
    searchedServerKeywordsRef.current.clear();
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!active]);

  const kwLower = keyword.trim().toLowerCase();

  const roomInfos = useMemo(() => {
    const infos: { room: RoomKeyStr; label: string; originalName: string; address: string | null; isGroup: boolean; latestDate: number; accountEmail: string }[] = [];

    // 通常グループ作成時に「個別チャットの表示設定」をオフにして非表示にした宛先は、
    // その人自身のroomはもう一覧に出ないが、グループ自体が非表示でない限り宛先名/アドレスでの
    // 検索対象からも外れるべきではない（吸収先のグループを検索結果として開けるようにする）
    const hiddenMemberGroup = new Map<string, RoomKeyStr>();
    keysOf(chatConfigs).forEach(room => {
      const cfg = chatConfigs[room];
      if (cfg?.isGroup && !cfg.filterCriteria && !cfg.isHidden && cfg.groupHiddenMembers?.length) {
        const { accountEmail } = decodeRoomKey(room);
        cfg.groupHiddenMembers.forEach((localKey: string) => {
          hiddenMemberGroup.set(encodeRoomKey(accountEmail, localKey), room);
        });
      }
    });

    contactDirectory.forEach(c => {
      if (chatConfigs[c.room]?.isHidden) {
        const groupRoom = hiddenMemberGroup.get(c.room);
        // グループ化以外の理由で非表示にした宛先は、従来通り検索対象から除外する
        if (!groupRoom) return;
        infos.push({ room: groupRoom, label: c.label, originalName: c.originalName, address: c.address || null, isGroup: false, latestDate: c.latestDate, accountEmail: c.accountEmail });
        return;
      }
      infos.push({ room: c.room, label: c.label, originalName: c.originalName, address: c.address || null, isGroup: false, latestDate: c.latestDate, accountEmail: c.accountEmail });
    });
    keysOf(chatConfigs).forEach(room => {
      const cfg = chatConfigs[room];
      if (cfg?.isGroup && !cfg.isHidden && (groupedEmails[room] || []).length > 0) {
        const label = cfg.customName || app.actions.roomLocalKey(room);
        infos.push({
          room,
          label,
          // グループ名は作成時に必須入力のため「変更前の名前」という概念が無く、labelと同一でよい
          originalName: label,
          address: null,
          isGroup: true,
          latestDate: groupedEmails[room][0]?.date ? new Date(groupedEmails[room][0].date).getTime() : 0,
          accountEmail: app.actions.roomAccountEmail(room),
        });
      }
    });
    return infos;
  }, [contactDirectory, chatConfigs, groupedEmails]);

  const roomInfoMap = useMemo(() => new Map(roomInfos.map(r => [r.room, r])), [roomInfos]);

  const emailRoomMap = useMemo(() => {
    const map = new Map<string, RoomKeyStr>();
    keysOf(groupedEmails).forEach(room => (groupedEmails[room] || []).forEach((e) => map.set(e.id, room)));
    return map;
  }, [groupedEmails]);

  // 非表示にしたチャット・メッセージは検索結果にも出さない（useMailApp.ts の senderList と同じ判定基準）
  const isEmailHiddenFromSearch = (e: Email): boolean => {
    const isTrash = e.labelIds?.includes("TRASH");
    const isSpam = e.labelIds?.includes("SPAM");
    const isInbox = e.labelIds?.includes("INBOX");
    const isSent = e.labelIds?.includes("SENT") || e.isMe;
    const isArchive = !isTrash && !isSpam && !isInbox && !isSent;
    if (!(isInbox || isArchive || isSent)) return false;
    const room = emailRoomMap.get(e.id);
    if (room && chatConfigs[room]?.isHidden) return true;
    return !!messageConfigs[messageConfigKey(e.id)]?.isHidden;
  };

  const recipientMatches = useMemo(() => {
    if (!kwLower) return [];
    return roomInfos.filter(r =>
      (r.label.toLowerCase().includes(kwLower) || r.originalName.toLowerCase().includes(kwLower))
      && isAccountFilterVisible(r.accountEmail)
    );
  }, [roomInfos, kwLower, accountFilter]);

  const addressMatches = useMemo(() => {
    if (!kwLower) return [];
    return roomInfos.filter(r => r.address && r.address.toLowerCase().includes(kwLower) && isAccountFilterVisible(r.accountEmail));
  }, [roomInfos, kwLower, accountFilter]);

  const subjectMatches = useMemo(() => {
    if (!kwLower) return [];
    return allUniqueEmails.filter((e) => {
      if (!(e.subject || "").toLowerCase().includes(kwLower)) return false;
      if (isEmailHiddenFromSearch(e)) return false;
      if (!isAccountFilterVisible(e.accountId)) return false;
      return boxFilter[getSearchBoxInfo(e).key];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allUniqueEmails, kwLower, boxFilter, accountFilter, emailRoomMap, chatConfigs, messageConfigs]);

  const bodyMatches = useMemo(() => {
    if (!kwLower) return [];
    return allUniqueEmails.filter((e) => {
      if (!(e.body || "").toLowerCase().includes(kwLower)) return false;
      if (isEmailHiddenFromSearch(e)) return false;
      if (!isAccountFilterVisible(e.accountId)) return false;
      return boxFilter[getSearchBoxInfo(e).key];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allUniqueEmails, kwLower, boxFilter, accountFilter, emailRoomMap, chatConfigs, messageConfigs]);

  // クライアント側（既に読み込み済みのメールだけ）の検索結果が0件の場合、Gmail本体を対象に
  // サーバー検索するフォールバック。ヒットしたメールはsearchServerSide内でemails stateへ
  // マージされるため、上のsubjectMatches/bodyMatchesが次のレンダーで自動的に拾ってくれる
  // （このコンポーネント側で結果を別途保持・マージする必要がない）
  const [isServerSearching, setIsServerSearching] = useState(false);
  useEffect(() => {
    if (!kwLower || kwLower.length < 2) { setIsServerSearching(false); return; }
    if (activeTab !== "all" && activeTab !== "subject" && activeTab !== "body") return;
    // 「このキーワード・このフィールドは既にサーバー検索を試した」ものは、たとえローカル結果が
    // 引き続き0件でも二度と撃たない（他の理由でallUniqueEmailsが更新され、この副作用が
    // 再評価された場合の無駄なGmail API呼び出し・クォータ消費を防ぐ）。
    // 判定ロジック自体は app/lib/searchFallback.ts に切り出してユニットテストしてある
    const needSubject = shouldTriggerServerSearch(searchedServerKeywordsRef.current, kwLower, "subject", subjectMatches.length);
    const needBody = shouldTriggerServerSearch(searchedServerKeywordsRef.current, kwLower, "body", bodyMatches.length);
    if (!needSubject && !needBody) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      if (needSubject) markServerSearched(searchedServerKeywordsRef.current, kwLower, "subject");
      if (needBody) markServerSearched(searchedServerKeywordsRef.current, kwLower, "body");
      setIsServerSearching(true);
      try {
        await Promise.all([
          needSubject ? app.actions.searchServerSide(keyword, "subject") : Promise.resolve([]),
          needBody ? app.actions.searchServerSide(keyword, "body") : Promise.resolve([]),
        ]);
      } finally {
        if (!cancelled) setIsServerSearching(false);
      }
    }, 500);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kwLower, activeTab, subjectMatches.length, bodyMatches.length]);

  const sortRooms = (list: typeof roomInfos, order: SearchSort) => {
    const arr = [...list];
    if (order === "kana") arr.sort((a, b) => a.label.localeCompare(b.label, "ja"));
    else if (order === "oldest") arr.sort((a, b) => a.latestDate - b.latestDate);
    else arr.sort((a, b) => b.latestDate - a.latestDate);
    return arr;
  };
  const sortEmailsByDate = (list: Email[], order: "newest" | "oldest") => {
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

  // 注意: ここでは exitAfterAction()（内部で history.go(-N) を使う）を使わない。
  // go()/back() は非同期に処理されるため、直後に openChat 側の pushState が同期的に走ると
  // 履歴の位置がずれ、意図しないタイミングでポップされてチャットが開いた直後に閉じてしまう。
  // そのため、検索モーダルの履歴エントリは openChat 側で同期的に replaceState して片付ける
  // （jumpToSearchResult も同様の仕組みで検索バー用エントリを扱う）
  const handleOpenChat = (room: RoomKeyStr) => {
    setModal(null);
    const cameFromModal = typeof window !== "undefined" && window.history.state?.action === "modal";
    openChat(room, { replaceHistory: cameFromModal });
  };

  const handleJumpToMessage = (room: RoomKeyStr, msgId: string, field: "subject" | "body") => {
    jumpToSearchResult(room, msgId, keyword, field);
  };

  const TABS: [SearchTab, string][] = [["all", "すべて"], ["recipient", "宛先名"], ["address", "アドレス"], ["subject", "件名"], ["body", "本文"]];

  const showKanaSort = activeTab === "recipient" || activeTab === "address";
  const showBoxFilter = activeTab === "subject" || activeTab === "body";

  const renderRoomRow = (info: { room: RoomKeyStr; label: string; address: string | null }, primary: "label" | "address") => (
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

  const renderEmailRow = (email: Email, field: "subject" | "body") => {
    const room = emailRoomMap.get(email.id);
    const info = room ? roomInfoMap.get(room) : undefined;
    const boxName = getSearchBoxInfo(email).name;
    const dateStr = new Date(email.date).toLocaleString("ja-JP", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    return (
      <button
        key={email.id}
        onClick={() => room && handleJumpToMessage(room, email.id, field)}
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
          <span className="truncate max-w-[150px]">{info?.label || (room ? app.actions.roomLocalKey(room) : "")}</span>
          {info?.address && <span className="truncate max-w-[150px]">{info.address}</span>}
          <span>{dateStr}</span>
          <span>{boxName}</span>
        </div>
      </button>
    );
  };

  // すべてタブ用: 各カテゴリー5件までは表示し、6件目以降は「もっと見る」で折りたたむ
  const ALL_TAB_COLLAPSE_LIMIT = 5;
  const renderSection = <T,>(key: string, title: string, items: T[], renderItem: (item: T) => React.ReactNode) => {
    if (items.length === 0) return null;
    const isExpanded = !!expandedAllSections[key];
    const visibleItems = isExpanded ? items : items.slice(0, ALL_TAB_COLLAPSE_LIMIT);
    const hiddenCount = items.length - ALL_TAB_COLLAPSE_LIMIT;
    return (
      <div className="mb-4">
        <div className="text-xs font-bold text-gray-400 px-1 mb-1">{title} ({items.length}件)</div>
        <div className="bg-[#232428] rounded">
          {visibleItems.map(renderItem)}
          {hiddenCount > 0 && (
            <button
              onClick={() => setExpandedAllSections(prev => ({ ...prev, [key]: !isExpanded }))}
              className="w-full text-center py-2 text-xs font-bold text-[#5865F2] hover:bg-[#2B2D31] transition border-t border-[#1E1F22]/50"
            >
              {isExpanded ? "折りたたむ" : `もっと見る（他${hiddenCount}件）`}
            </button>
          )}
        </div>
      </div>
    );
  };

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
          {searchAccountList.length > 1 && (
            <div className="flex flex-wrap gap-1 text-[11px] font-bold">
              {searchAccountList.map(acct => {
                const isMain = acct === mainEmail;
                const profile = isMain ? undefined : (linkedAccountProfiles as Record<string, { name?: string; picture?: string }>)[acct];
                const pictureSrc = isMain ? session?.user?.image : profile?.picture;
                const displayName = isMain ? (session?.user?.name || acct) : (profile?.name || acct);
                return (
                  <label key={acct} title={acct} className="flex items-center gap-1 cursor-pointer bg-[#313338] px-2 py-1 rounded hover:bg-[#3f4147]">
                    <input type="checkbox" checked={accountFilter[acct] !== false} onChange={(e) => setAccountFilter(prev => ({ ...prev, [acct]: e.target.checked }))} className="accent-[#5865F2]" />
                    {useIconLabels ? (
                      <img src={pictureSrc || `/api/avatar?name=${encodeURIComponent(displayName)}`} alt="" referrerPolicy="no-referrer" className="w-4 h-4 rounded-full flex-shrink-0" />
                    ) : acct.split("@")[0]}
                  </label>
                );
              })}
            </div>
          )}
        </div>

        <div
          className="flex-1 overflow-y-auto p-3 min-h-0"
          onScroll={(e) => {
            // 宛先・アドレス・件名・本文いずれも、まだ読み込んでいないチャットが残っていると
            // 検索対象に含まれないため、下までスクロールしたら追加読み込みする
            const { scrollTop, clientHeight, scrollHeight } = e.currentTarget;
            if (scrollHeight - Math.abs(scrollTop) - clientHeight < 50 && !app.state.isLoadingMoreChats && !app.state.chatStatusMessage) {
              app.actions.handleLoadMoreChats();
            }
          }}
        >
          {!kwLower && (
            <div className="text-center text-sm text-gray-500 py-10">キーワードを入力してください</div>
          )}
          {kwLower && isServerSearching && (
            <div className="text-center text-xs text-[#5865F2] font-bold pt-2 pb-1 animate-pulse">Gmail全体から検索中...</div>
          )}
          {kwLower && noResults && !isServerSearching && (
            <div className="text-center text-sm text-gray-500 py-10">見つかりませんでした</div>
          )}
          {kwLower && activeTab === "all" && (
            <>
              {renderSection("recipient", "宛先名", sortedRecipients, (r) => renderRoomRow(r, "label"))}
              {renderSection("address", "アドレス", sortedAddresses, (r) => renderRoomRow(r, "address"))}
              {renderSection("subject", "件名", sortedSubjects, (e) => renderEmailRow(e, "subject"))}
              {renderSection("body", "本文", sortedBodies, (e) => renderEmailRow(e, "body"))}
            </>
          )}
          {kwLower && activeTab === "recipient" && (
            <div className="bg-[#232428] rounded">{sortedRecipients.map(r => renderRoomRow(r, "label"))}</div>
          )}
          {kwLower && activeTab === "address" && (
            <div className="bg-[#232428] rounded">{sortedAddresses.map(r => renderRoomRow(r, "address"))}</div>
          )}
          {kwLower && activeTab === "subject" && (
            <div className="bg-[#232428] rounded">{sortedSubjects.map(e => renderEmailRow(e, "subject"))}</div>
          )}
          {kwLower && activeTab === "body" && (
            <div className="bg-[#232428] rounded">{sortedBodies.map(e => renderEmailRow(e, "body"))}</div>
          )}
          {kwLower && app.state.isLoadingMoreChats && (
            <div className="flex justify-center py-2">
              <span className="text-xs text-[#5865F2] animate-pulse">読み込み中...</span>
            </div>
          )}
          {kwLower && !app.state.isLoadingMoreChats && app.state.chatStatusMessage && (
            <div className="flex justify-center py-2">
              <span className="text-xs text-gray-500">{app.state.chatStatusMessage}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
