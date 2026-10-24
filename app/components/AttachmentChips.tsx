"use client";

import { useState, useEffect } from "react";
import { getCachedAttachment, setCachedAttachment, memCache, getCachedVideoThumb, setCachedVideoThumb, videoThumbMemCache } from "../lib/attachmentCache";
import { generateVideoThumbnail } from "../lib/videoThumbnail";
import { formatFileSize } from "./ui";

// トーク画面のメッセージに並べる添付（画像はその場で表示、動画はサムネイル付きのチップ）。page.tsx から分けたもの（動きは同じ）
export function InlineAttachmentImage({ attachment, messageId, accountId, cacheKey, onOpen }: {
  attachment: { filename: string; mimeType: string; size: number; attachmentId?: string };
  messageId: string;
  accountId?: string;
  cacheKey: string;
  onOpen: (base64: string) => void;
}) {
  // Synchronous check of in-memory cache for instant display on remount
  const [base64, setBase64] = useState<string | null>(() => memCache.get(cacheKey) ?? null);
  const [loading, setLoading] = useState(() => !memCache.has(cacheKey));

  useEffect(() => {
    if (memCache.has(cacheKey)) return;
    let cancelled = false;
    (async () => {
      // L2: check IndexedDB (fast, survives page reload)
      const cached = await getCachedAttachment(cacheKey);
      if (cancelled) return;
      if (cached) { setBase64(cached); setLoading(false); return; }
      // L3: fetch from API
      // 送信直後のローカルのメールは attachmentId を持たない（中身は送信時にキャッシュへ書き込み済み）。
      // 問い合わせても取得できないので、取得失敗と同じ扱いにする
      if (!attachment.attachmentId) { if (!cancelled) setLoading(false); return; }
      try {
        const attParams = new URLSearchParams({ messageId, attachmentId: attachment.attachmentId });
        if (accountId) attParams.append("accountEmail", accountId);
        const res = await fetch(`/api/emails?${attParams.toString()}`);
        if (cancelled) return;
        if (res.ok) {
          const { data } = await res.json();
          if (!cancelled && data) {
            const b64 = (data as string).replace(/-/g, '+').replace(/_/g, '/');
            setCachedAttachment(cacheKey, b64); // fire and forget
            setBase64(b64);
          }
        }
      } catch {}
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [cacheKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return (
    <div className="w-40 h-24 rounded-xl bg-black/20 flex items-center justify-center">
      <div className="w-4 h-4 border-2 border-gray-500 border-t-white rounded-full animate-spin" />
    </div>
  );
  if (!base64) return null;

  return (
    <img
      src={`data:${attachment.mimeType};base64,${base64}`}
      alt={attachment.filename}
      className="max-w-[280px] max-h-52 rounded-xl cursor-pointer object-contain block hover:brightness-90 transition"
      onClick={(e) => { e.stopPropagation(); onOpen(base64); }}
      draggable={false}
    />
  );
}

const VIDEO_CHIP_MAX_W = 220;
const VIDEO_CHIP_MAX_H = 260;

function fitBox(ratio: number, maxW: number, maxH: number) {
  let w = maxW;
  let h = w / ratio;
  if (h > maxH) { h = maxH; w = h * ratio; }
  return { w: Math.round(w), h: Math.round(h) };
}

export function VideoAttachmentChip({ attachment, messageId, accountId, cacheKey, onOpen }: {
  attachment: { filename: string; mimeType: string; size: number; attachmentId?: string };
  messageId: string;
  accountId?: string;
  cacheKey: string;
  onOpen: () => void;
}) {
  const [thumb, setThumb] = useState<{ dataUrl: string; ratio: number } | null>(() => videoThumbMemCache.get(cacheKey) ?? null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (thumb || videoThumbMemCache.has(cacheKey)) return;
    let cancelled = false;
    (async () => {
      const cachedThumb = await getCachedVideoThumb(cacheKey);
      if (cancelled) return;
      if (cachedThumb) { setThumb(cachedThumb); return; }

      // 再生時と同じキャッシュを共有するので、後で開いたときに二重ダウンロードにならない
      let base64 = await getCachedAttachment(cacheKey);
      if (!base64 && attachment.attachmentId) {
        try {
          const attParams = new URLSearchParams({ messageId, attachmentId: attachment.attachmentId });
          if (accountId) attParams.append("accountEmail", accountId);
          const res = await fetch(`/api/emails?${attParams.toString()}`);
          if (res.ok) {
            const { data } = await res.json();
            if (data) {
              base64 = (data as string).replace(/-/g, '+').replace(/_/g, '/');
              setCachedAttachment(cacheKey, base64);
            }
          }
        } catch {}
      }
      if (cancelled) return;
      if (!base64) { setFailed(true); return; }

      const generated = await generateVideoThumbnail(base64, attachment.mimeType);
      if (cancelled) return;
      if (generated) {
        setThumb(generated);
        setCachedVideoThumb(cacheKey, generated);
      } else {
        setFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [cacheKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const { w, h } = fitBox(thumb?.ratio || 16 / 9, VIDEO_CHIP_MAX_W, VIDEO_CHIP_MAX_H);

  return (
    <div
      className="relative rounded-xl overflow-hidden cursor-pointer group select-none flex-shrink-0 bg-black"
      style={{ width: w, height: h }}
      onClick={(e) => { e.stopPropagation(); onOpen(); }}
    >
      {thumb ? (
        <img src={thumb.dataUrl} alt="" className="absolute inset-0 w-full h-full object-cover" draggable={false} />
      ) : (
        <div className="absolute inset-0 bg-gradient-to-br from-[#1a1a2e] to-[#2d1b69] flex items-center justify-center">
          {!failed && <div className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />}
        </div>
      )}
      <div className="absolute inset-0 flex items-center justify-center bg-black/10 group-hover:bg-black/25 transition">
        <div className="w-12 h-12 bg-white/90 rounded-full flex items-center justify-center shadow-xl group-hover:scale-110 transition-transform">
          <span className="text-black text-base ml-0.5">▶</span>
        </div>
      </div>
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-2.5 pb-1.5 pt-4">
        <div className="text-xs text-white font-medium truncate">{attachment.filename}</div>
        <div className="text-[10px] text-white/50">{formatFileSize(attachment.size)}</div>
      </div>
    </div>
  );
}
