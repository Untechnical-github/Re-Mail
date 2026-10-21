// ピン留めの保存データ（D1 の custom_name に入る JSON）の読み書きを助ける純粋関数。
// D1 にはメールの中身を置かず、Gmail のメッセージ ID だけを保存する（絶対ルール1）。
// 以前の形式（data にメール本体を丸ごと入れていた）も読めるようにしておく（ロールバックしても壊れないように）
import type { Email } from "../types/email";

// 1つのピン留めチャットで覚えておく ID の上限（以前の「直近60件」と同じ）
export const MAX_PINNED_IDS_PER_CHAT = 60;

const GMAIL_ID_RE = /^[0-9a-f]{6,32}$/i;
export const isGmailId = (v: unknown): v is string => typeof v === "string" && GMAIL_ID_RE.test(v);

// 保存データの JSON から、ピン留めしたメールの ID と、古い形式で入っていたメール本体を取り出す
export function readPinnedField(parsed: { ids?: unknown; data?: unknown }): { ids: string[]; legacyEmails: Email[] } {
  const legacyEmails: Email[] = [];
  if (parsed.data) {
    const list = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
    for (const e of list) {
      if (e && typeof e === "object" && isGmailId((e as Email).id)) legacyEmails.push(e as Email);
    }
  }
  const ids = Array.isArray(parsed.ids) ? parsed.ids.filter(isGmailId) : legacyEmails.map(e => e.id);
  return { ids: capPinnedIds(ids), legacyEmails };
}

// 重複を除き、上限までにする（先頭ほど新しいメールという並びを保つ）
export function capPinnedIds(ids: string[]): string[] {
  return Array.from(new Set(ids.filter(isGmailId))).slice(0, MAX_PINNED_IDS_PER_CHAT);
}

// ピン留めチャットの ID 一覧を作り直す。今読み込めているそのチャットのメール（新しい順）を先に、
// まだ読み込めていない以前の ID を後ろに並べる。読み込み前の ID を落とすと、
// 古いメールのピン留めが消えてしまうため残す（ゴミ箱・迷惑メールに移ったものと、存在しないものは除く）
export function mergePinnedIds(loadedIdsNewestFirst: string[], previousIds: string[], dropIds: Set<string>): string[] {
  const loaded = new Set(loadedIdsNewestFirst);
  const rest = previousIds.filter(id => !loaded.has(id) && !dropIds.has(id));
  return capPinnedIds([...loadedIdsNewestFirst.filter(id => !dropIds.has(id)), ...rest]);
}

// Gmail 側で削除されて取得できなかったピン留めメールの代わりに表示するもの
export function missingPinnedEmail(id: string, roomLocalKey: string | undefined, accountId: string): Email {
  return {
    id,
    threadId: "",
    subject: "(このメールは存在しません)",
    from: "",
    to: "",
    date: new Date(0).toUTCString(),
    body: "このメールは存在しません",
    snippet: "",
    labelIds: [],
    senderRoom: roomLocalKey,
    accountId,
    isMissing: true,
  };
}
