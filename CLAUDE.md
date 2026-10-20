# Re:Mail

Gmail をチャット風 UI（相手ごとのトークルーム）で読み書きする Web アプリ。Next.js（App Router）を OpenNext で Cloudflare Workers 上に載せて動かし、設定は D1 に保存する。自前サーバーは持たず、費用はドメイン代と Workers の有料プランだけにする方針。仕組みの詳細はコードを直接読む（中核ロジックは `app/hooks/useMailApp.ts`、純粋関数は `app/lib/`）。

## Git の運用ルール

- ブランチは `main` の1本だけを使う。新しいブランチは作らない。
- コミットは `main` に直接行い、`git push origin main` で push する。
- PR は作らない（頼まれた場合を除く）。
- 作業を始める前に `git pull origin main` で最新の状態にする。
- コミットメッセージは日本語で、何をなぜ変えたかを1行で書く（例：「連携アカウントのリフレッシュトークン更新をD1に書き戻す」）。
- main に push すると、GitHub Actions（`.github/workflows/deploy-worker.yml`）が Worker を自動でデプロイする。手で `wrangler deploy` や `opennextjs-cloudflare deploy` を実行しない。
- push した後は `gh run watch` で結果を確認し、失敗していたら原因を調べて報告する。Worker 以外のファイルだけの push ではワークフローが動かないので、やり直すときは `gh workflow run deploy-worker.yml` か `gh run rerun <ID> --failed` を使う。
- 本番の URL は https://re-mail.eusng90912.workers.dev 。デプロイ後の動作確認（`script/ci/health-check.sh`）に失敗すると、1つ前の版に自動で戻る。

## 触ってはいけないもの

- `.next/` `.open-next/` `.wrangler/` と、Next.js が自動生成する `next-env.d.ts` `types/routes.d.ts` `types/cache-life.d.ts` `types/validator.ts` は手で編集しない。
- `.env.local`・シークレット・API キー・トークンをファイルやコミットに書かない。`wrangler.json` の `database_id` も変えない。
- シークレットの置き場所と現在の一覧（値はどこにも書かない）:
  - Worker 用（`npx wrangler secret put <名前>`）: `AUTH_SECRET` `GOOGLE_CLIENT_ID` `GOOGLE_CLIENT_SECRET` `TOKEN_ENCRYPTION_KEY`
  - GitHub Actions 用（`gh secret set <名前>`）: `CLOUDFLARE_API_TOKEN`（Workers 編集＋D1 編集の権限）`CLOUDFLARE_ACCOUNT_ID`
  - この環境の wrangler は本番の認証が通らないので、Claude はシークレットを登録・変更できない。新しい環境変数やシークレットが要る変更では、push する前に、登録してほしい名前とコマンドをユーザーに伝えて登録してもらう（登録前にデプロイすると動作確認に失敗して前の版に戻る）。
- `TOKEN_ENCRYPTION_KEY` を変える・消す前提のコードを書かない。D1 の暗号化済みトークン（`encv1:` 始まり）が復号できなくなり、連携アカウントが全滅する。
- メール本文を表示する iframe の `sandbox` に `allow-scripts` を足さない。メール内のスクリプトが実行され XSS になる。

## D1（データベース）のルール

- スキーマは `migrations/` の連番ファイル（`0002_xxx.sql` …）で管理し、デプロイ時に GitHub Actions が `wrangler d1 migrations apply` で本番に当てる。適用済みのファイルは書き換えず、変更は必ず新しいファイルとして足す。
- スキーマ変更は非破壊にする。`DROP TABLE` を書かない。列の追加は `ALTER TABLE ... ADD COLUMN` で行う。新しいコードより先にスキーマが当たるので、古いコード（ロールバック先）が壊れない変更にする。
- この環境からは本番 D1 を直接操作しない（ローカルの wrangler は本番の認証が通らない）。スキーマ変更は migrations ファイルを足して push し、Actions に当てさせる。
- `chat_configs` の `account_email` が空文字 `""` の行は、`__GLOBAL_SETTINGS__` / `__KNOWN_BOXES__` 用に予約している。
- `linked_accounts` のトークンは必ず `app/lib/tokenCrypto.ts` の `encryptSecret` / `decryptSecret` を通して読み書きする。

## コードの約束

- API ルートに `export const runtime = 'edge'` を書かない（OpenNext が対応していない）。D1 などのバインディングは `@opennextjs/cloudflare` の `getCloudflareContext().env` から取る。Node 専用 API は `nodejs_compat` で動く範囲に限り、なるべく fetch・Web Crypto・TextEncoder などの Web 標準で書く。
- roomKey（アカウント＋相手の複合キー）の組み立て・分解は `app/lib/roomKey.ts` の `encodeRoomKey` / `decodeRoomKey` だけで行う。区切り文字を直接 `split` しない。D1 の `chat_id` はローカルキー、画面の state は複合キー、と使い分ける。
- チャットは連携アカウントごとに分離する。同じ相手でもアカウントが違えば別チャット。ピン留め・非表示・永続データの処理でアカウントを取り違えない。
- 「自分が送ったメールか」の判定は共通の `isMineEmail`（アドレス完全一致）を使う。`.includes` で部分一致させない。
- Gmail API の呼び出しは `fetchWithRetry` を通す。アクセストークンは `getValidAccessToken` で取る（リフレッシュの二重実行を防ぐため）。
- 送信直後の仮 ID は `fake-` で始まる。Gmail 側に存在しないので API に渡さない。
- 依存パッケージを増やさない。Workers・D1・R2・Workers AI とドメイン以外にお金のかかるサービスを使わない。
- 理由がないと消されそうな1行には、理由を日本語のコメントで残す（既存コードもその書き方に合わせている）。
- ユーザー操作に関わる失敗は握りつぶさず、トースト（`showErrorToast`）で伝える。`alert()` は使わない。

## 変更したら確認すること

- `npm test`・`npm run lint`・`npx tsc --noEmit` がすべて通ってから push する（3つとも CI でも確認し、失敗するとデプロイされない）。
- Lint のエラーは 0 に保つ。警告も増やさない。ルールをその行だけ外すときは `// eslint-disable-next-line <ルール> -- <理由>` の形で必ず理由を書く。
- `any` を使わない。Gmail・D1・API の応答には型を付ける（メールは `app/types/email.ts` の `Email`、ルームのキーは `RoomKeyStr`）。
- `app/lib/` の純粋関数を変えたら、対応する `*.test.ts` にテストを足す。
- 実際の Google ログインや Gmail の実データが要る動作（送受信・添付・ページング・アカウント連携）は、この環境では確かめられない。変更したら「ユーザーが実機で確認すべき手順」を作業報告に書く。

## よく使うコマンド

- 開発サーバー：`npm run dev`
- テスト：`npm test`
- 型チェック：`npx tsc --noEmit`
- Lint：`npm run lint`
- Workers 用ビルドの確認：`npm run cf-build`（ローカルの Workers 環境で動かすなら `npm run preview`）
- デプロイの手動実行：`gh workflow run deploy-worker.yml`（結果は `gh run watch`）
