import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
import { SECURITY_HEADERS } from "./app/lib/securityHeaders";

const nextConfig: NextConfig = {
  // 型チェックは CI で npx tsc --noEmit として別に行うので、ビルドでは止めない
  // （Next.js 16 で eslint の設定はなくなった。Lint も CI で npm run lint として別に行う）
  typescript: {
    ignoreBuildErrors: true,
  },
  // ページ全体にセキュリティヘッダーを付ける（中身と理由は app/lib/securityHeaders.ts）
  // 開発サーバー（next dev）は eval を使うので、この CSP を付けると動かなくなる。本番のビルドだけに付ける
  async headers() {
    if (process.env.NODE_ENV !== "production") return [];
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;

// next dev でも getCloudflareContext() から D1 などのバインディングを使えるようにする
initOpenNextCloudflareForDev();
