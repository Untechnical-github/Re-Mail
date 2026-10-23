// ピン留めの保存データ（D1 の custom_name に入る JSON）の読み書きを助ける純粋関数。
// D1 にはメールの中身を置かず、Gmail のメッセージ ID だけを保存する（絶対ルール1）
import type { Email } from "../types/email";

// 1つのピン留めチャットで覚えておく ID の上限（以前の「直近60件」と同じ）
export const MAX_PINNED_IDS_PER_CHAT = 60;

const GMAIL_ID_RE = /^[0-9a-f]{6,32}$/i;
export const isGmailId = (v: unknown): v is string => typeof v === "string" && GMAIL_ID_RE.test(v);

// 保存データの JSON から、ピン留めしたメールの ID を取り出す（ID でない値は捨てる）
export function readPinnedIds(parsed: { ids?: unknown }): string[] {
  return Array.isArray(parsed.ids) ? capPinnedIds(parsed.ids.filter(isGmailId)) : [];
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

// 保存する設定（custom_name の JSON）からメール本体（data）を取り除く。ピン留めは ids だけを持つ形なので、
// data は今の画面からは送られないが、送られてきても D1 に書かないための守りとして保存の前に必ず通す（絶対ルール1）。
// 変える必要が無ければ、受け取った値をそのまま返す
export function stripPinnedBodies(customName: string | null | undefined): string | null | undefined {
  if (!customName || !customName.startsWith("{")) return customName;
  let obj: Record<string, unknown>;
  try {
    const v = JSON.parse(customName);
    if (!v || typeof v !== "object" || Array.isArray(v)) return customName;
    obj = v as Record<string, unknown>;
  } catch {
    return customName;
  }
  if (!("data" in obj)) return customName;
  delete obj.data;
  return JSON.stringify(obj);
}
