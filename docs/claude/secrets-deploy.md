# シークレット・デプロイの決まり（環境変数・シークレット・デプロイの失敗・本番の確認に触るときだけ読む）

- `.env.local`・`.dev.vars`・シークレット・API キー・トークンの値を、ファイル・コミット・ログに書かない。Claude は値を見ない・保管場所を聞き出さない。
- シークレットの名前（値はどこにも書かない）：
  - Worker 用（`npx wrangler secret put <名前>`）：`AUTH_SECRET` `GOOGLE_CLIENT_ID` `GOOGLE_CLIENT_SECRET` `TOKEN_ENCRYPTION_KEY`
  - GitHub Actions 用（`gh secret set <名前>`）：`CLOUDFLARE_API_TOKEN`（Workers 編集＋D1 編集）`CLOUDFLARE_ACCOUNT_ID`
- この環境の wrangler は本番の認証が通らないので、Claude はシークレットを登録・変更できない。新しい環境変数・シークレットが要る変更では、**push の前に**名前と登録のコマンドをユーザーに伝えて登録してもらう（登録前にデプロイすると動作確認に失敗して前の版に戻る）。
- ローカル開発でも暗号の鍵が要るので、ユーザーが `.dev.vars` に開発用の鍵を入れる。
- デプロイは `.github/workflows/deploy-worker.yml`（`main` への push で、Worker に関係するファイルが変わったときだけ動く）。README など文書だけの push では動かない。やり直すときは `gh workflow run deploy-worker.yml` か `gh run rerun <ID> --failed`。
- 本番：https://re-mail.eusng90912.workers.dev 。デプロイ後の動作確認（`script/ci/health-check.sh`）に失敗すると1つ前の版に自動で戻る。
- 手で `wrangler deploy` / `opennextjs-cloudflare deploy` を実行しない。
- よく使うコマンド：開発 `npm run dev`、Workers 用ビルド `npm run cf-build`、ローカルの Workers 環境 `npm run preview`。
- コミットメッセージには、何をなぜ変えたかを日本語1行で書く。`npm test`・`npm run lint`・`npx tsc --noEmit` は CI でも確かめ、1つでも失敗するとデプロイされない。
