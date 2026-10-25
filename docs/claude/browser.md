# ブラウザでの確認（Claude Code のリモート環境・Playwright。画面の確認・送受信の確認をするときだけ読む）

Playwright と Chromium はリモート環境に入っている（`require("playwright")` で使える。依存には足さない）。
ユーザー向けの手順（トークンの取り方など）は `docs/remote-browser-check.md`。

## 使い方
1. `script/browser/dev.sh` … ローカル D1 に migrations を当てて `next dev`（http://localhost:3000）を裏で起動する。止めるのは `script/browser/dev.sh stop`。
   - `script/browser/dev.sh --preview` … 本番と同じ Workers の形（OpenNext でビルドして `wrangler dev`、http://localhost:8787）。CSP・セキュリティヘッダー・`worker.ts` が本番と同じになる。ビルドに30秒ほどかかり、コードを変えたら起動し直す。
   - 普段は `next dev` で作り、**push の前の最後の確認は `--preview` で行う**（CSP 違反はコンソールのエラーとして `check.mjs` に出る）。
2. `node script/browser/check.mjs [URL] [--mobile] [--login[=2]] [--wait=ミリ秒]` … `.playwright/` にスクリーンショット、標準出力にログインの成否・コンソールのエラー・止めた外部通信を出す。
3. 操作を伴う確認は、その場でスクリプトを書く（scratchpad に置く）。ページは必ず `session.mjs` の `openTestPage(browser, url, { account: 1 | 2, mobile })` で作る
   （ログインの Cookie・外部通信の遮断・**テスト用アカウント以外への送信の遮断**が付く）。`page.route` を自分で足すときは `route.fallback()` で後ろに回す。
4. `node script/browser/gmail-inspect.mjs --account=2 --q='subject:"[re-mail-test]" newer_than:1h' [--body]` … Gmail を API で直接読み、ヘッダー・スレッド・MIME の各部分を出す（読むだけ）。

## ログイン
- 環境変数（ユーザーが入れる。Claude は値を見ない・出力しない・会話で聞かない）：
  `GOOGLE_CLIENT_ID` `GOOGLE_CLIENT_SECRET`（本番・ローカル開発と共通） `RE_MAIL_TEST_EMAIL` `RE_MAIL_TEST_REFRESH_TOKEN`、2つ目は末尾に `_2`。
- `AUTH_SECRET` と `TOKEN_ENCRYPTION_KEY` は要らない（`dev.sh` がこの環境の中だけの鍵を作る）。
- `login: 失敗` が出たら、ユーザーに `docs/remote-browser-check.md` の B で取り直してもらう（値をチャットで受け取らない）。

## 送受信の確認
- 送ってよいのは、テスト用アカウントの1つ目と2つ目のあいだだけ。件名の先頭に `[re-mail-test]` を付ける。
- 送信は1回の操作につき1回。結果が分からなくても自動でやり直さない（絶対ルール2）。`gmail-inspect.mjs` で届いたかを確かめる。
- 確かめること：To/Cc/Bcc・From・件名・`threadId`・返信の `In-Reply-To`/`References`・添付（名前・種類・大きさ）・文字コード・署名・引用。
- 純正 Gmail との見比べは、ユーザーに同じ内容を純正から送ってもらい、両方を `gmail-inspect.mjs` で出して並べる。
- 本文を出す（`--body`）のはテスト用のメールだけ。結果の報告にも本文を長く貼らない。

## 確認の後
- 画面・送受信に関わる変更は、ここで確認が通ってから `main` に push する（ユーザーの了承済み）。確かめられなかったことは報告に書く。
