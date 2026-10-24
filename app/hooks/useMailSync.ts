// 一覧の取得と差分同期：全アカウントの一覧の取得・サーバー検索・最初の読み込み・チャットごとの取得（場所をまたぐ）・
// 場所の切り替え・読み込めなかったメールの再試行・裏からの差分同期（Gmail の history）。useMailApp.ts から分けた（動きは変えない）
import { useState, useEffect, useRef, type MutableRefObject } from "react";
import { signOut } from "next-auth/react";
import type { Session } from "next-auth";
import type { SelectionMode, ModalState } from "../types/mail";
import type { Email } from "../types/email";
import { clearDeviceData } from "../lib/deviceData";
import type { ChatListTab } from "../lib/filterMatch";
import { type LocalKey, type RoomKeyStr, asLocalKey, decodeRoomKey } from "../lib/roomKey";
import { pendingMembers, aggregateGroupPagingState } from "../lib/groupPaging";
import { applySyncResult, idsToFetchForLabelChanges, type BoxFlags, type SyncResult } from "../lib/historySync";
import { syncedSettingsKey, pickCommonSettings, type SyncedSettings } from "../lib/syncedSettings";
import { logError, logWarn } from "../lib/safeLog";
import { mapWithConcurrency, reconcileFakeSentEmails } from "../lib/mailAppHelpers";
import type { ChatConfig, MessageConfig } from "../types/mail";
import type { useEmailModals } from "./useEmailModals";
import type { SetState, ConfigsApi } from "./mailAppTypes";

// /api/accounts が返す linked_accounts の行
type LinkedAccountRow = { account_email: string; needs_reauth: number | null; name: string | null; picture: string | null };
type EmailModalsApi = ReturnType<typeof useEmailModals>;

export function useMailSync({
  session, emailsRef, setEmails, setIsLoading, selectedSender, showErrorToast, signingOutRef, unloadedIds, setUnloadedIds,
  syncConfigs, chatConfigsRef, messageConfigsRef, applySyncedPersisted, loadD1Configs, applySyncedSettings, savedSyncedKeyRef, setSyncedSettingsReady, saveGlobalSettings,
  linkedAccountsRef, setLinkedAccounts, setReauthNeededAccounts, setLinkedAccountProfiles,
  checkInbox, checkArchive, checkSpam, checkTrash, checkSent, filterKeyRef, isInitialFilterRun, emailsFilterKeyRef, filterCacheRef, activeChatTab,
  setCurrentNextPageTokens, currentNextPageTokensRef, groupMemberTokensRef, setChatNextPageToken, chatNextPageTokenRef, setChatStatusMessage,
  setSelectionMode, setSelectedIds, setModal, setRenameInput, openEmailModal, openAttachmentModal, setRevealedCrossPrompts, activeLoadRef, searchTimeoutRef,
}: {
  session: Session | null;
  emailsRef: MutableRefObject<Email[]>;
  setEmails: SetState<Email[]>;
  setIsLoading: SetState<boolean>;
  selectedSender: RoomKeyStr | null;
  showErrorToast: (message: string) => void;
  signingOutRef: MutableRefObject<boolean>;
  unloadedIds: Record<string, string[]>;
  setUnloadedIds: SetState<Record<string, string[]>>;
  syncConfigs: ConfigsApi["syncConfigs"];
  chatConfigsRef: MutableRefObject<Record<RoomKeyStr, ChatConfig>>;
  messageConfigsRef: MutableRefObject<Record<RoomKeyStr, MessageConfig>>;
  applySyncedPersisted: (nextPMsgs: Email[]) => void;
  loadD1Configs: ConfigsApi["loadD1Configs"];
  applySyncedSettings: ConfigsApi["applySyncedSettings"];
  savedSyncedKeyRef: ConfigsApi["savedSyncedKeyRef"];
  setSyncedSettingsReady: ConfigsApi["setSyncedSettingsReady"];
  saveGlobalSettings: ConfigsApi["saveGlobalSettings"];
  linkedAccountsRef: MutableRefObject<string[]>;
  setLinkedAccounts: SetState<string[]>;
  setReauthNeededAccounts: SetState<string[]>;
  setLinkedAccountProfiles: SetState<Record<string, { name?: string; picture?: string }>>;
  checkInbox: boolean;
  checkArchive: boolean;
  checkSpam: boolean;
  checkTrash: boolean;
  checkSent: boolean;
  filterKeyRef: MutableRefObject<string>;
  isInitialFilterRun: MutableRefObject<boolean>;
  emailsFilterKeyRef: MutableRefObject<string>;
  filterCacheRef: MutableRefObject<Map<string, { emails: Email[]; currentNextPageTokens: Record<string, string | null> }>>;
  activeChatTab: ChatListTab;
  setCurrentNextPageTokens: SetState<Record<string, string | null>>;
  currentNextPageTokensRef: MutableRefObject<Record<string, string | null>>;
  groupMemberTokensRef: MutableRefObject<Record<string, string>>;
  setChatNextPageToken: SetState<string | null>;
  chatNextPageTokenRef: MutableRefObject<string | null>;
  setChatStatusMessage: SetState<string | null>;
  setSelectionMode: SetState<SelectionMode>;
  setSelectedIds: SetState<string[]>;
  setModal: SetState<ModalState>;
  setRenameInput: SetState<string>;
  openEmailModal: EmailModalsApi["openEmailModal"];
  openAttachmentModal: EmailModalsApi["openAttachmentModal"];
  setRevealedCrossPrompts: SetState<string[]>;
  activeLoadRef: MutableRefObject<number>;
  searchTimeoutRef: MutableRefObject<NodeJS.Timeout | null>;
}) {
  // メイン+連携済みの全アカウント分を並行して取得し、1つの配列にマージする。
  // pageToken は常にnull（先頭ページ取得専用。追加読み込みはhandleLoadMoreChatsが個別に担う）のため
  // 実質未使用。limitはアカウント数で按分し、合算でおおよそtargetLimit件になるようにする
  // 各アカウントの「ここから後の変化を取る」起点（Gmail の historyId）。一覧を取り直すたびに更新する
  const historyIdsRef = useRef<Record<string, string>>({});
  const syncingRef = useRef(false);

  const captureHistoryBaselines = async (accounts: string[]): Promise<Record<string, string>> => {
    const myEmail = session?.user?.email || "";
    const out: Record<string, string> = {};
    await mapWithConcurrency(accounts, 3, async (account) => {
      try {
        const params = new URLSearchParams({ sync: "1" });
        if (account !== myEmail) params.append("accountEmail", account);
        const res = await fetch(`/api/emails?${params.toString()}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { historyId?: string | null };
        if (data.historyId) out[account] = data.historyId;
      } catch { /* 起点が取れなければ、次の更新で一覧を取り直す */ }
    });
    return out;
  };

  const fetchEmails = async (limit = 100, query = "", flags = { inbox: true, archive: true, spam: false, trash: false, sent: false }, _pageToken: string | null = null, _isLoadMore = false, isSilent = false, currentEmailsState = emailsRef.current, getIsCancelled = () => false, _isInitLoad = false) => {
    // ★修正: flags.sent も判定に含めることで、「送信済みのみ」チェック時にAPIが空振りするのを防ぐ
    if (!flags.inbox && !flags.archive && !flags.spam && !flags.trash && !flags.sent) {
      setEmails([]); if (!isSilent) setIsLoading(false); return { success: false, emails: [] };
    }
    if (!isSilent) setIsLoading(true);
    const targetLimit = limit;

    try {
      const qParts = [];
      let useIncludeTrash = "false";

      if (flags.trash || flags.spam) {
        useIncludeTrash = "true";
      }
      // 送信済みはGmailの「送信済みフォルダ」だけでなく全場所の送信メールを対象とする
      if (flags.sent) {
        useIncludeTrash = "true";
      }

      if (flags.archive) {
        if (!flags.inbox) qParts.push("-in:inbox");
      } else {
        const orLabels = [];
        if (flags.inbox) orLabels.push("in:inbox");
        if (flags.sent) orLabels.push("from:me"); // in:sent → from:me (全場所の送信メール)
        if (flags.spam) orLabels.push("in:spam");
        if (flags.trash) orLabels.push("in:trash");
        if (orLabels.length > 0) qParts.push(`(${orLabels.join(" OR ")})`);
      }

      if (query) qParts.push(query);
      const q = qParts.join(" ").trim();

      const myEmail = session?.user?.email || "";
      const accounts = [myEmail, ...linkedAccountsRef.current];
      const perAccountLimit = Math.max(1, Math.ceil(targetLimit / accounts.length));

      // アカウント数が多い場合にGmail APIのレート制限へ一斉に触れないよう、同時フェッチ数の
      // 上限を設ける（1〜3アカウントなら実質そのまま全並列、それ以上は3アカウントずつ処理する）
      // 差分の起点（historyId）は一覧より先に取る（間に届いたメールを取りこぼさないため。重なった分は ID で同じものになる）
      const baselinePromise = captureHistoryBaselines(accounts);
      const results = await mapWithConcurrency(accounts, 3, async (accountEmail) => {
        const params = new URLSearchParams({ maxResults: perAccountLimit.toString(), q, includeTrash: useIncludeTrash });
        if (accountEmail !== myEmail) params.append("accountEmail", accountEmail);
        params.append("_t", Date.now().toString());
        try {
          const res = await fetch(`/api/emails?${params.toString()}`);
          return { accountEmail, res };
        } catch {
          return { accountEmail, res: null as Response | null };
        }
      });

      // 認証切れの強制サインアウトはメインアカウントの失効時のみ行う。連携アカウントのトークン
      // 失効はそのアカウント分だけ黙って読み込めない扱いにし、メインアカウントの利用は継続させる
      const mainResult = results.find(r => r.accountEmail === myEmail);
      if (mainResult?.res && (mainResult.res.status === 401 || mainResult.res.status === 403)) {
        // 401 は「ログインが本当に切れた」とは限らない。トークンの更新が一時的に失敗して古いトークンのまま
        // Gmail に断られただけのこともある（実機テストで、これで勝手にログアウトされ下書きも消えた）。
        // セッションを取り直して（ここでトークンの更新とログイン情報の保存も行われる）、
        // Google がログインを無効と言っている場合だけログアウトする
        let loginInvalid = true;
        try {
          const s = (await (await fetch("/api/auth/session", { cache: "no-store" })).json()) as { user?: unknown; error?: string } | null;
          loginInvalid = !s?.user || s.error === "RefreshAccessTokenError";
        } catch {
          // 通信できないときはログイン状態を判断できないので、ログアウトはしない
          loginInvalid = false;
        }
        if (!loginInvalid) {
          logWarn("emails.unauthorizedTransient", { status: mainResult.res.status });
          showErrorToast("Gmail との接続が一時的に切れました。しばらくすると自動でつなぎ直します。");
          return { success: false, emails: currentEmailsState };
        }
        if (!signingOutRef.current) {
          signingOutRef.current = true;
          // 認証切れでログアウトするときも、端末に残したメールの中身・下書きを消す
          await clearDeviceData();
          // signOut のサーバー側処理（セッションCookie破棄）が終わる前に遷移すると、
          // 古いセッションが残ったままリロードされ無限ループになるため必ず完了を待つ
          await signOut({ redirect: false });
          // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- ログアウト後は画面の状態を残さないよう、ページを読み込み直す必要がある
          window.location.href = "/";
        }
        return { success: false, emails: currentEmailsState };
      }

      if (getIsCancelled()) return { success: false, emails: currentEmailsState };

      const newMessages: Email[] = [];
      const nextTokens: Record<string, string | null> = {};
      let anyOk = false;
      const failedByAccount: Record<string, string[]> = {};
      for (const { accountEmail, res } of results) {
        if (!res || !res.ok) continue;
        const data = await res.json();
        // res.json() 待機中に新しいフィルターへ切り替えられている可能性があるため再チェック。
        // ここで弾かないと、古いフィルターの結果が新しいフィルターの結果を上書きしてしまう
        if (getIsCancelled()) return { success: false, emails: currentEmailsState };
        anyOk = true;
        ((data.messages || []) as Email[]).forEach((m) => newMessages.push({ ...m, accountId: accountEmail }));
        nextTokens[accountEmail] = data.nextPageToken || null;
        if (Array.isArray(data.failedIds) && data.failedIds.length > 0) failedByAccount[accountEmail] = data.failedIds as string[];
      }
      if (!anyOk) return { success: false, emails: currentEmailsState };
      // 読み込めなかったメールがあれば、黙って欠けさせずに画面で知らせる（取り直せたら消す）
      setUnloadedIds(failedByAccount);
      // 一覧を取れたアカウントだけ、差分の起点を更新する
      const baselines = await baselinePromise;
      for (const { accountEmail, res } of results) {
        if (res?.ok && baselines[accountEmail]) historyIdsRef.current[accountEmail] = baselines[accountEmail];
      }

      const map = new Map(currentEmailsState.map((e) => [e.id, e]));
      newMessages.forEach((m) => map.set(m.id, m));
      const updatedEmails = reconcileFakeSentEmails(Array.from(map.values())).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

      const nextPMsgs = syncConfigs(updatedEmails, chatConfigsRef.current, messageConfigsRef.current);
      applySyncedPersisted(nextPMsgs);
      setEmails(updatedEmails);

      if (!isSilent || updatedEmails.length <= targetLimit) setCurrentNextPageTokens(nextTokens);
      return { success: true, emails: updatedEmails };
    } catch {
      return { success: false, emails: currentEmailsState };
    } finally {
      if (!isSilent && !getIsCancelled()) setIsLoading(false);
    }
  };

  // 検索モーダル用フォールバック: クライアント側に既に読み込み済みのメールだけでなく、
  // Gmail本体を対象にサーバー検索する。ローカルの検索結果が0件のときだけ呼ばれる想定
  // （数千通あるような実アカウントで、読み込み範囲外の過去メールが検索に一切引っかからない
  // 問題への対応）。メイン＋連携アカウントをまたいで検索し、見つかったメールはそのまま
  // emails stateへマージする（クリックしてチャットを開いた際に即座に反映されるように）
  // onlyAccount を渡すと、そのアカウントだけを探す（返信元を選ぶ画面は送信元のアカウントのメールしか選べないため、ほかは撃たない）
  const searchServerSide = async (keyword: string, field: "subject" | "body", onlyAccount?: string): Promise<Email[]> => {
    const trimmed = keyword.trim();
    if (!trimmed) return [];
    const myEmail = session?.user?.email || "";
    const accounts = onlyAccount ? [onlyAccount] : [myEmail, ...linkedAccountsRef.current];
    const escaped = trimmed.replace(/"/g, '\\"');
    const q = field === "subject" ? `subject:"${escaped}"` : `"${escaped}"`;

    const results = await mapWithConcurrency(accounts, 3, async (accountEmail) => {
      const params = new URLSearchParams({ maxResults: "50", q, includeTrash: "true" });
      if (accountEmail !== myEmail) params.append("accountEmail", accountEmail);
      params.append("_t", Date.now().toString());
      try {
        const res = await fetch(`/api/emails?${params.toString()}`);
        if (!res.ok) return [];
        const data = await res.json();
        return ((data.messages || []) as Email[]).map((m) => ({ ...m, accountId: accountEmail }));
      } catch { return []; }
    });

    const merged = results.flat();
    if (merged.length > 0) {
      setEmails(prev => {
        const map = new Map(prev.map((e) => [e.id, e]));
        merged.forEach((m) => map.set(m.id, m));
        return reconcileFakeSentEmails(Array.from(map.values()));
      });
    }
    return merged;
  };

  const initLoadDoneRef = useRef(false);
  // 初回のメール取得が完了するまでは senderList が空のまま（未取得なだけ）なので、
  // 「フィルターでチャットが消えた」判定を初回取得完了まで抑止するためのフラグ
  const hasLoadedOnceRef = useRef(false);

  // eslint-disable-next-line react-hooks/immutability -- isInitialFilterRun は useMailApp.ts の useRef。effect の中で current を書き換えるだけ（useMailApp.ts にあったときと同じ）
  useEffect(() => {
    if (session && !initLoadDoneRef.current) {
      initLoadDoneRef.current = true;
      const initLoad = async () => {
        try {
          setIsLoading(true);
          const [{ formatted: loadedConfigs, globalSettings }, linkedAccountsRes] = await Promise.all([
            loadD1Configs(),
            fetch("/api/accounts").then(r => r.ok ? r.json() : { accounts: [] }).catch(() => ({ accounts: [] })),
          ]);
          // どの端末でも共通の設定を反映する。D1 に無い設定（初めて同期する端末の値）は、このあと D1 に保存される
          const remoteSettings: SyncedSettings = globalSettings || {};
          applySyncedSettings(remoteSettings);
          // updatedAt は画面が持たないので、比べるときは外す
          savedSyncedKeyRef.current = syncedSettingsKey(pickCommonSettings(remoteSettings));
          setSyncedSettingsReady(true);
          // fetchEmails等が読む前に、ref側は同期的に確定させておく（state更新の再レンダリングを待たない）
          const linkedAccountRows = (linkedAccountsRes.accounts || []) as LinkedAccountRow[];
          const linkedEmails: string[] = linkedAccountRows.map((a) => a.account_email).filter(Boolean);
          linkedAccountsRef.current = linkedEmails;
          setLinkedAccounts(linkedEmails);
          setReauthNeededAccounts(linkedAccountRows.filter((a) => a.needs_reauth === 1).map((a) => a.account_email).filter(Boolean));
          const profiles: Record<string, { name?: string; picture?: string }> = {};
          linkedAccountRows.forEach((a) => {
            if (a.account_email) profiles[a.account_email] = { name: a.name || undefined, picture: a.picture || undefined };
          });
          setLinkedAccountProfiles(profiles);

          // チェックボックスの状態はマウント時点で localStorage から同期的に復元済みなので、
          // ここでは読み直さず現在の state をそのまま使う（読み込み中に見た目が切り替わるのを防ぐ）
          const initInbox = remoteSettings.inbox ?? checkInbox;
          const initArchive = remoteSettings.archive ?? checkArchive;
          const initSpam = remoteSettings.spam ?? checkSpam;
          const initTrash = remoteSettings.trash ?? checkTrash;
          const initSent = remoteSettings.sent ?? checkSent;
          filterKeyRef.current = `${initInbox}-${initArchive}-${initSpam}-${initTrash}-${initSent}`;
          // eslint-disable-next-line react-hooks/immutability -- isInitialFilterRun は useMailApp.ts の useRef。effect の中で current を書き換えるだけ（useMailApp.ts にあったときと同じ）
          isInitialFilterRun.current = false;

          setEmails([]);

          let res = await fetchEmails(100, "", { inbox: initInbox, archive: initArchive, spam: initSpam, trash: initTrash, sent: initSent }, null, false, false, [], () => false, true);
          if (!res.success) {
            // デプロイ直後の再起動やネットワーク瞬断でここが失敗すると、全体一覧が空のまま
            // fetchChatCrossbox（開いていたチャットだけの取得）が成功してしまい、
            // 「そのチャットしか表示されない」ように見える不具合になるため1回だけ再試行する
            await new Promise(r => setTimeout(r, 1500));
            res = await fetchEmails(100, "", { inbox: initInbox, archive: initArchive, spam: initSpam, trash: initTrash, sent: initSent }, null, false, false, [], () => false, true);
          }
          emailsFilterKeyRef.current = filterKeyRef.current;

          if (selectedSender && res.success) {
            // await せずに進むと、復元したチャットのメッセージがまだ senderList に
            // 反映される前に hasLoadedOnceRef が立ってしまい、「チャットが消えた」と
            // 誤判定されて selectedSender がクリアされてしまう（＝復元直後に一瞬だけ
            // 「チャットを選択してください」画面に戻ってしまう不具合の原因だった）
            const restoredConfig = loadedConfigs[selectedSender];
            const { accountEmail: restoredAccountEmail, localKey: restoredLocalKey } = decodeRoomKey(selectedSender);
            if (restoredConfig?.isGroup) {
              // グループのルームキーはGmail検索語にならないため、メンバーごとに個別取得する。
              // 「追加読み込み」で使うメンバーごとのページングトークンもここで正しく初期化しておく
              // （しないと復元直後の「追加読み込み」が常に1ページ目を取り直すだけになる）
              groupMemberTokensRef.current = {};
              const restoredMembers = (restoredConfig.groupMembers || []) as LocalKey[];
              await Promise.all(restoredMembers.map(async m => {
                const result = await fetchChatCrossbox(asLocalKey(m), restoredAccountEmail, false, res.emails, true).catch(() => ({ nextToken: "END_ALL" }));
                groupMemberTokensRef.current[m] = result.nextToken || "END_ALL";
              }));
              const aggState = aggregateGroupPagingState(restoredMembers, groupMemberTokensRef.current);
              const nextToken = aggState === "MORE" ? `GROUP_MORE_${Date.now()}` : aggState;
              setChatNextPageToken(nextToken); chatNextPageTokenRef.current = nextToken;
            } else {
              await fetchChatCrossbox(restoredLocalKey, restoredAccountEmail, false, res.emails);
            }
          }

          // 表示中のモーダル・選択中の内容・作成中の返信を復元する。
          // 表示に必要な内容そのものを保存してあるため、データの再取得完了を待たずに復元できる
          try {
            const savedUiState = localStorage.getItem("remail_ui_state");
            if (savedUiState) {
              const ui = JSON.parse(savedUiState);
              if (ui.selectionMode && ui.selectionMode !== "none" && Array.isArray(ui.selectedIds) && ui.selectedIds.length > 0) {
                setSelectionMode(ui.selectionMode);
                setSelectedIds(ui.selectedIds);
              }
              if (ui.modal) setModal(ui.modal);
              if (ui.renameInput) setRenameInput(ui.renameInput);
              if (ui.emailModalEmail) openEmailModal(ui.emailModalEmail);
              if (ui.attachmentModal) openAttachmentModal(ui.attachmentModal);
            }
          } catch (e) { logError("uiState.restore", {}, e); }

          setTimeout(() => {
            const asideScroll = localStorage.getItem(`remail_scroll_aside_${activeChatTab}`);
            const mainScroll = localStorage.getItem("remail_scroll_main");
            const asideEl = document.querySelector("aside > div.flex-1");
            const mainEl = document.querySelector("main > div.flex-1");
            if (asideScroll && asideEl) asideEl.scrollTop = parseInt(asideScroll, 10);
            if (mainScroll && mainEl) mainEl.scrollTop = parseInt(mainScroll, 10);
          }, 150);

        } catch (err) { logError("initialLoad", {}, err); } finally { setIsLoading(false); hasLoadedOnceRef.current = true; }
      };
      initLoad();
    }
  }, [session]);

  // sender は必ず生のローカルキー（相手の表示名/アドレス）。Gmail検索クエリに直接埋め込むため、
  // 複合roomKeyを渡すと壊れる（"from:\"account name\"" のような無意味な検索になる）。
  // accountEmail はこの相手が所属するアカウント（roomKeyのアカウント部分）で、どの連携アカウントの
  // Gmailから取得するかを決める
  // overrideToken: グループの各メンバーなど、共有の chatNextPageTokenRef とは別に
  // メンバーごとのページングトークンを明示的に渡したい場合に使う（指定時は skipToken も併用し、
  // 単一チャット用の共有トークンを巻き込まないようにする）
  const fetchChatCrossbox = async (sender: LocalKey, accountEmail: string, isLoadMore = false, knownEmails = emailsRef.current, skipToken = false, overrideToken?: string) => {
    const currentToken = overrideToken !== undefined ? overrideToken : chatNextPageTokenRef.current;
    try {
      // ref を使う: state(chatNextPageToken)は連続でループ呼び出しした場合に
      // 再レンダリング前の古い値を参照し続けてしまう（同じページを取得し続ける）ことがあるため
      if (isLoadMore && currentToken?.startsWith("END")) {
        return { found: false, nextToken: currentToken, messages: [] };
      }

      const addrSet = new Set<string>();
      knownEmails.forEach(e => {
        if (e.from.includes(sender) || (e.to && e.to.includes(sender)) || e.senderRoom === sender) {
          if (!e.isMe) {
            const match = e.from.match(/<([^>]+)>/);
            if (match) addrSet.add(match[1].trim());
          }
        }
      });
      let q = `(from:"${sender}" OR to:"${sender}")`;
      if (addrSet.size > 0) {
         const addrs = Array.from(addrSet).map(a => `from:${a} OR to:${a}`).join(" OR ");
         q = `(${q} OR ${addrs})`;
      }

      const params = new URLSearchParams({ maxResults: "100", q, includeTrash: "true" });
      if (accountEmail && accountEmail !== (session?.user?.email || "")) params.append("accountEmail", accountEmail);
      // すでに読み込んであるメールの詳細は取り直さない（Gmail の利用上限を使い切らないため。実機テストで、
      // 開いた直後の一覧取得とこの取得が同じ約70件の詳細を二重に取り、上限に触れていた）
      const myEmail = session?.user?.email || "";
      const knownMap = new Map(knownEmails
        .filter(e => !e.id.startsWith("fake-") && !e.isMissing && (e.accountId || myEmail) === (accountEmail || myEmail))
        .map(e => [e.id, e] as const));
      const knownIdsParam = Array.from(knownMap.keys()).slice(0, 300).join(",");
      if (knownIdsParam) params.append("knownIds", knownIdsParam);
      const tokenToUse = isLoadMore ? (currentToken === "FIRST_PAGE" ? null : currentToken) : null;
      if (tokenToUse) params.append("pageToken", tokenToUse);
      params.append("_t", Date.now().toString());

      const res = await fetch(`/api/emails?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        const fetchedMessages = ((data.messages || []) as Email[]).map((m) => ({ ...m, accountId: accountEmail }));
        // 詳細を省いたメール（取得済みのもの）は、手元のものでこのページの結果を補う
        const fetchedIds = new Set(fetchedMessages.map(m => m.id));
        const knownInPage = ((data.topIds || []) as string[]).filter(id => !fetchedIds.has(id)).map(id => knownMap.get(id)).filter((m): m is Email => !!m);
        const validMessages = [...fetchedMessages, ...knownInPage];
        const nextToken = data.nextPageToken || "END_ALL";
        if (!skipToken) { setChatNextPageToken(nextToken); chatNextPageTokenRef.current = nextToken; }

        if (fetchedMessages.length > 0) {
          setEmails(prev => {
            const map = new Map(prev.map(e => [e.id, e]));
            fetchedMessages.forEach((m) => map.set(m.id, m));
            return reconcileFakeSentEmails(Array.from(map.values()));
          });
        }

        return { found: validMessages.length > 0, nextToken, messages: validMessages };
      }
    } catch(e) { logError("chat.fetchPage", {}, e); }
    return { found: false, nextToken: isLoadMore ? currentToken : "FIRST_PAGE", messages: [] };
  };

  // ルームの履歴を取得する。グループチャットの場合はルームキー自体がGmail検索語にならないため、
  // メンバーそれぞれのアドレスで個別に取得する
  const fetchCrossboxForRoom = async (room: RoomKeyStr, knownEmails = emailsRef.current) => {
    const cfg = chatConfigsRef.current[room];
    const { accountEmail, localKey } = decodeRoomKey(room);
    if (cfg?.isGroup) {
      // グループの「追加読み込み」はメンバーごとに独立したページングトークンが必要なため、
      // ここでは共有の chatNextPageToken を汚さず（skipToken: true）、メンバーごとの
      // トークンを groupMemberTokensRef に記録する。全メンバー分そろってから、
      // 追加読み込みが可能かどうかを共有の chatNextPageToken に反映する
      groupMemberTokensRef.current = {};
      const members = (cfg.groupMembers || []) as LocalKey[];
      await Promise.all(members.map(async m => {
        const result = await fetchChatCrossbox(asLocalKey(m), accountEmail, false, knownEmails, true).catch(() => ({ nextToken: "END_ALL" }));
        groupMemberTokensRef.current[m] = result.nextToken || "END_ALL";
      }));
      const aggState = aggregateGroupPagingState(members, groupMemberTokensRef.current);
      const nextToken = aggState === "MORE" ? `GROUP_MORE_${Date.now()}` : aggState;
      setChatNextPageToken(nextToken); chatNextPageTokenRef.current = nextToken;
    } else {
      await fetchChatCrossbox(localKey, accountEmail, false, knownEmails);
    }
  };

  // グループチャットの「追加読み込み」: まだ読み終えていないメンバーだけ、そのメンバー自身の
  // ページングトークンを使って次のページを取得する。全メンバーが読み終わったら
  // END_ALL/END_LIMIT を共有の chatNextPageToken に反映し、自動読み込みのトリガーを止める
  const fetchGroupLoadMore = async (room: RoomKeyStr) => {
    const cfg = chatConfigsRef.current[room];
    const { accountEmail } = decodeRoomKey(room);
    const members = (cfg?.groupMembers || []) as LocalKey[];
    const pending = pendingMembers(members, groupMemberTokensRef.current);

    if (pending.length > 0) {
      await Promise.all(pending.map(async m => {
        const tokenForMember = groupMemberTokensRef.current[m] ?? "FIRST_PAGE";
        const result = await fetchChatCrossbox(asLocalKey(m), accountEmail, true, emailsRef.current, true, tokenForMember).catch(() => ({ nextToken: "END_ALL" }));
        groupMemberTokensRef.current[m] = result.nextToken || "END_ALL";
      }));
    }

    const aggState = aggregateGroupPagingState(members, groupMemberTokensRef.current);
    const nextToken = aggState === "MORE" ? `GROUP_MORE_${Date.now()}` : aggState;
    setChatNextPageToken(nextToken); chatNextPageTokenRef.current = nextToken;
    return { nextToken };
  };

  // eslint-disable-next-line react-hooks/immutability -- isInitialFilterRun は useMailApp.ts の useRef。effect の中で current を書き換えるだけ（useMailApp.ts にあったときと同じ）
  useEffect(() => {
    if (!session) return;

    if (isInitialFilterRun.current) {
      // eslint-disable-next-line react-hooks/immutability -- isInitialFilterRun は useMailApp.ts の useRef。effect の中で current を書き換えるだけ（useMailApp.ts にあったときと同じ）
      isInitialFilterRun.current = false;
      return;
    }

    const newFilterKey = `${checkInbox}-${checkArchive}-${checkSpam}-${checkTrash}-${checkSent}`;
    const isFilterChange = filterKeyRef.current !== newFilterKey;

    if (isFilterChange) {
      // 旧フィルターの状態をキャッシュに保存する。ただし emails が本当に「旧フィルターの取得結果」を
      // 反映している場合に限る（連続切り替えで直前の取得がキャンセルされていた場合、emails は
      // さらに古いフィルターのデータのままなので、それを誤って旧フィルター名義でキャッシュしない）
      if (emailsFilterKeyRef.current === filterKeyRef.current) {
        filterCacheRef.current.set(filterKeyRef.current, {
          emails: emailsRef.current,
          currentNextPageTokens: currentNextPageTokensRef.current,
        });
      }
      filterKeyRef.current = newFilterKey;
      // 他場所の表示リセット
      setRevealedCrossPrompts([]);
    }

    let isCancelled = false;
    activeLoadRef.current += 1;

    const handleFilterChange = async () => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
      searchTimeoutRef.current = setTimeout(async () => {
        await saveGlobalSettings(checkInbox, checkArchive, checkSpam, checkTrash, checkSent);

        // フィルター切り替えでキャッシュあり → 即復元
        const cached = isFilterChange ? filterCacheRef.current.get(newFilterKey) : null;
        if (cached) {
          if (!isCancelled) {
            setEmails(cached.emails);
            setCurrentNextPageTokens(cached.currentNextPageTokens);
            currentNextPageTokensRef.current = cached.currentNextPageTokens;
            setChatStatusMessage(null);
            setIsLoading(false);
            emailsFilterKeyRef.current = newFilterKey;
          }
          if (selectedSender && !isCancelled) {
            fetchCrossboxForRoom(selectedSender, cached.emails);
          }
        } else {
          if (!isCancelled) { setEmails([]); setChatStatusMessage(null); }
          const res = await fetchEmails(100, "", { inbox: checkInbox, archive: checkArchive, spam: checkSpam, trash: checkTrash, sent: checkSent }, null, false, false, [], () => isCancelled, true);
          if (!isCancelled) { setChatStatusMessage(null); emailsFilterKeyRef.current = newFilterKey; }
          if (selectedSender && !isCancelled && res.success) {
            fetchCrossboxForRoom(selectedSender, res.emails);
          }
        }
      }, 0);
    };
    handleFilterChange();
    return () => { isCancelled = true; if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current); };
  }, [checkInbox, checkArchive, checkSpam, checkTrash, checkSent]);

  // 連携アカウントの再連携要求状態（needs_reauth）を再取得する。トークンのリフレッシュ失敗は
  // メール取得のポーリング中に裏側で起きるため、定期的にここで再チェックしてUIに反映する
  const refreshLinkedAccountsStatus = async () => {
    if (linkedAccountsRef.current.length === 0) return;
    try {
      const res = await fetch("/api/accounts");
      if (!res.ok) return;
      const data = await res.json();
      const rows = (data.accounts || []) as LinkedAccountRow[];
      setReauthNeededAccounts(rows.filter((a) => a.needs_reauth === 1).map((a) => a.account_email).filter(Boolean));
    } catch { /* 一時的な取得失敗は無視し、次回のポーリングに任せる */ }
  };

  // 読み込めなかったメールだけを ID で取り直す（一覧ごと取り直すと Gmail の利用上限にすぐ触れるため）。
  // 取り直せたものは一覧に足し、まだ読み込めないものだけを残して知らせ続ける
  const [isRetryingUnloaded, setIsRetryingUnloaded] = useState(false);
  const retryUnloaded = async () => {
    if (isRetryingUnloaded) return;
    setIsRetryingUnloaded(true);
    const myEmail = session?.user?.email || "";
    const flags: BoxFlags = { inbox: checkInbox, archive: checkArchive, spam: checkSpam, trash: checkTrash, sent: checkSent };
    const stillFailed: Record<string, string[]> = {};
    const fetched: Email[] = [];
    try {
      for (const [account, ids] of Object.entries(unloadedIds)) {
        for (let i = 0; i < ids.length; i += 50) {
          const chunk = ids.slice(i, i + 50);
          try {
            const params = new URLSearchParams({ ids: chunk.join(",") });
            if (account !== myEmail) params.append("accountEmail", account);
            const res = await fetch(`/api/emails?${params.toString()}`, { cache: "no-store" });
            if (!res.ok) { (stillFailed[account] ||= []).push(...chunk); continue; }
            const data = (await res.json()) as { messages?: Email[]; failedIds?: string[] };
            fetched.push(...(data.messages || []).map(m => ({ ...m, accountId: account })));
            if (data.failedIds?.length) (stillFailed[account] ||= []).push(...data.failedIds);
          } catch {
            (stillFailed[account] ||= []).push(...chunk);
          }
        }
      }
      if (fetched.length > 0) {
        let updated = applySyncResult(emailsRef.current, { messages: fetched, labelUpdates: [], deleted: [] }, flags);
        updated = reconcileFakeSentEmails(updated).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        applySyncedPersisted(syncConfigs(updated, chatConfigsRef.current, messageConfigsRef.current));
        setEmails(updated);
      }
      setUnloadedIds(stillFailed);
      if (Object.keys(stillFailed).length > 0) showErrorToast("まだ読み込めないメールがあります。Gmail の利用上限に触れている可能性があるので、1分ほど待ってからもう一度お試しください。");
    } finally {
      setIsRetryingUnloaded(false);
    }
  };

  // 自動更新。前回からの変化（新着・削除・ラベルの変化）だけを取り、新着メールの詳細だけを取りにいく。
  // 起点が無い・古すぎるアカウントがあれば、これまでどおり一覧を取り直す（そのとき起点も取り直す）
  const syncOrRefetch = async () => {
    if (syncingRef.current) return;
    const flags: BoxFlags = { inbox: checkInbox, archive: checkArchive, spam: checkSpam, trash: checkTrash, sent: checkSent };
    const myEmail = session?.user?.email || "";
    const accounts = [myEmail, ...linkedAccountsRef.current].filter(Boolean);
    if (accounts.some(a => !historyIdsRef.current[a])) {
      fetchEmails(100, "", { inbox: checkInbox, archive: checkArchive, spam: checkSpam, trash: checkTrash, sent: checkSent }, null, false, true, emailsRef.current, () => false, false);
      return;
    }
    syncingRef.current = true;
    try {
      let needRefetch = false;
      const results: { account: string; result: SyncResult }[] = [];
      await mapWithConcurrency(accounts, 3, async (account) => {
        try {
          const params = new URLSearchParams({ sync: "1", historyId: historyIdsRef.current[account] });
          if (account !== myEmail) params.append("accountEmail", account);
          const res = await fetch(`/api/emails?${params.toString()}`, { cache: "no-store" });
          if (!res.ok) { logWarn("sync.client", { status: res.status }); return; }
          const data = (await res.json()) as { reset?: boolean; historyId?: string; messages?: Email[]; labelUpdates?: { id: string; labelIds: string[] }[]; deleted?: string[] };
          if (data.reset) { delete historyIdsRef.current[account]; needRefetch = true; return; }
          if (data.historyId) historyIdsRef.current[account] = data.historyId;
          results.push({ account, result: { messages: (data.messages || []).map(m => ({ ...m, accountId: account })), labelUpdates: data.labelUpdates || [], deleted: data.deleted || [] } });
        } catch (e) {
          // 1つのアカウントの失敗で、ほかのアカウントの更新は止めない
          logWarn("sync.client", {}, e);
        }
      });
      // ゴミ箱から戻した・受信箱に戻したなど、まだ画面に無いメールが今の場所に入るようになったら、その詳細を取って足す
      const knownIds = new Set(emailsRef.current.map(e => e.id));
      await Promise.all(results.map(async ({ account, result }) => {
        const ids = idsToFetchForLabelChanges(knownIds, result.labelUpdates, flags).slice(0, 50);
        if (ids.length === 0) return;
        try {
          const params = new URLSearchParams({ ids: ids.join(",") });
          if (account !== myEmail) params.append("accountEmail", account);
          const res = await fetch(`/api/emails?${params.toString()}`, { cache: "no-store" });
          if (!res.ok) { logWarn("sync.fetchMovedIn", { status: res.status }); return; }
          const data = (await res.json()) as { messages?: Email[] };
          result.messages.push(...(data.messages || []).map(m => ({ ...m, accountId: account })));
        } catch (e) {
          logWarn("sync.fetchMovedIn", {}, e);
        }
      }));
      const changed = results.some(r => r.result.messages.length || r.result.labelUpdates.length || r.result.deleted.length);
      if (changed) {
        let updated = emailsRef.current;
        for (const { result } of results) updated = applySyncResult(updated, result, flags);
        updated = reconcileFakeSentEmails(updated).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        const nextPMsgs = syncConfigs(updated, chatConfigsRef.current, messageConfigsRef.current);
        applySyncedPersisted(nextPMsgs);
        setEmails(updated);
      }
      if (needRefetch) fetchEmails(100, "", { inbox: checkInbox, archive: checkArchive, spam: checkSpam, trash: checkTrash, sent: checkSent }, null, false, true, emailsRef.current, () => false, false);
    } finally {
      syncingRef.current = false;
    }
  };

  useEffect(() => {
    if (!session) return;
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        void syncOrRefetch();
        refreshLinkedAccountsStatus();
      }
    }, 60000);

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        if (emailsRef.current.length === 0) {
          fetchEmails(100, "", { inbox: checkInbox, archive: checkArchive, spam: checkSpam, trash: checkTrash, sent: checkSent }, null, false, false, [], () => false, true);
        } else {
          void syncOrRefetch();
        }
      }
    };
    const handleOnline = () => {
      void syncOrRefetch();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("online", handleOnline);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("online", handleOnline);
    };
  }, [session, checkInbox, checkArchive, checkSpam, checkTrash, checkSent]);

  return { searchServerSide, hasLoadedOnceRef, fetchChatCrossbox, fetchCrossboxForRoom, fetchGroupLoadMore, isRetryingUnloaded, retryUnloaded };
}
