// 送信の API に届いた「本文中の画像」（書式付きの入力欄で入れたもの）を確かめる純粋関数。
// 形が正しくないもの・上限を超えるものが1つでもあれば、送らずに断る（勝手に落として送らない）
import type { MimeInlinePart } from "./mime";

export const INLINE_IMAGE_LIMITS = { maxImages: 20, maxImageBytes: 10 * 1024 * 1024 } as const;
const TYPES = /^image\/(png|jpeg|gif|webp|bmp)$/;
const CID = /^ii_[0-9a-z]{1,24}$/;

export function validateInlineImages(v: unknown): { ok: true; images: MimeInlinePart[] } | { ok: false } {
  if (!Array.isArray(v) || v.length > INLINE_IMAGE_LIMITS.maxImages) return { ok: false };
  const images: MimeInlinePart[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    const i = raw as Partial<{ contentId: string; filename: string; mimeType: string; data: string }> | null;
    if (!i || typeof i !== "object") return { ok: false };
    if (typeof i.contentId !== "string" || !CID.test(i.contentId) || seen.has(i.contentId)) return { ok: false };
    if (typeof i.mimeType !== "string" || !TYPES.test(i.mimeType)) return { ok: false };
    if (typeof i.data !== "string" || !/^[A-Za-z0-9+/=\r\n]*$/.test(i.data.slice(0, 1000))) return { ok: false };
    if (Math.floor((i.data.length * 3) / 4) > INLINE_IMAGE_LIMITS.maxImageBytes) return { ok: false };
    const filename = typeof i.filename === "string" && i.filename.trim() ? i.filename.slice(0, 200) : "image.png";
    seen.add(i.contentId);
    images.push({ contentId: i.contentId, filename, mimeType: i.mimeType, data: i.data });
  }
  return { ok: true, images };
}
