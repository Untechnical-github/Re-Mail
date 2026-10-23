// 入力欄の「送信先」（To / Cc / Bcc）を扱う純粋関数。
// - 同じアドレスは1回だけ。重なったら To > Cc > Bcc の順で残す（位置は最初に出てきた所）
// - 合計の上限は 500 件（純正 Gmail の1通あたりの上限）、1件のアドレスは 320 文字まで。形が正しくないものは足さない
// - 返信元を選んだときの「返信」「全員に返信」の宛先と、引用が元のやり取りにいなかった人に届くかの判定
import { splitAddressList, parseAddress } from "./mime";
import { planReply, type ReplySource } from "./recipients";

export type RecipientRole = "to" | "cc" | "bcc";
export type ComposeRecipient = { address: string; name?: string; role: RecipientRole };

export const MAX_RECIPIENTS = 500;
export const MAX_RECIPIENT_ADDRESS_LENGTH = 320;
// 表示名は画面とヘッダーにしか使わないので、長すぎるものは切る（巨大な入力で固まらないように）
const MAX_NAME_LENGTH = 200;

export const ROLE_LABELS: Record<RecipientRole, string> = {
  to: "宛先",
  cc: "ほかの人にも見せる（Cc）",
  bcc: "こっそり送る（Bcc）",
};
export const ROLE_HINTS: Record<RecipientRole, string> = {
  to: "",
  cc: "全員がお互いの名前とアドレスを見られます",
  bcc: "ほかの受信者には、この人に送ったことが見えません",
};

const ROLE_RANK: Record<RecipientRole, number> = { to: 0, cc: 1, bcc: 2 };
const ROLES: readonly RecipientRole[] = ["to", "cc", "bcc"];

// ヘッダーを壊す文字（改行・区切り・<>・引用符）を含まない、ふつうの形のアドレスだけを通す。
// 正規表現は後戻りしない単純な形にしてある（長さは先に見る）
const ADDRESS_RE = /^[^\s@<>,;:"\\()[\]]+@[^\s@<>,;:"\\()[\]]+\.[^\s@<>,;:"\\()[\]]+$/;

export function isValidRecipientAddress(address: unknown): address is string {
  if (typeof address !== "string") return false;
  const a = address.trim();
  return a.length > 0 && a.length <= MAX_RECIPIENT_ADDRESS_LENGTH && ADDRESS_RE.test(a);
}

export const recipientKey = (address: string) => address.trim().toLowerCase();

function cleanName(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined;
  // 改行（ヘッダーの差し込み）と、アドレスの区切りに使う記号は表示名から除く
  const n = name.slice(0, MAX_NAME_LENGTH * 2).replace(/[\r\n<>"\\]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH);
  return n || undefined;
}

// 壊れた値・重なり・上限を整えた送信先の並び。invalid は形が正しくなくて捨てた件数、overLimit は上限を超えて捨てた件数
export function normalizeRecipients(list: unknown): { recipients: ComposeRecipient[]; invalid: number; overLimit: number } {
  const out: ComposeRecipient[] = [];
  const index = new Map<string, number>();
  let invalid = 0;
  let overLimit = 0;
  if (!Array.isArray(list)) return { recipients: out, invalid, overLimit };
  // 入力の件数そのものにも上限を置く（巨大な配列で固まらないように）
  for (const raw of list.slice(0, MAX_RECIPIENTS * 4)) {
    const r = raw as Partial<ComposeRecipient> | null;
    if (!r || typeof r !== "object" || !isValidRecipientAddress(r.address) || !ROLES.includes(r.role as RecipientRole)) { invalid++; continue; }
    const address = r.address.trim();
    const role = r.role as RecipientRole;
    const name = cleanName(r.name);
    const key = recipientKey(address);
    const at = index.get(key);
    if (at !== undefined) {
      const cur = out[at];
      // 重なったら立場の強いほう（To > Cc > Bcc）を残す。表示名は分かっているほうを使う
      out[at] = { address: cur.address, name: cur.name || name, role: ROLE_RANK[role] < ROLE_RANK[cur.role] ? role : cur.role };
      if (!out[at].name) delete out[at].name;
      continue;
    }
    if (out.length >= MAX_RECIPIENTS) { overLimit++; continue; }
    index.set(key, out.length);
    out.push(name ? { address, name, role } : { address, role });
  }
  if (Array.isArray(list) && list.length > MAX_RECIPIENTS * 4) overLimit += list.length - MAX_RECIPIENTS * 4;
  return { recipients: out, invalid, overLimit };
}

// 「表示名 <アドレス>, アドレス」の並びを送信先にする（形が正しくないものは捨てる）
export function recipientsFromHeader(list: string | undefined, role: RecipientRole): ComposeRecipient[] {
  const entries = splitAddressList((list || "").slice(0, 200_000)).map(e => {
    const { name, address } = parseAddress(e);
    return { address, name: name || undefined, role };
  });
  return normalizeRecipients(entries).recipients;
}

// 送る立場ごとのヘッダーの値（"表示名" <アドレス>, ...）。表示名の符号化は mime.ts の formatAddressHeader が行う
export function recipientsHeader(list: ComposeRecipient[], role: RecipientRole): string {
  return list.filter(r => r.role === role).map(r => (r.name ? `"${r.name}" <${r.address}>` : r.address)).join(", ");
}

export function includesAddress(list: ComposeRecipient[], address: string): boolean {
  const k = recipientKey(address || "");
  return !!k && list.some(r => recipientKey(r.address) === k);
}

// 比べるための文字列（並び順に左右されない）
export function recipientsKey(list: ComposeRecipient[]): string {
  return list.map(r => `${r.role}:${recipientKey(r.address)}`).sort().join(",");
}

export function displayRecipientName(r: Pick<ComposeRecipient, "name" | "address">): string {
  return r.name ? `${r.name}さん` : r.address;
}

// たたんだときの1行。「山田さん ほか2名（Cc 1・Bcc 1）」。最初に出すのは To の最初、無ければ Cc、無ければ Bcc
export function summarizeRecipients(list: ComposeRecipient[]): string {
  const first = pickMoveTarget(list);
  if (!first) return "";
  const cc = list.filter(r => r.role === "cc").length;
  const bcc = list.filter(r => r.role === "bcc").length;
  const counts = [cc ? `Cc ${cc}` : "", bcc ? `Bcc ${bcc}` : ""].filter(Boolean).join("・");
  const head = list.length > 1 ? `${displayRecipientName(first)} ほか${list.length - 1}名` : displayRecipientName(first);
  return counts ? `${head}（${counts}）` : head;
}

// 今のチャットの相手が送信先から外れたときに移る先：To の最初、無ければ Cc の最初、無ければ Bcc の最初（追加した順）
export function pickMoveTarget(list: ComposeRecipient[]): ComposeRecipient | null {
  for (const role of ROLES) {
    const hit = list.find(r => r.role === role);
    if (hit) return hit;
  }
  return null;
}

// 送信先が1人以上いて、今のチャットの相手が含まれないか（相手のアドレスが分からないときは判定しない）
export function excludesPartner(list: ComposeRecipient[], partnerAddress: string): boolean {
  if (!isValidRecipientAddress(partnerAddress)) return false;
  return list.length > 0 && !includesAddress(list, partnerAddress);
}

const lowerSet = (list: string[]) => new Set(list.filter(Boolean).map(a => a.trim().toLowerCase()));
const withoutMe = (list: ComposeRecipient[], me: Set<string>) => list.filter(r => !me.has(recipientKey(r.address)));

export type ReplyChoices = {
  // 返信：今のチャットの相手（To）＋返信元の差出人（Reply-To 優先。To）
  reply: ComposeRecipient[];
  // 全員に返信：今のチャットの相手（To）＋返信元の To（To）・Cc（Cc）
  replyAll: ComposeRecipient[];
  // 自分と相手以外の宛先があるか（あるときだけ「返信」「全員に返信」を選んでもらう）
  needsChoice: boolean;
};

// 返信元を選んだときの宛先の候補。Bcc は入れない（受け取ったメールには残らないため）。自分とエイリアスは除く
export function replyChoices(src: ReplySource, partner: ComposeRecipient | null, myAddresses: string[]): ReplyChoices {
  const me = lowerSet(myAddresses);
  const plan = planReply(src, myAddresses);
  const head = partner ? [{ ...partner, role: "to" as const }] : [];
  const reply = normalizeRecipients([...head, ...withoutMe(recipientsFromHeader(plan.senderOnly.to, "to"), me)]).recipients;
  const replyAll = normalizeRecipients([
    ...head,
    ...withoutMe(recipientsFromHeader(plan.all.to, "to"), me),
    ...withoutMe(recipientsFromHeader(plan.all.cc, "cc"), me),
  ]).recipients;
  return { reply, replyAll, needsChoice: plan.extra.length > 0 };
}

// 送信先を選ぶ画面の「元のメールに入っていた人」：差出人（Reply-To 優先）・To・Cc を元の立場付きで。自分とエイリアスは除く
export function originalParticipants(src: ReplySource, myAddresses: string[]): ComposeRecipient[] {
  const me = lowerSet(myAddresses);
  const sender = recipientsFromHeader(src.replyTo, "to").length > 0 ? recipientsFromHeader(src.replyTo, "to") : recipientsFromHeader(src.from, "to");
  return normalizeRecipients([
    ...withoutMe(sender, me),
    ...withoutMe(recipientsFromHeader(src.to, "to"), me),
    ...withoutMe(recipientsFromHeader(src.cc, "cc"), me),
  ]).recipients;
}

// 返信元があり、送信先に返信元のメールの差出人・Reply-To・To・Cc（自分を除く）が1人もいない＝
// 元のメールの内容（引用）が、元のやり取りにいなかった人にだけ届く
export function quoteGoesToOutsiders(list: ComposeRecipient[], src: ReplySource | null, myAddresses: string[]): boolean {
  if (!src || list.length === 0) return false;
  const me = lowerSet(myAddresses);
  const original = new Set(
    [src.from, src.replyTo, src.to, src.cc]
      .flatMap(h => recipientsFromHeader(h, "to"))
      .map(r => recipientKey(r.address))
      .filter(k => !me.has(k))
  );
  // 元のメールが自分だけのやり取りなら、注意を出す相手がいない
  if (original.size === 0) return false;
  return !list.some(r => original.has(recipientKey(r.address)));
}

export type SendHeaders = { to: string; cc: string; bcc: string };
export type SendHeadersCheck = { ok: true; headers: SendHeaders; count: number } | { ok: false; error: "NO_RECIPIENTS" | "TOO_MANY_RECIPIENTS" | "INVALID_RECIPIENTS" };

// 1件の宛先（表示名つき）の長さの上限。表示名は画面側で 200 文字までにしているので、それより十分長い値は壊れた入力とみなす
const MAX_ENTRY_LENGTH = 1000;

// サーバーで送信の宛先を確かめる。To / Cc / Bcc は文字列か未指定。改行を含む・形が正しくない・
// 合計 500 件を超える・1件も無いときは送らない（宛先を勝手に直さず、そのまま 400 で返す）
export function validateSendHeaders(input: { to?: unknown; cc?: unknown; bcc?: unknown }): SendHeadersCheck {
  const fields = { to: input.to, cc: input.cc, bcc: input.bcc };
  const headers: SendHeaders = { to: "", cc: "", bcc: "" };
  let count = 0;
  for (const key of ["to", "cc", "bcc"] as const) {
    const v = fields[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string") return { ok: false, error: "INVALID_RECIPIENTS" };
    if (v.length > MAX_RECIPIENTS * MAX_ENTRY_LENGTH) return { ok: false, error: "TOO_MANY_RECIPIENTS" };
    if (/[\r\n]/.test(v)) return { ok: false, error: "INVALID_RECIPIENTS" };
    const entries = splitAddressList(v);
    for (const e of entries) {
      if (e.length > MAX_ENTRY_LENGTH || !isValidRecipientAddress(parseAddress(e).address)) return { ok: false, error: "INVALID_RECIPIENTS" };
    }
    count += entries.length;
    if (count > MAX_RECIPIENTS) return { ok: false, error: "TOO_MANY_RECIPIENTS" };
    headers[key] = v.trim();
  }
  if (count === 0) return { ok: false, error: "NO_RECIPIENTS" };
  return { ok: true, headers, count };
}

// 送ったメールの時間の横に出す「To 1・Cc 2・Bcc 1」（0 のものは出さない）
export function sentRecipientCounts(email: { to?: string; cc?: string; bcc?: string }): string {
  const count = (h?: string) => splitAddressList((h || "").slice(0, 200_000)).length;
  return ([["To", count(email.to)], ["Cc", count(email.cc)], ["Bcc", count(email.bcc)]] as const)
    .filter(([, n]) => n > 0).map(([label, n]) => `${label} ${n}`).join("・");
}

// 受け取ったメールで、自分（エイリアスを含む）がどの欄にいたか。To にも Cc にもいなければ「宛先に自分なし」
// （Bcc・メーリングリスト・自動転送のどれか分からないため、「Bcc」とは書かない）
export function receivedRole(email: { to?: string; cc?: string }, myAddresses: string[]): "To" | "Cc" | "宛先に自分なし" {
  const me = lowerSet(myAddresses);
  const has = (h?: string) => splitAddressList((h || "").slice(0, 200_000)).some(e => me.has(parseAddress(e).address.trim().toLowerCase()));
  if (has(email.to)) return "To";
  if (has(email.cc)) return "Cc";
  return "宛先に自分なし";
}
