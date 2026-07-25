// useMailApp.ts の groupedEmails useMemo から抽出した、副作用のない純粋関数版。
// 「1アカウント分のメール配列 + そのアカウントのchatConfigs」を受け取り、ローカルなroomキー
// （相手の表示名やアドレス、group:xxxx など）でグルーピングしたものを返す。
// 複数アカウント分の結果をマージする場合は mergeAccountGroups を使う（そちらで
// encodeRoomKey による複合キー化を行う）。

import { ChatConfig } from "../types/mail";
import { Email } from "../types/email";
import { isMineEmail, messageMatchesFilter } from "./filterMatch";
import { encodeRoomKey } from "./roomKey";

function parseAddressSet(toHeader: string): Set<string> {
  const set = new Set<string>();
  (toHeader || "").split(",").forEach(part => {
    const match = part.match(/<([^>]+)>/);
    const addr = ((match ? match[1] : part) || "").trim().toLowerCase();
    if (addr) set.add(addr);
  });
  return set;
}

function sameAddressSet(a: Set<string>, b: Set<string>): boolean {
  return a.size > 0 && a.size === b.size && [...a].every(addr => b.has(addr));
}

// グループのメンバーの実メールアドレス集合を求める。作成時に確定させて保存した値を正とし、
// （古い形式のグループ等で）保存が無い場合のみ、そのメンバーの個別チャットの受信メールから推定する
function resolveGroupMemberAddresses(cfg: ChatConfig, roomLookup: Record<string, Email[]>, myEmail: string): Set<string> {
  const members = cfg.groupMembers || [];
  const addresses = (cfg.groupMemberAddresses && cfg.groupMemberAddresses.length === members.length)
    ? cfg.groupMemberAddresses
    : members.map((m: string) => {
        const msgs = roomLookup[m];
        const partner = msgs?.find((e: Email) => !isMineEmail(e, myEmail));
        const raw = partner ? partner.from : "";
        const match = (raw || "").match(/<([^>]+)>/);
        const resolved = ((match ? match[1] : raw) || "").trim().toLowerCase();
        return resolved || m.trim().toLowerCase();
      });
  return new Set(addresses.map((a: string) => a.toLowerCase()).filter(Boolean));
}

// 1アカウント分のメールを、ローカルなroomキーでグルーピングする（既存のgroupedEmails useMemoと
// 完全に同じロジック）。返り値のキーはローカルキー（例: "田中太郎", "group:xxxx"）で、
// アカウントをまたいだ複合キー化は行わない（それは mergeAccountGroups の責務）
export function groupEmailsByRoom(
  emails: Email[],
  myAddress: string,
  chatConfigs: Record<string, ChatConfig>,
): Record<string, Email[]> {
  const groups: Record<string, Email[]> = {};
  const tempSentEmails: Email[] = [];
  emails.forEach((email) => {
    if (email.senderRoom) { if (!groups[email.senderRoom]) groups[email.senderRoom] = []; groups[email.senderRoom].push(email); return; }
    const isMe = email.isMe || email.from.includes(myAddress || "");
    if (!isMe) {
      const roomName = email.from.split("<")[0].replace(/"/g, "").trim() || "Unknown";
      if (!groups[roomName]) groups[roomName] = []; groups[roomName].push(email);
    } else { tempSentEmails.push(email); }
  });

  tempSentEmails.forEach((email) => {
    // 実行中メモリ上でも送信済みメールからINBOXを強制剥奪する
    if (email.labelIds?.includes("INBOX")) {
      email.labelIds = email.labelIds.filter((l: string) => l !== "INBOX");
    }
    const toClean = email.to ? email.to.toLowerCase() : "";
    let matchedRoom: string | null = null;
    for (const roomName of Object.keys(groups)) {
      const roomNameLower = roomName.toLowerCase();
      const partnerEmail = groups[roomName].find(e => !e.isMe && !e.from.includes(myAddress || ""))?.from.toLowerCase() || "";
      const partnerAddr = (partnerEmail.match(/<([^>]+)>/) || [null, partnerEmail])[1]?.trim() || partnerEmail.trim();
      if ((roomNameLower && toClean.includes(roomNameLower)) || (partnerAddr && toClean.includes(partnerAddr))) { matchedRoom = roomName; break; }
    }
    if (matchedRoom) { groups[matchedRoom].push({ ...email, isMe: true }); }
    else {
      let newRoomName = "Unknown";
      if (email.to) {
        const toMatch = email.to.split(",")[0];
        newRoomName = toMatch.split("<")[0].replace(/"/g, "").trim() || toMatch.replace(/[<>]/g, "").trim();
        if (!newRoomName) newRoomName = "Unknown";
      }
      if (!groups[newRoomName]) groups[newRoomName] = []; groups[newRoomName].push({ ...email, isMe: true });
    }
  });

  // まだ返信がなく表示名が分からないうちは「アドレスそのもの」がルームキーになるが、
  // 後から返信が来ると差出人の表示名で別のルームが作られてしまい、同じ相手なのに
  // チャットが2つに分裂する（過去に送信しただけのやり取りが宛先アドレス名義のまま
  // 取り残される）。表示名ルームが実在する場合は、アドレス名義のルームをそちらへ
  // 統合する（グループのルームキーは対象外）
  const emailLikeRoom = (room: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(room.trim());
  const resolveRoomPartnerAddr = (room: string): string => {
    const msgs = groups[room];
    if (!msgs || msgs.length === 0) return "";
    const partner = msgs.find((e: Email) => !isMineEmail(e, myAddress || ""));
    const raw = partner ? partner.from : (msgs.find((e: Email) => e.to)?.to || "");
    const match = (raw || "").match(/<([^>]+)>/);
    return ((match ? match[1] : raw) || "").trim().toLowerCase();
  };
  Object.keys(groups).forEach(room => {
    if (!emailLikeRoom(room)) return;
    const addr = room.trim().toLowerCase();
    const displayRoom = Object.keys(groups).find(other =>
      other !== room && !emailLikeRoom(other) && !chatConfigs[other]?.isGroup && resolveRoomPartnerAddr(other) === addr
    );
    if (displayRoom) {
      const existingIds = new Set(groups[displayRoom].map((e: Email) => e.id));
      groups[room].forEach((e: Email) => { if (!existingIds.has(e.id)) { groups[displayRoom].push(e); existingIds.add(e.id); } });
      delete groups[room];
    }
  });

  // グループチャット: メンバーからの受信メールと、グループから送信したメールを集約する。
  // 送信メールの判定はDBに何も永続化せず、その都度「宛先セットがメンバー全員と完全一致するか」
  // だけで判定する（Gmail自身が持つToヘッダーの情報だけで完結するため、送信履歴が増えても
  // D1の容量やロード時間を圧迫しない）。一斉送信は1通のメールなので、各メンバー個別チャットにも
  // 同じメールを反映する。
  Object.keys(chatConfigs).forEach(room => {
    const cfg = chatConfigs[room];
    if (!cfg?.isGroup) return;
    // フィルターツールで作成したグループ: 宛先の集合ではなく条件でメッセージを動的に集約する
    if (cfg.filterCriteria) {
      const createdAtMs = cfg.filterCreatedAt ? new Date(cfg.filterCreatedAt).getTime() : 0;
      groups[room] = emails.filter((e: Email) => {
        if (!messageMatchesFilter(e, cfg.filterCriteria!, myAddress)) return false;
        if (cfg.filterIncludeExisting === false) {
          const t = new Date(e.date).getTime();
          if (!(t > createdAtMs)) return false;
        }
        // フィルターグループは常に受信専用チャットとして扱う（送信済みメールは含めない）
        if (isMineEmail(e, myAddress)) return false;
        return true;
      });
      return;
    }
    const mode = cfg.groupMode || "normal";
    const members = cfg.groupMembers || [];
    const memberAddresses = resolveGroupMemberAddresses(cfg, groups, myAddress);

    // このグループから送信されたメール = 宛先セットがメンバー全員と完全一致する送信済みメール
    const sentViaGroup = emails.filter((e: Email) => isMineEmail(e, myAddress) && sameAddressSet(parseAddressSet(e.to || ""), memberAddresses));

    // 一斉送信したメールを各メンバーの個別チャットにも反映する
    sentViaGroup.forEach((sentMsg: Email) => {
      members.forEach((member: string) => {
        if (!groups[member]) groups[member] = [];
        if (!groups[member].some((e: Email) => e.id === sentMsg.id)) groups[member].push(sentMsg);
      });
    });

    if (mode === "outbound_only") {
      groups[room] = sentViaGroup;
      return;
    }

    const received = emails.filter((e: Email) => {
      if (isMineEmail(e, myAddress)) return false;
      const addrMatch = (e.from || "").match(/<([^>]+)>/);
      const addr = (addrMatch ? addrMatch[1] : e.from || "").trim().toLowerCase();
      return memberAddresses.has(addr);
    });

    if (mode === "inbound_only") {
      groups[room] = received;
    } else {
      const merged = [...received];
      const mergedIds = new Set(merged.map((e: Email) => e.id));
      sentViaGroup.forEach((e: Email) => { if (!mergedIds.has(e.id)) { merged.push(e); mergedIds.add(e.id); } });
      groups[room] = merged;
    }
  });

  // フィルターグループで「元のメッセージを非表示にする」がONの場合、一致したメッセージを
  // 他の全ルーム（元の個別チャット等）から動的に除外する。chatConfigsやメールが変わるたびに
  // 毎回再計算されるため、OFFにすれば次の再計算で自動的に元のルームへ復元される
  Object.keys(chatConfigs).forEach(room => {
    const cfg = chatConfigs[room];
    if (!cfg?.isGroup || !cfg.filterCriteria || !cfg.filterHideOriginal) return;
    const matchedIds = new Set((groups[room] || []).map((e: Email) => e.id));
    if (matchedIds.size === 0) return;
    Object.keys(groups).forEach(otherRoom => {
      if (otherRoom === room) return;
      groups[otherRoom] = groups[otherRoom].filter((e: Email) => !matchedIds.has(e.id));
    });
  });

  Object.keys(groups).forEach(sender => groups[sender].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()));
  return groups;
}

// 複数アカウント分の groupEmailsByRoom の結果を、1つのroomKey空間へマージする。
// 各アカウントの結果をそのアカウントの encodeRoomKey で複合キー化してから合体するため、
// 別アカウントに同姓同名の相手がいてもキーが異なり、衝突・混在しない
export function mergeAccountGroups(
  perAccountGroups: { accountEmail: string; groups: Record<string, Email[]> }[],
): Record<string, Email[]> {
  const merged: Record<string, Email[]> = {};
  perAccountGroups.forEach(({ accountEmail, groups }) => {
    Object.keys(groups).forEach(localKey => {
      merged[encodeRoomKey(accountEmail, localKey)] = groups[localKey];
    });
  });
  return merged;
}
