# リモート環境でログインして動作確認する（ユーザーがする操作）

Claude Code のリモート環境（クラウド）で、Claude がテスト用の Google アカウントにログインした Re:Mail を Playwright で開き、画面を確かめられるようにするための手順。スマホだけでもできる。
Claude 側の決まりは `docs/claude/browser.md`。

> **トークンや Client secret をチャットに貼らない。** 値は必ず環境の設定（環境変数）に入れる。

## しくみ
- Google のログイン画面は自動では通れない。そこで、Google の「リフレッシュトークン」（Gmail に入り続けるための鍵）を環境変数に入れておき、リモート環境ではそこからログイン済みの状態を作る。
- 画面に実際のメールが出て、Claude もそれを見る。**テスト用の Google アカウントを使う。**

---

## A. 最初に1回だけ
### A-1. テスト用の Google アカウントを2つ用意する
普段使っていないアカウントを2つ作るか、選ぶ。1つ目で Re:Mail を確かめ、2つ目は送受信の相手にする（2つ目は無くても、送受信の往復以外は確かめられる）。
Claude はこの2つのあいだでしか送信しない（ほかの宛先への送信は確認用スクリプトが止める）。

### A-2. いつもの OAuth クライアントに戻り先を1つ足す（Google Cloud。スマホのブラウザでも可）
本番・ローカル開発と同じ OAuth クライアントを共通で使う。
1. https://console.cloud.google.com を開き、Re:Mail のプロジェクトを選ぶ。
2. 「API とサービス」→「認証情報」→ Re:Mail で使っている「OAuth 2.0 クライアント ID」を開く。
3. 「承認済みのリダイレクト URI」に `https://developers.google.com/oauthplayground` を足して保存する（スマホで取るときに使う）。
4. 同意画面が「テスト中」なら、「対象」（または「OAuth 同意画面」）の「テストユーザー」に A-1 の**2つとも**足す。

### A-3. 環境変数を入れる（1回目）
セッション画面のタイトルバーにある環境のメニュー →「Edit」→ 環境変数に入れる（スマホのアプリに出ないときは、ブラウザで claude.ai/code を開く）。
```
GOOGLE_CLIENT_ID=（.dev.vars・本番と同じ値）
GOOGLE_CLIENT_SECRET=（.dev.vars・本番と同じ値）
RE_MAIL_TEST_EMAIL=（A-1 の1つ目のアドレス）
RE_MAIL_TEST_REFRESH_TOKEN=（B で1つ目の分を取る）
RE_MAIL_TEST_EMAIL_2=（A-1 の2つ目のアドレス）
RE_MAIL_TEST_REFRESH_TOKEN_2=（B で2つ目の分を取る）
```
`AUTH_SECRET`・`TOKEN_ENCRYPTION_KEY` は入れなくてよい（リモート環境の中で作る）。
スマホの Playground でもクライアント シークレットを入れるので、パスワード管理アプリなどに控えておく。

---

## B. トークンを取る（最初と、切れたとき）
同意画面が「テスト中」だと、トークンは**7日で切れる**。Claude が「login: 失敗」と言ったら取り直す。

### B-1. スマホ（または PC）のブラウザで取る：OAuth 2.0 Playground
1. https://developers.google.com/oauthplayground を開く（スマホは横向きか「PC 版サイト」にすると押しやすい）。
2. 右上の歯車（OAuth 2.0 configuration）を開く。
   - 「Use your own OAuth credentials」にチェック → いつものクライアント ID とシークレット（A-3 と同じ値）を入れる。
   - 「Access type」は **Offline**、「Force prompt」は **Consent Screen** にする。
   - 閉じる。
3. 左の「Step 1」の一番下の入力欄（Input your own scopes）に、次をそのまま入れて「Authorize APIs」。
   ```
   openid email profile https://www.googleapis.com/auth/gmail.modify
   ```
   （Re:Mail と同じ権限。これ以外を足さない）
4. **テスト用アカウント**を選び、許可する（「このアプリは確認されていません」と出たら「詳細」→「移動」）。
5. 「Step 2」で「Exchange authorization code for tokens」を押す。
6. 出てきた **Refresh token** をコピーし、A-3 の `RE_MAIL_TEST_REFRESH_TOKEN` に入れて保存する。
7. **2つ目のアカウントの分**は、3〜6 をもう一度行い、4 で2つ目を選び、6 で `RE_MAIL_TEST_REFRESH_TOKEN_2` に入れる。
   アカウントを選ぶ画面が出ずに1つ目で進んでしまうときは、ブラウザのシークレット（プライベート）タブで 1 からやり直す。
8. Playground の歯車に入れたシークレットは、ブラウザを閉じれば残らない。気になるなら Playground のページを閉じる。

### B-2. PC で取る（別の方法）
リポジトリの直下で、ローカルの `next dev` を止めてから実行する（`.dev.vars` のクライアントを使う）。値はターミナルに出るだけで、ファイルには残らない。
```
node script/browser/get-refresh-token.mjs              # 1つ目
node script/browser/get-refresh-token.mjs --account=2  # 2つ目（名前に _2 が付いて出る）
```
出てきた値を A-3 の環境変数に入れる。

---

## C. 毎回の使い方
1. 環境変数を変えたら、**新しいセッションを始める**（動いているセッションには反映されない）。
2. Claude に頼む。例：
   - 「ログインして、トップ画面を PC とスマホで確認して」
   - 「〇〇を直したので、ログインして△△の画面で動くか確かめて」
3. Claude は `script/browser/dev.sh` で起動し、`check.mjs --login` などで確かめる。push の前には、本番と同じ Workers の形（`dev.sh --preview`）でも確かめる。確認が通ったら `main` に push して本番に反映し、結果を報告する（確認が通らなければ push しない）。
4. 送受信の確認の頼み方の例：
   - 「1つ目から2つ目に、Cc 付き・添付付きで送って、2つ目に届いた中身を確かめて」
   - 「2つ目のメールに1つ目から返信して、同じスレッドにつながるか確かめて」
   - 「純正 Gmail で同じ操作をしたときと、ヘッダーを見比べて」（純正側は、自分でスマホの Gmail アプリから2つ目あてに送っておく）
   Claude は件名に `[re-mail-test]` を付けて送り、2つ目の Gmail を API で直接読んで、宛先・件名・スレッド・添付・文字コードを報告する。

## D. 困ったとき
| 症状 | すること |
| --- | --- |
| Claude が「login: 失敗（RefreshAccessTokenError）」 | B でトークンを取り直し、新しいセッションで頼む |
| 何度取り直しても失敗する | `GOOGLE_CLIENT_ID`/`SECRET` が `.dev.vars`・Playground に入れたものと同じか確かめる。A-2 の 4（テストユーザー）を確かめる |
| Playground で「redirect_uri_mismatch」 | A-2 の 3 のリダイレクト URI が入っているか確かめる |
| Claude が「RE_MAIL_TEST_… がありません」 | A-3 の環境変数の名前を確かめ、新しいセッションを始める |
| Claude が「login(2): 失敗」 | 2つ目の分だけ B-1 の 7 で取り直す |
| テスト用アカウントの受信箱が `[re-mail-test]` で埋まった | 純正 Gmail で `subject:[re-mail-test]` を検索してまとめて削除する |

## E. やめるとき
- https://myaccount.google.com/permissions をテスト用アカウントで開き、Re:Mail のアクセスを削除する（トークンが無効になる）。
- 環境変数の `RE_MAIL_TEST_REFRESH_TOKEN`（と `_2`）を消す。不要なら A-2 で足したリダイレクト URI を外す。
