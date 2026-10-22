// Cloudflare Worker の入り口。OpenNext が作る Worker（.open-next/worker.js）をそのまま使い、
// 定期実行（scheduled）だけを足す（OpenNext の「カスタム Worker」の書き方）。
// .open-next/worker.js はビルドしたときにできるので、このファイルは型チェック（tsc）の対象から外してある。
// 処理の中身は型チェックされる app/lib/backfill.ts に置き、ここは呼ぶだけにする
// @ts-expect-error -- ビルドしたときにできるファイル
import { default as handler } from "./.open-next/worker.js";
import { runBackfill } from "./app/lib/backfill";

type Env = CloudflareEnv & { TOKEN_ENCRYPTION_KEY?: string };
type ScheduledCtx = { waitUntil: (p: Promise<unknown>) => void };

const worker = {
  fetch: handler.fetch,
  // 二度と Re:Mail を開かない利用者の行も、D1 で平文のまま残らないよう置き換える（wrangler.json の triggers.crons）
  async scheduled(_event: unknown, env: Env, ctx: ScheduledCtx) {
    // 暗号化の鍵は process.env から読むので、定期実行のときも入れておく（リクエストのときは OpenNext が入れる）
    if (env.TOKEN_ENCRYPTION_KEY && !process.env.TOKEN_ENCRYPTION_KEY) process.env.TOKEN_ENCRYPTION_KEY = env.TOKEN_ENCRYPTION_KEY;
    ctx.waitUntil(runBackfill(env.DB));
  },
};

export default worker;

// OpenNext が使う Durable Object のクラスも、そのまま出しておく（出さないとデプロイが失敗する）
// @ts-expect-error -- ビルドしたときにできるファイル
export { DOQueueHandler, DOShardedTagCache, BucketCachePurge } from "./.open-next/worker.js";
