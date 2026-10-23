// 返信の宛先を、純正 Gmail と同じ決まりで計算する純粋関数（返信元を選んだときの送信先の初期値づくりに使う。composeRecipients.ts）。
// - 返信（相手のみ）: Reply-To があればそこへ、なければ差出人へ。自分が送ったメールへの返信なら、元の To へ
// - 全員に返信: 上に加えて元の To の残りを To に、元の Cc を Cc に入れる。自分のアドレスと重複は除く
import { splitAddressList, parseAddress } from "./mime";

export type ReplySource = { from: string; to: string; cc?: string; replyTo?: string };
export type ReplyRecipients = { to: string; cc: string };
export type ExtraRecipient = { name: string; address: string; field: "to" | "cc" };
export type ReplyPlan = {
  senderOnly: ReplyRecipients;
  all: ReplyRecipients;
  // 「全員に返信」にすると増える宛先。空なら返信元を選んだときに「返信／全員に返信」を聞かない
  extra: ExtraRecipient[];
};

type Entry = { raw: string; name: string; address: string; key: string };

function entries(list: string | undefined): Entry[] {
  return splitAddressList(list || "")
    .map(raw => {
      const { name, address } = parseAddress(raw);
      return { raw: raw.trim(), name, address, key: address.trim().toLowerCase() };
    })
    .filter(e => e.key.includes("@"));
}

function uniqueExcluding(list: Entry[], exclude: Set<string>): Entry[] {
  const seen = new Set(exclude);
  const out: Entry[] = [];
  for (const e of list) {
    if (seen.has(e.key)) continue;
    seen.add(e.key);
    out.push(e);
  }
  return out;
}

const join = (list: Entry[]) => list.map(e => e.raw).join(", ");

export function planReply(src: ReplySource, myAddresses: string[]): ReplyPlan {
  const me = new Set(myAddresses.filter(Boolean).map(a => a.trim().toLowerCase()));
  const from = entries(src.from);
  const to = entries(src.to);
  const cc = entries(src.cc);
  const replyTo = entries(src.replyTo);
  const fromIsMe = from.length > 0 && me.has(from[0].key);

  // 相手のみに返すときの宛先
  let primary: Entry[];
  if (fromIsMe) primary = to;
  else if (replyTo.length > 0) primary = replyTo;
  else primary = from;
  let senderOnlyTo = uniqueExcluding(primary, me);
  // 自分宛てに自分で送ったメールなど、ほかに宛先が残らない場合は差出人（自分）へ返す
  if (senderOnlyTo.length === 0) senderOnlyTo = from.slice(0, 1);

  const allTo = uniqueExcluding([...senderOnlyTo, ...(fromIsMe ? [] : to)], me);
  const allCc = uniqueExcluding(cc, new Set([...me, ...allTo.map(e => e.key)]));

  const senderKeys = new Set(senderOnlyTo.map(e => e.key));
  const extra: ExtraRecipient[] = [
    ...allTo.filter(e => !senderKeys.has(e.key)).map(e => ({ name: e.name, address: e.address, field: "to" as const })),
    ...allCc.map(e => ({ name: e.name, address: e.address, field: "cc" as const })),
  ];

  return {
    senderOnly: { to: join(senderOnlyTo), cc: "" },
    all: { to: join(allTo), cc: join(allCc) },
    extra,
  };
}
