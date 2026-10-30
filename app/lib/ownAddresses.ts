// 自分のアドレス（アカウントごと）。Gmail の sendAs（主アドレス・エイリアス・プラスアドレス・Workspace の別名）と、
// 手で登録した受信専用アドレス（Email Routing などで転送されてくる、sendAs に無いアドレス）をまとめて扱う。
// チャットとチェックボックスは自分のアドレスごとに分け、設定とフィルターはアカウント単位のまま（README §7.7）。
// sendAs の取得結果はメモリにだけ持ち、どこにも保存しない。比較はすべて小文字にそろえた完全一致
import type { Email } from "../types/email";
import { splitAddressList, parseAddress } from "./mime";

export type OwnAddressBook = {
  // アカウントのアドレス（主アドレス・小文字）
  primary: string;
  // sendAs のすべて（確認待ちも含む・小文字）。受信の判定に使う
  sendAs: string[];
  // 差出人に使えるアドレス（主アドレスと、確認が済んだ sendAs・小文字）
  sendable: string[];
  // 受信専用アドレス（アカウント設定で手で登録したもの・小文字。sendAs と重なるものは除いてある）
  receiveOnly: string[];
};

// 受信専用アドレスの件数とアドレスの長さの上限（壊れた・巨大な設定で固まらないため）
export const MAX_RECEIVE_ONLY_ADDRESSES = 20;
const MAX_ADDRESS_LENGTH = 254;
// 「ローカル部@ドメイン.トップレベル」。空白・山かっこ・カンマなど宛先の区切りになる文字は入れない
const OWN_ADDRESS_RE = /^[^\s@<>(),;:"]{1,64}@[^\s@<>(),;:".]+(\.[^\s@<>(),;:".]+)+$/;

export function normalizeAddress(a: string): string {
  return (a || "").trim().toLowerCase();
}

export function isValidOwnAddress(a: string): boolean {
  const v = normalizeAddress(a);
  return v.length > 0 && v.length <= MAX_ADDRESS_LENGTH && OWN_ADDRESS_RE.test(v);
}

function uniq(list: string[]): string[] {
  return [...new Set(list.map(normalizeAddress).filter(Boolean))];
}

// sendAs が読めなかった（null）ときは、主アドレスと受信専用アドレスだけで動かす
export function buildOwnAddressBook(
  account: string,
  sendAs: { sendAsEmail: string; canSend: boolean }[] | null,
  receiveOnly: string[] = [],
): OwnAddressBook {
  const primary = normalizeAddress(account);
  const all = uniq((sendAs || []).map(s => s.sendAsEmail)).filter(a => a !== primary);
  const sendable = [primary, ...uniq((sendAs || []).filter(s => s.canSend).map(s => s.sendAsEmail)).filter(a => a !== primary)].filter(Boolean);
  const taken = new Set([primary, ...all]);
  const ro = uniq(receiveOnly).filter(a => !taken.has(a) && isValidOwnAddress(a)).slice(0, MAX_RECEIVE_ONLY_ADDRESSES);
  return { primary, sendAs: all, sendable, receiveOnly: ro };
}

// そのアカウントの自分のアドレスすべて（主アドレスが先頭。重なりなし・小文字）
export function ownAddressList(book: OwnAddressBook): string[] {
  return uniq([book.primary, ...book.sendAs, ...book.receiveOnly]);
}

export function isReceiveOnlyAddress(book: OwnAddressBook, address: string): boolean {
  return book.receiveOnly.includes(normalizeAddress(address));
}

export function canSendFrom(book: OwnAddressBook, address: string): boolean {
  return book.sendable.includes(normalizeAddress(address));
}

// 受信専用アドレスの登録の確かめ。登録できるならそのアドレス（小文字）、できなければ理由
export function checkReceiveOnlyAddress(input: string, book: OwnAddressBook): { ok: true; address: string } | { ok: false; reason: string } {
  const address = normalizeAddress(input);
  if (!isValidOwnAddress(address)) return { ok: false, reason: "メールアドレスの形になっていません（例：user@example.com）" };
  if (address === book.primary || book.sendAs.includes(address)) return { ok: false, reason: "このアドレスは Gmail の「他のアドレスからメールを送信」にあるので、登録しなくても自分のアドレスになります" };
  if (book.receiveOnly.includes(address)) return { ok: false, reason: "このアドレスはもう登録してあります" };
  if (book.receiveOnly.length >= MAX_RECEIVE_ONLY_ADDRESSES) return { ok: false, reason: `受信専用アドレスは${MAX_RECEIVE_ONLY_ADDRESSES}件までです` };
  return { ok: true, address };
}

// ヘッダーに並ぶアドレス（小文字）。壊れた・巨大なヘッダーで固まらないよう、見る長さに上限を置く
function addressesOf(header: string | undefined): string[] {
  return splitAddressList((header || "").slice(0, 200_000)).map(e => normalizeAddress(parseAddress(e).address)).filter(Boolean);
}

type ResolvableEmail = Pick<Email, "from" | "to" | "cc"> & { deliveredTo?: string };

// メールがどの自分のアドレスのものか（小文字）。
// - 受け取ったメール：To → Cc → Delivered-To の順に見て、最初に出てくる自分のアドレス。無ければ主アドレス
//   （自分の複数のアドレスに同時に届いたメールも、この順で最初の1つにだけ入れる）
// - 送ったメール・下書き：From。From が一覧に無ければ主アドレス
export function resolveOwnAddress(email: ResolvableEmail, book: OwnAddressBook, isOwn: boolean): string {
  const mine = new Set(ownAddressList(book));
  if (isOwn) {
    const from = addressesOf(email.from)[0] || "";
    return mine.has(from) ? from : book.primary;
  }
  for (const header of [email.to, email.cc, email.deliveredTo]) {
    const hit = addressesOf(header).find(a => mine.has(a));
    if (hit) return hit;
  }
  return book.primary;
}

// 1アカウント分のメールそれぞれの自分のアドレス（メール ID → 小文字のアドレス）。
// 例外：送ったメールの From が主アドレスで、同じスレッドの受け取ったメールが受信専用アドレスに振り分けられているときは、
// その受信専用アドレスに入れる（受信専用アドレスからは送れないので主アドレスから返信する。その返信がチャットから消えないように）
export function assignOwnAddresses<E extends ResolvableEmail & Pick<Email, "id" | "threadId">>(
  emails: E[],
  book: OwnAddressBook,
  isOwn: (e: E) => boolean,
): Map<string, string> {
  const out = new Map<string, string>();
  const threadReceiveOnly = new Map<string, string>();
  const own: E[] = [];
  for (const e of emails) {
    if (isOwn(e)) { own.push(e); continue; }
    const addr = resolveOwnAddress(e, book, false);
    out.set(e.id, addr);
    if (e.threadId && book.receiveOnly.includes(addr) && !threadReceiveOnly.has(e.threadId)) threadReceiveOnly.set(e.threadId, addr);
  }
  for (const e of own) {
    let addr = resolveOwnAddress(e, book, true);
    if (addr === book.primary && e.threadId && threadReceiveOnly.has(e.threadId)) addr = threadReceiveOnly.get(e.threadId)!;
    out.set(e.id, addr);
  }
  return out;
}

// 自分のアドレスのチェックボックス（共通設定 ownAddresses）のキー。アカウントと自分のアドレスを空白でつなぐ
// （同じアドレスがほかのアカウントの sendAs にもあることがあるので、アカウントも含める）
export function ownAddressCheckKey(account: string, address: string): string {
  return `${normalizeAddress(account)} ${normalizeAddress(address)}`;
}

// チャットを一覧に出すか。アカウントのチェックが外れていれば出さない。アドレスごとのチェックは、外したもの（false）だけ出さない
export function isOwnAddressVisible(checkAccounts: Record<string, boolean>, checkOwn: Record<string, boolean>, account: string, address: string): boolean {
  if (checkAccounts[account] === false) return false;
  return checkOwn[ownAddressCheckKey(account, address)] !== false;
}

// アカウントのチェックボックスの見た目：全部オン / 全部オフ / 一部だけオン（中間）
export function accountCheckState(checkAccounts: Record<string, boolean>, checkOwn: Record<string, boolean>, account: string, addresses: string[]): "on" | "off" | "mixed" {
  const on = addresses.filter(a => isOwnAddressVisible(checkAccounts, checkOwn, account, a)).length;
  if (on === 0) return "off";
  return on === addresses.length ? "on" : "mixed";
}

// アカウントのチェックを押したとき：全部オンなら全部オフに、それ以外なら全部オンにする（アドレスごとの値をすべて書く）
export function toggleAccountChecks(checkAccounts: Record<string, boolean>, checkOwn: Record<string, boolean>, account: string, addresses: string[]): { accounts: Record<string, boolean>; own: Record<string, boolean> } {
  const turnOn = accountCheckState(checkAccounts, checkOwn, account, addresses) !== "on";
  const own = { ...checkOwn };
  for (const a of addresses) own[ownAddressCheckKey(account, a)] = turnOn;
  return { accounts: { ...checkAccounts, [account]: turnOn }, own };
}

// アドレスのチェックを押したとき：ほかのアドレスは今見えているとおりの値を書き、アカウントは1つでもオンならオンにする
export function toggleOwnAddressCheck(checkAccounts: Record<string, boolean>, checkOwn: Record<string, boolean>, account: string, addresses: string[], address: string, on: boolean): { accounts: Record<string, boolean>; own: Record<string, boolean> } {
  const own = { ...checkOwn };
  for (const a of addresses) own[ownAddressCheckKey(account, a)] = isOwnAddressVisible(checkAccounts, checkOwn, account, a);
  own[ownAddressCheckKey(account, address)] = on;
  const anyOn = addresses.some(a => own[ownAddressCheckKey(account, a)] !== false);
  return { accounts: { ...checkAccounts, [account]: anyOn }, own };
}
