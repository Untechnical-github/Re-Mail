// チャット一覧：表示するチャットの並び（下書き・ピン留め・新しい順）・非表示／ピン留め／名前を変えたチャットとメッセージの一覧・
// 一覧から消えたチャットを閉じる。useMailApp.ts から分けた（動きは変えない）
import { useEffect, useMemo, useRef, type MutableRefObject } from "react";
import type { Session } from "next-auth";
import type { ChatConfig, MessageConfig } from "../types/mail";
import type { Email } from "../types/email";
import { type RoomKeyStr, decodeRoomKey, keysOf } from "../lib/roomKey";
import type { SetState } from "./mailAppTypes";

export function useChatList({
  session, groupedEmails, allUniqueEmails, chatConfigs, messageConfigs, messageConfigKey, isAccountVisible, isRoomVisible, roomVisibilityKey, checkAccounts,
  checkInbox, checkArchive, checkSpam, checkTrash, checkSent, revealedCrossPrompts, draftChats, hasLoadedOnceRef, isLoading, selectedSender, setSelectedSender,
}: {
  session: Session | null;
  groupedEmails: Record<RoomKeyStr, Email[]>;
  allUniqueEmails: Email[];
  chatConfigs: Record<RoomKeyStr, ChatConfig>;
  messageConfigs: Record<RoomKeyStr, MessageConfig>;
  messageConfigKey: (messageId: string, accountHint?: string) => RoomKeyStr;
  isAccountVisible: (accountId?: string) => boolean;
  // チャットを出すか（アカウントと自分のアドレスのチェックボックス）。roomVisibilityKey はその判定が変わったら変わる値
  isRoomVisible: (room: RoomKeyStr) => boolean;
  roomVisibilityKey: string;
  checkAccounts: Record<string, boolean>;
  checkInbox: boolean;
  checkArchive: boolean;
  checkSpam: boolean;
  checkTrash: boolean;
  checkSent: boolean;
  revealedCrossPrompts: string[];
  draftChats: string[];
  hasLoadedOnceRef: MutableRefObject<boolean>;
  isLoading: boolean;
  selectedSender: RoomKeyStr | null;
  setSelectedSender: SetState<RoomKeyStr | null>;
}) {
  const senderList = useMemo<RoomKeyStr[]>(() => {

    const getLatestValidDate = (sender: RoomKeyStr): number => {
      const allEmails = groupedEmails[sender] || [];
      const config = chatConfigs[sender];

      const validEmails = allEmails.filter((e) => {
        const isTrash = e.labelIds?.includes("TRASH");
        const isSpam = e.labelIds?.includes("SPAM");
        const isInbox = e.labelIds?.includes("INBOX");
        const isSent = e.labelIds?.includes("SENT") || e.isMe;
        const isArchive = !isTrash && !isSpam && !isInbox && !isSent;

        if ((isInbox || isArchive || isSent) && (config?.isHidden || messageConfigs[messageConfigKey(e.id, e.accountId)]?.isHidden)) return false;
        if (!isAccountVisible(e.accountId)) return false;

        // ★修正: 送信済みの「絶対権限（他のラベルを無視）」を適用
        let isCurrentBox = false;
        if (isSent) {
            isCurrentBox = checkSent;
        } else {
            isCurrentBox = (isTrash && checkTrash) || (isSpam && checkSpam) || (isInbox && checkInbox) || (isArchive && checkArchive);
        }

        return isCurrentBox || revealedCrossPrompts.includes(e.id);
      });

      return validEmails[0] ? new Date(validEmails[0].date).getTime() : 0;
    };

    const allRoomKeys = Array.from(new Set([...keysOf(groupedEmails), ...draftChats])) as RoomKeyStr[];

    return allRoomKeys.filter((sender: RoomKeyStr) => {
      const config = chatConfigs[sender];
      if (config?.isHidden) return false;
      // 表示しないアカウント・自分のアドレスのチャットは、下書きだけのチャット・ピン留めしたチャットも出さない
      if (!isRoomVisible(sender)) return false;

      // 「作成」で作った未送信の下書きチャットは、送信するまで無条件で一覧に表示する
      if (draftChats.includes(sender) && (!groupedEmails[sender] || groupedEmails[sender].length === 0)) return true;

      const hasDisplayableEmail = (groupedEmails[sender] || []).some((e) => {
        const isTrash = e.labelIds?.includes("TRASH");
        const isSpam = e.labelIds?.includes("SPAM");
        const isInbox = e.labelIds?.includes("INBOX");
        const isSent = e.labelIds?.includes("SENT") || e.isMe;
        const isArchive = !isTrash && !isSpam && !isInbox && !isSent;

        if ((isInbox || isArchive || isSent) && (config?.isHidden || messageConfigs[messageConfigKey(e.id, e.accountId)]?.isHidden)) return false;
        if (!isAccountVisible(e.accountId)) return false;

        if (revealedCrossPrompts.includes(e.id)) return true;

        // ★修正: 送信済みの判定を最初に持ってくることで絶対的な権限を持たせる
        if (isSent) return checkSent;
        if (isTrash) return checkTrash;
        if (isSpam) return checkSpam;
        if (isArchive) return checkArchive;
        return checkInbox;
      });

      if (!hasDisplayableEmail && !config?.isPinned) return false;
      return true;

    }).sort((a: RoomKeyStr, b: RoomKeyStr): number => {
      // 作成直後の下書きチャットは通常のチャットと同様、一番上（ピン留めより上）に表示する
      const isDraftA = draftChats.includes(a) && (!groupedEmails[a] || groupedEmails[a].length === 0) ? 1 : 0;
      const isDraftB = draftChats.includes(b) && (!groupedEmails[b] || groupedEmails[b].length === 0) ? 1 : 0;
      if (isDraftA !== isDraftB) return isDraftB - isDraftA;

      const pinA = chatConfigs[a]?.isPinned ? 1 : 0;
      const pinB = chatConfigs[b]?.isPinned ? 1 : 0;
      if (pinA !== pinB) return pinB - pinA;

      const timeA = getLatestValidDate(a);
      const timeB = getLatestValidDate(b);
      return (isNaN(timeB) ? 0 : timeB) - (isNaN(timeA) ? 0 : timeA);
    });
  }, [groupedEmails, chatConfigs, messageConfigs, checkSent, checkInbox, checkArchive, checkSpam, checkTrash, checkAccounts, roomVisibilityKey, session, revealedCrossPrompts, draftChats]);

  const hiddenChats = keysOf(chatConfigs).filter(k => chatConfigs[k]?.isHidden);
  // messageConfigsは複合キーだが、他所（Modals.tsx等）との互換のため各要素のidは生のメッセージIDのまま返す
  const hiddenMsgs = keysOf(messageConfigs).filter(k => messageConfigs[k]?.isHidden).map(stateKey => {
    const { localKey: id } = decodeRoomKey(stateKey);
    return allUniqueEmails.find(e => e.id === id) || { id, subject: "過去のメッセージ", date: new Date().toISOString() };
  });
  // 非表示解除ボタン統合・ピン留め一覧・リセット画面（すべてのチャット/メッセージから選ぶ）で使う
  const pinnedChats = keysOf(chatConfigs).filter(k => chatConfigs[k]?.isPinned);
  const pinnedMsgs = keysOf(messageConfigs).filter(k => messageConfigs[k]?.isPinned).map(stateKey => {
    const { localKey: id } = decodeRoomKey(stateKey);
    return allUniqueEmails.find(e => e.id === id) || { id, subject: "過去のメッセージ", date: new Date().toISOString() };
  });
  const nameChangedChats = keysOf(chatConfigs).filter(k => !!chatConfigs[k]?.customName);

  // senderList からチャットが消えたら（フィルター変更・非表示化など）メッセージ画面を自動クローズ
  // ただし初回のメール取得が終わるまでは senderList が「まだ空なだけ」なので判定しない。
  // また、「作成」で候補から直接開いたチャットのように、そもそも現在のフィルターで
  // 一覧に表示される対象ではないチャットまで閉じてしまわないよう、
  // 過去に一度でも一覧に表示されていた（＝本当に消えた）場合のみクローズする
  const prevSenderListRef = useRef<string[]>(senderList);
  useEffect(() => {
    if (hasLoadedOnceRef.current && !isLoading && selectedSender) {
      const wasVisible = prevSenderListRef.current.includes(selectedSender);
      const isVisible = senderList.includes(selectedSender);
      if (wasVisible && !isVisible) {
        setSelectedSender(null);
        if (typeof window !== "undefined") {
          localStorage.removeItem("remail_selected_sender");
          localStorage.removeItem("remail_scroll_main");
        }
      }
    }
    prevSenderListRef.current = senderList;
  }, [senderList, isLoading]);

  return { senderList, hiddenChats, hiddenMsgs, pinnedChats, pinnedMsgs, nameChangedChats };
}
