import { useEffect, useRef, useState } from "react";
import { loadPdfjs } from "../lib/pdfjs";
import "pdfjs-dist/web/pdf_viewer.css";

const MAX_SCALE = 5;

// PDFをブラウザ標準ビューアに任せず pdf.js でキャンバスに描画するコンポーネント。
// 常にコンテナの横幅に合わせてレンダリングするため、モーダル幅=PDF幅になり、
// iOS Safariの拡大表示やAndroid Chromeで表示できない問題を回避できる。
// テキストレイヤーを重ねることでテキストのコピーも可能。
//
// 拡大操作はAttachmentModalの画像プレビューと同じ「translate3d + scale」方式の
// 独自ズームで実装する（モーダル表示中はネイティブのピンチズームを無効化しているため）。
// ただし画像と違いPDFは複数ページの縦長コンテンツなので、等倍（フィット幅）の間は
// 通常のスクロール／テキスト選択を優先し、ズームしたときだけドラッグ＝パン操作に切り替える。
export function PdfPreview({ base64, filename }: { base64: string; filename: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pagesContainerRef = useRef<HTMLDivElement>(null);
  const pdfRef = useRef<any>(null);
  const loadingTaskRef = useRef<any>(null);
  const renderTokenRef = useRef(0);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  // PDF本体の読み込み（添付ファイルが変わったときだけ）
  useEffect(() => {
    let cancelled = false;
    setStatus("loading");

    (async () => {
      try {
        const pdfjsLib = await loadPdfjs();
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const loadingTask = pdfjsLib.getDocument({ data: bytes });
        loadingTaskRef.current = loadingTask;
        const pdf = await loadingTask.promise;
        if (cancelled) { loadingTask.destroy(); return; }
        pdfRef.current = pdf;
        setStatus("ready");
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      pdfRef.current = null;
      if (loadingTaskRef.current) { loadingTaskRef.current.destroy(); loadingTaskRef.current = null; }
    };
  }, [base64]);

  // ページのレンダリング（コンテナ幅変更のたびに再描画）とズーム/パン操作のセットアップ
  useEffect(() => {
    if (status !== "ready" || !pdfRef.current || !containerRef.current || !pagesContainerRef.current) return;
    const container = containerRef.current;
    const content = pagesContainerRef.current;

    const renderAll = async () => {
      const myToken = ++renderTokenRef.current;
      const pdfjsLib = await loadPdfjs();
      const pdf = pdfRef.current;
      const containerWidth = container.clientWidth;
      if (renderTokenRef.current !== myToken || !pdf || !containerWidth) return;

      content.innerHTML = "";
      const dpr = Math.min(window.devicePixelRatio || 1, 2);

      for (let n = 1; n <= pdf.numPages; n++) {
        if (renderTokenRef.current !== myToken) return;
        const page = await pdf.getPage(n);
        if (renderTokenRef.current !== myToken) return;

        const baseViewport = page.getViewport({ scale: 1 });
        const cssScale = containerWidth / baseViewport.width;
        const cssViewport = page.getViewport({ scale: cssScale });
        const renderViewport = page.getViewport({ scale: cssScale * dpr });

        const pageWrapper = document.createElement("div");
        pageWrapper.style.position = "relative";
        pageWrapper.style.width = `${Math.ceil(cssViewport.width)}px`;
        pageWrapper.style.height = `${Math.ceil(cssViewport.height)}px`;
        pageWrapper.style.margin = n > 1 ? "8px auto 0" : "0 auto";
        // テキストレイヤーのCSS（pdf_viewer.css）が参照するスケール変数
        pageWrapper.style.setProperty("--scale-factor", String(cssScale));
        pageWrapper.style.setProperty("--total-scale-factor", String(cssScale));
        content.appendChild(pageWrapper);

        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(renderViewport.width);
        canvas.height = Math.ceil(renderViewport.height);
        canvas.style.width = "100%";
        canvas.style.height = "100%";
        canvas.style.display = "block";
        pageWrapper.appendChild(canvas);

        const ctx = canvas.getContext("2d");
        if (ctx) {
          await page.render({ canvasContext: ctx, viewport: renderViewport }).promise;
          if (renderTokenRef.current !== myToken) return;
        }

        const textLayerDiv = document.createElement("div");
        textLayerDiv.className = "textLayer";
        pageWrapper.appendChild(textLayerDiv);
        try {
          const textLayer = new pdfjsLib.TextLayer({
            textContentSource: page.streamTextContent(),
            container: textLayerDiv,
            viewport: cssViewport,
          });
          await textLayer.render();
        } catch {
          // テキストレイヤーの描画に失敗しても表示自体は継続する
        }
        if (renderTokenRef.current !== myToken) return;
      }
    };

    // --- ズーム/パン（画像プレビューの実装を参考に、PDF向けに調整） ---
    content.style.transformOrigin = "0 0";
    content.style.willChange = "transform";

    let scale = 1, x = 0, y = 0;

    const applyOverflow = () => { container.style.overflow = scale > 1 ? "hidden" : "auto"; };

    const setTransform = (transition = "none") => {
      content.style.transition = transition;
      content.style.transform = scale === 1 ? "none" : `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
    };

    const reset = (animated = false) => {
      scale = 1; x = 0; y = 0;
      setTransform(animated ? "transform 0.2s ease-out" : "none");
      container.style.cursor = "";
      applyOverflow();
    };

    const checkMovability = () => ({
      canMoveX: content.offsetWidth * scale > container.clientWidth + 1,
      canMoveY: content.offsetHeight * scale > container.clientHeight + 1,
    });

    const snap = (transition = "transform 0.2s ease-out") => {
      if (scale <= 1) { reset(transition !== "none"); return; }
      const cW = container.clientWidth, cH = container.clientHeight;
      const vW = content.offsetWidth * scale, vH = content.offsetHeight * scale;
      x = vW <= cW ? (cW - vW) / 2 : Math.max(cW - vW, Math.min(0, x));
      y = vH <= cH ? 0 : Math.max(cH - vH, Math.min(0, y));
      setTransform(transition);
      container.style.cursor = "grab";
      applyOverflow();
    };

    // container は overflow-auto でスクロールしているため、拡大の基準点を求めるときは
    // クリック位置をビューポート相対ではなく「スクロール量を足したコンテンツ内の絶対座標」に
    // 変換する必要がある（これを忘れると2ページ目以降でズームの中心が1ページ目側にずれる）
    const clientToContentPoint = (clientX: number, clientY: number, rect: DOMRect) => ({
      cx: clientX - rect.left + container.scrollLeft,
      cy: clientY - rect.top + container.scrollTop,
    });

    // ホイールはCtrl併用時のみズーム（トラックパッドのピンチはctrlKey付きのwheelとして届く）。
    // 通常のホイール/2本指スクロールはページ送りのスクロールに使わせる。
    // トラックパッドのピンチは短時間に大量のwheelイベントを発火するため、毎回アンカーを
    // 取り直すと（scrollTopの読み直しなどで）誤差が蓄積してズームの中心が徐々にずれてしまう。
    // タッチのピンチと同じく、一連のジェスチャーが続いている間はジェスチャー開始時に
    // 一度だけ求めたアンカー座標を使い回す
    let wheelSnapTimer: ReturnType<typeof setTimeout> | null = null;
    let wheelAnchor: { cx: number; cy: number } | null = null;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      if (wheelSnapTimer) clearTimeout(wheelSnapTimer);
      const newScale = Math.min(MAX_SCALE, Math.max(1, scale * (1 + (e.deltaY > 0 ? -1 : 1) * 0.15)));
      if (newScale === scale) {
        wheelSnapTimer = setTimeout(() => { snap(); wheelSnapTimer = null; wheelAnchor = null; }, 300);
        return;
      }
      if (!wheelAnchor) {
        const rect = container.getBoundingClientRect();
        wheelAnchor = clientToContentPoint(e.clientX, e.clientY, rect);
      }
      const bx = (wheelAnchor.cx - x) / scale, by = (wheelAnchor.cy - y) / scale;
      scale = newScale;
      x = wheelAnchor.cx - bx * scale; y = wheelAnchor.cy - by * scale;
      setTransform("transform 0.05s ease-out");
      applyOverflow();
      wheelSnapTimer = setTimeout(() => { snap(); wheelSnapTimer = null; wheelAnchor = null; }, 300);
    };

    // マウスドラッグ：等倍のときは何もしない＝テキスト選択をブラウザ標準のまま使える
    let isDragging = false;
    let dragStartMouseX = 0, dragStartMouseY = 0, dragStartX = 0, dragStartY = 0;
    let move = { canMoveX: false, canMoveY: false };

    const onMouseDown = (e: MouseEvent) => {
      if (scale <= 1) return;
      e.preventDefault();
      move = checkMovability();
      isDragging = true;
      dragStartMouseX = e.clientX; dragStartMouseY = e.clientY;
      dragStartX = x; dragStartY = y;
      container.style.cursor = "grabbing";
      content.style.transition = "none";
    };
    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      e.preventDefault();
      let dx = e.clientX - dragStartMouseX, dy = e.clientY - dragStartMouseY;
      if (!move.canMoveX) dx = 0;
      if (!move.canMoveY) dy = 0;
      x = dragStartX + dx; y = dragStartY + dy;
      setTransform();
    };
    const onMouseUp = () => {
      if (isDragging) { isDragging = false; container.style.cursor = "grab"; snap("transform 0.1s ease-out"); }
    };

    // タッチ：ピンチは常にズームとして扱う。単指ドラッグは「既にズーム済み」のときだけ
    // パンとして扱い、等倍時はネイティブのスクロール／長押しテキスト選択を邪魔しない
    let isPinching = false;
    let pinchStartDist = 0, pinchStartScale = 1, pinchAnchorX = 0, pinchAnchorY = 0;
    let pinchRect: DOMRect | null = null;
    let singleTouching = false;
    let lastTouchX = 0, lastTouchY = 0;

    const getTouchDist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const getTouchMid = (t: TouchList) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        isPinching = true; singleTouching = false;
        pinchRect = container.getBoundingClientRect();
        const mid = getTouchMid(e.touches);
        const { cx, cy } = clientToContentPoint(mid.x, mid.y, pinchRect);
        pinchStartDist = getTouchDist(e.touches);
        pinchStartScale = scale;
        pinchAnchorX = (cx - x) / scale;
        pinchAnchorY = (cy - y) / scale;
        content.style.transition = "none";
      } else if (e.touches.length === 1 && !isPinching && scale > 1) {
        e.preventDefault();
        singleTouching = true;
        move = checkMovability();
        lastTouchX = e.touches[0].clientX; lastTouchY = e.touches[0].clientY;
        content.style.transition = "none";
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2 && isPinching && pinchRect) {
        if (e.cancelable) e.preventDefault();
        const currentDist = getTouchDist(e.touches);
        const currentMid = getTouchMid(e.touches);
        const { cx, cy } = clientToContentPoint(currentMid.x, currentMid.y, pinchRect);
        scale = Math.min(MAX_SCALE, Math.max(1, pinchStartScale * currentDist / pinchStartDist));
        x = cx - pinchAnchorX * scale;
        y = cy - pinchAnchorY * scale;
        setTransform();
        applyOverflow();
      } else if (e.touches.length === 1 && singleTouching && !isPinching && scale > 1) {
        if (e.cancelable) e.preventDefault();
        let dx = e.touches[0].clientX - lastTouchX, dy = e.touches[0].clientY - lastTouchY;
        if (!move.canMoveX) dx = 0;
        if (!move.canMoveY) dy = 0;
        x += dx; y += dy;
        lastTouchX = e.touches[0].clientX; lastTouchY = e.touches[0].clientY;
        setTransform();
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) isPinching = false;
      if (e.touches.length === 1 && !isPinching && scale > 1) {
        singleTouching = true;
        move = checkMovability();
        lastTouchX = e.touches[0].clientX; lastTouchY = e.touches[0].clientY;
      } else if (e.touches.length === 0) {
        singleTouching = false;
        snap();
      }
    };

    container.addEventListener("wheel", onWheel, { passive: false });
    container.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    container.addEventListener("touchstart", onTouchStart, { passive: false });
    container.addEventListener("touchmove", onTouchMove, { passive: false });
    container.addEventListener("touchend", onTouchEnd);

    // --- リサイズ（回転含む）：ズームを解除してから幅に合わせて再描画 ---
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRender = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => { reset(false); renderAll(); }, 100);
    };
    // ResizeObserver は observe() 開始直後に一度必ず発火するため、
    // それを初回描画のトリガーとして使う（明示的な初回呼び出しは不要）
    const ro = new ResizeObserver(scheduleRender);
    ro.observe(container);

    return () => {
      ro.disconnect();
      if (debounceTimer) clearTimeout(debounceTimer);
      if (wheelSnapTimer) clearTimeout(wheelSnapTimer);
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchMove);
      container.removeEventListener("touchend", onTouchEnd);
    };
  }, [status]);

  return (
    <div ref={containerRef} className="w-full h-full overflow-auto bg-[#525659]">
      {status === "loading" && (
        <div className="w-full h-full flex items-center justify-center text-gray-300 text-sm">読み込み中...</div>
      )}
      {status === "error" && (
        <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-gray-300 text-sm p-4 text-center">
          <span>{filename} を表示できませんでした</span>
        </div>
      )}
      <div ref={pagesContainerRef} className={status === "ready" ? "py-2" : "hidden"} />
    </div>
  );
}
