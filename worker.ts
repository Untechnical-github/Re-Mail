// Cloudflare Worker の入り口。OpenNext が作る Worker（.open-next/worker.js）をそのまま使い、
// ページのスクリプトに付ける nonce の処理だけを足す（OpenNext の「カスタム Worker」の書き方）。
// .open-next/worker.js はビルドしたときにできるので、このファイルは型チェック（tsc）の対象から外してある。
// 処理の中身は型チェックされる app/lib/securityHeaders.ts に置き、ここは呼ぶだけにする
// @ts-expect-error -- ビルドしたときにできるファイル
import { default as handler } from "./.open-next/worker.js";
import { generateNonce, withNonceRequest, withNonceResponse } from "./app/lib/securityHeaders";

type Ctx = { waitUntil: (p: Promise<unknown>) => void };

const worker = {
  // ページのスクリプトに付ける nonce を毎回作り、Next.js に渡して、同じ nonce の CSP を HTML の応答に付ける
  // （CSP の script-src から 'unsafe-inline' を外すため。中身は app/lib/securityHeaders.ts）
  async fetch(request: Request, env: CloudflareEnv, ctx: Ctx) {
    const nonce = generateNonce();
    const res = await handler.fetch(withNonceRequest(request, nonce), env, ctx);
    return withNonceResponse(res, nonce);
  },
};

export default worker;

// OpenNext が使う Durable Object のクラスも、そのまま出しておく（出さないとデプロイが失敗する）
// @ts-expect-error -- ビルドしたときにできるファイル
export { DOQueueHandler, DOShardedTagCache, BucketCachePurge } from "./.open-next/worker.js";
