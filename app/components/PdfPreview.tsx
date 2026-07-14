import { useEffect, useRef, useState } from "react";
import { loadPdfjs } from "../lib/pdfjs";

// PDFをブラウザ標準ビューアに任せず pdf.js でキャンバスに描画するコンポーネント。
// 常にコンテナの横幅に合わせてレンダリングするため、モーダル幅=PDF幅になり、
// iOS Safariの拡大表示やAndroid Chromeで表示できない問題を回避できる。
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

  // コンテナ幅に合わせて全ページを再描画（初回表示・リサイズ・端末回転のたびに実行）
  useEffect(() => {
    if (status !== "ready" || !pdfRef.current || !containerRef.current || !pagesContainerRef.current) return;

    const renderAll = async () => {
      const myToken = ++renderTokenRef.current;
      const pdf = pdfRef.current;
      const pagesEl = pagesContainerRef.current;
      const containerWidth = containerRef.current?.clientWidth;
      if (!pdf || !pagesEl || !containerWidth) return;

      pagesEl.innerHTML = "";
      const dpr = Math.min(window.devicePixelRatio || 1, 2);

      for (let n = 1; n <= pdf.numPages; n++) {
        if (renderTokenRef.current !== myToken) return;
        const page = await pdf.getPage(n);
        if (renderTokenRef.current !== myToken) return;

        const baseViewport = page.getViewport({ scale: 1 });
        const cssScale = containerWidth / baseViewport.width;
        const viewport = page.getViewport({ scale: cssScale * dpr });

        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        canvas.style.width = "100%";
        canvas.style.height = "auto";
        canvas.style.display = "block";
        if (n > 1) canvas.style.marginTop = "8px";
        pagesEl.appendChild(canvas);

        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        await page.render({ canvasContext: ctx, viewport }).promise;
        if (renderTokenRef.current !== myToken) return;
      }
    };

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRender = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(renderAll, 100);
    };

    const ro = new ResizeObserver(scheduleRender);
    ro.observe(containerRef.current);
    return () => {
      ro.disconnect();
      if (debounceTimer) clearTimeout(debounceTimer);
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
