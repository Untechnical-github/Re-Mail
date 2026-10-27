// useMailApp.ts の groupedEmails useMemo から抽出した、副作用のない純粋関数版。
// 規則：受け取ったメールは相手（Reply-To に自分以外があればそのアドレス、無ければ From）のルームへ。
// 自分が送ったメールは To / Cc / Bcc に入っている相手の個人チャットすべてへ。アドレスだけのルームは、
// 同じアドレスの表示名ルームがあればそちらへまとめる。グループは宛先の集合がメンバーと完全一致する送信メールと、メンバーからの受信メール
// 「1アカウント分のメール配列 + そのアカウントのchatConfigs」を受け取り、ローカルなroomキー
// （相手の表示名やアドレス、group:xxxx など）でグルーピングしたものを返す。
// 複数アカウント分の結果をマージする場合は mergeAccountGroups を使う（そちらで
// encodeRoomKey による複合キー化を行う）。

import { ChatConfig } from "../types/mail";
import { Email } from "../types/email";
import { isMineEmail, messageMatchesFilter } from "./filterMatch";
import { LocalKey, RoomKeyStr, encodeRoomKey, decodeRoomKey, keysOf } from "./roomKey";
import { splitAddressList, parseAddress } from "./mime";

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

// グループのメンバーの実メールアドレス集合。作成時に確定させて保存した値（groupMemberAddresses）だけを使う。
// 保存が無い・メンバーの数と合わない（壊れた）グループは空にする（受信メールから推定した相手に送らない。送信は呼び出し側で止める）
export function groupMemberAddresses(cfg: ChatConfig): Set<string> {
  const members = cfg.groupMembers || [];
  const addresses = cfg.groupMemberAddresses;
  if (!Array.isArray(addresses) || addresses.length !== members.length) return new Set();
  return new Set(addresses.filter((a): a is string => typeof a === "string").map(a => a.trim().toLowerCase()).filter(Boolean));
}

// 自分が送ったメールか。myAddresses の先頭がそのアカウントのアドレス、残りがエイリアス（Gmail の「別のアドレスから送信」）。
// エイリアスが別のアカウント（連携しているほかのアカウントなど）のアドレスのとき、そこから届いたメールにも Gmail は「送信済み」を付ける。
// エイリアスからのメールでも、このアカウントに届いたもの（受信箱にある・To / Cc にこのアカウントのアドレスがある）は受け取ったメールとする
export function isOwnMail(email: Pick<Email, "from" | "to" | "cc" | "labelIds" | "isMe">, myAddresses: string[]): boolean {
  if (email.isMe) return true;
  const [primary = "", ...rest] = myAddresses;
  if (isMineEmail(email, primary)) return true;
  const aliases = rest.filter(a => a && a.trim().toLowerCase() !== primary.trim().toLowerCase());
  if (aliases.length === 0 || !isMineEmail(email, aliases)) return false;
  if ((email.labelIds || []).includes("INBOX")) return false;
  const me = primary.trim().toLowerCase();
  const toMe = [email.to, email.cc].some(h => splitAddressList((h || "").slice(0, 200_000)).some(e => parseAddress(e).address.trim().toLowerCase() === me));
  return !toMe;
}

// 受け取ったメールとして画面に出すときのコピー（エイリアスから届いたメールに Gmail が付けた「送信済み」を外す）
function asReceived(email: Email): Email {
  return email.labelIds?.includes("SENT") ? { ...email, labelIds: email.labelIds.filter(l => l !== "SENT") } : email;
}

// 受け取ったメールの「相手」。Reply-To に自分（エイリアスを含む）以外のアドレスがあれば、その最初のものを相手にする
// （問い合わせフォームのように From が共通で Reply-To が人ごとに違うメールを、返信先の人のチャットにまとめるため）。
// Reply-To が無ければ From。roomName は Reply-To の表示名、無ければ Reply-To のアドレス（From の表示名は使わない）
export type MailPartner = { name: string; address: string; roomName: string; viaReplyTo: boolean };

export function mailPartnerOf(email: Pick<Email, "from" | "replyTo">, myAddresses: string[]): MailPartner {
  const me = new Set(myAddresses.filter(Boolean).map(a => a.trim().toLowerCase()));
  // 壊れた・巨大なヘッダーで固まらないよう、見る長さに上限を置く
  const replyTo = splitAddressList((email.replyTo || "").slice(0, 20_000))
    .map(parseAddress)
    .find(a => a.address.includes("@") && !me.has(a.address.trim().toLowerCase()));
  if (replyTo) {
    const address = replyTo.address.trim().toLowerCase();
    return { name: replyTo.name, address, roomName: replyTo.name || replyTo.address.trim() || "Unknown", viaReplyTo: true };
  }
  const from = email.from || "";
  const { name, address } = parseAddress(from);
  return { name, address: address.trim().toLowerCase(), roomName: from.split("<")[0].replace(/"/g, "").trim() || "Unknown", viaReplyTo: false };
}

// 自分が送ったメールの宛先（To / Cc / Bcc）。アドレス（小文字）と表示名
function sentRecipients(email: Pick<Email, "to" | "cc" | "bcc">): { addresses: Set<string>; names: Set<string>; first: string } {
  const addresses = new Set<string>();
  const names = new Set<string>();
  let first = "";
  for (const header of [email.to, email.cc, email.bcc]) {
    for (const entry of splitAddressList((header || "").slice(0, 200_000))) {
      const { name, address } = parseAddress(entry);
      const addr = address.trim().toLowerCase();
      if (addr) addresses.add(addr);
      if (name) names.add(name.trim());
      // 新しいルームの名前：To の最初の宛先の表示名（無ければアドレス）。To が無ければ Cc、Cc も無ければ Bcc の最初
      if (!first) first = name.trim() || address.trim();
    }
  }
  return { addresses, names, first };
}

// 受け取ったメールの相手のアドレス → ルーム名。同じアドレスで表示名が複数あるときだけ入れる。
// 設定のあるルーム名（chatConfigs にある名前）を優先し、無ければいちばん新しいメールの表示名にする
// （どちらも同じなら今までと同じ名前のまま。アドレスだけのルーム名は表示名があればそちらに負ける）
export function canonicalRoomNames(
  emails: Email[],
  myAddresses: string[],
  chatConfigs: Record<LocalKey, ChatConfig>,
): Map<string, string> {
  const names = new Map<string, { name: string; time: number }[]>();
  for (const email of emails) {
    if (email.senderRoom || isOwnMail(email, myAddresses)) continue;
    const partner = mailPartnerOf(email, myAddresses);
    if (!partner.address) continue;
    const list = names.get(partner.address) || [];
    const time = new Date(email.date).getTime() || 0;
    const found = list.find(n => n.name === partner.roomName);
    if (found) found.time = Math.max(found.time, time);
    else list.push({ name: partner.roomName, time });
    names.set(partner.address, list);
  }
  const isAddressName = (n: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(n.trim());
  const out = new Map<string, string>();
  names.forEach((list, address) => {
    if (list.length < 2) return;
    const withConfig = list.filter(n => !!chatConfigs[n.name as LocalKey] && !chatConfigs[n.name as LocalKey]?.isGroup);
    const pool = withConfig.length > 0 ? withConfig : (list.some(n => !isAddressName(n.name)) ? list.filter(n => !isAddressName(n.name)) : list);
    const best = pool.reduce((a, b) => (b.time > a.time ? b : a));
    out.set(address, best.name);
  });
  return out;
}

// 1アカウント分のメールを、ローカルなroomキーでグルーピングする。
// 返り値のキーはローカルキー（例: "田中太郎", "group:xxxx"）で、
// アカウントをまたいだ複合キー化は行わない（それは mergeAccountGroups の責務）。
// myAliases は自分のエイリアス（Reply-To が自分宛てかどうかの判定にだけ使う）
export function groupEmailsByRoom(
  emails: Email[],
  myAddress: string,
  chatConfigs: Record<LocalKey, ChatConfig>,
  myAliases: string[] = [],
): Record<LocalKey, Email[]> {
  const groups: Record<string, Email[]> = {};
  const tempSentEmails: Email[] = [];
  const myAddresses = [myAddress, ...myAliases];
  // ルームの相手のアドレス（Reply-To を優先）。最初に見つかった受信メールで決める
  const roomPartner: Record<string, string> = {};
  // 同じ相手（アドレス）なのに表示名がメールごとに違う（「高澤悠樹」と「髙澤家」など）と、チャットが表示名ごとに分かれてしまう。
  // 相手のアドレスごとにルーム名を1つに決める：設定（ピン留め・名前の変更など）があるルーム名を優先し、無ければいちばん新しいメールの表示名
  const canonicalRoom = canonicalRoomNames(emails, myAddresses, chatConfigs);
  emails.forEach((email) => {
    if (email.senderRoom) { if (!groups[email.senderRoom]) groups[email.senderRoom] = []; groups[email.senderRoom].push(email); return; }
    const isMe = isOwnMail(email, myAddresses);
    if (!isMe) {
      const partner = mailPartnerOf(email, myAddresses);
      const roomName = (partner.address && canonicalRoom.get(partner.address)) || partner.roomName;
      if (!groups[roomName]) groups[roomName] = [];
      // エイリアスから届いたメールに Gmail が付けた「送信済み」は、画面では外す（受け取ったメールとして受信箱などに出す）。
      // Gmail のラベルそのものは変えない（一覧の元のデータ allUniqueEmails には残る）
      groups[roomName].push(asReceived(email));
      if (!roomPartner[roomName] && partner.address) roomPartner[roomName] = partner.address;
    } else { tempSentEmails.push(email); }
  });

  // 自分が送ったメールは、To / Cc / Bcc のどれかに相手のアドレス（またはルーム名）が入っている個人チャットすべてに入れる
  // （グループのメールを各メンバーのチャットに入れるのと同じ考え方）。グループのルームは対象外
  const individualRooms = Object.keys(groups).filter(room => !chatConfigs[room as LocalKey]?.isGroup && !room.startsWith("group:"));
  tempSentEmails.forEach((email) => {
    // 実行中メモリ上でも送信済みメールからINBOXを強制剥奪する
    if (email.labelIds?.includes("INBOX")) {
      email.labelIds = email.labelIds.filter((l: string) => l !== "INBOX");
    }
    const { addresses, names, first } = sentRecipients(email);
    const matched = individualRooms.filter(room => {
      const partnerAddr = roomPartner[room] || "";
      return (partnerAddr && addresses.has(partnerAddr)) || names.has(room) || addresses.has(room.trim().toLowerCase());
    });
    if (matched.length > 0) {
      matched.forEach(room => groups[room].push({ ...email, isMe: true }));
      return;
    }
    const newRoomName = first || "Unknown";
    if (!groups[newRoomName]) {
      groups[newRoomName] = [];
      // 送ったメールだけで作ったルームも、あとの送ったメールの照合先にする（相手は最初の宛先）
      if (!chatConfigs[newRoomName as LocalKey]?.isGroup && !newRoomName.startsWith("group:")) individualRooms.push(newRoomName);
      // To が「undisclosed-recipients:;」（純正 Gmail で Bcc だけ）のときも Cc・Bcc の最初の人を相手にする
      const firstAddress = parseAddress(splitAddressList([email.to, email.cc, email.bcc].filter(Boolean).join(",").slice(0, 200_000))[0] || "").address.trim().toLowerCase();
      if (firstAddress && !roomPartner[newRoomName]) roomPartner[newRoomName] = firstAddress;
    }
    if (!groups[newRoomName].some(e => e.id === email.id)) groups[newRoomName].push({ ...email, isMe: true });
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
    const partner = msgs.find((e: Email) => !isOwnMail(e, myAddresses));
    if (partner) return mailPartnerOf(partner, myAddresses).address;
    const raw = (msgs.find((e: Email) => e.to)?.to || "").split(",")[0];
    const match = (raw || "").match(/<([^>]+)>/);
    return ((match ? match[1] : raw) || "").trim().toLowerCase();
  };
  Object.keys(groups).forEach(room => {
    if (!emailLikeRoom(room)) return;
    const addr = room.trim().toLowerCase();
    const displayRoom = Object.keys(groups).find(other =>
      other !== room && !emailLikeRoom(other) && !chatConfigs[other as LocalKey]?.isGroup && resolveRoomPartnerAddr(other) === addr
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
  keysOf(chatConfigs).forEach(room => {
    const cfg = chatConfigs[room];
    if (!cfg?.isGroup) return;
    // フィルターツールで作成したグループは受信専用のため、このアカウント1件分の中だけで完結させず、
    // 全アカウント分のメールをまたいで集約できるようにする（applyFilterGroups の責務）。
    // ここでは何もしない（groups[room] を作らない）
    if (cfg.filterCriteria) return;
    const mode = cfg.groupMode || "normal";
    const members = cfg.groupMembers || [];
    const memberAddresses = groupMemberAddresses(cfg);

    // このグループから送信されたメール = 宛先セットがメンバー全員と完全一致する送信済みメール
    const sentViaGroup = emails.filter((e: Email) => isOwnMail(e, myAddresses) && sameAddressSet(parseAddressSet(e.to || ""), memberAddresses));

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
      if (isOwnMail(e, myAddresses)) return false;
      const addrMatch = (e.from || "").match(/<([^>]+)>/);
      const addr = (addrMatch ? addrMatch[1] : e.from || "").trim().toLowerCase();
      return memberAddresses.has(addr);
    }).map(asReceived);

    if (mode === "inbound_only") {
      groups[room] = received;
    } else {
      const merged = [...received];
      const mergedIds = new Set(merged.map((e: Email) => e.id));
      sentViaGroup.forEach((e: Email) => { if (!mergedIds.has(e.id)) { merged.push(e); mergedIds.add(e.id); } });
      groups[room] = merged;
    }
  });

  Object.keys(groups).forEach(sender => groups[sender].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()));
  // groups の内部実装は素の文字列キーのまま（Phase3のロジックを一切変更しないため）。
  // 「このRecordのキーはこの関数のローカルroom空間に閉じている」という保証だけ、公開シグネチャで型として表す
  return groups as Record<LocalKey, Email[]>;
}

// 複数アカウント分の groupEmailsByRoom の結果を、1つのroomKey空間へマージする。
// 各アカウントの結果をそのアカウントの encodeRoomKey で複合キー化してから合体するため、
// 別アカウントに同姓同名の相手がいてもキーが異なり、衝突・混在しない
export function mergeAccountGroups(
  perAccountGroups: { accountEmail: string; groups: Record<LocalKey, Email[]> }[],
): Record<RoomKeyStr, Email[]> {
  const merged: Record<RoomKeyStr, Email[]> = {};
  perAccountGroups.forEach(({ accountEmail, groups }) => {
    (Object.keys(groups) as LocalKey[]).forEach(localKey => {
      merged[encodeRoomKey(accountEmail, localKey)] = groups[localKey];
    });
  });
  return merged;
}

// フィルターツールで作成したグループ（filterCriteria持ち）専用の集約。条件に一致すれば
// 送信済みメールも含まれる（通常のグループのような宛先セット一致は必要ない）。
// フィルターはアカウントごとのものなので、そのグループのアカウント（roomKey のアカウント）のメールだけを集める
// （ほかのアカウントのメールは混ぜない。通常のグループと同じ）。
// mergeAccountGroups 済みの複合キー空間に対して、chatConfigs・allEmails も複合キー/全アカウント分の
// ものをそのまま渡して呼ぶ（groupEmailsByRoom内では意図的にfilterCriteria持ちのroomを扱わない）
// ルームのアカウント（小文字）。複合キーでない古いキーは空にする（例外で一覧全体を止めないため）
function accountOfRoom(room: RoomKeyStr): string {
  try { return decodeRoomKey(room).accountEmail.toLowerCase(); } catch { return ""; }
}

export function applyFilterGroups(
  merged: Record<RoomKeyStr, Email[]>,
  chatConfigs: Record<RoomKeyStr, ChatConfig>,
  allEmails: Email[],
  myEmail: string,
): Record<RoomKeyStr, Email[]> {
  const next: Record<RoomKeyStr, Email[]> = { ...merged };

  keysOf(chatConfigs).forEach(room => {
    const cfg = chatConfigs[room];
    if (!cfg?.isGroup || !cfg.filterCriteria) return;
    const createdAtMs = cfg.filterCreatedAt ? new Date(cfg.filterCreatedAt).getTime() : 0;
    const roomAccount = accountOfRoom(room);
    next[room] = allEmails.filter((e: Email) => {
      // このメール自身が属するアカウント（未設定＝accountId導入前のデータ等はmyEmail名義とみなす）
      const emailAccount = e.accountId || myEmail;
      if (emailAccount.toLowerCase() !== roomAccount) return false;
      if (!messageMatchesFilter(e, cfg.filterCriteria!, emailAccount)) return false;
      if (cfg.filterIncludeExisting === false) {
        const t = new Date(e.date).getTime();
        if (!(t > createdAtMs)) return false;
      }
      return true;
    }).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  });

  // フィルターグループで「元のメッセージを非表示にする」がONの場合、一致したメッセージを
  // 同じアカウントのほかのルーム（元の個別チャット等）から動的に除外する。
  // chatConfigsやメールが変わるたびに毎回再計算されるため、OFFにすれば次の再計算で自動的に
  // 元のルームへ復元される
  keysOf(chatConfigs).forEach(room => {
    const cfg = chatConfigs[room];
    if (!cfg?.isGroup || !cfg.filterCriteria || !cfg.filterHideOriginal) return;
    const matchedIds = new Set((next[room] || []).map((e: Email) => e.id));
    if (matchedIds.size === 0) return;
    const roomAccount = accountOfRoom(room);
    keysOf(next).forEach(otherRoom => {
      if (otherRoom === room) return;
      if (accountOfRoom(otherRoom) !== roomAccount) return;
      next[otherRoom] = next[otherRoom].filter((e: Email) => !matchedIds.has(e.id));
    });
  });

  return next;
}

// ルームの相手（表示名とアドレス）。相手から届いたメールがあれば mailPartnerOf（Reply-To 優先）、
// 送ったメールしか無ければ、その宛先（To / Cc / Bcc）のうちルーム名（表示名かアドレス）に合うもの、無ければ最初の宛先
export function roomPartner(msgs: Email[], localKey: string, myAddress: string, myAliases: string[] = []): { name: string; address: string } {
  const partner = msgs.find(e => !isOwnMail(e, [myAddress, ...myAliases]));
  if (partner) {
    const p = mailPartnerOf(partner, [myAddress, ...myAliases]);
    return { name: p.name, address: p.address };
  }
  const room = (localKey || "").trim();
  let fallback: { name: string; address: string } | null = null;
  for (const e of msgs) {
    for (const header of [e.to, e.cc, e.bcc]) {
      for (const entry of splitAddressList((header || "").slice(0, 200_000))) {
        const { name, address } = parseAddress(entry);
        const addr = address.trim().toLowerCase();
        if (!addr) continue;
        if (addr === room.toLowerCase() || (name && name.trim() === room)) return { name: name.trim(), address: addr };
        if (!fallback) fallback = { name: name.trim(), address: addr };
      }
    }
  }
  return fallback || { name: "", address: "" };
}
