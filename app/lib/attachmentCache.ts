import localforage from "localforage";

// 添付と動画サムネイルのキャッシュは、ログアウト・連携解除で消せるようアカウントごとにキーを分ける（絶対ルール1）。
// アカウントを含まない以前の形式（storeName が attachments / video_thumbs）は、どのアカウントのものか分からないので一度だけ捨てる
const _store = localforage.createInstance({
  name: "remail",
  storeName: "attachments_v2",
});

if (typeof window !== "undefined") {
  void localforage.dropInstance({ name: "remail", storeName: "attachments" }).catch(() => {});
  void localforage.dropInstance({ name: "remail", storeName: "video_thumbs" }).catch(() => {});
}

const accountPrefix = (account: string) => `${account.trim().toLowerCase()}|`;

// Gmail APIの attachmentId はメッセージ再取得のたびに変わることがあるため、
// キャッシュキーには使わずファイル名+サイズ+添付順で安定したキーを組み立てる。先頭にアカウントを付ける
export function attachmentCacheKey(account: string, messageId: string, index: number, filename: string, size: number): string {
  return `${accountPrefix(account)}${messageId}:${index}:${filename}:${size}`;
}

// attachmentId で開く場合（画面のキャッシュキーが無いとき）のキー
export function attachmentIdCacheKey(account: string, messageId: string, attachmentId: string | undefined): string {
  return `${accountPrefix(account)}${messageId}:${attachmentId}`;
}

// L1: in-memory (survives re-renders, lost on page reload)
export const memCache = new Map<string, string>();

function base64ToUint8(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function uint8ToBase64(u8: Uint8Array): string {
  let s = "";
  const chunk = 8192;
  for (let i = 0; i < u8.length; i += chunk) {
    s += String.fromCharCode(...u8.subarray(i, i + chunk));
  }
  return btoa(s);
}

// L2: IndexedDB (survives page reload, stores raw binary — 25% smaller than base64)
export async function getCachedAttachment(key: string): Promise<string | null> {
  const mem = memCache.get(key);
  if (mem !== undefined) return mem;
  try {
    const bin = await _store.getItem<Uint8Array>(key);
    if (!bin) return null;
    const b64 = uint8ToBase64(bin);
    memCache.set(key, b64);
    return b64;
  } catch {
    return null;
  }
}

export async function setCachedAttachment(key: string, base64: string): Promise<void> {
  memCache.set(key, base64);
  try {
    await _store.setItem(key, base64ToUint8(base64));
  } catch {}
}

// 動画サムネイル（フレーム画像 + アスペクト比）のキャッシュ
export type VideoThumb = { dataUrl: string; ratio: number };

const _thumbStore = localforage.createInstance({
  name: "remail",
  storeName: "video_thumbs_v2",
});

export const videoThumbMemCache = new Map<string, VideoThumb>();

export async function getCachedVideoThumb(key: string): Promise<VideoThumb | null> {
  const mem = videoThumbMemCache.get(key);
  if (mem) return mem;
  try {
    const stored = await _thumbStore.getItem<VideoThumb>(key);
    if (stored) videoThumbMemCache.set(key, stored);
    return stored ?? null;
  } catch {
    return null;
  }
}

export async function setCachedVideoThumb(key: string, thumb: VideoThumb): Promise<void> {
  videoThumbMemCache.set(key, thumb);
  try {
    await _thumbStore.setItem(key, thumb);
  } catch {}
}

// 連携を解除したアカウントの添付・サムネイルだけを消す
export async function removeAccountAttachmentCaches(account: string): Promise<void> {
  const prefix = accountPrefix(account);
  for (const key of Array.from(memCache.keys())) if (key.startsWith(prefix)) memCache.delete(key);
  for (const key of Array.from(videoThumbMemCache.keys())) if (key.startsWith(prefix)) videoThumbMemCache.delete(key);
  for (const store of [_store, _thumbStore]) {
    try {
      const keys = await store.keys();
      await Promise.all(keys.filter(k => k.startsWith(prefix)).map(k => store.removeItem(k)));
    } catch { /* 消せなかった分は次のログアウトでまとめて消える */ }
  }
}

// ログアウトしたときに、すべてのアカウントの添付・サムネイルを消す
export async function clearAttachmentCaches(): Promise<void> {
  memCache.clear();
  videoThumbMemCache.clear();
  await Promise.all([_store.clear().catch(() => {}), _thumbStore.clear().catch(() => {})]);
}
