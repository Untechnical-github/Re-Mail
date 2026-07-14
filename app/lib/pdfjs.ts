let pdfjsPromise: Promise<typeof import("pdfjs-dist")> | null = null;

// pdf.js 本体と Worker の初期化をまとめて行う（ブラウザでのみ呼び出す想定）。
// ブラウザの標準PDFビューア（iframe + data URL）に頼ると、Android Chromeでは
// そもそも表示できず、iOS Safariでは拡大された状態で開かれてしまうため、
// pdf.js でキャンバスに自前描画することで全ブラウザで挙動を統一する。
export function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist").then((pdfjsLib) => {
      pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.min.mjs",
        import.meta.url
      ).toString();
      return pdfjsLib;
    });
  }
  return pdfjsPromise;
}
