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
