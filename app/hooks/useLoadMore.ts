// さらに読み込む：チャット一覧（全アカウントの次のページ）とメッセージ（開いているチャットの古いもの）。
// スクロールバーが出るまで自動で続けて読み込む。useMailApp.ts から分けた（動きは変えない）
import { useEffect, type MutableRefObject } from "react";
import type { Session } from "next-auth";
import type { ChatConfig } from "../types/mail";
import type { Email } from "../types/email";
import { type RoomKeyStr, decodeRoomKey } from "../lib/roomKey";
import { reconcileFakeSentEmails } from "../lib/mailAppHelpers";
import type { useMailSync } from "./useMailSync";
import type { SetState } from "./mailAppTypes";

type MailSyncApi = ReturnType<typeof useMailSync>;

export function useLoadMore({
  session, setEmails, isLoading, selectedSender, groupedEmails, senderList, chatConfigsRef,
  checkInbox, checkArchive, checkSpam, checkTrash, checkSent,
  currentNextPageTokens, setCurrentNextPageTokens, currentNextPageTokensRef, loadingMoreChatsRef, setIsLoadingMoreChats, chatStatusMessage, setChatStatusMessage,
  loadingMoreMsgRef, setIsLoadingMore, chatNextPageToken, msgStatusMessage, setMsgStatusMessage, fetchChatCrossbox, fetchGroupLoadMore,
}: {
  session: Session | null;
  setEmails: SetState<Email[]>;
  isLoading: boolean;
  selectedSender: RoomKeyStr | null;
  groupedEmails: Record<RoomKeyStr, Email[]>;
  senderList: RoomKeyStr[];
  chatConfigsRef: MutableRefObject<Record<RoomKeyStr, ChatConfig>>;
  checkInbox: boolean;
  checkArchive: boolean;
  checkSpam: boolean;
  checkTrash: boolean;
  checkSent: boolean;
  currentNextPageTokens: Record<string, string | null>;
  setCurrentNextPageTokens: SetState<Record<string, string | null>>;
  currentNextPageTokensRef: MutableRefObject<Record<string, string | null>>;
  loadingMoreChatsRef: MutableRefObject<boolean>;
  setIsLoadingMoreChats: SetState<boolean>;
  chatStatusMessage: string | null;
  setChatStatusMessage: SetState<string | null>;
  loadingMoreMsgRef: MutableRefObject<boolean>;
  setIsLoadingMore: SetState<boolean>;
  chatNextPageToken: string | null;
  msgStatusMessage: string | null;
  setMsgStatusMessage: SetState<string | null>;
  fetchChatCrossbox: MailSyncApi["fetchChatCrossbox"];
  fetchGroupLoadMore: MailSyncApi["fetchGroupLoadMore"];
}) {
  const handleLoadMoreChats = async () => {
    const liveTokens = currentNextPageTokensRef.current;
    const myEmail = session?.user?.email || "";
    const accountsToLoad = Object.keys(liveTokens).filter(a => liveTokens[a]);
    if (loadingMoreChatsRef.current || accountsToLoad.length === 0) {
        if (accountsToLoad.length === 0 && !chatStatusMessage) setChatStatusMessage("すべてのメールを読み込みました");
        return;
    }
    loadingMoreChatsRef.current = true;
    setIsLoadingMoreChats(true);
    setChatStatusMessage(null);

    try {
      const qParts = [];
      let useIncludeTrash = "false";

      if (checkTrash || checkSpam) { useIncludeTrash = "true"; }
      if (checkSent) { useIncludeTrash = "true"; }
      if (checkArchive) {
        if (!checkInbox) qParts.push("-in:inbox");
      } else {
        const orLabels = [];
        if (checkInbox) orLabels.push("in:inbox");
        if (checkSent) orLabels.push("from:me");
        if (checkSpam) orLabels.push("in:spam");
        if (checkTrash) orLabels.push("in:trash");
        if (orLabels.length > 0) qParts.push(`(${orLabels.join(" OR ")})`);
      }
      const baseQuery = qParts.join(" ").trim();

      // アカウントごとに独立したページトークンで、まだ続きがあるアカウント分だけ並行して1ページ取得する
      const results = await Promise.all(accountsToLoad.map(async (accountEmail) => {
        const params = new URLSearchParams({ maxResults: "100", q: baseQuery, includeTrash: useIncludeTrash, pageToken: liveTokens[accountEmail]! });
        if (accountEmail !== myEmail) params.append("accountEmail", accountEmail);
        params.append("_t", Date.now().toString());
        try {
          const res: Response = await fetch(`/api/emails?${params.toString()}`);
          if (!res.ok) return { accountEmail, ok: false, messages: [] as Email[], nextToken: liveTokens[accountEmail] };
          const data = (await res.json()) as { messages?: Email[]; nextPageToken?: string | null };
          return { accountEmail, ok: true, messages: ((data.messages || []) as Email[]).map((m) => ({ ...m, accountId: accountEmail })), nextToken: data.nextPageToken || null };
        } catch {
          return { accountEmail, ok: false, messages: [] as Email[], nextToken: liveTokens[accountEmail] };
        }
      }));

      const rawMessages = results.flatMap(r => r.messages);
      const nextTokens: Record<string, string | null> = { ...liveTokens };
      let anyOk = false;
      results.forEach(r => { if (r.ok) { anyOk = true; nextTokens[r.accountEmail] = r.nextToken; } });

      if (!anyOk) {
        setChatStatusMessage("メールが読み込めませんでした。");
        return;
      }

      if (rawMessages.length > 0) {
        setEmails(prev => {
          const map = new Map(prev.map((e) => [e.id, e]));
          rawMessages.forEach((m) => map.set(m.id, m));
          return reconcileFakeSentEmails(Array.from(map.values()));
        });
      }

      // tokenを更新→currentNextPageTokens変化→useEffectが次ページを判断
      setCurrentNextPageTokens(nextTokens);
      if (!Object.values(nextTokens).some(t => t)) setChatStatusMessage("すべてのメールを読み込みました");

    } catch {
      setChatStatusMessage("エラーが発生しました。");
    } finally {
      setIsLoadingMoreChats(false);
      loadingMoreChatsRef.current = false;
    }
  };

  const handleLoadMoreMessage = async () => {
    if (loadingMoreMsgRef.current || chatNextPageToken?.startsWith("END")) {
        if (chatNextPageToken === "END_LIMIT") setMsgStatusMessage("re:mailの読み込み上限に達しました");
        else if (chatNextPageToken === "END_ALL") setMsgStatusMessage("すべてのメールを読み込みました");
        return;
    }
    loadingMoreMsgRef.current = true;
    setIsLoadingMore(true);
    setMsgStatusMessage(null);

    const { localKey: loadMoreLocalKey } = decodeRoomKey(selectedSender!);
    // グループのローカルキー（group:xxxx）はGmail検索語にならないため、通常のfetchChatCrossboxではなく
    // メンバーごとに独立したページングを行うfetchGroupLoadMoreを使う
    const isGroupRoom = chatConfigsRef.current[selectedSender!]?.isGroup;
    const result = isGroupRoom
      ? await fetchGroupLoadMore(selectedSender!)
      : await fetchChatCrossbox(loadMoreLocalKey, decodeRoomKey(selectedSender!).accountEmail, true);

    if (result.nextToken === "END_LIMIT") {
        setMsgStatusMessage("re:mailの読み込み上限に達しました");
    } else if (result.nextToken === "END_ALL") {
        setMsgStatusMessage("すべてのメールを読み込みました");
    }
    
    setIsLoadingMore(false);
    loadingMoreMsgRef.current = false;
  };
  // サイドバー: senderList や currentNextPageTokens が変化するたびに即座にチェック
  // → スクロールバーが出るまで（または全件読み込みまで）自動でチャットを追加読み込みする
  const hasMoreChatsToLoad = Object.values(currentNextPageTokens).some(t => t);
  useEffect(() => {
    if (isLoading || loadingMoreChatsRef.current || chatStatusMessage) return;
    if (!hasMoreChatsToLoad && senderList.length === 0) return;
    const asideEl = document.querySelector("aside > div.flex-1.overflow-y-auto");
    if (!asideEl) return;
    const { scrollHeight, clientHeight, scrollTop } = asideEl as HTMLElement;
    if (scrollHeight - Math.abs(scrollTop) - clientHeight < 100) {
      handleLoadMoreChats();
    }
  }, [isLoading, senderList, chatStatusMessage, hasMoreChatsToLoad, checkInbox, checkArchive, checkSpam, checkTrash, checkSent]);

  // メッセージスレッド: chatNextPageToken やメッセージ件数が変化するたびに即座にチェック
  // → スクロールバーが出るまで（または全件読み込みまで）自動でメッセージを追加読み込みする
  const currentChatLength = selectedSender ? (groupedEmails[selectedSender] || []).length : 0;
  useEffect(() => {
    if (loadingMoreMsgRef.current || msgStatusMessage || !chatNextPageToken || chatNextPageToken === "FIRST_PAGE" || chatNextPageToken.startsWith("END")) return;
    const mainEl = document.querySelector("main > div.flex-1.overflow-y-auto");
    if (!mainEl) return;
    const { scrollHeight, clientHeight, scrollTop } = mainEl as HTMLElement;
    if (scrollHeight - Math.abs(scrollTop) - clientHeight < 100) {
      handleLoadMoreMessage();
    }
  }, [chatNextPageToken, msgStatusMessage, currentChatLength, selectedSender]);

  return { handleLoadMoreChats, handleLoadMoreMessage };
}
