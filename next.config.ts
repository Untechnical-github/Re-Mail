import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const nextConfig: NextConfig = {
  // 型チェックは CI で npx tsc --noEmit として別に行うので、ビルドでは止めない
  // （Next.js 16 で eslint の設定はなくなった。Lint も CI で npm run lint として別に行う）
  typescript: {
    ignoreBuildErrors: true,
  },
};

export default nextConfig;

// next dev でも getCloudflareContext() から D1 などのバインディングを使えるようにする
initOpenNextCloudflareForDev();
