# Re:Mail（リメール）

Gmail を **LINE / Discord のようなチャット形式** で読み書きする Web アプリ。メールを「相手ごとのトークルーム」にまとめ、受信箱・アーカイブ・送信済み・迷惑メール・ゴミ箱を横断して1本のトーク画面に並べる。複数の Google アカウントを連携でき、チャットはアカウントごとに分かれる。

**見た目はチャット、中身は普通のメール。** 相手は Re:Mail の存在を知らなくてよく、知る必要もない。

- 本番：https://re-mail.eusng90912.workers.dev
- リポジトリ：GitHub `Untechnical-github/Re-Mail`（**公開リポジトリ**、`main` 1本運用）
- 実行基盤：Next.js 16（App Router）を OpenNext で Cloudflare Workers に載せる。設定は Cloudflare D1

> **この README の位置づけ**
> この README は、Re:Mail の仕様書を兼ねる唯一の設計文書。旧「プロジェクト概要 / システム仕様書」はこれに統合して廃止した。
> Re:Mail がどう動くかを、アルゴリズム・定数・画面の文言まで詳しく説明する。設定ファイルは、変えてはいけないこととその理由を書く。
> - **§0 の絶対ルールは、この README の他の節・`CLAUDE.md`・頼まれた作業内容のすべてより優先する。** 機能・速さ・見た目とぶつかったら、常に §0 を取る。
> - Claude Code 向けの作業手順（Git の運用・コマンド・チェックリスト）は `CLAUDE.md` が正。コードとこの README が食い違ったら、どちらが正しいかを確かめて**両方を**直す。

---

## 目次

0. [絶対ルールとサブテーマ](#0-絶対ルールとサブテーマ)
1. [プロダクト概要と運営方針](#1-プロダクト概要と運営方針)
2. [技術スタック](#2-技術スタック)
3. [環境の準備と動かし方](#3-環境の準備と動かし方)
4. [設定ファイル](#4-設定ファイル)
5. [ディレクトリ構成](#5-ディレクトリ構成)
6. [デプロイ（CI/CD）](#6-デプロイcicd)
7. [認証と複数アカウント](#7-認証と複数アカウント)
8. [データの置き場所と形式](#8-データの置き場所と形式)
9. [API 仕様](#9-api-仕様)
10. [送信の仕様（純正 Gmail と同じにする）](#10-送信の仕様純正-gmail-と同じにする)
11. [受信・解析の仕様](#11-受信解析の仕様)
12. [`app/lib/` モジュール仕様](#12-applib-モジュール仕様)
13. [中核ロジック `useMailApp.ts`](#13-中核ロジック-usemailappts)
14. [画面仕様](#14-画面仕様)
15. [セキュリティ](#15-セキュリティ)
16. [テスト](#16-テスト)
17. [変更時のチェックリスト](#17-変更時のチェックリスト)
18. [既知の問題・残り課題](#18-既知の問題残り課題)
19. [設計判断の記録](#19-設計判断の記録)
20. [今後の構想](#20-今後の構想)
21. [claude.ai と Claude Code の役割分担](#21-claudeai-と-claude-code-の役割分担)

---

## 0. 絶対ルールとサブテーマ

### 0.1 なぜこのルールなのか
メールは雑談だけでなく**ビジネスにも使われる**。Re:Mail から送ったメールが、純正 Gmail から送った場合と比べて**相手側で違って見える・届かない・スレッドが崩れる・二重に届く**と、使う人の信用を直接傷つける。
また Re:Mail は **Google アカウントとメール**という最も重い個人情報を扱う。**データを自分たちのところに貯めない・外へ出さない**ことが、プロダクトが存在してよい条件になる。

### 0.2 絶対ルール（優先順）
ルールの文言は理想を表す。外部サービス（Gmail / Google / Cloudflare）が落ちる以上「エラーがゼロ」は文字どおりには実現できない。だから**守るべき状態を、検証できる形で定義する**。

#### ルール1：個人情報を漏らさない・貯めない
1. **サーバー（D1 / R2 / KV / ログ）にメールの中身を置かない。** 本文・件名・添付・HTML は Worker を「通過」するだけで、保存しない。
2. **サーバーに平文の個人情報を置かない。** メールアドレス・相手の名前・フィルターのキーワードなど、D1 に残す必要があるものは暗号化するか HMAC にして保存する（§8）。
3. **ログに個人情報を出さない。** ログは必ず `safeLog.ts` を通す。出してよいのは「処理名・HTTP ステータス・Gmail のエラー理由コード・メッセージ ID／スレッド ID・件数・所要時間」だけ。
4. **第三者に何も送らない。** 解析ツール・広告・外部 CDN・外部フォントを使わない。HTML メールのリモート画像やトラッキングピクセルは、本人の操作（または、開封が送り手に伝わると説明したうえで本人が選んだ設定）がない限り読み込まない（§15.3）。
5. **端末内の保存は「消せる・分かれている・最小限」。** IndexedDB / localStorage のキャッシュは Google アカウントごとに分け、ログアウトで必ず消す（アカウントを1つだけログアウトしたときは、そのアカウントの分を消す）。利用者が選ぶ設定は、端末ではなく D1 に暗号化して持つ。
6. **権限は最小限。** OAuth スコープは必要なものだけにする。足すときはこの README に理由を書く。ブラウザに渡すセッションにも Gmail のアクセストークンを入れない。

#### ルール2：純正 Gmail と同じに送受信する（送信の忠実性）
1. **相手から見て、純正 Gmail で送ったものと区別がつかない。** 宛先（To / Cc）、差出人（送信元エイリアス）、件名、スレッド、署名、引用、添付、文字コード、Message-ID の形を純正と揃える。
2. **送信は「ちょうど1回」。** 二重送信も、送ったつもりで届いていない状態も起こさない。結果が分からないときは「不明」として扱い、確かめる（§10.6）。
3. **受信したメールの情報を黙って落とさない。** 引用や署名の折りたたみなど表示上の整形はしてよいが、元の内容・添付・宛先には必ず辿れるようにする。
4. **純正と違う挙動になるときは、送る前に画面で分かるようにする。** 例：署名や送信元の設定が読めないときは「署名なしで送りますか」と確かめる。

#### ルール3：止まらない（壊れない・失わない・黙らない）
1. **データを失わない。** 入力中の本文・添付は、送信失敗・通信断・タブの再読み込みで消えない。
2. **黙って失敗しない。** 失敗は必ず画面で伝え、次にどうすればよいか（再試行・再ログイン・純正 Gmail で開く）を添える。`alert()` は使わず、トーストで伝える。
3. **一部が落ちても全体は動く。** アカウント1つ・メール1通・添付1つ・壊れた設定1つの失敗で、一覧やほかのアカウントを止めない。
4. **フリーズしない。** 巨大なメールや異常なメールでも、入力の長さと数に上限を置いて打ち切る（§11.2）。
5. **デプロイで壊さない。** テスト・lint・型チェック・ヘルスチェック・自動ロールバックのどれかを通らない変更は、本番に出ない（§6）。

### 0.3 サブテーマ（絶対ルールの範囲内で、常に追う）
- **コストは最低限**：固定費はドメイン代と Workers の有料プランだけにする。依存パッケージを増やさない。R2 は使わない。Gmail API の利用上限も「コスト」とみなし、呼び出しは必要な分だけにする（差分同期・`knownIds`・`fields` で取るデータを絞る）。
- **シンプルなデザインで多機能**：機能は増やしても、画面の要素は増やさない。常に見えるボタンは「送信・添付・返信」程度に絞り、上級の機能は選択モードのアクションバー・モーダル・設定の奥に置く。新しい機能は既定でオフにするか、必要なときだけ出す形にする。
- **読み込みは最速**：サーバー側のキャッシュではなく、**端末内のキャッシュと差分取得**で速くする（ルール1と両立させるため）。

サブテーマどうしがぶつかったときは、どちらを取ったかと理由を作業報告に書く。

### 0.4 ルールの確かめ方
- 新しい機能や変更を入れるたびに、§17 のチェックリストを通す。
- ルール1・2 に関わる処理（MIME の組み立て、宛先の計算、暗号化、ログの伏せ字、送信結果の判定）には、必ず Vitest のテストを書く。
- 純正 Gmail との差は、**同じ内容を純正と Re:Mail の両方から送り、受信側の「メッセージのソースを表示」で比べる**実機テストで確かめる（§17.2）。2026-10-22 の実機テストで見つかった差（署名の位置、引用見出しの表示名、転送のスレッド、ヘッダーの並び）は修正済み。

---

## 1. プロダクト概要と運営方針

### 1.1 核となる体験
- メールを「件名・本文・宛先」の単位ではなく**「相手ごとのチャットルーム」**に自動でまとめる。
- 受信箱・アーカイブ・送信済み・迷惑メール・ゴミ箱を**横断（クロスボックス）**して、同じ相手とのメールを1つのチャットに集める。どの箱を表示するかはチェックボックスで切り替える。
- 複数の Google アカウントに同時にログインでき、どれも対等に扱う（画面に「連携」「メイン」の区別を出さない）。**チャット・設定・フィルターはアカウントごとに完全に分ける**（§7.1・§7.5）。
- UI は Discord 風のダークテーマ：背景 `#313338`、アクセント `#5865F2`、ピン留め `#FEE75C`。PC は「チャット一覧（左）＋トーク画面（右）」の2ペイン、モバイルは1画面ずつ切り替える。

### 1.2 運営方針
- **自前のサーバーを持たない。** 費用は**ドメイン代**と **Cloudflare Workers の有料プラン**だけ。
- **メールを預からない。** Re:Mail は Gmail の「別の見え方」であって、メールの保管場所ではない。メールの正本は常に Gmail にある。
- インフラは Cloudflare に寄せる。
  - **Workers**：OpenNext 経由で Next.js を動かす。
  - **D1**：チャット設定・共通設定・アカウント設定と、ログインしているアカウントの暗号化したトークンを保存する（キーは HMAC、中身は暗号化）。
  - **Cron Triggers**：使わない（以前は古い形式の行の置き換えに使っていたが、移行を終えたので 2026-10-23 にやめた）。
  - **R2**：**使わない。** 添付は Gmail から端末へ直接流す（一時保管も個人情報の保存にあたるため）。
  - **Workers AI**：有料プランの AI 機能に使う想定で、まだ使っていない。使うときは**オプトイン・保存なし・ログなし**（§20）。
- 今の対応は Gmail のみ。将来は Outlook・iCloud にも対応したい。Web 版が仕上がったら Android / iOS アプリを作る予定。
- 収益化は月額の有料プランを検討中。候補は AI 返信・要約・件名の自動生成で、どれも §0 を満たす形でだけ提供する。

---

## 2. 技術スタック

| 領域 | 採用技術 |
| --- | --- |
| フレームワーク | **Next.js 16.3.8**（App Router）/ React 19.2.4。Next.js 15 のサポートが 2026-10-21 に終わるのに合わせて更新した |
| 言語 | TypeScript 5（`strict`） |
| 認証 | NextAuth v5（`5.0.0-beta.32`）＋ Google Provider。JWT セッションを400日保持する。トークンは暗号化された Cookie に入る。ブラウザに返すセッションからはアクセストークンを除く |
| スタイリング | Tailwind CSS v4（`@tailwindcss/postcss`）。色はクラスに直接書く（例：`bg-[#313338]`） |
| 実行・デプロイ | **`@opennextjs/cloudflare` 1.20.9** で Cloudflare Workers に載せる。入り口は自作の `worker.ts`（OpenNext の Worker に、ページごとの CSP nonce を足したもの）。互換フラグは `nodejs_compat` / `global_fetch_strictly_public` |
| DB | Cloudflare D1（バインディング `DB`、DB 名 `re-mail`、`migrations/` で管理）。**メールの中身は置かない** |
| CI/CD | GitHub Actions（`.github/workflows/deploy-worker.yml`）、Node 24 |
| テスト | Vitest 4（`app/**/*.test.ts`、Node 環境。jsdom は使わない） |
| Lint | ESLint 9（`eslint-config-next` 16.3.8）。`no-console` をエラーにする |
| 端末内の保存 | localforage（IndexedDB）：下書き・ピン留めの中身・添付・動画サムネイル。localStorage：画面の状態。どれもアカウント別に分け、ログアウトで消す |
| メール API | Gmail REST API v1 を `fetch` で直接呼ぶ（SDK は使わない）。送信は upload エンドポイント、更新は history API |
| 実行時の依存 | `next` / `react` / `react-dom` / `next-auth` / `localforage` の5つだけ。**解析・広告・外部 CDN・外部フォントは読み込まない** |

**移行の経緯**：以前は `@cloudflare/next-on-pages`（Cloudflare Pages ＋ Edge Runtime）を使っていたが、非推奨になったため OpenNext ＋ Workers に移った。API ルートに `export const runtime = 'edge'` を書いてはいけない（OpenNext が対応していない）。D1 などのバインディングは `getCloudflareContext().env` から取る。

---

## 3. 環境の準備と動かし方

### 3.1 用意するもの
- Node.js 24（CI と同じ版）、npm
- Cloudflare アカウント（**Workers の有料プラン**。CPU 時間に必要）
- Google Cloud のプロジェクト（OAuth クライアントと Gmail API）
- GitHub リポジトリ（Actions を使う）

### 3.2 プロジェクトの成り立ち
- `create-next-app`（TypeScript・ESLint・Tailwind・App Router、`src/` なし）で始めたプロジェクト。設定ファイルの要点は §4、依存の版は §2。
- `app/globals.css` は create-next-app の既定のまま。画面の色はコンポーネント側で直接指定する。
- `public/` には create-next-app 既定の SVG だけが入っていて、画面では使っていない。

### 3.3 Google Cloud の設定
1. **Gmail API を有効にする。**
2. **OAuth 同意画面**：
   - ユーザーの種類は「外部」。公開ステータスは審査前の「テスト」で、テストユーザーに使う人のアドレスを足す（最大100人）。
   - スコープは `openid` `email` `profile` `https://www.googleapis.com/auth/gmail.modify`。
3. **OAuth クライアント ID**（ウェブアプリケーション）：
   - 承認済みのリダイレクト URI に、次の**2つ**を登録する（本番とローカルの両方）。
     - `https://<本番ドメイン>/api/auth/callback/google`（NextAuth 用）
     - `https://<本番ドメイン>/api/accounts/connect`（別のアカウントでもログインするとき用）
     - ローカル：`http://localhost:3000/api/auth/callback/google` と `http://localhost:3000/api/accounts/connect`
4. テストモードでは、リフレッシュトークンが**7日で失効**する（§7.6）。

### 3.4 Cloudflare の設定
1. D1 を作る：`npx wrangler d1 create re-mail`。出てきた `database_id` を `wrangler.json` に書く。今の本番は `f3e2ba87-ef1e-4a51-9054-b1add1cad95e` で、**この値は変えない**。
2. マイグレーションを当てる：`npx wrangler d1 migrations apply re-mail --remote`（ふだんは CI が自動で当てる）。
3. Worker のシークレットを登録する（値はどこにも書かない・コミットしない）：
   ```bash
   npx wrangler secret put AUTH_SECRET            # NextAuth の署名用。例: openssl rand -base64 32
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   npx wrangler secret put TOKEN_ENCRYPTION_KEY   # base64 にした32バイト。例: openssl rand -base64 32
   ```
   - **`TOKEN_ENCRYPTION_KEY` を変える・消す・失くすと、D1 のトークンと設定がすべて読めなくなる**（§8.4）。Cloudflare に登録したシークレットは後から値を読み出せないので、控えはリポジトリ・Cloudflare・GitHub の**外**（パスワードマネージャーなど）に保管する。今の本番の鍵の控えは、開発者が保管済み。
4. GitHub の Actions シークレットを登録する：`CLOUDFLARE_API_TOKEN`（権限は Workers の編集と D1 の編集）、`CLOUDFLARE_ACCOUNT_ID`。

### 3.5 ローカルで動かす
- `.dev.vars` に4つのシークレットを書く（`.gitignore` 済み。**コミットしない**）。**ローカルでも `TOKEN_ENCRYPTION_KEY` が要る**（無いと設定・アカウントの API が 500 を返し、D1 には何も書かない。平文で保存する逃げ道は無い）。開発用の鍵は本番と別のものを `openssl rand -base64 32` で作って入れる。
- `npm run dev`：`next.config.ts` の `initOpenNextCloudflareForDev()` により、`getCloudflareContext()` からローカルの D1（`.wrangler/` 配下、Git の追跡外）が使える。ローカルの D1 には `npx wrangler d1 migrations apply re-mail --local` でスキーマを当てる。
- 開発サーバーにはセキュリティヘッダーを付けない（本番のビルドだけに付ける）。
- Workers に近い形で確かめるなら `npm run preview`。

### 3.6 デプロイ
- `main` に push すると、GitHub Actions が自動でデプロイする（§6）。手で `wrangler deploy` を実行しない。手動で動かすときは `gh workflow run deploy-worker.yml`、結果は `gh run watch` で見る。

### 3.7 動作の確認
1. `npm test` / `npm run lint` / `npx tsc --noEmit` がすべて通る。
2. ヘルスチェック（`bash script/ci/health-check.sh`、`HEALTH_CHECK_URL` で URL を変えられる）が通る。
3. 実機で、ログイン → 一覧 → チャットを開く → 返信 → 添付 → 別のアカウントでもログイン → 送信元の切り替え → アカウントを1つだけログアウト → すべてログアウトで端末のデータが消える、まで通す。
4. 送信まわりは §17.2 の比較テストを行う。

---
## 4. 設定ファイル

中身はリポジトリのファイルが正。ここには、それぞれの設定で**変えてはいけないこと・そうしている理由**だけを書く（ファイルのコメントにも理由が書いてある）。

| ファイル | 要点 |
| --- | --- |
| `package.json` | 実行時の依存は `next` / `react` / `react-dom` / `next-auth` / `localforage` の5つだけ（版は §2）。スクリプトは `dev` / `build` / `start` / `lint`（`eslint`）/ `test`（`vitest run --passWithNoTests`）/ `preview`（OpenNext でビルドしてローカルの Workers で動かす）/ `cf-build`（OpenNext のビルドだけ）。`package-lock.json` は `npm install` で作る |
| `tsconfig.json` | `strict`。`worker.ts` はビルドで生成される `.open-next/worker.js` を読むので、型チェックから外す |
| `eslint.config.mjs` | `eslint-config-next` の core-web-vitals と typescript。`no-console` はエラー（例外は `app/lib/safeLog.ts` だけ。ログにアドレスや本文を出さないため）。React Compiler 向けの4ルール（`react-hooks/set-state-in-effect` / `refs` / `purity` / `immutability`）は誤検知が多いので警告。未使用の引数は `_` で始めれば許す。`.open-next/` `.wrangler/` と Next.js が生成する型ファイルは対象外 |
| `vitest.config.ts` | 対象は `app/**/*.test.ts`。環境は Node のまま（jsdom や Workers の再現は使わない） |
| `open-next.config.ts` / `postcss.config.mjs` | 既定のまま（`defineCloudflareConfig()`、`@tailwindcss/postcss`） |
| `wrangler.json` | 名前 `re-mail`、入り口 `worker.ts`、互換フラグ `nodejs_compat` / `global_fetch_strictly_public`、静的ファイルは `.open-next/assets`（バインディング `ASSETS`）、自分自身へのサービスバインディング `WORKER_SELF_REFERENCE`（OpenNext が使う）、`observability` オン、D1 のバインディング `DB`（DB 名 `re-mail`、`migrations_dir: "migrations"`）。**`database_id` は本番の D1 の ID なので変えない**（§3.4）。定期実行は使わない。`triggers.crons` を空の配列にしてあるのは、以前登録していた定期実行をデプロイのときに確実に外すため（`triggers` を書かないと、wrangler は登録済みの定期実行をそのまま残す） |
| `next.config.ts` | 型チェックは CI で別に行うので `typescript.ignoreBuildErrors: true`。セキュリティヘッダー（`SECURITY_HEADERS`）は本番のビルドだけに付ける。**CSP はここに入れない**（nonce が消える。§15.1）。`initOpenNextCloudflareForDev()` で `next dev` でも D1 などのバインディングを使えるようにする |
| `worker.ts` | OpenNext の Worker をそのまま使い、ページごとの CSP nonce の処理だけを足す（中身は `securityHeaders.ts`。§15.1）。OpenNext が使う Durable Object のクラス（`DOQueueHandler` / `DOShardedTagCache` / `BucketCachePurge`）もそのまま export する（しないとデプロイが失敗する） |
| `env.d.ts` | `CloudflareEnv` は `DB: D1Database` だけ。`TOKEN_ENCRYPTION_KEY` などのシークレットは `process.env` から読む（OpenNext がリクエストのたびに入れる） |
| `types/next-auth.d.ts` | `Session` に `accessToken?` と `error?`（リフレッシュトークンが失効したとき `"RefreshAccessTokenError"`）を足す |
| `.gitignore` | create-next-app の既定に、`/.open-next/`・`.dev.vars*`・`/.wrangler/` を足す（`.env*` は既定で入っている） |
| `migrations/0001_initial.sql` | `chat_configs`（§8.3）と `linked_accounts`（§8.4）の `CREATE TABLE IF NOT EXISTS`。本番には適用済み |
| `migrations/0002_linked_accounts_account_enc.sql` | `linked_accounts` に `account_enc TEXT` を足す（§8.4） |
| `migrations/0003_drop_legacy_rows.sql` | 保存の形の移行を終えたときに古い形式のデータを消したもの（§6.1）。`chat_configs` はすべて消し、`linked_accounts` は今の形式でない行だけを消す（先頭は `LIKE` ではなく `substr` で比べる。`LIKE` は大文字小文字を区別しないため）。新しく作る D1 では何も消さない |
| `.github/workflows/deploy-worker.yml` | 流れは §6。`main` への push で、Worker に関係するファイル（`app/**` `public/**` `migrations/**` `auth.ts` `worker.ts` `env.d.ts` `next.config.ts` `open-next.config.ts` `postcss.config.mjs` `tsconfig.json` `eslint.config.mjs` `wrangler.json` `package.json` `package-lock.json` `script/ci/**` とこのファイル）が変わったときだけ動く。手動実行（`workflow_dispatch`）もできる。権限は `contents: read`。`concurrency: deploy-worker`（取り消さずに順番待ち）、20分で打ち切り。ロールバックは、デプロイが成功したあとにヘルスチェックが失敗したときだけ |
| `script/ci/retry.sh` | 引数のコマンドを最大3回試す（失敗したら20秒・40秒待つ）。`npm ci`・マイグレーション・デプロイ・ロールバックに使う |
| `script/ci/health-check.sh` | デプロイ後の動作確認（中身は §6）。URL は `HEALTH_CHECK_URL` で変えられる（既定は本番）。最大3回、10秒・20秒の間を空けて試す |
| `app/globals.css` | create-next-app の既定のまま（画面の色はコンポーネント側で直接指定する） |
| `app/layout.tsx` | `lang="ja"`。**`export const dynamic = "force-dynamic"`** で毎回サーバーで描く（CSP の nonce は開くたびに変わるので、ビルド時の HTML を返すとスクリプトが止まる） |
| `app/providers.tsx` | `SessionProvider` で包むだけ（`layout.tsx` をサーバー側の部品にするため分けた） |
| `auth.ts` | §7.2・§7.4 |
| `app/api/auth/[...nextauth]/route.ts` / `app/lib/publicSession.ts` | `/api/auth/session` の応答から `accessToken` / `refreshToken` / `expiresAt` を取り除く（§7.2）。Set-Cookie はそのまま通し、中身を作り直すので `content-length` は消す |

---

## 5. ディレクトリ構成

```
Re-Mail/
├── app/
│   ├── api/
│   │   ├── auth/[...nextauth]/route.ts   # NextAuth のハンドラ。/session の応答からアクセストークンを除く（§7.2）
│   │   ├── accounts/route.ts             # セッションを持たないアカウントの一覧（GET）・ログアウト（DELETE）
│   │   ├── accounts/connect/route.ts     # 別のアカウントでもログインするための独自 OAuth（リダイレクトとコールバックを兼ねる）
│   │   ├── avatar/route.ts               # イニシャルの SVG アバター
│   │   ├── config/route.ts               # D1 の設定の読み書き（HMAC＋暗号化。鍵が無ければ 500）
│   │   ├── config/route.test.ts
│   │   └── emails/route.ts               # Gmail の取得・差分同期・送信・送信確認・移動・削除・添付・HTML 本文・sendAs（保存せず中継だけ）
│   ├── components/
│   │   ├── Modals.tsx                    # すべてのモーダル
│   │   └── ui.tsx                        # ActionBar・アイコン・HighlightText・BodyWithLinks・formatFileSize
│   ├── hooks/
│   │   └── useMailApp.ts                 # 状態とロジックの中核（カスタムフック。§13）
│   ├── lib/                              # React に依存しない純粋関数（ほぼすべてにテストあり。§12）
│   ├── types/
│   │   ├── mail.ts                       # ChatConfig / MessageConfig / SelectionMode / ModalState
│   │   └── email.ts                      # Email / EmailAttachment
│   ├── error.tsx / global-error.tsx      # エラー画面（もう一度表示する・ページを読み込み直す・純正 Gmail で開く）
│   ├── globals.css / layout.tsx / providers.tsx
│   └── page.tsx                          # メイン画面（ログイン・一覧・トーク）
├── migrations/                           # D1 のスキーマ（連番。適用済みのファイルは書き換えない）
├── script/ci/                            # retry.sh / health-check.sh
├── .github/workflows/deploy-worker.yml
├── types/next-auth.d.ts
├── auth.ts / worker.ts / env.d.ts
├── next.config.ts / open-next.config.ts / wrangler.json
├── vitest.config.ts / tsconfig.json / eslint.config.mjs / postcss.config.mjs
├── public/                               # create-next-app 既定の SVG（使っていない）
├── CLAUDE.md                             # Claude Code 向けの作業ルール
├── README.md                             # この文書（仕様書を兼ねる）
└── package.json / package-lock.json
```

右クリックや長押しの専用メニュー（ContextMenu）は**無い**。長押し（PC はクリック操作）で**選択モード**に入り、アクションバー（`ui.tsx` の `ActionBar`）から操作する。

---

## 6. デプロイ（CI/CD）

`main` に push すると、GitHub Actions が次の順で実行する。Worker に関係するファイル（§4 の `paths`）が変わったときだけ動く。README など文書だけの変更では動かない。

1. `npm ci`（`retry.sh` で最大3回）→ `npm test` → `npm run lint` → `npx tsc --noEmit`
2. `npx opennextjs-cloudflare build`
3. シークレットの登録確認（`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`）
4. **D1 マイグレーションを先に当てる**（`wrangler d1 migrations apply re-mail --remote`）。新しいコードが新しい列を使っても動くようにするため
5. `npx opennextjs-cloudflare deploy`
6. **ヘルスチェック**（`script/ci/health-check.sh`）：トップページが 200 を返すか、`/api/auth/providers` に `"google"` が出るか（シークレットがそろっているか）、トップページの CSP に nonce があり、ページ内のインラインスクリプトがすべて同じ nonce を持っているか。nonce がずれると画面は動かないのにページは 200 を返すので、ここで見つける
7. ヘルスチェックに失敗したら、**1つ前の版へ自動でロールバック**する（`wrangler rollback --yes`）。D1 のスキーマとデータは戻らない

デプロイは `concurrency: deploy-worker` で1つずつ順に動き、20分で打ち切られる。

### 6.1 データ移行は2段階で行う
ロールバックでコードだけが戻っても壊れないようにするため（ルール3-5）。
- **段階1**：新しい形式も古い形式も**読める**コードを出す。保存はまだ古い形式のまま。
- **段階2**：保存を新しい形式に切り替える。段階1のコードは新しい形式も読めるので、段階2から1つ戻しても壊れない。
- **終わったら**：古い形式のデータを migrations で消し、古い形式を読むコードを消す。段階2のコードは新しい形式だけの D1 でも動くので、「データの削除」と「コードの削除」は1回の push でよい（マイグレーションはデプロイより先に当たる）。
- **今の状態**：アドレスの置き換え（`a1:`）と設定の置き場所の移行（そのアカウント自身の置き場所）は、**2026-10-23 にすべて終えた。** 古い形式のデータは `migrations/0003_drop_legacy_rows.sql` で消した（`chat_configs` はすべて、`linked_accounts` は今の形式でない行だけ。§4）。段階のフラグ（`addressStage.ts` / `configStage.ts`）、定期実行での書き直し（`backfill.ts`）、平文の値を読む処理も消した。今のコードは今の形式だけを読み、鍵が無ければ平文で書かずに例外にする。
- 今後また保存の形を変えるときは、この段階1・段階2で入れ、終わったら古い形式のデータと読むコードを消す。

### 6.2 スキーマ変更の決まり
- 新しいファイル（`0004_xxx.sql` …）を足す。適用済みのファイルは書き換えない。
- 非破壊にする：`DROP TABLE` は書かない。列は `ALTER TABLE ... ADD COLUMN` で足す。列やデータを消すときは、まず使わなくなるコードを出し、次の段階で消す。
- 本番の D1 を手で操作しない。migrations を足して push し、Actions に当てさせる。

---

## 7. 認証と複数アカウント

### 7.1 考え方：ログインしているアカウントはすべて対等
- 複数の Google アカウントに**同時にログインでき、どれも対等な別々のアカウント**として扱う（ログインできた＝同じ人）。**画面に「連携」「メインアカウント」のような区別を出さない。**
- メールの表示はまとめて出すが、チャット・設定・フィルターはアカウントごとに分ける（§7.5・§8.3）。設定はそのアカウント自身の置き場所（D1 の `user_email` がそのアカウント）に保存するので、どのアカウントで直接ログインしても同じ設定で使える。
- 内部では、**ログインのセッション（NextAuth の JWT Cookie）を持つアカウントが1つ**あり、ほかのアカウントは D1 の `linked_accounts` にそのアカウントの付属として付いている。コードの中では今も前者を「メイン」、後者を「連携アカウント」と呼ぶことがあるが、画面には出さない。
- Google に求める権限は `app/lib/googleScopes.ts` の `GOOGLE_OAUTH_SCOPE`（`openid email profile https://www.googleapis.com/auth/gmail.modify`）の1か所だけに書き、最初のログインにも別のアカウントの追加にも同じものを使う。
  - `openid` / `email`：どのアカウントかを確かめる
  - `profile`：名前とプロフィール画像（画面に出すだけ。認証や照合には使わない）
  - `gmail.modify`：メールの読み取り・送信・ラベルの付け外し（**完全削除はできない**）

### 7.2 最初のログイン（`auth.ts`）
- Google でログインする。`prompt=consent` と `access_type=offline` でリフレッシュトークンを取る。
- セッションは JWT で、400日保持し、1日ごとに延長する。アクセストークン・期限・リフレッシュトークンは NextAuth の**暗号化された JWT Cookie** に入り、サーバー側には保存しない。
- `jwt` コールバックでは、期限まで60秒より余裕があればそのまま返し、そうでなければ `getValidAccessToken` でリフレッシュする。`invalid_grant` / `invalid_client`（恒久的な失効）のときだけ `error: "RefreshAccessTokenError"` を付けて再ログインさせ、それ以外の失敗（一時的なもの）は元のトークンのまま返す。
- **ブラウザに返すセッション（`/api/auth/session`）からは `accessToken` / `refreshToken` / `expiresAt` を取り除く**（`publicSession.ts`）。ページ上で万一スクリプトが動いても、Gmail の鍵を持ち出せないようにするため。API ルートは `auth()` で中身ごと使える。
- **メールの取得が 401 / 403 になっても、すぐにはログアウトしない。** まずセッションを取り直し、`RefreshAccessTokenError` が付いている・ユーザーがいないなど、ログインが本当に無効なときだけログアウトする。トークン更新の一時的な失敗で勝手にログアウトされ、下書きまで消える事故が実機で起きたため。
- ログイン画面の文言は「Googleでログインして始める」。`signIn("google")` を呼ぶ。

### 7.3 別のアカウントでもログインする（`/api/accounts/connect`）
- NextAuth とは別系統の OAuth。1つのエンドポイントが「Google へのリダイレクト」と「コールバックでのトークン交換」を兼ねる。ログインしていなければ `/` に戻す。
  1. `code` が無いリクエスト：ランダムな `state` を作り、Cookie `remail_link_state`（httpOnly・secure・SameSite=Lax・有効600秒・path はこのエンドポイント）に入れて、`https://accounts.google.com/o/oauth2/v2/auth` へリダイレクトする。パラメータは `scope=GOOGLE_OAUTH_SCOPE`、`access_type=offline`、`prompt=consent select_account`（リフレッシュトークンを毎回確実に受け取るため）、`redirect_uri=<origin>/api/accounts/connect`。
  2. コールバック：`state` を Cookie と照らし合わせる（合わなければ `/?accountLinkError=state_mismatch`）。`code` をトークンに替え、`https://www.googleapis.com/oauth2/v2/userinfo` でアドレス・名前・画像を取る。リフレッシュトークンが無ければ `/?accountLinkError=no_refresh_token`、そのほかの失敗は `/?accountLinkError=1`。成功したら `saveLinkedAccount` で保存して `/?accountLinked=<アドレス>` へ戻す。
  3. 画面は `accountLinked` / `accountLinkError` を読み取ってトーストを出し、URL からパラメータを消す。
- トークンは D1 の `linked_accounts` に**暗号化して**（`encv1:`）保存する。暗号化 Cookie に移す案は**見送った**（理由は §19）。
- 行のキーにしている自分のアドレス（`user_email`・`account_email`）は `a1:`＋HMAC に置き換える。そのアカウントの元のアドレス（`account_enc`）・表示名（`name`）・プロフィール画像の URL（`picture`）は暗号化して持つ。名前が取れなかったときは、アドレスを名前の代わりにしない（画面にアドレスが2回出るため。名前なしとして扱う）。
- リフレッシュトークンが失効したら（`invalid_grant` / `invalid_client`）`needs_reauth=1` を立てる。画面にはトーストで「ログインが切れた」ことと再ログインの方法を伝え、アカウントの一覧に「再ログインが必要」と出す。ほかのアカウントは動き続ける（ルール3-3）。リフレッシュに成功したら `needs_reauth=0` に戻す。
- Google がリフレッシュトークンを新しくした（ローテーションした）場合は、新しいものを必ず書き戻す。暗号化の鍵が無いときは 401（再ログイン）ではなく 500 を返す（再ログインでは直らないため）。

### 7.4 アカウントを1つだけログアウトする（`logoutAccount`）
アカウントの一覧（`account_menu`）で、アカウントごとに「ログアウト」できる。確認の文言は「このアカウントだけログアウトします。ほかのアカウントはそのまま使えます。このアカウントの設定は残り、もう一度ログインすれば元どおりに使えます」。「すべてのアカウントからログアウト」もある。
- **セッションを持たないアカウント**：`DELETE /api/accounts?account_email=` で `linked_accounts` の行を消し、画面からそのアカウントのメール・チャットを取り除き、`clearAccountDeviceData` で端末のそのアカウントの分を消す。トースト「〇〇 からログアウトしました」。
- **セッションを持つアカウント**：ほかのアカウント（再ログインが要らないもの）の1つにセッションを引き継ぐ。
  1. 画面が `useSession().update({ switchTo: <引き継ぐアカウント> })` を呼ぶ。
  2. `auth.ts` の `jwt` コールバック（`trigger === "update"`）が `promoteLinkedAccount(db, 今のアカウント, 引き継ぐアカウント)` を呼ぶ。引き継げるのは**今のアカウントの `linked_accounts` に付いているアカウントだけ**（ほかの人のアカウントにはなれない）。再ログインが必要なら何も変えない。
  3. `promoteLinkedAccount` は、引き継ぐアカウントのトークン・名前・画像を復号して返し、今のアカウントに付いていたほかのアカウントの行を引き継ぐアカウントに付け替え（暗号化した値はそのまま写す）、**今のアカウントの行をすべて消す**（ログアウトしたアカウントのトークンを残さない）。写すのと消すのは同じ `db.batch` で行う。
  4. JWT を引き継いだアカウントのものに置き換える（`sub` / `email` / `name` / `picture` / トークン。保存されたアクセストークンが無ければ `expiresAt: 0` にして次の通信ですぐ取り直させる）。
  5. 画面は、セッションのアドレスが引き継ぐアカウントになったことを確かめてから、ログアウトしたアカウントの端末のデータを `clearAccountDeviceData` で消し、`remail_device_owner` を引き継いだアカウントにし、開いていたチャットとスクロール位置を消して再読み込みする。失敗したら「ログアウトできませんでした。通信状況を確認して、もう一度お試しください。」と伝え、何も変えない。
- ほかに使えるアカウントが無ければ、すべてログアウトする（`clearDeviceData` → `signOut`）。
- ログアウトしても、そのアカウントの `chat_configs`（設定）は残す。もう一度ログインすれば元どおりに使える。

### 7.5 チャットの分け方（設計判断）
- **チャットはアカウントごとに完全に分ける。** 同じ相手でも、アカウントが違えば別のチャットにする。仕事用と個人用の文脈が混ざったり、送信元を取り違えたり（＝ビジネス上の事故）するのを避けるため。
- 画面で使うキー（roomKey）は「アカウントのアドレス ＋ `\u0000` ＋ ローカルキー」の複合キー。ローカルキーは、相手の表示名（無ければアドレス）、`group:xxxx`、`filter:xxxx`、メッセージ単位の設定なら Gmail のメッセージ ID。組み立てと分解は必ず `roomKey.ts` を通す。型でも `LocalKey` と `RoomKeyStr` を分けている。**D1 の `chat_id` はローカルキー、画面の state は複合キー**、と使い分ける。
- 一覧の上の**アカウント別チェックボックス**で、表示するアカウントを絞れる（共通設定）。
- **グループ・フィルター・フィルターグループもアカウントごと。** フィルターは必ずどれか1つのアカウントのもの（`filterCriteria.accountEmail`）で、そのアカウントのメールにだけ効く。フィルターグループもほかのアカウントのメールを混ぜない。
- 返信は、開いているチャットのアカウントから送る。**ログインしているアカウントが2つ以上あるときは、返信欄の上に「送信元: <アカウント> 切り替え」を出す**（グループでは出さない）。押すと `select_send_account` モーダルで別のアカウントを選べ、そのアカウントで同じ相手とのチャット（無ければ新しいチャット）に切り替わる（§13.8）。
- 新規作成とグループ作成では送信元のアカウントを選ぶ。転送は、元のメールを受け取ったアカウントから送る。

### 7.6 OAuth の「テストモード」の制約
審査前はリフレッシュトークンが**7日で失効**する。失効しても §7.2・§7.3 の導線（再ログインのトースト）があるので、黙って壊れることはない。根本的な解決は OAuth 審査の通過（§18.4）。

---

## 8. データの置き場所と形式

### 8.1 置き場所の一覧

| 置き場所 | 置くもの | 置かないもの |
| --- | --- | --- |
| Gmail | メールの正本（すべて） | — |
| NextAuth の JWT Cookie（暗号化） | セッションを持つアカウントのアクセストークン・期限・リフレッシュトークン | — |
| D1 `chat_configs` | 利用者が Re:Mail で行った設定（ピン留め・非表示・名前変更・グループ・フィルター）・共通設定・アカウント設定。どれもそのアカウント自身の置き場所に置く（§8.3.1） | メールの本文・件名・添付・HTML。平文のアドレス・名前・キーワード |
| D1 `linked_accounts` | セッションを持たないアカウントの暗号化したトークン、暗号化したアドレス・表示名・画像 URL | 平文のトークン・アドレス |
| ログ | 処理名・ステータス・理由コード・メッセージ ID／スレッド ID・件数・所要時間 | 上記以外のすべて |
| 端末（IndexedDB / localStorage） | 画面の状態・下書き・キャッシュ（アカウント別） | 設定（D1 に置く） |
| R2 / KV | **使わない** | — |

### 8.2 D1 の値の形

| 値 | D1 での形 |
| --- | --- |
| 自分のアドレス（`user_email`・`account_email`） | `a1:` ＋ HMAC（元に戻せない）。`trim().toLowerCase()` してから `"addr:" + アドレス` を HMAC する |
| 相手の名前・アドレス・メッセージ ID（`chat_id`） | `h1:` ＋ HMAC(`chat_id`) |
| 元の chat_id・設定の中身・元の account_email | 封筒 JSON `{"c": 元のchat_id, "n": 元のcustom_name, "a": 元のaccount_email}` を AES-256-GCM で暗号化して `custom_name` 列に入れる |
| 共通設定・アカウント設定（`__GLOBAL_SETTINGS__` / `__ACCOUNT_SETTINGS__` 行） | 設定の JSON をまるごと AES-256-GCM で暗号化 |
| `linked_accounts` のアカウントの元のアドレス・表示名・画像 URL | AES-256-GCM（`encv1:`） |
| OAuth トークン | AES-256-GCM（`encv1:`） |
| フラグ（`is_pinned`・`is_hidden`・`hidden_at_date`・`unhide_on_new`・`needs_reauth`・`expires_at`・`created_at`） | 平文（個人情報を含まない） |

- **暗号文の形**：`encv1:` ＋ base64(IV 12バイト) ＋ `:` ＋ base64(暗号文＋タグ)。鍵は `TOKEN_ENCRYPTION_KEY`（base64 の32バイト）を AES-GCM の raw 鍵として読み込む。
- **HMAC**：`TOKEN_ENCRYPTION_KEY` を HKDF（SHA-256、salt は空、info は `remail-chat-id-hmac-v1`）にかけて HMAC-SHA256 の鍵を派生させる。出力は base64url（`+`→`-`、`/`→`_`、末尾の `=` を除く。43文字）。
- **鍵が設定されていなければ、暗号化・復号・HMAC のどれも例外にする**（`EncryptionKeyMissingError`）。API は 500 を返し、D1 には何も書かない。平文で保存する逃げ道は無い（ローカル開発でも `.dev.vars` に鍵を入れる。§3.5）。
- 復号できるのは `encv1:` で始まる値だけ。それ以外（以前の平文の値）は例外にする。
- **この節の形（接頭辞・IV の長さ・base64 の種類・HKDF の info・`addr:` の付け方・封筒の名前）は、1文字でも変えると既存の D1 のデータが読めなくなる**（HMAC の値が変わり、設定が見つからなくなる）。変えるときは新旧どちらの形も読めるようにし、既存の行を読めることをテストで確かめる。

### 8.3 `chat_configs`（主キー `user_email, account_email, chat_id`）
列：`user_email` / `account_email` / `chat_id` / `custom_name` / `is_pinned` / `is_hidden` / `hidden_at_date` / `unhide_on_new`（`migrations/0001_initial.sql`）。

- `account_email = ""` の行は予約行。`chat_id` が `__GLOBAL_SETTINGS__`（共通設定）・`__ACCOUNT_SETTINGS__`（アカウント設定）。予約行は `chat_id` を HMAC にせず、中身をまるごと暗号化する。
- **`custom_name` の中身（復号したあと）**：
  - ただの文字列なら、チャットの表示名（名前変更）。
  - `{` で始まれば JSON。チャット単位なら `ChatConfig`（§8.6）の一部。グループのメンバー・フィルターの条件・ピン留めの ID 一覧などがここに入る。
  - メッセージ単位の設定（ピン留め・非表示）は、`chat_id` を Gmail のメッセージ ID にした行で、JSON に `roomId`（複合キー）を持つ。封筒ごと暗号化するので外からは見えない。
  - ピン留めの JSON は `ids`（Gmail のメッセージ ID の配列、新しい順、**チャットあたり最大60件**）だけを持つ。保存の前に必ず `stripPinnedBodies` を通し、メール本体（`data`）が送られてきても書かない（`pinnedIds.ts`）。
- **読み込み（`openConfigs(db, アカウント)`）**：`user_email` が `a1:`（そのアカウント）の行を読み、封筒を開けて元の形に戻す。`h1:` でない行・復号できない行・封筒にアカウント（`a`）が無い行は、ログ（`config.openRow`）を出して返さない（ほかの行の表示は止めない）。
- **保存（`saveConfig`）**：`a1:` のキー・`h1:` の chat_id・暗号化した封筒で UPSERT する。
- **削除（`deleteConfig`）**：`a1:` のキーと `h1:` の chat_id で消す。
- **予約行の読み書き（`readReservedRow` / `writeReservedRow`）**：中身はまるごと暗号化して書く。読むときは `encv1:` の値だけを復号し、読めなければ空の設定として扱う。
- 壊れた設定（例：壊れたフィルター定義）が1つあっても、その条件は「一致しない」扱いにして画面全体を落とさない（ルール3-3）。

#### 8.3.1 アカウントごとの置き場所（`openSessionConfigs` / `saveSessionConfig`）
設定は**そのアカウント自身の置き場所**（`user_email` = そのアカウント）に保存する。こうすると、ほかのアカウントの付属として使っていたアカウントで直接ログインしても、同じ設定がそのまま使える。

| 設定 | 置き場所 |
| --- | --- |
| チャットの設定（ピン留め・非表示・名前変更）・グループ・フィルター・メッセージ単位の設定 | そのチャットのアカウントの置き場所（`account_email` も同じアカウント） |
| アカウント設定（`__ACCOUNT_SETTINGS__`） | そのアカウントの置き場所 |
| 共通設定（`__GLOBAL_SETTINGS__`） | ログインしている**全アカウント**の置き場所に同じものを書く。読むときは `updatedAt` が一番新しいものを使う（同じならセッションを持つアカウントの分）。あとから足したアカウントにも写す |

- 「ログインしているアカウント」は、セッションのアカウントと、その `linked_accounts` に付いているアカウント（`sessionAccountList`）。API はリクエストのたびに `listLinkedAccountEmails` でこれを求める（アドレスの列だけを読んで復号する。表示名・画像は復号せず、行の書き直しもしない）。
- **読み込み（`openSessionConfigs(db, セッションのアカウント, 付いているアカウント)`）**：全アカウントの置き場所を `openConfigs` で読み、次のようにまとめる。
  - チャットの設定は、**その置き場所のアカウントのものだけ**を返す（ある置き場所に別のアカウントの行があっても返さない。アカウントを取り違えない）。
  - 共通設定の写しのうち `updatedAt` が一番新しいものを使い、違う写し・無い写しを書き直す（あとから足したアカウントにも写す）。書き直しは失敗しても読み込みを止めない（次に読んだときにまた試す）。
  - アカウント設定は、そのアカウントの置き場所のもの（無ければ空）。
  - 応答は、共通設定の行（1行にまとめて復号した JSON。共通設定が無ければ出さない）とチャットの設定の一覧、それにアカウントごとのアカウント設定。
- **保存（`saveSessionConfig`）**：そのチャット（フィルター）のアカウントの置き場所に書く。フィルターもアカウントごとなので、全アカウントに書く設定は無い。**ログインしていないアカウントのものは書かない**（`UnknownAccountError`。API は 400）。
- **削除（`deleteSessionConfig`）**：そのアカウントの置き場所から消す。ログインしていないアカウントのものは 400。
- **共通設定の保存（`saveCommonSettings`）**：全アカウントの写しのうち一番新しいものに、変えた値を重ね、`updatedAt` を今の時刻にして、全アカウントの置き場所に書く。
- **アカウント設定の保存（`saveAccountSettings`）**：そのアカウントの置き場所の `__ACCOUNT_SETTINGS__` に、`sanitizeAccountSettings` を通した値を重ねて書く。

### 8.4 `linked_accounts`（主キー `user_email, account_email`）
列：`user_email` / `account_email` / `account_enc`（0002 で追加）/ `refresh_token` / `access_token` / `expires_at`（ミリ秒）/ `created_at`（ISO）/ `needs_reauth` / `name` / `picture`。

- 読み書きは必ず `linkedAccountsStore.ts` を通す。今の形式（`user_email`・`account_email` が `a1:`、`account_enc`・`refresh_token` が `encv1:`、`access_token`・`name`・`picture` は NULL か `encv1:`）だけを読む。
  - `findLinkedAccount`：`a1:` のキーで1行を探す。返した行のキーのまま更新する。
  - `listLinkedAccounts`：画面用にアドレス・名前・画像を復号して返す。開けない行はログを出して飛ばす（ほかのアカウントは使える）。
  - `saveLinkedAccount`：INSERT（衝突時は UPDATE）する。トークン・アドレス・名前・画像はすべて暗号化する。
  - `deleteLinkedAccount`：`a1:` のキーで消す。
  - `promoteLinkedAccount(db, from, to)`：セッションを持つアカウント（from）だけをログアウトし、to に引き継ぐ（§7.4）。to が from に付いていない・再ログインが必要なら `null`（何も変えない）。
  - `listLinkedAccountEmails`：設定の読み書きのたびに使う、アドレスだけの一覧（`account_enc` だけを復号する）。

### 8.5 鍵の扱い
- 鍵は **`TOKEN_ENCRYPTION_KEY` の1本だけ**。HMAC の鍵はそこから HKDF で用途別に派生させる（シークレットを増やさないため）。
- **この鍵を変える・消す・失くすと、トークンだけでなく D1 の設定もすべて読めなくなる**（HMAC のキーも作り直せない）。鍵を更新するときは、新旧どちらでも読める期間を作る。値に鍵の版を埋め込んであるので（`encv1:` → `encv2:`、`a1:` / `h1:` の数字）、それを使う。
- 鍵の控えは、開発者がリポジトリ・Cloudflare・GitHub の外に保管している。**Claude は鍵の値を見ない・書かない・保管場所を聞き出さない。**

### 8.6 設定の型（`app/types/mail.ts`）
`ChatConfig`（チャット単位）・`MessageConfig`（メッセージ単位）・`SelectionMode`・`ModalState`。`custom_name` の JSON はこの名前で保存するので、名前を変えると既存の設定が読めなくなる。要点：
- `ChatConfig`：`customName` / `isPinned` / `isHidden` / `hiddenAtDate` / `unhideOnNew` / `forceFetch`（永続読み込み）/ `persistedIds`（ピン留めした ID、最大60件）/ `isGroup` / `groupMembers`（ローカルキー）/ `groupMemberAddresses`（作成時に確定した実アドレス）/ `groupMode`（`normal` / `inbound_only` / `outbound_only`）/ `groupHiddenMembers`（作成時に新たに隠したメンバー）/ `filterCriteria` / `filterHideOriginal` / `filterIncludeExisting` / `filterAction`（`hide` / `pin` / `move` / `delete` / `read` / `unread`）/ `filterContinuous` / `filterDestination` / `filterCreatedAt` / `filterLastAppliedAt`。
- `MessageConfig`：`isPinned` / `isHidden` / `hiddenAtDate` / `unhideOnNew` / `forceFetch` / `roomId`（複合キー）。
- チャット単位とメッセージ単位は、画面では**別のマップ**（`chatConfigs` / `messageConfigs`）に持つ。

### 8.7 端末内の保存

**localStorage**（画面の状態。ログアウトで消す。ただし ⭐ はログアウトでも残す）

| キー | 中身 |
| --- | --- |
| `remail_selected_sender` | 開いているチャットの複合キー |
| `remail_draft_chats` | 下書きチャット（まだ送っていない新しい宛先のチャット）の一覧 |
| `remail_active_chat_tab` | 一覧のタブ（`individual` / `group` / `filter`） |
| `remail_scroll_aside_<タブ>` / `remail_scroll_main` | スクロール位置 |
| `remail_ui_state` | 開いていた画面の状態（復元用） |
| `remail_account_settings` | アカウントの表示チェックボックス（D1 から読み終えるまでの仮の値） |
| ⭐ `remail_use_icon_labels` | 文字／アイコン表示（D1 から読み終えるまでの仮の値） |
| ⭐ `remail_box_settings` | 場所のチェックボックス（既定は受信箱とアーカイブだけオン） |
| ⭐ `remail_chat_cache_limit` | チャットごとのメール一覧を何チャット分メモリに残すか（既定10、LRU） |
| `remail_device_owner` | この端末で最後に使った人（別の人がログインしたら前の人のデータを消すため） |

**IndexedDB（localforage）**

| ストア | キー | 中身 |
| --- | --- | --- |
| `drafts` | チャットの複合キー（`<アカウント>\u0000<ローカルキー>`） | 入力中の返信（本文・件名・返信元・添付・送信先 `recipients`〔`{ address, name?, role: "to"\|"cc"\|"bcc" }[]`。`null` は既定＝相手を To に1人〕・`recipientsBase`〔返信元を選んで置き換えたときの送信先〕）。読み戻すときに `normalizeRecipients` で壊れた値と上限を超えた分を捨てる |
| `pinned` | アカウント | ピン留めしたメールの中身（`id → Email`） |
| `attachments_v2` | `<アカウント(小文字)>\|<メッセージID>:<添付の番号>:<ファイル名>:<サイズ>`（attachmentId は取り直すたびに変わることがあるのでキーにしない）。画面のキーが無いときは `<アカウント>\|<メッセージID>:<attachmentId>` | 添付の base64 |
| `video_thumbs_v2` | 同上 | 動画のサムネイル（data URL と縦横比） |

- どれも localforage の `name: "remail"`。添付とサムネイルは、メモリのキャッシュ（`Map`）と IndexedDB の2段。
- localStorage の値が読めない（壊れている・複合キーでない）ときは無視して、既定の状態で動く（止めない）。
- **消す仕組み（`deviceData.ts`）**：すべてのアカウントからのログアウト（自分で押した・認証切れ）で、上のすべて（⭐ を除く）を消す。別の人がログインしたら、前の人のデータを消す。1つのアカウントだけをログアウトしたら、そのアカウントの分だけを消す。設定は D1 にあるので、ログアウトしても変わらない。
- 端末に新しく何かを置くときは、アカウント別のキーにし、`deviceData.ts` の消す対象に必ず足す。

---

## 9. API 仕様

すべての API はログインが必要で、ログインしていなければ（または `RefreshAccessTokenError` なら）`401 {"error":"Unauthorized"}` を返す。ユーザーの識別には `session.user.email` を使う。

### 9.1 `GET /api/accounts`
- 応答：`{ accounts: [{ account_email, needs_reauth, name, picture }] }`（`listLinkedAccounts` の結果。セッションを持つアカウントは含まない。セッションのアカウントはセッションから分かる）。

### 9.2 `DELETE /api/accounts?account_email=<アドレス>`
- セッションを持たないアカウントをログアウトする。`linked_accounts` の行を消す（`chat_configs` は残す）。応答：`{ success: true }`。セッションを持つアカウントのログアウトは、§7.4 の `update({ switchTo })` で行う。

### 9.3 `GET /api/accounts/connect`
- §7.3 のとおり。

### 9.4 `GET /api/avatar?name=<名前>`
- 40×40 の SVG を返す。名前の最初の1文字（大文字、太字16px、白、中央 `x=20 y=25`）を、名前のハッシュ（`hash = charCode + ((hash << 5) - hash)` を全文字で回し、`abs(hash) % 360` を色相にする）から決めた色（HSL、彩度55%・明度45%）の正方形の上に描く（丸く見せるのは表示側の `rounded-full`）。名前が無ければ `U`。`Cache-Control: public, max-age=2592000, s-maxage=2592000, immutable`（30日）。外部の画像サービスを使わないため自前で作る。

### 9.5 `/api/config`
すべて「ログインしているアカウント」（§8.3.1）を対象にする。
- `GET [?account_email=]`：`{ configs: [...], accountSettings: { <アカウント>: { alwaysLoadImages?, autoReadOnOpenChat?, autoReadOnOpenMail? } } }`。`openSessionConfigs` の結果を返す。共通設定の行は `custom_name` を復号した JSON 文字列にして返す。`account_email` を付けると、そのアカウントの行と予約行だけに絞る。
- `POST`：
  - `{ global_settings: {...} }` → `saveCommonSettings`（全アカウントに書く）。`{ success: true, settings }`。
  - `{ account_settings: {...}, account_email }` → `saveAccountSettings`。`account_email` がログインしているアカウントでなければ `400 { error: "Unknown account" }`。`{ success: true, settings }`。
  - `{ account_email, chat_id, custom_name, is_pinned, is_hidden, hidden_at_date, unhide_on_new }` → `saveSessionConfig`（そのアカウントの置き場所に書く）。`account_email` と `chat_id` が無ければ 400。`account_email` がログインしているアカウントでなければ `400 { error: "Unknown account" }`。
- `DELETE ?chat_id=&account_email=`（クエリ。どちらも必須）→ `deleteSessionConfig`。ログインしているアカウントでなければ 400。
- D1 の失敗・暗号化の鍵が無いときは `500 { error: "Database Error", details }` を返し、画面は `configSaveQueue` で送り直す（§12.6）。`/api/accounts` も同じ形で失敗を返す。

### 9.6 `GET /api/emails`（読み取り。パラメータで動きを切り替える。上から順に判定）
共通パラメータ `accountEmail`：どのアカウントのトークンを使うか。省略、またはセッションのアカウントならセッションのトークンを、それ以外は `linked_accounts` のトークンを使う（§7.3）。トークンが取れなければ 401。

Gmail の読み取りはすべて `fetchWithRetry` を通す（§10.1）。詳細取得の `fields` は `id,threadId,snippet,labelIds,payload(headers,parts,body)` に絞る。

| パラメータ | 動き | 応答 |
| --- | --- | --- |
| `messageId` ＋ `attachmentId` | 添付の中身を取る（`fake-` の ID なら取らない） | `{ data: base64url \| null }` |
| `sendAs=1` | 送信元エイリアスと署名の一覧。`isPrimary` か `verificationStatus === "accepted"` のものだけ | `{ sendAs: [{ sendAsEmail, displayName, replyToAddress, signature, isPrimary, isDefault }] }` |
| `sync=1` ＋ `historyId` | 差分同期（§13.4） | 下記 |
| `ids=<id,id,...>` | ID 指定で取る（16進6〜32文字だけ、重複を除いて最大50件、20件ずつ並列） | `{ messages, missing, failedIds }`（404・400 は `missing`） |
| `lookupByMessageId=<Message-ID>` | `rfc822msgid:` で検索して1件取る（迷惑メール・ゴミ箱も含む） | `{ found, email? }` |
| `messageId` ＋ `html=true` | HTML 本文（§11.4）。`full=true` なら加工しない HTML とテキストを返す | `{ htmlBody, hasHtml, inlineImages }` / `{ htmlBody, textBody, hasHtml }` |
| （上記以外） | 一覧（§11.1） | `{ messages, topIds, nextPageToken, failedIds }` |

**`sync=1` の詳細**
- `historyId` が無い（数字1〜20桁でない）とき：`/profile?fields=historyId` を取り、`{ historyId }` を返すだけ（起点を作る）。
- あるとき：`history.list` を `historyTypes=messageAdded,messageDeleted,labelAdded,labelRemoved`・`maxResults=500` で**最大5ページ**取る。
  - 404（起点が古すぎる）か、5ページで取り切れなかったら `{ reset: true }`（画面は一覧を取り直す）。
  - `summarizeHistory` で、新着・削除・ラベルが変わったメッセージにまとめる（§12.2）。
  - 新着は**最大100件**まで、**10件ずつ**詳細を取る。404 だったものは削除扱い。
  - 新着をすべて取れたとき（失敗が無く、100件以内）だけ `historyId` を最新に進める。取れなかったものがあれば元の `historyId` を返し、次回同じ位置から取り直す。
  - 応答：`{ historyId, messages, labelUpdates: [{ id, labelIds }], deleted }`。

### 9.7 `POST /api/emails`（`action` で切り替える）
本文に `accountEmail` を入れると、そのアカウントのトークンを使う。

| `action` | 本文 | 動き |
| --- | --- | --- |
| `send`（省略時も） | `to, cc, bcc, subject, body, bodyHtml, threadId, inReplyTo, references, from, replyTo, attachments[{filename,mimeType,data}], forwardAttachmentsFrom, messageId` | §10。宛先は `validateSendHeaders` で確かめ、1件も無ければ `400 NO_RECIPIENTS`、合計500件を超えたら `400 TOO_MANY_RECIPIENTS`、改行・形が正しくないアドレスがあれば `400 INVALID_RECIPIENTS`（宛先を勝手に直さない） |
| `verifySent` | `messageId, to, cc, bcc, subject, body, sentAfterMs` | 送信済みフォルダを照合し、`{ found, id?, threadId? }` |
| `delete` | `trashIds` | ゴミ箱へ移す（`TRASH` を付け、`INBOX`・`SPAM` を外す）。`permanentIds` が付いていれば `400 { error: "Permanent delete is not supported" }`（完全削除は `gmail.modify` では使えない。スコープは増やさない） |
| `move` | `ids`, `destination` | `labelChangeFor(destination)` のラベルを付け外しする（§12.2 の `mailboxOps.ts`）。移動先が `INBOX` / `ARCHIVE` / `SPAM` / `TRASH` 以外なら `400 { error: "Invalid destination" }` |
| `markRead` | `ids`, `read`（boolean） | 既読（`UNREAD` を外す）／未読（`UNREAD` を付ける）。`read` が boolean でなければ 400 |

- `move` / `delete` / `markRead` はすべて `batchModify`（`fetchWithRetry` を通す）。ID は `sanitizeMessageIds`（英数字1〜64文字だけ、重複を除く。`fake-` は外れる）で整え、**1000件ずつ**に分けて送る。対象が0件なら `{ success: true, count: 0 }`。
- Gmail が失敗したら、**成功と返さずに** `{ error: "Failed to <action>", reason }` をそのステータス（4xx/5xx）で返す。401 は `Unauthorized`。成功は `{ success: true, count }`。
- 1回のリクエストは1つのアカウント分（`accountEmail`）。画面は対象のメールをアカウントごとに分けて、それぞれ送る（§13.10）。

---

## 10. 送信の仕様（純正 Gmail と同じにする）

### 10.1 再試行の規則
- **読み取り・ラベル操作（`fetchWithRetry`）**：最大3回まで再試行する。
  - 5xx：`300 × 2^n` ミリ秒＋0〜200ミリ秒の揺らぎ。
  - 429 と、レート制限を表す 403：`Retry-After` があればそれ（上限10秒）、無ければ `2000 × 2^n` ミリ秒＋0〜500ミリ秒（約2秒→4秒→8秒）。画面を開いた直後の一括取得で上限に触れ、15秒ほどで戻ることを実機で確かめて延ばした。
  - レート制限の 403 とは、理由コード（`error.errors[0].reason`）が `rateLimitExceeded` / `userRateLimitExceeded` / `quotaExceeded` / `dailyLimitExceeded` のもの、または `error.status` が `RESOURCE_EXHAUSTED` のもの。
- **送信は `fetchWithRetry` を通さない。** `classifySendStatus` で結果を分ける。
  - `ok`：2xx。
  - `unauthorized`：401。
  - `retry`：429・レート制限の 403。Gmail が受け付けを断った＝送られていないので、待って再試行してよい（最大3回。待ち時間は `Retry-After`（上限10秒）か `500 × 2^n` ミリ秒＋0〜300ミリ秒）。3回とも断られたら `failed`。
  - `failed`：それ以外の 4xx。送られていないので失敗として返す。
  - `unknown`：5xx・タイムアウト（90秒）・通信断。**送れている可能性がある**ので再試行せず、§10.6 の照合に回す。

### 10.2 送り方
- **upload エンドポイント**（`https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart`、上限35MB）に送る。本体は `multipart/related` で、1つ目のパートがメタデータ JSON（`{"threadId": ...}`、無ければ `{}`）、2つ目が `message/rfc822` の組み立てたメール。raw を JSON に入れる方式は、数MB を超えると失敗していたので切り替えた。
- 添付の合計は純正 Gmail と同じ **25MB** が上限。画面（送る前）とサーバー（`413 Attachments too large`）の両方で確かめる。base64 で約1.37倍に膨らんでも 35MB に収まる。

### 10.3 メールの組み立て（`mime.ts`）
- メール全体を **7bit の ASCII** にする。ヘッダーは RFC 2047（`=?UTF-8?B?...?=`、1語45バイトまで、`CRLF＋空白` で折り返す。ASCII だけなら符号化しない）。本文はすべて base64（76文字で折り返す）。
- ヘッダーの値から CR・LF を取り除き、ヘッダーの差し込みを防ぐ。
- アドレスのヘッダー（From / To / Cc / Bcc / Reply-To）は、表示名だけを符号化し、`<アドレス>` はそのまま残す。
- **Bcc**：Bcc ヘッダーを入れた raw を `messages.send` に渡すと、Gmail が受信者側のメールからは取り除き、自分の送信済みにだけ残す（純正と同じ）。Bcc だけで送るとき（To が空）は To ヘッダーを付けない（中身の無い `To:` は RFC 5322 に合わない）。純正 Gmail で送った送信済みのソースでの Bcc の位置は §17.2 で確かめ、違えば純正に合わせる。
- 構造：
  - テキストと HTML の両方を `multipart/alternative` にする。
  - 本文中の画像（転送で引き継いだ cid: 画像）があれば、HTML と画像を `multipart/related` にまとめる。
  - 添付があれば、全体を `multipart/mixed` にする。添付のファイル名は `name=`（RFC 2047）・`filename=`（RFC 2047）・`filename*=UTF-8''...`（RFC 2231）を併記する。
  - 区切り文字は `remail_<UUID>`。
- **ヘッダーの並び**は純正 Gmail に合わせて `MIME-Version` → `References` → `In-Reply-To` → `From` → `Date` → `Message-ID` → `Subject` → `To` → `Cc` → `Bcc` → `Reply-To`（無いものは出さない）。
- **Message-ID は送る前にこちらで決める。** 形は純正 Gmail と同じ `<CA` ＋ 英数字40文字 ＋ `@mail.gmail.com>`。照合に使うためと、Re:Mail から送ったことが分からないようにするため。画面から有効な Message-ID が送られてくればそれを使う（再送で同じ ID を使えるように）。
- **Date ヘッダーは付けない**（Gmail が付ける。純正と同じ）。
- `From` は、既定ではない送信元エイリアスを使うときだけ付ける（既定なら Gmail が付ける）。

### 10.4 返信と宛先（`replyCompose.ts` / `recipients.ts` / `composeRecipients.ts`）
- **件名**：「Re: 元の件名」。すでに `Re:`（大文字小文字は問わない）で始まっていれば付け足さない。元の件名が空なら `Re: `。返信元があるときは件名の欄を出さない。
- **スレッド**：`In-Reply-To` に元の Message-ID、`References` に元の References ＋ 元の Message-ID（**直近20件まで**）、Gmail API の `threadId` を付ける。
- **宛先はすべて入力欄の「送信先」で決める**（To / Cc / Bcc。`{ address, name?, role }[]`）。以前の「Cc：〇〇さん ほか2名」と「全員に返信」の切り替え（`replyAll`）はなくした。
  - 既定は**開いているチャットの相手を To に1人**。同じアドレスは1回だけで、重なったら To > Cc > Bcc の順で残す（`normalizeRecipients`）。合計500件（純正 Gmail の1通あたりの上限）、1件のアドレスは320文字まで。形が正しくないアドレスは足さない。
  - **返信元を選んだとき**（`replyChoices`。返信元の画面で選んだときも、アクションバーの「リプライ」でも同じ）：先に**そのアカウントの sendAs が読めるまで待つ**（自分のエイリアスを送信先から除くため。待つあいだは「送信元の設定を読み込んでいます…」。待つあいだにほかのチャットへ移ったり別のメールを選び直したりしたら何もしない）。読めなかったときは、送るときの確認と同じく「署名と送信元の設定を読み込めませんでした。純正 Gmail と違い、自分のエイリアスが送信先に入ることがあります（そのときは自分にも届きます）。このまま送信先を決めますか？」（「このまま決める」「送信先はそのまま」）と確かめる。そのうえで、返信元の `planReply(...).extra` が空でなければ（自分と相手以外の宛先があれば）確認画面で選んでもらい、送信先を**置き換える**。
    - 「返信」：今のチャットの相手（To）＋ `planReply(...).senderOnly`（To。Reply-To があればそちら、自分が送ったメールなら元の To）
    - 「全員に返信」：今のチャットの相手（To）＋ `planReply(...).all`（To は To、Cc は Cc）
    - Bcc は入れない（受け取ったメールには残らないため）。自分のアドレスとすべてのエイリアスは除く。確認画面には、それぞれ実際に入る宛先（名前・アドレス・立場）を並べる。`extra` が空なら確認なしで「返信」と同じに入れる。
    - 送信先を自分で変えていた（既定または前回の置き換えから足した・外した）ときは、先に「送信先を置き換えます。自分で足した人は外れます。」と確かめる（「送信先はそのまま」を選ぶと、返信元だけ変えて送信先は変えない）。
  - **今のチャットの相手が送信先から外れたとき**（`excludesPartner`）：送信先が1人以上残っていれば、確認画面を1つだけ出す（「〇〇さんを外すと、このチャットからは送れません。△△さんとのチャットに移って続けますか？ 入力中の本文・添付・送信先・返信元はそのまま持っていきます。」「移る」「やめる」）。△△さんは To の最初、無ければ Cc の最初、無ければ Bcc の最初（`pickMoveTarget`）。移り先は同じアカウントのその相手のチャット、無ければ下書きチャット。移り元の下書きは、移り先で読み戻せたら消す（二重送信を防ぐ。移り先に書きかけの下書きがあれば、どちらも消さずに残してトーストで伝える）。「やめる」ならその変更をしない。送信先が0人になったときは移らず、送信ボタンを押せなくして「送信先がありません」と出す。送る直前にも同じ条件を確かめる。
  - **引用が元のやり取りにいなかった人に届くとき**（`quoteGoesToOutsiders`）：返信元があり、送信先に返信元のメールの差出人・Reply-To・To・Cc（自分を除く）が1人もいなければ、送る前に「元のメールの内容（引用）が、元のやり取りにいなかった人に届きます。送りますか？」と確かめる。
  - グループチャットの送信先はメンバー全員の To で固定し、編集できない（グループから送ったメールの判定を崩さないため）。
- **送信元（`pickSendAs`）**：Gmail の sendAs 設定に従う。元のメールの宛先に自分のエイリアスが入っていればそのエイリアスから、そうでなければ既定の送信元から（純正の「受信したアドレスから返信する」と同じ）。
- **署名**：sendAs の署名を使う。並びは純正の既定と同じ「本文 → 引用 → 署名」。テキストでは `-- `（ハイフン2つと空白）の行のあとに署名を置く。HTML では `<div class="gmail_signature">` で囲む。
- **引用**：`gmail_quote` 形式で、やり取り全体（さらに前の引用を含む）を入れる。見出しは `2026年1月1日(木) 10:00 名前 <アドレス>:` の形（`formatQuoteHeader`）。HTML は `<div class="gmail_quote"><div class="gmail_attr">見出し<br></div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">…</blockquote></div>`。引用の元は `html=true&full=true` で取った加工しない本文。Re:Mail の画面では引用を折りたたむ。
- **sendAs の読み込み**：10分キャッシュする。失敗したら4秒待って1回だけ取り直す。それでもだめなら、**送る前に「署名なし・既定のアドレスで送りますか」と確かめる**（ボタン「このまま送る」）。黙って署名なしで送らない。

### 10.5 転送
- 宛先選びは新規作成と同じモーダル（`compose_new_chat` の `composeMode: "forward"`）。ボタンは「転送」。
- 件名は「Fwd: 元の件名」（すでに `Fwd:` / `Fw:` で始まっていれば付け足さない）。本文は純正と同じ見出し `---------- Forwarded message ---------` に、From・Date・Subject・To（・Cc）を並べ、元の HTML・テキストを続ける（`composeForwardBodies`）。
- **元のメールの添付と本文中の画像（cid:）は、サーバーで元のメールから取り直して一緒に送る**（`forwardAttachmentsFrom` に元のメッセージ ID）。本文から参照されている cid: 画像は `multipart/related` のインライン画像に、それ以外は添付にする。
- 取れなかったら**送らずに** `502 { error: "FORWARD_ATTACHMENTS_FAILED", stage, status, reason }` を返す（`stage` は `list` / `tooLarge` / `get` / `empty` / `exception`）。画面は理由を伝え、利用上限のときは「1分ほど待ってから」と案内する。25MB を超えるなら送る前に止める。
- `In-Reply-To` / `References` / `threadId` を付ける（純正の転送と同じく元のスレッドに入る）。
- 転送中は「転送しています…」、終わったら「転送しました」と表示する。送信直後で実 ID がまだ無いメール（`fake-`）は転送できない旨を伝える。

### 10.6 二重送信・送信漏れを防ぐ流れ
1. 入力中の内容（本文・件名・返信元・送信先・添付）は、チャットごとに端末へ下書き保存してある（§13.7）。
2. 送信ボタンは、1回押したら終わるまで押せなくする。
3. **成功**（Gmail が ID を返した）：画面に送ったメールを足し、下書きを消す。送った添付は、あとで見るときに取り直さなくて済むよう、添付キャッシュに先に書いておく。
4. **`failed`**：原因を表示し、下書きは残す。
5. **`unknown`**：サーバーが `findSentMessage` で送信済みフォルダを照合する。1.5秒待って1回目、4秒待って2回目。
   - まず自前の Message-ID で `rfc822msgid:` 検索する。
   - 見つからなければ、`in:sent after:<送信の60秒前>` の直近10件を、件名（空白を除いて比較）・To と Cc と Bcc の集合（送信済みには Bcc が残るので、Bcc だけの送信でも照合できる。メタデータは `metadataHeaders` に Bcc を足して取る）・時刻（送信の60秒前以降）・本文の冒頭（最大40文字。Gmail の snippet の文字参照を戻して比較）で照合する。
   - 見つかれば成功（`verified: true`）。見つからなければ `502 { error: "SEND_UNCONFIRMED", messageId }`。
   - 画面は `SEND_UNCONFIRMED` を受けたら `verifySent` でもう一度確かめ、それでも見つからなければ「送信されていません。再送しますか？」と**ユーザーに確かめる**。**自動では再送しない。** 再送するときは同じ Message-ID を使う。
6. 実 ID が取れなかったとき（照合でも ID が分からないとき）だけ、画面に `fake-` で始まる仮 ID のメールを置く。次に一覧を取ったとき、`reconcileFakeSentEmails` で本物と重複する仮のメールを消す。仮 ID は Gmail に存在しないので、API に渡さない。

---

## 11. 受信・解析の仕様

### 11.1 一覧の取得
- パラメータ：`q`（Gmail の検索式）・`maxResults`（既定10）・`pageToken`・`includeTrash`（`includeSpamTrash=true` にする）・`knownIds`（取得済みの ID。カンマ区切り）。
- `messages.list` で ID を取り、`knownIds` に無いものだけ**20件ずつ並列で**詳細を取る。
- 詳細が取れなかったものは捨てずに `failedIds` で返す（404 は消えたものとして数えない）。画面は「読み込めなかったメールが○件あります（再試行）」と出し、再試行では**そのメールだけを `ids=` で取り直す**（50件ずつ）。一覧ごと取り直すと利用上限にすぐ触れ、実機でかえって読み込めない数が増えたため。
- 一覧取得そのものが 429 なら `429` を返し、画面は時間をおいて取り直す。

### 11.2 入力の上限（ルール3-4）
Workers では処理中に時計が進まないので、「○ミリ秒で打ち切る」ことができない。だから**後戻りが爆発する正規表現を使わず（前から1回なめる）、長さと数に上限を置く**。

| 対象 | 上限 |
| --- | --- |
| MIME の入れ子の深さ | 30 |
| 1通で見る MIME パートの数 | 500 |
| 整形する本文の長さ | 30万文字（超えたら整形せず先頭だけを出し「全文は Gmail で確認」と添える） |
| CSS を探す本文の長さ | 10万文字 |
| リンク抽出・転送判定にかける HTML | 200万文字 |
| 取り出すリンクの数 | 300（リンクの文字は150文字まで） |
| HTML 本文で返す cid: 画像の数 | 30 |
| 画面で差し込む cid: 画像1枚の大きさ | 10MB |

### 11.3 解析（`messageParse.ts`）
- **文字コード**：Gmail API はテキストのパートを UTF-8 に直して返すのに、charset ヘッダーは元のまま残す（実機で確認）。そのため、**まず UTF-8（不正なら例外にする設定）として読み**、UTF-8 として正しくないとき・ISO-2022-JP の切り替えの印（ESC `$B` など）があるときだけ、書かれた charset（ISO-2022-JP・Shift_JIS・EUC-JP など。別名は `normalizeCharset` で揃える）で読み直す。
- **ヘッダー**：`decodeMimeHeader` で RFC 2047 を戻す。同じ charset の隣り合った符号化語は、間の空白を除いてつなげる（折り返された日本語の件名に空白が入らないように）。
- **本文**：`text/plain` を優先し、無ければ HTML からテキストを作る（`getTextBody`）。HTML は最も長い `text/html`（`getHtmlBody`）。
- **整形（表示上だけ）**：
  - `stripQuotedReply`：最初の `>` 行から後ろを引用として折りたたむ。その直前（空行をさかのぼった行）が引用の見出し（`YYYY年M月D日`・`さんは書きました`・`On ... wrote:`）ならそこから折りたたむ。`>` 行が無くても、末尾に残った日英の見出し行以降は取り除く。
  - `stripLooseCssRules`：壊れた text/plain に紛れ込んだ CSS の規則を取り除く（10万文字まで）。
  - `cleanseBody`：これらをまとめて行う（30万文字まで）。
  - `stripHtmlQuote`：HTML の `gmail_attr` / `gmail_quote` の div や blockquote 以降を取り除く。
  - `looksLikeForward`：件名が `Fwd:` / `Fw:` で始まるか、本文（200万文字まで）に `forwarded message` があり、その行が `>` で始まっていなければ転送メールとみなす。転送なら引用を取り除かない（中身そのものなので）。
- **リンク**：`extractHtmlLinks` で HTML の `<a href>` を `indexOf` でなめて取り出す（`https?://` だけ）。テキスト版の本文ではリンク先が失われるため。
- **添付**：`extractAttachments` で添付の一覧を作る。S/MIME の署名（`application/pkcs7-signature` など）は除く。本文から cid: で参照されていない名前のないインライン画像（iPhone のメールの写真など）は `image.<拡張子>` という名前を付けて添付として並べる（どこにも出ずに消えないように）。
- **`parseMessageDetail`**（`Email` 型に変える）：`subject`（無ければ「(件名なし)」）・`from`・`to`（無ければ `Delivered-To`）・`cc`・`bcc`（自分が送ったメール＝送信済みにだけ入る）・`replyTo`・`date`・`messageIdHeader`・`references`・`inReplyTo`（転送メールでは付けない）・`isForward`・`body`（整形後）・`snippet`・`labelIds`・`attachments`・`htmlLinks`・`hasHtml`。

### 11.4 HTML 本文（`html=true`）
- `fields=payload` で取り、`getHtmlBody` で最も長い HTML を選ぶ。転送メールでなければ `stripHtmlQuote` で引用を除く。
- 本文から `cid:` で参照されている画像の情報（`contentId`・`attachmentId`・`mimeType`・`size`）を最大30件返す。画面は本文を先に出し、画像は**同時に3枚まで**添付 API で取りにいって、あとから差し込む（`replaceCidImages`）。サーバーにも端末にも保存しない。1枚が10MB を超えるものは差し込まず、「Gmail で開く」を案内する。
- 表示の下ごしらえ（`emailHtml.ts`）は §15.3。

---
## 12. `app/lib/` モジュール仕様

React に依存しない純粋関数を置く。ほぼすべてに `*.test.ts` がある。★の付いたものは、**既存のデータとの互換や送信の忠実性に直結する**。変えるときは、§8.2 の形・§10 の送信の仕様を崩していないかをテストと §17.2 の比較テストで確かめる。

### 12.1 キー・グルーピング・フィルター
| ファイル | 役割 |
| --- | --- |
| ★`roomKey.ts` | `encodeRoomKey(account, localKey)` / `decodeRoomKey(roomKey)`。区切りは `\u0000`（表示名やアドレスに絶対に出てこない文字）。`LocalKey` / `RoomKeyStr` の branded type、`asLocalKey`、`keysOf`。**区切り文字で直接 `split` してはいけない** |
| `groupEmails.ts` | `groupEmailsByRoom(emails, myAddress, chatConfigs, myAliases)`：1アカウント分をローカルキーでまとめる（エイリアスは Reply-To が自分宛てかの判定にだけ使う）。`mailPartnerOf`：受け取ったメールの相手（Reply-To 優先）。`roomPartner`：ルームの相手の表示名とアドレス（画面の `getRoomAddress` / `getRoomRecipient` が使う）。`mergeAccountGroups`：アカウントごとの結果を複合キーにして合体する。`applyFilterGroups`：フィルターで作ったグループを、全アカウントのメールから組み立てる（下記）。`groupMemberAddresses`：グループのメンバーの保存したアドレス |
| `filterMatch.ts` | `isMineEmail`・`getFindBarBoxKey`・`BOX_KEY_TO_LABEL`・`isActionBoxRestricted`・`messageMatchesFilter`・`getConditionSets`・`chatConfigTab`・`isEmptyFilterCriteria`（下記） |
| `mailboxOps.ts` | 移動・削除・既読／未読のラベル（`labelChangeFor`：`INBOX` は INBOX を付け TRASH・SPAM を外す／`ARCHIVE` は INBOX・TRASH・SPAM を外すだけ（Gmail にアーカイブのラベルは無い）／`SPAM` は SPAM を付け INBOX・TRASH を外す／`TRASH` は TRASH を付け INBOX・SPAM を外す。`readLabelChange`）、`sanitizeMessageIds`、`chunkIds`（`BATCH_MODIFY_LIMIT = 1000`）、`groupIdsByAccount`。サーバーと画面の両方で使う |
| `groupPaging.ts` | グループチャットの、メンバーごとのページトークンの状態をまとめる。`PAGING_DONE_STATES = ["END_ALL", "END_LIMIT"]`、`pendingMembers`、`aggregateGroupPagingState`（まだ読める人がいれば `MORE`） |
| `searchFallback.ts` | サーバー検索を、同じ語・同じ項目で二度撃たないための判定（`shouldTriggerServerSearch` / `markServerSearched`。対象の項目は `subject` / `body`） |

**`isMineEmail(email, myEmail | myEmail[])`**：`email.isMe` が true なら自分。そうでなければ、From の `<アドレス>`（無ければヘッダー全体）を小文字にして、自分のアドレス（複数可）と**完全一致**で比べる。`.includes` で部分一致させてはいけない（`a@gmail.com` が `ba@gmail.com` を自分と誤判定する）。

**保存場所の判定（`getFindBarBoxKey`）**：`SENT` か `isMe` なら送信済み → `TRASH` ならゴミ箱 → `SPAM` なら迷惑メール → `INBOX` なら受信箱 → どれでもなければアーカイブ。

**操作できない場所（`isActionBoxRestricted`）**：ピン留め・非表示はゴミ箱と迷惑メールではできない。削除はゴミ箱と送信済みではできない。移動は送信済みではできない。既読・未読にするはどこでもできる。

**グルーピング（`groupEmailsByRoom`）の規則**（ここを変えると既存のチャットの分かれ方が変わる）：
1. `senderRoom` が付いたメールは、そのルームに入れる。
2. 自分のメールでなければ、相手を決める（`mailPartnerOf`）。**Reply-To に自分（エイリアスを含む）以外のアドレスがあれば、その最初のアドレスをそのメールの相手にする**。ルーム名は Reply-To の表示名、無ければ Reply-To のアドレス（From の表示名は使わない。問い合わせフォームのように From が共通で Reply-To が人ごとに違うメールを、1つのチャットに混ぜないため）。Reply-To が無ければ、From の表示名（`<` の前、`"` を除いて trim。空なら `Unknown`）をルーム名にする。
3. 自分が送ったメールは、まずメモリ上で `INBOX` ラベルを外す。**To / Cc / Bcc のどれかに相手のアドレス（またはルーム名と同じ表示名・アドレス）が入っている、同じアカウントの個人チャットすべてに入れる**（完全一致。部分一致では入れない。グループのルームは対象外）。どれにも当たらなければ、To の最初の宛先の表示名（無ければアドレス）、To が無ければ Cc、Cc も無ければ Bcc の最初で新しいルームを作り、あとの送ったメールの照合先にもする。`isMe: true` を付ける。1通が複数のルームに入るので、画面の `emailRoomMap`（メッセージ ID → ルーム）は「どれか1つのルーム」を返す。アカウントの判定にはそのまま使える（どのルームでも同じアカウント）。ピン留め・非表示で覚えるルームは、開いているチャットに入っていればそのチャットにする（`roomOfMessage`）。
4. まだ返信が無くアドレスそのものがルーム名になっているルームは、同じアドレスの表示名ルーム（グループではないもの。相手のアドレスは Reply-To 優先）があれば、そちらに統合する（同じ相手のチャットが2つに分かれないように）。
5. グループ（`isGroup` かつ `filterCriteria` が無いもの）：メンバーの実アドレスは `groupMemberAddresses`（作成時に確定した値。関数 `groupMemberAddresses(cfg)` で読む）だけを使う。保存が無い・数がメンバーと合わない（壊れた）グループは空にし、受信メールから推定しない（そのグループには送信もしない。§13.8）。**グループから送ったメール＝To の宛先の集合がメンバー全員と完全に一致する自分のメール**（D1 には何も残さず、毎回 To から判定する）。それを各メンバーの個別チャットにも入れる。モードが `outbound_only` なら送ったメールだけ、`inbound_only` ならメンバーから届いたメールだけ、`normal` なら両方。
6. 各ルームを日時の新しい順に並べる。

**フィルターグループ（`applyFilterGroups`）**：`filterCriteria` を持つグループは、**そのグループのアカウント（roomKey のアカウント）のメールだけ**から `messageMatchesFilter` で一致するものを集める（ほかのアカウントのメールは混ぜない）。`filterIncludeExisting === false` なら `filterCreatedAt` より後のメールだけ。`filterHideOriginal` なら、一致したメールを**同じアカウントの**ほかのルームから除く（毎回計算し直すので、オフにすれば元に戻る）。

**フィルター条件（`FilterCriteria`）**：
```ts
type TextRule = { field: "recipientName" | "recipientAddress" | "subject" | "body"; mode: "contains" | "not_contains"; keyword: string };
type ConditionSet = {            // セットの中は AND
  direction?: "received" | "sent";
  textRules?: TextRule[];
  dateRange?: { from?: string; to?: string };   // "YYYY-MM-DD"（閲覧者の地域時間のその日の 0:00〜23:59:59.999）
  hasAttachment?: boolean;
  isReply?: boolean;             // replyToId か inReplyTo があるか
  isForward?: boolean;
  format?: "html" | "text";
  isUnread?: boolean;            // 未読か（UNREAD ラベル）
};
type FilterCriteria = {
  conditionSets?: ConditionSet[]; // セットどうしは OR。空なら場所とアカウントだけで絞る
  boxes?: ("inbox" | "archive" | "sent" | "spam" | "trash")[];
  accountEmail?: string;          // このフィルターのアカウント。必ず入る。無いフィルターは壊れた設定として、どのメールにも一致させない
};
```
- 相手の名前・アドレスの条件は、`direction` が `sent` なら To、`received` なら From、未指定なら「自分でない方」を見る。比較は小文字にした部分一致。
- 語が空・壊れている条件、`accountEmail` の無いフィルター、`conditionSets` が配列でないフィルターはどのメールにも一致させない。`messageMatchesFilter` 全体を `try/catch` で囲み、例外なら「一致しない」にする（壊れた設定で画面を落とさない）。
- `isEmptyFilterCriteria`：条件セットも場所もアカウントも無いフィルターは、誤って全件に効かないよう弾く。

### 12.2 同期・解析・送信
| ファイル | 役割 |
| --- | --- |
| `historySync.ts` | `summarizeHistory(records)`：history の記録を「新着 `added`・削除 `deleted`・ラベルが変わった `labels`（変わった後のラベル）」にまとめる。新着のあとに消えたものは両方から外す。新着のラベルはまとめない（詳細を取るので）。`matchesBoxFlags(labelIds, flags)`：今のチェックボックスで表示する場所か（下書きは出さない。迷惑メール・ゴミ箱・送信済みのどれもオフなら、迷惑メールとゴミ箱は出さない。アーカイブがオンなら「受信箱がオン、または受信箱ではない」）。`applySyncResult`：削除を外し、ラベルを書き換え、新着を足す（すでに画面にあるか、表示する場所に入るものだけ）。`idsToFetchForLabelChanges`：ラベルの変化で表示する場所に入ってきた、画面に無いメールの ID |
| ★`messageParse.ts` | §11.3 |
| ★`mime.ts` | §10.3。`buildMimeSegments`・`buildGmailUploadBody`・`encodeMimeHeader`・`decodeMimeHeader`・`formatAddressHeader`・`splitAddressList`・`parseAddress`・`normalizeCharset` |
| ★`replyCompose.ts` | §10.4・§10.5 |
| ★`recipients.ts` | §10.4。`planReply`（純正 Gmail と同じ返信・全員に返信の宛先） |
| ★`composeRecipients.ts` | §10.4。入力欄の送信先：`normalizeRecipients`（重なり・上限・形）・`recipientsFromHeader` / `recipientsHeader`・`summarizeRecipients`（「山田さん ほか2名（Cc 1・Bcc 1）」）・`pickMoveTarget`・`excludesPartner`・`replyChoices`・`originalParticipants`・`quoteGoesToOutsiders`・`validateSendHeaders`（サーバーの宛先の検証）・`sentRecipientCounts` / `receivedRole`（宛先の表示設定） |
| ★`sendVerify.ts` | §10.1・§10.6 |
| ★`emailHtml.ts` | §15.3 |

### 12.3 暗号・保存
| ファイル | 役割 |
| --- | --- |
| ★`tokenCrypto.ts` | `encryptSecret` / `decryptSecret` / `hmacId` / `EncryptionKeyMissingError`（§8.2。鍵が無ければどれも例外） |
| ★`addressKey.ts` | `normalizeAddress` / `isAddressKey` / `addressKeyFor`（`a1:`。空のアドレスは例外） |
| ★`configCrypto.ts` | `sealRow` / `openRow`（`h1:` と封筒。`openRow` は `sealRow` の形でない行を `null` にする）、`isReservedRow`、`isSealedChatId` |
| ★`configStore.ts` | §8.3・§8.3.1（`openConfigs`・`openSessionConfigs`・`saveSessionConfig`・`deleteSessionConfig`・`saveCommonSettings`・`saveAccountSettings`・`UnknownAccountError`） |
| `googleScopes.ts` | `GOOGLE_OAUTH_SCOPE`（§7.1） |
| `linkedAccountsStore.ts` | §8.4（`promoteLinkedAccount`、設定の読み書きで使う軽い `listLinkedAccountEmails` を含む） |
| ★`syncedSettings.ts` | **共通設定**（`SYNCED_SETTING_TYPES`）：`inbox` / `archive` / `spam` / `trash` / `sent` / `iconLabels`（boolean）、`accounts`（アドレス → boolean、最大50件、アドレスは320文字以内で `^[^\s@]{1,64}@[^\s@]{1,255}$`）、`updatedAt`（ミリ秒。写しのどれが新しいかを決める）。画面が持つのは `COMMON_SETTING_KEYS`（`updatedAt` を除く）。**アカウント設定**（`ACCOUNT_SETTING_TYPES`）：`alwaysLoadImages` / `autoReadOnOpenChat` / `autoReadOnOpenMail`（boolean）。`sanitizeSyncedSettings` / `sanitizeAccountSettings` は一覧に無いものを捨てる。`syncedSettingsKey`（名前の順番に左右されない比較用の文字列）・`pickCommonSettings`・`newestCommonSettings` |
| `pinnedIds.ts` | `MAX_PINNED_IDS_PER_CHAT = 60`、`isGmailId`（16進6〜32文字）、`readPinnedIds`（`ids` だけを読む）、`capPinnedIds`、`mergePinnedIds`、`missingPinnedEmail`（消えていたメールの代わりに置く「このメールは存在しません」の仮のメール。`isMissing: true`）、`stripPinnedBodies`（保存の前に JSON から `data` を取り除く守り） |
| `pinnedCache.ts` | ピン留めの中身の端末キャッシュ（ストア `pinned`、キーはアカウント） |
| `drafts.ts` | `loadDraft` / `saveDraft`（空なら消す）/ `removeDraft` / `removeAccountDrafts` / `clearDrafts`。`ComposeDraft = { subject, body, replyToMessage, attachments[{filename,mimeType,size,data}], updatedAt }` |
| `attachmentCache.ts` | §8.7 |
| `deviceData.ts` | §8.7。`clearDeviceData()`（ログアウト：`remail_` で始まる localStorage のキーを `KEEP_ON_LOGOUT` 以外すべて、sessionStorage の `remail_` のキーすべて、添付・ピン留め・下書きのストア、`localforage.clear()`）。`clearAccountDeviceData(account)`（1つのアカウントだけのログアウト：`remail_account_settings` と `remail_draft_chats` からそのアカウントの分を除き、開いていたのがそのアカウントのチャットなら `remail_selected_sender` と `remail_scroll_main` を消し、`remail_ui_state` は丸ごと消す。添付・ピン留め・下書きはそのアカウントの分だけ消す）。`DEVICE_OWNER_KEY = "remail_device_owner"` |

### 12.4 トークン・ログ・そのほか
| ファイル | 役割 |
| --- | --- |
| `googleToken.ts` | `getValidAccessToken(account, accessToken, expiresAt, refreshToken)`。期限まで60秒より余裕があればそのまま返す。そうでなければ `https://oauth2.googleapis.com/token` で `grant_type=refresh_token`。**同じアカウントへの同時のリフレッシュは、メモリ上の `inFlightRefreshes`（Map）で1回にまとめる**（同じ Worker インスタンスの中だけの対策）。失敗したら Google の応答（`error` を含む）を投げる。新しい `refresh_token` が返ればそれも返す |
| ★`safeLog.ts` | `logError` / `logWarn` / `logInfo`（§15.4） |
| ★`securityHeaders.ts` | §15.1 |
| `configSaveQueue.ts` | §12.6 |
| `gmailLink.ts` | `gmailOpenUrl(account, threadId)` → `https://mail.google.com/mail/?authuser=<アカウント>#all/<スレッドID>`（スレッド ID が16進でなければ `#inbox`） |
| `videoThumbnail.ts` | 動画の Blob から `<video>` でサムネイルを作る。0.3秒の位置に移動して canvas に描き、JPEG（品質0.7）の data URL と縦横比を返す。8秒で諦める |
| `errorMessage.ts` | `unknown` のエラーから文字列を取り出す（画面の表示用。ログには使わない） |
| `fakeD1.testutil.ts` | テスト用の D1 の偽物（`migrations/` を本物の SQLite に当てる。途中まで当ててから `applyMigration` で残りを当てることもできる） |
| `publicSession.ts` | §7.2 |

### 12.5 型（`app/types/email.ts`）
`Email`：`id` / `threadId` / `subject` / `from` / `to` / `cc?` / `replyTo?` / `date` / `body` / `snippet` / `labelIds` / `isMe?` / `senderRoom?` / `attachments?: EmailAttachment[]` / `htmlLinks?: {text, href}[]` / `hasHtml?` / `replyToId?`（返信元のローカル ID）/ `inReplyTo?` / `messageIdHeader?` / `references?` / `isForward?` / `accountId?`（どのアカウントのメールか）/ `isMissing?`。
`EmailAttachment`：`filename` / `mimeType` / `size` / `attachmentId?`（送った直後のメールには無い）。

### 12.6 設定の保存の送り直し（`configSaveQueue.ts`）
- 設定の保存（`/api/config` の POST・DELETE）が、通信断・408・429・5xx で失敗したら、**2秒・5秒・15秒・30秒・60秒あとに**自動で送り直す（合計約2分）。`online` イベントが来たらすぐ送る。
- 設定の保存は上書きなので、何度送っても害が無い（メールの送信とは違う）。
- キーは行（アカウント＋chat_id、共通設定は専用のキー）ごと。同じ行に新しい保存が来たら、古い値は送らない。
- 400・401 など、送り直しても結果が変わらない失敗と、送り直しても届かなかったときは、トーストで伝える。送り直しの待ちに入ったときは「通信が戻りしだい自動でもう一度保存します。保存できるまでページを閉じないでください。」と伝える。
- 送り直す中身は相手の名前などを含むので、**端末に保存しない**（メモリだけ）。再読み込みすると消えることを画面で伝える。

---

## 13. 中核ロジック `useMailApp.ts`

`page.tsx` と各コンポーネントは、このフックが返す `{ state, actions, computed, refs }`（型 `MailAppHook`）を受け取って描画するだけにする。ロジックはここに集める。

### 13.1 初回の読み込み
1. ログインが済んだら、`remail_device_owner` で端末の持ち主を確かめる。別の人が記録されていれば `clearDeviceData()` してから自分を記録する（共有 PC 対策）。
2. D1 の設定（`/api/config`。チャットの設定・共通設定・アカウント設定）とほかにログインしているアカウント（`/api/accounts`）を**並列で**読む。失敗したら1.5秒待って1回だけ取り直し、それでもだめならトーストで伝える（「ピン留め・名前変更などの設定を読み込めませんでした…」）。
3. 共通設定を `applySyncedSettings` で、アカウント設定を `accountSettings` に入れて画面に当てる。**D1 から読み終えるまでは共通設定を保存しない**（ほかの端末で変えた設定を、この端末の古い値で上書きしないため）。それまでは localStorage の仮の値で表示する。
4. ログインしている全アカウントのメールを `mapWithConcurrency`（**同時3件**）で取り、各メールに `accountId` を付ける。1回に取る数は合計100件を、表示するアカウントで分ける。ページトークンと読み込み完了の状態（`END_ALL` / `END_LIMIT`）はアカウントごとに持つ。
5. 一覧を取る**前に**、各アカウントの `historyId` の起点を `sync=1`（historyId なし）で取っておく（一覧を取っている間に届いたメールを取りこぼさないため）。
6. 開いていたチャット・画面の状態・スクロール位置を localStorage から戻す。

### 13.2 一覧の検索式
チェックボックスの状態から Gmail の検索式を作る。
- アーカイブがオン：受信箱もオンなら条件なし、受信箱がオフなら `-in:inbox`。
- アーカイブがオフ：オンの場所を OR でつなぐ（受信箱 `in:inbox`、送信済み `from:me`、迷惑メール `in:spam`、ゴミ箱 `in:trash`）。
- 迷惑メール・ゴミ箱・送信済みのどれかがオンなら `includeTrash=true`。
- 下書きは出さない。

### 13.3 アカウントの 401 の扱い
- セッションのアカウントで 401 / 403 が返ったら、§7.2 のとおり、セッションを取り直してから判断する。本当に無効なら `clearDeviceData()` → `signOut()` → 再読み込み。一時的なら「Gmail との接続が一時的に切れました。しばらくすると自動でつながります。」と伝える。
- ほかのアカウントで 401 なら、そのアカウントだけを止め、`needs_reauth` を画面に反映して再ログインを案内する（「ログインが切れているため、このアカウントのメールが読み込めていません。「再ログイン」からログインし直してください。」）。ほかのアカウントは続ける。

### 13.4 自動更新（差分同期）
- **60秒ごと**（タブが見えているときだけ）・タブに戻ったとき（`visibilitychange`）・通信が戻ったとき（`online`）に、`syncOrRefetch` を呼ぶ。
- 各アカウントで `sync=1&historyId=…` を呼び、`applySyncResult` で画面に当てる。`idsToFetchForLabelChanges` で出てきた、画面に無いのに表示する場所へ入ってきたメールは `ids=` で詳細を取る。
- `reset: true` が返ったら、そのアカウントの一覧を取り直す（取りこぼしを残さない）。
- 以前は約1分ごとに最新100通の詳細をすべて取り直しており、Gmail API の利用上限をすぐに使い切っていた。history.list は1回2ユニットで、詳細を取るのは新着だけ。

### 13.5 チャットを開いたとき
- **クロスボックス取得**：その相手について、全部の場所を横断して取る。検索式は `(from:"相手" OR to:"相手")` に、分かっている相手のアドレスを OR で足したもの。`maxResults=100`、`knownIds`（最大300件）で取得済みの詳細は取り直さない。
- 開いているチャットに、チェックボックスでオフにしている場所のメールが含まれるときは、トークの中に「{場所}のメールが含まれています。読み込みますか？」のボタンを出し、押したら出す。
- グループチャットは、メンバーごとに独立したページトークンで読み進め（`GROUP_MORE_<時刻>` の印で次を読む）、`groupPaging.ts` で全体の状態をまとめる。
- チャットごとのメール一覧はメモリに LRU で残す（既定10チャット分）。
- ピン留めの中身は、端末キャッシュ（`pinnedCache`）から先に出し、足りない分だけ `ids=` で取る。Gmail で消えていたものは `missingPinnedEmail` で「このメールは存在しません」と出す。

### 13.6 無限スクロール
一覧・トークとも、下（トークは上）まで来たら次のページを読む。画面が埋まらないときも、埋まるまで自動で読む。

### 13.7 下書き
- 入力中の返信（本文・件名・返信元・送信先・添付）を、**チャットごとに** IndexedDB に保存する（`drafts.ts`）。送信先は既定（相手を To に1人）のままなら保存しない（`null`）。送信の失敗・通信断・再読み込み・チャットの切り替えで失わない。空なら消す。
- チャットを切り替えたら、そのチャットの下書きを読み込む。読み込み終わるまで送信ボタンを押せなくする（`isDraftReady`）。以前は、別のチャットで書きかけた文が今のチャットに残って誤送信される問題があった。
- 端末に保存できなかったら「入力中の内容を端末に保存できませんでした。再読み込みすると消えます…」と伝える。
- **下書きチャット**：新しい宛先でチャットを作って、まだ送っていない状態。`remail_draft_chats` に持ち、送ると普通のチャットになる。ほかのチャットへ離れたとき、**書いた内容（本文・件名・添付・返信元）もその相手とのやり取りも無ければ**、一覧から消し、下書き（送信先を変えただけのものも）も消す。書いた内容があれば残す（離れる直前の入力はすぐ保存する）。入力を持って移った（送信先を変えて移る・送信元を切り替える）ときは、移り先で読み戻して移り元の下書きを消したあと（2秒後）に判断する。

### 13.8 送信（`handleSend`）
1. 受信専用のグループ・フィルターグループからは送れない（入力欄の上に理由を出す）。
2. グループからは、メンバー全員のアドレス（保存した `groupMemberAddresses`）を To に入れて1通で送る。アドレスが読めない（壊れた）グループには送らず、「このグループはメンバーのアドレスが読めないため送信できません。グループを作り直してください。本文は入力欄に残っています。」と伝える。
3. 個別チャットでは、宛先は入力欄の送信先そのもの（`recipientsHeader` で To / Cc / Bcc にする）。送る前に、送信先が0人なら「送信先がありません」と伝えて止め、今のチャットの相手を含まないなら移る確認（§10.4）を出して止め、引用が元のやり取りにいなかった人にだけ届くなら確かめる。返信元があれば `fetchOriginalFull`（`html=true&full=true`）で引用の元を取る。返信元はほかのチャットのメールでもよい（`threadId`・`In-Reply-To`・`References` はそのメールのもの）。
4. sendAs を取り（10分キャッシュ、失敗したら4秒後に1回だけ）、`pickSendAs` で送信元を決める。読めなければ「このまま送る」で確かめる。既定ではない送信元のときだけ From を付ける。
5. 添付の合計が25MB を超えていたら送らずに伝える。
6. `/api/emails` に `send` を POST する。Message-ID は画面で作って渡す（再送で同じ ID を使うため）。
7. 結果は §10.6 のとおり。成功したら、送ったメールを画面に足し（実 ID、無ければ `fake-`。`to` / `cc` / `bcc` も入れる）、送った添付を添付キャッシュに先に書き、下書き（送信先を含む）を消す。
8. 失敗のトースト：「メールの送信に失敗しました。通信状況を確認してください。」など。結果が分からないときは、送信確認のダイアログ（「再送する」）を出す。

**送信元のアカウントを切り替える（`switchSendAccount`）**：返信欄の「送信元」から別のアカウントを選ぶと、そのアカウントで同じ相手とのチャット（無ければ下書きチャット）を開く。入力中の本文・添付・送信先（返信元が無ければ件名も）を切り替え先へ持っていき、切り替え先で読み戻せたら**切り替え元の下書きは消す**（両方に残って二重に送られないように）。返信元はスレッドがアカウントごとのため外す。トースト「送信元を 〇〇 に切り替えました」。

**返信チップ**：返信元がほかのチャットのメールなら、押したときに「返信元のメールがある〇〇さんとのチャットに移りますか？」と確かめてから移り、そのメールまでスクロールする。同じチャットならスクロールするだけ。

### 13.9 転送（`forwardMessageTo`）
§10.5。まず「転送しています…」を出し、終わったら「転送しました」。

### 13.10 移動・削除・既読／未読・非表示・ピン留め・リセット・名前変更
- 選択モード（`SelectionMode`）でチャットやメッセージを選び、アクションバーから操作する。対象が複数の場所にまたがるときは、`categorized_action_select` モーダルで「アカウント × 場所」ごとの件数を見せて選ばせる。移動先も、この場所ごとの確認画面で選ぶ。
- **Gmail への反映（`postMailboxChange`）**：画面は先に（楽観的に）書き換え、対象のメールを**アカウントごとに分けて**（`groupIdsByAccount`。メールの `accountId` で分け、無ければセッションのアカウント）、それぞれのアカウントで `/api/emails` に POST する。`fake-` の ID は送らない。
  - 失敗したらトーストで伝える。401 なら「〇〇がGmailに反映されませんでした（ログインが切れています）。プロフィールのボタンから再ログインしてから、もう一度お試しください。」、そのほかは「〇〇がGmailに反映されませんでした。再読み込みすると元の場所に戻ります。時間をおいてもう一度お試しいただくか、純正 Gmail で操作してください。」（既読・未読では「元の場所に戻ります」の代わりに「元の既読・未読の状態に戻ります」）、通信できなかったら「〇〇がGmailに反映されなかった可能性があります。通信状況を確認し、再読み込みして確かめてください。」（〇〇は 移動・削除・既読・未読）。
- 削除はゴミ箱へ移す（ゴミ箱・送信済みのメールは対象外）。完全削除は無い。
- **既読・未読（`applyReadToIds`）**：Gmail の既読は「`UNREAD` ラベルが無い」こと（純正と同じ）。すでにその状態のメールと `fake-` は送らず（Gmail の呼び出しを増やさない）、アカウントごとに1回だけ送る。送っている間（5秒）は、自動の既読で同じメールをもう一度送らない。
  - アクションバーの「既読」／「未読」：チャットなら、そのチャットに表示されているメールすべてが対象。すべて既読なら「未読」になる。
  - **アカウント設定「チャットを開いたら既読にする」**（既定オフ）：オンのアカウントでは、開いているチャットに表示されている未読メールを既読にする。開いている間に届いたメールも既読にするが、**画面が見えていないとき（`visibilityState` が `visible` でない）は既読にしない**。開いているチャットで自分で「未読にする」を押したメールは、チャットを開き直すまで既読に戻さない（すぐ既読に戻ってしまうため）。
  - **アカウント設定「メールを開いたら既読にする」**（既定オフ）：メールの詳細を開いたら、そのメールを既読にする。
  - 外部の画像を読み込んだことと既読はそろえない（Gmail の既読は相手に伝わるものではないため。一度入れた変更を元に戻した）。
- 未読のあるチャットは一覧で名前を太く・明るく、最後のメッセージを少し太く出す。未読のメッセージは本文を少し太く出す。
- 非表示・ピン留め・名前変更・リセットは Re:Mail の中だけの設定で、Gmail は変えない。D1 のそのアカウントの置き場所に保存する（§8.3.1・§12.6）。
- **ピン留めの上限**：チャットは10件、メッセージは100件。
- 非表示には「新着が来たら自動で再表示する」（`unhideOnNew`）を選べる。`hiddenAtDate` より新しいメールが来たら表示に戻す。

### 13.11 継続フィルター
- `filterContinuous` のフィルター（非表示・ピン留め・移動・削除・既読にする・未読にする）は、そのフィルターのアカウントのメールのうち、`filterLastAppliedAt` より新しい日時のメールにだけ自動で当て、当てたら `filterLastAppliedAt` を進める。

### 13.12 設定の保存
- **共通設定**（場所・アカウントのチェックボックス、文字／アイコン表示）：変えたら少し待ってまとめて（続けて切り替えたら最後の分だけ）`global_settings` を POST する。サーバーが全アカウントの置き場所に書く。
- **アカウント設定**（メールの外部の画像・チャットを開いたら既読にする・メールを開いたら既読にする）：`setAccountSetting(account, updates)` で、そのアカウントの `account_settings` を POST する。
- 新しい設定を足すときは、共通設定なら `syncedSettings.ts` の `SYNCED_SETTING_TYPES` と `COMMON_SETTING_KEYS`、このフックの `syncedSettings` / `applySyncedSettings` に、アカウント設定なら `ACCOUNT_SETTING_TYPES` に足す。

### 13.13 ブラウザ履歴との連携
- モーダル・選択モード・検索バー・モバイルのチャット画面を `history.pushState` で積み、「戻る」で閉じる（state は `{ chat }` / `{ action: "select" | "modal" | "findbar" }`）。モバイルでチャットを開いたときは URL に `#chat` を付ける。
- スクロール位置はタブごとに保存して戻す。

### 13.14 そのほかの定数
| 項目 | 値 |
| --- | --- |
| モバイルとみなす幅 | 768px 未満 |
| 長押しで選択モードに入る時間 | 500ミリ秒 |
| エラートーストの表示時間 | 4秒 |
| 本文中の画像の同時取得 | 3枚、1枚10MB まで |
| 読み込めなかったメールの再試行 | 50件ずつ `ids=` で |
| 自動更新の間隔 | 60秒 |

### 13.15 エラー表示
- ユーザーの操作に関わる失敗は、すべて `showErrorToast` で伝える（`alert()` は使わない）。メッセージには次の行動（再試行・再ログイン・純正 Gmail で開く・通信状況の確認）を添える。
- 想定外の例外は `app/error.tsx`（ページ）と `app/global-error.tsx`（レイアウトごと。`<html><body>` から自分で描く）で受け止める。真っ白な画面にせず、見出し「画面の表示で問題が起きました」、説明「読み込み直すと直ることがあります。急ぎのメールは、純正の Gmail で確認・送信できます。」、ボタン「もう一度表示する」（`reset()`）・「ページを読み込み直す」、リンク「純正 Gmail で開く」（`gmailOpenUrl()`、新しいタブ）を出す。ログは `logError("ui.errorBoundary", {}, error)` で、エラーの種類だけが残る。

---

## 14. 画面仕様

### 14.1 色
| 用途 | 色 |
| --- | --- |
| 背景（トーク） | `#313338` |
| 一覧の背景 | `#2B2D31` |
| 一覧の上部・入力欄の外側 | `#232428` |
| 入力欄・カード | `#383A40` |
| 境界線・入力の背景 | `#1E1F22` |
| ホバー | `#35373C` / `#3f4147` |
| 選択中のチャット | `#404249` |
| アクセント（ボタン・自分の吹き出し） | `#5865F2`（ホバー `#4752C4`） |
| ピン留め・検索のヒット | `#FEE75C` |
| 検索の今のヒット | `#FFA500` |
| 場所の色 | 受信箱 `#5865F2`、アーカイブ `#95A5A6`、迷惑メール `#FEE75C`、ゴミ箱 `#DA373C`、送信済み `#1ABC9C` |
| 危険・ログイン切れ | 赤（`red-500` 系） |

外部フォントは使わない（Arial / Helvetica / システムフォント）。

### 14.2 ログイン画面
背景 `#313338` の中央に、大きな「Re:Mail」（`#5865F2`、太字）と「Googleでログインして始める」ボタン。読み込み中は「読み込み中...」。

### 14.3 チャット一覧（左。PC は幅320px、モバイルは全幅）
上から順に：
1. **ヘッダー**：「Re:Mail」と、アイコンのボタン（フィルター・検索・設定・自分のアバター＝アカウントメニュー）。
2. **場所のチェックボックス**：受信箱／アーカイブ／送信済／迷惑／ゴミ箱（チェックボックスの色は場所の色）。設定で「アイコン」にすると文字の代わりにアイコンを出す。
3. **アカウントのチェックボックス**（ログインしているアカウントが2つ以上のときだけ）：アカウントごとに表示を切り替える。
4. **タブ**：「個人チャット」「グループチャット」「フィルター」。選ばれたタブは `#5865F2`。
5. **アクションバー**（選択モードのときだけ）。
6. **読み込めなかったメールのお知らせ**（あるときだけ）：「読み込めなかったメールが○件あります」と「再試行」（実行中は「取り直し中…」）。
7. **チャットの行**：アバター（`/api/avatar`）、名前、最後のメッセージ、ピン留めの印。未読があれば名前を太く・白く、最後のメッセージを少し太く出す。行の枠には、そのチャットに含まれる場所の色をグラデーションで出す。ログインしているアカウントが2つ以上のときは、どのアカウントのチャットかを、全アカウント同じ形の小さなバッジで出す（ログインが切れていれば赤、ホバーで「（ログインが切れています。再ログインしてください）」）。
8. 下に「チャットを追加読み込み中...」や「もっと見る...」などの状態表示。初回は「初期データ読み込み中...」。

### 14.4 トーク画面（右。PC は残りの幅、モバイルはチャットを開いたら全幅）
1. **ヘッダー**：（モバイルは「←」）、相手の名前、グループのモード（「・受信専用」「・送信専用」）、アカウントのバッジ、検索ボタン。
2. **検索バー**（Ctrl+F 風。開いたときだけ）：「キーワードで検索...」、ヒット数、「前の一致」「次の一致」、場所の絞り込み。
3. **アクションバー**（選択モードのとき）。
4. **ピン留めの帯**：ピン留めしたメッセージを横並びの丸いボタンで出し、押すとそこまでスクロールする。
5. **メッセージ**（新しいものが下。`flex-col-reverse`）：
   - 自分の吹き出しは右寄せで `#5865F2`、相手は左寄せで `#2B2D31`。未読は本文を少し太く出す。自分の吹き出しのアバターは、そのチャットのアカウントの名前から作る。
   - 件名（無ければ「(件名なし)」）、日時、本文（URL と HTML のリンクを押せる。ホバーでリンク先を見せる）、添付（画像はその場で表示、動画はサムネイル、そのほかはチップ）。
   - 返信のメッセージには、返信元へ飛べる「返信チップ」（Discord 風）を出す。返信元が読み込まれていなければ `lookupByMessageId` で探しにいき、無ければ「存在しません」と出す。
   - 押すとメールの詳細モーダル（HTML 表示・「Gmail で開く」）。
   - オフにしている場所のメールがあれば「{場所}のメールが含まれています。読み込みますか？」。
   - メッセージが無ければ「まだメッセージがありません」、読み込み中は「過去のメッセージを読み込み中...」。
6. **入力欄**：
   - 並びは上から **送信元 → 送信先 → 返信元 → 件名（返信元なしのときだけ）→ 添付・本文・送信**。
   - **たたみ方（PC・スマホ共通）**：送信スペースを「開いている」かを持つ（`composeActive`）。**送信元・送信先・返信元・件名を出すのは、本文に何か書いてあるか、送信スペースを開いているか、送信スペースから開いた確認画面・選ぶ画面を出している間**。それ以外は隠してメッセージを読む場所を広くとる。
     - 開く：送信スペースのどこかを押したとき（キーボードで中に入ったときも）、アクションバーの「リプライ」を押したとき。
     - たたむ（開いている状態を解く）：送信スペース以外の場所を押したとき（確認画面・モーダルの中は除く）、メッセージ一覧のスクロールが始まったとき（ホイール・指で動かしたときだけ。読み込みによる自動のスクロールでは解かない）。このとき送信先の欄も閉じる。
     - **本文に何か書いてあれば、開いている状態を解いても隠さない**（書きかけのままスクロールしても、送信元・送信先・返信元は出たまま）。フォーカスが外れただけではたたまない。
     - メール本文（HTML の表示部分）の中を押したときは、押したことがアプリに届かないため、たたまない。
   - **送信元**：アカウントのアイコン・名前・実際の From を1つのチップで出す。**送るときと同じ決め方（`pickSendAs`）で、実際に使う From を出す**（元のメールが自分のエイリアス宛てならそのエイリアスと表示名、後ろに「（<アカウント> のエイリアス）」）。欄を押すと `select_send_account`（「変更」などの文言は出さない。送信元は必ず1つ要るので「外す」は無い）。ログインしているアカウントが1つでエイリアスも無ければ押せない。sendAs はアカウントごとに10分キャッシュし、**起動時にログイン中のすべてのアカウントの分を1回ずつ取る**（開いているチャットのアカウントを先に。1.5秒待ってから、1件ずつ1.5秒あけて。開いた直後の一括取得とぶつからないように）。読めなかったアカウントは、そのアカウントのチャットを開いたときに取り直す。チャットのまとめ方（Reply-To が自分のエイリアスなら無視する）と返信の宛先（自分のエイリアスを除く）に要るため、開いたチャットの分だけでなく全部を取る。
   - **送信先**：たたんでいるときは1行の要約「送信先：山田さん ほか2名（Cc 1・Bcc 1）」。押すと開き、1人ずつのチップ（`/api/avatar` のアイコン・名前〔無ければアドレス〕・立場のラベル「宛先」「ほかの人にも見せる（Cc）」「こっそり送る（Bcc）」と一言説明〔Cc：「全員がお互いの名前とアドレスを見られます」、Bcc：「ほかの受信者には、この人に送ったことが見えません」〕）と「＋ 送信先を追加」（`select_recipients`）を出す。欄を押すと開く／閉じる（「開く」「閉じる」の文言は出さない）。チップを押すと確認を挟んで外す（「〇〇さんを送信先から外しますか？」「外す」「やめる」）。0人なら「送信先がありません」。グループでは「グループのメンバー全員に送ります」とだけ出し、編集できない。
   - **返信元**：「返信元:」と元のメッセージ（無ければ「なし（新しいメール）」）と「×」（返信元を外す）。欄を押すと `select_reply_target`（「返信元を選択／変更」の文言は出さない）。「×」で外すと、返信元を選んだときに自動で入れた件名（Re: 元の件名）も一緒に消す（自分で書き換えた件名は残す）。
   - 件名「件名 (省略可)」は返信元が無いときだけ出す（返信の件名はスレッドが分かれないよう元の件名に揃える）。
   - 添付（📎「ファイルを添付」。複数可、25MB まで）、本文、「送信」ボタン（本文が空・送信先が0人・送信中・下書きを読み込み中は押せない）。本文の欄は最初は1行で、入力に合わせて伸び、画面の高さの約40%（またはおよそ8行）で止まって中をスクロールする（PC・スマホ共通）。
   - **宛先の表示設定**（共通設定・既定オフ）：送ったメールの時間の横に「To 1・Cc 2・Bcc 1」（0のものは出さない）、受け取ったメールの時間の横に自分の立場「To」「Cc」（どちらにも自分〔エイリアスを含む〕がいなければ「宛先に自分なし」。Bcc・メーリングリスト・自動転送のどれか分からないため「Bcc」とは書かない）。
   - 入力欄の確認画面（送信先を外す・チャットを移る・送信先を置き換える・返信／全員に返信・引用の注意）は、送信確認のダイアログと同じ形で出す。
   - 受信専用のグループでは「受信専用のグループチャットのため、送信・返信はできません」、フィルターグループでは「フィルターグループのため、送信・返信はできません」と出し、入力欄を薄くして押せなくする。
   - チャットが無いときは、ヘッダーに「新規作成中」「未選択」などを出す。
7. **トースト**：画面下中央に出す。情報（`#5865F2` の枠）、エラー（赤の枠、4秒）、送信確認のダイアログ（「再送する」）。

### 14.5 アクションバー（`ui.tsx` の `ActionBar`）
選択モードで出す。ボタンは状況に応じて：「全選択」「キャンセル」「作成」（グループの作成）、「名前変更」（チャット）、「転送」「リプライ」「コピー」（メッセージ）、「ピン留め」／「ピン解除」、「既読」／「未読」（チャットなら表示されているメールすべて。すべて既読なら「未読」）、「移動」、「非表示」、「削除」、「リセット」（チャット）。保存場所で使えない操作（§12.1）は無効にする。設定で「アイコン」にするとアイコンで出す。

### 14.6 モーダル（`Modals.tsx`）
| 種類 | 中身 |
| --- | --- |
| `account_menu` | 見出し「ログイン中のアカウント」。全アカウントを同じ形で並べ（名前・アドレス・画像、セッションのものに「使用中」、切れていれば「再ログインが必要」）、各アカウントに「ログアウト」（確認：「このアカウントだけログアウトします…」と「はい」「いいえ」）、切れていれば「再ログイン」（`/api/accounts/connect`）。「+ 別のアカウントでもログイン」（`/api/accounts/connect`）、「すべてのアカウントからログアウト」（1つだけなら「ログアウト」。`clearDeviceData` してから `signOut`） |
| `settings` | タブで分ける：「共通」（どのアカウントでも同じ設定）と、アカウントごとのタブ。**共通**：「送信ボタン・アクションバー・場所の表示」の「文字」／「アイコン」（実験的）。「送ったメールに宛先の人数を表示する」「受け取ったメールに、自分がどの欄で受け取ったかを表示する」のオン／オフ（既定はオフ。説明に To / Cc / Bcc の一言説明）。「どのアカウントでログインしても同じ設定になります。あとから追加したアカウントにも使われます。一覧の上の受信箱〜ゴミ箱・アカウントの表示のチェックも共通設定です」。**アカウント**：「メールの外部の画像」の「押したときだけ」（既定）／「毎回読み込む」（「画像を読み込んだ時点で、送り手に『メールを開いたこと・開いた日時・おおよその場所（IP アドレス）』が伝わることがあります」）、「チャットを開いたら既読にする」「メールを開いたら既読にする」のオン／オフ（既定はオフ） |
| `select_send_account` | 見出し「送信元のアカウント」。アカウントを選ぶと、そのアカウントで同じ相手とのチャットを開く（「…入力中の本文・添付・送信先は引き継ぎ、返信元は外します（スレッドはアカウントごとのため）」）。エイリアスがあれば一覧を出し、「どのアドレスから送るかは、純正 Gmail と同じく返信元のメールの宛先に合わせて自動で決まります」と添える |
| `select_recipients` | 入力欄の「＋ 送信先を追加」。`compose_new_chat` の相手選び（既存の相手＋新しいアドレス、検索つき）を使い回す。候補は送信元と同じアカウントのチャットの相手だけで、もう送信先にいる人は出さない。複数選べ、選んだ人ごとに立場（宛先／ほかの人にも見せる（Cc）／こっそり送る（Bcc）。既定は To）を選べる。返信元が選ばれていれば、一番上に「元のメールに入っていた人」（差出人〔Reply-To 優先〕・To・Cc、自分とエイリアスを除く）を元の立場付きで出す。ボタンは「追加」 |
| `compose_new_chat` | 新規作成・グループ作成・転送の宛先選び。送信元のアカウントを選び、既存の相手か新しいアドレスを選ぶ。複数選ぶとグループ作成になり、モード（通常／受信専用／送信専用）とメンバーの個別チャットを隠すかを選ぶ。転送モードでは25MB を確かめ、ボタンは「転送」 |
| `categorized_action_select` | 移動・削除・ピン留め・非表示の対象を、アカウント × 場所ごとの件数で選ぶ。移動では移動先（受信箱／アーカイブ／迷惑メール／ゴミ箱）も選ぶ |
| `confirm_pin` / `confirm_unpin` / `confirm_delete` / `confirm_delete_group` / `confirm_hide` | 確認。非表示では「新着が来たら再表示する」を選べる。グループの削除では、作成時に自分が隠したメンバーだけを元に戻す |
| `rename` | チャットの名前を変える |
| `reset_select` | リセットの範囲（すべて／選んだチャット）を選ぶ |
| `select_reply_target` | 返信元のメッセージを選ぶ。上に検索モーダル（§14.7）と同じ形の検索（タブ・並び替え・場所の絞り込み・2文字以上で0件なら**送信元のアカウントだけ**をサーバー検索。同じ語で二度撃たない）、その下に今のチャットのメール。選べるのは送信元と同じアカウントのメールだけ（ほかのチャットのメールも選べる）。選んでも開いているチャットは変わらない。`fake-` や読み込めていないメールは選べない。選ぶと §10.4 の「返信／全員に返信」の確認に進む |
| `search` | 検索モーダル（§14.7） |
| `filter_tool` | フィルターツール（§14.8） |

**メールの詳細（`EmailModal`）**：差出人・To・Cc（送ったメールなら Bcc も。設定に関係なく出す）・日時・件名、HTML 本文（§15.3 の iframe）、「画像を表示」ボタン（リモートの画像があるときだけ）、添付の一覧、「Gmail で開く」。

**添付（`AttachmentModal`）**：画像（ピンチ・ホイールで拡大）、PDF（Blob にして新しいタブで開く）、音声、動画、テキストのプレビュー。ダウンロードと共有（Web Share API があれば）。

### 14.7 検索モーダル
- 対象のタブ：すべて／宛先名／アドレス／件名／本文。並び替え、場所とアカウントの絞り込み。
- 読み込み済みのメールから探す。2文字以上の語で0件だったら、500ミリ秒待って、全アカウントを対象に Gmail 本体をサーバー検索する（同じ語・同じ項目では二度撃たない）。
- 結果は5件ずつ出し、「もっと見る」で続きを出す。
- 検索語に正規表現の記号が入っても落ちない（`HighlightText` は記号をエスケープしてから強調する）。

### 14.8 フィルターツール
**アカウントごとのタブ**に分かれていて、フィルターは必ずどれか1つのアカウントのもの。画面の流れ：一覧（「保存されたフィルターはありません」/ 編集・削除）→ 条件 → OR の一覧 → アクション → 確認。
- 条件：受信／送信、宛先名・アドレス・件名・本文のキーワード（含む／含まない）、期間、添付の有無、返信か、転送か、HTML／テキスト、未読・既読。これを「条件セット」として OR でいくつでも足せる。保存場所で絞れる。
- アクション：
  - **作成（グループ化）**：常に動的で、新着にも効く。「これまでのメールを含める／含めない」、元のチャットから隠すかを選べる。ローカルキーは `filter:<時刻>-<乱数>`。
  - **非表示・ピン留め・移動・削除・既読にする・未読にする**：「1回限り」か「継続」（新着にも自動で効く）。
- 確認画面には**実際に効く件数**を出す（「これまでのメールを含めない」なら既存の分は数えない）。削除はゴミ箱へ移ること、継続なら新着にも効くことも書く。
- 通常のグループのローカルキーは `group:<時刻の36進>-<乱数>`。

---
## 15. セキュリティ

### 15.1 ページ全体のヘッダー（`securityHeaders.ts`）
**本番のビルドだけに付ける。** 開発サーバーには付けない。

**CSP**（`worker.ts` が付ける）
```
default-src 'self';
script-src 'self' 'nonce-<毎回作る値>';
style-src 'self' 'unsafe-inline' https:;
img-src 'self' data: blob: https:;
font-src 'self' data: https:;
media-src 'self' data: blob:;
frame-src 'self' data: blob:;
connect-src 'self';
worker-src 'self' blob:;
object-src 'none';
base-uri 'self';
form-action 'self' https://accounts.google.com;
frame-ancestors 'none'
```
- **nonce の流れ**：`worker.ts` がリクエストのたびに16バイトの乱数（base64）を作る → `withNonceRequest` でリクエストに CSP ヘッダーを付けて OpenNext に渡す → Next.js がリクエストの CSP から nonce を読み、自分の起動用スクリプトに付ける → `withNonceResponse` で、HTML の応答に同じ nonce の CSP を、それ以外の応答には nonce なしの CSP を付ける。
- スクリプトに `'unsafe-inline'` を使わない。入り込んだスクリプトは nonce を知らないので動かない。**`script-src` に `'unsafe-inline'` を戻さない。**
- **CSP を `next.config.ts` の `headers()` に入れてはいけない。** OpenNext がリクエスト側を上書きして nonce が消え、画面が動かなくなる（ページは 200 を返すので気づきにくい。ヘルスチェックで見つける）。
- nonce が毎回変わるので、ページはビルド時の静的な HTML にできない。`layout.tsx` の `export const dynamic = "force-dynamic"` で毎回サーバーで描く。
- CSS の `'unsafe-inline'` は、React の style 属性とメール本文の style が使うため残す（CSS ではスクリプトは動かない）。
- 画像・CSS・フォントの `https:` は、「画像を表示」を押したあとに出すため。押す前は iframe の中の CSP が止める（§15.3）。

**そのほかのヘッダー**（`SECURITY_HEADERS`。`next.config.ts` の `headers()` で付ける）
| ヘッダー | 値 | 理由 |
| --- | --- | --- |
| `X-Frame-Options` | `DENY` | ほかのサイトに埋め込ませない |
| `X-Content-Type-Options` | `nosniff` | |
| `Referrer-Policy` | `no-referrer` | メールのリンク先に Re:Mail の URL を伝えない |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()` | 使わない機能を使わせない |
| `Strict-Transport-Security` | `max-age=31536000` | |
| `Cross-Origin-Opener-Policy` | `same-origin` | |

### 15.2 トークン
- ブラウザには Gmail のアクセストークンを渡さない（§7.2）。Gmail への呼び出しはすべて Worker を通る。
- セッションを持たないアカウントのトークンは D1 に暗号化して置く（§8）。アカウントを1つだけログアウトするとき、そのアカウントのトークンは D1 にも Cookie にも残さない（§7.4）。
- セッションを引き継げるのは、今のアカウントの `linked_accounts` に付いているアカウントだけ（`promoteLinkedAccount` が確かめる）。画面から任意のアドレスを渡しても、ほかの人のアカウントにはなれない。

### 15.3 HTML メールの表示（`emailHtml.ts`）
- **sandbox 付きの iframe**（`srcDoc`）で表示する。`sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin"`。**`allow-scripts` は無い**ので、本文のスクリプトは動かない。リンクは新しいタブで開く（`allow-popups`）。`allow-same-origin` は、画面側のコードが `iframe.contentDocument` に触ってズームなどを行うために要るので、残すと決めた（開発者の判断）。**これ以上の項目（`allow-scripts` / `allow-forms` / `allow-top-navigation` など）は足さない。**
- `prepareEmailHtml(html, allowRemote)` が表示の前に次を行う。
  - 外部の URL へ移動させる `<meta http-equiv="refresh">` を取り除く（CSP では止まらないため。`<meta>` を1つずつ切り出してから中身を見る。タグ全体を1つの正規表現で探すと、巨大なタグで後戻りが爆発する）。
  - `<head>` の先頭に CSP の `<meta>` を差し込む（`<head>` が無ければ `<!DOCTYPE html><html><head>…</head><body>…</body></html>` で包む）。
    - 既定（`allowRemote = false`）：`default-src 'none'; img-src data: blob: cid:; style-src 'unsafe-inline'; font-src data:; media-src data: blob:`。**リモートの読み込みを塞ぐ**（トラッキングピクセル対策）。書き方の抜け道があっても通らない。
    - 許すとき：`default-src 'none'; img-src * data: blob: cid:; style-src * 'unsafe-inline'; font-src * data:; media-src * data: blob:`。
    - どちらでもスクリプトは許さない（sandbox でも止めている）。
  - `<base target="_blank">` と、最小限のスタイル（`img{max-width:100%;height:auto}`、`body{margin:0;padding:16px;word-break:break-word;opacity:0;transform-origin:0 0}` など。`opacity:0` は、ズームを合わせ終わってから画面側で表示するため）を入れる。
- `hasRemoteContent(html)` で、リモートの読み込み（`<img src="http…"`・`url(http…)`・`background="http…"`・`<link href="http…"`。`//` 始まりも含む。200万文字まで）があるかを調べ、あれば「外部の画像を読み込んでいません」と「画像を表示」ボタンを出す。押したときだけ `allowRemote: true` で表示し直す。
- 設定の「メールの外部の画像」を「毎回読み込む」（`alwaysLoadImages`）にすると、押さずに読み込む。**既定は「押したときだけ」。** 設定画面に「毎回読み込むと開封が送り手に伝わる」ことを書いてある。
- 本文中の cid: 画像は `replaceCidImages` で data URL に差し替える（§11.4）。
- ピンチ・ホイールで拡大できる。
- 差出人ごとの「常に表示」は、設定を増やさないため作らない。

### 15.4 ログ（`safeLog.ts`）
- `console.*` を直接使うことは ESLint の `no-console` で禁止している（例外は `safeLog.ts` だけ）。すべて `logError` / `logWarn` / `logInfo(op, fields, detail)` を通す。
- 出すのは JSON 1行：`{ level, op, status?, count?, durationMs?, messageId?, threadId?, reason?, errorName? }`。
  - `op` は `^[A-Za-z0-9_.:-]{1,64}$`（違えば `invalid-op`）。
  - `messageId` / `threadId` は16進6〜32文字のときだけ。
  - `reason` は `^[A-Za-z_]{1,64}$`（Gmail / OAuth の理由コード。渡された `detail` からも拾う）。
  - `errorName` は `^[A-Za-z]{1,40}$`（エラーの種類）。
- **エラーの `message` は出さない**（URL の検索語やアドレスを含みうるため）。形が合わないものは捨てる。
- 開発環境（`NODE_ENV === "development"`）でだけ、原因を追えるよう `detail` もそのまま出す。

### 15.5 そのほか
- 追加アカウントの OAuth は `state` を httpOnly Cookie で照らし合わせる（CSRF 対策）。
- 外部への通信は Google（OAuth・Gmail API）だけ。CDN・解析・外部フォントは使わない。
- テストやコメントに実在のメールアドレスや実データを書かない（例は `user@example.com`）。

---

## 16. テスト

- `npm test`（Vitest、`app/**/*.test.ts`、Node 環境）。
- テストのあるファイル：`roomKey` `groupEmails` `filterMatch` `groupPaging` `searchFallback` `historySync` `messageParse` `mime` `replyCompose` `recipients` `sendVerify` `emailHtml` `safeLog` `tokenCrypto` `addressKey` `configCrypto` `configStore` `linkedAccountsStore` `migrations`（0003 が古い形式の行だけを消すか） `syncedSettings` `securityHeaders` `configSaveQueue` `pinnedIds` `drafts` `gmailLink` `publicSession`、`mailboxOps`、`configSpaces`（アカウントごとの置き場所）、`app/api/config/route.test.ts`。
- D1 は `fakeD1.testutil.ts` の偽物で試す。暗号は、テスト用に作った鍵を `process.env.TOKEN_ENCRYPTION_KEY` に入れて試す（本物の鍵は使わない）。
- **必ず境界値のテストを書くもの**（壊れると絶対ルールに直結する）：送信の MIME の組み立て（日本語の件名、長い件名、絵文字、Cc あり、日本語のファイル名、ヘッダーへの改行の差し込み）、宛先の計算（Reply-To、自分が送ったメールへの返信、全員に返信で自分を除く）、暗号化と HMAC（古い形式の値は読まずに例外で止まらない・鍵が無いと平文で保存しない）、入力の上限（巨大な入力・深い入れ子・壊れた MIME）、ログの伏せ字、送信結果の分類。
- `npm test`・`npm run lint`・`npx tsc --noEmit` の3つがすべて通ってから push する（CI でも確かめ、どれか失敗するとデプロイされない）。
- Lint のエラーは0に保つ。React Compiler 向けの4つのルールは誤検知が多いので警告にしてある。その行だけルールを外すときは `// eslint-disable-next-line <ルール> -- <理由>` と必ず理由を書く。`any` を使わない。

---

## 17. 変更時のチェックリスト

### 17.1 毎回の確認（`CLAUDE.md` にも同じものがある）
- [ ] サーバー（D1・ログ）にメールの中身や平文の個人情報を書いていないか
- [ ] ログ出力は `safeLog.ts` を通しているか
- [ ] 外部ドメインへの通信（CDN・解析・画像など）を増やしていないか
- [ ] 送信処理に自動再試行を入れていないか（429・レート制限の 403 以外）
- [ ] 宛先（To / Cc / Bcc）・件名・スレッド・添付・署名が落ちる経路はないか
- [ ] 失敗したとき、画面に見える表示と次の行動があるか
- [ ] 異常に大きい・壊れた入力で固まらないか（上限があるか）
- [ ] D1 の変更は2段階で、古いコードでも壊れないか（移行が終わったら古い形式のデータと読むコードを消す。§6.1）
- [ ] Gmail API・Workers の呼び出し回数を増やしていないか（増やしたなら量と理由）
- [ ] 端末に新しく保存するものは、アカウント別で、ログアウト（1つだけのログアウトを含む）で消えるか
- [ ] 新しい設定は、共通設定（`SYNCED_SETTING_TYPES` / `COMMON_SETTING_KEYS`）かアカウント設定（`ACCOUNT_SETTING_TYPES`）のどちらかに足して D1 に置いたか（端末だけに置いていないか）
- [ ] 設定・フィルター・グループ・送信元で、アカウントを取り違える経路はないか（ほかのアカウントのメールを混ぜていないか）
- [ ] CSP を広げすぎていないか（`script-src` に `'unsafe-inline'` を戻さない、CSP を `next.config.ts` に入れない）
- [ ] 常に見える画面の要素を増やしていないか、既存の色と部品に合っているか
- [ ] 最初の表示やスクロールを遅くする処理を入れていないか
- [ ] テスト・lint・型チェックが通るか

### 17.2 送信まわりを変えたときの比較テスト
同じ内容を**純正 Gmail** と **Re:Mail** の両方から送り、受信側で「メッセージのソースを表示」して比べる。
- 新規作成（日本語の件名・絵文字・長い件名）
- 返信（スレッドがつながるか。相手側が Gmail でも Outlook でも）
- 全員に返信（Cc が残るか）／相手のみ（Cc に届かないか）／Reply-To 付きのメールへの返信
- 転送（HTML・添付・本文中の画像）
- 添付（日本語のファイル名、5MB 超、25MB 近く）
- 送信元エイリアス・署名（署名の読み込みに失敗したときの確認も）
- **Bcc**（受信側と自分の送信済みの両方でソースを見る）：To＋Bcc、Bcc だけ、To＋Cc＋Bcc。受信者側のメールに Bcc ヘッダーが無いこと、Bcc の人に届くこと、自分の送信済みに Bcc が残ること、ヘッダーの並び（純正の送信済みでの Bcc の位置）、Bcc だけのときの To ヘッダー（純正が付けるか）
- 返信で Cc を足す：スレッドがつながること、件名が「Re: 元の件名」のままのこと
- ほかのチャットのメールを返信元にして、今のチャットの相手に送る：スレッドと引用
- 送信結果が分からないときの照合：Bcc だけの送信でも `verifySent` が一致を見つけられること

### 17.3 自動の結合テスト（まだ作っていない）
今は Claude Code から実際の Gmail で送受信を確かめられない。テスト専用の Google アカウントを2つ用意し、トークンをローカルの `.dev.vars` に置けば、Re:Mail の送信処理で A から B に送り、B 側で `format=raw` を取ってヘッダー・スレッド・Cc・添付・文字コードを自動で調べられる。純正 Gmail から一度送ったソースを「正解」として保存しておけば、比べるところまで自動にできる。

---

## 18. 既知の問題・残り課題

### 18.1 直したもの（2026-10-22〜23）
README 作成時のコード確認で見つかった不具合は、すべて直した。
- アーカイブへの移動が Gmail に反映されなかった → `labelChangeFor("ARCHIVE")` で受信箱から外す。
- 連携アカウントのメールの移動・削除にメインアカウントのトークンが使われていた → 画面がアカウントごとに分けて送る（`groupIdsByAccount`）。
- 削除の失敗を成功と返していた → Gmail が失敗したらそのステータスと理由を返す。
- 完全削除（`batchDelete`）の使えない分岐 → 消した。`permanentIds` は 400 で断る。
- 重複していた削除の分岐、使われていない移動先のモーダル（`select_move_dest` など） → 消した。
- `verifySent` に Cc を渡していなかった → 渡す。
- `CLAUDE.md` の `ContextMenu.tsx` の記述 → 外した。

### 18.2 2026-10-23 のコード確認で気づいた点（すべて対応済み）
| 項目 | 対応 |
| --- | --- |
| 設定の置き場所の移行が段階1のまま、以前の置き場所の古い写しが残る | 段階2に切り替え、以前の置き場所の写しは読んだときに消すようにした |
| `/api/config` のたびに `listLinkedAccounts`（全行の復号と書き直し）を呼んでいた | アドレスだけを読む `listLinkedAccountEmails` に替えた |
| 返信欄の「送信元」が、実際の From（エイリアス）と違うことがあった | 送るときと同じ決め方で、実際の From を出すようにした |
| 既読・未読の失敗の文言が移動・削除向けだった | 「元の既読・未読の状態に戻ります」にした |
| アクションバーの文言がそろっていなかった | 「既読」「未読」にそろえた |
| API が `scope=shared` を受け付けていた | やめた（`configScope.ts` も消した） |
| 移行のための「古い形式も読む」コードと古い形式のデータが残っていた | 2026-10-23 に移行を終え、古い形式のデータを `0003_drop_legacy_rows.sql` で消し、読むコード・段階のフラグ・定期実行を消した。鍵が無いときに平文で保存する逃げ道もなくした（§6.1） |

### 18.3 ルールとのギャップのうち、開発者が判断してそのままにするもの
| 項目 | 理由 |
| --- | --- |
| メール本文の iframe の `sandbox` に `allow-same-origin` が付いている | `allow-scripts` は無いので本文のスクリプトは動かない。これ以上の項目は足さない |
| CSP の `style-src` に `'unsafe-inline'` が残っている | React の style 属性とメール本文の style が使うため。CSS ではスクリプトは動かない |

ほかに、品質の改善候補として `next.config.ts` の `ignoreBuildErrors: true` がある（CI で `tsc` を通しているので実害は無い）。

### 18.4 一般公開に向けて残っているもの
- **Google の OAuth 審査**：`gmail.modify` は制限付きスコープなので、100人を超えて公開するには審査と第三者のセキュリティ評価（CASA）が要る。審査前は「未確認のアプリ」の警告が出て、テストユーザーは100人まで、リフレッシュトークンは7日で失効する。D1 に平文の個人情報を残さない形にしたので、審査で説明する範囲は小さくなった。
- **プライバシーポリシー・利用規約**：「メールはサーバーに保存しない」「D1 にはキーを HMAC にして中身を暗号化した設定（共通設定・アカウント設定を含む）と、暗号化したトークンだけを置く」「端末内のデータはログアウトで消す」「第三者に送らない」「ログに個人情報を残さない」「HTML メールの外部画像は既定で読み込まない」と書く。Google API Services User Data Policy（Limited Use）に従うことも書く。
- **実際の利用者のメールでの検証**：ログには中身を残せないので、ログには「どの処理で・どの種類の失敗か」だけを残し、再現は利用者の同意を得た報告で行う。

---

## 19. 設計判断の記録

| 判断 | 理由 |
| --- | --- |
| 自前のサーバーを持たず、Cloudflare Workers ＋ D1 にする | 固定費をドメイン代と Workers の有料プランだけにするため |
| メールを保存しない（R2 も使わない） | ルール1。添付の一時保管も個人情報の保存にあたる |
| チャットはアカウントごとに完全に分ける | 文脈の混在と送信元の取り違え（ビジネス上の事故）を避けるため |
| roomKey の区切りに `\u0000` を使い、`roomKey.ts` に集める | 表示名に区切りと同じ文字が入る衝突を構造的に防ぐため。型でも取り違えを防ぐ |
| グループから送ったメールを D1 に残さず、To の集合で判定する | 送るたびに D1 のデータが増えないようにするため |
| セッションを持たないアカウントのトークンは D1 に暗号化して置き、暗号化 Cookie には移さない | Cookie だと連携が「その端末・そのブラウザだけ」になりログアウトで消える／1つ約4KB で連携が多いと入らない／トークン更新のたびに書き換えて同時リクエストどうしで上書きし合う／D1 のトークンはすでに暗号化済みで、移しても安全性はそれほど上がらない |
| HMAC の鍵を新しいシークレットにせず、`TOKEN_ENCRYPTION_KEY` から HKDF で派生させる | シークレットを増やさないため |
| 保存の形の変更を2段階で入れ、終わったら古い形式を消す | ロールバックで壊れないようにするため。移行が終わったら古い形式を読むコードを消し、コードを単純にする |
| 移行の終わりに `chat_configs` をすべて消す（設定を作り直す） | 暗号化した中身の中に古い形式が残っていても SQL では見分けられないため。利用者が開発者本人だけで、設定が消えてよいと本人が決めた。`linked_accounts` は今の形式の行だけ残し、再ログインを要らなくした |
| 鍵が無ければ例外にし、平文で保存しない | ローカル開発の便利さより、D1 に平文の個人情報を書く道をなくすことを取った（ルール1） |
| 定期実行（`backfill.ts`）をやめる | 古い形式の行が無くなり、置き換えるものが無くなったため |
| 送信を自動で再試行しない | 5xx やタイムアウトでも送れている可能性があり、再試行すると二重送信になる |
| Message-ID を自前で決め、純正の形にする | 結果が分からないときの照合に使うため。Re:Mail から送ったことが分からないように |
| 送信を upload エンドポイントにする | raw を JSON に入れる方式は数MB を超えると失敗したため |
| 差分同期を history API にする | 最新100通を毎分取り直す方式は Gmail API の利用上限をすぐに使い切ったため |
| 読み込めなかったメールは ID で取り直す | 一覧ごと取り直すと利用上限にすぐ触れ、かえって読み込めない数が増えたため |
| 401 ですぐにログアウトしない | トークン更新の一時的な失敗で勝手にログアウトされ、下書きまで消えたため |
| ブラウザに返すセッションからアクセストークンを除く | ページ上でスクリプトが動いても Gmail の鍵を持ち出せないように |
| 設定を端末ではなく D1 に置く | どの端末でも同じにし、ログアウトで消えないように |
| CSP を nonce にする | `script-src 'unsafe-inline'` をなくすため |
| HTML メールの外部画像を既定で読み込まない | トラッキングピクセルで開封や IP が送り手に伝わるのを防ぐため |
| 専用の右クリックメニューを作らず、選択モードとアクションバーにまとめる | PC とモバイルで同じ操作にし、画面の部品の種類を増やさないため |
| `@cloudflare/next-on-pages` から OpenNext に移る | next-on-pages が非推奨になったため |
| Next.js 16 に上げる | Next.js 15 のサポートが 2026-10-21 に終わったため |
| `groupEmailsByRoom` はローカルキーを返し、複合キーにするのは `mergeAccountGroups` | 複数アカウント対応のとき、既存のグルーピングのロジックを一切変えずに済ませるため（広がる破損を防ぐための、意図した仕様からの逸脱） |
| 複数のアカウントを対等に扱い、画面から「連携」「メイン」の区別をなくす | ログインできた＝同じ人なので、どのアカウントも同じように使え、どれでも1つだけログアウトできるようにするため |
| 設定をそのアカウント自身の置き場所に保存する | ほかのアカウントの付属として使っていたアカウントで直接ログインしても、同じ設定で使えるようにするため |
| フィルターをアカウントごとにする（アカウントの決まっていないフィルターは一致させない） | どのアカウントのフィルターかを明確にし、ほかのアカウントのメールを混ぜない（送信元の取り違えなどを防ぐ）ため |
| セッションを持つアカウントのログアウトは、ほかのアカウントへ引き継ぐ | 1つだけログアウトしても、残りのアカウントを使い続けられるようにするため。ログアウトしたアカウントのトークンは残さない |
| 権限の一覧を `googleScopes.ts` の1か所にまとめる | あとから追加したアカウントだけ `profile` が無く、名前と画像が出なかったため |
| 既読・未読を自動にする設定は既定でオフ | Gmail の状態を勝手に変えないため（シンプルなデザイン：新しい機能は既定でオフ） |
| 外部の画像の読み込みと既読をそろえない | Gmail の既読は相手に伝わるものではなく、そろえる必要がないため（一度入れて元に戻した） |
| 完全削除を作らない | `gmail.modify` では使えず、作るには権限を増やす必要があるため（ルール1-6） |
| リフレッシュの同時実行をメモリの Map でまとめる | 同じインスタンス内での二重リフレッシュを防ぐ簡易な対策。厳密にするなら D1 に「リフレッシュ中」の印を持たせる |

---

## 20. 今後の構想（すべて §0 の範囲内で）
- **Outlook / iCloud 対応**：Gmail 固有の処理（ラベル名・history 同期・MIME の解読・upload 送信・sendAs）を差し替えやすい形を意識する。送信の忠実性のテストはプロバイダーごとに行う。
- **Android / iOS アプリ**：端末内の保存の決まり（アカウント別・消せる）を引き継ぐ。
- **AI 機能（有料プラン）**：Workers AI を使い、**オプトイン・その場で処理して保存しない・ログに残さない・学習に使われない**ことを条件にする。AI が書いた返信は、本人が確かめてから送る（自動で送らない）。
- **画像のプロキシ**：Worker を通して（保存せずに）中継すれば、既定で画像を出しても送り手に IP や開封時刻が伝わらない。Workers のリクエスト数との兼ね合いで判断する。
- **構成の見直し（要調査）**：ブラウザから Gmail API を直接呼べば、メールが Worker を通らなくなる。ただし「ブラウザにアクセストークンを渡さない」方針にしたので、採るなら安全性の比較から考え直す。
- **R2**：使わない方針。

---

## 21. claude.ai と Claude Code の役割分担
- **claude.ai（Re:Mail プロジェクト）**：設計の壁打ち、原因の仮説出し、Claude Code に渡す指示文づくり。**指示文には、関係する §0 のルールを必ず書き添える。**
- **Claude Code**：実装・テスト・push。作業ルールは `CLAUDE.md` に従う（冒頭に §0 とサブテーマ、§17.1 のチェックリストがある）。
- **この README を正とする。** 大きな変更をしたら、同じコミットで README の該当箇所も直す。claude.ai のプロジェクトは GitHub と同期しているが、Claude Code の変更は自動では反映されないので、大きな変更のあとは同期をやり直す。

---
