// 設定の保存（ピン留め・非表示・名前変更・グループ・フィルターのチャットの設定、共通設定、アカウント設定）。
// useMailApp.ts から分けた（動きは変えない）。保存はアカウントごとの D1 の置き場所に、失敗したら自動で送り直す（configSaveQueue.ts）
import { useState, useEffect, useMemo, useRef, type Dispatch, type SetStateAction, type MutableRefObject } from "react";
import type { useSession } from "next-auth/react";
import type { ChatConfig, MessageConfig } from "../types/mail";
import type { Email } from "../types/email";
import { LocalKey, RoomKeyStr, asLocalKey, encodeRoomKey, decodeRoomKey, keysOf } from "../lib/roomKey";
import { sanitizeSyncedSettings, sanitizeAccountSettings, legacyAccountSettingsToCopy, syncedSettingsKey, type SyncedSettings, type AccountSettings } from "../lib/syncedSettings";
import { readPinnedIds, capPinnedIds, mergePinnedIds } from "../lib/pinnedIds";
import { logError, logWarn } from "../lib/safeLog";
import { createSaveQueue, type SaveQueue } from "../lib/configSaveQueue";

const CONFIG_SAVE_FAILED = "設定（ピン留め・名前変更など）を保存できませんでした。再読み込みすると元に戻ります。通信状況を確認して、もう一度お試しください。";
const CONFIG_SAVE_RETRYING = "設定（ピン留め・名前変更など）を保存できませんでした。通信が戻りしだい自動でもう一度保存します。保存できるまでページを閉じないでください。";
const SYNCED_SETTINGS_KEY = "__synced_settings__";
const ACCOUNT_SETTINGS_KEY_PREFIX = "__account_settings__:";

// /api/config が返す chat_configs の行
type D1ConfigRow = {
  chat_id: string;
  account_email: string | null;
  custom_name: string | null;
  is_pinned: number | null;
  is_hidden: number | null;
  hidden_at_date: string | null;
  unhide_on_new: number | null;
};

type SetState<T> = Dispatch<SetStateAction<T>>;
export type UseConfigsParams = {
  session: ReturnType<typeof useSession>["data"];
  showErrorToast: (message: string) => void;
  showInfoToast: (message: string | null, durationMs?: number) => void;
  selectedSender: RoomKeyStr | null;
  setSelectedSender: SetState<RoomKeyStr | null>;
  setChatConfigs: SetState<Record<RoomKeyStr, ChatConfig>>;
  setMessageConfigs: SetState<Record<RoomKeyStr, MessageConfig>>;
  chatConfigsRef: MutableRefObject<Record<RoomKeyStr, ChatConfig>>;
  messageConfigsRef: MutableRefObject<Record<RoomKeyStr, MessageConfig>>;
  setPersistedEmails: SetState<Email[]>;
  hydratePinnedEmails: (chatCfgs: Record<RoomKeyStr, ChatConfig>, msgCfgs: Record<RoomKeyStr, MessageConfig>, have: Email[]) => Promise<unknown>;
  accountSettings: Record<string, AccountSettings>;
  setAccountSettings: SetState<Record<string, AccountSettings>>;
  setAccountSettingsLoaded: SetState<boolean>;
  checkInbox: boolean; checkArchive: boolean; checkSpam: boolean; checkTrash: boolean; checkSent: boolean;
  useIconLabels: boolean; checkAccounts: Record<string, boolean>; checkOwnAddresses: Record<string, boolean>;
  setCheckInbox: SetState<boolean>; setCheckArchive: SetState<boolean>; setCheckSpam: SetState<boolean>; setCheckTrash: SetState<boolean>; setCheckSent: SetState<boolean>;
  setUseIconLabels: SetState<boolean>; setCheckAccounts: SetState<Record<string, boolean>>; setCheckOwnAddresses: SetState<Record<string, boolean>>;
};

export function useConfigs({
  session, showErrorToast, showInfoToast, selectedSender, setSelectedSender, setChatConfigs, setMessageConfigs, chatConfigsRef, messageConfigsRef, setPersistedEmails, hydratePinnedEmails, accountSettings, setAccountSettings, setAccountSettingsLoaded, checkInbox, checkArchive, checkSpam, checkTrash, checkSent, useIconLabels, checkAccounts, checkOwnAddresses, setCheckInbox, setCheckArchive, setCheckSpam, setCheckTrash, setCheckSent, setUseIconLabels, setCheckAccounts, setCheckOwnAddresses,
}: UseConfigsParams) {
  // 設定の保存は、失敗したら自動で送り直す（中身は app/lib/configSaveQueue.ts）。同じ行への保存は新しい値だけを送る。
  // 送り直してもだめなら、画面の表示はもう変わっているので、保存されていないこと（再読み込みで元に戻ること）を伝える（絶対ルール3）
  const saveQueueRef = useRef<SaveQueue | null>(null);
  const getSaveQueue = (): SaveQueue => {
    if (!saveQueueRef.current) {
      saveQueueRef.current = createSaveQueue({
        onRetrying: () => showErrorToast(CONFIG_SAVE_RETRYING),
        onRecovered: () => showInfoToast("設定を保存しました", 2500),
        onGaveUp: (key) => showErrorToast(key === SYNCED_SETTINGS_KEY || key.startsWith(ACCOUNT_SETTINGS_KEY_PREFIX)
          ? "設定をほかの端末と同期できませんでした。この端末では変えたとおりに動きます。通信状況を確認して、もう一度設定を変えてください。"
          : CONFIG_SAVE_FAILED),
      });
    }
    return saveQueueRef.current;
  };
  // 失敗した保存を送るときのステータスをログに残す（ステータスだけ。中身は出さない）
  const sendConfigRequest = async (op: string, input: string, init?: RequestInit): Promise<Response> => {
    try {
      const res = await fetch(input, init);
      if (!res.ok) logWarn(op, { status: res.status });
      return res;
    } catch (e) {
      logError(op, {}, e);
      throw e;
    }
  };
  useEffect(() => {
    // 通信が戻ったら、待たずに送り直す
    const onOnline = () => saveQueueRef.current?.flush();
    // まだ保存できていない設定があるときは、ページを閉じる前に確かめる（閉じると変更が消えるため）
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!saveQueueRef.current?.hasPending()) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, []);

  // ピン留め・非表示・名前変更・グループ・フィルターなどの設定を、そのアカウントの置き場所に保存する
  const saveConfigRow = async (row: { chat_id: string; account_email: string; custom_name: string; is_pinned?: boolean; is_hidden?: boolean; hidden_at_date?: string; unhide_on_new?: boolean }) => {
    const body = JSON.stringify(row);
    await getSaveQueue().save(encodeRoomKey(row.account_email, asLocalKey(row.chat_id)), () =>
      sendConfigRequest("config.save", "/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body }));
  };

  const loadD1Configs = async (): Promise<{ globalSettings: SyncedSettings | null; formatted: Record<RoomKeyStr, ChatConfig> }> => {
    let globalSettings: SyncedSettings | null = null;
    let loadedAccountSettings: Record<string, AccountSettings> | null = null;
    const formatted: Record<RoomKeyStr, ChatConfig> = {} as Record<RoomKeyStr, ChatConfig>;
    const formattedMessages: Record<RoomKeyStr, MessageConfig> = {} as Record<RoomKeyStr, MessageConfig>;
    try {
      const res = await fetch("/api/config");
      if (res.ok) {
        const data = await res.json();
        loadedAccountSettings = {};
        if (data.accountSettings && typeof data.accountSettings === "object") {
          for (const [acc, v] of Object.entries(data.accountSettings as Record<string, unknown>)) loadedAccountSettings[acc] = sanitizeAccountSettings(v);
        }
        (data.configs as D1ConfigRow[] | undefined)?.forEach((c) => {
          if (c.chat_id === "__GLOBAL_SETTINGS__" && c.custom_name) {
            try { globalSettings = sanitizeSyncedSettings(JSON.parse(c.custom_name)); } catch { /* 壊れた設定は無視して既定値を使う */ } return;
          }
          let customNameVal = c.custom_name || undefined;
          let forceFetchVal = false;
          let pinnedIdsVal: string[] | undefined = undefined;
          let roomIdVal = undefined;
          let isGroupVal = undefined;
          let groupMembersVal = undefined;
          let groupMemberAddressesVal = undefined;
          let groupModeVal = undefined;
          let groupHiddenMembersVal = undefined;
          let filterCriteriaVal = undefined;
          let filterHideOriginalVal = undefined;
          let filterActionVal = undefined;
          let filterContinuousVal = undefined;
          let filterDestinationVal = undefined;
          let filterCreatedAtVal = undefined;
          let filterLastAppliedAtVal = undefined;
          let filterIncludeExistingVal = undefined;
          if (customNameVal && customNameVal.startsWith('{')) {
            try {
              const parsed = JSON.parse(customNameVal);
              customNameVal = parsed.name; forceFetchVal = parsed.forceFetch; roomIdVal = parsed.roomId;
              isGroupVal = parsed.isGroup; groupMembersVal = parsed.groupMembers; groupModeVal = parsed.groupMode;
              groupMemberAddressesVal = parsed.groupMemberAddresses; groupHiddenMembersVal = parsed.groupHiddenMembers;
              filterCriteriaVal = parsed.filterCriteria; filterHideOriginalVal = parsed.filterHideOriginal;
              filterActionVal = parsed.filterAction; filterContinuousVal = parsed.filterContinuous; filterDestinationVal = parsed.filterDestination;
              filterCreatedAtVal = parsed.filterCreatedAt; filterLastAppliedAtVal = parsed.filterLastAppliedAt;
              filterIncludeExistingVal = parsed.filterIncludeExisting;
              // ピン留めは Gmail のメッセージ ID だけを保存している（中身は端末キャッシュと Gmail から埋める）
              pinnedIdsVal = readPinnedIds(parsed);
            } catch { /* 壊れた保存データは無視する */ }
          }
          // roomIdの有無で、room単位の設定かメッセージ単位の設定かを振り分ける
          // （メッセージ単位はGmailメッセージIDそのものがchat_idに入っており、roomIdフィールドで
          // どのroomに属するかを示す。room単位の行にはroomIdは存在しない）。
          // stateのキーは常にencodeRoomKey済みの複合roomKeyに揃える（D1のaccount_email列 + chat_id列）
          const stateKey = encodeRoomKey(c.account_email || session?.user?.email || "", c.chat_id as LocalKey);
          if (roomIdVal !== undefined) {
            formattedMessages[stateKey] = { isPinned: c.is_pinned === 1, isHidden: c.is_hidden === 1, hiddenAtDate: c.hidden_at_date || undefined, unhideOnNew: c.unhide_on_new === 1, forceFetch: forceFetchVal, roomId: roomIdVal };
          } else {
            formatted[stateKey] = { customName: customNameVal, isPinned: c.is_pinned === 1, isHidden: c.is_hidden === 1, hiddenAtDate: c.hidden_at_date || undefined, unhideOnNew: c.unhide_on_new === 1, forceFetch: forceFetchVal, persistedIds: pinnedIdsVal, isGroup: isGroupVal, groupMembers: groupMembersVal, groupMemberAddresses: groupMemberAddressesVal, groupMode: groupModeVal, groupHiddenMembers: groupHiddenMembersVal, filterCriteria: filterCriteriaVal, filterHideOriginal: filterHideOriginalVal, filterAction: filterActionVal, filterContinuous: filterContinuousVal, filterDestination: filterDestinationVal, filterCreatedAt: filterCreatedAtVal, filterLastAppliedAt: filterLastAppliedAtVal, filterIncludeExisting: filterIncludeExistingVal };
          }
        });
        setChatConfigs(formatted); setMessageConfigs(formattedMessages); setPersistedEmails([]);
        // 端末キャッシュと Gmail から、ピン留めメールの中身を後から埋める（最初の表示は待たせない）
        void hydratePinnedEmails(formatted, formattedMessages, []);
      }
      else {
        logWarn("config.load", { status: res.status });
        showErrorToast("ピン留め・名前変更などの設定を読み込めませんでした。再読み込みしてください。");
      }
    } catch (e) {
      logError("config.load", {}, e);
      showErrorToast("ピン留め・名前変更などの設定を読み込めませんでした。通信状況を確認して再読み込みしてください。");
    }
    // 宛先の表示は以前は共通設定だった。まだ決めていないアカウントには、その値を写して保存する
    if (loadedAccountSettings) {
      const copies = legacyAccountSettingsToCopy(globalSettings, loadedAccountSettings);
      for (const [acc, add] of Object.entries(copies)) {
        loadedAccountSettings[acc] = { ...loadedAccountSettings[acc], ...add };
        saveAccountSettingRow(acc, add);
      }
      setAccountSettings(loadedAccountSettings);
    }
    // 読めたときだけ「読み終えた」にする（読めなかったら、オフにしているかもしれないので Gmail の下書きとの同期を始めない）
    if (loadedAccountSettings) setAccountSettingsLoaded(true);
    return { globalSettings, formatted };
  };

  // 共通設定（どのアカウントでログインしても同じ。名前と型は app/lib/syncedSettings.ts の COMMON_SETTING_KEYS）。
  // 新しい共通設定を足すときは、ここと下の applySyncedSettings にも足す。アカウントごとの設定は accountSettings に持つ
  const syncedSettings: SyncedSettings = useMemo(() => ({
    inbox: checkInbox, archive: checkArchive, spam: checkSpam, trash: checkTrash, sent: checkSent,
    iconLabels: useIconLabels, accounts: checkAccounts, ownAddresses: checkOwnAddresses,
  }), [checkInbox, checkArchive, checkSpam, checkTrash, checkSent, useIconLabels, checkAccounts, checkOwnAddresses]);
  // D1 から読んだ設定を画面に反映する（D1 に無い設定は、この端末の今の値のまま）
  const applySyncedSettings = (s: SyncedSettings) => {
    if (s.inbox !== undefined) setCheckInbox(s.inbox);
    if (s.archive !== undefined) setCheckArchive(s.archive);
    if (s.spam !== undefined) setCheckSpam(s.spam);
    if (s.trash !== undefined) setCheckTrash(s.trash);
    if (s.sent !== undefined) setCheckSent(s.sent);
    if (s.iconLabels !== undefined) setUseIconLabels(s.iconLabels);
    if (s.accounts !== undefined) setCheckAccounts(s.accounts);
    if (s.ownAddresses !== undefined) setCheckOwnAddresses(s.ownAddresses);
  };
  // D1 から読み終えるまでは保存しない（読む前のこの端末の値で、ほかの端末で変えた設定を上書きしないため）
  const [syncedSettingsReady, setSyncedSettingsReady] = useState(false);
  // 最後に D1 にあると分かっている設定。今の値と違うときだけ保存する
  const savedSyncedKeyRef = useRef("");
  useEffect(() => {
    if (!syncedSettingsReady) return;
    const key = syncedSettingsKey(syncedSettings);
    if (key === savedSyncedKeyRef.current) return;
    // 続けて切り替えたときに何度も保存しないよう、少し待ってからまとめて保存する
    // 失敗したら、ほかの設定と同じく自動で送り直す
    const body = JSON.stringify({ global_settings: syncedSettings });
    const timer = setTimeout(() => {
      void getSaveQueue().save(SYNCED_SETTINGS_KEY, async () => {
        const res = await sendConfigRequest("config.saveSynced", "/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body });
        if (res.ok) savedSyncedKeyRef.current = key;
        return res;
      });
    }, 800);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- getSaveQueue は ref から同じキューを返すだけで、描画ごとに作り直されるため入れると毎回保存が走る
  }, [syncedSettings, syncedSettingsReady]);

  // アカウント設定の変えた分を、そのアカウントの置き場所に保存する（失敗したら自動で送り直す）
  function saveAccountSettingRow(account: string, updates: AccountSettings) {
    const body = JSON.stringify({ account_settings: updates, account_email: account });
    void getSaveQueue().save(`${ACCOUNT_SETTINGS_KEY_PREFIX}${account}`, () =>
      sendConfigRequest("config.saveAccount", "/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body }));
  }
  // アカウント設定を1つ変えて、そのアカウントの置き場所に保存する（失敗したら自動で送り直す）
  const setAccountSetting = (account: string, updates: AccountSettings) => {
    if (!account) return;
    setAccountSettings(prev => ({ ...prev, [account]: { ...prev[account], ...updates } }));
    saveAccountSettingRow(account, updates);
  };
  // そのアカウントのメールで、外部の画像を押さずに読み込むか
  const alwaysLoadImagesFor = (account: string | undefined): boolean =>
    !!accountSettings[account || session?.user?.email || ""]?.alwaysLoadImages;

  const saveGlobalSettings = async (inbox: boolean, archive: boolean, spam: boolean, trash: boolean, sent: boolean) => {
    if (typeof window !== "undefined") {
      localStorage.setItem("remail_box_settings", JSON.stringify({ inbox, archive, spam, trash, sent }));
    }
  };

  // targetId は常に「D1のchat_id列にそのまま入る生のローカルキー」（相手名やgroup:xxxx等）を渡してもらい、
  // accountEmail は別引数で明示的に渡す（フェーズ2〜4で実際の複数アカウントが導入されるまでは、
  // 呼び出し側は常に自分自身のアカウント=session.user.emailを渡す）。
  // state（chatConfigs）上のキーだけ、ここでencodeRoomKeyして複合化する
  // （groupedEmails・selectedSenderと同じ複合roomKey空間に揃えるため。D1のchat_id自体は生のまま）
  const updateChatConfig = async (targetId: LocalKey, updates: Partial<ChatConfig>, accountEmail: string) => {
    const stateKey = encodeRoomKey(accountEmail, targetId);
    const nextConfig = { ...chatConfigsRef.current[stateKey], ...updates };
    setChatConfigs(prev => ({ ...prev, [stateKey]: nextConfig }));
    let nameToSave = nextConfig.customName || "";
    if (nextConfig.forceFetch || nextConfig.isGroup || nextConfig.filterAction) {
      nameToSave = JSON.stringify({
        // 最後に保存した時刻（アカウントごとの写しのうち、どれが新しいかを決めるのに使う）
        updatedAt: Date.now(),
        // ピン留めはメールの中身を保存せず、Gmail のメッセージ ID だけを保存する（絶対ルール1）
        name: nextConfig.customName, forceFetch: nextConfig.forceFetch, ids: nextConfig.persistedIds ? capPinnedIds(nextConfig.persistedIds) : undefined,
        isGroup: nextConfig.isGroup, groupMembers: nextConfig.groupMembers, groupMemberAddresses: nextConfig.groupMemberAddresses, groupMode: nextConfig.groupMode,
        groupHiddenMembers: nextConfig.groupHiddenMembers,
        filterCriteria: nextConfig.filterCriteria, filterHideOriginal: nextConfig.filterHideOriginal,
        filterAction: nextConfig.filterAction, filterContinuous: nextConfig.filterContinuous, filterDestination: nextConfig.filterDestination,
        filterCreatedAt: nextConfig.filterCreatedAt, filterLastAppliedAt: nextConfig.filterLastAppliedAt,
        filterIncludeExisting: nextConfig.filterIncludeExisting,
      });
    }
    await saveConfigRow({ chat_id: targetId, account_email: accountEmail, custom_name: nameToSave, is_pinned: nextConfig.isPinned, is_hidden: nextConfig.isHidden, hidden_at_date: nextConfig.hiddenAtDate, unhide_on_new: nextConfig.unhideOnNew });
  };

  // メッセージ単位の設定（ピン留め・非表示）。room単位のupdateChatConfigとはstate/キー空間が別
  // （どちらもD1の chat_configs テーブル自体は共有しており、chat_id列に room名 か メッセージID かの
  // どちらが入るかだけが違う。custom_name列にroomId等をJSONで詰める形式もroom側と共通）。
  // targetIdは生のGmailメッセージID、stateキーだけencodeRoomKeyで複合化する
  const updateMessageConfig = async (targetId: LocalKey, updates: Partial<MessageConfig>, accountEmail: string) => {
    const stateKey = encodeRoomKey(accountEmail, targetId);
    const nextConfig = { ...messageConfigsRef.current[stateKey], ...updates };
    setMessageConfigs(prev => ({ ...prev, [stateKey]: nextConfig }));
    let nameToSave = "";
    if (nextConfig.forceFetch || nextConfig.roomId) {
      // メッセージ単位のピン留めは chat_id がメッセージ ID そのものなので、中身は何も保存しない
      nameToSave = JSON.stringify({ forceFetch: nextConfig.forceFetch, roomId: nextConfig.roomId });
    }
    await saveConfigRow({ chat_id: targetId, account_email: accountEmail, custom_name: nameToSave, is_pinned: nextConfig.isPinned, is_hidden: nextConfig.isHidden, hidden_at_date: nextConfig.hiddenAtDate, unhide_on_new: nextConfig.unhideOnNew });
  };

  // グループチャットの削除: 設定行そのものを消すだけで、メンバーの個別チャットや実際のメールには一切触れない
  const deleteChatConfig = async (targetId: LocalKey, accountEmail: string) => {
    const stateKey = encodeRoomKey(accountEmail, targetId);
    // グループを削除する場合、そのグループの作成によって非表示にした個別チャットは表示に戻す
    const cfg = chatConfigsRef.current[stateKey];
    if (cfg?.isGroup && cfg.groupHiddenMembers?.length) {
      cfg.groupHiddenMembers.forEach(member => {
        updateChatConfig(asLocalKey(member), { isHidden: false }, accountEmail);
      });
    }

    setChatConfigs(prev => {
      const next = { ...prev };
      delete next[stateKey];
      return next;
    });
    // ピン留めされていた場合、ローカルにキャッシュしていたメッセージのコピーも消しておく
    // （D1側の行は削除で一括して消えるが、ローカルstateはそれとは別に残ってしまうため）
    // senderRoomだけで突き合わせると、別アカウントに同じ表示名（localKey）の相手がいる場合に
    // そちらの永続データまで消してしまうため、accountIdも一致するものだけに絞り込む
    setPersistedEmails(prev => prev.filter((e) => !(e.senderRoom === targetId && (e.accountId || session?.user?.email || "") === accountEmail)));
    if (selectedSender === stateKey) {
      setSelectedSender(null);
      if (typeof window !== "undefined") {
        localStorage.removeItem("remail_selected_sender");
        localStorage.removeItem("remail_scroll_main");
      }
    }
    // 削除も同じ行の保存として扱う（削除の後に古い値の送り直しで行が戻らないように。削除は何度送っても同じ）
    const url = `/api/config?chat_id=${encodeURIComponent(targetId)}&account_email=${encodeURIComponent(accountEmail)}`;
    await getSaveQueue().save(stateKey, () => sendConfigRequest("config.delete", url, { method: "DELETE" }));
  };

  // UI層（Modals.tsx等）はチャットの識別子として常に複合キー（RoomKeyStr、chatConfigsのstateキーと同じもの）
  // だけを扱う。roomKeyの直接パース（decodeRoomKey）をこのファイル以外に書かないというルールを守るため、
  // UI側から呼ぶ場合は生のupdateChatConfig/deleteChatConfigではなく必ずこちらを経由する
  const updateChatConfigByRoomKey = (room: RoomKeyStr, updates: Partial<ChatConfig>) => {
    const { accountEmail, localKey } = decodeRoomKey(room);
    return updateChatConfig(localKey, updates, accountEmail);
  };
  const deleteChatConfigByRoomKey = (room: RoomKeyStr) => {
    const { accountEmail, localKey } = decodeRoomKey(room);
    return deleteChatConfig(localKey, accountEmail);
  };

  const syncConfigs =(latestEmails: Email[], currentChatConfigs: Record<RoomKeyStr, ChatConfig>, currentMessageConfigs: Record<RoomKeyStr, MessageConfig>) => {
    const pMsgs: Email[] = [];
    const chatUpdatesToD1: { id: LocalKey, accountEmail: string, updates: Partial<ChatConfig> }[] = [];
    const msgUpdatesToD1: { id: LocalKey, accountEmail: string, updates: Partial<MessageConfig> }[] = [];

    // room単位: ピン留め（全メッセージの永続表示を最新化）・非表示（unhideOnNewでの自動解除）
    keysOf(currentChatConfigs).forEach(stateKey => {
      const { accountEmail, localKey: targetId } = decodeRoomKey(stateKey);
      const config = currentChatConfigs[stateKey];
      let hasUpdate = false;
      const newConfig: Partial<ChatConfig> = { ...config };

      if (config?.isPinned && config.forceFetch) {
        // latestEmailsは全アカウント分を含むため、accountIdも一致するものだけに絞り込む
        // （そうしないと別アカウントの同名（同一localKey）の相手のメールが混入する）
        const chatEmails = latestEmails.filter(e => {
           const room = e.senderRoom || (e.from.split("<")[0].replace(/"/g, "").trim() || "Unknown");
           const emailAccount = e.accountId || session?.user?.email || "";
           return room === targetId && emailAccount === accountEmail && !e.labelIds?.includes("TRASH") && !e.labelIds?.includes("SPAM");
        }).map(e => ({...e, senderRoom: targetId}));

        // まだ読み込めていないピン留めの ID は残す（落とすと古いメールのピン留めが消えるため）。
        // ゴミ箱・迷惑メールに移ったもの、Gmail に存在しなかったものだけ外す
        const oldIds = config.persistedIds || [];
        const dropIds = new Set(latestEmails.filter(e => oldIds.includes(e.id) && (e.isMissing || e.labelIds?.includes("TRASH") || e.labelIds?.includes("SPAM"))).map(e => e.id));
        const nextIds = mergePinnedIds(chatEmails.map(e => e.id), oldIds, dropIds);
        if (oldIds.join(",") !== nextIds.join(",")) {
           newConfig.persistedIds = nextIds.length > 0 ? nextIds : null; hasUpdate = true;
        }
        const idSet = new Set(nextIds);
        pMsgs.push(...latestEmails.filter(e => idSet.has(e.id) && !e.isMissing).map(e => ({ ...e, senderRoom: targetId })));
      }

      // unhideOnNew が有効な場合のみ、非表示日時より新しいメールがあれば自動解除
      if (config?.isHidden && config.unhideOnNew) {
        const hiddenDate = config.hiddenAtDate ? new Date(config.hiddenAtDate) : new Date(0);
        const hasNewEmail = latestEmails.some(e => {
          const room = e.senderRoom || (e.from.split("<")[0].replace(/"/g, "").trim() || "Unknown");
          const emailAccount = e.accountId || session?.user?.email || "";
          return room === targetId &&
                 emailAccount === accountEmail &&
                 !e.labelIds?.includes("TRASH") &&
                 !e.labelIds?.includes("SPAM") &&
                 new Date(e.date) > hiddenDate;
        });
        if (hasNewEmail) {
          newConfig.isHidden = false; newConfig.hiddenAtDate = undefined; newConfig.unhideOnNew = false; hasUpdate = true;
        }
      }

      if (hasUpdate) chatUpdatesToD1.push({ id: targetId, accountEmail, updates: newConfig });
    });

    // メッセージ単位: ピン留めしたメッセージがゴミ箱/迷惑メールへ移動されたら自動解除、
    // forceFetchがONならそのメッセージ自身を永続表示の対象に含める
    keysOf(currentMessageConfigs).forEach(stateKey => {
      const { accountEmail, localKey: targetId } = decodeRoomKey(stateKey);
      const config = currentMessageConfigs[stateKey];
      let hasUpdate = false;
      const newConfig: Partial<MessageConfig> = { ...config };

      if (config?.isPinned) {
        const msg = latestEmails.find(e => e.id === targetId);
        // 読み込めていないだけのメールはピン留めを外さない（端末キャッシュや Gmail から後で埋める）。
        // Gmail で削除されていたものは「このメールは存在しません」として残し、黙って消さない
        if (msg && (msg.labelIds?.includes("TRASH") || msg.labelIds?.includes("SPAM"))) {
          newConfig.isPinned = false; newConfig.forceFetch = false; hasUpdate = true;
        } else if (msg && config.forceFetch) {
          pMsgs.push(msg.isMissing ? msg : { ...msg, senderRoom: config.roomId ? decodeRoomKey(config.roomId).localKey : msg.senderRoom });
        }
      }

      if (config?.isHidden) {
        const msg = latestEmails.find(e => e.id === targetId);
        if (!msg || msg.labelIds?.includes("TRASH") || msg.labelIds?.includes("SPAM")) {
          newConfig.isHidden = false; newConfig.hiddenAtDate = undefined; newConfig.roomId = undefined; hasUpdate = true;
        }
      }

      if (hasUpdate) msgUpdatesToD1.push({ id: targetId, accountEmail, updates: newConfig });
    });

    chatUpdatesToD1.forEach(u => updateChatConfig(u.id, u.updates, u.accountEmail));
    msgUpdatesToD1.forEach(u => updateMessageConfig(u.id, u.updates, u.accountEmail));
    return pMsgs;
  };

  return {
    loadD1Configs, applySyncedSettings, setSyncedSettingsReady, savedSyncedKeyRef, setAccountSetting, alwaysLoadImagesFor, saveGlobalSettings, updateChatConfig, updateMessageConfig, deleteChatConfig, updateChatConfigByRoomKey, deleteChatConfigByRoomKey, syncConfigs,
  };
}
