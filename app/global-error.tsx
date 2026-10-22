"use client";
// レイアウトそのもので例外が起きたときの画面（app/error.tsx では受け止められない場合）。
// このときは layout.tsx も使えないので、html と body をここで書く
import { useEffect } from "react";
import { logError } from "./lib/safeLog";
import { gmailOpenUrl } from "./lib/gmailLink";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    logError("ui.globalErrorBoundary", {}, error);
  }, [error]);

  return (
    <html lang="ja">
      <body style={{ margin: 0, background: "#313338", color: "#e5e7eb", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>
        <div role="alert" style={{ minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div style={{ maxWidth: 360, width: "100%", background: "#2B2D31", border: "1px solid #1E1F22", borderRadius: 8, padding: 24, textAlign: "center" }}>
            <h1 style={{ fontSize: 18, margin: "0 0 8px", color: "#fff" }}>画面の表示で問題が起きました</h1>
            <p style={{ fontSize: 14, lineHeight: 1.6, margin: "0 0 20px" }}>読み込み直すと直ることがあります。急ぎのメールは、純正の Gmail で確認・送信できます。</p>
            <button onClick={() => reset()} style={{ display: "block", width: "100%", padding: "8px 16px", marginBottom: 8, background: "#5865F2", color: "#fff", border: 0, borderRadius: 4, fontWeight: 700, cursor: "pointer" }}>
              もう一度表示する
            </button>
            <button onClick={() => window.location.reload()} style={{ display: "block", width: "100%", padding: "8px 16px", marginBottom: 8, background: "#4E5058", color: "#fff", border: 0, borderRadius: 4, fontWeight: 700, cursor: "pointer" }}>
              ページを読み込み直す
            </button>
            <a href={gmailOpenUrl()} target="_blank" rel="noopener noreferrer" style={{ color: "#5865F2", fontSize: 14 }}>純正 Gmail で開く</a>
          </div>
        </div>
      </body>
    </html>
  );
}
