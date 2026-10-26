# ブラウザでの確認（PC の Claude Code・`~/remail-e2e`。画面の確認・送受信の確認をするときだけ読む）

**Muse の環境で動いているときは、この文書の手順（Playwright・`~/remail-e2e`・手でログインしたプロファイル）は使えない。ブラウザでの確認はせず、本番で Muse のブラウザで確かめる手順を報告に書く。**

## 場所
- `~/remail-e2e`（`C:\Users\eusng\remail-e2e`）。リポジトリの外にあり、コミットしない。
- Playwright 1.52 と、手でログインした Chrome のプロファイルで**本番**を操作する。
- `profiles/`（ログイン状態）と `results/`（スクリーンショット。個人情報が写る）は共有しない（会話・報告・コミットに出さない）。

## 設定（`config.json`）
- `baseUrl`：本番の URL
- `senderAccount`：Re:Mail にログインする側
- `receiverAccount`：受け取る側
- `allowedRecipients`：送ってよいアドレス

## ログイン
- `node open.mjs sender` / `node open.mjs receiver` でプロファイルを開き、手でログインする。
- ログインが切れたら、同じ手順でやり直してもらうようユーザーに頼む（Claude はパスワードを扱わない）。

## 実行
- `node run.mjs <sender|receiver> steps/<番号>-<名前>.mjs [--show]`
  - 既定は画面なし（headless）。`--show` で画面を出す。
  - スクリーンショットは `results/` に保存される。
- 手順は `export default async ({ context, page, shot, log }) => {}` の形で書き、`steps/` に番号を付けて足す。

## 部品
- `lib/remail.mjs`：Re:Mail の画面操作（`openPartnerChat`・`typeInEditor`・`sendAndWait`・`installSendGuard` など）
- `lib/gmail.mjs`：純正 Gmail の画面操作
- `lib/guard.mjs`：送信先を `config.json` のアドレスだけに限る
- `lib/eml.mjs`：受け取ったメールのソースの読み取り
- 純正 Gmail の操作は、同じ context の2枚目のページ（`context.newPage()`）で行う（例：`steps/73-draft-inbound.mjs`）。

## 送受信の確認
- 送ってよいのは、テスト用の2アカウントの間だけ。件名の先頭に `[re-mail-test]` を付ける。
- 送信は1回の操作につき1回。結果が分からなくても自動でやり直さない（絶対ルール2）。
- 確かめること：To/Cc/Bcc・From・件名・`threadId`・返信の `In-Reply-To`/`References`・添付（名前・種類・大きさ）・文字コード・署名・引用。
- 純正 Gmail との見比べは、同じ内容を純正 Gmail からも送り、受け取った両方のソースを `lib/eml.mjs` で読んで並べる。
- 報告に本文を長く貼らない。

## 確認の時期
- 本番を操作するので、push してデプロイされたあとに確かめる。
- 確かめられなかったことは報告に書く。
