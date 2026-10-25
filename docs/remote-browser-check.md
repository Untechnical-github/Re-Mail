# リモート環境でログインして動作確認する（ユーザーがする操作）

Claude Code のリモート環境（クラウド）で、Claude がテスト用の Google アカウントにログインした Re:Mail を Playwright で開き、画面を確かめられるようにするための手順。スマホだけでもできる。
Claude 側の決まりは `docs/claude/browser.md`。

> **トークンや Client secret をチャットに貼らない。** 値は必ず環境の設定（環境変数）に入れる。

## しくみ
- Google のログイン画面は自動では通れない。そこで、Google の「リフレッシュトークン」（Gmail に入り続けるための鍵）を環境変数に入れておき、リモート環境ではそこからログイン済みの状態を作る。
- 画面に実際のメールが出て、Claude もそれを見る。**テスト用の Google アカウントを使う。**

---

## A. 最初に1回だけ
### A-1. テスト用の Google アカウントを用意する
普段使っていないアカウントを作るか、選ぶ。送信の確認にも使うので、何通か適当なメールを入れておくと確かめやすい。

### A-2. 確認用の OAuth クライアントを作る（Google Cloud。スマホのブラウザでも可）
本番やローカル開発のクライアントには手を付けず、確認用を別に作る（漏れても本番に響かない）。
1. https://console.cloud.google.com を開き、Re:Mail のプロジェクトを選ぶ。
2. 「API とサービス」→「認証情報」→「認証情報を作成」→「OAuth クライアント ID」。
3. 種類は「ウェブ アプリケーション」、名前は「Re:Mail リモート確認用」など。
4. 「承認済みのリダイレクト URI」に次の2つを足す。
   - `https://developers.google.com/oauthplayground` （スマホで取るとき）
   - `http://localhost:3000/api/auth/callback/google` （PC のスクリプトで取るとき）
5. 作成すると「クライアント ID」と「クライアント シークレット」が出る。**シークレットは後から見られないことがある**ので、パスワード管理アプリなどに保存する。
6. 同意画面が「テスト中」なら、「対象」（または「OAuth 同意画面」）の「テストユーザー」に A-1 のアカウントを足す。

### A-3. 環境変数を入れる（1回目）
セッション画面のタイトルバーにある環境のメニュー →「Edit」→ 環境変数に入れる（スマホのアプリに出ないときは、ブラウザで claude.ai/code を開く）。
```
GOOGLE_CLIENT_ID=（A-2 のクライアント ID）
GOOGLE_CLIENT_SECRET=（A-2 のクライアント シークレット）
RE_MAIL_TEST_EMAIL=（A-1 のアドレス）
RE_MAIL_TEST_REFRESH_TOKEN=（B で取る）
```
`AUTH_SECRET`・`TOKEN_ENCRYPTION_KEY` は入れなくてよい（リモート環境の中で作る）。

---

## B. トークンを取る（最初と、切れたとき）
同意画面が「テスト中」だと、トークンは**7日で切れる**。Claude が「login: 失敗」と言ったら取り直す。

### B-1. スマホ（または PC）のブラウザで取る：OAuth 2.0 Playground
1. https://developers.google.com/oauthplayground を開く（スマホは横向きか「PC 版サイト」にすると押しやすい）。
2. 右上の歯車（OAuth 2.0 configuration）を開く。
   - 「Use your own OAuth credentials」にチェック → A-2 のクライアント ID とシークレットを入れる。
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
7. Playground の歯車に入れたシークレットは、ブラウザを閉じれば残らない。気になるなら Playground のページを閉じる。

### B-2. PC で取る（別の方法）
リポジトリの直下で、ローカルの `next dev` を止めてから実行する。値はターミナルに出るだけで、ファイルには残らない。
```
GOOGLE_CLIENT_ID=（A-2 の ID） GOOGLE_CLIENT_SECRET=（A-2 のシークレット） node script/browser/get-refresh-token.mjs
```
（環境変数を付けないと `.dev.vars` のクライアントで取る。その場合、A-3 の `GOOGLE_CLIENT_ID`/`SECRET` も `.dev.vars` と同じにしないと「login: 失敗」になる。**トークンを取ったクライアントと、環境変数のクライアントは必ず同じにする**）

---

## C. 毎回の使い方
1. 環境変数を変えたら、**新しいセッションを始める**（動いているセッションには反映されない）。
2. Claude に頼む。例：
   - 「ログインして、トップ画面を PC とスマホで確認して」
   - 「〇〇を直したので、ログインして△△の画面で動くか確かめて」
3. Claude は `script/browser/dev.sh` で起動し、`check.mjs --login` などで確かめて、スクリーンショットで結果を返す。
4. 送信を確かめてもらうときは、宛先を**テスト用アカウント自身**にするよう伝える。届いたメールは、純正 Gmail（テスト用アカウント）でも開いて見比べる。

## D. 困ったとき
| 症状 | すること |
| --- | --- |
| Claude が「login: 失敗（RefreshAccessTokenError）」 | B でトークンを取り直し、新しいセッションで頼む |
| 何度取り直しても失敗する | `GOOGLE_CLIENT_ID` がトークンを取ったクライアントと同じか確かめる。A-2 の 6（テストユーザー）を確かめる |
| Playground で「redirect_uri_mismatch」 | A-2 の 4 のリダイレクト URI が入っているか確かめる |
| Claude が「RE_MAIL_TEST_… がありません」 | A-3 の環境変数の名前を確かめ、新しいセッションを始める |

## E. やめるとき
- https://myaccount.google.com/permissions をテスト用アカウントで開き、確認用のアプリのアクセスを削除する（トークンが無効になる）。
- 環境変数の `RE_MAIL_TEST_REFRESH_TOKEN` を消す。不要なら A-2 の OAuth クライアントも削除する。
