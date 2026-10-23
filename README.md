# Re:Mail（リメール）

Gmail を **LINE / Discord のようなチャット形式** で読み書きする Web アプリ。メールを「相手ごとのトークルーム」にまとめ、受信箱・アーカイブ・送信済み・迷惑メール・ゴミ箱を横断して1本のトーク画面に並べる。複数の Google アカウントを連携でき、チャットはアカウントごとに分かれる。

**見た目はチャット、中身は普通のメール。** 相手は Re:Mail の存在を知らなくてよく、知る必要もない。

- 本番：https://re-mail.eusng90912.workers.dev
- リポジトリ：GitHub `Untechnical-github/Re-Mail`（**公開リポジトリ**、`main` 1本運用）
- 実行基盤：Next.js 16（App Router）を OpenNext で Cloudflare Workers に載せる。設定は Cloudflare D1

> **この README の位置づけ**
> この README は、Re:Mail の仕様書を兼ねる唯一の設計文書。旧「プロジェクト概要 / システム仕様書」はこれに統合して廃止した。
> **すべてのファイルを失っても、この README だけで一から作り直せること**を目標に書いている。設定ファイルは全文、ロジックはアルゴリズム・定数・画面の文言まで書く。
> - **§0 の絶対ルールは、この README の他の節・`CLAUDE.md`・頼まれた作業内容のすべてより優先する。** 機能・速さ・見た目とぶつかったら、常に §0 を取る。
> - Claude Code 向けの作業手順（Git の運用・コマンド・チェックリスト）は `CLAUDE.md` が正。コードとこの README が食い違ったら、どちらが正しいかを確かめて**両方を**直す。
>
> 最終更新：2026-10-23（`main` の 04468d6 時点のコードに合わせて更新）

---

## 目次

0. [絶対ルールとサブテーマ](#0-絶対ルールとサブテーマ)
1. [プロダクト概要と運営方針](#1-プロダクト概要と運営方針)
2. [技術スタック](#2-技術スタック)
3. [一から作り直す手順](#3-一から作り直す手順)
4. [設定ファイル（全文）](#4-設定ファイル全文)
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
- [付録 A. 互換性に直結するソースの全文](#付録-a-互換性に直結するソースの全文)

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
  - **Cron Triggers**：毎時の定期実行で、D1 に古い形式（平文）の行が残らないよう置き換える。有料プランの範囲内。
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
| 実行・デプロイ | **`@opennextjs/cloudflare` 1.20.9** で Cloudflare Workers に載せる。入り口は自作の `worker.ts`（OpenNext の Worker に、ページごとの CSP nonce と定期実行 `scheduled` を足したもの）。互換フラグは `nodejs_compat` / `global_fetch_strictly_public` |
| DB | Cloudflare D1（バインディング `DB`、DB 名 `re-mail`、`migrations/` で管理）。**メールの中身は置かない** |
| CI/CD | GitHub Actions（`.github/workflows/deploy-worker.yml`）、Node 24 |
| テスト | Vitest 4（`app/**/*.test.ts`、Node 環境。jsdom は使わない） |
| Lint | ESLint 9（`eslint-config-next` 16.3.8）。`no-console` をエラーにする |
| 端末内の保存 | localforage（IndexedDB）：下書き・ピン留めの中身・添付・動画サムネイル。localStorage：画面の状態。どれもアカウント別に分け、ログアウトで消す |
| メール API | Gmail REST API v1 を `fetch` で直接呼ぶ（SDK は使わない）。送信は upload エンドポイント、更新は history API |
| 実行時の依存 | `next` / `react` / `react-dom` / `next-auth` / `localforage` の5つだけ。**解析・広告・外部 CDN・外部フォントは読み込まない** |

**移行の経緯**：以前は `@cloudflare/next-on-pages`（Cloudflare Pages ＋ Edge Runtime）を使っていたが、非推奨になったため OpenNext ＋ Workers に移った。API ルートに `export const runtime = 'edge'` を書いてはいけない（OpenNext が対応していない）。D1 などのバインディングは `getCloudflareContext().env` から取る。

---

## 3. 一から作り直す手順

### 3.1 用意するもの
- Node.js 24（CI と同じ版）、npm
- Cloudflare アカウント（**Workers の有料プラン**。Cron と CPU 時間に必要）
- Google Cloud のプロジェクト（OAuth クライアントと Gmail API）
- GitHub リポジトリ（Actions を使う）

### 3.2 プロジェクトの雛形
1. `npx create-next-app@16.3.8`（TypeScript・ESLint・Tailwind・App Router を選び、`src/` は使わない）。
2. §4 の設定ファイルを全文そのまま置く。`package.json` の依存は §4.1 の版に揃え、`npm install` で `package-lock.json` を作る。
3. `app/globals.css` は create-next-app の既定のまま（全文は §4.17）。画面の色はコンポーネント側で直接指定する。
4. `public/` には create-next-app 既定の SVG だけが入っていて、画面では使っていない。

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
   - **作り直すときは、元の鍵を使う**こと。新しい鍵にすると、既存の D1 のデータはすべて捨てることになる。
4. GitHub の Actions シークレットを登録する：`CLOUDFLARE_API_TOKEN`（権限は Workers の編集と D1 の編集）、`CLOUDFLARE_ACCOUNT_ID`。

### 3.5 ローカルで動かす
- `.dev.vars` に4つのシークレットを書く（`.gitignore` 済み。**コミットしない**）。
- `npm run dev`：`next.config.ts` の `initOpenNextCloudflareForDev()` により、`getCloudflareContext()` からローカルの D1（`.wrangler/` 配下、Git の追跡外）が使える。ローカルの D1 には `npx wrangler d1 migrations apply re-mail --local` でスキーマを当てる。
- 開発サーバーにはセキュリティヘッダーを付けない（本番のビルドだけに付ける）。
- Workers に近い形で確かめるなら `npm run preview`。

### 3.6 デプロイ
- `main` に push すると、GitHub Actions が自動でデプロイする（§6）。手で `wrangler deploy` を実行しない。手動で動かすときは `gh workflow run deploy-worker.yml`、結果は `gh run watch` で見る。

### 3.7 作り直したあとの確認
1. `npm test` / `npm run lint` / `npx tsc --noEmit` がすべて通る。
2. ヘルスチェック（`bash script/ci/health-check.sh`、`HEALTH_CHECK_URL` で URL を変えられる）が通る。
3. 実機で、ログイン → 一覧 → チャットを開く → 返信 → 添付 → 別のアカウントでもログイン → 送信元の切り替え → アカウントを1つだけログアウト → すべてログアウトで端末のデータが消える、まで通す。
4. 送信まわりは §17.2 の比較テストを行う。

---
## 4. 設定ファイル（全文）

ここにある内容は、そのままファイルに書けば同じものになる（コメントもそのまま残す。コメントには「なぜそうしているか」が書いてある）。

### 4.1 `package.json`
`package-lock.json` は `npm install` で作り直す。

```json
{
  "name": "re-mail",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "eslint",
    "test": "vitest run --passWithNoTests",
    "preview": "opennextjs-cloudflare build && opennextjs-cloudflare preview",
    "cf-build": "opennextjs-cloudflare build"
  },
  "dependencies": {
    "localforage": "^1.10.0",
    "next": "16.3.8",
    "next-auth": "5.0.0-beta.32",
    "react": "19.2.4",
    "react-dom": "19.2.4"
  },
  "devDependencies": {
    "@opennextjs/cloudflare": "1.20.9",
    "@tailwindcss/postcss": "^4",
    "@types/node": "^20",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "eslint": "^9",
    "eslint-config-next": "16.3.8",
    "tailwindcss": "^4",
    "typescript": "^5",
    "vitest": "^4.1.10",
    "wrangler": "^4.148.0"
  }
}

```

### 4.2 `tsconfig.json`
`worker.ts` はビルドで生成される `.open-next/worker.js` を読むので、型チェックから外す。

```json
{
  "compilerOptions": {
    "target": "ES2017",
    "lib": [
      "dom",
      "dom.iterable",
      "esnext"
    ],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "react-jsx",
    "incremental": true,
    "plugins": [
      {
        "name": "next"
      }
    ],
    "paths": {
      "@/*": [
        "./*"
      ]
    }
  },
  "include": [
    "next-env.d.ts",
    "**/*.ts",
    "**/*.tsx",
    ".next/types/**/*.ts",
    ".next/dev/types/**/*.ts",
    "**/*.mts"
  ],
  "exclude": [
    "node_modules",
    "worker.ts"
  ]
}

```

### 4.3 `eslint.config.mjs`
```js
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // 位置引数の並びを保つために残している未使用の引数は、先頭に _ を付けて明示する
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", caughtErrors: "none" }],
      // React Compiler を使う前提のルール。Re:Mail は React Compiler を使っておらず、
      // イベント処理の中のコードまで「描画中」と判定する誤検知が多いため、知らせるだけ（警告）にする
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/immutability": "warn",
      // ログにメールアドレスや本文を出さないよう、console は直接使わず app/lib/safeLog.ts を通す
      "no-console": "error",
    },
  },
  {
    // safeLog だけは、形を確かめた項目を console に書き出す役目なので console を使ってよい
    files: ["app/lib/safeLog.ts"],
    rules: { "no-console": "off" },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // ビルド・ローカル実行で生成されるファイル（Lint の対象外）
    ".open-next/**",
    ".wrangler/**",
    ".vercel/**",
    // Next.js が自動生成する型ファイル
    "types/validator.ts",
    "types/routes.d.ts",
    "types/cache-life.d.ts",
  ]),
]);

export default eslintConfig;

```

### 4.4 `vitest.config.ts`
```ts
import { defineConfig } from "vitest/config";

// Workers 非依存の純粋関数（app/lib配下）だけをテストするため、
// 環境はNode標準のままでよい（jsdomやWorkersランタイムのエミュレーションは不要）
export default defineConfig({
  test: {
    include: ["app/**/*.test.ts"],
  },
});

```

### 4.5 `open-next.config.ts`
```ts
import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig();

```

### 4.6 `postcss.config.mjs`
```js
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;

```

### 4.7 `wrangler.json`
`database_id` は本番の D1 の ID。作り直すときに新しい D1 を作ったなら、その ID に置き換える。cron は毎時23分（ほかの利用者の定期実行が集中する0分を避けている）。

```json
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "re-mail",
  "main": "worker.ts",
  "compatibility_date": "2025-09-01",
  "compatibility_flags": [
    "nodejs_compat",
    "global_fetch_strictly_public"
  ],
  "assets": {
    "directory": ".open-next/assets",
    "binding": "ASSETS"
  },
  "services": [
    {
      "binding": "WORKER_SELF_REFERENCE",
      "service": "re-mail"
    }
  ],
  "observability": {
    "enabled": true
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "re-mail",
      "database_id": "f3e2ba87-ef1e-4a51-9054-b1add1cad95e",
      "migrations_dir": "migrations"
    }
  ],
  "triggers": {
    "crons": [
      "23 * * * *"
    ]
  }
}

```

### 4.8 `next.config.ts`
```ts
import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
import { SECURITY_HEADERS } from "./app/lib/securityHeaders";

const nextConfig: NextConfig = {
  // 型チェックは CI で npx tsc --noEmit として別に行うので、ビルドでは止めない
  // （Next.js 16 で eslint の設定はなくなった。Lint も CI で npm run lint として別に行う）
  typescript: {
    ignoreBuildErrors: true,
  },
  // ページ全体にセキュリティヘッダーを付ける（中身と理由は app/lib/securityHeaders.ts）。
  // CSP はここでは付けず worker.ts で付ける（ここに入れると nonce が消える。理由は securityHeaders.ts）。
  // 開発サーバー（next dev）では付けない（本番と同じにするのは本番のビルドだけ）
  async headers() {
    if (process.env.NODE_ENV !== "production") return [];
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;

// next dev でも getCloudflareContext() から D1 などのバインディングを使えるようにする
initOpenNextCloudflareForDev();

```

### 4.9 `worker.ts`
```ts
// Cloudflare Worker の入り口。OpenNext が作る Worker（.open-next/worker.js）をそのまま使い、
// 定期実行（scheduled）だけを足す（OpenNext の「カスタム Worker」の書き方）。
// .open-next/worker.js はビルドしたときにできるので、このファイルは型チェック（tsc）の対象から外してある。
// 処理の中身は型チェックされる app/lib/backfill.ts に置き、ここは呼ぶだけにする
// @ts-expect-error -- ビルドしたときにできるファイル
import { default as handler } from "./.open-next/worker.js";
import { runBackfill } from "./app/lib/backfill";
import { generateNonce, withNonceRequest, withNonceResponse } from "./app/lib/securityHeaders";

type Env = CloudflareEnv & { TOKEN_ENCRYPTION_KEY?: string };
type ScheduledCtx = { waitUntil: (p: Promise<unknown>) => void };

const worker = {
  // ページのスクリプトに付ける nonce を毎回作り、Next.js に渡して、同じ nonce の CSP を HTML の応答に付ける
  // （CSP の script-src から 'unsafe-inline' を外すため。中身は app/lib/securityHeaders.ts）
  async fetch(request: Request, env: Env, ctx: ScheduledCtx) {
    const nonce = generateNonce();
    const res = await handler.fetch(withNonceRequest(request, nonce), env, ctx);
    return withNonceResponse(res, nonce);
  },
  // 二度と Re:Mail を開かない利用者の行も、D1 で平文のまま残らないよう置き換える（wrangler.json の triggers.crons）
  async scheduled(_event: unknown, env: Env, ctx: ScheduledCtx) {
    // 暗号化の鍵は process.env から読むので、定期実行のときも入れておく（リクエストのときは OpenNext が入れる）
    if (env.TOKEN_ENCRYPTION_KEY && !process.env.TOKEN_ENCRYPTION_KEY) process.env.TOKEN_ENCRYPTION_KEY = env.TOKEN_ENCRYPTION_KEY;
    ctx.waitUntil(runBackfill(env.DB));
  },
};

export default worker;

// OpenNext が使う Durable Object のクラスも、そのまま出しておく（出さないとデプロイが失敗する）
// @ts-expect-error -- ビルドしたときにできるファイル
export { DOQueueHandler, DOShardedTagCache, BucketCachePurge } from "./.open-next/worker.js";

```

### 4.10 `env.d.ts`
`TOKEN_ENCRYPTION_KEY` などのシークレットは `process.env` から読む（OpenNext がリクエストのたびに入れる。定期実行のときだけは `worker.ts` が入れる）。

```ts
interface CloudflareEnv {
  DB: D1Database;
}
```

### 4.11 `types/next-auth.d.ts`
```ts
import "next-auth";

declare module "next-auth" {
  interface Session {
    accessToken?: string;
    // リフレッシュトークンが失効したとき "RefreshAccessTokenError" が入る（auth.ts の session コールバック参照）
    error?: string;
  }
}

```

### 4.12 `.gitignore`
```gitignore
# See https://help.github.com/articles/ignoring-files/ for more about ignoring files.

# dependencies
/node_modules
/.pnp
.pnp.*
.yarn/*
!.yarn/patches
!.yarn/plugins
!.yarn/releases
!.yarn/versions

# testing
/coverage

# next.js
/.next/
/out/

# production
/build

# misc
.DS_Store
*.pem

# debug
npm-debug.log*
yarn-debug.log*
yarn-error.log*
.pnpm-debug.log*

# env files (can opt-in for committing if needed)
.env*

# vercel
.vercel

# typescript
*.tsbuildinfo
next-env.d.ts

# OpenNext（Cloudflare Workers 用ビルド）
/.open-next/
.dev.vars*
/.wrangler/

```

### 4.13 `migrations/0001_initial.sql`
```sql
-- 0001_initial.sql
-- 旧 schema.sql をそのまま移したもの。本番 D1 には同じ内容が適用済みなので、
-- CREATE TABLE IF NOT EXISTS により初回の migrations apply では何も変わらず「適用済み」として記録される。
-- 以後のスキーマ変更は、このファイルを書き換えずに migrations/0002_xxx.sql のように新しいファイルを足す。
-- （chat_configs は複数アカウント対応のため一度だけ意図的にDROP+CREATEで作り直し済み）

CREATE TABLE IF NOT EXISTS chat_configs (
  user_email TEXT NOT NULL,      -- Re:Mailにログインしている本人
  account_email TEXT NOT NULL,   -- どの連携アカウントのチャットか（メインアカウント自身も含む）。
                                  -- __GLOBAL_SETTINGS__ / __KNOWN_BOXES__ のようなユーザー単位の
                                  -- 特殊行は、特定アカウントに紐づかないため空文字 "" を予約する
  chat_id TEXT NOT NULL,         -- アカウント内でのローカルなキー（相手名 or group:xxxx）
  custom_name TEXT,              -- 変更したチャット名
  is_pinned INTEGER DEFAULT 0,   -- ピン留め (0: false, 1: true)
  is_hidden INTEGER DEFAULT 0,   -- 非表示 (0: false, 1: true)
  hidden_at_date TEXT,           -- 非表示にした日時（ISO文字列）
  unhide_on_new INTEGER DEFAULT 0, -- 新着時に非表示解除するか (0: false, 1: true)
  PRIMARY KEY (user_email, account_email, chat_id)
);

-- フェーズ2: 複数アカウント連携。メインアカウント自身はここには含めない
-- （メインアカウントのトークンはNextAuthのJWT/セッション側で管理する）
CREATE TABLE IF NOT EXISTS linked_accounts (
  user_email TEXT NOT NULL,      -- Re:Mailにログインしている本人（＝メインアカウント）
  account_email TEXT NOT NULL,   -- 追加で連携したGoogleアカウントのアドレス
  refresh_token TEXT NOT NULL,
  access_token TEXT,
  expires_at INTEGER,            -- access_token の有効期限（ミリ秒epoch）
  created_at TEXT,
  needs_reauth INTEGER DEFAULT 0, -- リフレッシュトークンが失効し再連携が必要か (0: false, 1: true)
  name TEXT,                     -- 表示用（設定のアイコン表示切替でアバター横に出す名前）。認証には使わない
  picture TEXT,                  -- 表示用のGoogleアカウントのプロフィール画像URL。認証には使わない
  PRIMARY KEY (user_email, account_email)
);

-- 移行前に本番 D1 へ手動で実行済みの追記マイグレーション（履歴として残す）。
-- 上の CREATE 文にはこれらの列が含まれているので、新しく作る DB では不要
-- ALTER TABLE linked_accounts ADD COLUMN needs_reauth INTEGER DEFAULT 0;
-- ALTER TABLE linked_accounts ADD COLUMN name TEXT;
-- ALTER TABLE linked_accounts ADD COLUMN picture TEXT;

```

### 4.14 `migrations/0002_linked_accounts_account_enc.sql`
```sql
-- 0002_linked_accounts_account_enc.sql
-- 連携アカウントのアドレス（account_email）を D1 のキーから外すための列。
-- キーには「a1:」＋HMAC を入れ、画面に出すための元のアドレスは暗号化してこの列に持つ（app/lib/linkedAccountsStore.ts）。
-- 列を足すだけなので、この列を知らない古いコードもそのまま動く
ALTER TABLE linked_accounts ADD COLUMN account_enc TEXT;

```

### 4.15 `.github/workflows/deploy-worker.yml`
```yaml
name: Deploy Worker

on:
  push:
    branches: [main]
    # Worker に関係するファイルが変わったときだけ動かす（README など文書だけの変更では動かない）
    paths:
      - 'app/**'
      - 'public/**'
      - 'migrations/**'
      - 'auth.ts'
      - 'worker.ts'
      - 'env.d.ts'
      - 'next.config.ts'
      - 'open-next.config.ts'
      - 'postcss.config.mjs'
      - 'tsconfig.json'
      - 'eslint.config.mjs'
      - 'wrangler.json'
      - 'package.json'
      - 'package-lock.json'
      - 'script/ci/**'
      - '.github/workflows/deploy-worker.yml'
  workflow_dispatch:

permissions:
  contents: read

# デプロイが重ならないように1つずつ順番に動かす
concurrency:
  group: deploy-worker
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    env:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 24
          cache: npm
      - run: bash script/ci/retry.sh npm ci
      - run: npm test
      - run: npm run lint
      - run: npx tsc --noEmit
      - name: Build
        run: npx opennextjs-cloudflare build
      - name: Check secrets
        run: |
          if [ -z "$CLOUDFLARE_API_TOKEN" ] || [ -z "$CLOUDFLARE_ACCOUNT_ID" ]; then
            echo "::error::GitHub の Secrets に CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID が登録されていません"
            exit 1
          fi
      # 新しいコードが新しい列を使う場合に備えて、デプロイより先にスキーマを当てる。
      # 適用済みのファイルは D1 側に記録されているので、何度実行しても同じものは二度当たらない
      - name: Apply D1 migrations
        run: bash script/ci/retry.sh npx wrangler d1 migrations apply re-mail --remote
      - id: deploy
        run: bash script/ci/retry.sh npx opennextjs-cloudflare deploy
      - name: Health check
        run: bash script/ci/health-check.sh
      # 動作確認に失敗したら、1つ前の版に戻す（D1 のスキーマは戻らない）
      - name: Roll back
        if: failure() && steps.deploy.outcome == 'success'
        run: bash script/ci/retry.sh npx wrangler rollback --yes --message "Health check failed (run ${{ github.run_id }})"

```

### 4.16 `script/ci/retry.sh` / `script/ci/health-check.sh`
```bash
#!/usr/bin/env bash
# 一時的な失敗（ネットワーク、GitHub や npm の障害など）に備えて、コマンドを最大3回試す。
#   bash script/ci/retry.sh npm ci
for attempt in 1 2 3; do
  "$@" && exit 0
  if [ "$attempt" -lt 3 ]; then
    echo "::warning::失敗したので $((attempt * 20)) 秒後にやり直します（${attempt}/3）: $*"
    sleep $((attempt * 20))
  fi
done
echo "::error::3回試しても失敗しました: $*"
exit 1

```

```bash
#!/usr/bin/env bash
# デプロイした Worker の動作確認。反映を待つため、少し間を空けて最大3回試す。
# - トップページと、Auth.js のプロバイダー一覧（Worker 上の Next.js と
#   AUTH_SECRET などのシークレットが揃っているか）の両方が正しく応答するか
# - トップページの CSP に nonce があり、ページ内のインラインスクリプトがすべて同じ nonce を持っているか
#   （nonce がずれるとスクリプトが止まって画面が動かないのに、ページ自体は 200 を返すため、ここで見る）
set -euo pipefail
URL="${HEALTH_CHECK_URL:-https://re-mail.eusng90912.workers.dev}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

check_csp_nonce() {
  curl -fsS -D "$TMP/h.txt" -o "$TMP/p.html" -H "accept: text/html" "$URL/" || return 1
  local nonce
  nonce="$(grep -i '^content-security-policy:' "$TMP/h.txt" | grep -o "'nonce-[A-Za-z0-9+/=]*'" | head -1 | sed "s/'nonce-//; s/'//")"
  if [ -z "$nonce" ]; then echo "CSP に nonce がありません"; return 1; fi
  # src の無い <script> を数え、そのうち nonce が合っていないものがあれば失敗
  local inline bad
  inline="$(grep -o '<script[^>]*>' "$TMP/p.html" | grep -vc ' src=' || true)"
  bad="$(grep -o '<script[^>]*>' "$TMP/p.html" | grep -v ' src=' | grep -vc "nonce=\"$nonce\"" || true)"
  if [ "$inline" -eq 0 ]; then echo "インラインスクリプトが見つかりません（ページの形が変わった可能性）"; return 1; fi
  if [ "$bad" -ne 0 ]; then echo "nonce の合わないインラインスクリプトが ${bad} 個あります"; return 1; fi
  return 0
}

for i in 1 2 3; do
  if curl -fsS -o /dev/null "$URL/" \
    && curl -fsS "$URL/api/auth/providers" | grep -q '"google"' \
    && check_csp_nonce; then
    echo "Worker は正常に応答しています"
    exit 0
  fi
  sleep $((i * 10))
done
echo "::error::Worker が正しく応答しません: $URL"
exit 1

```

### 4.17 `app/globals.css`
```css
@import "tailwindcss";

:root {
  --background: #ffffff;
  --foreground: #171717;
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --font-sans: var(--font-geist-sans);
  --font-mono: var(--font-geist-mono);
}

@media (prefers-color-scheme: dark) {
  :root {
    --background: #0a0a0a;
    --foreground: #ededed;
  }
}

body {
  background: var(--background);
  color: var(--foreground);
  font-family: Arial, Helvetica, sans-serif;
}

```

### 4.18 `app/layout.tsx`
```tsx
import Providers from "./providers";
import "./globals.css";

// ページを開くたびにサーバーで描画する。CSP の nonce は開くたびに変わり、Next.js がそれを起動用のスクリプトに
// 付けるので、ビルド時に作った HTML（nonce が無い）を返すとスクリプトが止まって画面が動かなくなるため
export const dynamic = "force-dynamic";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

```

### 4.19 `app/providers.tsx`
```tsx
"use client";
// ログイン状態（next-auth）をページ全体に配る。layout.tsx をサーバー側の部品にするため、ここに分けた
import { SessionProvider } from "next-auth/react";

export default function Providers({ children }: { children: React.ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>;
}

```

### 4.20 `auth.ts`
アカウントを1つだけログアウトするときの引き継ぎ（`trigger === "update"` の分岐）は §7.4。

```ts
// auth.ts
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { getValidAccessToken } from "./app/lib/googleToken";
import { logError } from "./app/lib/safeLog";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { promoteLinkedAccount } from "./app/lib/linkedAccountsStore";
import { GOOGLE_OAUTH_SCOPE } from "./app/lib/googleScopes";

export const { handlers, signIn, signOut, auth } = NextAuth({
  trustHost: true,
  secret: process.env.AUTH_SECRET,
  session: {
    strategy: "jwt",
    // ログインセッション自体は最低1年間保持する（Googleのリフレッシュトークンでアクセストークンは別途自動更新される）
    maxAge: 60 * 60 * 24 * 400, // 400日
    updateAge: 60 * 60 * 24, // 1日ごとにセッションの有効期限を延長
  },
  jwt: {
    maxAge: 60 * 60 * 24 * 400,
  },
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      authorization: {
        params: {
          scope: GOOGLE_OAUTH_SCOPE,
          prompt: "consent",
          access_type: "offline", // ★重要: これがあることでリフレッシュトークンがもらえる
          response_type: "code",
        },
      },
    }),
  ],
  callbacks: {
    async jwt({ token, account, trigger, session }) {
      // ⓪ ログイン中のアカウントだけをログアウトし、ほかにログインしているアカウントの1つに引き継ぐ（画面の useSession().update から）。
      // 引き継げるのは、今のアカウントに一緒にログインしているアカウントだけ（D1 に付いているものだけ。ほかの人のアカウントにはなれない）
      if (trigger === "update" && session && typeof (session as { switchTo?: unknown }).switchTo === "string" && token.email) {
        const to = (session as { switchTo: string }).switchTo;
        try {
          const next = await promoteLinkedAccount(getCloudflareContext().env.DB, token.email, to);
          if (!next) return token;
          return {
            ...token,
            sub: to,
            email: to,
            // 名前が取れていないときはアドレスを名前にしない（画面にアドレスが2回出るため。名前なしとして扱う）
            name: next.name ?? null,
            picture: next.picture ?? null,
            accessToken: next.accessToken ?? undefined,
            // 保存されたアクセストークンが無ければ、次の通信ですぐ取り直させる
            expiresAt: next.accessToken && next.expiresAt ? next.expiresAt : 0,
            refreshToken: next.refreshToken,
            error: undefined,
          };
        } catch (error: unknown) {
          logError("auth.switchAccount", {}, error);
          return token;
        }
      }

      // ① 初回ログイン時：Googleから貰った鍵と、その有効期限、そして「更新用のマスターキー（リフレッシュトークン）」を保存する
      if (account) {
        return {
          ...token,
          accessToken: account.access_token,
          expiresAt: account.expires_at ? account.expires_at * 1000 : Date.now() + 3600 * 1000,
          refreshToken: account.refresh_token,
        };
      }

      // ② その後の通信時：現在の時刻が有効期限より前（1分ほどの余裕を持たせる）なら、今の鍵をそのまま使う
      if (Date.now() < (token.expiresAt as number) - 60 * 1000) {
        return token;
      }

      // ③ 有効期限が切れていた場合：裏側でGoogleにアクセスし、新しい鍵をもらう（ユーザーには見えない）。
      // 追加連携アカウント（フェーズ4）と同じリフレッシュロジック・同時実行対策を共有する
      try {
        const result = await getValidAccessToken(
          token.email as string,
          null, // 期限切れと判定済みなので必ずリフレッシュさせる
          null,
          token.refreshToken as string,
        );

        return {
          ...token,
          accessToken: result.accessToken,
          expiresAt: result.expiresAt,
          // Googleは新しいリフレッシュトークンを返さない場合があるため、その場合は古いものを使い回す
          refreshToken: result.refreshToken ?? token.refreshToken,
        };
      } catch (error: unknown) {
        logError("token.refresh.main", {}, error);
        // Googleが「リフレッシュトークン自体が無効」と明言した場合のみ致命的エラーにする。
        // ネットワーク瞬断やGoogle側の一時的な障害まで同じ扱いにすると、
        // 一時的な不調のたびにサインアウト＆リロードが走ってしまうため。
        const code = (error as { error?: string } | null)?.error;
        const isPermanent = code === "invalid_grant" || code === "invalid_client";
        if (isPermanent) {
          return { ...token, error: "RefreshAccessTokenError" };
        }
        // 一時的な失敗：古いトークンのまま返し、次回アクセス時に再試行させる
        return token;
      }
    },
    async session({ session, token }) {
      // セッションオブジェクトにアクセストークンとエラー状態を乗せてAPIルートで使えるようにする
      session.accessToken = token.accessToken as string | undefined;
      session.error = token.error as string | undefined;
      return session;
    },
  },
});
```

### 4.21 `app/api/auth/[...nextauth]/route.ts` と `app/lib/publicSession.ts`
```ts
// app/api/auth/[...nextauth]/route.ts
import type { NextRequest } from "next/server";
import { handlers } from "../../../../auth";
import { toPublicSession } from "../../../lib/publicSession";

// /api/auth/session の応答（ブラウザに返るセッション）からは、Gmail のアクセストークンを取り除く。
// セッション Cookie の更新（Set-Cookie）はそのまま通す
async function withoutServerOnlyFields(req: NextRequest, handler: (req: NextRequest) => Promise<Response>): Promise<Response> {
  const res = await handler(req);
  if (!new URL(req.url).pathname.endsWith("/session")) return res;
  if (!(res.headers.get("content-type") || "").includes("application/json")) return res;
  const json = await res.json().catch(() => undefined);
  const headers = new Headers(res.headers);
  // 中身を作り直すので、長さは付け直させる
  headers.delete("content-length");
  return new Response(JSON.stringify(toPublicSession(json) ?? null), { status: res.status, headers });
}

export const GET = (req: NextRequest) => withoutServerOnlyFields(req, handlers.GET);
export const POST = (req: NextRequest) => withoutServerOnlyFields(req, handlers.POST);

```

```ts
// ブラウザに返すセッションから、サーバーだけが使う値（Gmail のアクセストークン）を取り除く。
// ページの上で何かのスクリプトが動いても、Gmail を読み書きできる鍵を持ち出せないようにするため（絶対ルール1）。
// サーバー側（API ルート）は auth() でこれまでどおりアクセストークンを受け取れる
const SERVER_ONLY_FIELDS = ["accessToken", "refreshToken", "expiresAt"] as const;

export function toPublicSession(session: unknown): unknown {
  if (!session || typeof session !== "object" || Array.isArray(session)) return session;
  const copy: Record<string, unknown> = { ...(session as Record<string, unknown>) };
  for (const f of SERVER_ONLY_FIELDS) delete copy[f];
  return copy;
}

```

---

## 5. ディレクトリ構成

```
Re-Mail/
├── app/
│   ├── api/
│   │   ├── auth/[...nextauth]/route.ts   # NextAuth のハンドラ。/session の応答からアクセストークンを除く（§4.21）
│   │   ├── accounts/route.ts             # セッションを持たないアカウントの一覧（GET）・ログアウト（DELETE）
│   │   ├── accounts/connect/route.ts     # 別のアカウントでもログインするための独自 OAuth（リダイレクトとコールバックを兼ねる）
│   │   ├── avatar/route.ts               # イニシャルの SVG アバター
│   │   ├── config/route.ts               # D1 の設定の読み書き（HMAC＋暗号化。読んだときに古い形式を置き換える）
│   │   ├── config/route.test.ts
│   │   └── emails/route.ts               # Gmail の取得・差分同期・送信・送信確認・移動・削除・添付・HTML 本文・sendAs（保存せず中継だけ）
│   ├── components/
│   │   ├── Modals.tsx                    # すべてのモーダル（約3,200行）
│   │   └── ui.tsx                        # ActionBar・アイコン・HighlightText・BodyWithLinks・formatFileSize
│   ├── hooks/
│   │   └── useMailApp.ts                 # 状態とロジックの中核（約3,600行のカスタムフック。§13）
│   ├── lib/                              # React に依存しない純粋関数（ほぼすべてにテストあり。§12）
│   ├── types/
│   │   ├── mail.ts                       # ChatConfig / MessageConfig / SelectionMode / ModalState
│   │   └── email.ts                      # Email / EmailAttachment
│   ├── error.tsx / global-error.tsx      # エラー画面（もう一度表示する・ページを読み込み直す・純正 Gmail で開く）
│   ├── globals.css / layout.tsx / providers.tsx
│   └── page.tsx                          # メイン画面（ログイン・一覧・トーク。約1,060行）
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

`main` に push すると、GitHub Actions が次の順で実行する。Worker に関係するファイル（§4.15 の `paths`）が変わったときだけ動く。README など文書だけの変更では動かない。

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
- **段階2**：保存を新しい形式に切り替え、古い形式の行は**読んだときに**新しい形式に書き換える。段階1のコードは新しい形式も読めるので、段階2から1つ戻しても壊れない。
- D1 の中身を暗号化しているので、データの書き換えは SQL ではなく Worker の中で行う。
- 今のアドレスの移行は段階2（`app/lib/addressStage.ts` の `WRITE_HASHED_ADDRESS = true`）。

### 6.2 スキーマ変更の決まり
- 新しいファイル（`0003_xxx.sql` …）を足す。適用済みのファイルは書き換えない。
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

### 7.2 最初のログイン（`auth.ts`、全文は §4.20）
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
- Google がリフレッシュトークンを新しくした（ローテーションした）場合は、新しいものを必ず書き戻す。平文で残っていた古いトークンは、使われたときに暗号化して書き戻す。

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

### 8.2 D1 の値の形（段階2）

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
- 鍵が設定されていなければ、暗号化も HMAC もせずに平文のまま扱う（ローカル開発用）。本番では必ず設定されている前提。暗号化した値があるのに鍵が無いときは、復号で例外にする。
- 実装の全文は付録 A（`tokenCrypto.ts`・`addressKey.ts`・`configCrypto.ts`）。**既存の D1 のデータを読めるようにするには、ここを1文字も変えずに作り直すこと。**

### 8.3 `chat_configs`（主キー `user_email, account_email, chat_id`）
列：`user_email` / `account_email` / `chat_id` / `custom_name` / `is_pinned` / `is_hidden` / `hidden_at_date` / `unhide_on_new`（DDL は §4.13）。

- `account_email = ""` の行は予約行。`chat_id` が `__GLOBAL_SETTINGS__`（共通設定）・`__ACCOUNT_SETTINGS__`（アカウント設定）・`__KNOWN_BOXES__`（以前の版の名残）。予約行は `chat_id` を HMAC にせず、中身をまるごと暗号化する。
- **`custom_name` の中身（復号したあと）**：
  - ただの文字列なら、チャットの表示名（名前変更）。
  - `{` で始まれば JSON。チャット単位なら `ChatConfig`（§8.6）の一部。グループのメンバー・フィルターの条件・ピン留めの ID 一覧などがここに入る。
  - メッセージ単位の設定（ピン留め・非表示）は、`chat_id` を Gmail のメッセージ ID にした行で、JSON に `roomId`（複合キー）を持つ。段階2では `roomId` も暗号化（`roomIdEnc`）されるが、封筒ごと暗号化するので外からは見えない。
  - ピン留めの JSON は `ids`（Gmail のメッセージ ID の配列、新しい順、**チャットあたり最大60件**）だけを持つ。以前の形式（`data` にメール本体を入れていた）は、読んだときに本体から ID を取り出して `ids` に移し、本体を取り除いて書き戻す（`pinnedIds.ts`）。
- **読み込み（`openAndMigrateConfigs`）**：`user_email` が平文の行と `a1:` の行の両方を読み、封筒を開けて元の形に戻す。同じ設定が古い形と新しい形の両方にあれば新しい方を使い（優先度：`user_email` が `a1:` で +4、`account_email` が `a1:` で +2、`chat_id` が `h1:` で +1）、使わなかった方は消す。開けない行はログを出して飛ばすが、**消さずに残す**（鍵の問題なら直せばまた読めるため）。古い形の行や本体の残っている行は、同じ `db.batch` の中で「新しい形で書いてから古い行を消す」ので、途中で失われない。
- **保存（`saveConfig`）**：UPSERT し、同じ設定の古い形の行（平文のアドレス・平文の chat_id の組み合わせ）を同じバッチで消す。送られてきた `custom_name` にメール本体が入っていても取り除く。
- **削除（`deleteConfig`）**：古い形・新しい形のどれで保存されていても消す。
- **予約行の読み書き（`readReservedRow` / `writeReservedRow`）**：今の形の行を優先して読む。書くときはまるごと暗号化し、古い形（平文のアドレス）の行を同じバッチで消す。鍵が無く暗号化できないときは、アドレスを含む `accounts` を外してから平文で置く。
- 壊れた設定（例：壊れたフィルター定義）が1つあっても、その条件は「一致しない」扱いにして画面全体を落とさない（ルール3-3）。

#### 8.3.1 アカウントごとの置き場所（`openSessionConfigs` / `saveSessionConfig`）
設定は**そのアカウント自身の置き場所**（`user_email` = そのアカウント）に保存する。こうすると、ほかのアカウントの付属として使っていたアカウントで直接ログインしても、同じ設定がそのまま使える。

| 設定 | 置き場所 |
| --- | --- |
| チャットの設定（ピン留め・非表示・名前変更）・グループ・フィルター・メッセージ単位の設定 | そのチャットのアカウントの置き場所（`account_email` も同じアカウント） |
| アカウント設定（`__ACCOUNT_SETTINGS__`） | そのアカウントの置き場所 |
| 共通設定（`__GLOBAL_SETTINGS__`） | ログインしている**全アカウント**の置き場所に同じものを書く。読むときは `updatedAt` が一番新しいものを使う（同じならセッションを持つアカウントの分）。あとから足したアカウントにも写す |

- 「ログインしているアカウント」は、セッションのアカウントと、その `linked_accounts` に付いているアカウント（`sessionAccountList`）。API はリクエストのたびに `listLinkedAccountEmails` でこれを求める（アドレスの列だけを読んで復号する。表示名・画像は復号せず、行の書き直しもしない）。
- **読み込み（`openSessionConfigs(db, セッションのアカウント, 付いているアカウント)`）**：全アカウントの置き場所を `openAndMigrateConfigs` で読み、次の順でまとめる。
  1. 自分の置き場所にある自分のチャットの設定を使う。以前、ほかのアカウントだけが対象のフィルターをセッションのアカウント名義で保存していたものは、対象のアカウントの置き場所へ移す。
  2. **以前の置き場所**（以前はほかのアカウントの設定も、セッションのアカウントの置き場所に書いていた）にあって、自分の置き場所に無いものは使い、自分の置き場所へ写す。段階2では、写し終えた（または自分の置き場所にすでにある）以前の行を**消す**（D1 に同じ設定を2つ置かない）。消すのは書き足しのあとで、書き足しが失敗したら消さない。ログインしていないアカウント（ログアウトしたアカウントなど）の行は、セッションのアカウントの置き場所の分だけ、これまでどおり返す（消さない）。
  3. **すべてのアカウントが対象だった以前のフィルター**（`shared: true` か、`filterCriteria.accountEmail` が無いもの）は、一番新しい写しをもとに、**アカウントごとの別々のフィルター**に分けて各アカウントの置き場所に書き直す（`assignFilterAccount`）。アカウントが1つだけのときは、そのアカウントのフィルターとしてそのまま返す。
  4. 共通設定の写しが食い違っていれば、一番新しいもので書き直す。
  5. アカウント設定が無ければ、以前の共通設定にあった `alwaysLoadImages` を初期値にする（書くのは変えたときだけ）。
  - 書き足し・書き直しは失敗しても読み込みを止めない（次に読んだときにまた試す）。
  - 応答は、予約行（共通設定は1行にまとめて復号した JSON）とまとめた設定の一覧、それにアカウントごとのアカウント設定。
- **保存（`saveSessionConfig`）**：そのチャット（フィルター）のアカウントの置き場所に書く。フィルターもアカウントごとなので、全アカウントに書く設定は無い（API の `scope=shared` はやめた。関数の引数には読むときの互換のために残っている）。ログインしていないアカウントのものは、これまでどおりセッションのアカウントの置き場所に書く。保存する JSON には `updatedAt`（最後に保存した時刻）を入れる（以前の写しが残っていたとき、どれが新しいかを決めるため）。
- **移行の段階（`app/lib/configStage.ts` の `WRITE_LEGACY_LINKED_COPY`）**：**2026-10-23 に `false`（段階2）へ切り替えた。** 段階1（`true`）では、セッションのアカウント以外の設定を、そのアカウントの置き場所に加えて以前の置き場所（セッションのアカウントの `user_email`）にも書いていた（古いコードに戻しても設定が見えるように）。段階2では以前の置き場所には書かず、残っている古い写しは読んだときに消す。
- **削除（`deleteSessionConfig`）**：そのアカウントの置き場所と以前の置き場所の両方から消す。
- **共通設定の保存（`saveCommonSettings`）**：全アカウントの写しのうち一番新しいものに、変えた値を重ね、`updatedAt` を今の時刻にして、全アカウントの置き場所に書く。
- **アカウント設定の保存（`saveAccountSettings`）**：そのアカウントの置き場所の `__ACCOUNT_SETTINGS__` に、`sanitizeAccountSettings` を通した値を重ねて書く。

### 8.4 `linked_accounts`（主キー `user_email, account_email`）
列：`user_email` / `account_email` / `account_enc`（0002 で追加）/ `refresh_token` / `access_token` / `expires_at`（ミリ秒）/ `created_at`（ISO）/ `needs_reauth` / `name` / `picture`。

- 読み書きは必ず `linkedAccountsStore.ts` を通す。
  - `findLinkedAccount`：平文と `a1:` の両方のキーで探し、新しい形の行（`user_email` が `a1:` で +2、`account_email` が `a1:` で +1）を優先する。返した行のキーのまま更新する。
  - `listLinkedAccounts`：画面用にアドレス・名前・画像を復号して返す。段階2では、古い形の行をここで新しい形に置き換え、重複を消す。
  - `saveLinkedAccount`：新しい形で INSERT（衝突時は UPDATE）し、同じアカウントの古い形の行を消す。
  - `deleteLinkedAccount`：どの形で保存されていても消す。
  - `promoteLinkedAccount(db, from, to)`：セッションを持つアカウント（from）だけをログアウトし、to に引き継ぐ（§7.4）。to が from に付いていない・再ログインが必要なら `null`（何も変えない）。

### 8.5 鍵の扱い
- 鍵は **`TOKEN_ENCRYPTION_KEY` の1本だけ**。HMAC の鍵はそこから HKDF で用途別に派生させる（シークレットを増やさないため）。
- **この鍵を変える・消す・失くすと、トークンだけでなく D1 の設定もすべて読めなくなる**（HMAC のキーも作り直せない）。鍵を更新するときは、新旧どちらでも読める期間を作る。値に鍵の版を埋め込んであるので（`encv1:` → `encv2:`、`a1:` / `h1:` の数字）、それを使う。
- 鍵の控えは、開発者がリポジトリ・Cloudflare・GitHub の外に保管している。**Claude は鍵の値を見ない・書かない・保管場所を聞き出さない。**

### 8.6 設定の型（`app/types/mail.ts`）
`ChatConfig`（チャット単位）・`MessageConfig`（メッセージ単位）・`SelectionMode`・`ModalState` の全文は付録 A の `types/mail.ts`。要点：
- `ChatConfig`：`customName` / `isPinned` / `isHidden` / `hiddenAtDate` / `unhideOnNew` / `forceFetch`（永続読み込み）/ `persistedIds`（ピン留めした ID、最大60件）/ `isGroup` / `groupMembers`（ローカルキー）/ `groupMemberAddresses`（作成時に確定した実アドレス）/ `groupMode`（`normal` / `inbound_only` / `outbound_only`）/ `groupHiddenMembers`（作成時に新たに隠したメンバー）/ `filterCriteria` / `filterHideOriginal` / `filterIncludeExisting` / `filterAction`（`hide` / `pin` / `move` / `delete`）/ `filterContinuous` / `filterDestination` / `filterCreatedAt` / `filterLastAppliedAt`。
- `MessageConfig`：`isPinned` / `isHidden` / `hiddenAtDate` / `unhideOnNew` / `forceFetch` / `roomId`（複合キー）。
- チャット単位とメッセージ単位は、画面では**別のマップ**（`chatConfigs` / `messageConfigs`）に持つ。

### 8.7 定期実行による古い行の置き換え（`backfill.ts`）
- 設定は「その人が Re:Mail を開いたとき」に今の形へ置き換わる。二度と開かない人の行は、平文（本文入りのピン留めを含む）のまま残ってしまう。
- それを残さないよう、`worker.ts` の `scheduled`（毎時23分）から `runBackfill(db, 20)` を呼ぶ。`user_email NOT LIKE 'a1:%'` の利用者を `ORDER BY random()` で最大20人選び、開いたときと同じ処理（`openAndMigrateConfigs`・`listLinkedAccounts`）で置き換える。開けない行がある人で毎回つまらないよう、順番はばらばらにする。1人の失敗で、ほかの人の処理は止めない。
- 段階1（`WRITE_HASHED_ADDRESS = false`）のときは何もしない。

### 8.8 端末内の保存

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
| `drafts` | チャットの複合キー（`<アカウント>\u0000<ローカルキー>`） | 入力中の返信（本文・件名・返信先・添付） |
| `pinned` | アカウント | ピン留めしたメールの中身（`id → Email`） |
| `attachments_v2` | `<アカウント(小文字)>\|<メッセージID>:<添付の番号>:<ファイル名>:<サイズ>`（attachmentId は取り直すたびに変わることがあるのでキーにしない）。画面のキーが無いときは `<アカウント>\|<メッセージID>:<attachmentId>` | 添付の base64 |
| `video_thumbs_v2` | 同上 | 動画のサムネイル（data URL と縦横比） |

- どれも localforage の `name: "remail"`。添付とサムネイルは、メモリのキャッシュ（`Map`）と IndexedDB の2段。アカウントを含まない以前の形式のストア（`attachments` / `video_thumbs`）は、どのアカウントのものか分からないので起動時に捨てる。
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
- `GET [?account_email=]`：`{ configs: [...], accountSettings: { <アカウント>: { alwaysLoadImages?, autoReadOnOpenChat?, autoReadOnOpenMail? } } }`。`openSessionConfigs` の結果を返す。共通設定の行は `custom_name` を復号した JSON 文字列にして返す。メッセージ単位の行の `custom_name` は `revealConfigName` で `roomId` を戻して返す。`account_email` を付けると、そのアカウントの行と予約行だけに絞る。
- `POST`：
  - `{ global_settings: {...} }` → `saveCommonSettings`（全アカウントに書く）。`{ success: true, settings }`。
  - `{ account_settings: {...}, account_email }` → `saveAccountSettings`。`account_email` がログインしているアカウントでなければ `400 { error: "Unknown account" }`。`{ success: true, settings }`。
  - `{ account_email, chat_id, custom_name, is_pinned, is_hidden, hidden_at_date, unhide_on_new }` → `saveSessionConfig`（そのアカウントの置き場所に書く）。`account_email` と `chat_id` が無ければ 400。
- `DELETE ?chat_id=&account_email=`（クエリ。どちらも必須）→ `deleteSessionConfig`。
- D1 の失敗は `500 { error: "Database Error", details }` を返し、画面は `configSaveQueue` で送り直す（§12.6）。`/api/accounts` も同じ形で失敗を返す。

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
| `send`（省略時も） | `to, cc, subject, body, bodyHtml, threadId, inReplyTo, references, from, replyTo, attachments[{filename,mimeType,data}], forwardAttachmentsFrom, messageId` | §10 |
| `verifySent` | `messageId, to, cc, subject, body, sentAfterMs` | 送信済みフォルダを照合し、`{ found, id?, threadId? }` |
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

### 10.3 メールの組み立て（`mime.ts`、全文は付録 A）
- メール全体を **7bit の ASCII** にする。ヘッダーは RFC 2047（`=?UTF-8?B?...?=`、1語45バイトまで、`CRLF＋空白` で折り返す。ASCII だけなら符号化しない）。本文はすべて base64（76文字で折り返す）。
- ヘッダーの値から CR・LF を取り除き、ヘッダーの差し込みを防ぐ。
- アドレスのヘッダー（From / To / Cc / Reply-To）は、表示名だけを符号化し、`<アドレス>` はそのまま残す。
- 構造：
  - テキストと HTML の両方を `multipart/alternative` にする。
  - 本文中の画像（転送で引き継いだ cid: 画像）があれば、HTML と画像を `multipart/related` にまとめる。
  - 添付があれば、全体を `multipart/mixed` にする。添付のファイル名は `name=`（RFC 2047）・`filename=`（RFC 2047）・`filename*=UTF-8''...`（RFC 2231）を併記する。
  - 区切り文字は `remail_<UUID>`。
- **ヘッダーの並び**は純正 Gmail に合わせて `MIME-Version` → `References` → `In-Reply-To` → `From` → `Date` → `Message-ID` → `Subject` → `To` → `Cc` → `Reply-To`（無いものは出さない）。
- **Message-ID は送る前にこちらで決める。** 形は純正 Gmail と同じ `<CA` ＋ 英数字40文字 ＋ `@mail.gmail.com>`。照合に使うためと、Re:Mail から送ったことが分からないようにするため。画面から有効な Message-ID が送られてくればそれを使う（再送で同じ ID を使えるように）。
- **Date ヘッダーは付けない**（Gmail が付ける。純正と同じ）。
- `From` は、既定ではない送信元エイリアスを使うときだけ付ける（既定なら Gmail が付ける）。

### 10.4 返信（`replyCompose.ts` / `recipients.ts`、全文は付録 A）
- **件名**：「Re: 元の件名」。すでに `Re:`（大文字小文字は問わない）で始まっていれば付け足さない。元の件名が空なら `Re: `。返信中は件名欄を編集できない。
- **スレッド**：`In-Reply-To` に元の Message-ID、`References` に元の References ＋ 元の Message-ID（**直近20件まで**）、Gmail API の `threadId` を付ける。
- **宛先（`planReply`）**：
  - 既定は**「相手のみ」**（純正 Gmail と同じ）。`Reply-To` があればそちらへ。自分が送ったメールへの返信なら、元の To へ。
  - 元のメールに Cc や複数の To があるときだけ、入力欄の近くに「Cc：〇〇さん ほか2名」（`describeExtraRecipients`）と「全員に返信」の切り替えを出す。全員に返信では、自分のアドレス（すべての送信元エイリアスを含む）を除いた To と Cc を残す。
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
1. 入力中の内容（本文・件名・返信先・添付）は、チャットごとに端末へ下書き保存してある（§13.7）。
2. 送信ボタンは、1回押したら終わるまで押せなくする。
3. **成功**（Gmail が ID を返した）：画面に送ったメールを足し、下書きを消す。送った添付は、あとで見るときに取り直さなくて済むよう、添付キャッシュに先に書いておく。
4. **`failed`**：原因を表示し、下書きは残す。
5. **`unknown`**：サーバーが `findSentMessage` で送信済みフォルダを照合する。1.5秒待って1回目、4秒待って2回目。
   - まず自前の Message-ID で `rfc822msgid:` 検索する。
   - 見つからなければ、`in:sent after:<送信の60秒前>` の直近10件を、件名（空白を除いて比較）・To と Cc の集合・時刻（送信の60秒前以降）・本文の冒頭（最大40文字。Gmail の snippet の文字参照を戻して比較）で照合する。
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

### 11.3 解析（`messageParse.ts`、全文は付録 A）
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
- **`parseMessageDetail`**（`Email` 型に変える）：`subject`（無ければ「(件名なし)」）・`from`・`to`（無ければ `Delivered-To`）・`cc`・`replyTo`・`date`・`messageIdHeader`・`references`・`inReplyTo`（転送メールでは付けない）・`isForward`・`body`（整形後）・`snippet`・`labelIds`・`attachments`・`htmlLinks`・`hasHtml`。

### 11.4 HTML 本文（`html=true`）
- `fields=payload` で取り、`getHtmlBody` で最も長い HTML を選ぶ。転送メールでなければ `stripHtmlQuote` で引用を除く。
- 本文から `cid:` で参照されている画像の情報（`contentId`・`attachmentId`・`mimeType`・`size`）を最大30件返す。画面は本文を先に出し、画像は**同時に3枚まで**添付 API で取りにいって、あとから差し込む（`replaceCidImages`）。サーバーにも端末にも保存しない。1枚が10MB を超えるものは差し込まず、「Gmail で開く」を案内する。
- 表示の下ごしらえ（`emailHtml.ts`）は §15.3。

---
## 12. `app/lib/` モジュール仕様

React に依存しない純粋関数を置く。ほぼすべてに `*.test.ts` がある。★の付いたものは、**既存のデータとの互換や送信の忠実性に直結する**ので、付録 A に全文を載せた（作り直すときは全文をそのまま使う）。

### 12.1 キー・グルーピング・フィルター
| ファイル | 役割 |
| --- | --- |
| ★`roomKey.ts` | `encodeRoomKey(account, localKey)` / `decodeRoomKey(roomKey)`。区切りは `\u0000`（表示名やアドレスに絶対に出てこない文字）。`LocalKey` / `RoomKeyStr` の branded type、`asLocalKey`、`keysOf`。**区切り文字で直接 `split` してはいけない** |
| `groupEmails.ts` | `groupEmailsByRoom(emails, myAddress, chatConfigs)`：1アカウント分をローカルキーでまとめる。`mergeAccountGroups`：アカウントごとの結果を複合キーにして合体する。`applyFilterGroups`：フィルターで作ったグループを、全アカウントのメールから組み立てる（下記） |
| `filterMatch.ts` | `isMineEmail`・`getFindBarBoxKey`・`BOX_KEY_TO_LABEL`・`isActionBoxRestricted`・`messageMatchesFilter`・`getConditionSets`・`chatConfigTab`・`isEmptyFilterCriteria`（下記） |
| `mailboxOps.ts` | 移動・削除・既読／未読のラベル（`labelChangeFor`：`INBOX` は INBOX を付け TRASH・SPAM を外す／`ARCHIVE` は INBOX・TRASH・SPAM を外すだけ（Gmail にアーカイブのラベルは無い）／`SPAM` は SPAM を付け INBOX・TRASH を外す／`TRASH` は TRASH を付け INBOX・SPAM を外す。`readLabelChange`）、`sanitizeMessageIds`、`chunkIds`（`BATCH_MODIFY_LIMIT = 1000`）、`groupIdsByAccount`。サーバーと画面の両方で使う |
| `groupPaging.ts` | グループチャットの、メンバーごとのページトークンの状態をまとめる。`PAGING_DONE_STATES = ["END_ALL", "END_LIMIT"]`、`pendingMembers`、`aggregateGroupPagingState`（まだ読める人がいれば `MORE`） |
| `searchFallback.ts` | サーバー検索を、同じ語・同じ項目で二度撃たないための判定（`shouldTriggerServerSearch` / `markServerSearched`。対象の項目は `subject` / `body`） |

**`isMineEmail(email, myEmail | myEmail[])`**：`email.isMe` が true なら自分。そうでなければ、From の `<アドレス>`（無ければヘッダー全体）を小文字にして、自分のアドレス（複数可）と**完全一致**で比べる。`.includes` で部分一致させてはいけない（`a@gmail.com` が `ba@gmail.com` を自分と誤判定する）。

**保存場所の判定（`getFindBarBoxKey`）**：`SENT` か `isMe` なら送信済み → `TRASH` ならゴミ箱 → `SPAM` なら迷惑メール → `INBOX` なら受信箱 → どれでもなければアーカイブ。

**操作できない場所（`isActionBoxRestricted`）**：ピン留め・非表示はゴミ箱と迷惑メールではできない。削除はゴミ箱と送信済みではできない。移動は送信済みではできない。既読・未読にするはどこでもできる。

**グルーピング（`groupEmailsByRoom`）の規則**（ここを変えると既存のチャットの分かれ方が変わる）：
1. `senderRoom` が付いたメールは、そのルームに入れる。
2. 自分のメールでなければ、From の表示名（`<` の前、`"` を除いて trim。空なら `Unknown`）をルーム名にする。
3. 自分が送ったメールは、まずメモリ上で `INBOX` ラベルを外す。To（小文字）にルーム名か、そのルームの相手のアドレスが含まれていれば、そのルームに入れる。無ければ To の最初の宛先の表示名（無ければアドレス）で新しいルームを作る。`isMe: true` を付ける。
4. まだ返信が無くアドレスそのものがルーム名になっているルームは、同じアドレスの表示名ルーム（グループではないもの）があれば、そちらに統合する（同じ相手のチャットが2つに分かれないように）。
5. グループ（`isGroup` かつ `filterCriteria` が無いもの）：メンバーの実アドレスは `groupMemberAddresses`（作成時に確定。数がメンバーと合うときだけ使う）、無ければメンバーの個別チャットの受信メールから推定する。**グループから送ったメール＝To の宛先の集合がメンバー全員と完全に一致する自分のメール**（D1 には何も残さず、毎回 To から判定する）。それを各メンバーの個別チャットにも入れる。モードが `outbound_only` なら送ったメールだけ、`inbound_only` ならメンバーから届いたメールだけ、`normal` なら両方。
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
  accountEmail?: string;          // このフィルターのアカウント。今は必ず入る（以前の、空＝全アカウントのものは読んだときにアカウントごとに分ける。§8.3.1）
  // 以前の版のデータ（conditionSets が無いときだけ読む）
  textRules?: TextRule[]; dateRange?: { from?: string; to?: string }; hasAttachment?: boolean; isReply?: boolean; isForward?: boolean; format?: "html" | "text";
};
```
- 相手の名前・アドレスの条件は、`direction` が `sent` なら To、`received` なら From、未指定なら「自分でない方」を見る。比較は小文字にした部分一致。
- 語が空・壊れている条件はどのメールにも一致させない。`messageMatchesFilter` 全体を `try/catch` で囲み、例外なら「一致しない」にする（壊れた設定で画面を落とさない）。
- `isEmptyFilterCriteria`：条件セットも場所もアカウントも無いフィルターは、誤って全件に効かないよう弾く。

### 12.2 同期・解析・送信
| ファイル | 役割 |
| --- | --- |
| `historySync.ts` | `summarizeHistory(records)`：history の記録を「新着 `added`・削除 `deleted`・ラベルが変わった `labels`（変わった後のラベル）」にまとめる。新着のあとに消えたものは両方から外す。新着のラベルはまとめない（詳細を取るので）。`matchesBoxFlags(labelIds, flags)`：今のチェックボックスで表示する場所か（下書きは出さない。迷惑メール・ゴミ箱・送信済みのどれもオフなら、迷惑メールとゴミ箱は出さない。アーカイブがオンなら「受信箱がオン、または受信箱ではない」）。`applySyncResult`：削除を外し、ラベルを書き換え、新着を足す（すでに画面にあるか、表示する場所に入るものだけ）。`idsToFetchForLabelChanges`：ラベルの変化で表示する場所に入ってきた、画面に無いメールの ID |
| ★`messageParse.ts` | §11.3 |
| ★`mime.ts` | §10.3。`buildMimeSegments`・`buildGmailUploadBody`・`encodeMimeHeader`・`decodeMimeHeader`・`formatAddressHeader`・`splitAddressList`・`parseAddress`・`normalizeCharset` |
| ★`replyCompose.ts` | §10.4・§10.5 |
| ★`recipients.ts` | §10.4 |
| ★`sendVerify.ts` | §10.1・§10.6 |
| ★`emailHtml.ts` | §15.3 |

### 12.3 暗号・保存
| ファイル | 役割 |
| --- | --- |
| ★`tokenCrypto.ts` | `encryptSecret` / `decryptSecret` / `isEncrypted` / `hmacId`（§8.2） |
| ★`addressKey.ts` | `normalizeAddress` / `isAddressKey` / `addressKeyFor` / `lookupKeysFor`（`a1:`） |
| ★`configCrypto.ts` | `sealRow` / `openRow`（`h1:` と封筒）、`sealConfigName` / `revealConfigName`（`roomIdEnc`）、`isReservedRow`、`isSealedChatId` |
| `addressStage.ts` | `export const WRITE_HASHED_ADDRESS = true;`（段階2） |
| `configStore.ts` | §8.3・§8.3.1 |
| `configStage.ts` | `export const WRITE_LEGACY_LINKED_COPY = false;`（設定の置き場所の移行の段階2。§8.3.1） |
| `googleScopes.ts` | `GOOGLE_OAUTH_SCOPE`（§7.1） |
| `linkedAccountsStore.ts` | §8.4（`promoteLinkedAccount`、設定の読み書きで使う軽い `listLinkedAccountEmails` を含む） |
| `backfill.ts` | §8.7 |
| ★`syncedSettings.ts` | **共通設定**（`SYNCED_SETTING_TYPES`）：`inbox` / `archive` / `spam` / `trash` / `sent` / `iconLabels`（boolean）、`accounts`（アドレス → boolean、最大50件、アドレスは320文字以内で `^[^\s@]{1,64}@[^\s@]{1,255}$`）、`updatedAt`（ミリ秒。写しのどれが新しいかを決める）、`alwaysLoadImages`（以前の名残。今はアカウント設定なので画面からは書かない）。画面が持つのは `COMMON_SETTING_KEYS`（`updatedAt` と `alwaysLoadImages` を除く）。**アカウント設定**（`ACCOUNT_SETTING_TYPES`）：`alwaysLoadImages` / `autoReadOnOpenChat` / `autoReadOnOpenMail`（boolean）。`sanitizeSyncedSettings` / `sanitizeAccountSettings` は一覧に無いものを捨てる。`syncedSettingsKey`（名前の順番に左右されない比較用の文字列）・`pickCommonSettings`・`newestCommonSettings` |
| `pinnedIds.ts` | `MAX_PINNED_IDS_PER_CHAT = 60`、`isGmailId`（16進6〜32文字）、`readPinnedField`（`ids` と以前の `data` の両方を読む）、`capPinnedIds`、`mergePinnedIds`、`missingPinnedEmail`（消えていたメールの代わりに置く「このメールは存在しません」の仮のメール。`isMissing: true`）、`stripPinnedBodies`（JSON から `data` を取り除き、ID だけ残す） |
| `pinnedCache.ts` | ピン留めの中身の端末キャッシュ（ストア `pinned`、キーはアカウント） |
| `drafts.ts` | `loadDraft` / `saveDraft`（空なら消す）/ `removeDraft` / `removeAccountDrafts` / `clearDrafts`。`ComposeDraft = { subject, body, replyToMessage, attachments[{filename,mimeType,size,data}], updatedAt }` |
| `attachmentCache.ts` | §8.8 |
| `deviceData.ts` | §8.8。`clearDeviceData()`（ログアウト：`remail_` で始まる localStorage のキーを `KEEP_ON_LOGOUT` 以外すべて、sessionStorage の `remail_` のキーすべて、添付・ピン留め・下書きのストア、`localforage.clear()`）。`clearAccountDeviceData(account)`（1つのアカウントだけのログアウト：`remail_account_settings` と `remail_draft_chats` からそのアカウントの分を除き、開いていたのがそのアカウントのチャットなら `remail_selected_sender` と `remail_scroll_main` を消し、`remail_ui_state` は丸ごと消す。添付・ピン留め・下書きはそのアカウントの分だけ消す）。`DEVICE_OWNER_KEY = "remail_device_owner"` |

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
| `fakeD1.testutil.ts` | テスト用の D1 の偽物 |
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
- 入力中の返信（本文・件名・返信先・添付）を、**チャットごとに** IndexedDB に保存する（`drafts.ts`）。送信の失敗・通信断・再読み込み・チャットの切り替えで失わない。空なら消す。
- チャットを切り替えたら、そのチャットの下書きを読み込む。読み込み終わるまで送信ボタンを押せなくする（`isDraftReady`）。以前は、別のチャットで書きかけた文が今のチャットに残って誤送信される問題があった。
- 端末に保存できなかったら「入力中の内容を端末に保存できませんでした。再読み込みすると消えます…」と伝える。
- **下書きチャット**：新しい宛先でチャットを作って、まだ送っていない状態。`remail_draft_chats` に持ち、送ると普通のチャットになる。

### 13.8 送信（`handleSend`）
1. 受信専用のグループ・フィルターグループからは送れない（入力欄の上に理由を出す）。
2. グループからは、メンバー全員のアドレスを To に入れて1通で送る。
3. 返信なら `planReply` で宛先を決め（相手のみ／全員に返信）、`fetchOriginalFull`（`html=true&full=true`）で引用の元を取る。
4. sendAs を取り（10分キャッシュ、失敗したら4秒後に1回だけ）、`pickSendAs` で送信元を決める。読めなければ「このまま送る」で確かめる。既定ではない送信元のときだけ From を付ける。
5. 添付の合計が25MB を超えていたら送らずに伝える。
6. `/api/emails` に `send` を POST する。Message-ID は画面で作って渡す（再送で同じ ID を使うため）。
7. 結果は §10.6 のとおり。成功したら、送ったメールを画面に足し（実 ID、無ければ `fake-`）、送った添付を添付キャッシュに先に書き、下書きを消す。
8. 失敗のトースト：「メールの送信に失敗しました。通信状況を確認してください。」など。結果が分からないときは、送信確認のダイアログ（「再送する」）を出す。

**送信元のアカウントを切り替える（`switchSendAccount`）**：返信欄の「送信元」から別のアカウントを選ぶと、そのアカウントで同じ相手とのチャット（無ければ下書きチャット）を開く。入力中の本文・添付（返信でなければ件名も）を切り替え先へ持っていき、**切り替え元の下書きは消す**（両方に残って二重に送られないように）。返信先（元のメッセージ）はアカウントが違うので持っていかない。トースト「送信元を 〇〇 に切り替えました」。

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
   - **送信元**（グループでは出さない）：「送信元: <実際の From>」。**送るときと同じ決め方（`pickSendAs`）で、実際に使う From を出す**（元のメールが自分のエイリアス宛てならそのエイリアスと表示名、後ろに「（<アカウント> のエイリアス）」）。ログインしているアカウントが2つ以上なら「切り替え」が付き、押すと `select_send_account`。アカウントが1つでも、エイリアスから送るときは出す。sendAs はアカウントごとに10分キャッシュし、チャットを開いて1.5秒後に取りにいく（開いた直後の一括取得とぶつからないように）。
   - 返信先が選ばれていれば「返信先:」と元のメッセージ、「返信先を変更」「×」。全員に返信の対象がいるときだけ「Cc：〇〇さん ほか2名」と「全員に返信」の切り替え。
   - **スマホでは**、本文が空で返信欄にキャレット（フォーカス）も無いときは、送信元・返信先・件名を隠してメッセージを読む場所を広くとる。本文に何か書くか、返信欄に触れると出る（フォーカスが外れたかは0.4秒待ってから見る。返信欄の中のボタンを押す途中で消えないように）。パソコンでは常に出す。
   - 件名「件名 (省略可)」。返信中は編集できず、「返信の件名は、スレッドが分かれないよう元の件名に揃えます」と出す。
   - 添付（📎「ファイルを添付」。複数可、25MB まで）、本文、「送信」ボタン（本文が空・送信中・下書きを読み込み中は押せない）。
   - 受信専用のグループでは「受信専用のグループチャットのため、送信・返信はできません」、フィルターグループでは「フィルターグループのため、送信・返信はできません」と出し、入力欄を薄くして押せなくする。
   - チャットが無いときは、ヘッダーに「新規作成中」「未選択」などを出す。
7. **トースト**：画面下中央に出す。情報（`#5865F2` の枠）、エラー（赤の枠、4秒）、送信確認のダイアログ（「再送する」）。

### 14.5 アクションバー（`ui.tsx` の `ActionBar`）
選択モードで出す。ボタンは状況に応じて：「全選択」「キャンセル」「作成」（グループの作成）、「名前変更」（チャット）、「転送」「リプライ」「コピー」（メッセージ）、「ピン留め」／「ピン解除」、「既読」／「未読」（チャットなら表示されているメールすべて。すべて既読なら「未読」）、「移動」、「非表示」、「削除」、「リセット」（チャット）。保存場所で使えない操作（§12.1）は無効にする。設定で「アイコン」にするとアイコンで出す。

### 14.6 モーダル（`Modals.tsx`）
| 種類 | 中身 |
| --- | --- |
| `account_menu` | 見出し「ログイン中のアカウント」。全アカウントを同じ形で並べ（名前・アドレス・画像、セッションのものに「使用中」、切れていれば「再ログインが必要」）、各アカウントに「ログアウト」（確認：「このアカウントだけログアウトします…」と「はい」「いいえ」）、切れていれば「再ログイン」（`/api/accounts/connect`）。「+ 別のアカウントでもログイン」（`/api/accounts/connect`）、「すべてのアカウントからログアウト」（1つだけなら「ログアウト」。`clearDeviceData` してから `signOut`） |
| `settings` | タブで分ける：「共通」（どのアカウントでも同じ設定）と、アカウントごとのタブ。**共通**：「送信ボタン・アクションバー・場所の表示」の「文字」／「アイコン」（実験的）。「どのアカウントでログインしても同じ設定になります。あとから追加したアカウントにも使われます。一覧の上の受信箱〜ゴミ箱・アカウントの表示のチェックも共通設定です」。**アカウント**：「メールの外部の画像」の「押したときだけ」（既定）／「毎回読み込む」（「画像を読み込んだ時点で、送り手に『メールを開いたこと・開いた日時・おおよその場所（IP アドレス）』が伝わることがあります」）、「チャットを開いたら既読にする」「メールを開いたら既読にする」のオン／オフ（既定はオフ） |
| `select_send_account` | 見出し「送信元のアカウント」。アカウントを選ぶと、そのアカウントで同じ相手とのチャットを開く（「選んだアカウントで、この相手とのチャットを開きます（やり取りが無ければ新しいチャットになります）。入力中の本文と添付は引き継ぎます」） |
| `compose_new_chat` | 新規作成・グループ作成・転送の宛先選び。送信元のアカウントを選び、既存の相手か新しいアドレスを選ぶ。複数選ぶとグループ作成になり、モード（通常／受信専用／送信専用）とメンバーの個別チャットを隠すかを選ぶ。転送モードでは25MB を確かめ、ボタンは「転送」 |
| `categorized_action_select` | 移動・削除・ピン留め・非表示の対象を、アカウント × 場所ごとの件数で選ぶ。移動では移動先（受信箱／アーカイブ／迷惑メール／ゴミ箱）も選ぶ |
| `confirm_pin` / `confirm_unpin` / `confirm_delete` / `confirm_delete_group` / `confirm_hide` | 確認。非表示では「新着が来たら再表示する」を選べる。グループの削除では、作成時に自分が隠したメンバーだけを元に戻す |
| `rename` | チャットの名前を変える |
| `reset_select` | リセットの範囲（すべて／選んだチャット）を選ぶ |
| `select_reply_target` | 返信先のメッセージを選ぶ |
| `search` | 検索モーダル（§14.7） |
| `filter_tool` | フィルターツール（§14.8） |

**メールの詳細（`EmailModal`）**：差出人・宛先・Cc・日時・件名、HTML 本文（§15.3 の iframe）、「画像を表示」ボタン（リモートの画像があるときだけ）、添付の一覧、「Gmail で開く」。

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

### 15.1 ページ全体のヘッダー（`securityHeaders.ts`、全文は付録 A）
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

### 15.3 HTML メールの表示（`emailHtml.ts`、全文は付録 A）
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

### 15.4 ログ（`safeLog.ts`、全文は付録 A）
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

- `npm test`（Vitest、`app/**/*.test.ts`、Node 環境）。今あるテストは29ファイル・約270件。
- テストのあるファイル：`roomKey` `groupEmails` `filterMatch` `groupPaging` `searchFallback` `historySync` `messageParse` `mime` `replyCompose` `recipients` `sendVerify` `emailHtml` `safeLog` `tokenCrypto` `addressKey` `configCrypto` `configStore` `linkedAccountsStore` `backfill` `syncedSettings` `securityHeaders` `configSaveQueue` `pinnedIds` `drafts` `gmailLink` `publicSession`、`mailboxOps`、`configSpaces`（アカウントごとの置き場所）、`app/api/config/route.test.ts`。
- D1 は `fakeD1.testutil.ts` の偽物で試す。暗号は、テスト用に作った鍵を `process.env.TOKEN_ENCRYPTION_KEY` に入れて試す（本物の鍵は使わない）。
- **必ず境界値のテストを書くもの**（壊れると絶対ルールに直結する）：送信の MIME の組み立て（日本語の件名、長い件名、絵文字、Cc あり、日本語のファイル名、ヘッダーへの改行の差し込み）、宛先の計算（Reply-To、自分が送ったメールへの返信、全員に返信で自分を除く）、暗号化と HMAC（古い形式を読める・鍵が無いとき）、入力の上限（巨大な入力・深い入れ子・壊れた MIME）、ログの伏せ字、送信結果の分類。
- `npm test`・`npm run lint`・`npx tsc --noEmit` の3つがすべて通ってから push する（CI でも確かめ、どれか失敗するとデプロイされない）。
- Lint のエラーは0に保つ。React Compiler 向けの4つのルールは誤検知が多いので警告にしてある。その行だけルールを外すときは `// eslint-disable-next-line <ルール> -- <理由>` と必ず理由を書く。`any` を使わない。

---

## 17. 変更時のチェックリスト

### 17.1 毎回の確認（`CLAUDE.md` にも同じものがある）
- [ ] サーバー（D1・ログ）にメールの中身や平文の個人情報を書いていないか
- [ ] ログ出力は `safeLog.ts` を通しているか
- [ ] 外部ドメインへの通信（CDN・解析・画像など）を増やしていないか
- [ ] 送信処理に自動再試行を入れていないか（429・レート制限の 403 以外）
- [ ] 宛先（To / Cc）・件名・スレッド・添付・署名が落ちる経路はないか
- [ ] 失敗したとき、画面に見える表示と次の行動があるか
- [ ] 異常に大きい・壊れた入力で固まらないか（上限があるか）
- [ ] D1 の変更は2段階で、古いコードでも壊れないか
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

### 18.3 ルールとのギャップのうち、開発者が判断してそのままにするもの
| 項目 | 理由 |
| --- | --- |
| メール本文の iframe の `sandbox` に `allow-same-origin` が付いている | `allow-scripts` は無いので本文のスクリプトは動かない。これ以上の項目は足さない |
| CSP の `style-src` に `'unsafe-inline'` が残っている | React の style 属性とメール本文の style が使うため。CSS ではスクリプトは動かない |

ほかに、品質の改善候補として `next.config.ts` の `ignoreBuildErrors: true` がある（CI で `tsc` を通しているので実害は無い）。

### 18.4 一般公開に向けて残っているもの
- **Google の OAuth 審査**：`gmail.modify` は制限付きスコープなので、100人を超えて公開するには審査と第三者のセキュリティ評価（CASA）が要る。審査前は「未確認のアプリ」の警告が出て、テストユーザーは100人まで、リフレッシュトークンは7日で失効する。D1 に平文の個人情報を残さない形にしたので、審査で説明する範囲は小さくなった。
- **プライバシーポリシー・利用規約**：「メールはサーバーに保存しない」「D1 にはキーを HMAC にして中身を暗号化した設定（共通設定・アカウント設定を含む）と、暗号化したトークンだけを置き、古い形式の行も定期的に置き換える」「端末内のデータはログアウトで消す」「第三者に送らない」「ログに個人情報を残さない」「HTML メールの外部画像は既定で読み込まない」と書く。Google API Services User Data Policy（Limited Use）に従うことも書く。
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
| D1 の書き換えを SQL ではなく Worker で行い、2段階で入れる | 中身が暗号化されているので SQL では書き換えられない。ロールバックで壊れないようにするため |
| 定期実行で古い行を置き換える | 二度と開かない人の行が平文のまま残らないようにするため |
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
| フィルターをアカウントごとにし、全アカウント対象のフィルターを分ける | どのアカウントのフィルターかを明確にし、ほかのアカウントのメールを混ぜない（送信元の取り違えなどを防ぐ）ため |
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
## 付録 A. 互換性に直結するソースの全文

ここに載せたファイルは、**既存の D1 のデータを読めるか・送ったメールが純正 Gmail と同じになるか・個人情報が漏れないか・アカウントを取り違えないか**を決める。作り直すときは、ここにある全文をそのまま使う（1文字でも変えると、たとえば HMAC の値が変わって既存の設定がすべて見つからなくなる）。ほかのファイル（`useMailApp.ts`・`page.tsx`・`Modals.tsx`・`ui.tsx`・API ルートなど）は、本文の仕様から組み立てる。

| 節 | ファイル | 決めること |
| --- | --- | --- |
| A.1 | `app/types/email.ts` | メールの型 |
| A.2 | `app/types/mail.ts` | 設定・選択・モーダルの型（D1 の JSON の形） |
| A.3 | `app/lib/roomKey.ts` | 複合キー |
| A.4 | `app/lib/tokenCrypto.ts` | 暗号文と HMAC の形 |
| A.5 | `app/lib/addressKey.ts` | アドレスのキー（a1:） |
| A.6 | `app/lib/addressStage.ts` | アドレスの移行の段階 |
| A.7 | `app/lib/configCrypto.ts` | chat_id（h1:）と封筒 |
| A.8 | `app/lib/configStage.ts` | 設定の置き場所の移行の段階 |
| A.9 | `app/lib/configStore.ts` | 設定の読み書き・アカウントごとの置き場所・移行 |
| A.10 | `app/lib/linkedAccountsStore.ts` | アカウントのトークンの読み書き・引き継ぎ・移行 |
| A.11 | `app/lib/backfill.ts` | 定期実行 |
| A.12 | `app/lib/pinnedIds.ts` | ピン留めの保存形式 |
| A.13 | `app/lib/syncedSettings.ts` | 共通設定・アカウント設定の名前と型 |
| A.14 | `app/lib/googleScopes.ts` | Google に求める権限 |
| A.15 | `app/lib/googleToken.ts` | トークンの更新 |
| A.16 | `app/lib/safeLog.ts` | ログに出してよいもの |
| A.17 | `app/lib/securityHeaders.ts` | CSP とヘッダー |
| A.18 | `app/lib/emailHtml.ts` | HTML メールの表示 |
| A.19 | `app/lib/sendVerify.ts` | 送信結果の分類と照合 |
| A.20 | `app/lib/mime.ts` | 送信メールの組み立て |
| A.21 | `app/lib/replyCompose.ts` | 返信・転送の本文と件名 |
| A.22 | `app/lib/recipients.ts` | 返信の宛先 |
| A.23 | `app/lib/messageParse.ts` | 受信メールの解析 |
| A.24 | `app/lib/historySync.ts` | 差分同期 |
| A.25 | `app/lib/mailboxOps.ts` | 移動・削除・既読／未読のラベル |
| A.26 | `app/lib/filterMatch.ts` | フィルター条件 |
| A.27 | `app/lib/groupEmails.ts` | チャットの分け方 |

### A.1 `app/types/email.ts`

```ts
// 添付ファイルのメタデータ。送信直後にローカルで作ったメールには attachmentId が無い
// （中身はアタッチメントキャッシュに先回りで書き込んである）
export type EmailAttachment = {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId?: string;
};

// Gmail APIのメッセージ（生データ）と、送信直後にローカルで作る表示用オブジェクトの両方が
// 流れ込む、アプリ全体で扱う「メール」の形（/api/emails の parseMessageDetail の戻り値に合わせる）
export type Email = {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  // 返信の宛先（全員に返信・Reply-To）を純正 Gmail と同じに決めるために持つ。送信直後の仮オブジェクトには無いことがある
  cc?: string;
  replyTo?: string;
  date: string;
  body: string;
  snippet: string;
  labelIds: string[];
  // 送信直後にローカルで作った表示用オブジェクトにのみ付与される（生データには無い）。
  // isMineEmail() は From ヘッダーによるフォールバックも併用する
  isMe?: boolean;
  // グループチャット等で、このメッセージがどのルームに属するか明示的に指定する場合に使う
  senderRoom?: string;
  attachments?: EmailAttachment[];
  // HTML本文から抜き出したリンク（テキスト版本文ではリンク先が失われるため）
  htmlLinks?: { text: string; href: string }[];
  hasHtml?: boolean;
  // 返信元メッセージのローカルID（表示用のチップ紐付けに使う）
  replyToId?: string;
  // 送信メールに引用として付与する、返信元メッセージの Message-ID ヘッダー値
  inReplyTo?: string;
  // このメッセージ自体の Message-ID ヘッダー値（他メッセージから返信元として参照される）
  messageIdHeader?: string;
  // このメッセージの References ヘッダー値（返信するときに、純正 Gmail と同じくこれを引き継ぐ）
  references?: string;
  isForward?: boolean;
  // フェーズ3以降、どの連携アカウントで受信/送信したメールかを表す。フェーズ2までは未設定
  accountId?: string;
  // ピン留めしていたメールが Gmail 側で削除されて取得できなかったときの表示用（app/lib/pinnedIds.ts）
  isMissing?: boolean;
};

```

### A.2 `app/types/mail.ts`

```ts
import type { FilterCriteria } from "../lib/filterMatch";
import type { LocalKey, RoomKeyStr } from "../lib/roomKey";
import type { Email } from "./email";

export type GroupMode = "normal" | "inbound_only" | "outbound_only";

export type ChatConfig = {
  customName?: string;
  isPinned?: boolean;
  isHidden?: boolean;
  hiddenAtDate?: string;
  unhideOnNew?: boolean;
  // チャット全体をピン留めしたときに、そのチャットの全メッセージを強制的に永続読み込みするかどうか
  forceFetch?: boolean;
  // ピン留めしたチャットのメールの Gmail メッセージ ID（新しい順、最大60件）。D1 には中身を置かず ID だけを保存し、
  // 中身は端末キャッシュ（app/lib/pinnedCache.ts）と Gmail から取る
  persistedIds?: string[] | null;
  isGroup?: boolean;
  // メンバーはアカウント内のローカルキー（相手の表示名やアドレス）で保存する。groupEmailsByRoomが
  // アカウントごとのローカルroom空間で照合するため、複合キー（RoomKeyStr）を混ぜてはいけない
  groupMembers?: LocalKey[];
  // groupMembers と同じ並び順でのメンバーの実メールアドレス。作成時に一度だけ確定させて保存する
  // （メンバー数分だけの固定サイズなので、送信のたびに増え続けるデータにはならない）
  groupMemberAddresses?: string[];
  groupMode?: GroupMode;
  // このグループの作成時に、まだ非表示になっていなかったのを新たに非表示にしたメンバーの一覧。
  // グループ削除時に、この一覧の分だけ非表示を解除する（グループ作成前から非表示だったものは触らない）。
  // groupMembers と同じくローカルキー
  groupHiddenMembers?: LocalKey[];
  // フィルターツールで作成したグループ用。存在する場合、このグループはアドレス集合ベースではなく
  // フィルター条件ベース（動的に再評価される）であることを示す
  filterCriteria?: FilterCriteria;
  // true の場合、フィルター条件に一致したメッセージを他の全ルーム（元の個別チャット等）から
  // 動的に除外する（groupedEmails側で毎回再計算されるため、明示的な復元処理は不要）
  filterHideOriginal?: boolean;
  // グループフィルター用。false の場合、作成時点（filterCreatedAt）より前の既存メールは
  // グループに含めず、それ以降に届いた新着メールだけを対象にする。未指定/true は既存メールも含める（デフォルト）
  filterIncludeExisting?: boolean;
  // フィルターツールの非グループ系アクション（非表示/ピン留め/移動/削除）を「継続」で保存した場合のみ設定される。
  // isGroup とは排他的に使う（filterAction が設定されている行はグループではない）
  filterAction?: "hide" | "pin" | "move" | "delete" | "read" | "unread";
  // true = 継続（新着メールにも自動適用され続ける）。継続のフィルターのみこの行自体が永続化される
  filterContinuous?: boolean;
  // move専用: 移動先のGmailラベル（INBOX/ARCHIVE/SPAM/TRASH）
  filterDestination?: string;
  // 継続フィルターの作成時刻（ISO）
  filterCreatedAt?: string;
  // 継続フィルターが新着メールを最後に自動適用した時刻（ISO）。この時刻より新しい日時のメールだけが次回の自動走査対象になる
  filterLastAppliedAt?: string;
};

// 個別メッセージ単位の設定（ピン留め・非表示）。chatConfigs（room単位）とは別のキー空間・別のマップで持つ
// （以前は同じ chatConfigs マップに roomId の有無で混在させていたが、roomKey導入にあたって
// 「roomではないメッセージID」が同じ名前空間に紛れ込むのを避けるため分離した）
export type MessageConfig = {
  isPinned?: boolean;
  isHidden?: boolean;
  hiddenAtDate?: string;
  unhideOnNew?: boolean;
  // このメッセージ自身の永続コピーを保持するか（ピン留め等で、通常の取得ページングの外にあっても表示し続けるため）
  forceFetch?: boolean;
  // このメッセージがどのroomに属するか（room単位のchatConfigsのキーと同じ空間＝複合キー）
  roomId?: RoomKeyStr;
};

export type SelectionMode = "none" | "chat_select" | "msg_select" | "chat_hide" | "chat_delete" | "msg_hide" | "msg_delete" | "chat_pin" | "msg_pin" | "chat_reset" | "msg_reset" | "chat_move" | "msg_move";

export type ModalState = {
  type: "confirm_delete" | "confirm_hide" | "rename" | "confirm_pin" | "confirm_unpin" | "reset_select" | "categorized_action_select" | "select_reply_target" | "select_send_account" | "compose_new_chat" | "confirm_delete_group" | "search" | "account_menu" | "filter_tool" | "settings";
  targetMode: "chat" | "msg" | "all_chats" | "current_chat" | "specific_chat";
  targets: string[];
  action?: "pin" | "hide" | "delete" | "move";
  refinedTargets?: string[];
  // compose_new_chat 用: "forward" のとき、宛先選択後のボタンは「転送」になり、
  // forwardMessage を選択した宛先へ転送する（新しいチャットを開いたりグループを作ったりはしない）
  composeMode?: "create" | "forward";
  forwardMessage?: Email;
  // reset_select 用: 対象がすべてのチャット/メッセージ（"all"）か、選択した特定のチャットだけ（"specific"）か
  resetScope?: "all" | "specific";
} | null;

// モーダルの対象の種類（チャット単位・メッセージ単位など）
export type ModalTargetMode = NonNullable<ModalState>["targetMode"];

```

### A.3 `app/lib/roomKey.ts`

```ts
// roomKeyの組み立て・分解を一元化する。表示名やメールアドレスに絶対出現しない制御文字を
// 区切り文字に使うことで、「相手の表示名にたまたま区切り文字と同じ並びの文字列が含まれる」
// ような衝突を構造的に防ぐ。
//
// ルール: 以後、roomKey の直接パース（区切り文字での split 等）をこのファイル以外に
// 書かない。必ず encodeRoomKey / decodeRoomKey を経由すること。
//
// 型レベルの安全策: LocalKey（アカウント内だけで通用する生の識別子。相手の表示名・
// group:xxxx・GmailメッセージIDなど）と RoomKeyStr（encodeRoomKey済みの複合文字列）を
// 別のbranded typeにしている。「room名をGmail検索クエリにそのまま埋め込む関数にroomKeyStr
// を渡してしまう」「複合キーであるべき場所に生のlocalKeyを渡してしまう」といった取り違えを、
// 実行時ではなくtscのコンパイル時に検出できるようにするため
declare const localKeyBrand: unique symbol;
declare const roomKeyBrand: unique symbol;
export type LocalKey = string & { readonly [localKeyBrand]: true };
export type RoomKeyStr = string & { readonly [roomKeyBrand]: true };

// 新規にlocalKeyを作る場所（メール差出人名の抽出、group:xxxxの生成など）で使う、
// 「このstringは意図的にLocalKeyとして扱う」という宣言
export function asLocalKey(s: string): LocalKey {
  return s as LocalKey;
}

const SEP = "\u0000";

export function encodeRoomKey(accountEmail: string, localKey: LocalKey | string): RoomKeyStr {
  if (localKey.includes(SEP)) throw new Error("localKey must not contain the separator");
  return `${accountEmail}${SEP}${localKey}` as RoomKeyStr;
}

export function decodeRoomKey(roomKey: RoomKeyStr | string): { accountEmail: string; localKey: LocalKey } {
  const idx = roomKey.indexOf(SEP);
  if (idx === -1) throw new Error(`Invalid room key (missing account prefix): ${roomKey}`);
  return { accountEmail: roomKey.slice(0, idx), localKey: roomKey.slice(idx + 1) as LocalKey };
}

// Object.keys() はTypeScript標準ライブラリの制限で常に string[] を返してしまう
// （branded typeのキーを保ったまま返せない）ため、その情報を型として復元するためのヘルパー
export function keysOf<K extends string>(o: Record<K, unknown>): K[] {
  return Object.keys(o) as K[];
}

```

### A.4 `app/lib/tokenCrypto.ts`

```ts
// linked_accounts テーブルに保存する refresh_token / access_token を、Cloudflareの環境変数
// TOKEN_ENCRYPTION_KEY（base64エンコードされた32バイトのAES鍵）でAES-256-GCM暗号化する。
// これらのトークンはGmailへの継続的なアクセスを許す長期的な資格情報のため、D1へ平文で
// 置くのはリスクが大きい（D1への読み取りアクセスがあれば誰でもそのアカウントを使えてしまう）。
//
// 後方互換のための設計:
// - TOKEN_ENCRYPTION_KEY が未設定の場合は暗号化せず平文のまま返す（既存の挙動を壊さないが、
//   本番運用前に必ず設定することを強く推奨する。設定漏れに気づけるよう警告ログ tokenCrypto.keyMissing を出す）
// - 復号時、値が "encv1:" で始まらない場合は暗号化前の古いデータとみなしてそのまま返す
//   （鍵導入前に保存された既存の連携アカウントのトークンを引き続き使えるようにするため）
// - 呼び出し側（resolveAccessToken）は、読み取った値が平文だったときに再暗号化して
//   書き戻すことで、使われるたびに徐々に暗号化済みへ移行していく

import { logWarn } from "./safeLog";

const ENC_PREFIX = "encv1:";
let warnedMissingKey = false;

async function importKey(): Promise<CryptoKey | null> {
  const keyB64 = process.env.TOKEN_ENCRYPTION_KEY;
  if (!keyB64) {
    if (!warnedMissingKey) {
      // TOKEN_ENCRYPTION_KEY 未設定。linked_accounts のトークンが平文のまま保存されるので、運用前に設定する
      logWarn("tokenCrypto.keyMissing");
      warnedMissingKey = true;
    }
    return null;
  }
  const raw = Uint8Array.from(atob(keyB64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin);
}
function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export async function encryptSecret(plain: string): Promise<string> {
  if (!plain) return plain;
  const key = await importKey();
  if (!key) return plain;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain));
  return `${ENC_PREFIX}${toBase64(iv)}:${toBase64(new Uint8Array(ciphertext))}`;
}

export async function decryptSecret(stored: string | null | undefined): Promise<string> {
  if (!stored) return stored || "";
  if (!stored.startsWith(ENC_PREFIX)) return stored; // 鍵導入前の平文データ（後方互換）
  const key = await importKey();
  if (!key) {
    // 暗号化済みデータがあるのに鍵が無い（鍵をローテーション/削除してしまった等）場合は
    // 復号不能なので、呼び出し側がリフレッシュ失敗として扱えるよう例外にする
    throw new Error("Cannot decrypt: TOKEN_ENCRYPTION_KEY is not set but stored value is encrypted");
  }
  const [, ivB64, dataB64] = stored.split(":");
  const iv = fromBase64(ivB64);
  const ciphertext = fromBase64(dataB64);
  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, ciphertext as BufferSource);
  return new TextDecoder().decode(plainBuf);
}

// 値が既に暗号化済み（＝再暗号化不要）かどうか
export function isEncrypted(stored: string | null | undefined): boolean {
  return !!stored && stored.startsWith(ENC_PREFIX);
}

// D1 の chat_id（相手の名前やアドレス）を、元に戻せない決まった値に置き換えるための HMAC。
// 同じ相手なら同じ値になるので、行を探す・上書きする・消すことはこれまでどおりできる。
// 鍵は TOKEN_ENCRYPTION_KEY から HKDF で別の用途の鍵を作って使う（新しいシークレットを増やさないため）。
// TOKEN_ENCRYPTION_KEY が無ければ null を返す（呼び出し側は平文のまま扱う）
let hmacKeyPromise: Promise<CryptoKey | null> | null = null;
function importHmacKey(): Promise<CryptoKey | null> {
  if (!hmacKeyPromise) {
    hmacKeyPromise = (async () => {
      const keyB64 = process.env.TOKEN_ENCRYPTION_KEY;
      if (!keyB64) return null;
      const raw = Uint8Array.from(atob(keyB64), (c) => c.charCodeAt(0));
      const base = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
      return crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode("remail-chat-id-hmac-v1") },
        base,
        { name: "HMAC", hash: "SHA-256", length: 256 },
        false,
        ["sign"],
      );
    })();
  }
  return hmacKeyPromise;
}

export async function hmacId(value: string): Promise<string | null> {
  const key = await importHmacKey();
  if (!key) return null;
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
  // 行のキーに使うので、URL でも安全な文字だけにする（43文字）
  return toBase64(sig).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

```

### A.5 `app/lib/addressKey.ts`

```ts
// D1 のキーにしている自分のアドレス（user_email・account_email）を、元に戻せない決まった値に置き換える。
// Re:Mail をほかの人も使うので、D1 だけが漏れても利用者のアドレス一覧が分からないようにする（絶対ルール1）。
// HMAC の計算は呼び出し側から渡す（tokenCrypto.ts の hmacId。テストでは差し替える）

export const ADDRESS_KEY_PREFIX = "a1:";

// 大文字小文字や前後の空白の違いで別の値にならないようにする（違うと「自分の設定が見つからない」になるため）
export function normalizeAddress(email: string): string {
  return (email || "").trim().toLowerCase();
}

export function isAddressKey(value: string | null | undefined): boolean {
  return !!value && value.startsWith(ADDRESS_KEY_PREFIX);
}

type Hmac = (value: string) => Promise<string | null>;

// アドレスを D1 のキーにする値。鍵が無ければ null（呼び出し側は平文のまま扱う）
export async function addressKeyFor(email: string, hmac: Hmac): Promise<string | null> {
  const n = normalizeAddress(email);
  if (!n) return null;
  // chat_id の HMAC と同じ鍵を使うので、用途の違う値と重ならないよう前に印を付けて計算する
  const h = await hmac(`addr:${n}`);
  return h ? ADDRESS_KEY_PREFIX + h : null;
}

// 移行の途中は平文の行と置き換えた行が混ざるので、両方で探す
export async function lookupKeysFor(email: string, hmac: Hmac): Promise<string[]> {
  const keys = [email];
  const hashed = await addressKeyFor(email, hmac);
  if (hashed) keys.push(hashed);
  return keys;
}

```

### A.6 `app/lib/addressStage.ts`

```ts
// 自分のアドレス（user_email・account_email）を D1 のキーから外す移行の段階。設定（chat_configs）と
// 連携アカウント（linked_accounts）で同じ値を使う。
//   false（段階1）: アドレスを置き換えた行も読める。保存はアドレスを平文のまま
//   true（段階2）: アドレスを置き換えて保存し、古い形の行は読んだときに置き換える
// 段階1のコードは段階2の行も読めるので、段階2から1つ前に戻しても壊れない
export const WRITE_HASHED_ADDRESS = true;

```

### A.7 `app/lib/configCrypto.ts`

```ts
// chat_configs.custom_name（JSON）のうち、相手の名前・アドレスを含む値を暗号化して D1 に置くための変換。
// 今はメッセージ単位のピン留め・非表示の roomId（「アカウント＋相手の名前」の複合キー）が対象。
// 暗号化・復号の関数は呼び出し側から渡す（tokenCrypto.ts の encryptSecret / decryptSecret。テストでは差し替える）。
//
// 古いコードに戻しても壊れないよう、2段階で入れる:
// 段階1: 読むときに roomIdEnc を復号して roomId として返す（保存はまだ平文の roomId）
// 段階2: 保存するときに roomId を roomIdEnc に置き換える（段階1のコードは roomIdEnc を読めるので、戻しても壊れない）

type Crypt = (value: string) => Promise<string>;

function parseObject(customName: string | null | undefined): Record<string, unknown> | null {
  if (!customName || !customName.startsWith("{")) return null;
  try {
    const v = JSON.parse(customName);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// D1 から読んだ custom_name を、画面に返す形にする（roomIdEnc → roomId）。
// 復号できなければ roomId を空にする（空でもメッセージ単位の設定として扱われ、どのルームにも属さないだけで壊れない）
export async function revealConfigName(customName: string | null | undefined, decrypt: Crypt): Promise<string | null | undefined> {
  const obj = parseObject(customName);
  if (!obj || typeof obj.roomIdEnc !== "string") return customName;
  const { roomIdEnc, ...rest } = obj;
  let roomId = "";
  try { roomId = await decrypt(roomIdEnc as string); } catch { roomId = ""; }
  return JSON.stringify({ ...rest, roomId });
}

// 保存する custom_name の roomId を暗号化して roomIdEnc に置き換える（段階2で使う）
export async function sealConfigName(customName: string | null | undefined, encrypt: Crypt): Promise<string | null | undefined> {
  const obj = parseObject(customName);
  if (!obj || typeof obj.roomId !== "string" || !obj.roomId) return customName;
  const { roomId, ...rest } = obj;
  return JSON.stringify({ ...rest, roomIdEnc: await encrypt(roomId as string) });
}

// 平文の roomId が残っている（段階2より前に保存された）行か
export function hasPlainRoomId(customName: string | null | undefined): boolean {
  const obj = parseObject(customName);
  return !!obj && typeof obj.roomId === "string" && !!obj.roomId;
}

// ---- 行ごとの暗号化（chat_id と custom_name をまとめて隠す） ----
// D1 の chat_id（相手の名前・アドレス、またはメッセージ ID）を「h1:」＋HMAC に置き換え、
// 元の chat_id と custom_name（自分で付けた名前・グループのメンバー・フィルターの語など）は
// まとめて暗号化して custom_name に入れる。画面とのやり取りは、これまでどおり元の chat_id と custom_name で行う

export const SEALED_CHAT_ID_PREFIX = "h1:";

export type RowCrypto = {
  hmac: (value: string) => Promise<string | null>;
  encrypt: Crypt;
  decrypt: Crypt;
};

// account_email が空の行は __GLOBAL_SETTINGS__ などの予約行（個人情報を含まない）なので、そのまま扱う
export function isReservedRow(accountEmail: string | null | undefined): boolean {
  return !accountEmail;
}

export function isSealedChatId(chatId: string | null | undefined): boolean {
  return !!chatId && chatId.startsWith(SEALED_CHAT_ID_PREFIX);
}

// 保存する形にする。鍵が無い（HMAC が作れない）ときは null（呼び出し側は平文のまま保存する）。
// accountEmail を渡すと、元のアカウントのアドレスも一緒に暗号化して持つ（account_email 列を置き換えた後に戻すため）
export async function sealRow(chatId: string, customName: string | null | undefined, c: RowCrypto, accountEmail?: string): Promise<{ chatId: string; customName: string } | null> {
  const hashed = await c.hmac(chatId);
  if (!hashed) return null;
  const envelope = JSON.stringify(accountEmail ? { c: chatId, n: customName ?? null, a: accountEmail } : { c: chatId, n: customName ?? null });
  return { chatId: SEALED_CHAT_ID_PREFIX + hashed, customName: await c.encrypt(envelope) };
}

// D1 の行を、画面に返す形（元の chat_id と custom_name）に戻す。暗号化していない行はそのまま。
// 復号できない行は null（その行は返さない。ほかの行の表示は止めない）
export async function openRow(chatId: string, customName: string | null | undefined, c: RowCrypto): Promise<{ chatId: string; customName: string | null; accountEmail?: string } | null> {
  if (!isSealedChatId(chatId)) return { chatId, customName: customName ?? null };
  try {
    const env = JSON.parse(await c.decrypt(customName || "")) as { c?: unknown; n?: unknown; a?: unknown };
    if (typeof env.c !== "string" || !env.c) return null;
    const out: { chatId: string; customName: string | null; accountEmail?: string } = { chatId: env.c, customName: typeof env.n === "string" ? env.n : null };
    if (typeof env.a === "string" && env.a) out.accountEmail = env.a;
    return out;
  } catch {
    return null;
  }
}

```

### A.8 `app/lib/configStage.ts`

```ts
// 設定をアカウントごとの置き場所（そのアカウントの user_email）に移す移行の段階。
//   true（段階1）: 連携アカウントの設定を、そのアカウントの置き場所に書き、以前の置き場所（メインアカウントの user_email）にも同じものを書く。
//                  古いコードに戻しても、以前の置き場所の行で設定が見える
//   false（段階2）: 以前の置き場所には書かない（段階1を十分に動かしてから切り替える）
//   2026-10-23 に段階2へ切り替えた。段階2のコードは以前の置き場所の古い写しを、読んだときに消す
export const WRITE_LEGACY_LINKED_COPY = false;

```

### A.9 `app/lib/configStore.ts`

```ts
// 設定（chat_configs）の読み書き。/api/config と、全行を定期的に置き換える処理（app/lib/backfill.ts）の両方から使う。
//
// D1 に個人情報を平文で置かない（絶対ルール1）。
// - chat_id（相手の名前・アドレス）は「h1:」＋HMAC、元の chat_id と custom_name（名前変更・グループ・フィルターの語）は
//   まとめて暗号化して保存する（app/lib/configCrypto.ts）
// - user_email・account_email（自分のアドレス）は「a1:」＋HMAC に置き換え、元の account_email は暗号化した中身に持たせる
//   （app/lib/addressKey.ts）。Re:Mail をほかの人も使うので、D1 だけが漏れても利用者の一覧が分からないようにする
// 画面とのやり取りは、これまでどおり元のアドレス・chat_id・custom_name で行う。
// 古いコードに戻しても壊れないよう、段階を分けて入れる（段階は app/lib/addressStage.ts で切り替える）
import { logError, logInfo } from "./safeLog";
import { decryptSecret, encryptSecret, hmacId, isEncrypted } from "./tokenCrypto";
import { stripPinnedBodies } from "./pinnedIds";
import { addressKeyFor, isAddressKey } from "./addressKey";
import { WRITE_HASHED_ADDRESS } from "./addressStage";
import { sanitizeSyncedSettings, sanitizeAccountSettings, newestCommonSettings, syncedSettingsKey, type SyncedSettings, type AccountSettings } from "./syncedSettings";
import { WRITE_LEGACY_LINKED_COPY } from "./configStage";
import { sealConfigName, sealRow, openRow, isReservedRow, isSealedChatId, SEALED_CHAT_ID_PREFIX, type RowCrypto } from "./configCrypto";

type Db = CloudflareEnv["DB"];

const rowCrypto: RowCrypto = { hmac: hmacId, encrypt: encryptSecret, decrypt: decryptSecret };

type Row = {
  user_email: string;
  account_email: string;
  chat_id: string;
  custom_name?: string | null;
  is_pinned?: number | null;
  is_hidden?: number | null;
  hidden_at_date?: string | null;
  unhide_on_new?: number | null;
};

// 画面に返す形（元のアドレス・chat_id・custom_name）
export type OpenedConfig = Omit<Row, "user_email">;
type OpenedRow = OpenedConfig & { source: Row; rank: number };

const UPSERT_SQL = `INSERT INTO chat_configs (user_email, account_email, chat_id, custom_name, is_pinned, is_hidden, hidden_at_date, unhide_on_new)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_email, account_email, chat_id) DO UPDATE SET
       custom_name=excluded.custom_name,
       is_pinned=excluded.is_pinned,
       is_hidden=excluded.is_hidden,
       hidden_at_date=excluded.hidden_at_date,
       unhide_on_new=excluded.unhide_on_new`;

const DELETE_ROW_SQL = "DELETE FROM chat_configs WHERE user_email = ? AND account_email = ? AND chat_id = ?";

// 本人のアドレスの、平文と置き換えた値（移行の途中は両方の行がありうる）
async function userKeys(email: string): Promise<{ plain: string; hashed: string | null }> {
  return { plain: email, hashed: await addressKeyFor(email, hmacId) };
}

// これから保存するときに使う account_email の値（段階1では平文のまま）
async function targetAccountKey(accountEmail: string): Promise<string> {
  if (isReservedRow(accountEmail)) return "";
  if (!WRITE_HASHED_ADDRESS) return accountEmail;
  return (await addressKeyFor(accountEmail, hmacId)) || accountEmail;
}

// 本人の設定をすべて読み、元の形に戻して返す。古い形の行・本体の残っている行は、ここで今の保存の形に置き換える
export async function openAndMigrateConfigs(db: Db, userEmail: string): Promise<OpenedConfig[]> {
  const user = await userKeys(userEmail);
  const targetUser = WRITE_HASHED_ADDRESS && user.hashed ? user.hashed : user.plain;
  const { results } = user.hashed
    ? await db.prepare("SELECT * FROM chat_configs WHERE user_email IN (?, ?)").bind(user.plain, user.hashed).all()
    : await db.prepare("SELECT * FROM chat_configs WHERE user_email = ?").bind(user.plain).all();
  const rows = results as Row[];

  // それぞれの行を元の形に戻す。同じ設定が古い形と新しい形の両方にあれば、新しい形（rank が高い方）を使い、
  // 使わなかった方は「同じ設定の古い行」として後で消す。開けなかった行は消さずにそのまま残す（失わないため）
  const opened = new Map<string, OpenedRow>();
  const duplicates: Row[] = [];
  for (const row of rows) {
    const reserved = isReservedRow(row.account_email);
    let chatId = row.chat_id;
    let customName = row.custom_name ?? null;
    let accountEmail = row.account_email;
    if (!reserved) {
      const o = await openRow(row.chat_id, row.custom_name, rowCrypto);
      if (!o) { logError("config.openRow", {}); continue; }
      chatId = o.chatId;
      customName = o.customName;
      if (isAddressKey(row.account_email)) {
        // アドレスを置き換えた行は、暗号化した中身に元のアドレスを持っている
        if (!o.accountEmail) { logError("config.openRow.noAccount", {}); continue; }
        accountEmail = o.accountEmail;
      }
      // メールの中身を D1 に置かない（絶対ルール1）。以前の形式で残っていた本体は、ここで取り除く
      customName = stripPinnedBodies(customName) ?? null;
    }
    const rank = (isAddressKey(row.user_email) ? 4 : 0) + (isAddressKey(row.account_email) ? 2 : 0) + (isSealedChatId(row.chat_id) ? 1 : 0);
    const key = `${accountEmail}\u0000${chatId}`;
    const prev = opened.get(key);
    if (prev && prev.rank >= rank) { duplicates.push(row); continue; }
    if (prev) duplicates.push(prev.source);
    opened.set(key, {
      account_email: accountEmail, chat_id: chatId, custom_name: customName,
      is_pinned: row.is_pinned, is_hidden: row.is_hidden, hidden_at_date: row.hidden_at_date, unhide_on_new: row.unhide_on_new,
      source: row, rank,
    });
  }

  // 古い形の行・本体の残っている行を、今の保存の形に置き換える（同じバッチで書いて消すので途中で失われない）。
  // 失敗しても読み込みは止めない（次に読んだときにまた試す）
  try {
    const stmts = [];
    let rewritten = 0;
    for (const o of opened.values()) {
      const reserved = isReservedRow(o.account_email);
      const account = await targetAccountKey(o.account_email);
      let chat = o.chat_id;
      let custom = o.custom_name ?? null;
      if (!reserved) {
        const sealed = await sealRow(o.chat_id, o.custom_name, rowCrypto, WRITE_HASHED_ADDRESS ? o.account_email : undefined);
        if (sealed) { chat = sealed.chatId; custom = sealed.customName; }
        else custom = (await sealConfigName(custom, encryptSecret)) ?? null;
      }
      const src = o.source;
      const sameKeys = src.user_email === targetUser && src.account_email === account && src.chat_id === chat;
      // 中身を書き直す必要があるか：本体が残っている、または（段階2で）元のアドレスをまだ中身に持っていない
      let contentStale = false;
      if (!reserved && isSealedChatId(src.chat_id)) {
        const srcOpened = await openRow(src.chat_id, src.custom_name, rowCrypto);
        contentStale = !srcOpened
          || stripPinnedBodies(srcOpened.customName) !== srcOpened.customName
          || (WRITE_HASHED_ADDRESS && !srcOpened.accountEmail);
      } else if (!reserved) {
        contentStale = true; // 平文の chat_id の行は暗号化して置き換える
      }
      if (sameKeys && !contentStale) continue;
      if (!reserved && !isSealedChatId(chat)) continue; // 鍵が無く暗号化できないときは、今の行をそのまま使う
      stmts.push(db.prepare(UPSERT_SQL).bind(targetUser, account, chat, custom, o.is_pinned ?? 0, o.is_hidden ?? 0, o.hidden_at_date ?? null, o.unhide_on_new ?? 0));
      if (!sameKeys) stmts.push(db.prepare(DELETE_ROW_SQL).bind(src.user_email, src.account_email, src.chat_id));
      rewritten++;
    }
    for (const row of duplicates) stmts.push(db.prepare(DELETE_ROW_SQL).bind(row.user_email, row.account_email, row.chat_id));
    if (stmts.length > 0) {
      await db.batch(stmts);
      logInfo("config.migrateRows", { count: rewritten });
    }
  } catch (e) {
    logError("config.migrateRows", { count: rows.length }, e);
  }

  return Array.from(opened.values()).map((o) => ({
    account_email: o.account_email, chat_id: o.chat_id, custom_name: o.custom_name,
    is_pinned: o.is_pinned, is_hidden: o.is_hidden, hidden_at_date: o.hidden_at_date, unhide_on_new: o.unhide_on_new,
  }));
}

export type ConfigInput = {
  chat_id: string;
  account_email: string;
  custom_name: string | null;
  is_pinned?: boolean;
  is_hidden?: boolean;
  hidden_at_date?: string | null;
  unhide_on_new?: boolean;
};

// 1つの設定を保存する。同じ設定の古い形の行（平文のアドレス・平文の chat_id）が残っていれば消す
export async function saveConfig(db: Db, userEmail: string, input: ConfigInput): Promise<void> {
  const user = await userKeys(userEmail);
  const targetUser = WRITE_HASHED_ADDRESS && user.hashed ? user.hashed : user.plain;
  // メールの中身（以前の形式のピン留めの本体）は、送られてきても保存しない（絶対ルール1）
  const customName = stripPinnedBodies(input.custom_name) ?? null;
  const flags = [input.is_pinned ? 1 : 0, input.is_hidden ? 1 : 0, input.hidden_at_date || null, input.unhide_on_new ? 1 : 0] as const;

  const account = await targetAccountKey(input.account_email);
  const sealed = await sealRow(input.chat_id, customName, rowCrypto, WRITE_HASHED_ADDRESS ? input.account_email : undefined);
  const chat = sealed ? sealed.chatId : input.chat_id;
  const custom = sealed ? sealed.customName : ((await sealConfigName(customName, encryptSecret)) || null);
  const userKeysList = [user.plain, user.hashed || user.plain];
  const accountKeys = [input.account_email, (await addressKeyFor(input.account_email, hmacId)) || input.account_email];
  const chatKeys = [input.chat_id, chat];
  await db.batch([
    db.prepare(UPSERT_SQL).bind(targetUser, account, chat, custom, ...flags),
    db.prepare(`DELETE FROM chat_configs WHERE user_email IN (?, ?) AND account_email IN (?, ?) AND chat_id IN (?, ?)
                AND NOT (user_email = ? AND account_email = ? AND chat_id = ?)`)
      .bind(...userKeysList, ...accountKeys, ...chatKeys, targetUser, account, chat),
  ]);
}

// 1つの設定を消す（古い形・新しい形のどれで保存されていても消す）
export async function deleteConfig(db: Db, userEmail: string, chatId: string, accountEmail: string): Promise<void> {
  const user = await userKeys(userEmail);
  const sealedChat = await hmacId(chatId);
  const userKeysList = [user.plain, user.hashed || user.plain];
  const accountKeys = [accountEmail, (await addressKeyFor(accountEmail, hmacId)) || accountEmail];
  const chatKeys = [chatId, sealedChat ? `${SEALED_CHAT_ID_PREFIX}${sealedChat}` : chatId];
  await db.prepare("DELETE FROM chat_configs WHERE user_email IN (?, ?) AND account_email IN (?, ?) AND chat_id IN (?, ?)")
    .bind(...userKeysList, ...accountKeys, ...chatKeys).run();
}

// どの端末でも共通の設定（account_email が空の予約行 __GLOBAL_SETTINGS__ に持つ）。
// 入れてよい設定の名前と型は app/lib/syncedSettings.ts で決め、それ以外は捨てる。
// アカウントのアドレスを含むので、行の中身はまとめて暗号化して保存する（以前の平文の JSON も読める）
export const GLOBAL_SETTINGS_CHAT_ID = "__GLOBAL_SETTINGS__";

// 保存されている中身を設定に戻す。暗号化したもの・以前の平文の JSON のどちらも読む。読めなければ空
export async function openGlobalSettings(customName: string | null | undefined): Promise<SyncedSettings> {
  if (!customName) return {};
  try {
    const json = customName.startsWith("encv1:") ? await decryptSecret(customName) : customName;
    return sanitizeSyncedSettings(JSON.parse(json));
  } catch {
    return {};
  }
}

// 予約行（account_email が空）の中身を読む。今の形の行を優先する
async function readReservedRow(db: Db, userEmail: string, chatId: string): Promise<string | null> {
  const user = await userKeys(userEmail);
  const targetUser = WRITE_HASHED_ADDRESS && user.hashed ? user.hashed : user.plain;
  const { results } = await db.prepare("SELECT user_email, custom_name FROM chat_configs WHERE user_email IN (?, ?) AND account_email = '' AND chat_id = ?")
    .bind(user.plain, user.hashed || user.plain, chatId).all();
  const rows = results as { user_email: string; custom_name: string | null }[];
  return (rows.find(r => r.user_email === targetUser) || rows[0])?.custom_name ?? null;
}

// 予約行を、渡した値そのもので置き換える（暗号化して書く）。古い形（平文のアドレス）の行があれば消す。
// 鍵が無く暗号化できないとき（ローカルの開発環境など）は、アドレスを含む値を平文で D1 に置かないよう外して書き、外した値を返す
async function writeReservedRow(db: Db, userEmail: string, chatId: string, value: Record<string, unknown>): Promise<Record<string, unknown>> {
  const user = await userKeys(userEmail);
  const targetUser = WRITE_HASHED_ADDRESS && user.hashed ? user.hashed : user.plain;
  const out = { ...value };
  let sealed = await encryptSecret(JSON.stringify(out));
  if (!isEncrypted(sealed)) {
    delete out.accounts;
    sealed = JSON.stringify(out);
  }
  await db.batch([
    db.prepare(UPSERT_SQL).bind(targetUser, "", chatId, sealed, 0, 0, null, 0),
    db.prepare("DELETE FROM chat_configs WHERE user_email IN (?, ?) AND account_email = '' AND chat_id = ? AND user_email <> ?")
      .bind(user.plain, user.hashed || user.plain, chatId, targetUser),
  ]);
  return out;
}

// 共通の設定の一部を書き換える。ほかの値は残す。古い形（平文のアドレス）の行があれば今の形に移して消す
export async function saveGlobalSettings(db: Db, userEmail: string, updates: unknown): Promise<SyncedSettings> {
  const merged: SyncedSettings = { ...(await openGlobalSettings(await readReservedRow(db, userEmail, GLOBAL_SETTINGS_CHAT_ID))), ...sanitizeSyncedSettings(updates) };
  return (await writeReservedRow(db, userEmail, GLOBAL_SETTINGS_CHAT_ID, merged)) as SyncedSettings;
}

// ---- アカウントごとの置き場所 ----
// 設定は「そのアカウント自身」の置き場所（user_email = そのアカウント）に保存する。こうすると、連携アカウントで
// 直接ログインしても、連携して使っていたときの設定がそのまま使える（ログインできる＝同じ人とみなす）。
// - アカウント設定・チャットの設定（ピン留め・非表示・名前変更・グループ・そのアカウントだけのフィルター）：そのアカウントの置き場所
// - 共通設定・すべてのアカウントが対象のフィルター（shared）：ログインしている全アカウントの置き場所に同じものを書く
// 以前は連携アカウントの設定もメインアカウントの置き場所に書いていた。その行は読んだときに写し、段階1では両方に書く（configStage.ts）

export const ACCOUNT_SETTINGS_CHAT_ID = "__ACCOUNT_SETTINGS__";

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// custom_name の JSON から、すべてのアカウントが対象か（shared）・最後に保存した時刻・フィルターの対象アカウントを読む
export function configMeta(customName: string | null | undefined): { shared: boolean; updatedAt: number; filterAccount?: string; isFilter?: boolean } {
  if (!customName || !customName.startsWith("{")) return { shared: false, updatedAt: 0 };
  try {
    const p = JSON.parse(customName) as { shared?: unknown; updatedAt?: unknown; filterAction?: unknown; isGroup?: unknown; filterCriteria?: { accountEmail?: unknown } };
    const fa = p.filterCriteria?.accountEmail;
    const meta: { shared: boolean; updatedAt: number; filterAccount?: string; isFilter?: boolean } = { shared: p.shared === true, updatedAt: typeof p.updatedAt === "number" ? p.updatedAt : 0 };
    if (typeof fa === "string" && fa) meta.filterAccount = fa;
    if (!!p.filterAction || (!!p.isGroup && !!p.filterCriteria)) meta.isFilter = true;
    return meta;
  } catch {
    return { shared: false, updatedAt: 0 };
  }
}

// フィルターを、指定したアカウントだけのものにする（すべてのアカウントが対象だったものを、アカウントごとに分けるとき）
export function assignFilterAccount(customName: string | null | undefined, account: string): string | null {
  if (!customName) return customName ?? null;
  try {
    const p = JSON.parse(customName) as Record<string, unknown> & { filterCriteria?: Record<string, unknown> };
    delete p.shared;
    p.filterCriteria = { ...(p.filterCriteria || {}), accountEmail: account };
    return JSON.stringify(p);
  } catch {
    return customName;
  }
}

const toInput = (o: OpenedConfig, accountEmail: string): ConfigInput => ({
  chat_id: o.chat_id, account_email: accountEmail, custom_name: o.custom_name ?? null,
  is_pinned: o.is_pinned === 1, is_hidden: o.is_hidden === 1, hidden_at_date: o.hidden_at_date ?? null, unhide_on_new: o.unhide_on_new === 1,
});
// 2つの写しの中身が同じかを比べるための値
const contentKey = (o: OpenedConfig) => JSON.stringify([o.custom_name ?? null, o.is_pinned ? 1 : 0, o.is_hidden ? 1 : 0, o.hidden_at_date ?? null, o.unhide_on_new ? 1 : 0]);

// ログイン中のアカウント（メイン＋連携）。重複と空を除く
export function sessionAccountList(primary: string, linked: string[]): string[] {
  const out = [primary];
  for (const a of linked) if (a && !out.some(x => sameAddress(x, a))) out.push(a);
  return out;
}

export type SessionConfigs = { configs: OpenedConfig[]; accountSettings: Record<string, AccountSettings> };

// ログイン中の全アカウントの設定を読み、画面に返す形にまとめる。足りない写し・以前の置き場所の行は、ここで書き足す
export async function openSessionConfigs(db: Db, primary: string, linked: string[]): Promise<SessionConfigs> {
  const accounts = sessionAccountList(primary, linked);
  const findAccount = (a: string) => accounts.find(x => sameAddress(x, a));
  const spaces = new Map<string, OpenedConfig[]>();
  for (const a of accounts) spaces.set(a, await openAndMigrateConfigs(db, a));

  const result = new Map<string, OpenedConfig>();
  const writes: { owner: string; input: ConfigInput }[] = [];
  const deletes: { owner: string; chatId: string; accountEmail: string }[] = [];
  const key = (account: string, chat: string) => `${account.toLowerCase()}\u0000${chat}`;

  // 1. 自分の置き場所にある、自分のチャットの設定
  for (const [owner, rows] of spaces) {
    for (const o of rows) {
      if (isReservedRow(o.account_email) || !sameAddress(o.account_email, owner)) continue;
      const meta = configMeta(o.custom_name);
      if (meta.shared || (meta.isFilter && !meta.filterAccount && accounts.length > 1)) continue;
      // 以前はほかのアカウントだけが対象のフィルターも、メインアカウント名義で保存していた。対象のアカウントへ移す
      const target = meta.filterAccount ? findAccount(meta.filterAccount) : undefined;
      if (target && !sameAddress(target, owner)) {
        if (!result.has(key(target, o.chat_id))) {
          result.set(key(target, o.chat_id), { ...o, account_email: target });
          writes.push({ owner: target, input: toInput(o, target) });
        }
        deletes.push({ owner, chatId: o.chat_id, accountEmail: owner });
        continue;
      }
      result.set(key(owner, o.chat_id), { ...o, account_email: owner });
    }
  }
  // 2. 以前の置き場所（ほかのアカウントの置き場所）にある、このアカウントのチャットの設定。自分の置き場所に無いものだけ使い、写す。
  //    段階2（configStage.ts）では、写し終えた（または自分の置き場所にすでにある）以前の行は消す（D1 に同じ設定を2つ置かない）。
  //    消すのは書き足しのあと（同じ try の中で、書き足しが失敗したら消さない）
  for (const [space, rows] of spaces) {
    for (const o of rows) {
      if (isReservedRow(o.account_email) || sameAddress(o.account_email, space) || configMeta(o.custom_name).shared) continue;
      const owner = findAccount(o.account_email);
      if (!owner) {
        // 連携を解除したアカウントなどの行は、これまでどおりメインアカウントの置き場所の分だけ返す
        if (space === primary && !result.has(key(o.account_email, o.chat_id))) result.set(key(o.account_email, o.chat_id), o);
        continue;
      }
      if (!WRITE_LEGACY_LINKED_COPY) deletes.push({ owner: space, chatId: o.chat_id, accountEmail: o.account_email });
      if (result.has(key(owner, o.chat_id))) continue;
      result.set(key(owner, o.chat_id), { ...o, account_email: owner });
      writes.push({ owner, input: toInput(o, owner) });
    }
  }
  // 3. すべてのアカウントが対象のフィルター（shared と、アカウントを決めていない以前のフィルター）は、
  //    アカウントごとの別々のフィルターに分ける（フィルターはアカウントごとに保存し、そのアカウントのメールにだけ効く）。
  //    一番新しい写しをもとに、各アカウントの置き場所にそのアカウントだけのフィルターとして書き直す
  if (accounts.length > 1) {
    const best = new Map<string, { o: OpenedConfig; at: number; preferred: boolean }>();
    for (const [space, rows] of spaces) {
      for (const o of rows) {
        if (isReservedRow(o.account_email)) continue;
        const meta = configMeta(o.custom_name);
        const toSplit = meta.shared || (meta.isFilter && !meta.filterAccount && sameAddress(o.account_email, space));
        if (!toSplit) continue;
        const cur = best.get(o.chat_id);
        const preferred = space === primary;
        if (!cur || meta.updatedAt > cur.at || (meta.updatedAt === cur.at && preferred && !cur.preferred)) best.set(o.chat_id, { o, at: meta.updatedAt, preferred });
      }
    }
    for (const [chat, { o }] of best) {
      for (const a of accounts) {
        // 分けたあとにそのアカウントで編集した（アカウントの決まった）フィルターがあれば、そちらを使う
        if (result.has(key(a, chat))) continue;
        const own: OpenedConfig = { ...o, account_email: a, custom_name: assignFilterAccount(o.custom_name, a) };
        result.set(key(a, chat), own);
        writes.push({ owner: a, input: toInput(own, a) });
      }
    }
  } else {
    // 1つのアカウントだけでログインしているときは、そのアカウントのフィルターとしてそのまま返す
    for (const o of spaces.get(primary) || []) {
      if (isReservedRow(o.account_email) || !configMeta(o.custom_name).shared) continue;
      result.set(key(primary, o.chat_id), { ...o, account_email: primary });
    }
  }

  // 4. 共通設定：一番新しい写しを使い、違う写し・無い写しを書き直す（あとから足したアカウントにも写す）
  const reservedOf = (a: string, chatId: string) => spaces.get(a)?.find(o => isReservedRow(o.account_email) && o.chat_id === chatId);
  const globalCopies = await Promise.all(accounts.map(async (a) => ({ a, settings: await openGlobalSettings(reservedOf(a, GLOBAL_SETTINGS_CHAT_ID)?.custom_name) })));
  const common = newestCommonSettings(globalCopies.map(c => ({ settings: c.settings, preferred: c.a === primary })));
  const commonKey = syncedSettingsKey(common);
  const globalWrites = Object.keys(common).length > 0 ? globalCopies.filter(c => syncedSettingsKey(c.settings) !== commonKey).map(c => c.a) : [];

  // 5. アカウント設定：無ければ、以前の共通設定にあった値を初期値にする（書くのは変えたときだけ）
  const accountSettings: Record<string, AccountSettings> = {};
  for (const { a, settings } of globalCopies) {
    const raw = reservedOf(a, ACCOUNT_SETTINGS_CHAT_ID)?.custom_name;
    if (raw) { accountSettings[a] = await openAccountSettings(raw); continue; }
    const legacy = settings.alwaysLoadImages ?? common.alwaysLoadImages;
    accountSettings[a] = legacy === undefined ? {} : { alwaysLoadImages: legacy };
  }

  // 書き足しは失敗しても読み込みは止めない（次に読んだときにまた試す）
  try {
    for (const w of writes) await saveSessionConfig(db, primary, linked, w.input, undefined, w.owner);
    for (const d of deletes) await deleteConfig(db, d.owner, d.chatId, d.accountEmail);
    for (const a of globalWrites) await writeReservedRow(db, a, GLOBAL_SETTINGS_CHAT_ID, common);
    const n = writes.length + deletes.length + globalWrites.length;
    if (n > 0) logInfo("config.syncSpaces", { count: n });
  } catch (e) {
    logError("config.syncSpaces", {}, e);
  }

  // 共通設定は1行にまとめて返す（中身は復号した JSON）。そのほかの予約行はメインアカウントの分だけ
  const reserved: OpenedConfig[] = (spaces.get(primary) || []).filter(o => isReservedRow(o.account_email) && o.chat_id !== GLOBAL_SETTINGS_CHAT_ID && o.chat_id !== ACCOUNT_SETTINGS_CHAT_ID);
  if (accounts.some(a => reservedOf(a, GLOBAL_SETTINGS_CHAT_ID))) reserved.push({ account_email: "", chat_id: GLOBAL_SETTINGS_CHAT_ID, custom_name: JSON.stringify(common) });
  return { configs: [...reserved, ...result.values()], accountSettings };
}

// 1つの設定を、ログイン中のアカウントの置き場所に保存する。
// scope が "shared" なら全アカウントに、そうでなければそのチャットのアカウント（account_email）の置き場所に書く。
// ownerOverride は読むときの書き足し用（その置き場所にだけ書く）
export async function saveSessionConfig(db: Db, primary: string, linked: string[], input: ConfigInput, scope?: "shared", ownerOverride?: string): Promise<void> {
  const accounts = sessionAccountList(primary, linked);
  const legacyCopy = (owner: string) => WRITE_LEGACY_LINKED_COPY && !sameAddress(owner, primary) && !configMeta(input.custom_name).shared;
  if (ownerOverride) {
    await saveConfig(db, ownerOverride, { ...input, account_email: ownerOverride });
    if (legacyCopy(ownerOverride)) await saveConfig(db, primary, { ...input, account_email: ownerOverride });
    return;
  }
  if (scope === "shared") {
    for (const a of accounts) await saveConfig(db, a, { ...input, account_email: a });
    return;
  }
  const owner = accounts.find(a => sameAddress(a, input.account_email));
  // ログイン中のアカウントでなければ（連携を解除したアカウントなど）、これまでどおりメインアカウントの置き場所に書く
  if (!owner) { await saveConfig(db, primary, input); return; }
  await saveConfig(db, owner, { ...input, account_email: owner });
  // 段階1：古いコードに戻しても見えるよう、以前の置き場所にも書く
  if (legacyCopy(owner)) await saveConfig(db, primary, { ...input, account_email: owner });
}

// 1つの設定を消す。shared なら全アカウントの写しを、そうでなければそのアカウントの置き場所と以前の置き場所の行を消す
export async function deleteSessionConfig(db: Db, primary: string, linked: string[], chatId: string, accountEmail: string, scope?: "shared"): Promise<void> {
  const accounts = sessionAccountList(primary, linked);
  if (scope === "shared") {
    for (const a of accounts) await deleteConfig(db, a, chatId, a);
    await deleteConfig(db, primary, chatId, accountEmail);
    return;
  }
  const owner = accounts.find(a => sameAddress(a, accountEmail));
  if (owner && !sameAddress(owner, primary)) await deleteConfig(db, owner, chatId, owner);
  await deleteConfig(db, primary, chatId, accountEmail);
}

// 共通設定を書き換え、ログイン中の全アカウントに同じものを書く（一番新しい写しに、変えた値を重ねる）
export async function saveCommonSettings(db: Db, primary: string, linked: string[], updates: unknown, now = Date.now()): Promise<SyncedSettings> {
  const accounts = sessionAccountList(primary, linked);
  const current = await Promise.all(accounts.map(async (a) => ({ settings: await openGlobalSettings(await readReservedRow(db, a, GLOBAL_SETTINGS_CHAT_ID)), preferred: a === primary })));
  const merged: SyncedSettings = { ...newestCommonSettings(current), ...sanitizeSyncedSettings(updates), updatedAt: now };
  let out: SyncedSettings = merged;
  for (const a of accounts) out = (await writeReservedRow(db, a, GLOBAL_SETTINGS_CHAT_ID, merged)) as SyncedSettings;
  return out;
}

export async function openAccountSettings(customName: string | null | undefined): Promise<AccountSettings> {
  if (!customName) return {};
  try {
    const json = customName.startsWith("encv1:") ? await decryptSecret(customName) : customName;
    return sanitizeAccountSettings(JSON.parse(json));
  } catch {
    return {};
  }
}

// アカウント設定の一部を書き換える（そのアカウントの置き場所に書く）
export async function saveAccountSettings(db: Db, accountEmail: string, updates: unknown): Promise<AccountSettings> {
  const merged: AccountSettings = { ...(await openAccountSettings(await readReservedRow(db, accountEmail, ACCOUNT_SETTINGS_CHAT_ID))), ...sanitizeAccountSettings(updates) };
  return (await writeReservedRow(db, accountEmail, ACCOUNT_SETTINGS_CHAT_ID, merged)) as AccountSettings;
}

```

### A.10 `app/lib/linkedAccountsStore.ts`

```ts
// 連携アカウント（linked_accounts）の読み書き。自分のアドレス（user_email・account_email）は「a1:」＋HMAC に置き換え、
// 元の連携アカウントのアドレス・表示名・プロフィール画像の URL は暗号化して保存する（絶対ルール1）。
// 移行の途中は平文の行と置き換えた行が混ざるので、読むときは両方を探す（app/lib/addressStage.ts）
import { addressKeyFor, isAddressKey, normalizeAddress } from "./addressKey";
import { WRITE_HASHED_ADDRESS } from "./addressStage";
import { decryptSecret, encryptSecret, hmacId, isEncrypted } from "./tokenCrypto";
import { logError, logInfo } from "./safeLog";

type Db = CloudflareEnv["DB"];

export type LinkedAccountRow = {
  user_email: string;
  account_email: string;
  account_enc?: string | null;
  refresh_token: string;
  access_token: string | null;
  expires_at: number | null;
  created_at?: string | null;
  needs_reauth: number | null;
  name?: string | null;
  picture?: string | null;
};

const INSERT_SQL = `INSERT INTO linked_accounts (user_email, account_email, account_enc, refresh_token, access_token, expires_at, created_at, needs_reauth, name, picture)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_email, account_email) DO UPDATE SET
       account_enc=excluded.account_enc, refresh_token=excluded.refresh_token, access_token=excluded.access_token,
       expires_at=excluded.expires_at, needs_reauth=excluded.needs_reauth, name=excluded.name, picture=excluded.picture`;

async function keysOf(email: string): Promise<[string, string]> {
  return [email, (await addressKeyFor(email, hmacId)) || email];
}

// 保存に使うキー（段階1では平文のまま）
async function targetKeys(userEmail: string, accountEmail: string): Promise<{ user: string; account: string }> {
  if (!WRITE_HASHED_ADDRESS) return { user: userEmail, account: accountEmail };
  return {
    user: (await addressKeyFor(userEmail, hmacId)) || userEmail,
    account: (await addressKeyFor(accountEmail, hmacId)) || accountEmail,
  };
}

// 新しい形の行ほど優先する（同じ連携アカウントが古い形と新しい形の両方にあるとき）
function rankOf(row: LinkedAccountRow): number {
  return (isAddressKey(row.user_email) ? 2 : 0) + (isAddressKey(row.account_email) ? 1 : 0);
}

// 1つの連携アカウントの行（トークンを取り出すため）。見つかった行のキーもそのまま返すので、更新はその行に対して行う
export async function findLinkedAccount(db: Db, userEmail: string, accountEmail: string): Promise<LinkedAccountRow | null> {
  const [u1, u2] = await keysOf(userEmail);
  const [a1, a2] = await keysOf(accountEmail);
  const { results } = await db.prepare(
    "SELECT * FROM linked_accounts WHERE user_email IN (?, ?) AND account_email IN (?, ?)"
  ).bind(u1, u2, a1, a2).all();
  const rows = (results || []) as LinkedAccountRow[];
  return rows.sort((x, y) => rankOf(y) - rankOf(x))[0] || null;
}

// 本人の連携アカウントの一覧（画面に出すため、アドレス・表示名・画像 URL は元に戻して返す）。
// 段階2では、古い形の行をここで新しい形に置き換える
export async function listLinkedAccounts(db: Db, userEmail: string): Promise<{ account_email: string; needs_reauth: number | null; name: string | null; picture: string | null }[]> {
  const [u1, u2] = await keysOf(userEmail);
  const { results } = await db.prepare("SELECT * FROM linked_accounts WHERE user_email IN (?, ?)").bind(u1, u2).all();
  const rows = (results || []) as LinkedAccountRow[];

  const byAccount = new Map<string, { row: LinkedAccountRow; accountEmail: string; name: string | null; picture: string | null }>();
  const duplicates: LinkedAccountRow[] = [];
  for (const row of rows) {
    let accountEmail = row.account_email;
    let name: string | null = null;
    let picture: string | null = null;
    try {
      if (isAddressKey(row.account_email)) {
        if (!row.account_enc) { logError("accounts.openRow.noAccount", {}); continue; }
        accountEmail = await decryptSecret(row.account_enc);
      }
      name = row.name ? await decryptSecret(row.name) : null;
      picture = row.picture ? await decryptSecret(row.picture) : null;
    } catch (e) {
      // 開けない行は消さずに残す（鍵の問題なら、直せばまた読めるため）
      logError("accounts.openRow", {}, e);
      continue;
    }
    const key = normalizeAddress(accountEmail);
    const prev = byAccount.get(key);
    if (prev && rankOf(prev.row) >= rankOf(row)) { duplicates.push(row); continue; }
    if (prev) duplicates.push(prev.row);
    byAccount.set(key, { row, accountEmail, name, picture });
  }

  if (WRITE_HASHED_ADDRESS) {
    try {
      const stmts = [];
      for (const { row, accountEmail, name, picture } of byAccount.values()) {
        const t = await targetKeys(userEmail, accountEmail);
        const done = row.user_email === t.user && row.account_email === t.account && !!row.account_enc
          && (!row.name || row.name.startsWith("encv1:")) && (!row.picture || row.picture.startsWith("encv1:"));
        if (done) continue;
        stmts.push(db.prepare(INSERT_SQL).bind(
          t.user, t.account, await encryptSecret(accountEmail), row.refresh_token, row.access_token, row.expires_at, row.created_at ?? null,
          row.needs_reauth ?? 0, name ? await encryptSecret(name) : null, picture ? await encryptSecret(picture) : null,
        ));
        if (row.user_email !== t.user || row.account_email !== t.account) {
          stmts.push(db.prepare("DELETE FROM linked_accounts WHERE user_email = ? AND account_email = ?").bind(row.user_email, row.account_email));
        }
      }
      for (const row of duplicates) stmts.push(db.prepare("DELETE FROM linked_accounts WHERE user_email = ? AND account_email = ?").bind(row.user_email, row.account_email));
      if (stmts.length > 0) {
        await db.batch(stmts);
        logInfo("accounts.migrateRows", { count: stmts.length });
      }
    } catch (e) {
      logError("accounts.migrateRows", {}, e);
    }
  }

  return Array.from(byAccount.values()).map(({ row, accountEmail, name, picture }) => ({ account_email: accountEmail, needs_reauth: row.needs_reauth, name, picture }));
}

// 連携した（し直した）アカウントを保存する。同じアカウントの古い形の行は消す
export async function saveLinkedAccount(db: Db, userEmail: string, accountEmail: string, v: { refreshToken: string; accessToken: string | null; expiresAt: number | null; name: string | null; picture: string | null }): Promise<void> {
  const t = await targetKeys(userEmail, accountEmail);
  const hashed = WRITE_HASHED_ADDRESS;
  const [u1, u2] = await keysOf(userEmail);
  const [a1, a2] = await keysOf(accountEmail);
  await db.batch([
    db.prepare(INSERT_SQL).bind(
      t.user, t.account, hashed ? await encryptSecret(accountEmail) : null,
      await encryptSecret(v.refreshToken), v.accessToken ? await encryptSecret(v.accessToken) : null, v.expiresAt, new Date().toISOString(), 0,
      // 表示名・画像 URL は段階2から暗号化する（段階1より前のコードは、暗号化した値をそのまま画面に出してしまうため）
      v.name ? (hashed ? await encryptSecret(v.name) : v.name) : null,
      v.picture ? (hashed ? await encryptSecret(v.picture) : v.picture) : null,
    ),
    db.prepare("DELETE FROM linked_accounts WHERE user_email IN (?, ?) AND account_email IN (?, ?) AND NOT (user_email = ? AND account_email = ?)")
      .bind(u1, u2, a1, a2, t.user, t.account),
  ]);
}

// 連携を解除する（古い形・新しい形のどちらで保存されていても消す）
export async function deleteLinkedAccount(db: Db, userEmail: string, accountEmail: string): Promise<void> {
  const [u1, u2] = await keysOf(userEmail);
  const [a1, a2] = await keysOf(accountEmail);
  await db.prepare("DELETE FROM linked_accounts WHERE user_email IN (?, ?) AND account_email IN (?, ?)").bind(u1, u2, a1, a2).run();
}

// ログイン中のアカウント（from）だけをログアウトし、残りのアカウントの1つ（to）にログインを引き継ぐ。
// - to のトークン・表示名・画像を返す（ログインのセッションを to のものに置き換えるため）
// - from に付いていたほかのアカウントは、to に付け替える（暗号化した値は持ち主に関係なく同じ鍵で読めるので、そのまま写す）
// - from の行はすべて消す（ログアウトしたアカウントのトークンを残さない）
// to が from に付いていない・再ログインが必要なときは null（何も変えない）
export async function promoteLinkedAccount(db: Db, from: string, to: string): Promise<{ refreshToken: string; accessToken: string | null; expiresAt: number | null; name: string | null; picture: string | null } | null> {
  const target = await findLinkedAccount(db, from, to);
  if (!target || target.needs_reauth) return null;
  const open = async (v: string | null | undefined) => (v ? (isEncrypted(v) ? await decryptSecret(v) : v) : null);
  const refreshToken = await open(target.refresh_token);
  if (!refreshToken) return null;

  const [u1, u2] = await keysOf(from);
  const { results } = await db.prepare("SELECT * FROM linked_accounts WHERE user_email IN (?, ?)").bind(u1, u2).all();
  const rows = (results || []) as LinkedAccountRow[];
  const [t1, t2] = await keysOf(to);
  const stmts = [];
  for (const row of rows) {
    // 引き継ぐアカウント自身の行は写さない（自分自身に自分は付けない）
    if (row.account_email === t1 || row.account_email === t2) continue;
    const accountEmail = isAddressKey(row.account_email) ? (row.account_enc ? await decryptSecret(row.account_enc) : null) : row.account_email;
    if (!accountEmail || normalizeAddress(accountEmail) === normalizeAddress(from)) continue;
    const k = await targetKeys(to, accountEmail);
    stmts.push(db.prepare(INSERT_SQL).bind(
      k.user, k.account, row.account_enc ?? (WRITE_HASHED_ADDRESS ? await encryptSecret(accountEmail) : null), row.refresh_token, row.access_token, row.expires_at,
      row.created_at ?? new Date().toISOString(), row.needs_reauth ?? 0, row.name ?? null, row.picture ?? null,
    ));
  }
  stmts.push(db.prepare("DELETE FROM linked_accounts WHERE user_email IN (?, ?)").bind(u1, u2));
  // 写すのと消すのは同じバッチで行う（途中で失われないように）
  await db.batch(stmts);
  logInfo("accounts.promote", { count: stmts.length - 1 });
  return {
    refreshToken,
    accessToken: await open(target.access_token),
    expiresAt: target.expires_at,
    name: await open(target.name ?? null),
    picture: await open(target.picture ?? null),
  };
}


// 一緒にログインしているアカウントのアドレスだけ（設定の読み書きのたびに使う）。
// listLinkedAccounts と違い、表示名・画像は復号せず、行の書き直しもしない（アドレスの列だけを読む）
export async function listLinkedAccountEmails(db: Db, userEmail: string): Promise<string[]> {
  const [u1, u2] = await keysOf(userEmail);
  const { results } = await db.prepare("SELECT account_email, account_enc FROM linked_accounts WHERE user_email IN (?, ?)").bind(u1, u2).all();
  const out: string[] = [];
  for (const row of (results || []) as { account_email: string; account_enc: string | null }[]) {
    try {
      const email = isAddressKey(row.account_email) ? (row.account_enc ? await decryptSecret(row.account_enc) : "") : row.account_email;
      if (email && !out.some(e => normalizeAddress(e) === normalizeAddress(email))) out.push(email);
    } catch (e) {
      // 開けない行は飛ばす（ほかのアカウントの設定は読めるように）
      logError("accounts.listEmails", {}, e);
    }
  }
  return out;
}

```

### A.11 `app/lib/backfill.ts`

```ts
// D1 の全行を、今の保存の形（アドレスの置き換え・相手名や設定の暗号化・ピン留めの本体の削除）に置き換える。
// 設定は「その人が Re:Mail を開いたとき」に置き換わるので、二度と開かない人の行は平文のまま残ってしまう。
// それを残さないよう、Worker の定期実行（worker.ts の scheduled）から呼ぶ。
// 置き換え方は、開いたときと同じ処理（configStore.ts・linkedAccountsStore.ts）をそのまま使う
import { openAndMigrateConfigs } from "./configStore";
import { listLinkedAccounts } from "./linkedAccountsStore";
import { WRITE_HASHED_ADDRESS } from "./addressStage";
import { logError, logInfo } from "./safeLog";

type Db = CloudflareEnv["DB"];

// まだ置き換えていない（user_email が平文の）利用者を、1回に maxUsers 人まで処理する。
// 開けない行がある人で毎回つまらないよう、順番はばらばらにする
export async function runBackfill(db: Db, maxUsers = 20): Promise<{ configUsers: number; linkedUsers: number }> {
  // 段階2（アドレスも置き換えて保存する）になるまでは何もしない（段階1のコードに戻せる状態を保つため）
  if (!WRITE_HASHED_ADDRESS) return { configUsers: 0, linkedUsers: 0 };
  let configUsers = 0;
  let linkedUsers = 0;
  try {
    const { results } = await db.prepare(
      "SELECT DISTINCT user_email FROM chat_configs WHERE user_email NOT LIKE 'a1:%' ORDER BY random() LIMIT ?"
    ).bind(maxUsers).all();
    for (const { user_email } of results as { user_email: string }[]) {
      try {
        await openAndMigrateConfigs(db, user_email);
        configUsers++;
      } catch (e) {
        // 1人の失敗で、ほかの人の置き換えは止めない
        logError("backfill.configs", {}, e);
      }
    }
  } catch (e) {
    logError("backfill.configs.list", {}, e);
  }
  try {
    const { results } = await db.prepare(
      "SELECT DISTINCT user_email FROM linked_accounts WHERE user_email NOT LIKE 'a1:%' ORDER BY random() LIMIT ?"
    ).bind(maxUsers).all();
    for (const { user_email } of results as { user_email: string }[]) {
      try {
        await listLinkedAccounts(db, user_email);
        linkedUsers++;
      } catch (e) {
        logError("backfill.linked", {}, e);
      }
    }
  } catch (e) {
    logError("backfill.linked.list", {}, e);
  }
  if (configUsers || linkedUsers) logInfo("backfill", { count: configUsers + linkedUsers });
  return { configUsers, linkedUsers };
}

```

### A.12 `app/lib/pinnedIds.ts`

```ts
// ピン留めの保存データ（D1 の custom_name に入る JSON）の読み書きを助ける純粋関数。
// D1 にはメールの中身を置かず、Gmail のメッセージ ID だけを保存する（絶対ルール1）。
// 以前の形式（data にメール本体を丸ごと入れていた）も読めるようにしておく（ロールバックしても壊れないように）
import type { Email } from "../types/email";

// 1つのピン留めチャットで覚えておく ID の上限（以前の「直近60件」と同じ）
export const MAX_PINNED_IDS_PER_CHAT = 60;

const GMAIL_ID_RE = /^[0-9a-f]{6,32}$/i;
export const isGmailId = (v: unknown): v is string => typeof v === "string" && GMAIL_ID_RE.test(v);

// 保存データの JSON から、ピン留めしたメールの ID と、古い形式で入っていたメール本体を取り出す
export function readPinnedField(parsed: { ids?: unknown; data?: unknown }): { ids: string[]; legacyEmails: Email[] } {
  const legacyEmails: Email[] = [];
  if (parsed.data) {
    const list = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
    for (const e of list) {
      if (e && typeof e === "object" && isGmailId((e as Email).id)) legacyEmails.push(e as Email);
    }
  }
  const ids = Array.isArray(parsed.ids) ? parsed.ids.filter(isGmailId) : legacyEmails.map(e => e.id);
  return { ids: capPinnedIds(ids), legacyEmails };
}

// 重複を除き、上限までにする（先頭ほど新しいメールという並びを保つ）
export function capPinnedIds(ids: string[]): string[] {
  return Array.from(new Set(ids.filter(isGmailId))).slice(0, MAX_PINNED_IDS_PER_CHAT);
}

// ピン留めチャットの ID 一覧を作り直す。今読み込めているそのチャットのメール（新しい順）を先に、
// まだ読み込めていない以前の ID を後ろに並べる。読み込み前の ID を落とすと、
// 古いメールのピン留めが消えてしまうため残す（ゴミ箱・迷惑メールに移ったものと、存在しないものは除く）
export function mergePinnedIds(loadedIdsNewestFirst: string[], previousIds: string[], dropIds: Set<string>): string[] {
  const loaded = new Set(loadedIdsNewestFirst);
  const rest = previousIds.filter(id => !loaded.has(id) && !dropIds.has(id));
  return capPinnedIds([...loadedIdsNewestFirst.filter(id => !dropIds.has(id)), ...rest]);
}

// Gmail 側で削除されて取得できなかったピン留めメールの代わりに表示するもの
export function missingPinnedEmail(id: string, roomLocalKey: string | undefined, accountId: string): Email {
  return {
    id,
    threadId: "",
    subject: "(このメールは存在しません)",
    from: "",
    to: "",
    date: new Date(0).toUTCString(),
    body: "このメールは存在しません",
    snippet: "",
    labelIds: [],
    senderRoom: roomLocalKey,
    accountId,
    isMissing: true,
  };
}

// 設定（custom_name の JSON）に以前の形式で残っているメール本体（data）を取り除く（ピン留めの段階2）。
// チャット単位のピン留め（roomId を持たない）でまだ ids が無ければ、data のメール ID から ids を作ってから消す。
// メッセージ単位のピン留めは chat_id がメッセージ ID そのものなので、data を消すだけでよい。
// 変える必要が無ければ、受け取った値をそのまま返す（呼び出し側は「変わったか」で書き戻すかを決める）
export function stripPinnedBodies(customName: string | null | undefined): string | null | undefined {
  if (!customName || !customName.startsWith("{")) return customName;
  let obj: Record<string, unknown>;
  try {
    const v = JSON.parse(customName);
    if (!v || typeof v !== "object" || Array.isArray(v)) return customName;
    obj = v as Record<string, unknown>;
  } catch {
    return customName;
  }
  if (!("data" in obj)) return customName;
  const { data, ...rest } = obj;
  const isMessageLevel = "roomId" in rest || "roomIdEnc" in rest;
  if (!isMessageLevel && !Array.isArray(rest.ids)) {
    const ids = readPinnedField({ data }).legacyEmails.map((e) => e.id).filter(isGmailId);
    if (ids.length > 0) rest.ids = capPinnedIds(ids);
  }
  return JSON.stringify(rest);
}

```

### A.13 `app/lib/syncedSettings.ts`

```ts
// 設定は2種類ある。どちらもどの端末でも共通で、D1 に暗号化して保存する。
// - 共通設定（SYNCED_SETTING_TYPES）：どのアカウントでログインしても同じ。ログインしている全アカウントの
//   __GLOBAL_SETTINGS__ に同じものを書き、読むときは一番新しいもの（updatedAt）を使う。あとから足したアカウントにも写す
// - アカウント設定（ACCOUNT_SETTING_TYPES）：アカウントごと。そのアカウントの __ACCOUNT_SETTINGS__ に書く
// 新しい設定を足すときは、どちらかの一覧に名前と型を足す（一覧に無い名前の値は保存されずに捨てられる）。
// 画面の状態（開いているタブ・スクロール位置・開いているチャット）と下書きは設定ではないので、ここに入れず端末に置く
export const SYNCED_SETTING_TYPES = {
  // 場所のチェックボックス（受信箱〜ゴミ箱）
  inbox: "boolean",
  archive: "boolean",
  spam: "boolean",
  trash: "boolean",
  sent: "boolean",
  // 送信ボタン・アクションバー・場所の表示を、文字にするかアイコンにするか
  iconLabels: "boolean",
  // 以前は共通設定だった「メールの外部の画像」。今はアカウント設定に移したので画面からは書かない。
  // 古い行から各アカウントの初期値を作るのと、古いコードに戻したときに読めるよう、名前だけ残す
  alwaysLoadImages: "boolean",
  // アカウントごとの表示チェックボックス（キーはアカウントのアドレス。行ごと暗号化するので D1 に平文では残らない）
  accounts: "accountMap",
  // 最後に保存した時刻（ミリ秒）。アカウントごとの写しのうち、どれが一番新しいかを決めるのに使う
  updatedAt: "number",
} as const;

// 画面が持って保存する共通設定の名前（updatedAt と、移した alwaysLoadImages は含めない）
export const COMMON_SETTING_KEYS = ["inbox", "archive", "spam", "trash", "sent", "iconLabels", "accounts"] as const;

// アカウント設定の一覧（アカウントごとに保存する）
export const ACCOUNT_SETTING_TYPES = {
  // メールの外部の画像を、押さずに毎回読み込むか
  alwaysLoadImages: "boolean",
  // チャットを開いたら、そのチャットに表示されているメールを既読にするか（既定はオフ）
  autoReadOnOpenChat: "boolean",
  // メールを開いたら（詳細を表示したら）、そのメールを既読にするか（既定はオフ）
  autoReadOnOpenMail: "boolean",
} as const;
export type AccountSettings = { -readonly [K in keyof typeof ACCOUNT_SETTING_TYPES]?: boolean };

type SettingType = (typeof SYNCED_SETTING_TYPES)[keyof typeof SYNCED_SETTING_TYPES];
type ValueOf<T extends SettingType> = T extends "boolean" ? boolean : T extends "accountMap" ? Record<string, boolean> : T extends "number" ? number : never;
export type SyncedSettings = { -readonly [K in keyof typeof SYNCED_SETTING_TYPES]?: ValueOf<(typeof SYNCED_SETTING_TYPES)[K]> };

// アカウントの表示チェックボックスに入れてよい件数とアドレスの長さの上限（壊れた・巨大な値を保存しない）
const MAX_ACCOUNTS = 50;
const MAX_ADDRESS_LENGTH = 320;
const ADDRESS_RE = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

// 決まった名前・型の値だけを残す（それ以外は捨てる）
export function sanitizeSyncedSettings(value: unknown): SyncedSettings {
  const out: Record<string, unknown> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, type] of Object.entries(SYNCED_SETTING_TYPES)) {
    const v = (value as Record<string, unknown>)[key];
    if (type === "boolean" && typeof v === "boolean") out[key] = v;
    if (type === "number" && typeof v === "number" && Number.isFinite(v) && v >= 0) out[key] = v;
    if (type === "accountMap" && v && typeof v === "object" && !Array.isArray(v)) {
      const map: Record<string, boolean> = {};
      for (const [addr, on] of Object.entries(v as Record<string, unknown>).slice(0, MAX_ACCOUNTS)) {
        if (typeof on === "boolean" && addr.length <= MAX_ADDRESS_LENGTH && ADDRESS_RE.test(addr)) map[addr] = on;
      }
      out[key] = map;
    }
  }
  return out as SyncedSettings;
}

// 2つの設定が同じかを比べるための文字列（名前の順番に左右されない）
export function syncedSettingsKey(s: SyncedSettings): string {
  const norm = (v: unknown): unknown => v && typeof v === "object" && !Array.isArray(v)
    ? Object.keys(v as Record<string, unknown>).sort().map(k => [k, norm((v as Record<string, unknown>)[k])])
    : v;
  return JSON.stringify(norm(s));
}

// 共通設定のうち、画面が持つ名前だけを取り出す（保存済みかどうかを比べるときに、updatedAt などで食い違わないように）
export function pickCommonSettings(s: SyncedSettings): SyncedSettings {
  const out: Record<string, unknown> = {};
  for (const k of COMMON_SETTING_KEYS) if (s[k] !== undefined) out[k] = s[k];
  return out as SyncedSettings;
}

// アカウント設定の、決まった名前・型の値だけを残す
export function sanitizeAccountSettings(value: unknown): AccountSettings {
  const out: AccountSettings = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const key of Object.keys(ACCOUNT_SETTING_TYPES) as (keyof typeof ACCOUNT_SETTING_TYPES)[]) {
    const v = (value as Record<string, unknown>)[key];
    if (typeof v === "boolean") out[key] = v;
  }
  return out;
}

// アカウントごとの写しのうち一番新しい共通設定を選ぶ（updatedAt が無い古い行は 0 とみなし、同じならログイン中のアカウントの分）
export function newestCommonSettings(copies: { settings: SyncedSettings; preferred: boolean }[]): SyncedSettings {
  let best: { settings: SyncedSettings; at: number; preferred: boolean } | null = null;
  for (const c of copies) {
    const at = c.settings.updatedAt ?? 0;
    if (!best || at > best.at || (at === best.at && c.preferred && !best.preferred)) best = { settings: c.settings, at, preferred: c.preferred };
  }
  return best ? best.settings : {};
}

```

### A.14 `app/lib/googleScopes.ts`

```ts
// Google に求める権限（OAuth スコープ）。最初のログイン（auth.ts）と、別のアカウントでもログインするとき
// （app/api/accounts/connect/route.ts）で同じものを使う。どのアカウントも同じ扱いにするため、ここ以外で書かない。
// 権限を増やすときは、理由を添えてユーザーに確認する（CLAUDE.md 絶対ルール1）
// - openid / email：どのアカウントかを確かめる
// - profile：名前とプロフィール画像（画面に出すだけ。認証や照合には使わない）
// - gmail.modify：メールの読み取り・送信・ラベルの付け外し（完全削除はできない）
export const GOOGLE_OAUTH_SCOPE = "openid email profile https://www.googleapis.com/auth/gmail.modify";

```

### A.15 `app/lib/googleToken.ts`

```ts
// Googleのアクセストークン取得・リフレッシュを一元化する。メインアカウント（auth.tsのjwtコールバック）と
// 追加連携アカウント（フェーズ4のメール取得）の両方がこの関数を通ることで、リフレッシュロジックの
// 二重管理を避ける。
//
// 同一アカウントに対して同時に複数リクエストが来ても、リフレッシュ処理は1回だけ実行されるよう
// メモリ上でPromiseを共有する（Workers はリクエストごとにインスタンスが分離される場合があるため、
// これは「同一インスタンス内での同時実行」を防ぐ簡易的な対策に留まる。より厳密な排他制御が必要になった
// 場合は、D1に一時的な「リフレッシュ中フラグ」を持たせる方式に拡張できる）
type TokenResult = { accessToken: string; expiresAt: number; refreshToken?: string };

// Google の OAuth トークンエンドポイントのレスポンス（失敗時は error / error_description が入る）
export type GoogleTokenResponse = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  error?: string;
  error_description?: string;
};

const inFlightRefreshes = new Map<string, Promise<TokenResult>>();

export async function getValidAccessToken(
  accountEmail: string,
  currentAccessToken: string | null,
  expiresAt: number | null,
  refreshToken: string,
): Promise<TokenResult> {
  if (currentAccessToken && expiresAt && Date.now() < expiresAt - 60_000) {
    return { accessToken: currentAccessToken, expiresAt };
  }

  const existing = inFlightRefreshes.get(accountEmail);
  if (existing) return existing;

  const refreshPromise = (async () => {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });
    const tokens = (await res.json()) as GoogleTokenResponse;
    if (!res.ok) throw tokens;
    // Googleは新しいリフレッシュトークンを返す場合があり、その場合は呼び出し側で保存し直す必要がある
    // （ローテーション後に古いリフレッシュトークンを使い続けるとinvalid_grantで失効するため）
    return {
      accessToken: tokens.access_token as string,
      expiresAt: Date.now() + (tokens.expires_in ?? 0) * 1000,
      refreshToken: tokens.refresh_token as string | undefined,
    };
  })();

  inFlightRefreshes.set(accountEmail, refreshPromise);
  try {
    return await refreshPromise;
  } finally {
    inFlightRefreshes.delete(accountEmail);
  }
}

```

### A.16 `app/lib/safeLog.ts`

```ts
// 個人情報を出さないログ。console.* を直接使わず、必ずここを通す（eslint の no-console で強制している）。
// 本番で出すのは「処理名・HTTP ステータス・Gmail のエラー理由コード・メッセージ／スレッド ID・件数・所要時間」だけ。
// メールアドレス・名前・件名・本文・トークン・生の応答は、形を確かめて通らないものはすべて捨てる。
// 開発環境（npm run dev）でだけ、原因を追いやすいようエラーの中身もそのまま出す。

export type LogFields = {
  status?: number;
  reason?: string; // Gmail / OAuth のエラー理由コード（例: rateLimitExceeded, invalid_grant）
  messageId?: string; // Gmail のメッセージ ID（意味を持たない16進の文字列）
  threadId?: string;
  count?: number;
  durationMs?: number;
};

export type SafeLogRecord = { level: "error" | "warn" | "info"; op: string } & LogFields & { errorName?: string };

const OP_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const GMAIL_ID_RE = /^[0-9a-f]{6,32}$/i;
const REASON_RE = /^[A-Za-z_]{1,64}$/;
const ERROR_NAME_RE = /^[A-Za-z]{1,40}$/;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

// エラーの中から、出してよいもの（エラーの種類名と理由コード）だけを取り出す。
// message は URL の検索語やアドレスを含みうるので出さない
function pickFromError(detail: unknown): { errorName?: string; reason?: string } {
  if (!detail || typeof detail !== "object") return {};
  const out: { errorName?: string; reason?: string } = {};
  const name = (detail as { name?: unknown }).name;
  if (typeof name === "string" && ERROR_NAME_RE.test(name)) out.errorName = name;
  // OAuth のエラー応答（{ error: "invalid_grant" }）と Gmail のエラー応答（{ error: { errors: [{ reason }] } }）
  const err = (detail as { error?: unknown }).error;
  if (typeof err === "string" && REASON_RE.test(err)) out.reason = err;
  const gmailReason = (err as { errors?: { reason?: unknown }[] } | undefined)?.errors?.[0]?.reason;
  if (typeof gmailReason === "string" && REASON_RE.test(gmailReason)) out.reason = gmailReason;
  return out;
}

// 出力する1行分を組み立てる（テストできるよう、出力とは分けておく）
export function buildLogRecord(level: SafeLogRecord["level"], op: string, fields: LogFields = {}, detail?: unknown): SafeLogRecord {
  const record: SafeLogRecord = { level, op: OP_RE.test(op) ? op : "invalid-op" };
  if (isNum(fields.status)) record.status = fields.status;
  if (isNum(fields.count)) record.count = fields.count;
  if (isNum(fields.durationMs)) record.durationMs = Math.round(fields.durationMs);
  if (typeof fields.messageId === "string" && GMAIL_ID_RE.test(fields.messageId)) record.messageId = fields.messageId;
  if (typeof fields.threadId === "string" && GMAIL_ID_RE.test(fields.threadId)) record.threadId = fields.threadId;
  const picked = pickFromError(detail);
  const reason = typeof fields.reason === "string" && REASON_RE.test(fields.reason) ? fields.reason : picked.reason;
  if (reason) record.reason = reason;
  if (picked.errorName) record.errorName = picked.errorName;
  return record;
}

const isDev = process.env.NODE_ENV === "development";

function write(level: SafeLogRecord["level"], op: string, fields?: LogFields, detail?: unknown) {
  const line = JSON.stringify(buildLogRecord(level, op, fields, detail));
  const out = level === "error" ? console.error : level === "warn" ? console.warn : console.info;
  if (isDev && detail !== undefined) out(line, detail);
  else out(line);
}

export const logError = (op: string, fields?: LogFields, detail?: unknown) => write("error", op, fields, detail);
export const logWarn = (op: string, fields?: LogFields, detail?: unknown) => write("warn", op, fields, detail);
export const logInfo = (op: string, fields?: LogFields) => write("info", op, fields);

```

### A.17 `app/lib/securityHeaders.ts`

```ts
// ページ全体に付けるセキュリティヘッダー。CSP は worker.ts が、それ以外は next.config.ts が付ける。
// CSP を next.config.ts の headers() に入れてはいけない。OpenNext は headers() の値をリクエストのヘッダーにも上書きで入れるため、
// worker.ts が渡した nonce 付きの CSP が nonce の無い CSP に置き換わり、Next.js がスクリプトに nonce を付けなくなる（画面が動かなくなる）。
// - スクリプトは自分のサイトのものと、そのページを返すたびに作る nonce を付けたものだけ。
//   'unsafe-inline' は使わない（入り込んだスクリプトがあっても、nonce を知らないので動かせない）。
//   Next.js はリクエストの Content-Security-Policy ヘッダーから nonce を読み、自分が埋め込む起動用のスクリプトに付ける。
//   その nonce は worker.ts が毎回作って渡す（下の withNonceRequest / withNonceResponse）。
//   外部のスクリプト・解析ツールは読み込ませない（絶対ルール1：外部への通信を増やさない）
// - CSS は 'unsafe-inline' を残す。React の style 属性とメール本文の style が使うため（style-src に nonce を入れると
//   'unsafe-inline' が無視されて画面が崩れるので、nonce は script-src にだけ入れる）。CSS ではスクリプトは動かない
// - 画像・CSS・フォントは https を許す。メール本文の iframe（srcdoc）はこのページの CSP も受け継ぐため、
//   「画像を表示」を押したときにメールの画像を出せるようにする。押す前は、iframe の中の CSP（app/lib/emailHtml.ts）が止める
// - Google のプロフィール画像（googleusercontent.com）も https なので、ここに含まれる
// - 添付のプレビュー（PDF・音声・動画）は data: / blob: の URL で出す
// - ほかのサイトの中に Re:Mail を埋め込ませない（クリックジャッキング対策）
// - ログインのとき Google のログイン画面へ移るので、form-action に accounts.google.com を入れる
export function buildContentSecurityPolicy(nonce?: string): string {
  return [
    "default-src 'self'",
    nonce ? `script-src 'self' 'nonce-${nonce}'` : "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https:",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https:",
    "media-src 'self' data: blob:",
    "frame-src 'self' data: blob:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' https://accounts.google.com",
    // https への切り替えは下の Strict-Transport-Security で行う（ここで upgrade-insecure-requests を入れると、
    // ローカルの http での動作確認が壊れるため入れない）
    "frame-ancestors 'none'",
  ].join("; ");
}

// nonce の無い版。HTML 以外の応答（API など）に付ける
export const CONTENT_SECURITY_POLICY = buildContentSecurityPolicy();

// CSP 以外のヘッダー（next.config.ts の headers() で付ける）
export const SECURITY_HEADERS: { key: string; value: string }[] = [
  // 古いブラウザ向けの、埋め込み禁止
  { key: "X-Frame-Options", value: "DENY" },
  // 送られてきたファイルの種類を勝手に推測させない
  { key: "X-Content-Type-Options", value: "nosniff" },
  // メールのリンクを開いたとき、リンク先に Re:Mail の URL を伝えない（Re:Mail を使っていることを送り手に知らせない）
  { key: "Referrer-Policy", value: "no-referrer" },
  // 使わない端末の機能（カメラ・マイク・位置情報など）は使わせない
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()" },
  // 必ず https で開かせる（workers.dev のこのサイトだけ。サブドメインには広げない）
  { key: "Strict-Transport-Security", value: "max-age=31536000" },
  // ほかのサイトから開かれたウィンドウと、互いに触れられないようにする
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

// 推測できない nonce を作る（16バイトの乱数を base64 にしたもの）
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// Next.js に nonce を渡すため、リクエストに nonce 付きの CSP ヘッダーを入れる。
// ブラウザ側が送ってきた CSP ヘッダーは使わずに必ず上書きする（外から nonce を決めさせないため）
export function withNonceRequest(request: Request, nonce: string): Request {
  const headers = new Headers(request.headers);
  headers.delete("content-security-policy-report-only");
  headers.set("content-security-policy", buildContentSecurityPolicy(nonce));
  return new Request(request, { headers });
}

// 応答に CSP を付ける。HTML には同じ nonce の版、それ以外（API など）には nonce の無い版
export function withNonceResponse(response: Response, nonce: string): Response {
  const type = response.headers.get("content-type") || "";
  const res = new Response(response.body, response);
  res.headers.set("Content-Security-Policy", type.toLowerCase().startsWith("text/html") ? buildContentSecurityPolicy(nonce) : CONTENT_SECURITY_POLICY);
  return res;
}

```

### A.18 `app/lib/emailHtml.ts`

```ts
// HTML メールを iframe で表示する前の下ごしらえ（純粋関数）。
// リモートの画像・CSS・フォントは、読み込んだ時点で送信者に「開封した・いつ・どこで」が伝わる（トラッキング）ので、
// 利用者が「画像を表示」を押すまで読み込ませない（絶対ルール1）。CSP で塞ぐので、書き方の抜け道があっても通らない

// リモートの読み込みを塞ぐ／許す CSP。スクリプトはどちらでも動かさない（iframe の sandbox でも止めている）
export function emailCsp(allowRemote: boolean): string {
  return allowRemote
    ? "default-src 'none'; img-src * data: blob: cid:; style-src * 'unsafe-inline'; font-src * data:; media-src * data: blob:"
    : "default-src 'none'; img-src data: blob: cid:; style-src 'unsafe-inline'; font-src data:; media-src data: blob:";
}

// 「画像を表示」ボタンを出すかどうか。リモートの画像・背景・スタイルシートを含むか
export function hasRemoteContent(html: string): boolean {
  const s = html.length > 2_000_000 ? html.slice(0, 2_000_000) : html;
  return /<img\b[^>]*?\bsrc\s*=\s*["']?\s*(?:https?:)?\/\//i.test(s)
    || /\burl\(\s*["']?\s*(?:https?:)?\/\//i.test(s)
    || /\bbackground\s*=\s*["']?\s*(?:https?:)?\/\//i.test(s)
    || /<link\b[^>]*?\bhref\s*=\s*["']?\s*(?:https?:)?\/\//i.test(s);
}

// 本文の cid: の参照を、取得した画像（data: URL）に置き換える。
// images のキーは Content-ID を小文字にしたもの。見つからない参照はそのまま残す。
// cid: の後ろは引用符・空白・括弧・> までを1回なめるだけなので、巨大な入力でも後戻りしない
export function replaceCidImages(html: string, images: Record<string, string>): string {
  if (Object.keys(images).length === 0) return html;
  return html.replace(/cid:([^"'\s)>]{1,500})/gi, (whole, id: string) => {
    let key = id.toLowerCase();
    if (!(key in images)) {
      try { key = decodeURIComponent(id).toLowerCase(); } catch { return whole; }
    }
    return images[key] ?? whole;
  });
}

const BASE_STYLE =
  '<style>*{box-sizing:border-box;}img{max-width:100%;height:auto;}body{margin:0;padding:16px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;word-break:break-word;opacity:0;transform-origin:0 0;will-change:transform;}</style>';

// iframe の srcDoc に入れる HTML を作る。CSP はほかの何より先に効くよう、head の先頭に入れる
export function prepareEmailHtml(raw: string, allowRemote: boolean): string {
  // <meta http-equiv="refresh"> は iframe の中を外部の URL へ移動させられる（CSP では止まらない）ので取り除く
  // （<meta …> を1つずつ切り出してから中身を見る。タグ全体を1つの正規表現で探すと、巨大なタグで後戻りが爆発する）
  const cleaned = raw.replace(/<meta\b[^>]*>/gi, (tag) => (/http-equiv\s*=\s*["']?\s*refresh/i.test(tag) ? "" : tag));
  const inject =
    `<meta http-equiv="Content-Security-Policy" content="${emailCsp(allowRemote)}">` +
    '<base target="_blank">' +
    BASE_STYLE;
  if (/<head[\s>]/i.test(cleaned)) {
    return cleaned.replace(/(<head[^>]*>)/i, `$1${inject}`);
  }
  return `<!DOCTYPE html><html><head>${inject}</head><body>${cleaned}</body></html>`;
}

```

### A.19 `app/lib/sendVerify.ts`

```ts
// 送信の結果が分からないとき（5xx・タイムアウト・通信断）に、二重送信せずに
// 「本当に送れたか」を送信済みフォルダと照合するための純粋関数
import { splitAddressList, parseAddress } from "./mime";

// Gmail の送信 API の応答をどう扱うか。
// - retry: 429 は Gmail が受け付けを断った（送られていない）ので、待ってから再試行してよい
// - failed: 429 以外の 4xx も送られていないので、失敗として返す
// - unknown: 5xx は Gmail 側で送れている可能性があるので、再試行せず送信済みと照合する
export type SendOutcome = "ok" | "unauthorized" | "retry" | "failed" | "unknown";

// Gmail はレート制限・割り当て超過を 429 だけでなく 403（理由コード rateLimitExceeded など）でも返す。
// 実機テストで、転送の添付取得がこの 403 で失敗していた
const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded", "dailyLimitExceeded"]);

export function isRateLimitReason(reason: string | undefined): boolean {
  return !!reason && RATE_LIMIT_REASONS.has(reason);
}

// Gmail のエラー応答（{ error: { errors: [{ reason }], status } }）から理由コードを取り出す
export function gmailErrorReason(body: unknown): string | undefined {
  const err = (body as { error?: { errors?: { reason?: string }[]; status?: string } } | null)?.error;
  return err?.errors?.[0]?.reason || (err?.status === "RESOURCE_EXHAUSTED" ? "rateLimitExceeded" : undefined);
}

// reason は 403 のときだけ見る（レート制限の 403 は、受け付けを断った＝送られていないので再試行してよい）
export function classifySendStatus(status: number, reason?: string): SendOutcome {
  if (status >= 200 && status < 300) return "ok";
  if (status === 401) return "unauthorized";
  if (status === 429) return "retry";
  if (status === 403 && isRateLimitReason(reason)) return "retry";
  if (status >= 500) return "unknown";
  return "failed";
}

// 送信するメールに付ける Message-ID。照合に使うため送信前にこちらで決める。
// 形は純正 Gmail（<CA…@mail.gmail.com>）に揃え、Re:Mail から送ったことが分からないようにする
export function makeMessageId(randomBytes: Uint8Array): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let id = "CA";
  for (const b of randomBytes) id += chars[b % chars.length];
  return `<${id}@mail.gmail.com>`;
}

// クライアントから受け取った Message-ID を、そのままヘッダーに入れてよい形かどうか
export function isValidMessageId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 200 && /^<[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+>$/.test(value);
}

export function addressSet(list: string): Set<string> {
  return new Set(splitAddressList(list || "").map(e => parseAddress(e).address.toLowerCase()).filter(Boolean));
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

// 件名は折り返しや encoded-word の区切りで空白が変わりうるので、空白を除いて比べる
function normalizeSubject(s: string): string {
  return (s || "").replace(/\s+/g, "");
}

export type SentCandidate = {
  messageIdHeader: string;
  snippet: string; // Gmail が作る本文の冒頭（HTML の文字参照つき）
  subject: string; // 解読済み
  to: string; // 解読済み
  cc: string; // 解読済み
  internalDateMs: number;
};

export type SentExpectation = {
  messageId: string;
  subject: string;
  to: string;
  cc?: string;
  body?: string; // 送ろうとした本文（テキスト）
  sentAfterMs: number;
};

// 本文の冒頭を比べるための正規化。Gmail の snippet は文字参照（&#39; など）が入り、空白も詰められるので、
// 文字参照を戻したうえで空白をすべて除く
function normalizeForSnippet(s: string): string {
  return (s || "")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/\s+/g, "");
}

// 送信済みの1通が、今回送ろうとしたメールかどうか。
// Message-ID が一致すれば確実。Gmail が Message-ID を付け替えた場合に備えて、
// 宛先（To・Cc）・件名・時刻（送信を始めた1分前以降）・本文の冒頭がすべて一致する場合も同じメールとみなす。
// 同じ相手に同じ件名で続けて返信することはよくあるため、本文の冒頭まで見て取り違えを防ぐ
export function matchSentMessage(c: SentCandidate, e: SentExpectation): "messageId" | "fields" | null {
  if (c.messageIdHeader && c.messageIdHeader.trim() === e.messageId) return "messageId";
  if (c.internalDateMs < e.sentAfterMs - 60_000) return null;
  if (normalizeSubject(c.subject) !== normalizeSubject(e.subject)) return null;
  if (!sameSet(addressSet(c.to), addressSet(e.to))) return null;
  if (!sameSet(addressSet(c.cc), addressSet(e.cc || ""))) return null;
  const body = normalizeForSnippet(e.body || "");
  if (body) {
    const snippet = normalizeForSnippet(c.snippet);
    const n = Math.min(40, body.length, snippet.length);
    if (n === 0 || body.slice(0, n) !== snippet.slice(0, n)) return null;
  }
  return "fields";
}

```

### A.20 `app/lib/mime.ts`

```ts
// 送信するメール（RFC 5322 / MIME）を組み立てる純粋関数。
// Gmail の upload エンドポイントにはメール本体をそのまま（base64 で包まずに）送るため、
// ここで作るメールは全体を 7bit の ASCII だけにする（日本語はヘッダーは RFC 2047、本文は base64）。

export type MimeAttachment = { filename: string; mimeType: string; data: string /* base64 */ };
// HTML 本文から cid: で参照する画像（転送で元のメールの本文中の画像を引き継ぐときに使う）
export type MimeInlinePart = MimeAttachment & { contentId: string /* <> なし */ };

export type MimeInput = {
  // 省略すると Gmail がアカウントの既定の送信元を入れる（純正と同じ）。エイリアスから送るときだけ指定する
  from?: string;
  // 送信元エイリアスに「返信先アドレス」が設定されているときに付ける（純正 Gmail と同じ）
  replyTo?: string;
  to: string;
  cc?: string;
  subject: string;
  text?: string;
  html?: string;
  attachments?: MimeAttachment[];
  inline?: MimeInlinePart[];
  inReplyTo?: string;
  references?: string;
  messageId?: string;
  date?: Date;
};

// 文字列はそのまま、{ base64 } は 76 文字ごとに改行を入れて書き出す。
// 添付は数十MBになりうるので、巨大な文字列を作り直さずに1つのバッファへ直接書き込むための形
export type MimeSegment = string | { base64: string };

const CRLF = "\r\n";

// ヘッダーに入れる値から改行を除く（改行を入れられると別のヘッダーを差し込まれるため）
export function stripLineBreaks(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}

export function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  // 1バイトずつ連結すると大きな本文で極端に遅くなるため、チャンク単位で変換する
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

// RFC 2047 の encoded-word にする。1語は75文字以内が決まりなので、UTF-8で45バイト
// （base64で60文字）ごとに区切り、文字の途中では切らない。語と語は折り返し（CRLF+空白）でつなぐ
export function encodeHeaderText(value: string): string {
  const clean = stripLineBreaks(value);
  if (/^[\x20-\x7E]*$/.test(clean)) return clean;
  const encoder = new TextEncoder();
  const words: string[] = [];
  let chunk = "";
  let chunkBytes = 0;
  for (const ch of Array.from(clean)) {
    const n = encoder.encode(ch).length;
    if (chunkBytes + n > 45 && chunk) {
      words.push(`=?UTF-8?B?${utf8ToBase64(chunk)}?=`);
      chunk = "";
      chunkBytes = 0;
    }
    chunk += ch;
    chunkBytes += n;
  }
  if (chunk) words.push(`=?UTF-8?B?${utf8ToBase64(chunk)}?=`);
  return words.join(`${CRLF} `);
}

// 「"山田, 太郎" <a@example.com>, b@example.com」のような宛先の並びを1件ずつに分ける。
// 表示名の中のカンマで切らないよう、引用符と <> の中は区切りとみなさない
export function splitAddressList(list: string): string[] {
  const result: string[] = [];
  let cur = "";
  let inQuote = false;
  let inAngle = false;
  for (const ch of list) {
    if (ch === '"') inQuote = !inQuote;
    else if (ch === "<" && !inQuote) inAngle = true;
    else if (ch === ">" && !inQuote) inAngle = false;
    if ((ch === "," || ch === ";") && !inQuote && !inAngle) {
      if (cur.trim()) result.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) result.push(cur.trim());
  return result;
}

// 1件の宛先を { name, address } に分ける。<> が無ければ全体をアドレスとみなす
export function parseAddress(entry: string): { name: string; address: string } {
  const m = entry.match(/^(.*?)<([^>]+)>\s*$/);
  if (m) {
    const name = m[1].trim().replace(/^"(.*)"$/, "$1").replace(/\\"/g, '"').trim();
    return { name, address: m[2].trim() };
  }
  return { name: "", address: entry.trim().replace(/^"(.*)"$/, "$1") };
}

// To/Cc ヘッダー用に整形する。日本語の表示名は encoded-word にし、
// 英数字でも記号（カンマなど）を含む表示名は引用符で囲む
export function formatAddressHeader(list: string): string {
  return splitAddressList(stripLineBreaks(list))
    .map(entry => {
      const { name, address } = parseAddress(entry);
      if (!name) return address;
      if (!/^[\x20-\x7E]*$/.test(name)) return `${encodeHeaderText(name)} <${address}>`;
      if (/^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~ ]*$/.test(name)) return `${name} <${address}>`;
      return `"${name.replace(/(["\\])/g, "\\$1")}" <${address}>`;
    })
    .join(`,${CRLF} `);
}

// 添付ファイル名。純正 Gmail と同じく name / filename に encoded-word を入れ、
// RFC 2231 の filename*（正式な UTF-8 指定）も併記する
function attachmentNameParams(filename: string): { typeParam: string; dispositionParam: string } {
  const clean = stripLineBreaks(filename || "attachment");
  const quoted = /^[\x20-\x7E]*$/.test(clean)
    ? clean.replace(/(["\\])/g, "\\$1")
    : `=?UTF-8?B?${utf8ToBase64(clean)}?=`;
  const star = encodeURIComponent(clean).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return {
    typeParam: `name="${quoted}"`,
    dispositionParam: `filename="${quoted}"; filename*=UTF-8''${star}`,
  };
}

// MIME タイプとして安全な文字だけ残す（ヘッダーを壊されないように）
function safeMimeType(mimeType: string): string {
  return /^[\w.+-]+\/[\w.+-]+$/.test(mimeType || "") ? mimeType : "application/octet-stream";
}

// base64 として正しい文字だけにする（改行などが混ざっていても MIME の境界を壊させない）
export function cleanBase64(data: string): string {
  return /^[A-Za-z0-9+/=]*$/.test(data) ? data : data.replace(/[^A-Za-z0-9+/=]/g, "");
}

function textPart(contentType: string, content: string): MimeSegment[] {
  return [
    `Content-Type: ${contentType}; charset="UTF-8"${CRLF}`,
    `Content-Transfer-Encoding: base64${CRLF}${CRLF}`,
    { base64: utf8ToBase64(content) },
    CRLF,
  ];
}

function newBoundary(): string {
  return `remail_${crypto.randomUUID().replace(/-/g, "")}`;
}

// 本文部分（テキストのみ／HTMLのみ／両方なら multipart/alternative）
function bodySegments(text: string | undefined, html: string | undefined): MimeSegment[] {
  if (html && text) {
    const b = newBoundary();
    return [
      `Content-Type: multipart/alternative; boundary="${b}"${CRLF}${CRLF}`,
      `--${b}${CRLF}`, ...textPart("text/plain", text),
      `--${b}${CRLF}`, ...textPart("text/html", html),
      `--${b}--${CRLF}`,
    ];
  }
  if (html) return textPart("text/html", html);
  return textPart("text/plain", text || "");
}

// Content-ID として安全な文字だけにする（ヘッダーを壊されないように）
function safeContentId(id: string): string {
  return stripLineBreaks(id).replace(/^<|>$/g, "").replace(/[^\w.@+-]/g, "");
}

// 本文と、本文から参照されるインライン画像（multipart/related）。純正 Gmail が本文中に画像のあるメールを送るときと同じ形
function bodyWithInlineSegments(text: string | undefined, html: string | undefined, inline: MimeInlinePart[]): MimeSegment[] {
  if (inline.length === 0 || !html) return bodySegments(text, html);
  const b = newBoundary();
  const segments: MimeSegment[] = [
    `Content-Type: multipart/related; boundary="${b}"${CRLF}${CRLF}`,
    `--${b}${CRLF}`,
    ...bodySegments(text, html),
  ];
  for (const part of inline) {
    const { typeParam, dispositionParam } = attachmentNameParams(part.filename);
    const cid = safeContentId(part.contentId);
    segments.push(
      `--${b}${CRLF}`,
      `Content-Type: ${safeMimeType(part.mimeType)}; ${typeParam}${CRLF}`,
      `Content-Disposition: inline; ${dispositionParam}${CRLF}`,
      `Content-Transfer-Encoding: base64${CRLF}`,
      `Content-ID: <${cid}>${CRLF}`,
      `X-Attachment-Id: ${cid}${CRLF}${CRLF}`,
      { base64: cleanBase64(part.data || "") },
      CRLF,
    );
  }
  segments.push(`--${b}--${CRLF}`);
  return segments;
}

export function buildMimeSegments(input: MimeInput): MimeSegment[] {
  const headers: string[] = [];
  // Date は付けない。純正 Gmail と同じ形式（送信者のタイムゾーン）で Gmail 側が付ける
  // 並びは純正 Gmail が送るメールと同じにする（MIME-Version → References → In-Reply-To → From → Date →
  // Message-ID → Subject → To → Cc）。Gmail は自分が付け直すヘッダーを並べ替えるが、それ以外はこの順のまま届くため
  headers.push("MIME-Version: 1.0");
  const inReplyTo = input.inReplyTo ? stripLineBreaks(input.inReplyTo).trim() : "";
  const references = input.references ? stripLineBreaks(input.references).trim() : inReplyTo;
  if (references) headers.push(`References: ${references}`);
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (input.from && input.from.trim()) headers.push(`From: ${formatAddressHeader(input.from)}`);
  if (input.date) headers.push(`Date: ${input.date.toUTCString().replace("GMT", "+0000")}`);
  if (input.messageId) headers.push(`Message-ID: ${stripLineBreaks(input.messageId).trim()}`);
  headers.push(`Subject: ${encodeHeaderText(input.subject || "")}`);
  headers.push(`To: ${formatAddressHeader(input.to || "")}`);
  if (input.cc && input.cc.trim()) headers.push(`Cc: ${formatAddressHeader(input.cc)}`);
  if (input.replyTo && input.replyTo.trim()) headers.push(`Reply-To: ${formatAddressHeader(input.replyTo)}`);

  const attachments = input.attachments || [];
  const inline = input.inline || [];
  if (attachments.length === 0) {
    return [headers.join(CRLF) + CRLF, ...bodyWithInlineSegments(input.text, input.html, inline)];
  }

  const b = newBoundary();
  const segments: MimeSegment[] = [
    headers.join(CRLF) + CRLF,
    `Content-Type: multipart/mixed; boundary="${b}"${CRLF}${CRLF}`,
    `--${b}${CRLF}`,
    ...bodyWithInlineSegments(input.text, input.html, inline),
  ];
  for (const att of attachments) {
    const { typeParam, dispositionParam } = attachmentNameParams(att.filename);
    segments.push(
      `--${b}${CRLF}`,
      `Content-Type: ${safeMimeType(att.mimeType)}; ${typeParam}${CRLF}`,
      `Content-Disposition: attachment; ${dispositionParam}${CRLF}`,
      `Content-Transfer-Encoding: base64${CRLF}${CRLF}`,
      { base64: cleanBase64(att.data || "") },
      CRLF,
    );
  }
  segments.push(`--${b}--${CRLF}`);
  return segments;
}

const LINE = 76;

function segmentLength(seg: MimeSegment): number {
  if (typeof seg === "string") return new TextEncoder().encode(seg).length;
  const len = seg.base64.length;
  return len + Math.ceil(len / LINE) * 2 - (len > 0 ? 2 : 0);
}

// セグメントを1つのバイト列にする。添付の base64 は巨大になりうるので、
// 改行入りの文字列を作り直さずに1文字ずつバッファへ書き込む（メモリを倍に使わないため）
export function assembleBytes(segments: MimeSegment[]): Uint8Array<ArrayBuffer> {
  const total = segments.reduce((sum, s) => sum + segmentLength(s), 0);
  const buf = new Uint8Array(total);
  const encoder = new TextEncoder();
  let off = 0;
  for (const seg of segments) {
    if (typeof seg === "string") {
      off += encoder.encodeInto(seg, buf.subarray(off)).written;
      continue;
    }
    const s = seg.base64;
    for (let i = 0; i < s.length; i++) {
      if (i > 0 && i % LINE === 0) { buf[off++] = 13; buf[off++] = 10; }
      buf[off++] = s.charCodeAt(i);
    }
  }
  return buf;
}

// Gmail の upload エンドポイント（uploadType=multipart）に送る本体。
// 1つ目のパートがメタデータ（threadId）、2つ目がメール本体そのもの
export function buildGmailUploadBody(message: MimeSegment[], threadId?: string): { body: Uint8Array<ArrayBuffer>; contentType: string } {
  const b = newBoundary();
  const metadata = JSON.stringify(threadId ? { threadId } : {});
  const segments: MimeSegment[] = [
    `--${b}${CRLF}Content-Type: application/json; charset=UTF-8${CRLF}${CRLF}${metadata}${CRLF}`,
    `--${b}${CRLF}Content-Type: message/rfc822${CRLF}${CRLF}`,
    ...message,
    `${CRLF}--${b}--${CRLF}`,
  ];
  return { body: assembleBytes(segments), contentType: `multipart/related; boundary=${b}` };
}

// メールの charset 名を、TextDecoder が受け付ける名前にそろえる。日本語のメールで使われる別名
// （cp932 など）は Workers の TextDecoder が知らないので、同じ文字の集まりの名前に置き換える
const CHARSET_ALIASES: Record<string, string> = {
  "cp932": "shift_jis", "ms932": "shift_jis", "windows-31j": "shift_jis", "x-sjis": "shift_jis", "sjis": "shift_jis", "shift-jis": "shift_jis", "x-ms-cp932": "shift_jis",
  "x-euc-jp": "euc-jp", "eucjp": "euc-jp",
  "iso-2022-jp-ms": "iso-2022-jp", "iso-2022-jp-1": "iso-2022-jp", "iso-2022-jp-2": "iso-2022-jp", "csiso2022jp": "iso-2022-jp",
  "utf8": "utf-8", "us-ascii": "utf-8", "ascii": "utf-8",
};

export function normalizeCharset(charset: string | undefined): string {
  const c = (charset || "").trim().replace(/^"|"$/g, "").toLowerCase();
  if (!c) return "utf-8";
  return CHARSET_ALIASES[c] || c;
}

// バイト列を指定の charset で文字にする。知らない charset なら UTF-8 として読む（壊れた入力でも例外にしない）
export function decodeBytes(bytes: Uint8Array, charset: string | undefined): string {
  try {
    return new TextDecoder(normalizeCharset(charset)).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

// Content-Type の値から charset を取り出す（無ければ undefined）
export function charsetOf(contentType: string | undefined): string | undefined {
  const m = (contentType || "").match(/charset\s*=\s*"?([^";\s]+)"?/i);
  return m ? m[1] : undefined;
}

function binaryToBytes(bin: string): Uint8Array {
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 0xff;
  return bytes;
}

// 受信したヘッダーの encoded-word（=?UTF-8?B?...?= / =?ISO-2022-JP?B?...?= など）を日本語に戻す。
// 長い件名は複数の語に分けて折り返されていて、送り手によっては1文字の途中で語が切れていることがあるため、
// 続いている同じ charset の語はバイト列をつなげてから1回で文字にする
export function decodeMimeHeader(header: string): string {
  if (!header) return "";
  // 語と語の間の空白・改行は文字ではなく区切りなので取り除く（RFC 2047）
  const src = header.replace(/(\?=)\s+(?==\?)/g, "$1");
  const re = /=\?([^?]+)\?([BQbq])\?([^?]*)\?=/g;
  let out = "";
  let last = 0;
  let pending: { charset: string; parts: Uint8Array[] } | null = null;
  const flush = () => {
    if (!pending) return;
    const total = pending.parts.reduce((n, b) => n + b.length, 0);
    const all = new Uint8Array(total);
    let off = 0;
    for (const b of pending.parts) { all.set(b, off); off += b.length; }
    out += decodeBytes(all, pending.charset);
    pending = null;
  };
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const [whole, rawCharset, encoding, text] = m;
    // 「charset*言語」の形（RFC 2231）は言語の部分を捨てる
    const charset = normalizeCharset(rawCharset.split("*")[0]);
    let bytes: Uint8Array;
    try {
      bytes = encoding.toUpperCase() === "B"
        ? binaryToBytes(atob(text))
        : binaryToBytes(text.replace(/_/g, " ").replace(/=([a-fA-F0-9]{2})/g, (_: string, hex: string) => String.fromCharCode(parseInt(hex, 16))));
    } catch {
      // 壊れた語はそのまま残す
      flush();
      out += src.slice(last, m.index) + whole;
      last = m.index + whole.length;
      continue;
    }
    if (m.index !== last) { flush(); out += src.slice(last, m.index); }
    if (pending && pending.charset !== charset) flush();
    if (!pending) pending = { charset, parts: [] };
    pending.parts.push(bytes);
    last = m.index + whole.length;
  }
  flush();
  return out + src.slice(last);
}

```

### A.21 `app/lib/replyCompose.ts`

```ts
// 返信メールの件名・References・送信元エイリアス・署名・引用を、純正 Gmail と同じ形で組み立てる純粋関数。
// 相手から見て Gmail 純正で送ったものと区別がつかないようにする（絶対ルール2）
import { splitAddressList, parseAddress } from "./mime";

// Gmail の sendAs 設定（users.settings.sendAs）のうち使うものだけ
export type SendAsInfo = {
  sendAsEmail: string;
  displayName?: string;
  signature?: string; // HTML
  replyToAddress?: string;
  isDefault?: boolean;
  isPrimary?: boolean;
};

// 「Re: 元の件名」。すでに Re: で始まっていれば付け足さない（大文字小文字は問わない）
export function replySubjectFor(original: string): string {
  // 「(件名なし)」は件名が空のときに画面用に入れている文字なので、元の件名としては空として扱う
  const s = (original || "").trim() === "(件名なし)" ? "" : (original || "").trim();
  if (/^re\s*:/i.test(s)) return s;
  return s ? `Re: ${s}` : "Re: ";
}

// 返信の References は「元のメールの References ＋ 元のメールの Message-ID」（RFC 5322）。
// 長いスレッドで際限なく伸びないよう、純正 Gmail と同じく直近のものだけ残す
export function buildReferences(originalReferences: string | undefined, originalMessageId: string | undefined, max = 20): string {
  const ids = `${originalReferences || ""} ${originalMessageId || ""}`.match(/<[^<>\s]+>/g) || [];
  const unique: string[] = [];
  for (const id of ids) if (!unique.includes(id)) unique.push(id);
  return unique.slice(-max).join(" ");
}

// 返信に使う送信元。元のメールが自分のエイリアス宛てに届いていたらそのエイリアスから、
// そうでなければ既定の送信元から送る（純正 Gmail の「メールを受信したアドレスから返信する」と同じ）
export function pickSendAs(list: SendAsInfo[], originalRecipients: string, accountEmail: string): SendAsInfo | null {
  if (list.length === 0) return null;
  const received = new Set(splitAddressList(originalRecipients || "").map(e => parseAddress(e).address.toLowerCase()));
  const matched = list.find(s => received.has(s.sendAsEmail.toLowerCase()));
  if (matched) return matched;
  return list.find(s => s.isDefault) || list.find(s => s.isPrimary) || list.find(s => s.sendAsEmail.toLowerCase() === accountEmail.toLowerCase()) || null;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function textToHtml(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, "<br>");
}

// 署名（HTML）をテキスト版の本文に入れるための文字列にする
export function signatureToText(html: string): string {
  return (html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    // ブロック要素の始まりと終わりで改行する（入れ子の div でも行がつながらないように）
    .replace(/<\/?(div|p|li|tr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .split("\n").map(l => l.trimEnd()).join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

// 引用の見出しや転送の見出しに出す宛先の書き方。純正 Gmail は表示名を引用符で囲まず
// 「山田 太郎 <a@example.com>」、表示名が無ければ「<a@example.com>」と書く
export function displayAddress(entry: string): string {
  const { name, address } = parseAddress(entry);
  return name ? `${name} <${address}>` : `<${address}>`;
}

export function displayAddressList(list: string): string {
  return splitAddressList(list || "").map(displayAddress).join(", ");
}

// 日本語版 Gmail の引用の見出し「2026年1月1日(木) 10:00 山田 太郎 <a@example.com>:」
export function formatQuoteHeader(date: Date, from: string): string {
  const weekday = ["日", "月", "火", "水", "木", "金", "土"][date.getDay()];
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日(${weekday}) ${hh}:${mm} ${displayAddress(from)}:`;
}

export type ReplyComposeInput = {
  text: string; // 利用者が書いた本文
  signatureHtml?: string; // sendAs の署名（無ければ付けない）
  quote?: { header: string; originalText: string; originalHtml?: string };
};

// 署名の HTML。純正 Gmail が付けるものと同じ形
function signatureHtmlBlock(sig: string): string {
  return `<div><br clear="all"></div><div><br></div><span class="gmail_signature_prefix">-- </span><br><div dir="ltr" class="gmail_signature" data-smartmail="gmail_signature">${sig}</div>`;
}

// テキスト版と HTML 版の本文を作る。並びは純正 Gmail の既定（「返信で元のメッセージの前に署名を挿入」がオフ）と
// 同じ「本文 → 引用 → 署名（-- の後）」。実際に純正 Gmail から送ったメールのソースと比べて合わせてある
export function composeReplyBodies(input: ReplyComposeInput): { text: string; html: string } {
  const sig = (input.signatureHtml || "").trim();
  const sigText = sig ? signatureToText(sig) : "";

  let text = input.text;
  if (input.quote) {
    const quoted = input.quote.originalText.replace(/\s+$/, "").split(/\r?\n/).map(l => (l ? `> ${l}` : ">")).join("\n");
    text += `\n\n\n${input.quote.header}\n\n${quoted}\n>\n`;
  }
  if (sigText) text += `\n\n-- \n${sigText}\n`;

  let html = `<div dir="ltr">${textToHtml(input.text)}</div>`;
  if (input.quote) {
    const original = input.quote.originalHtml?.trim() ? input.quote.originalHtml : textToHtml(input.quote.originalText);
    html += `<br><div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">${escapeHtml(input.quote.header)}<br></div>`
      + `<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">${original}</blockquote></div>`;
  }
  if (sig) html += signatureHtmlBlock(sig);
  return { text, html };
}

// 元の HTML メールは <html><head>…</head><body>…</body></html> の完全な文書であることが多い。
// 別の HTML の中に入れ子にすると構造が壊れ、背景色などが正しく出なくなるため、body の中身と属性だけを取り出す
export function extractHtmlBodyInner(html: string): { inner: string; attrs: string } {
  const bodyMatch = html.match(/<body([^>]*)>([\s\S]*)<\/body>/i);
  if (bodyMatch) return { inner: bodyMatch[2], attrs: bodyMatch[1] };
  const htmlMatch = html.match(/<html[^>]*>([\s\S]*)<\/html>/i);
  if (htmlMatch) return { inner: htmlMatch[1], attrs: "" };
  return { inner: html, attrs: "" };
}

// 「Fwd: 元の件名」。すでに Fwd: / Fw: で始まっていれば付け足さない
export function forwardSubjectFor(original: string): string {
  const s = (original || "").trim() === "(件名なし)" ? "" : (original || "").trim();
  if (/^fwd?\s*:/i.test(s)) return s;
  return `Fwd: ${s}`;
}

// 日本語版 Gmail の転送の Date 行「2026年1月1日(木) 9:05」
export function formatForwardDate(date: Date): string {
  const weekday = ["日", "月", "火", "水", "木", "金", "土"][date.getDay()];
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日(${weekday}) ${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export type ForwardComposeInput = {
  // 転送に添える本文（Re:Mail の転送画面では今は書けないので、空のことが多い）
  text?: string;
  signatureHtml?: string;
  original: { from: string; date: Date; subject: string; to: string; cc?: string; text: string; html?: string };
};

// 転送の見出しの宛先（HTML）。純正 Gmail と同じく「表示名 &lt;アドレス&gt;」、表示名が無ければ「 &lt;アドレス&gt;」
function forwardAddressHtml(list: string): string {
  return splitAddressList(list || "").map(e => {
    const { name, address } = parseAddress(e);
    return `${escapeHtml(name)} &lt;${escapeHtml(address)}&gt;`;
  }).join(", ");
}

// 転送の本文を純正 Gmail と同じ並び（本文 →「---------- Forwarded message ---------」の見出し → 元の本文 → 署名）で作る。
// 見出しの文言は日本語版 Gmail でも英語のまま。実際に純正 Gmail から送ったメールのソースと比べて合わせてある
export function composeForwardBodies(input: ForwardComposeInput): { text: string; html: string } {
  const o = input.original;
  const sig = (input.signatureHtml || "").trim();
  const body = input.text || "";
  const headerLines = [
    "---------- Forwarded message ---------",
    `From: ${displayAddress(o.from)}`,
    `Date: ${formatForwardDate(o.date)}`,
    `Subject: ${o.subject}`,
    `To: ${displayAddressList(o.to)}`,
    ...(o.cc ? [`Cc: ${displayAddressList(o.cc)}`] : []),
  ];

  let text = `${body}\n\n\n${headerLines.join("\n")}\n\n\n${o.text.replace(/\s+$/, "")}\n`;
  if (sig) text += `\n\n-- \n${signatureToText(sig)}\n`;

  const from = parseAddress(o.from);
  const headerHtml = [
    "---------- Forwarded message ---------",
    `From: <strong class="gmail_sendername" dir="auto">${escapeHtml(from.name || from.address)}</strong> <span dir="auto">&lt;${escapeHtml(from.address)}&gt;</span>`,
    `Date: ${escapeHtml(formatForwardDate(o.date))}`,
    `Subject: ${escapeHtml(o.subject)}`,
    `To: ${forwardAddressHtml(o.to)}`,
    ...(o.cc ? [`Cc: ${forwardAddressHtml(o.cc)}`] : []),
  ].join("<br>");

  let original: string;
  if (o.html && o.html.trim()) {
    // <body> があるときだけ、その属性（背景色など）を残すために div で包む。無ければそのまま入れる（純正と同じ）
    const { inner, attrs } = extractHtmlBodyInner(o.html);
    original = /<body[\s>]/i.test(o.html) ? `<div${attrs}>${inner}</div>` : inner;
  } else {
    original = `<div dir="ltr">${textToHtml(o.text)}</div>`;
  }
  let html = `<div dir="ltr">${textToHtml(body)}<div><br><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">${headerHtml}<br></div><br><br>${original}\n</div>`;
  if (sig) html += signatureHtmlBlock(sig);
  html += "</div></div>";
  return { text, html };
}

```

### A.22 `app/lib/recipients.ts`

```ts
// 返信の宛先を、純正 Gmail と同じ決まりで計算する純粋関数。
// - 返信（相手のみ）: Reply-To があればそこへ、なければ差出人へ。自分が送ったメールへの返信なら、元の To へ
// - 全員に返信: 上に加えて元の To の残りを To に、元の Cc を Cc に入れる。自分のアドレスと重複は除く
import { splitAddressList, parseAddress } from "./mime";

export type ReplySource = { from: string; to: string; cc?: string; replyTo?: string };
export type ReplyRecipients = { to: string; cc: string };
export type ExtraRecipient = { name: string; address: string; field: "to" | "cc" };
export type ReplyPlan = {
  senderOnly: ReplyRecipients;
  all: ReplyRecipients;
  // 「全員に返信」にすると増える宛先。空なら「全員に返信」の切り替えを出さない
  extra: ExtraRecipient[];
};

type Entry = { raw: string; name: string; address: string; key: string };

function entries(list: string | undefined): Entry[] {
  return splitAddressList(list || "")
    .map(raw => {
      const { name, address } = parseAddress(raw);
      return { raw: raw.trim(), name, address, key: address.trim().toLowerCase() };
    })
    .filter(e => e.key.includes("@"));
}

function uniqueExcluding(list: Entry[], exclude: Set<string>): Entry[] {
  const seen = new Set(exclude);
  const out: Entry[] = [];
  for (const e of list) {
    if (seen.has(e.key)) continue;
    seen.add(e.key);
    out.push(e);
  }
  return out;
}

const join = (list: Entry[]) => list.map(e => e.raw).join(", ");

export function planReply(src: ReplySource, myAddresses: string[]): ReplyPlan {
  const me = new Set(myAddresses.filter(Boolean).map(a => a.trim().toLowerCase()));
  const from = entries(src.from);
  const to = entries(src.to);
  const cc = entries(src.cc);
  const replyTo = entries(src.replyTo);
  const fromIsMe = from.length > 0 && me.has(from[0].key);

  // 相手のみに返すときの宛先
  let primary: Entry[];
  if (fromIsMe) primary = to;
  else if (replyTo.length > 0) primary = replyTo;
  else primary = from;
  let senderOnlyTo = uniqueExcluding(primary, me);
  // 自分宛てに自分で送ったメールなど、ほかに宛先が残らない場合は差出人（自分）へ返す
  if (senderOnlyTo.length === 0) senderOnlyTo = from.slice(0, 1);

  const allTo = uniqueExcluding([...senderOnlyTo, ...(fromIsMe ? [] : to)], me);
  const allCc = uniqueExcluding(cc, new Set([...me, ...allTo.map(e => e.key)]));

  const senderKeys = new Set(senderOnlyTo.map(e => e.key));
  const extra: ExtraRecipient[] = [
    ...allTo.filter(e => !senderKeys.has(e.key)).map(e => ({ name: e.name, address: e.address, field: "to" as const })),
    ...allCc.map(e => ({ name: e.name, address: e.address, field: "cc" as const })),
  ];

  return {
    senderOnly: { to: join(senderOnlyTo), cc: "" },
    all: { to: join(allTo), cc: join(allCc) },
    extra,
  };
}

// 入力欄の近くに出す「Cc：山田さん ほか2名」の文言。Cc が1人でもいれば Cc、いなければ To と書く
export function describeExtraRecipients(extra: ExtraRecipient[]): string {
  if (extra.length === 0) return "";
  const first = extra.find(e => e.field === "cc") || extra[0];
  const label = extra.some(e => e.field === "cc") ? "Cc" : "To";
  const who = first.name ? `${first.name}さん` : first.address;
  return extra.length > 1 ? `${label}：${who} ほか${extra.length - 1}名` : `${label}：${who}`;
}

```

### A.23 `app/lib/messageParse.ts`

```ts
// Gmail API のメッセージ（生データ）から、画面に出す本文・添付・リンクなどを取り出す処理。
// 長さや入れ子の深さが決まっていない入力を扱うので、どれも上限を設けて、超えたら処理を打ち切る（絶対ルール3）。
// Cloudflare Workers では処理中に時計が進まないため「○ミリ秒で打ち切る」はできない。代わりに、
// 後戻りが爆発する正規表現を使わず（indexOf で前から1回なめる）、入力の長さと数に上限を設ける
import { decodeMimeHeader, decodeBytes, charsetOf } from "./mime";

// Gmail API の生データ（必要なフィールドだけ）
export type GmailHeader = { name: string; value: string };
export type GmailMessagePart = {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailMessagePart[];
};
export type GmailMessage = { id: string; threadId: string; snippet?: string; labelIds?: string[]; payload?: GmailMessagePart };

// 入力の上限。超えた分は処理せず打ち切る（壊れたメールや悪意のあるメールで Worker や画面を固めないため）
export const LIMITS = {
  mimeDepth: 30, // MIME パートの入れ子の深さ
  mimeParts: 500, // 1通で見る MIME パートの数
  bodyChars: 300_000, // 整形する本文テキストの長さ。超えたら整形せずに生のまま（先頭だけ）出す
  cssRuleChars: 100_000, // 紛れ込んだ CSS を探す本文の長さ
  htmlChars: 2_000_000, // リンク抽出・転送判定にかける HTML の長さ
  links: 300, // 取り出すリンクの数
} as const;

export const TRUNCATED_NOTICE = "\n…(長文のため以下省略。全文は Gmail で確認してください)";

export function getHeader(headers: GmailHeader[], name: string): string {
  const header = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return header ? header.value : "";
}

// Gmail の body.data（base64url）を文字にする。Gmail API はテキストのパートを UTF-8 に直して返す
// （Content-Type の charset は元の Shift_JIS などのまま残る）ことを実機で確かめたので、まず UTF-8 として読む。
// UTF-8 として正しくないバイト列のときだけ、書かれている charset で読み直す
export function decodeBase64Url(base64Url: string, charset?: string) {
  try {
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const binString = atob(base64);
    const bytes = Uint8Array.from(binString, (m) => m.charCodeAt(0) & 0xff);
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      // ISO-2022-JP は ASCII だけでできているので UTF-8 としても正しく見える。
      // 漢字への切り替え（ESC $ B / ESC $ @）が入っていれば ISO-2022-JP として読む
      if (/\x1b\$[B@]/.test(text)) return decodeBytes(bytes, "iso-2022-jp");
      return text;
    } catch {
      return decodeBytes(bytes, charset);
    }
  } catch {
    return "";
  }
}

// パートの Content-Type ヘッダーにある charset
export function partCharset(part: GmailMessagePart): string | undefined {
  const ct = (part.headers || []).find((h) => h.name.toLowerCase() === "content-type")?.value;
  return charsetOf(ct);
}

// MIME の木を、深さとパート数の上限つきでたどる（深すぎる入れ子でスタックを使い切らないように）
export function walkParts(root: GmailMessagePart | undefined, visit: (part: GmailMessagePart) => void): void {
  let count = 0;
  const walk = (part: GmailMessagePart | undefined, depth: number) => {
    if (!part || depth > LIMITS.mimeDepth || count >= LIMITS.mimeParts) return;
    count++;
    visit(part);
    if (Array.isArray(part.parts)) for (const child of part.parts) walk(child, depth + 1);
  };
  walk(root, 0);
}

// テキスト本文。単一パートならその中身、複数パートなら木の順で最初の text/plain、無ければ最初の text/html
export function getTextBody(payload: GmailMessagePart): string {
  if (payload.body && payload.body.data) return decodeBase64Url(payload.body.data, partCharset(payload));
  // コールバックの中で代入すると型の絞り込みが効かないので、入れ物に入れて受け取る
  const found: { plain?: GmailMessagePart; html?: GmailMessagePart } = {};
  walkParts(payload, (part) => {
    if (part === payload || !part.body?.data) return;
    if (!found.plain && part.mimeType === "text/plain") found.plain = part;
    else if (!found.html && part.mimeType === "text/html") found.html = part;
  });
  const picked = found.plain || found.html;
  if (picked && picked.body?.data) return decodeBase64Url(picked.body.data, partCharset(picked));
  return "";
}

// S/MIME署名ファイル（smime.p7s など）は、メールの本文とは無関係な電子署名データで、
// Gmail自身も添付ファイルとして表示しない。銀行系のメールなどで必ず付与されることが多いため、
// re:mailでも同様に一覧から除外する
export function isSmimeSignaturePart(mimeType: string, filename: string): boolean {
  const mt = mimeType.toLowerCase();
  if (mt === 'application/pkcs7-signature' || mt === 'application/x-pkcs7-signature') return true;
  return /^smime\.p7[sm]$/i.test(filename.trim());
}

// 添付として並べるパート。
// html を渡したときは純正 Gmail と同じく、本文の HTML から cid: で参照されている画像は本文の中に出すので並べず、
// 参照されていないインラインのパート（Content-Disposition: inline）は添付として並べる（どこにも出ずに消えないように）。
// html を渡さないときは、これまでどおりインラインのパートを並べない
export function extractAttachments(payload: GmailMessagePart | undefined, html?: string): Array<{ filename: string; mimeType: string; size: number; attachmentId: string }> {
  const results: Array<{ filename: string; mimeType: string; size: number; attachmentId: string }> = [];
  walkParts(payload, (part) => {
    if (!part.body?.attachmentId) return;
    const headers = part.headers || [];
    const disp = headers.find((h) => h.name?.toLowerCase() === 'content-disposition')?.value?.toLowerCase() ?? '';
    const mimeType = part.mimeType || 'application/octet-stream';
    const contentId = (headers.find((h) => h.name?.toLowerCase() === 'content-id')?.value || '').trim().replace(/^<|>$/g, '');
    const name = part.filename?.trim() || '';
    if (isSmimeSignaturePart(mimeType, name)) return;
    if (html === undefined) {
      if (name && !disp.startsWith('inline')) results.push({ filename: name, mimeType, size: part.body.size || 0, attachmentId: part.body.attachmentId });
      return;
    }
    if (contentId && referencesContentId(html, contentId)) return;
    // 名前のない画像（iPhone のメールの本文中の写真など）も、消さずに添付として並べる
    const filename = name || (mimeType.startsWith('image/') && (disp.startsWith('inline') || contentId) ? `image.${mimeType.slice(6).replace(/[^a-z0-9]/gi, '') || 'img'}` : '');
    if (filename) results.push({ filename, mimeType, size: part.body.size || 0, attachmentId: part.body.attachmentId });
  });
  return results;
}

// Content-ID を持つパート（HTML 本文から cid: で参照される画像など）。転送で本文中の画像を引き継ぐために使う
export function extractContentIdParts(payload: GmailMessagePart | undefined): Array<{ filename: string; mimeType: string; size: number; attachmentId: string; contentId: string }> {
  const results: Array<{ filename: string; mimeType: string; size: number; attachmentId: string; contentId: string }> = [];
  walkParts(payload, (part) => {
    if (!part.body?.attachmentId) return;
    const raw = (part.headers || []).find((h) => h.name?.toLowerCase() === "content-id")?.value || "";
    const contentId = raw.trim().replace(/^<|>$/g, "");
    if (!contentId) return;
    results.push({ filename: part.filename || contentId, mimeType: part.mimeType || "application/octet-stream", size: part.body.size || 0, attachmentId: part.body.attachmentId, contentId });
  });
  return results;
}

// HTML が cid: でその画像を参照しているか（大文字小文字は区別しない。URL エンコードされた形も見る）
export function referencesContentId(html: string, contentId: string): boolean {
  const h = (html || "").toLowerCase();
  const id = contentId.toLowerCase();
  return h.includes(`cid:${id}`) || h.includes(`cid:${encodeURIComponent(id).toLowerCase()}`);
}

// HTML 本文の <a href="http..."> から「リンクの文字 → URL」を取り出す。
// 閉じタグの無い <a> が大量にあると正規表現では文末まで何度も探し直して固まるため、indexOf で前から1回なめる
export function extractHtmlLinks(html: string): Array<{text: string, href: string}> {
  const links: Array<{text: string, href: string}> = [];
  const seen = new Set<string>();
  const src = html.length > LIMITS.htmlChars ? html.slice(0, LIMITS.htmlChars) : html;
  const lower = src.toLowerCase();
  let pos = 0;
  while (links.length < LIMITS.links) {
    const open = lower.indexOf("<a", pos);
    if (open === -1) break;
    const next = lower.charAt(open + 2);
    if (next !== ">" && !/\s/.test(next)) { pos = open + 2; continue; }
    const tagEnd = lower.indexOf(">", open);
    if (tagEnd === -1) break;
    const close = lower.indexOf("</a>", tagEnd);
    if (close === -1) break;
    // タグ1つ分（長くても4000文字）だけを見るので、ここの正規表現は短い文字列にしかかからない
    const tag = src.slice(open, Math.min(tagEnd + 1, open + 4000));
    const hrefMatch = tag.match(/\bhref\s*=\s*["']?(https?:\/\/[^"'\s>]+)/i);
    if (hrefMatch) {
      const rawText = src.slice(tagEnd + 1, close).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      // テキストが空・長すぎ・そのままURLの場合はスキップ
      if (rawText && rawText.length <= 150 && !rawText.startsWith("http") && !seen.has(rawText)) {
        seen.add(rawText);
        links.push({ text: rawText, href: hrefMatch[1].trim() });
      }
    }
    pos = close + 4;
  }
  return links;
}

// multipart/related や multipart/alternative が何重にもネストしていても取りこぼさないよう、
// 木構造を最後まで走査してすべての text/html パートを集め、最も内容量の多いものを採用する
// （マーケティングメールなどで、装飾用の小さいhtml断片が本文より先に見つかってしまうのを防ぐ）
export function getHtmlBody(payload: GmailMessagePart | undefined): string {
  const candidates: string[] = [];
  walkParts(payload, (part) => {
    if (part.mimeType === "text/html" && part.body?.data) {
      const decoded = decodeBase64Url(part.body.data, partCharset(part));
      if (decoded) candidates.push(decoded);
    }
  });
  if (candidates.length === 0) return "";
  return candidates.reduce((longest, cur) => (cur.length > longest.length ? cur : longest));
}

// HTML版の返信引用ブロックを除去する。Gmailは "gmail_attr"（差出人/日時の一行）+
// "gmail_quote"（引用本文）というdivで、他クライアントは<blockquote>で末尾に引用を付与する。
// これらは常にメール本文の末尾に置かれるため、最初に見つかった開始位置から後ろを丸ごと切り落とす
export function stripHtmlQuote(html: string): string {
  if (!html) return html;
  const lower = html.toLowerCase();
  let cut = html.length;
  // class に gmail_attr / gmail_quote を持つ <div> の開始位置。正規表現でタグ全体を探すと、
  // 巨大なタグで後戻りが爆発するため、目印の語を indexOf で探してから、それを含むのが <div ...> かを確かめる
  for (const key of ["gmail_attr", "gmail_quote"]) {
    let from = 0;
    for (let tries = 0; tries < 1000; tries++) {
      const idx = lower.indexOf(key, from);
      if (idx === -1 || idx >= cut) break;
      const tagStart = lower.lastIndexOf("<", idx);
      const tagClose = tagStart === -1 ? -1 : lower.indexOf(">", tagStart);
      if (tagStart !== -1 && lower.startsWith("<div", tagStart) && tagClose > idx && idx - tagStart < 4000 && /\bclass\s*=/.test(lower.slice(tagStart, idx))) {
        cut = tagStart;
        break;
      }
      from = idx + key.length;
    }
  }
  const bq = lower.indexOf("<blockquote");
  if (bq !== -1 && bq < cut && /[\s>/]/.test(lower.charAt(bq + 11))) cut = bq;
  return html.slice(0, cut).trim();
}

// 件名が「Fwd:/Fw:」で始まる、または本文にGmail標準の転送マーカー（"---------- Forwarded
// message ---------"、日本語版Gmailでもこの部分は英語のまま）が引用符（"> "）なしで
// 含まれる場合は転送メールとみなす。「転送メールへの返信」だと、返信本文が引用した
// 転送内容の中にこのマーカーが "> " 付きで含まれてしまうため、引用行は対象から除外する
// （そうしないと、転送への返信自体が転送メール扱いされ、返信タグが消えたり
// 引用文除去がスキップされて元メッセージがそのまま表示され続けてしまう）
export function looksLikeForward(subject: string, bodyForCheck: string): boolean {
  if (/^\s*(fwd|fw)\s*:/i.test(subject || "")) return true;
  const src = (bodyForCheck || "").slice(0, LIMITS.htmlChars);
  const idx = src.toLowerCase().indexOf("forwarded message");
  if (idx === -1) return false;
  const lineStart = src.lastIndexOf("\n", idx) + 1;
  return !src.slice(lineStart, idx).trim().startsWith(">");
}

// 一部のメール（Yahoo!メールなど）は text/plain パートの生成が壊れており、
// <style>ブロックの中身（CSSの宣言）がタグなしでそのまま紛れ込んでいることがある。
// 通常の文章にはまず現れない「セレクタ { プロパティ: 値; ... }」という並びを検出して除去する
export function stripLooseCssRules(text: string): string {
  // 長すぎる本文や { を含まない本文では何もしない（見た目を整えるだけの処理なので、打ち切っても困らない）
  if (text.length > LIMITS.cssRuleChars || !text.includes("{")) return text;
  // { から次の { か } までしか進まないので、閉じていない { が大量にあっても全体で1回なめるだけで済む。
  // 中身が「プロパティ: 値;」の並び（2000文字以内）のときだけ消す
  return text.replace(/[^\n{}]{0,80}\{([^{}]{0,2000})\}/g, (m, inner: string) =>
    /^\s*(?:[\w-]+\s*:\s*[^;{}]+;\s*)+$/.test(inner) ? "" : m
  );
}

// 返信メールの末尾に自動付与される「引用元」ブロックを検出して取り除く。
// チャットUIでは代わりに「どのメッセージへの返信か」を専用のチップで表示するため、
// 本文側にこの定型引用文が残っていると二重表示・ノイズになる。
// メールクライアントごとに「YYYY年M月D日(曜) H:MM 差出人:」「On ... wrote:」
// 「差出人さんは書きました:」等、引用ヘッダーの文言はまちまちだが、引用本文自体は
// どのクライアントも共通して各行を "> " で始める（RFC的な慣習）ため、
// 特定の文言にマッチさせるのではなく、最初に現れる "> " 行を引用ブロックの開始とみなし、
// その直前の行が引用ヘッダーらしければ一緒に切り落とす、という汎用的な方式にする
export function stripQuotedReply(text: string): string {
  if (!text) return text;
  const lines = text.split("\n");
  let quoteStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^>/.test(lines[i].trim())) { quoteStart = i; break; }
  }
  if (quoteStart === -1) {
    // 引用元の本文が空などの理由で "> " 行自体が残っていない場合でも、
    // 日付ヘッダー行（「YYYY年M月D日(曜) H:MM 差出人:」）だけが末尾に取り残されることがあるため、
    // 定番の日英ヘッダー文言は保険として除去する
    let stripped = text.replace(/\n{0,2}\d{4}年\d{1,2}月\d{1,2}日\([日月火水木金土]\)\s*\d{1,2}:\d{2}\s+[^\n]*?:\s*[\s\S]*$/, "");
    stripped = stripped.replace(/\n{0,2}On\s.{0,150}?wrote:\s*[\s\S]*$/i, "");
    return stripped.trim();
  }
  let cut = quoteStart;
  // 日付ヘッダー行と引用本文の間に空行が挟まっていることがあるため、
  // 直前の1行だけでなく、空行をさかのぼって実際のヘッダー行を探す
  let headerIdx = cut - 1;
  while (headerIdx >= 0 && lines[headerIdx].trim() === "") headerIdx--;
  if (headerIdx >= 0) {
    const candidateLine = lines[headerIdx].trim();
    const looksLikeQuoteHeader = /\d{4}年\d{1,2}月\d{1,2}日|さんは書きました|^on\s.+wrote:?$/i.test(candidateLine);
    if (looksLikeQuoteHeader) cut = headerIdx;
  }
  return lines.slice(0, cut).join("\n").trim();
}

// &#8199; (10進) や &#x1F680; (16進) のようなHTML数値文字参照をデコードする。
// マーケティングメールがクリップ回避などの目的で埋め込む大量の不可視文字（figure space等）が
// 名前付きエンティティのデコードだけでは素通しになり、そのまま文字列として表示されてしまうため
export function decodeNumericEntity(codeStr: string, isHex: boolean): string {
  const cp = parseInt(codeStr, isHex ? 16 : 10);
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10FFFF) return "";
  try { return String.fromCodePoint(cp); } catch { return ""; }
}

// <style>…</style> のようなブロックを取り除く。閉じタグが無いと正規表現では文末まで何度も探し直すため、
// indexOf で前から1回なめる。閉じタグが見つからなければ、そこから後ろは触らない
export function removeTagBlocks(text: string, tag: string): string {
  const lower = text.toLowerCase();
  const open = `<${tag}`;
  const close = `</${tag}>`;
  let out = "";
  let pos = 0;
  while (pos < text.length) {
    const start = lower.indexOf(open, pos);
    if (start === -1) break;
    const end = lower.indexOf(close, start);
    if (end === -1) break;
    out += text.slice(pos, start);
    pos = end + close.length;
  }
  return out + text.slice(pos);
}

export function cleanseBody(text: string, isForward = false): string {
  if (!text) return "";
  // 長すぎる本文は整形せず、生のまま先頭だけを出す（整形の正規表現で Worker を固めないため）
  if (text.length > LIMITS.bodyChars) return text.slice(0, LIMITS.bodyChars) + TRUNCATED_NOTICE;
  let cleaned = removeTagBlocks(text, "style");
  cleaned = removeTagBlocks(cleaned, "script");
  cleaned = cleaned.replace(/<br\s*\/?>/gi, "\n");
  cleaned = cleaned.replace(/<\/p>|<\/div>|<\/tr>|<\/li>/gi, "\n");
  cleaned = cleaned.replace(/<[^>]+>/g, "");
  cleaned = cleaned.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&zwnj;/g, "").replace(/&shy;/g, "");
  cleaned = cleaned.replace(/&#(\d+);/g, (_, dec) => decodeNumericEntity(dec, false));
  cleaned = cleaned.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => decodeNumericEntity(hex, true));
  cleaned = stripLooseCssRules(cleaned);
  // 転送メールの本文は引用文ではなく転送された内容そのものなので、誤って切り捨てない
  if (!isForward) cleaned = stripQuotedReply(cleaned);
  // 各行をトリム → 空白行のみの行を空行に統一 → 連続する空行を1行に圧縮
  cleaned = cleaned.split("\n").map(l => l.trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return cleaned;
}

// 一覧取得・返信元の単体検索の両方で使う、メッセージ生データ→フロントエンド向け整形の共通処理
export function parseMessageDetail(message: GmailMessage) {
  const payload = message.payload;
  const headers = payload?.headers || [];

  const subject = decodeMimeHeader(getHeader(headers, "Subject")) || "(件名なし)";
  const from = decodeMimeHeader(getHeader(headers, "From"));
  // メルマガ等では実際の「To」ヘッダーが空・汎用的な値のことがあり、Gmail自身は
  // 実配送先を示す「Delivered-To」ヘッダーで表示を補っている。同様にフォールバックする
  const to = decodeMimeHeader(getHeader(headers, "To")) || decodeMimeHeader(getHeader(headers, "Delivered-To"));
  const cc = decodeMimeHeader(getHeader(headers, "Cc")) || undefined;
  const replyTo = decodeMimeHeader(getHeader(headers, "Reply-To")) || undefined;
  const date = getHeader(headers, "Date");
  const labelIds = message.labelIds || [];
  // Discord風の「返信先」チップ表示のため、Message-ID / In-Reply-To を保持しておく
  const messageIdHeader = getHeader(headers, "Message-ID") || undefined;
  const references = getHeader(headers, "References") || undefined;
  const rawBody = (payload ? getTextBody(payload) : "") || message.snippet || "";
  const rawHtmlForCheck = getHtmlBody(payload);
  // HTML側は引用が "> " ではなく <blockquote>/gmail_quote 等のタグで表現されるため、
  // 先に引用部分を取り除いた「自分の文章」だけを転送判定に使う。
  // そうしないと、転送メールへの返信（引用としてFwd内容がHTML側に残る）まで
  // 転送メール扱いされてしまう
  const htmlOwnContent = stripHtmlQuote(rawHtmlForCheck);
  const isForward = looksLikeForward(subject, rawBody) || looksLikeForward(subject, htmlOwnContent);
  // 転送メールはGmail側の都合でIn-Reply-Toが付与されていることがあるが、
  // 会話上の「返信」ではなく別内容の転送なので、re:mail側の返信チップは出さない
  const inReplyTo = isForward ? undefined : (getHeader(headers, "In-Reply-To") || undefined);
  let cleansedBody = cleanseBody(rawBody, isForward);
  // CSSの除去などで本文が空になってしまった場合は、Gmail側で生成されたスニペットに差し替える
  if (!cleansedBody.trim() && message.snippet) cleansedBody = cleanseBody(message.snippet, isForward);
  const htmlBodyForLinks = isForward ? rawHtmlForCheck.trim() : htmlOwnContent;
  const htmlLinks = htmlBodyForLinks ? extractHtmlLinks(htmlBodyForLinks) : [];

  const attachments = extractAttachments(payload, rawHtmlForCheck);
  const hasHtml = !!htmlBodyForLinks;
  return { id: message.id, threadId: message.threadId, subject, from, to, cc, replyTo, date, body: cleansedBody, snippet: message.snippet, labelIds, htmlLinks, attachments, messageIdHeader, references, inReplyTo, isForward, hasHtml };
}

```

### A.24 `app/lib/historySync.ts`

```ts
// Gmail の history API（前回からの変化だけを返す）で、画面のメール一覧を差分だけ更新するための純粋関数。
// これまでは約1分ごとに最新100通の詳細を全部取り直しており、Gmail API の利用上限をすぐに使い切っていた。
// history.list は1回2ユニットで、詳細を取り直すのは新しく届いたメールだけになる
import type { Email } from "../types/email";

type HistoryMessage = { id: string; threadId?: string; labelIds?: string[] };
export type GmailHistoryRecord = {
  id?: string;
  messagesAdded?: { message: HistoryMessage }[];
  messagesDeleted?: { message: HistoryMessage }[];
  labelsAdded?: { message: HistoryMessage; labelIds?: string[] }[];
  labelsRemoved?: { message: HistoryMessage; labelIds?: string[] }[];
};

export type HistorySummary = {
  added: string[]; // 新しく届いた（または作られた）メッセージ ID。詳細を取りにいく
  deleted: string[]; // 完全に削除されたメッセージ ID
  labels: Record<string, string[]>; // ラベルが変わったメッセージの、変わった後のラベル
};

// 変化の記録を古い順にたどり、最終的な状態にまとめる（追加された後に消されたものは、どちらにも入れない）
export function summarizeHistory(records: GmailHistoryRecord[]): HistorySummary {
  const added = new Set<string>();
  const deleted = new Set<string>();
  const labels: Record<string, string[]> = {};
  for (const r of records) {
    for (const a of r.messagesAdded || []) {
      if (!a.message?.id) continue;
      added.add(a.message.id);
      deleted.delete(a.message.id);
    }
    for (const d of r.messagesDeleted || []) {
      if (!d.message?.id) continue;
      if (added.has(d.message.id)) added.delete(d.message.id);
      else deleted.add(d.message.id);
      delete labels[d.message.id];
    }
    for (const l of [...(r.labelsAdded || []), ...(r.labelsRemoved || [])]) {
      if (!l.message?.id || !Array.isArray(l.message.labelIds)) continue;
      labels[l.message.id] = l.message.labelIds;
    }
  }
  // 新しく届いたメールは詳細を取り直すので、ラベルの変化は要らない
  for (const id of added) delete labels[id];
  return { added: Array.from(added), deleted: Array.from(deleted), labels };
}

export type BoxFlags = { inbox: boolean; archive: boolean; spam: boolean; trash: boolean; sent: boolean };

// そのメールが、いま画面で選んでいる場所（受信箱・アーカイブ・送信済・迷惑・ゴミ箱）に入るか。
// 一覧の取得（fetchEmails）が Gmail に投げている検索条件と同じ決まりにする
export function matchesBoxFlags(labelIds: string[] | undefined, flags: BoxFlags): boolean {
  const l = new Set(labelIds || []);
  // 下書きは画面に出さない（Gmail で書いている途中の下書きが、保存のたびに吹き出しとして出入りしないように）
  if (l.has("DRAFT")) return false;
  const spam = l.has("SPAM"), trash = l.has("TRASH"), inbox = l.has("INBOX"), sent = l.has("SENT");
  // 迷惑メール・ゴミ箱・送信済のどれも選んでいないときは、迷惑メールとゴミ箱を検索に含めていない
  const includeSpamTrash = flags.spam || flags.trash || flags.sent;
  if (!includeSpamTrash && (spam || trash)) return false;
  if (flags.archive) return flags.inbox || !inbox;
  return (flags.inbox && inbox) || (flags.sent && sent) || (flags.spam && spam) || (flags.trash && trash);
}

export type SyncResult = { messages: Email[]; labelUpdates: { id: string; labelIds: string[] }[]; deleted: string[] };

// 差分を画面のメール一覧に当てる。新しいメールは今の場所の条件に合うものだけ足し、
// 既にあるメールはラベルを差し替え、削除されたものは取り除く
export function applySyncResult(emails: Email[], result: SyncResult, flags: BoxFlags): Email[] {
  const deleted = new Set(result.deleted);
  const labelMap = new Map(result.labelUpdates.map((u) => [u.id, u.labelIds]));
  const map = new Map<string, Email>();
  for (const e of emails) {
    if (deleted.has(e.id)) continue;
    const labels = labelMap.get(e.id);
    map.set(e.id, labels ? { ...e, labelIds: labels } : e);
  }
  for (const m of result.messages) {
    if (deleted.has(m.id)) continue;
    if (map.has(m.id) || matchesBoxFlags(m.labelIds, flags)) map.set(m.id, m);
  }
  return Array.from(map.values());
}

// ラベルが変わったメールのうち、まだ画面に無く、変わった後のラベルが今の場所の条件に合うもの
// （ゴミ箱から戻した・アーカイブから受信箱に戻した など）。これらは詳細を取りにいって一覧に足す
export function idsToFetchForLabelChanges(knownIds: Set<string>, labelUpdates: { id: string; labelIds: string[] }[], flags: BoxFlags): string[] {
  return labelUpdates.filter((u) => !knownIds.has(u.id) && matchesBoxFlags(u.labelIds, flags)).map((u) => u.id);
}

```

### A.25 `app/lib/mailboxOps.ts`

```ts
// メールの移動・削除（ゴミ箱へ）で Gmail に付け外しするラベルと、送るメッセージ ID の整え方。
// サーバー（app/api/emails/route.ts）と画面（useMailApp.ts）の両方から使う

export type MoveDestination = "INBOX" | "ARCHIVE" | "SPAM" | "TRASH";

export type LabelChange = { addLabelIds: string[]; removeLabelIds: string[] };

// 純正 Gmail の「移動」と同じ付け外しにする。アーカイブは「受信箱から外す」だけで、付けるラベルは無い
// （Gmail にアーカイブというラベルは無い。以前は ARCHIVE を扱っておらず、何も変わらないまま画面だけ移って見えていた）
export function labelChangeFor(destination: unknown): LabelChange | null {
  switch (destination) {
    case "INBOX": return { addLabelIds: ["INBOX"], removeLabelIds: ["TRASH", "SPAM"] };
    case "ARCHIVE": return { addLabelIds: [], removeLabelIds: ["INBOX", "TRASH", "SPAM"] };
    case "SPAM": return { addLabelIds: ["SPAM"], removeLabelIds: ["INBOX", "TRASH"] };
    case "TRASH": return { addLabelIds: ["TRASH"], removeLabelIds: ["INBOX", "SPAM"] };
    default: return null;
  }
}

// 既読・未読にする。Gmail の既読は「UNREAD ラベルが無い」こと（純正 Gmail の既読・未読と同じ）
export function readLabelChange(read: boolean): LabelChange {
  return read ? { addLabelIds: [], removeLabelIds: ["UNREAD"] } : { addLabelIds: ["UNREAD"], removeLabelIds: [] };
}

// Gmail のメッセージ ID は英数字。送信直後の仮 ID（fake-）は Gmail に無いので外す。重複も外す
const GMAIL_ID = /^[A-Za-z0-9]{1,64}$/;
export function sanitizeMessageIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  const out = new Set<string>();
  for (const id of ids) {
    if (typeof id === "string" && GMAIL_ID.test(id)) out.add(id);
  }
  return Array.from(out);
}

// Gmail の batchModify は1回に1000件まで
export const BATCH_MODIFY_LIMIT = 1000;
export function chunkIds(ids: string[], size = BATCH_MODIFY_LIMIT): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

// どのアカウントのメールかで ID を分ける（連携アカウントのメールは、そのアカウントのトークンで動かす必要がある）。
// accountOf が空を返したものは fallbackAccount（ログイン中のメインアカウント）として扱う
export function groupIdsByAccount(ids: string[], accountOf: (id: string) => string | undefined, fallbackAccount: string): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const account = accountOf(id) || fallbackAccount;
    const list = groups.get(account);
    if (list) list.push(id); else groups.set(account, [id]);
  }
  return groups;
}

```

### A.26 `app/lib/filterMatch.ts`

```ts
// フィルターツール（作成/非表示/ピン留め/移動/削除）と検索バーで共有する、
// メールが自分の送信したものかどうかの判定・保存場所判定・条件マッチングロジック。
import type { Email } from "../types/email";

// 判定に使うフィールドだけを持つメール（テストや送信直後の仮オブジェクトでは一部が欠けている）
type MatchableEmail = Partial<Email>;

// From ヘッダーから実アドレス部分だけを厳密に取り出す（"表示名 <addr>" 形式ならaddr、
// なければヘッダー全体をそのままアドレスとみなす）。大文字小文字を無視して比較できるよう
// 小文字化・trimまで行う
function extractFromAddress(raw: string): string {
  const match = (raw || "").match(/<([^>]+)>/);
  return ((match ? match[1] : raw) || "").trim().toLowerCase();
}

// メールが自分の送信したものかどうかの判定。バックエンドが返す「生の」メールデータには
// isMe フィールドが元々存在せず、送信直後にローカルで作った表示用オブジェクトにだけ isMe:true を
// 付けている。そのオブジェクトが後から（60秒毎の自動更新や再取得で）生データに上書きされると
// isMe が失われるため、From が自分のアドレスと完全一致するかのフォールバックを必ず併用する。
// myEmailは単一アドレスでも、複数アドレス（メイン＋連携）の配列でも渡せる。
// 注意: 部分一致（.includes）で判定すると、例えば自分が a@gmail.com のとき
// ba@gmail.com からのメールを「自分の送信」と誤判定してしまうため、必ず完全一致で比較する
export function isMineEmail(e: MatchableEmail, myEmail: string | string[]): boolean {
  if (e.isMe) return true;
  const candidates = (Array.isArray(myEmail) ? myEmail : [myEmail]).filter(Boolean).map(a => a.trim().toLowerCase());
  if (candidates.length === 0) return false;
  const fromAddr = extractFromAddress(e.from || "");
  if (!fromAddr) return false;
  return candidates.includes(fromAddr);
}

export type FindBarBoxKey = "inbox" | "archive" | "sent" | "spam" | "trash";

// メッセージがどの場所（受信箱・アーカイブ等）に属するかを判定する
function getBoxKey(e: MatchableEmail): FindBarBoxKey {
  const isTrash = e.labelIds?.includes("TRASH");
  const isSpam = e.labelIds?.includes("SPAM");
  const isInbox = e.labelIds?.includes("INBOX");
  const isSent = e.labelIds?.includes("SENT") || e.isMe;
  return isSent ? "sent" : isTrash ? "trash" : isSpam ? "spam" : isInbox ? "inbox" : "archive";
}
export { getBoxKey as getFindBarBoxKey };

// FindBarBoxKey（小文字）⇔ Gmailラベル（大文字）の対応。フィルターツールのアクション（非表示/
// ピン留め/移動/削除）は実際のメール操作（ラベル書き換え等）がGmailラベル大文字キーを使うため必要
export const BOX_KEY_TO_LABEL: Record<FindBarBoxKey, string> = {
  inbox: "INBOX", archive: "ARCHIVE", sent: "SENT", spam: "SPAM", trash: "TRASH",
};

export type FilterAction = "hide" | "pin" | "move" | "delete" | "read" | "unread";

// フィルターツールの非グループアクションにおける場所ごとの対象外ルール。
// 既存の選択モード（CategorizedActionSelect）の isBoxRestricted と同じルールを、
// FindBarBoxKey（小文字）ベースで使えるようにしたもの
export function isActionBoxRestricted(action: FilterAction, box: FindBarBoxKey): boolean {
  if (action === "pin" || action === "hide") return box === "trash" || box === "spam";
  if (action === "delete") return box === "trash" || box === "sent";
  if (action === "move") return box === "sent";
  // 既読・未読にするは、どの場所のメールにも使える
  return false;
}

export type TextField = "recipientName" | "recipientAddress" | "subject" | "body";
export type DateDirection = "received" | "sent";
export type TextRule = {
  field: TextField;
  mode: "contains" | "not_contains";
  keyword: string;
};

// AND結合された1つの条件セット（方向・テキスト条件・期間・添付・返信・転送・形式）。
// FilterCriteria.conditionSets はこれの配列で、いずれか1つのセットに一致すればOK（OR結合）
export type ConditionSet = {
  // このセット全体を受信メールのみ/送信メールのみに絞り込む（未指定=問わない）。
  // テキスト条件のうち相手の名前/アドレスは、この値に応じてどちらのヘッダーを見るか決まる
  // （受信なら差出人、送信なら宛先。未指定＝問わないのときは相手＝自分でない方を見る）
  direction?: DateDirection;
  textRules?: TextRule[];
  dateRange?: { from?: string; to?: string };
  hasAttachment?: boolean;
  isReply?: boolean;
  isForward?: boolean;
  format?: "html" | "text";
  // 未読（true）か既読（false）か。未指定は問わない（Gmail の UNREAD ラベルで判断する）
  isUnread?: boolean;
};

export type FilterCriteria = {
  // OR結合される条件セットの配列。空/未指定は「内容条件なし＝保存場所条件だけで絞り込む」を意味する
  conditionSets?: ConditionSet[];
  boxes?: FindBarBoxKey[];
  // 対象アカウント（連携アカウントのメールアドレス）。未指定/空文字列＝アカウントを問わない。
  // グループ化のフィルターは受信専用のため、複数アカウントのメールをまたいで集約できる
  accountEmail?: string;
  // 後方互換用: conditionSets 導入前の旧バージョンで保存されたフラットな単一条件データ。
  // conditionSets が無いときだけ getConditionSets() 経由で読み込まれる
  textRules?: TextRule[];
  dateRange?: { from?: string; to?: string };
  hasAttachment?: boolean;
  isReply?: boolean;
  isForward?: boolean;
  format?: "html" | "text";
};

function isConditionSetEmpty(set: ConditionSet): boolean {
  return (
    !(set.textRules && set.textRules.length > 0) &&
    !set.dateRange &&
    set.hasAttachment === undefined &&
    set.isReply === undefined &&
    set.isForward === undefined &&
    set.format === undefined &&
    set.isUnread === undefined
  );
}

// FilterCriteria から、実際にOR評価すべき条件セットの配列を取り出す（新旧データ形式を吸収する）
export function getConditionSets(criteria: FilterCriteria): ConditionSet[] {
  if (criteria.conditionSets) return criteria.conditionSets;
  const legacy: ConditionSet = {
    textRules: criteria.textRules, dateRange: criteria.dateRange,
    hasAttachment: criteria.hasAttachment, isReply: criteria.isReply, isForward: criteria.isForward, format: criteria.format,
  };
  return isConditionSetEmpty(legacy) ? [] : [legacy];
}

// メッセージの「相手」（自分が送信したなら宛先、受信したなら差出人）の生ヘッダー文字列を返す。
// TextRule.direction が未指定の古いデータ向けの後方互換フォールバックにのみ使う
function getPartnerRaw(email: MatchableEmail, myEmail: string): string {
  return isMineEmail(email, myEmail) ? (email.to || "") : (email.from || "");
}

function extractName(raw: string): string {
  return raw.split("<")[0].replace(/"/g, "").trim() || raw.trim();
}

function extractAddress(raw: string): string {
  const match = raw.match(/<([^>]+)>/);
  return ((match ? match[1] : raw) || "").trim();
}

// <input type="date"> の "YYYY-MM-DD" 文字列を、閲覧者のローカルタイムゾーンでのその日の
// 開始/終了時刻として解釈する。new Date("YYYY-MM-DD") は日付のみの文字列をUTC 0時として
// パースする仕様のため、そのまま使うと日本時間などUTCより進んでいるタイムゾーンでは、
// 同じ「7月24日」のメールでも午前中に送受信されたものだけ前日UTC扱いになって
// 期間フィルターから漏れてしまう（同じ日の一部のメールだけ対象外になるバグの原因だった）
function parseLocalDayStart(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1, 0, 0, 0, 0);
}
function parseLocalDayEnd(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1, 23, 59, 59, 999);
}

function matchesTextRule(email: MatchableEmail, rule: TextRule, myEmail: string, direction: DateDirection | undefined): boolean {
  let target = "";
  if (rule.field === "recipientName" || rule.field === "recipientAddress") {
    const raw = direction ? (direction === "sent" ? (email.to || "") : (email.from || "")) : getPartnerRaw(email, myEmail);
    target = rule.field === "recipientName" ? extractName(raw) : extractAddress(raw);
  } else if (rule.field === "subject") target = email.subject || "";
  else target = email.body || "";

  // 保存データが壊れていて語が無い条件は、どのメールにも一致させない（画面全体を落とさないため）
  if (typeof rule?.keyword !== "string" || !rule.keyword) return false;
  const contains = target.toLowerCase().includes(rule.keyword.toLowerCase());
  return rule.mode === "not_contains" ? !contains : contains;
}

function matchesConditionSet(email: MatchableEmail, set: ConditionSet, myEmail: string): boolean {
  if (set.direction) {
    const isSent = isMineEmail(email, myEmail);
    if (set.direction === "received" && isSent) return false;
    if (set.direction === "sent" && !isSent) return false;
  }

  if (set.textRules && set.textRules.length > 0) {
    if (!set.textRules.every(rule => matchesTextRule(email, rule, myEmail, set.direction))) return false;
  }

  if (set.dateRange) {
    const { from, to } = set.dateRange;
    const emailDate = new Date(email.date ?? NaN);
    if (isNaN(emailDate.getTime())) return false; // 日時が壊れている/未解析のメールは期間条件付きでは対象外にする
    if (from && emailDate < parseLocalDayStart(from)) return false;
    if (to && emailDate > parseLocalDayEnd(to)) return false;
  }

  if (set.hasAttachment !== undefined) {
    const has = !!(email.attachments && email.attachments.length > 0);
    if (has !== set.hasAttachment) return false;
  }

  if (set.isReply !== undefined) {
    const isReply = !!(email.replyToId || email.inReplyTo);
    if (isReply !== set.isReply) return false;
  }

  if (set.isForward !== undefined) {
    if (!!email.isForward !== set.isForward) return false;
  }

  if (set.format !== undefined) {
    const isHtml = !!email.hasHtml;
    if (set.format === "html" && !isHtml) return false;
    if (set.format === "text" && isHtml) return false;
  }

  if (set.isUnread !== undefined) {
    const unread = !!email.labelIds?.includes("UNREAD");
    if (unread !== set.isUnread) return false;
  }

  return true;
}

export function messageMatchesFilter(email: MatchableEmail, criteria: FilterCriteria, myEmail: string): boolean {
  // 保存データが壊れたフィルターが1つあっても、ほかのメールやチャット一覧の表示は止めない（絶対ルール3）
  try {
    return messageMatchesFilterUnsafe(email, criteria, myEmail);
  } catch {
    return false;
  }
}

function messageMatchesFilterUnsafe(email: MatchableEmail, criteria: FilterCriteria, myEmail: string): boolean {
  // email.accountId が無い（accountId導入前のデータ・ローカルfake等）場合は myEmail 名義として扱う。
  // このメール自身が実際に属するアカウントを、以降の受信/送信（isMineEmail）判定にも使う。
  // myEmailを呼び出し元がメインアカウント固定で渡していても、連携アカウントのメールに対して
  // 正しく「自分＝そのメールの所属アカウント」で送受信判定できるようにするため
  const emailAccount = email.accountId || myEmail;
  if (criteria.accountEmail && emailAccount !== criteria.accountEmail) return false;

  if (criteria.boxes && criteria.boxes.length > 0) {
    if (!criteria.boxes.includes(getBoxKey(email))) return false;
  }

  const sets = getConditionSets(criteria);
  if (sets.length > 0) {
    if (!sets.some(set => matchesConditionSet(email, set, emailAccount))) return false;
  }

  return true;
}

// チャット一覧のタブ種別。フィルターツールで作成したグループ（isGroup && filterCriteria）は
// アドレスベースの通常グループとは別の「フィルター」タブに分類する
export type ChatListTab = "individual" | "group" | "filter";
export function chatConfigTab(cfg: { isGroup?: boolean; filterCriteria?: unknown } | null | undefined): ChatListTab {
  if (!cfg?.isGroup) return "individual";
  return cfg.filterCriteria ? "filter" : "group";
}

// FilterCriteria が実質的に何も条件を持っていないか（誤って全件マッチするのを防ぐガード用）
export function isEmptyFilterCriteria(criteria: FilterCriteria): boolean {
  return getConditionSets(criteria).length === 0 && !(criteria.boxes && criteria.boxes.length > 0) && !criteria.accountEmail;
}

```

### A.27 `app/lib/groupEmails.ts`

```ts
// useMailApp.ts の groupedEmails useMemo から抽出した、副作用のない純粋関数版。
// 「1アカウント分のメール配列 + そのアカウントのchatConfigs」を受け取り、ローカルなroomキー
// （相手の表示名やアドレス、group:xxxx など）でグルーピングしたものを返す。
// 複数アカウント分の結果をマージする場合は mergeAccountGroups を使う（そちらで
// encodeRoomKey による複合キー化を行う）。

import { ChatConfig } from "../types/mail";
import { Email } from "../types/email";
import { isMineEmail, messageMatchesFilter } from "./filterMatch";
import { LocalKey, RoomKeyStr, encodeRoomKey, decodeRoomKey, keysOf } from "./roomKey";

function parseAddressSet(toHeader: string): Set<string> {
  const set = new Set<string>();
  (toHeader || "").split(",").forEach(part => {
    const match = part.match(/<([^>]+)>/);
    const addr = ((match ? match[1] : part) || "").trim().toLowerCase();
    if (addr) set.add(addr);
  });
  return set;
}

function sameAddressSet(a: Set<string>, b: Set<string>): boolean {
  return a.size > 0 && a.size === b.size && [...a].every(addr => b.has(addr));
}

// グループのメンバーの実メールアドレス集合を求める。作成時に確定させて保存した値を正とし、
// （古い形式のグループ等で）保存が無い場合のみ、そのメンバーの個別チャットの受信メールから推定する
function resolveGroupMemberAddresses(cfg: ChatConfig, roomLookup: Record<string, Email[]>, myEmail: string): Set<string> {
  const members = cfg.groupMembers || [];
  const addresses = (cfg.groupMemberAddresses && cfg.groupMemberAddresses.length === members.length)
    ? cfg.groupMemberAddresses
    : members.map((m: string) => {
        const msgs = roomLookup[m];
        const partner = msgs?.find((e: Email) => !isMineEmail(e, myEmail));
        const raw = partner ? partner.from : "";
        const match = (raw || "").match(/<([^>]+)>/);
        const resolved = ((match ? match[1] : raw) || "").trim().toLowerCase();
        return resolved || m.trim().toLowerCase();
      });
  return new Set(addresses.map((a: string) => a.toLowerCase()).filter(Boolean));
}

// 1アカウント分のメールを、ローカルなroomキーでグルーピングする（既存のgroupedEmails useMemoと
// 完全に同じロジック）。返り値のキーはローカルキー（例: "田中太郎", "group:xxxx"）で、
// アカウントをまたいだ複合キー化は行わない（それは mergeAccountGroups の責務）
export function groupEmailsByRoom(
  emails: Email[],
  myAddress: string,
  chatConfigs: Record<LocalKey, ChatConfig>,
): Record<LocalKey, Email[]> {
  const groups: Record<string, Email[]> = {};
  const tempSentEmails: Email[] = [];
  emails.forEach((email) => {
    if (email.senderRoom) { if (!groups[email.senderRoom]) groups[email.senderRoom] = []; groups[email.senderRoom].push(email); return; }
    const isMe = isMineEmail(email, myAddress || "");
    if (!isMe) {
      const roomName = email.from.split("<")[0].replace(/"/g, "").trim() || "Unknown";
      if (!groups[roomName]) groups[roomName] = []; groups[roomName].push(email);
    } else { tempSentEmails.push(email); }
  });

  tempSentEmails.forEach((email) => {
    // 実行中メモリ上でも送信済みメールからINBOXを強制剥奪する
    if (email.labelIds?.includes("INBOX")) {
      email.labelIds = email.labelIds.filter((l: string) => l !== "INBOX");
    }
    const toClean = email.to ? email.to.toLowerCase() : "";
    let matchedRoom: string | null = null;
    for (const roomName of Object.keys(groups)) {
      const roomNameLower = roomName.toLowerCase();
      const partnerEmail = groups[roomName].find(e => !isMineEmail(e, myAddress || ""))?.from.toLowerCase() || "";
      const partnerAddr = (partnerEmail.match(/<([^>]+)>/) || [null, partnerEmail])[1]?.trim() || partnerEmail.trim();
      if ((roomNameLower && toClean.includes(roomNameLower)) || (partnerAddr && toClean.includes(partnerAddr))) { matchedRoom = roomName; break; }
    }
    if (matchedRoom) { groups[matchedRoom].push({ ...email, isMe: true }); }
    else {
      let newRoomName = "Unknown";
      if (email.to) {
        const toMatch = email.to.split(",")[0];
        newRoomName = toMatch.split("<")[0].replace(/"/g, "").trim() || toMatch.replace(/[<>]/g, "").trim();
        if (!newRoomName) newRoomName = "Unknown";
      }
      if (!groups[newRoomName]) groups[newRoomName] = []; groups[newRoomName].push({ ...email, isMe: true });
    }
  });

  // まだ返信がなく表示名が分からないうちは「アドレスそのもの」がルームキーになるが、
  // 後から返信が来ると差出人の表示名で別のルームが作られてしまい、同じ相手なのに
  // チャットが2つに分裂する（過去に送信しただけのやり取りが宛先アドレス名義のまま
  // 取り残される）。表示名ルームが実在する場合は、アドレス名義のルームをそちらへ
  // 統合する（グループのルームキーは対象外）
  const emailLikeRoom = (room: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(room.trim());
  const resolveRoomPartnerAddr = (room: string): string => {
    const msgs = groups[room];
    if (!msgs || msgs.length === 0) return "";
    const partner = msgs.find((e: Email) => !isMineEmail(e, myAddress || ""));
    const raw = partner ? partner.from : (msgs.find((e: Email) => e.to)?.to || "");
    const match = (raw || "").match(/<([^>]+)>/);
    return ((match ? match[1] : raw) || "").trim().toLowerCase();
  };
  Object.keys(groups).forEach(room => {
    if (!emailLikeRoom(room)) return;
    const addr = room.trim().toLowerCase();
    const displayRoom = Object.keys(groups).find(other =>
      other !== room && !emailLikeRoom(other) && !chatConfigs[other as LocalKey]?.isGroup && resolveRoomPartnerAddr(other) === addr
    );
    if (displayRoom) {
      const existingIds = new Set(groups[displayRoom].map((e: Email) => e.id));
      groups[room].forEach((e: Email) => { if (!existingIds.has(e.id)) { groups[displayRoom].push(e); existingIds.add(e.id); } });
      delete groups[room];
    }
  });

  // グループチャット: メンバーからの受信メールと、グループから送信したメールを集約する。
  // 送信メールの判定はDBに何も永続化せず、その都度「宛先セットがメンバー全員と完全一致するか」
  // だけで判定する（Gmail自身が持つToヘッダーの情報だけで完結するため、送信履歴が増えても
  // D1の容量やロード時間を圧迫しない）。一斉送信は1通のメールなので、各メンバー個別チャットにも
  // 同じメールを反映する。
  keysOf(chatConfigs).forEach(room => {
    const cfg = chatConfigs[room];
    if (!cfg?.isGroup) return;
    // フィルターツールで作成したグループは受信専用のため、このアカウント1件分の中だけで完結させず、
    // 全アカウント分のメールをまたいで集約できるようにする（applyFilterGroups の責務）。
    // ここでは何もしない（groups[room] を作らない）
    if (cfg.filterCriteria) return;
    const mode = cfg.groupMode || "normal";
    const members = cfg.groupMembers || [];
    const memberAddresses = resolveGroupMemberAddresses(cfg, groups, myAddress);

    // このグループから送信されたメール = 宛先セットがメンバー全員と完全一致する送信済みメール
    const sentViaGroup = emails.filter((e: Email) => isMineEmail(e, myAddress) && sameAddressSet(parseAddressSet(e.to || ""), memberAddresses));

    // 一斉送信したメールを各メンバーの個別チャットにも反映する
    sentViaGroup.forEach((sentMsg: Email) => {
      members.forEach((member: string) => {
        if (!groups[member]) groups[member] = [];
        if (!groups[member].some((e: Email) => e.id === sentMsg.id)) groups[member].push(sentMsg);
      });
    });

    if (mode === "outbound_only") {
      groups[room] = sentViaGroup;
      return;
    }

    const received = emails.filter((e: Email) => {
      if (isMineEmail(e, myAddress)) return false;
      const addrMatch = (e.from || "").match(/<([^>]+)>/);
      const addr = (addrMatch ? addrMatch[1] : e.from || "").trim().toLowerCase();
      return memberAddresses.has(addr);
    });

    if (mode === "inbound_only") {
      groups[room] = received;
    } else {
      const merged = [...received];
      const mergedIds = new Set(merged.map((e: Email) => e.id));
      sentViaGroup.forEach((e: Email) => { if (!mergedIds.has(e.id)) { merged.push(e); mergedIds.add(e.id); } });
      groups[room] = merged;
    }
  });

  Object.keys(groups).forEach(sender => groups[sender].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()));
  // groups の内部実装は素の文字列キーのまま（Phase3のロジックを一切変更しないため）。
  // 「このRecordのキーはこの関数のローカルroom空間に閉じている」という保証だけ、公開シグネチャで型として表す
  return groups as Record<LocalKey, Email[]>;
}

// 複数アカウント分の groupEmailsByRoom の結果を、1つのroomKey空間へマージする。
// 各アカウントの結果をそのアカウントの encodeRoomKey で複合キー化してから合体するため、
// 別アカウントに同姓同名の相手がいてもキーが異なり、衝突・混在しない
export function mergeAccountGroups(
  perAccountGroups: { accountEmail: string; groups: Record<LocalKey, Email[]> }[],
): Record<RoomKeyStr, Email[]> {
  const merged: Record<RoomKeyStr, Email[]> = {};
  perAccountGroups.forEach(({ accountEmail, groups }) => {
    (Object.keys(groups) as LocalKey[]).forEach(localKey => {
      merged[encodeRoomKey(accountEmail, localKey)] = groups[localKey];
    });
  });
  return merged;
}

// フィルターツールで作成したグループ（filterCriteria持ち）専用の集約。条件に一致すれば
// 送信済みメールも含まれる（通常のグループのような宛先セット一致は必要ない）。
// フィルターはアカウントごとのものなので、そのグループのアカウント（roomKey のアカウント）のメールだけを集める
// （ほかのアカウントのメールは混ぜない。通常のグループと同じ）。
// mergeAccountGroups 済みの複合キー空間に対して、chatConfigs・allEmails も複合キー/全アカウント分の
// ものをそのまま渡して呼ぶ（groupEmailsByRoom内では意図的にfilterCriteria持ちのroomを扱わない）
// ルームのアカウント（小文字）。複合キーでない古いキーは空にする（例外で一覧全体を止めないため）
function accountOfRoom(room: RoomKeyStr): string {
  try { return decodeRoomKey(room).accountEmail.toLowerCase(); } catch { return ""; }
}

export function applyFilterGroups(
  merged: Record<RoomKeyStr, Email[]>,
  chatConfigs: Record<RoomKeyStr, ChatConfig>,
  allEmails: Email[],
  myEmail: string,
): Record<RoomKeyStr, Email[]> {
  const next: Record<RoomKeyStr, Email[]> = { ...merged };

  keysOf(chatConfigs).forEach(room => {
    const cfg = chatConfigs[room];
    if (!cfg?.isGroup || !cfg.filterCriteria) return;
    const createdAtMs = cfg.filterCreatedAt ? new Date(cfg.filterCreatedAt).getTime() : 0;
    const roomAccount = accountOfRoom(room);
    next[room] = allEmails.filter((e: Email) => {
      // このメール自身が属するアカウント（未設定＝accountId導入前のデータ等はmyEmail名義とみなす）
      const emailAccount = e.accountId || myEmail;
      if (emailAccount.toLowerCase() !== roomAccount) return false;
      if (!messageMatchesFilter(e, cfg.filterCriteria!, emailAccount)) return false;
      if (cfg.filterIncludeExisting === false) {
        const t = new Date(e.date).getTime();
        if (!(t > createdAtMs)) return false;
      }
      return true;
    }).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  });

  // フィルターグループで「元のメッセージを非表示にする」がONの場合、一致したメッセージを
  // 同じアカウントのほかのルーム（元の個別チャット等）から動的に除外する。
  // chatConfigsやメールが変わるたびに毎回再計算されるため、OFFにすれば次の再計算で自動的に
  // 元のルームへ復元される
  keysOf(chatConfigs).forEach(room => {
    const cfg = chatConfigs[room];
    if (!cfg?.isGroup || !cfg.filterCriteria || !cfg.filterHideOriginal) return;
    const matchedIds = new Set((next[room] || []).map((e: Email) => e.id));
    if (matchedIds.size === 0) return;
    const roomAccount = accountOfRoom(room);
    keysOf(next).forEach(otherRoom => {
      if (otherRoom === room) return;
      if (accountOfRoom(otherRoom) !== roomAccount) return;
      next[otherRoom] = next[otherRoom].filter((e: Email) => !matchedIds.has(e.id));
    });
  });

  return next;
}

```