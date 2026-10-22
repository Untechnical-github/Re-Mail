// ページ全体に付けるセキュリティヘッダー（next.config.ts から使う）。
// - スクリプトは自分のサイトのものだけ（Next.js が埋め込む起動用のスクリプトがあるので 'unsafe-inline' は残す）。
//   外部のスクリプト・解析ツールは読み込ませない（絶対ルール1：外部への通信を増やさない）
// - 画像・CSS・フォントは https を許す。メール本文の iframe（srcdoc）はこのページの CSP も受け継ぐため、
//   「画像を表示」を押したときにメールの画像を出せるようにする。押す前は、iframe の中の CSP（app/lib/emailHtml.ts）が止める
// - Google のプロフィール画像（googleusercontent.com）も https なので、ここに含まれる
// - 添付のプレビュー（PDF・音声・動画）は data: / blob: の URL で出す
// - ほかのサイトの中に Re:Mail を埋め込ませない（クリックジャッキング対策）
// - ログインのとき Google のログイン画面へ移るので、form-action に accounts.google.com を入れる
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
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

export const SECURITY_HEADERS: { key: string; value: string }[] = [
  { key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
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
