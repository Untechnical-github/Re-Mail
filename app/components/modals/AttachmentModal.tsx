import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from "react";
import { getFileIcon, formatFileSize } from "../ui";
import type { MailAppHook } from "../../hooks/useMailApp";

export function AttachmentModal({ app }: { app: MailAppHook }) {
  const { attachmentModal } = app.state;
  const { closeAttachmentModal } = app.actions;
  const [pdfBlobUrl, setPdfBlobUrl] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const imgContainerRef = useRef<HTMLDivElement>(null);
  const imgCleanupRef = useRef<(() => void) | null>(null);

  // テキスト添付の中身は base64 から決まるだけなので、state に持たず描画時に計算する
  const textBase64 = attachmentModal?.base64;
  const textMimeType = attachmentModal?.mimeType;
  const textContent = useMemo(() => {
    if (!textBase64 || !textMimeType?.startsWith('text/')) return null;
    try {
      const bytes = Uint8Array.from(atob(textBase64), (c: string) => c.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    } catch {
      return null;
    }
  }, [textBase64, textMimeType]);

  // PDFは data:URI だと Android Chrome の iframe 内で表示できないことがあるため、
  // blob: URL に変換して渡す（Android Chrome でも埋め込みPDFビューアが起動しやすくなる）
  useEffect(() => {
    if (!attachmentModal?.base64 || attachmentModal.mimeType !== 'application/pdf') {
      setPdfBlobUrl(null);
      return;
    }
    let url: string | null = null;
    try {
      const bytes = Uint8Array.from(atob(attachmentModal.base64), (c: string) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: 'application/pdf' });
      url = URL.createObjectURL(blob);
      setPdfBlobUrl(url);
    } catch {
      setPdfBlobUrl(null);
    }
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [attachmentModal?.base64, attachmentModal?.mimeType]);

  useLayoutEffect(() => {
    if (!attachmentModal) return;
    // PDFはブラウザ標準のビューアにズーム操作ごと任せるため、ビューポートを固定しない
    // （画像プレビューは独自のズーム実装を使うため固定する）
    if (attachmentModal.mimeType === 'application/pdf') return;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    const original = meta?.content ?? '';
    if (meta) meta.content = 'width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no';
    return () => { if (meta) meta.content = original; };
  }, [!!attachmentModal]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup zoom listeners when attachment changes or modal closes
  useEffect(() => {
    return () => { if (imgCleanupRef.current) { imgCleanupRef.current(); imgCleanupRef.current = null; } };
  }, [attachmentModal?.attachmentId ?? '']);

  const onImgLoad = useCallback(() => {
    const img = imgRef.current;
    const container = imgContainerRef.current;
    if (!img || !container) return;
    // Cached images may fire onLoad synchronously before DOM layout
    if (container.clientWidth === 0) {
      requestAnimationFrame(() => { if (imgRef.current && imgContainerRef.current) onImgLoad(); });
      return;
    }
    if (imgCleanupRef.current) { imgCleanupRef.current(); imgCleanupRef.current = null; }

    const cW = container.clientWidth;
    const cH = container.clientHeight;
    const imgW = img.offsetWidth;
    const imgH = img.offsetHeight;

    let scale = 1;
    let x = (cW - imgW) / 2;
    let y = (cH - imgH) / 2;

    // Apply x,y,scale directly — NO clamping during gesture (prevents anchor drift)
    const setTransform = (transition = 'none') => {
      img.style.transition = transition;
      img.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
    };

    // Correct position — called ONLY after gesture ends
    const snap = (transition = 'transform 0.2s ease-out') => {
      const vW = imgW * scale;
      const vH = imgH * scale;
      if (scale <= 1) {
        scale = 1; x = (cW - imgW) / 2; y = (cH - imgH) / 2;
      } else {
        x = vW <= cW ? (cW - vW) / 2 : Math.max(cW - vW, Math.min(0, x));
        y = vH <= cH ? (cH - vH) / 2 : Math.max(cH - vH, Math.min(0, y));
      }
      img.style.transition = transition;
      img.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
    };

    const centerImage = (animated = true) => {
      scale = 1; x = (cW - imgW) / 2; y = (cH - imgH) / 2;
      setTransform(animated ? 'transform 0.2s ease-out' : 'none');
      container.style.cursor = 'grab';
    };

    centerImage(false);
    img.style.opacity = '1';

    // Wheel zoom: anchor from unclamped x,y → zero drift
    let wheelSnapTimer: ReturnType<typeof setTimeout> | null = null;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (wheelSnapTimer) { clearTimeout(wheelSnapTimer); wheelSnapTimer = null; }
      const newScale = scale * (1 + (e.deltaY > 0 ? -1 : 1) * 0.15);
      if (newScale <= 1) { centerImage(); return; }
      const rect = container.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const bx = (mx - x) / scale;
      const by = (my - y) / scale;
      x = mx - bx * newScale;
      y = my - by * newScale;
      scale = newScale;
      setTransform('transform 0.05s ease-out');
      wheelSnapTimer = setTimeout(() => { snap(); wheelSnapTimer = null; }, 300);
    };

    // Mouse drag
    let isDragging = false;
    let dragStartMouseX = 0, dragStartMouseY = 0, dragStartImageX = 0, dragStartImageY = 0;
    let canMoveX = false, canMoveY = false;

    const checkMovability = () => {
      canMoveX = imgW * scale > cW + 1;
      canMoveY = imgH * scale > cH + 1;
    };

    const onMouseDown = (e: MouseEvent) => {
      if (scale <= 1) return;
      e.preventDefault();
      snap('none'); // sync to valid position before drag starts
      isDragging = true;
      checkMovability();
      dragStartMouseX = e.clientX; dragStartMouseY = e.clientY;
      dragStartImageX = x; dragStartImageY = y;
      container.style.cursor = 'grabbing';
      img.style.transition = 'none';
    };
    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      e.preventDefault();
      let dx = e.clientX - dragStartMouseX;
      let dy = e.clientY - dragStartMouseY;
      if (!canMoveX) dx = 0;
      if (!canMoveY) dy = 0;
      x = dragStartImageX + dx;
      y = dragStartImageY + dy;
      setTransform();
    };
    const onMouseUp = () => {
      if (isDragging) {
        isDragging = false;
        container.style.cursor = 'grab';
        snap('transform 0.1s ease-out');
      }
    };

    // Touch: absolute anchor for pinch (zero drift) + incremental for single-touch pan
    let isPinching = false;
    let pinchStartDist = 0, pinchStartScale = 1;
    let pinchStartBodyX = 0, pinchStartBodyY = 0;
    let singleTouching = false;
    let lastTouchX = 0, lastTouchY = 0;

    const getTouchDist = (t: TouchList) => {
      const dx = t[0].clientX - t[1].clientX; const dy = t[0].clientY - t[1].clientY;
      return Math.sqrt(dx * dx + dy * dy);
    };
    const getTouchMid = (t: TouchList) => ({
      x: (t[0].clientX + t[1].clientX) / 2,
      y: (t[0].clientY + t[1].clientY) / 2,
    });

    const onTouchStart = (e: TouchEvent) => {
      e.preventDefault();
      if (e.touches.length === 2) {
        isPinching = true; singleTouching = false;
        const mid = getTouchMid(e.touches);
        pinchStartDist = getTouchDist(e.touches);
        pinchStartScale = scale;
        // Absolute anchor from unclamped x,y — recorded ONCE, used every frame
        pinchStartBodyX = (mid.x - x) / scale;
        pinchStartBodyY = (mid.y - y) / scale;
        img.style.transition = 'none';
      } else if (e.touches.length === 1 && !isPinching) {
        singleTouching = true;
        if (scale > 1) {
          checkMovability();
          lastTouchX = e.touches[0].clientX; lastTouchY = e.touches[0].clientY;
          img.style.transition = 'none';
        }
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.cancelable) e.preventDefault();
      if (e.touches.length === 2 && isPinching) {
        const currentDist = getTouchDist(e.touches);
        const currentMid = getTouchMid(e.touches);
        const newScale = pinchStartScale * currentDist / pinchStartDist;
        if (newScale <= 1) { centerImage(); return; }
        // Recompute from absolute anchor every frame — no incremental error
        scale = newScale;
        x = currentMid.x - pinchStartBodyX * newScale;
        y = currentMid.y - pinchStartBodyY * newScale;
        img.style.transition = 'none';
        setTransform();
      } else if (e.touches.length === 1 && singleTouching && !isPinching && scale > 1) {
        let dx = e.touches[0].clientX - lastTouchX;
        let dy = e.touches[0].clientY - lastTouchY;
        if (!canMoveX) dx = 0;
        if (!canMoveY) dy = 0;
        x += dx; y += dy;
        lastTouchX = e.touches[0].clientX; lastTouchY = e.touches[0].clientY;
        img.style.transition = 'none';
        setTransform();
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) { isPinching = false; }
      if (e.touches.length === 1 && !isPinching) {
        singleTouching = true; checkMovability();
        lastTouchX = e.touches[0].clientX; lastTouchY = e.touches[0].clientY;
        img.style.transition = 'none';
      } else if (e.touches.length === 0) {
        singleTouching = false;
        snap();
      }
    };

    img.addEventListener('wheel', onWheel, { passive: false });
    img.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    img.addEventListener('touchstart', onTouchStart, { passive: false });
    img.addEventListener('touchmove', onTouchMove, { passive: false });
    img.addEventListener('touchend', onTouchEnd);

    imgCleanupRef.current = () => {
      if (wheelSnapTimer) { clearTimeout(wheelSnapTimer); wheelSnapTimer = null; }
      img.removeEventListener('wheel', onWheel);
      img.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      img.removeEventListener('touchstart', onTouchStart);
      img.removeEventListener('touchmove', onTouchMove);
      img.removeEventListener('touchend', onTouchEnd);
    };
  }, []);

  if (!attachmentModal) return null;

  const { filename, mimeType, size, base64, isLoading } = attachmentModal;
  const isImage = mimeType.startsWith('image/');
  const isPdf = mimeType === 'application/pdf';
  const isTextFile = mimeType.startsWith('text/');
  const isAudio = mimeType.startsWith('audio/');
  const isVideo = mimeType.startsWith('video/');
  const canPreview = isImage || isPdf || isTextFile || isAudio || isVideo;
  const dataUrl = base64 ? `data:${mimeType};base64,${base64}` : null;

  const handleDownload = () => {
    if (!dataUrl) return;
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleOpenPdfInNewTab = () => {
    // Android Chrome は iframe に埋め込んだPDFを表示できないことがあるため、
    // 新しいタブで開いてブラウザ標準のPDFビューアに直接表示させる。
    // data:URI だとURL長の上限に引っかかる大きめのPDFもあるため blob: URL を使う
    if (pdfBlobUrl) { window.open(pdfBlobUrl, '_blank'); return; }
    if (dataUrl) window.open(dataUrl, '_blank');
  };

  const handleShare = async () => {
    if (!base64) return;
    try {
      const bytes = Uint8Array.from(atob(base64), (c: string) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: mimeType });
      const file = new File([blob], filename, { type: mimeType });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
        return;
      }
    } catch {}
    handleDownload();
  };

  return (
    <div className="fixed inset-0 bg-black/80 z-[60] flex items-center justify-center p-2 sm:p-4" onClick={closeAttachmentModal}>
      <div
        className="bg-[#2B2D31] rounded-lg shadow-2xl w-full max-w-2xl flex flex-col border border-[#1E1F22]"
        style={{ height: canPreview ? '90dvh' : 'auto' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ヘッダー */}
        <div className="flex items-center gap-3 p-4 border-b border-[#1E1F22] flex-shrink-0">
          <span className="flex-shrink-0">{getFileIcon(mimeType, "w-6 h-6")}</span>
          <div className="flex-1 min-w-0">
            <div className="font-bold text-white text-sm truncate">{filename}</div>
            <div className="text-[11px] text-gray-400">{formatFileSize(size)} · {mimeType}</div>
          </div>
          <button onClick={closeAttachmentModal} className="text-gray-400 hover:text-white text-xl font-bold flex-shrink-0 leading-none">×</button>
        </div>

        {/* プレビューエリア */}
        <div className="flex-1 min-h-0 relative overflow-hidden">
          {isLoading && (
            <div className="absolute inset-0 flex items-center justify-center text-gray-400 text-sm">読み込み中...</div>
          )}
          {!isLoading && !base64 && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-gray-500 text-sm p-4 text-center">
              <span>{getFileIcon(mimeType, "w-9 h-9")}</span>
              <span>ファイルを読み込めませんでした</span>
            </div>
          )}
          {!isLoading && dataUrl && isImage && (
            <div
              ref={imgContainerRef}
              className="w-full h-full overflow-hidden bg-[#111] relative"
              style={{ cursor: 'grab' }}
            >
              <img
                ref={imgRef}
                src={dataUrl}
                alt={filename}
                onLoad={onImgLoad}
                style={{
                  opacity: 0,
                  display: 'block',
                  maxWidth: '100%',
                  maxHeight: '100%',
                  transformOrigin: '0 0',
                  willChange: 'transform',
                  userSelect: 'none',
                }}
                draggable={false}
              />
            </div>
          )}
          {!isLoading && dataUrl && isPdf && (
            <iframe src={dataUrl} className="w-full h-full border-none" title={filename} />
          )}
          {!isLoading && dataUrl && isAudio && (
            <div className="w-full h-full flex items-center justify-center bg-[#1E1F22] p-8">
              <audio controls src={dataUrl} className="w-full max-w-md" />
            </div>
          )}
          {!isLoading && dataUrl && isVideo && (
            <div className="w-full h-full flex items-center justify-center bg-black">
              <video controls src={dataUrl} className="max-w-full max-h-full" />
            </div>
          )}
          {!isLoading && base64 && isTextFile && (
            <div className="w-full h-full overflow-auto p-4 bg-[#1E1F22]">
              <pre className="text-gray-200 text-sm whitespace-pre-wrap break-words font-mono leading-relaxed select-text">
                {textContent ?? '（テキストを読み込めませんでした）'}
              </pre>
            </div>
          )}
          {!isLoading && base64 && !canPreview && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-gray-400 p-8 text-center">
              <span>{getFileIcon(mimeType, "w-16 h-16")}</span>
              <span className="text-sm font-bold text-gray-300">{filename}</span>
              <span className="text-xs text-gray-500">このファイル形式はプレビューできません</span>
            </div>
          )}
        </div>

        {/* フッター */}
        <div className="p-4 border-t border-[#1E1F22] flex gap-3 flex-shrink-0">
          {isPdf && (
            <button onClick={handleOpenPdfInNewTab} disabled={!base64}
              className="flex-1 py-2.5 bg-[#2B2D31] border border-[#4752C4] hover:bg-[#35373C] disabled:opacity-30 text-gray-200 font-bold rounded text-sm transition">
              新しいタブで開く
            </button>
          )}
          <button onClick={handleDownload} disabled={!base64}
            className="flex-1 py-2.5 bg-[#5865F2] hover:bg-[#4752C4] disabled:bg-[#3f4147] disabled:text-gray-500 text-white font-bold rounded text-sm transition">
            ダウンロード
          </button>
          <button onClick={handleShare} disabled={!base64}
            className="flex-1 py-2.5 bg-[#2B2D31] border border-[#4752C4] hover:bg-[#35373C] disabled:opacity-30 text-gray-200 font-bold rounded text-sm transition">
            共有
          </button>
        </div>
      </div>
    </div>
  );
}
