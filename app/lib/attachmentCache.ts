import localforage from "localforage";

const _store = localforage.createInstance({
  name: "remail",
  storeName: "attachments",
});

// Gmail APIの attachmentId はメッセージ再取得のたびに変わることがあるため、
// キャッシュキーには使わずファイル名+サイズ+添付順で安定したキーを組み立てる
export function attachmentCacheKey(messageId: string, index: number, filename: string, size: number): string {
  return `${messageId}:${index}:${filename}:${size}`;
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
  storeName: "video_thumbs",
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
