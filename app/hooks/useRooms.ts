// ルームの計算：メールを相手ごと・グループごとのチャットに分ける・メッセージからルームとアカウントを引く・相手の名前とアドレス・
// 宛先の候補・グループの返信元の候補。useMailApp.ts から分けた（動きは変えない。分け方そのものは app/lib/groupEmails.ts）
import { useCallback, useEffect, useMemo, useRef, type MutableRefObject } from "react";
import type { Session } from "next-auth";
import type { ChatConfig, MessageConfig } from "../types/mail";
import type { Email } from "../types/email";
import { isMineEmail } from "../lib/filterMatch";
import { groupEmailsByRoom, mergeAccountGroups, applyFilterGroups, groupMemberAddresses, roomPartner } from "../lib/groupEmails";
import { type LocalKey, type RoomKeyStr, encodeRoomKey, decodeRoomKey, keysOf } from "../lib/roomKey";
import { parseAddressSet, sameAddressSet } from "../lib/mailAppHelpers";
import { mailIdentity } from "../lib/historySync";
import type { useSendAs } from "./useSendAs";

export function useRooms({
  session, chatConfigs, allUniqueEmails, sendAsByAccount, linkedAccounts, messageConfigsRef,
}: {
  session: Session | null;
  chatConfigs: Record<RoomKeyStr, ChatConfig>;
  allUniqueEmails: Email[];
  sendAsByAccount: ReturnType<typeof useSendAs>["sendAsByAccount"];
  linkedAccounts: string[];
  messageConfigsRef: MutableRefObject<Record<RoomKeyStr, MessageConfig>>;
}) {
  // 実際のグルーピングロジックは app/lib/groupEmails.ts の純粋関数に切り出してある
  // （副作用のない形でユニットテストできるようにするため）。groupedEmails・chatConfigs・
  // selectedSender は常に encodeRoomKey 済みの複合roomKey（RoomKeyStr）をキーとする。
  // chatConfigsは既に複合キーなので、groupEmailsByRoom（1アカウント分・ローカルキー前提の
  // 純粋関数）に渡す前に対象アカウント分だけローカルキーへ戻し、結果をmergeAccountGroupsで
  // 複合キーへ戻す。allUniqueEmailsも同様に、そのアカウント自身のメール（e.accountId一致）だけに
  // 絞り込んでから渡す（絞り込まないと、他アカウント宛のメールまでこのアカウントの相手名で
  // 誤ってグルーピングされてしまう）。accountId未設定（導入前のデータ・送信直後のローカルfake等）は
  // メインアカウント名義として扱う
  const groupedEmails = useMemo(() => {
    const myEmail = session?.user?.email || "";
    const accounts = [myEmail, ...linkedAccounts];
    const perAccountGroups = accounts.map(accountEmail => {
      const localChatConfigs: Record<LocalKey, ChatConfig> = {} as Record<LocalKey, ChatConfig>;
      keysOf(chatConfigs).forEach(key => {
        try {
          const decoded = decodeRoomKey(key);
          if (decoded.accountEmail === accountEmail) localChatConfigs[decoded.localKey] = chatConfigs[key];
        } catch { /* 複合roomKeyでない古いデータ（移行前の残り等）は無視する */ }
      });
      const accountEmails = allUniqueEmails.filter(e => (e.accountId || myEmail) === accountEmail);
      const aliases = (sendAsByAccount[accountEmail] || []).map(a => a.sendAsEmail);
      return { accountEmail, groups: groupEmailsByRoom(accountEmails, accountEmail, localChatConfigs, aliases) };
    });
    const merged = mergeAccountGroups(perAccountGroups);
    // フィルターグループ（filterCriteria持ち）は受信専用のため、上のアカウント単位の集約を
    // 対象外にしてある（groupEmailsByRoom側）。ここで全アカウント分のメールをまたいで
    // 別途集約する（criteria.accountEmailで対象アカウントを絞り込める）
    return applyFilterGroups(merged, chatConfigs, allUniqueEmails, myEmail);
  }, [allUniqueEmails, session, chatConfigs, linkedAccounts, sendAsByAccount]);

  // メール（アカウント＋ID）→ ルーム。連携アカウントどうしのメールは同じ ID で両方のアカウントに入ることがあるため、
  // 画面に出ているメールそのもののルームを引くときはこちらを使う
  const roomByIdentity = useMemo(() => {
    const myEmail = session?.user?.email || "";
    const map = new Map<string, RoomKeyStr>();
    keysOf(groupedEmails).forEach(room => (groupedEmails[room] || []).forEach((e) => map.set(mailIdentity(e, myEmail), room)));
    return map;
  }, [groupedEmails, session]);
  const sessionEmail = session?.user?.email || "";
  const roomOfEmail = useCallback((e: Email): RoomKeyStr | undefined => roomByIdentity.get(mailIdentity(e, sessionEmail)), [roomByIdentity, sessionEmail]);

  const groupedEmailsRef = useRef(groupedEmails);
  useEffect(() => { groupedEmailsRef.current = groupedEmails; }, [groupedEmails]);

  // メッセージID → 所属ルームキーの逆引き。フィルターツールで複数ルームにまたがる
  // メッセージを一括非表示/ピン留めする際、各メッセージ自身の本来のルームを正しく特定するために使う。
  // 自分が送ったメールは宛先の人のチャットすべてに出る（1通が複数のルームに入る）ので、ここには最後に見つけたルームが入る。
  // どのルームでも同じアカウントなので、アカウントの判定には使える。ルームそのものが要るときは roomOfMessage を使う
  const emailRoomMap = useMemo(() => {
    const map = new Map<string, RoomKeyStr>();
    keysOf(groupedEmails).forEach(room => (groupedEmails[room] || []).forEach((e) => map.set(e.id, room)));
    return map;
  }, [groupedEmails]);

  // メッセージが実際にどのアカウントに属するかを解決する。
  // 1) 既にそのメッセージの設定行が存在すればそのアカウントを最優先で再利用する
  //    （非表示化した後にメールデータがローカルから消えても、unhide時に同じキーへ確実に書き戻すため）
  // 2) groupedEmailsのroomキー（既に正しいアカウントで複合化済み）
  // 3) メール自身のaccountId
  // 4) どれも無ければメインアカウントにフォールバック
  // accountHint（そのメールの accountId）を渡したときはそれを使う（連携アカウントどうしのメールは同じ ID で
  // 両方のアカウントに入ることがあり、ID だけで引くとほかのアカウントの設定を見てしまうため）
  const resolveMessageAccountEmail = (messageId: string, accountHint?: string): string => {
    if (accountHint) return accountHint;
    const existingKey = keysOf(messageConfigsRef.current).find(k => decodeRoomKey(k).localKey === (messageId as LocalKey));
    if (existingKey) {
      try { return decodeRoomKey(existingKey).accountEmail; } catch { /* 複合キーでない古いデータは無視 */ }
    }
    const room = emailRoomMap.get(messageId);
    if (room) {
      try { return decodeRoomKey(room).accountEmail; } catch { /* 複合キーでない古いデータは無視 */ }
    }
    const found = allUniqueEmails.find((e) => e.id === messageId);
    return found?.accountId || session?.user?.email || "";
  };

  // メッセージ単位の設定（messageConfigs）を引くための複合キーを作る。そのメッセージが
  // 実際に属するアカウントで複合化するため、連携アカウントをまたいでメッセージIDが
  // 衝突しても互いの非表示/ピン留め状態が混ざらない
  const messageConfigKey = (messageId: string, accountHint?: string): RoomKeyStr => encodeRoomKey(resolveMessageAccountEmail(messageId, accountHint), messageId as LocalKey);

  // ルーム内の相手メールアドレスを推定する（「作成」機能での重複チャット判定・検索に使用）。
  // 連携アカウントのルームでは「自分」がメインアカウントとは限らないため、そのルーム自身が
  // 属するアカウントで判定する（メインアカウント固定だと、連携アカウント宛にメインアカウントから
  // 送ったメールを「相手からの受信」と誤認識してしまう）
  // 宛先に書く「表示名 <アドレス>」。相手から届いたメールの From に表示名があればそれを使い、無ければアドレスだけ
  // 受け取ったメールに Reply-To（自分以外）があれば、そのアドレスを相手とする（groupEmails.ts の roomPartner）
  const getRoomPartner = (room: RoomKeyStr): { name: string; address: string } => {
    const { accountEmail, localKey } = decodeRoomKey(room);
    const aliases = (sendAsByAccount[accountEmail] || []).map(a => a.sendAsEmail);
    return roomPartner(groupedEmails[room] || [], localKey, accountEmail, aliases);
  };
  const getRoomRecipient = (room: RoomKeyStr): string => {
    const { name, address } = getRoomPartner(room);
    // 表示名にカンマなどが入っていても宛先の区切りにならないよう、引用符で囲む（ヘッダーに書くときは mime.ts が整える）
    const cleanName = name.replace(/["\\<>\r\n]+/g, " ").trim();
    if (cleanName && address) return `"${cleanName}" <${address}>`;
    return address;
  };
  const getRoomAddress = (room: RoomKeyStr): string => getRoomPartner(room).address;

  // 「作成」モーダルの「候補」一覧（下書き中の空チャット・グループ自体は除く）。
  // ボックスのチェックボックス状態には影響されず（groupedEmails自体が非フィルター済みのため）、
  // 現在のフィルターに関わらず常に最新のやり取り順（時系列順）で並べる
  const contactDirectory = useMemo(() => {
    return keysOf(groupedEmails)
      .filter(room => (groupedEmails[room] || []).length > 0 && !chatConfigs[room]?.isGroup)
      .map(room => {
        const decoded = decodeRoomKey(room);
        return {
          room,
          label: chatConfigs[room]?.customName || decoded.localKey,
          // 名前変更後もリネーム前の元の表示名（相手のFromヘッダー由来の名前）で検索できるように、
          // labelとは別に保持しておく（customNameが無ければlabelと同じ値になる）
          originalName: decoded.localKey,
          address: getRoomAddress(room),
          accountEmail: decoded.accountEmail,
          latestDate: groupedEmails[room][0]?.date ? new Date(groupedEmails[room][0].date).getTime() : 0,
        };
      })
      .sort((a, b) => b.latestDate - a.latestDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupedEmails, chatConfigs, session]);

  // グループチャットの「返信先を選択」用プール: 表示モードに関わらず、
  // 自分がグループから送信したメール + メンバー全員からの受信メールを常に候補にする
  // （送信専用モードでもスレッドには出てこない相手の発言を選んで返信できるようにするため）
  const groupReplyPools = useMemo(() => {
    const pools: Record<string, Email[]> = {};
    keysOf(chatConfigs).forEach(room => {
      const cfg = chatConfigs[room];
      if (!cfg?.isGroup) return;
      const { accountEmail } = decodeRoomKey(room);
      // グループは1つのアカウントから送信する前提のため、「自分」はこのグループ自身が属する
      // アカウント（連携アカウントの場合はそちら）で判定する（メインアカウント固定だと、
      // 連携アカウントのグループで送受信の判定が逆転してしまう）
      const memberAddresses = groupMemberAddresses(cfg);
      // このグループのアカウントのメールだけを候補にする（ほかのアカウントのメールを混ぜない）。自分はエイリアスも含む
      const myEmail = session?.user?.email || "";
      const mine = [accountEmail, ...(sendAsByAccount[accountEmail] || []).map(a => a.sendAsEmail)];
      const accountEmails = allUniqueEmails.filter(e => (e.accountId || myEmail) === accountEmail);
      const sentViaGroup = accountEmails.filter((e) => isMineEmail(e, mine) && sameAddressSet(parseAddressSet(e.to || ""), memberAddresses));
      const received = accountEmails.filter((e) => {
        if (isMineEmail(e, mine)) return false;
        const addrMatch = (e.from || "").match(/<([^>]+)>/);
        const addr = (addrMatch ? addrMatch[1] : e.from || "").trim().toLowerCase();
        return memberAddresses.has(addr);
      });
      pools[room] = [...sentViaGroup, ...received].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    });
    return pools;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allUniqueEmails, chatConfigs, groupedEmails, session, sendAsByAccount]);

  return { groupedEmails, groupedEmailsRef, emailRoomMap, roomOfEmail, resolveMessageAccountEmail, messageConfigKey, getRoomPartner, getRoomRecipient, getRoomAddress, contactDirectory, groupReplyPools };
}
