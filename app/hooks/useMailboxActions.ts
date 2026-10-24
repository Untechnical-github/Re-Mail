// 選択したチャット・メールへの操作（非表示・ピン留め・移動・削除・既読／未読）と、継続フィルターの自動適用・開いたら既読にする。
// useMailApp.ts から分けた（動きは変えない）。Gmail への反映はアカウントごとに1回だけ送る（postMailboxChange）
import { useState, useEffect, useRef, type MutableRefObject } from "react";
import type { Session } from "next-auth";
import type { ChatConfig, MessageConfig, ModalState, SelectionMode, ModalTargetMode } from "../types/mail";
import type { Email } from "../types/email";
import { messageMatchesFilter } from "../lib/filterMatch";
import { type LocalKey, type RoomKeyStr, asLocalKey, decodeRoomKey, keysOf } from "../lib/roomKey";
import { capPinnedIds } from "../lib/pinnedIds";
import { logError, logWarn } from "../lib/safeLog";
import { groupIdsByAccount, type MoveDestination } from "../lib/mailboxOps";
import type { AccountSettings } from "../lib/syncedSettings";
import type { SetState, ConfigsApi, EmailModalState } from "./mailAppTypes";
import type { useMailSync } from "./useMailSync";

export function useMailboxActions({
  session, selectedSender, setSelectedSender, groupedEmails, emailRoomMap, allUniqueEmails, emails, setEmails, persistedEmails, setPersistedEmails,
  chatConfigs, chatConfigsRef, messageConfigsRef, updateMessageConfig, updateChatConfig, updateChatConfigByRoomKey, syncConfigs, applySyncedPersisted,
  resolveMessageAccountEmail, modal, exitAfterAction, checkInbox, checkArchive, checkSpam, checkTrash, checkSent, revealedCrossPrompts, setRevealedCrossPrompts,
  showErrorToast, accountSettings, emailModal,
  selectionMode, setSelectionMode, selectedIds, setSelectedIds, setModal, hasPushedSelectRef, emailsRef, fetchChatCrossbox, safeBack,
}: {
  session: Session | null;
  selectedSender: RoomKeyStr | null;
  setSelectedSender: SetState<RoomKeyStr | null>;
  groupedEmails: Record<RoomKeyStr, Email[]>;
  emailRoomMap: Map<string, RoomKeyStr>;
  allUniqueEmails: Email[];
  emails: Email[];
  setEmails: SetState<Email[]>;
  persistedEmails: Email[];
  setPersistedEmails: SetState<Email[]>;
  chatConfigs: Record<RoomKeyStr, ChatConfig>;
  chatConfigsRef: MutableRefObject<Record<RoomKeyStr, ChatConfig>>;
  messageConfigsRef: MutableRefObject<Record<RoomKeyStr, MessageConfig>>;
  updateMessageConfig: ConfigsApi["updateMessageConfig"];
  updateChatConfig: ConfigsApi["updateChatConfig"];
  updateChatConfigByRoomKey: ConfigsApi["updateChatConfigByRoomKey"];
  syncConfigs: ConfigsApi["syncConfigs"];
  applySyncedPersisted: (nextPMsgs: Email[]) => void;
  resolveMessageAccountEmail: (messageId: string) => string;
  modal: ModalState;
  exitAfterAction: () => void;
  checkInbox: boolean;
  checkArchive: boolean;
  checkSpam: boolean;
  checkTrash: boolean;
  checkSent: boolean;
  revealedCrossPrompts: string[];
  setRevealedCrossPrompts: SetState<string[]>;
  showErrorToast: (message: string) => void;
  accountSettings: Record<string, AccountSettings>;
  emailModal: EmailModalState;
  selectionMode: SelectionMode;
  setSelectionMode: SetState<SelectionMode>;
  selectedIds: string[];
  setSelectedIds: SetState<string[]>;
  setModal: SetState<ModalState>;
  hasPushedSelectRef: MutableRefObject<boolean>;
  emailsRef: MutableRefObject<Email[]>;
  fetchChatCrossbox: ReturnType<typeof useMailSync>["fetchChatCrossbox"];
  safeBack: () => void;
}) {
  // メッセージ単位の非表示のコア処理。modal状態に依存しないため、確認モーダル経由の実行と
  // 継続フィルターの自動適用エンジンの両方から呼べる
  // メッセージのルーム。開いているチャットに入っていればそのチャット（複数のチャットに出るメールで、操作した場所を優先する）
  const roomOfMessage = (id: string): RoomKeyStr | undefined =>
    selectedSender && (groupedEmails[selectedSender] || []).some(e => e.id === id) ? selectedSender : emailRoomMap.get(id);
  const applyHideToIds = (ids: string[]) => {
    ids.forEach(id => updateMessageConfig(asLocalKey(id), { isHidden: true, hiddenAtDate: new Date().toISOString(), roomId: roomOfMessage(id) }, resolveMessageAccountEmail(id)));
  };

  // メッセージ単位のピン留めのコア処理。modal状態に依存しないため、確認モーダル経由の実行と
  // 継続フィルターの自動適用エンジンの両方から呼べる（合計上限100件、TRASH/SPAMは対象外）
  const applyPinToIds = (ids: string[]) => {
    const existingPinnedMsgCount = keysOf(messageConfigsRef.current).filter(k =>
      messageConfigsRef.current[k]?.isPinned && messageConfigsRef.current[k]?.forceFetch
    ).length;
    const capped = ids.slice(0, Math.max(0, 100 - existingPinnedMsgCount));
    const pMsgs: Email[] = [];
    capped.forEach((targetId: string) => {
      const found = allUniqueEmails.find((e) => e.id === targetId);
      if (found && !found.labelIds?.includes("TRASH") && !found.labelIds?.includes("SPAM")) {
        // フィルターツール等、複数ルームにまたがるメッセージを対象にする場合があるため、
        // 常に selectedSender を使うのではなく、そのメッセージ自身の本来のルームを優先する
        const room = roomOfMessage(targetId) || selectedSender || undefined;
        const pData = { ...found, senderRoom: room ? decodeRoomKey(room).localKey : undefined };
        pMsgs.push(pData);
        updateMessageConfig(asLocalKey(targetId), { isPinned: true, forceFetch: true, roomId: room }, resolveMessageAccountEmail(targetId));
      }
    });
    if (pMsgs.length > 0) setPersistedEmails(prev => [...prev, ...pMsgs]);
  };

  // reset_select画面で選択された項目（"カテゴリ:chat|msg:id" の複合キー）を、
  // カテゴリごとに正しい解除処理へ振り分けて実行する。idの部分にはグループのローカルキー
  // （group:xxxx）自身がコロンを含むため、先頭2つのコロンだけで区切る（split(":")は使わない）
  const executeResetSelection = (compoundKeys: string[]) => {
    const pinChatTargets: RoomKeyStr[] = [];
    const pinMsgTargets: string[] = [];
    compoundKeys.forEach(key => {
      const firstColon = key.indexOf(":");
      const secondColon = key.indexOf(":", firstColon + 1);
      if (firstColon === -1 || secondColon === -1) return;
      const category = key.slice(0, firstColon);
      const level = key.slice(firstColon + 1, secondColon);
      const id = key.slice(secondColon + 1);
      if (category === "hide") {
        if (level === "chat") updateChatConfigByRoomKey(id as RoomKeyStr, { isHidden: false, hiddenAtDate: undefined, unhideOnNew: false });
        else updateMessageConfig(asLocalKey(id), { isHidden: false }, resolveMessageAccountEmail(id));
      } else if (category === "pin") {
        if (level === "chat") {
          updateChatConfigByRoomKey(id as RoomKeyStr, { isPinned: false, forceFetch: false, persistedIds: null });
          pinChatTargets.push(id as RoomKeyStr);
        } else {
          updateMessageConfig(asLocalKey(id), { isPinned: false, forceFetch: false }, resolveMessageAccountEmail(id));
          pinMsgTargets.push(id);
        }
      } else if (category === "name") {
        updateChatConfigByRoomKey(id as RoomKeyStr, { customName: undefined });
      }
    });
    // ピン留めを解除した分だけ、ローカルにキャッシュしていた永続表示用コピーも消しておく
    if (pinChatTargets.length > 0 || pinMsgTargets.length > 0) {
      const localChatKeys = pinChatTargets.map(t => decodeRoomKey(t).localKey);
      setPersistedEmails(prev => prev.filter(e => !(e.senderRoom && localChatKeys.includes(e.senderRoom as LocalKey)) && !pinMsgTargets.includes(e.id)));
    }
  };

  const executePin = () => {
    if (!modal) return;
    const isChatMode = modal.targetMode === "chat";

    if (isChatMode) {
      // チャットピン留め: 常に永続読み込み、上限10件
      const pMsgs = [...persistedEmails];
      const existingForcePinned = keysOf(chatConfigs).filter(k =>
        chatConfigs[k]?.isPinned && chatConfigs[k]?.forceFetch
      );
      const targets = modal.targets as RoomKeyStr[];
      const newToPin = targets.filter((t) => !existingForcePinned.includes(t));
      if (existingForcePinned.length + newToPin.length > 10) return;

      targets.forEach((targetId) => {
        const localId = decodeRoomKey(targetId).localKey;
        const pData = (groupedEmails[targetId] || []).map((e) => ({ ...e, senderRoom: localId }));
        pMsgs.push(...pData);
        updateChatConfigByRoomKey(targetId, { isPinned: true, forceFetch: true, persistedIds: capPinnedIds(pData.map(e => e.id)) });
      });
      setPersistedEmails(pMsgs);
    } else {
      // メッセージピン留め: 常に永続読み込み、合計上限100件
      applyPinToIds(modal.targets);
    }

    exitAfterAction();
  };

  const getActionableEmails = (targets: string[], targetMode: string) => {
    let result: Email[] = [];
    if (targetMode === "chat") {
      targets.forEach((chat: string) => {
        const chatEmails = groupedEmails[chat as RoomKeyStr] || [];
        result.push(...chatEmails.filter((e) => {
          const isTrash = e.labelIds?.includes("TRASH");
          const isSpam = e.labelIds?.includes("SPAM");
          const isInbox = e.labelIds?.includes("INBOX");
          const isSent = e.labelIds?.includes("SENT") || e.isMe; 
          const isArchive = !isTrash && !isSpam && !isInbox && !isSent; 
          
          // ★修正: モーダルでも送信済みの絶対権限を適用する
          let isCurrentBox = false;
          if (isSent) {
              isCurrentBox = checkSent;
          } else {
              isCurrentBox = (isTrash && checkTrash) || (isSpam && checkSpam) || (isInbox && checkInbox) || (isArchive && checkArchive);
          }
          return isCurrentBox || revealedCrossPrompts.includes(e.id);
        }));
      });
    } else {
      result = allUniqueEmails.filter((e) => targets.includes(e.id));
    }
    return result;
  };

  // メールの移動・削除（ゴミ箱へ）を Gmail に反映する。連携アカウントのメールは、そのアカウントとして送る
  // （accountEmail を付けないとメインアカウントのトークンが使われ、連携アカウントのメールには効かないため）。
  // 画面はもう移した表示になっているので、失敗したら再読み込みで元に戻ることと次の行動を伝える（絶対ルール3）
  const postMailboxChange = (kind: "move" | "delete" | "read" | "unread", ids: string[], destination?: MoveDestination) => {
    const myEmail = session?.user?.email || "";
    const owner = new Map<string, string>();
    persistedEmails.forEach(e => { if (e.accountId) owner.set(e.id, e.accountId); });
    emails.forEach(e => { if (e.accountId) owner.set(e.id, e.accountId); });
    // 送信直後の仮 ID は Gmail に無いので送らない
    const groups = groupIdsByAccount(ids.filter(id => !id.startsWith("fake-")), id => owner.get(id), myEmail);
    const label = kind === "delete" ? "削除" : kind === "move" ? "移動" : kind === "read" ? "既読" : "未読";
    groups.forEach((accountIds, accountEmail) => {
      const payload = kind === "delete"
        ? { action: "delete", accountEmail, trashIds: accountIds }
        : kind === "move"
          ? { action: "move", accountEmail, ids: accountIds, destination }
          : { action: "markRead", accountEmail, ids: accountIds, read: kind === "read" };
      fetch("/api/emails", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
        .then(res => {
          if (res.ok) return;
          logWarn(`${kind}.request`, { status: res.status, count: accountIds.length });
          showErrorToast(res.status === 401
            ? `${label}がGmailに反映されませんでした（ログインが切れています）。プロフィールのボタンから再ログインしてから、もう一度お試しください。`
            : kind === "read" || kind === "unread"
              // 既読・未読は場所を変えないので、「元の状態に戻る」と伝える
              ? `${label}がGmailに反映されませんでした。再読み込みすると元の既読・未読の状態に戻ります。時間をおいてもう一度お試しいただくか、純正 Gmail で操作してください。`
              : `${label}がGmailに反映されませんでした。再読み込みすると元の場所に戻ります。時間をおいてもう一度お試しいただくか、純正 Gmail で操作してください。`);
        })
        .catch(e => {
          logError(`${kind}.request`, {}, e);
          showErrorToast(`${label}がGmailに反映されなかった可能性があります。通信状況を確認し、再読み込みして確かめてください。`);
        });
    });
  };

  // 既読・未読にする（Gmail の UNREAD ラベルの付け外し）。画面はすぐに変え、Gmail にはアカウントごとに1回だけ送る。
  // すでにその状態のメール・送信直後の仮 ID は送らない（Gmail の呼び出しを増やさないため）
  const readInFlightRef = useRef<Set<string>>(new Set());
  // 自分で「未読にする」を押したメール。開いているチャットの自動の既読で、すぐに既読へ戻さないために覚えておく
  // （チャットを開き直したら忘れる）
  const manualUnreadRef = useRef<Set<string>>(new Set());
  const applyReadToIds = (ids: string[], read: boolean) => {
    const wanted = new Set(ids);
    const changed = allUniqueEmails
      .filter(e => wanted.has(e.id) && !e.id.startsWith("fake-") && !!e.labelIds?.includes("UNREAD") === read)
      .map(e => e.id);
    if (changed.length === 0) return;
    const changedSet = new Set(changed);
    const update = (e: Email): Email => {
      if (!changedSet.has(e.id)) return e;
      const labels = (e.labelIds || []).filter(l => l !== "UNREAD");
      return { ...e, labelIds: read ? labels : [...labels, "UNREAD"] };
    };
    setEmails(prev => prev.map(update));
    setPersistedEmails(prev => prev.map(update));
    changed.forEach(id => readInFlightRef.current.add(id));
    if (!read) changed.forEach(id => manualUnreadRef.current.add(id));
    postMailboxChange(read ? "read" : "unread", changed);
    // 送り終わったら、自動の既読でもう一度送れるようにする
    setTimeout(() => changed.forEach(id => readInFlightRef.current.delete(id)), 5000);
  };

  // 削除のコア処理（TRASH・SENT以外の「移動可能なメール」のみをゴミ箱へ移動）。modal状態に依存しないため、
  // 確認モーダル経由の実行と継続フィルターの自動適用エンジンの両方から呼べる
  const applyDeleteToIds = (ids: string[]) => {
    const deleteEmails = allUniqueEmails.filter((e) => ids.includes(e.id));
    const trashIds = deleteEmails.filter(e => !e.labelIds?.includes("TRASH") && !e.labelIds?.includes("SENT") && !e.isMe).map(e => e.id);
    if (trashIds.length === 0) return;
    try {
      const applyTrashLabels = (e: Email): Email => {
        if (trashIds.includes(e.id)) {
          const newLabels = (e.labelIds || []).filter((l: string) => l !== "INBOX" && l !== "SPAM");
          if (!newLabels.includes("TRASH")) newLabels.push("TRASH");
          return { ...e, labelIds: newLabels };
        }
        return e;
      };

      const nextEmails = emails.map(applyTrashLabels);
      const nextPersisted = persistedEmails.map(applyTrashLabels);

      const combined = new Map();
      nextPersisted.forEach(e => combined.set(e.id, e));
      nextEmails.forEach(e => combined.set(e.id, e));

      const nextPMsgs = syncConfigs(Array.from(combined.values()), chatConfigsRef.current, messageConfigsRef.current);

      setEmails(nextEmails);
      applySyncedPersisted(nextPMsgs);
      setRevealedCrossPrompts(prev => prev.filter(id => !trashIds.includes(id)));

      postMailboxChange("delete", trashIds);
    } catch (e) { logError("delete", {}, e); }
  };

  const executeConfirmedAction = async () => {
    if (!modal) return;
    const { type, targets, targetMode } = modal;
    
    if (type === "confirm_delete") {
      const deleteEmails = getActionableEmails(targets, targetMode);
      applyDeleteToIds(deleteEmails.map((e) => e.id));
      if (targetMode === "chat" && selectedSender !== null && targets.includes(selectedSender)) setSelectedSender(null);
    }
    else if (type === "confirm_hide") {
      if (targetMode === "msg") {
        applyHideToIds(targets);
      } else {
        (targets as RoomKeyStr[]).forEach(target => updateChatConfigByRoomKey(target, { isHidden: true, hiddenAtDate: new Date().toISOString() }));
        if (selectedSender !== null && targets.includes(selectedSender)) setSelectedSender(null);
      }
    }
    else if (type === "confirm_unpin") {
      if (targetMode === "chat") {
        const chatTargets = targets as RoomKeyStr[];
        chatTargets.forEach(targetId => updateChatConfigByRoomKey(targetId, { isPinned: false, forceFetch: false, persistedIds: null }));
        const localTargets = chatTargets.map(t => decodeRoomKey(t).localKey);
        setPersistedEmails(prev => prev.filter(e => !(e.senderRoom && localTargets.includes(e.senderRoom as LocalKey))));
      } else {
        (targets as string[]).forEach(targetId => updateMessageConfig(asLocalKey(targetId), { isPinned: false, forceFetch: false }, resolveMessageAccountEmail(targetId)));
        setPersistedEmails(prev => prev.filter(e => !targets.includes(e.id)));
      }
    }

    exitAfterAction();
  };

  // 場所ごとに異なる移動先へバッチ移動
  // 移動のコア処理。modal状態に依存せず exitAfterAction() も呼ばないため、
  // 継続フィルターの自動適用エンジン（バックグラウンド、モーダルもhistoryも関与しない）からも安全に呼べる
  const applyMoveToIds = (groups: { ids: string[], destination: string }[]) => {
    const allIds = groups.flatMap(g => g.ids);
    if (allIds.length === 0) return;

    const getDestForId = (id: string) => groups.find(g => g.ids.includes(id))?.destination;

    const applyNewLabels = (e: Email): Email => {
      const dest = getDestForId(e.id);
      if (!dest) return e;
      const newLabels = (e.labelIds || []).filter((l: string) => l !== "INBOX" && l !== "TRASH" && l !== "SPAM");
      if (dest !== "ARCHIVE") newLabels.push(dest);
      return { ...e, labelIds: newLabels };
    };

    const nextEmails = emails.map(applyNewLabels);
    const nextPersisted = persistedEmails.map(applyNewLabels);
    const combined = new Map();
    nextPersisted.forEach((e) => combined.set(e.id, e));
    nextEmails.forEach((e) => combined.set(e.id, e));
    const nextPMsgs = syncConfigs(Array.from(combined.values()), chatConfigsRef.current, messageConfigsRef.current);

    setEmails(nextEmails);
    applySyncedPersisted(nextPMsgs);
    setRevealedCrossPrompts((prev: string[]) => prev.filter(id => !allIds.includes(id)));

    groups.forEach(({ ids, destination }) => {
      if (ids.length > 0) postMailboxChange("move", ids, destination as MoveDestination);
    });
  };

  const executeBatchMove = async (groups: { ids: string[], destination: string }[]) => {
    applyMoveToIds(groups);
    exitAfterAction();
  };

  // アカウントの設定で「チャットを開いたら既読にする」がオンなら、開いているチャットに表示されている未読メールを既読にする。
  // 開いている間に届いたメールも既読にする（純正 Gmail でスレッドを開いているときと同じ）。
  // 画面が裏にあるときは既読にしない（見ていないメールを既読にしないため）
  const [pageVisible, setPageVisible] = useState(true);
  useEffect(() => {
    const onVis = () => setPageVisible(document.visibilityState === "visible");
    onVis();
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
  // 別のチャットを開いたら、「未読にする」を押したメールを忘れる（開き直したときは自動の既読の対象にする）
  useEffect(() => { manualUnreadRef.current.clear(); }, [selectedSender]);
  useEffect(() => {
    if (!selectedSender || !pageVisible) return;
    const me = session?.user?.email || "";
    const unread = getActionableEmails([selectedSender], "chat").filter(e =>
      e.labelIds?.includes("UNREAD") && !readInFlightRef.current.has(e.id) && !manualUnreadRef.current.has(e.id) &&
      !!accountSettings[e.accountId || me]?.autoReadOnOpenChat);
    if (unread.length > 0) applyReadToIds(unread.map(e => e.id), true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 開いているチャット・届いたメール・設定・画面の表示が変わったときだけ確かめる（関数は描画ごとに作り直されるため入れない）
  }, [selectedSender, groupedEmails, accountSettings, pageVisible, checkInbox, checkArchive, checkSpam, checkTrash, checkSent]);

  // アカウントの設定で「メールを開いたら既読にする」がオンなら、詳細を開いたメールを既読にする
  const openedMailId = emailModal?.email?.id;
  useEffect(() => {
    if (!openedMailId) return;
    const mail = allUniqueEmails.find(e => e.id === openedMailId);
    if (!mail?.labelIds?.includes("UNREAD") || readInFlightRef.current.has(mail.id)) return;
    if (accountSettings[mail.accountId || session?.user?.email || ""]?.autoReadOnOpenMail) applyReadToIds([mail.id], true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 開いたメールと設定が変わったときだけ確かめる（関数は描画ごとに作り直されるため入れない）
  }, [openedMailId, accountSettings]);

  // 継続フィルター（非表示/ピン留め/移動/削除）の自動適用エンジン。
  // allUniqueEmails が更新される（新着メール取得・タブ復帰時の再取得など）たびに、各継続フィルターの
  // filterLastAppliedAt より新しい日時のメールだけを対象に、1回だけ自動的にアクションを適用する
  // （Gmail自身のフィルター機能と同じ考え方）。手動で元に戻した（非表示解除等）メッセージは
  // カットオフより古い日時のまま残るため、次回以降の自動走査で再び対象になることはない
  useEffect(() => {
    keysOf(chatConfigsRef.current).forEach(stateKey => {
      const cfg = chatConfigsRef.current[stateKey];
      if (!cfg?.filterAction || !cfg.filterContinuous || !cfg.filterCriteria) return;
      const { accountEmail, localKey } = decodeRoomKey(stateKey);
      const cutoff = new Date(cfg.filterLastAppliedAt || cfg.filterCreatedAt || 0).getTime();
      const newMatches = allUniqueEmails.filter((e) => {
        // フィルターはアカウントごと。そのフィルターのアカウントのメールにだけ効かせる（ほかのアカウントのメールを動かさない）
        if ((e.accountId || session?.user?.email || "").toLowerCase() !== accountEmail.toLowerCase()) return false;
        const t = new Date(e.date).getTime();
        return !isNaN(t) && t > cutoff && messageMatchesFilter(e, cfg.filterCriteria!, accountEmail);
      });
      if (newMatches.length === 0) return;
      const ids = newMatches.map((e) => e.id);
      if (cfg.filterAction === "hide") {
        applyHideToIds(ids);
      } else if (cfg.filterAction === "pin") {
        applyPinToIds(ids);
      } else if (cfg.filterAction === "move") {
        applyMoveToIds([{ ids, destination: cfg.filterDestination! }]);
      } else if (cfg.filterAction === "delete") {
        applyDeleteToIds(ids);
      } else if (cfg.filterAction === "read" || cfg.filterAction === "unread") {
        applyReadToIds(ids, cfg.filterAction === "read");
      }
      updateChatConfig(localKey, { filterLastAppliedAt: new Date().toISOString() }, accountEmail);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allUniqueEmails]);

  // 選択モード（長押し・メニューから入る・選ぶ・抜ける）とメニューバーの操作
  const enterSelectionMode = (type: "chat" | "msg", id: string) => {
    const mode: SelectionMode = type === "chat" ? "chat_select" : "msg_select";
    setSelectionMode(mode);
    setSelectedIds([id]);
    if (type === "chat") {
      const { accountEmail, localKey } = decodeRoomKey(id);
      fetchChatCrossbox(localKey, accountEmail, false, emailsRef.current, true);
    }
    // 重複して積まない（既にselect履歴エントリがある場合はスキップ）
    if (!hasPushedSelectRef.current && window.history.state?.action !== "select") {
      window.history.pushState({ action: "select" }, "", window.location.href);
      hasPushedSelectRef.current = true;
    } else if (window.history.state?.action === "select") {
      hasPushedSelectRef.current = true;
    }
  };

  const handleMenuBarClick = (mode: string) => {
    const targetMode = mode.startsWith("chat") ? "chat" : "msg";
    const act = mode.replace("chat_", "").replace("msg_", "");
    const inSelection = selectionMode === `${targetMode}_select`;
    const hasSelection = inSelection && selectedIds.length > 0;

    // リセットは常にクリック可能（このボタン自体はチャット画面にしか無い）。選択中のチャットが
    // あればその範囲だけ、無ければ全チャット/メッセージから選ぶ画面を開く
    if (act === "reset") {
      const specificTargets = hasSelection ? [...selectedIds] : [];
      setModal({ type: "reset_select", targetMode: "chat", targets: specificTargets, resetScope: hasSelection ? "specific" : "all" });
      setSelectedIds([]);
      setSelectionMode("none");
      window.history.pushState({ action: "modal" }, "", window.location.href);
      return;
    }

    if (!inSelection || selectedIds.length === 0) return;

    if (act === "pin") {
      if (targetMode === "chat") {
        setModal({ type: "confirm_pin", targetMode: "chat", targets: [...selectedIds] });
      } else {
        setModal({ type: "categorized_action_select", targetMode: "msg", targets: [...selectedIds], action: "pin" });
      }
    } else if (act === "unpin") {
      setModal({ type: "confirm_unpin", targetMode: targetMode as ModalTargetMode, targets: [...selectedIds] });
    } else if (act === "hide") {
      if (targetMode === "chat") {
        setModal({ type: "confirm_hide", targetMode: "chat", targets: [...selectedIds] });
      } else {
        setModal({ type: "categorized_action_select", targetMode: "msg", targets: [...selectedIds], action: "hide" });
      }
    } else if (act === "delete") {
      // 選択がすべてグループチャットの場合は、実メールを一切触らない専用の削除フローにする
      if (targetMode === "chat" && selectedIds.every(id => chatConfigsRef.current[id as RoomKeyStr]?.isGroup)) {
        setModal({ type: "confirm_delete_group", targetMode: "chat", targets: [...selectedIds] });
      } else {
        setModal({ type: "categorized_action_select", targetMode: targetMode as ModalTargetMode, targets: [...selectedIds], action: "delete" });
      }
    } else if (act === "move") {
      setModal({ type: "categorized_action_select", targetMode: targetMode as ModalTargetMode, targets: [...selectedIds], action: "move" });
    } else if (act === "read" || act === "unread") {
      // 確認の画面は出さずにすぐ行う（いつでも戻せる操作のため）。チャットなら、そのチャットに表示されているメールすべて
      applyReadToIds(getActionableEmails([...selectedIds], targetMode).map(e => e.id), act === "read");
      // モーダルを開いていないので、選択の履歴を1つだけ戻して選択を終える（exitAfterAction はモーダルの分まで戻り、ページから出てしまう）
      safeBack();
      return;
    }
    window.history.pushState({ action: "modal" }, "", window.location.href);
  };

  const handleBackgroundClick = () => {
    if (selectionMode !== "none") safeBack();
  };

  const toggleSelection = (id: string) => {
    const isAdding = !selectedIds.includes(id);
    const next = isAdding ? [...selectedIds, id] : selectedIds.filter(i => i !== id);
    setSelectedIds(next);
    if (isAdding && selectionMode.startsWith("chat_")) {
      const { accountEmail, localKey } = decodeRoomKey(id);
      fetchChatCrossbox(localKey, accountEmail, false, emailsRef.current, true);
    }
    if (next.length === 0) {
      setSelectionMode("none");
      if (hasPushedSelectRef.current) {
        hasPushedSelectRef.current = false;
        // 選択用の履歴エントリを取り除く
        if (window.history.state?.action === "select") {
          window.history.back();
        }
      }
    }
  };

  return {
    applyHideToIds, applyPinToIds, executeResetSelection, executePin, getActionableEmails, applyReadToIds, applyDeleteToIds, executeConfirmedAction, applyMoveToIds, executeBatchMove,
    enterSelectionMode, handleMenuBarClick, handleBackgroundClick, toggleSelection,
  };
}
