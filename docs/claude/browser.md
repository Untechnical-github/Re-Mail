# ブラウザでの確認（Claude Code のリモート環境・Playwright。画面の確認をするときだけ読む）

Playwright と Chromium はリモート環境に入っている（`require("playwright")` で使える。依存には足さない）。

## 使い方
1. `script/browser/dev.sh` … ローカル D1 に migrations を当てて `next dev` を裏で起動する。止めるのは `script/browser/dev.sh stop`。
2. `node script/browser/check.mjs [URL] [--mobile] [--login] [--wait=ミリ秒]` … `.playwright/` にスクリーンショット、標準出力にコンソールのエラーと止めた外部通信を出す。
   - `--login` でテスト用アカウントにログインした状態で開く。一覧の読み込みを待つなら `--wait=5000` など。
3. 込み入った操作は、その場でスクリプトを書く：`import { addLoginCookie } from "./session.mjs"` で `context` に Cookie を入れてから `page.goto`。
   スクリプトは scratchpad に置き、`.playwright/` 以外に結果を残さない。

## ログインのしくみ
- Google のログイン画面は自動で通れないので、環境変数のリフレッシュトークンから NextAuth の Cookie を作る（`session.mjs`）。
- 要る環境変数（リモート環境の設定で、ユーザーが入れる。Claude は値を見ない・出力しない・会話で聞かない）：
  `GOOGLE_CLIENT_ID` `GOOGLE_CLIENT_SECRET`（ローカル開発と同じ値） `RE_MAIL_TEST_EMAIL` `RE_MAIL_TEST_REFRESH_TOKEN`
- `AUTH_SECRET` と `TOKEN_ENCRYPTION_KEY` は入れなくてよい（`dev.sh` がこの環境の中だけの鍵を作る）。
- トークンはユーザーが取る（スマホなら OAuth 2.0 Playground、PC なら `get-refresh-token.mjs`）。ユーザー向けの手順は `docs/remote-browser-check.md`。`check.mjs --login` が `login: 失敗` を出したら、その手順の B で取り直してもらうよう伝える（値をチャットで受け取らない）。
- 実際のメールが画面に出るので、**テスト用の Google アカウントを使う**。送信の確認は、テスト用アカウントから自分自身か別のテスト用アカウントあてに送る。
- Google Cloud の OAuth 同意画面が「テスト中」だと、リフレッシュトークンは7日で切れる。`invalid_grant` が出たら取り直してもらう。
