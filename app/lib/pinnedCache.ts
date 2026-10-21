// ピン留めしたメールの中身を、端末の IndexedDB にアカウントごとに置いておくキャッシュ。
// D1 には ID しか保存しないので、リロード後もすぐ表示できるようここから出し、足りない分だけ Gmail から取る。
// ログアウト・連携解除で消せるよう、キーは「pinned:アカウント」に揃える
import localforage from "localforage";
import type { Email } from "../types/email";

const store = localforage.createInstance({ name: "remail", storeName: "pinned" });

const keyFor = (account: string) => `pinned:${account.trim().toLowerCase()}`;

export async function loadPinnedCache(account: string): Promise<Record<string, Email>> {
  try {
    return (await store.getItem<Record<string, Email>>(keyFor(account))) || {};
  } catch {
    // 端末の保存領域が使えない（プライベートモードなど）場合は、Gmail から取り直すだけにする
    return {};
  }
}

// そのアカウントのピン留めメールの一覧で丸ごと置き換える（ピン留めを外したものは残さない）
export async function savePinnedCache(account: string, emails: Email[]): Promise<void> {
  const record: Record<string, Email> = {};
  for (const e of emails) record[e.id] = e;
  try {
    if (emails.length === 0) await store.removeItem(keyFor(account));
    else await store.setItem(keyFor(account), record);
  } catch {
    // 保存できなくても表示には困らない（次回は Gmail から取り直す）
  }
}

export async function removePinnedCache(account: string): Promise<void> {
  try { await store.removeItem(keyFor(account)); } catch { /* 消せなくても次の保存で上書きされる */ }
}

export async function clearPinnedCache(): Promise<void> {
  try { await store.clear(); } catch { /* 消せなくても次の保存で上書きされる */ }
}
