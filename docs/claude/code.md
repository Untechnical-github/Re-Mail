# コードの約束（複数アカウント・roomKey・設定・送受信のコードに触るときだけ読む）

## ランタイム
- API ルートに `export const runtime = 'edge'` を書かない（OpenNext が対応していない）。D1 などは `@opennextjs/cloudflare` の `getCloudflareContext().env` から取る。Node 専用 API は `nodejs_compat` の範囲に限り、なるべく fetch・Web Crypto・TextEncoder などの Web 標準で書く。

## アカウントとチャット
- roomKey（アカウント＋相手の複合キー）は `roomKey.ts` の `encodeRoomKey` / `decodeRoomKey` だけで組み立て・分解する。区切り文字で直接 `split` しない。D1 の `chat_id` はローカルキー、画面の state は複合キー。
- チャットはアカウントごとに分ける。同じ相手でもアカウントが違えば別チャット。ピン留め・非表示・送信元でアカウントを取り違えない（誤送信元はビジネス上の事故）。
- 複数のアカウントは対等に扱う。画面に「連携」「メイン」の区別を出さない。設定はそのアカウント自身の置き場所に保存する（`configStore.ts` の `openSessionConfigs` / `saveSessionConfig`）。
  - チャットの設定・グループ・フィルターはアカウントごと。フィルターは必ずどれか1つのアカウントのもの（`filterCriteria.accountEmail`）。アカウントの無いフィルターはどのメールにも一致させない。グループもほかのアカウントのメールを混ぜない（`groupEmails.ts`）。
  - 内部ではセッションを持つアカウントが1つあり、ほかは D1 の `linked_accounts`。そのアカウントだけをログアウトするときは、ほかのアカウントにセッションを引き継ぐ（`auth.ts` の jwt コールバックと `linkedAccountsStore.ts` の `promoteLinkedAccount`）。

## 設定
- 新しい設定は2種類のどちらかに足す（端末だけに置かない）。
  - 共通設定（どのアカウントでも同じ）：`syncedSettings.ts` の `SYNCED_SETTING_TYPES` と `COMMON_SETTING_KEYS`、`useMailApp.ts` の `syncedSettings` と `applySyncedSettings`。全アカウントの `__GLOBAL_SETTINGS__` に同じものを書く。
  - アカウント設定：`ACCOUNT_SETTING_TYPES` に足し、`useMailApp.ts` の `setAccountSetting` で保存する。設定画面では「アカウントの設定」の欄に出す。
- 端末に置くのは画面の状態（タブ・スクロール位置）と下書きだけ。新しく置くものはアカウント別のキーにし、`deviceData.ts` の消す対象に足す。

## 送受信
- 「自分のメールか」は `isMineEmail`（アドレス完全一致）。`.includes` で部分一致させない。
- Gmail API の読み取り・ラベル操作は `fetchWithRetry` を通す。**送信は通さない。** アクセストークンは `getValidAccessToken` で取る（リフレッシュの二重実行を防ぐ）。
- 送信直後の仮 ID は `fake-` で始まる。Gmail に無いので API に渡さない。
- Workers AI を使う機能は、本人がオンにしたときだけ動かし、入力も出力も保存・ログしない。AI が書いた文を自動で送らない。
- 返信の件名は元の件名に揃える。受信メールの整形（引用・署名の折りたたみ）は表示上だけにし、元の内容・添付・宛先は必ず辿れるようにする。
- ログ（`safeLog.ts`）に出してよいのは処理名・HTTP ステータス・件数・所要時間・Gmail のエラー理由コードだけ（アドレス・名前・件名・本文・トークン・生レスポンス・リクエストボディは渡さない）。
- 失敗の次の行動は、再試行・再連携・純正 Gmail で開く のどれか。上限を超えた入力は処理を打ち切って生のまま表示する。
- 送信まわりを変えたら、新規・返信・全員に返信・転送・日本語ファイル名の添付を純正 Gmail と Re:Mail の両方から送り、受信側の「メッセージのソースを表示」で比べる手順を報告に書く。

## 速さ・コスト・見た目
- サーバーにメールのキャッシュを作らない。取得済みは `knownIds` で詳細取得を省き、先にキャッシュを表示して裏で差分を取る。最初の表示・スクロールを遅らせない（重いものは遅延読み込み）。1件の変化で一覧全体を再描画・再計算しない。
- 並列取得は今の同時数（アカウント3件・詳細20件）が基準。増やすなら 429 との兼ね合いを確かめる。Gmail API は必要な分だけ（同じ検索を二度撃たない、`fields` / `format` で絞る）。
- R2 は使わない（添付の一時保管も個人情報の保存になる）。D1 の行数・容量を増やさない。
- 新しい色・新しい部品の種類を増やさない。右クリック／長押しのメニューは今は無い（作るなら先にユーザーに確認）。既存の流れ（チャットを開く→読む→返信）を長くしない。PC は2ペイン、モバイルは1画面切替＋ボトムシート。

## 書き方
- `any` を使わない。応答には型を付ける（メールは `app/types/email.ts` の `Email`、ルームのキーは `RoomKeyStr`）。
- 理由がないと消されそうな1行には、理由を日本語のコメントで残す。
- lint の React Compiler 向けの4ルールは誤検知が多いので警告扱い。出たら中身を見て、本当に問題なら直す。新しく書くコードで警告を増やさない。

## 残しているギャップ（ユーザーが決めたので、そのままにする）
- 直したもの（作り直さない）：送信の自動再試行（429 だけ待つ、ほかは送信済みと照合）・Cc の欠落・ピン留めの本文保存・D1 の平文の個人情報・設定の保存失敗（`configSaveQueue.ts`）・CSP の `script-src 'unsafe-inline'`（nonce に置き換え）。
- メール本文の iframe の `sandbox` に `allow-same-origin` が付いている（`allow-scripts` は無い）。
- CSP の `style-src` に `'unsafe-inline'`（React の style 属性とメール本文の style のため）。
- 入力欄の iframe の `allow-scripts`（`editor-security.md`）。
