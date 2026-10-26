// Gmail の history API（前回からの変化だけを返す）で、画面のメール一覧を差分だけ更新するための純粋関数。
// これまでは約1分ごとに最新100通の詳細を全部取り直しており、Gmail API の利用上限をすぐに使い切っていた。
// history.list は1回2ユニットで、詳細を取り直すのは新しく届いたメールだけになる
import type { Email } from "../types/email";

type HistoryMessage = { id: string; threadId?: string; labelIds?: string[] };
export type GmailHistoryRecord = {
  id?: string;
  messagesAdded?: { message: HistoryMessage }[];
  messagesDeleted?: { message: HistoryMessage }[];
  labelsAdded?: { message: HistoryMessage; labelIds?: string[] }[];
  labelsRemoved?: { message: HistoryMessage; labelIds?: string[] }[];
};

export type HistorySummary = {
  added: string[]; // 新しく届いた（または作られた）メッセージ ID。詳細を取りにいく
  deleted: string[]; // 完全に削除されたメッセージ ID
  labels: Record<string, string[]>; // ラベルが変わったメッセージの、変わった後のラベル
};

// 変化の記録を古い順にたどり、最終的な状態にまとめる（追加された後に消されたものは、どちらにも入れない）
export function summarizeHistory(records: GmailHistoryRecord[]): HistorySummary {
  const added = new Set<string>();
  const deleted = new Set<string>();
  const labels: Record<string, string[]> = {};
  for (const r of records) {
    for (const a of r.messagesAdded || []) {
      if (!a.message?.id) continue;
      added.add(a.message.id);
      deleted.delete(a.message.id);
    }
    for (const d of r.messagesDeleted || []) {
      if (!d.message?.id) continue;
      if (added.has(d.message.id)) added.delete(d.message.id);
      else deleted.add(d.message.id);
      delete labels[d.message.id];
    }
    for (const l of [...(r.labelsAdded || []), ...(r.labelsRemoved || [])]) {
      if (!l.message?.id || !Array.isArray(l.message.labelIds)) continue;
      labels[l.message.id] = l.message.labelIds;
    }
  }
  // 新しく届いたメールは詳細を取り直すので、ラベルの変化は要らない
  for (const id of added) delete labels[id];
  return { added: Array.from(added), deleted: Array.from(deleted), labels };
}

export type BoxFlags = { inbox: boolean; archive: boolean; spam: boolean; trash: boolean; sent: boolean };

// そのメールが、いま画面で選んでいる場所（受信箱・アーカイブ・送信済・迷惑・ゴミ箱）に入るか。
// 一覧の取得（fetchEmails）が Gmail に投げている検索条件と同じ決まりにする
export function matchesBoxFlags(labelIds: string[] | undefined, flags: BoxFlags): boolean {
  const l = new Set(labelIds || []);
  // 下書きは画面に出さない（Gmail で書いている途中の下書きが、保存のたびに吹き出しとして出入りしないように）
  if (l.has("DRAFT")) return false;
  const spam = l.has("SPAM"), trash = l.has("TRASH"), inbox = l.has("INBOX"), sent = l.has("SENT");
  // 迷惑メール・ゴミ箱・送信済のどれも選んでいないときは、迷惑メールとゴミ箱を検索に含めていない
  const includeSpamTrash = flags.spam || flags.trash || flags.sent;
  if (!includeSpamTrash && (spam || trash)) return false;
  if (flags.archive) return flags.inbox || !inbox;
  return (flags.inbox && inbox) || (flags.sent && sent) || (flags.spam && spam) || (flags.trash && trash);
}

export type SyncResult = { messages: Email[]; labelUpdates: { id: string; labelIds: string[] }[]; deleted: string[] };

// メールを見分けるキー（アカウント＋Gmail のメッセージ ID）。連携したアカウントどうしでやり取りしたメールは、
// 送った側と受け取った側で同じ ID になることがあるため、ID だけで1通にまとめると片方のアカウントのメールが消え、
// ラベル（送信済みなど）も混ざる。accountId が無い古いデータは defaultAccount（ログインしているアカウント）のものとみなす
export function mailIdentity(e: Pick<Email, "id" | "accountId">, defaultAccount: string): string {
  return `${(e.accountId || defaultAccount).trim().toLowerCase()}|${e.id}`;
}

// 一覧に取ってきたメールを重ねる（同じアカウントの同じ ID は新しいほうで置き換える。ほかのアカウントのものは残す）
export function mergeEmails(base: Email[], incoming: Email[], defaultAccount: string): Email[] {
  const map = new Map<string, Email>();
  for (const e of base) map.set(mailIdentity(e, defaultAccount), e);
  for (const e of incoming) map.set(mailIdentity(e, defaultAccount), e);
  return Array.from(map.values());
}

// 差分を画面のメール一覧に当てる。新しいメールは今の場所の条件に合うものだけ足し、
// 既にあるメールはラベルを差し替え、削除されたものは取り除く。
// account を渡したときは、ラベルの変化と削除をそのアカウントのメールにだけ当てる（ほかのアカウントの同じ ID のメールは触らない）
export function applySyncResult(emails: Email[], result: SyncResult, flags: BoxFlags, account?: string, defaultAccount = ""): Email[] {
  const deleted = new Set(result.deleted);
  const labelMap = new Map(result.labelUpdates.map((u) => [u.id, u.labelIds]));
  const target = account?.trim().toLowerCase();
  const map = new Map<string, Email>();
  for (const e of emails) {
    const key = mailIdentity(e, defaultAccount);
    const mine = !target || (e.accountId || defaultAccount).trim().toLowerCase() === target;
    if (mine && deleted.has(e.id)) continue;
    const labels = mine ? labelMap.get(e.id) : undefined;
    map.set(key, labels ? { ...e, labelIds: labels } : e);
  }
  for (const m of result.messages) {
    if (deleted.has(m.id)) continue;
    const key = mailIdentity(m, defaultAccount);
    if (map.has(key) || matchesBoxFlags(m.labelIds, flags)) map.set(key, m);
  }
  return Array.from(map.values());
}

// ラベルが変わったメールのうち、まだ画面に無く、変わった後のラベルが今の場所の条件に合うもの
// （ゴミ箱から戻した・アーカイブから受信箱に戻した など）。これらは詳細を取りにいって一覧に足す
export function idsToFetchForLabelChanges(knownIds: Set<string>, labelUpdates: { id: string; labelIds: string[] }[], flags: BoxFlags): string[] {
  return labelUpdates.filter((u) => !knownIds.has(u.id) && matchesBoxFlags(u.labelIds, flags)).map((u) => u.id);
}

// 下書きの変化（Gmail の下書きとの同期で使う）。下書きが作られた・書き換えられた（DRAFT ラベルのメールの追加）か、
// DRAFT ラベルの付け外し・下書きのメールの削除があったか。addedDraftIds は詳細を取りにいかなくてよいメール（一覧には出さないため）
export function draftHistory(records: GmailHistoryRecord[]): { changed: boolean; addedDraftIds: string[] } {
  const added = new Set<string>();
  let changed = false;
  for (const r of records) {
    for (const a of r.messagesAdded || []) {
      if (a.message?.id && (a.message.labelIds || []).includes("DRAFT")) { added.add(a.message.id); changed = true; }
    }
    for (const d of r.messagesDeleted || []) {
      if ((d.message?.labelIds || []).includes("DRAFT")) changed = true;
    }
    for (const l of [...(r.labelsAdded || []), ...(r.labelsRemoved || [])]) {
      if ((l.labelIds || []).includes("DRAFT")) changed = true;
    }
  }
  return { changed, addedDraftIds: Array.from(added) };
}

// 差分同期の結果から、Gmail の下書きを取り直すべきか（下書きが変わった・知っている下書きのメッセージ ID が消えた）
export function shouldRefreshDrafts(draftChanged: boolean, deleted: string[], knownDraftMessageIds: Set<string>): boolean {
  return draftChanged || deleted.some(id => knownDraftMessageIds.has(id));
}
