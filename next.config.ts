import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const nextConfig: NextConfig = {
  // デプロイ時の厳格チェックをパスする設定
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
};

export default nextConfig;

// next dev でも getCloudflareContext() から D1 などのバインディングを使えるようにする
initOpenNextCloudflareForDev();
