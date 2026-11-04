# シークレット・デプロイの決まり（環境変数・シークレット・デプロイの失敗・本番の確認に触るときだけ読む）

- `.env.local`・`.dev.vars`・シークレット・API キー・トークンの値を、ファイル・コミット・ログに書かない。Claude は値を見ない・保管場所を聞き出さない。
- シークレットの名前（値はどこにも書かない）：
  - Worker 用（`npx wrangler secret put <名前>`）：`AUTH_SECRET` `GOOGLE_CLIENT_ID` `GOOGLE_CLIENT_SECRET` `TOKEN_ENCRYPTION_KEY`
  - GitHub Actions 用（`gh secret set <名前>`）：`CLOUDFLARE_API_TOKEN`（Workers 編集＋D1 編集）`CLOUDFLARE_ACCOUNT_ID`
- 新しい環境変数・シークレットが要る変更では、**push の前に**登録する（後だとデプロイ後の動作確認に失敗して前の版に戻る）。Muse の環境では、ユーザーが共有した Cloudflare API トークンで自分で登録する。トークンが使えない環境では、名前と登録のコマンドをユーザーに伝えて登録してもらう。
- 本番に対して wrangler で行えるのはシークレットの登録・変更（`npx wrangler secret put` など）だけ。既存の `TOKEN_ENCRYPTION_KEY` は上書きしない（変えると D1 のトークンと設定がすべて読めなくなる。変えるときはユーザーが行う）。本番 D1 への `wrangler d1 execute --remote` などの直接操作と `wrangler deploy` はしない（マイグレーションとデプロイは GitHub Actions 経由）。
- トークンは Muse が環境変数 `CLOUDFLARE_API_TOKEN` として先に入れておく。コマンドでは `$CLOUDFLARE_API_TOKEN` を参照するだけで、値をコマンド行に書かない・echo しない・表示しない。トークンが複数の Cloudflare アカウントに触れる場合は、`CLOUDFLARE_ACCOUNT_ID` も環境変数で渡す（値は書かない）。認証エラーで通らないときは、失効している可能性があるので、ユーザーに新しいトークンを頼む。
- ローカル開発でも暗号の鍵が要るので、ユーザーが `.dev.vars` に開発用の鍵を入れる。
- デプロイは `.github/workflows/deploy-worker.yml`（`main` への push で、Worker に関係するファイルが変わったときだけ動く）。README など文書だけの push では動かない。やり直すときは `gh workflow run deploy-worker.yml` か `gh run rerun <ID> --failed`。
- 本番：https://re-mail.eusng90912.workers.dev 。デプロイ後の動作確認（`script/ci/health-check.sh`）に失敗すると1つ前の版に自動で戻る。
- 手で `wrangler deploy` / `opennextjs-cloudflare deploy` を実行しない。
- よく使うコマンド：開発 `npm run dev`、Workers 用ビルド `npm run cf-build`、ローカルの Workers 環境 `npm run preview`。
- コミットメッセージには、何をなぜ変えたかを日本語1行で書く。`npm test`・`npm run lint`・`npx tsc --noEmit` は CI でも確かめ、1つでも失敗するとデプロイされない。
