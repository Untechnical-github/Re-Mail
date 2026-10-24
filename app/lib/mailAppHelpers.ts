// useMailApp.ts から分けた、React に依存しない小さな計算（一覧の取得・グループ・検索バー・端末の表示設定）
import type { Email } from "../types/email";

// 同時実行数を制限しつつ配列の各要素に非同期処理を適用する。連携アカウント数が多い場合に
// 全アカウントを一斉にPromise.allで叩くと、各アカウントのメール取得（内部でさらにメッセージ
// 詳細を並列取得する）が重なってGmail APIのレート制限に触れる恐れがあるため、
// アカウント単位のフェッチはこれで束ねる
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      results[current] = await fn(items[current]);
    }
  });
  await Promise.all(workers);
  return results;
}

// 送信直後、Gmailが採番した実IDを取得できなかった場合にだけ使うその場限りのフェイクID
// （"fake-<timestamp>"）が、後からの再取得で同じメールの「実データ版」と重複して
// 両方残ってしまうのを防ぐ。同じアカウント・送信済み・同じ宛先＋件名で、日時が数分以内に
// 近い実メールが見つかったら、フェイク側を取り除いて実データ側だけを残す
// （実IDを取得できた通常ケースでは、mapのキーがそもそも同じIDになるため、
// この関数を通しても何も除去されない＝無害）
export function reconcileFakeSentEmails(list: Email[]): Email[] {
  const fakes = list.filter(e => typeof e.id === "string" && e.id.startsWith("fake-"));
  if (fakes.length === 0) return list;
  const reals = list.filter(e => typeof e.id === "string" && !e.id.startsWith("fake-"));
  const supersededFakeIds = new Set<string>();
  fakes.forEach(fake => {
    const fakeTime = new Date(fake.date).getTime();
    const match = reals.find(real =>
      (real.accountId || "") === (fake.accountId || "") &&
      !!real.isMe === true &&
      (real.to || "") === (fake.to || "") &&
      (real.subject || "") === (fake.subject || "") &&
      Math.abs(new Date(real.date).getTime() - fakeTime) < 5 * 60 * 1000
    );
    if (match) supersededFakeIds.add(fake.id);
  });
  return supersededFakeIds.size === 0 ? list : list.filter(e => !supersededFakeIds.has(e.id));
}

export function getSavedBoxSettings(): { inbox?: boolean; archive?: boolean; spam?: boolean; trash?: boolean; sent?: boolean } | null {
  if (typeof window === "undefined") return null;
  try {
    const saved = localStorage.getItem("remail_box_settings");
    return saved ? JSON.parse(saved) : null;
  } catch {
    return null;
  }
}

// アカウント別の表示チェックボックス（受信箱/アーカイブ...とは別枠）。未設定のアカウントはデフォルトで表示扱いにする
export function getSavedAccountSettings(): Record<string, boolean> | null {
  if (typeof window === "undefined") return null;
  try {
    const saved = localStorage.getItem("remail_account_settings");
    return saved ? JSON.parse(saved) : null;
  } catch {
    return null;
  }
}

// グループチャットの「送信済みメール」判定用: DBには何も永続化せず、Toヘッダーの宛先セットが
// メンバー全員と完全一致するかどうかだけで、その都度判定する（送信履歴が増えてもD1を圧迫しない）
export function parseAddressSet(field: string): Set<string> {
  const set = new Set<string>();
  (field || "").split(",").forEach((part: string) => {
    const match = part.match(/<([^>]+)>/);
    const addr = (match ? match[1] : part).trim().toLowerCase();
    if (addr) set.add(addr);
  });
  return set;
}
export function sameAddressSet(a: Set<string>, b: Set<string>): boolean {
  return a.size > 0 && a.size === b.size && [...a].every(addr => b.has(addr));
}

// 大文字小文字を無視して、text内にkwが出現する回数を数える（検索バーの「1件名あたり複数ヒット」対応用）
export function countOccurrences(text: string, kwLower: string): number {
  if (!kwLower) return 0;
  const lower = text.toLowerCase();
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = lower.indexOf(kwLower, pos);
    if (idx === -1) break;
    count++;
    pos = idx + kwLower.length;
  }
  return count;
}
