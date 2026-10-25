import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
import { SECURITY_HEADERS } from "./app/lib/securityHeaders";

const nextConfig: NextConfig = {
  // next dev が CLAUDE.md に Next.js 向けの文を書き足すのを止める（CLAUDE.md は手で管理する）
  agentRules: false,
  // 型チェックは CI で npx tsc --noEmit として別に行うので、ビルドでは止めない
  // （Next.js 16 で eslint の設定はなくなった。Lint も CI で npm run lint として別に行う）
  typescript: {
    ignoreBuildErrors: true,
  },
  // ページ全体にセキュリティヘッダーを付ける（中身と理由は app/lib/securityHeaders.ts）。
  // CSP はここでは付けず worker.ts で付ける（ここに入れると nonce が消える。理由は securityHeaders.ts）。
  // 開発サーバー（next dev）では付けない（本番と同じにするのは本番のビルドだけ）
  async headers() {
    if (process.env.NODE_ENV !== "production") return [];
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;

// next dev でも getCloudflareContext() から D1 などのバインディングを使えるようにする
initOpenNextCloudflareForDev();
