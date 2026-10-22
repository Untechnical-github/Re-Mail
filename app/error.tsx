"use client";
// 画面のどこかで例外が起きたときに出す画面（エラーバウンダリ）。真っ白な画面や「This page couldn't load」で止めず、
// 何が起きたかと、次にできること（読み込み直す・純正 Gmail で開く）を出す（絶対ルール3）
import { useEffect } from "react";
import { logError } from "./lib/safeLog";
import { gmailOpenUrl } from "./lib/gmailLink";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // エラーの中身（メッセージ）は個人情報を含みうるので、safeLog が種類だけを残す
    logError("ui.errorBoundary", {}, error);
  }, [error]);

  return (
    <div className="flex h-[100dvh] w-full items-center justify-center bg-[#313338] p-4 text-gray-200">
      <div role="alert" className="w-full max-w-sm rounded-lg border border-[#1E1F22] bg-[#2B2D31] p-6 text-center shadow-2xl">
        <h1 className="mb-2 text-lg font-bold text-white">画面の表示で問題が起きました</h1>
        <p className="mb-5 text-sm leading-relaxed text-gray-300">
          読み込み直すと直ることがあります。急ぎのメールは、純正の Gmail で確認・送信できます。
        </p>
        <div className="flex flex-col gap-2">
          <button onClick={() => reset()} className="rounded bg-[#5865F2] px-4 py-2 text-sm font-bold text-white hover:bg-[#4752C4]">
            もう一度表示する
          </button>
          <button onClick={() => window.location.reload()} className="rounded bg-[#4E5058] px-4 py-2 text-sm font-bold text-white hover:bg-[#6D6F78]">
            ページを読み込み直す
          </button>
          <a href={gmailOpenUrl()} target="_blank" rel="noopener noreferrer" className="px-4 py-2 text-sm text-[#5865F2] hover:underline">
            純正 Gmail で開く
          </a>
        </div>
      </div>
    </div>
  );
}
