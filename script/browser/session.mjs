// テスト用の Google アカウントでログインした状態の Playwright のページを作る（リモート環境での確認用）。
// Google のログイン画面は自動では通れないので、環境変数のリフレッシュトークンから NextAuth の Cookie を作る。
//   1つ目: RE_MAIL_TEST_EMAIL   / RE_MAIL_TEST_REFRESH_TOKEN
//   2つ目: RE_MAIL_TEST_EMAIL_2 / RE_MAIL_TEST_REFRESH_TOKEN_2（送受信の確認の相手）
// トークンはユーザーが取って環境の設定に入れる。Cookie はメモリの中だけで使い、ファイルやログに書かない。
// アクセストークンは入れず期限切れにしておくので、最初の通信でサーバー（auth.ts）が Google から取り直す。
import fs from "node:fs";
import path from "node:path";
import { encode } from "@auth/core/jwt";

const COOKIE_NAME = "authjs.session-token"; // http://localhost のときの名前（https では __Secure- が付く）
const MAX_ACCOUNTS = 2;

function authSecret() {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  const file = path.resolve(".playwright/dev-auth-secret");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  throw new Error("AUTH_SECRET がありません。先に script/browser/dev.sh で開発サーバーを起動してください");
}

// n = 1 か 2。無ければ null
export function testAccount(n = 1) {
  if (!Number.isInteger(n) || n < 1 || n > MAX_ACCOUNTS) throw new Error(`アカウントは 1〜${MAX_ACCOUNTS} で指定してください`);
  const suffix = n === 1 ? "" : `_${n}`;
  const email = process.env[`RE_MAIL_TEST_EMAIL${suffix}`];
  const refreshToken = process.env[`RE_MAIL_TEST_REFRESH_TOKEN${suffix}`];
  return email && refreshToken ? { email: email.trim().toLowerCase(), refreshToken } : null;
}

function requireAccount(n) {
  const a = testAccount(n);
  if (!a) {
    const s = n === 1 ? "" : `_${n}`;
    throw new Error(`RE_MAIL_TEST_EMAIL${s} と RE_MAIL_TEST_REFRESH_TOKEN${s} がありません。ユーザーに取ってもらい、環境の設定に入れてもらってください`);
  }
  return a;
}

// 送ってよい宛先（設定されているテスト用アカウントだけ）
export function allowedRecipients() {
  const set = new Set();
  for (let n = 1; n <= MAX_ACCOUNTS; n++) { const a = testAccount(n); if (a) set.add(a.email); }
  return set;
}

// Playwright の BrowserContext に、n 番目のテスト用アカウントでログインした Cookie を入れる
export async function addLoginCookie(context, baseUrl, n = 1) {
  const { email, refreshToken } = requireAccount(n);
  const value = await encode({
    token: { email, sub: email, name: null, picture: null, expiresAt: 0, refreshToken },
    secret: authSecret(),
    salt: COOKIE_NAME,
    maxAge: 60 * 60,
  });
  await context.addCookies([{ name: COOKIE_NAME, value, url: new URL(baseUrl).origin, httpOnly: true, sameSite: "Lax" }]);
}

// ログインが通ったか（ページを開く前に呼ぶ。失敗するとページ側がすぐログアウトして理由が消えるため）
export async function loginState(context, baseUrl) {
  const res = await context.request.get(`${new URL(baseUrl).origin}/api/auth/session`);
  const session = res.ok() ? await res.json().catch(() => null) : null;
  if (!session?.user) return "失敗（セッションがありません）";
  if (session.error) return `失敗（${session.error}。トークンが切れたか、GOOGLE_CLIENT_ID がトークンを取ったものと違う）`;
  return "OK";
}

const EMAIL_RE = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}/g;
function addressesIn(v) {
  const list = Array.isArray(v) ? v : [v];
  return list.flatMap((x) => (typeof x === "string" ? x.slice(0, 20000).match(EMAIL_RE) || [] : [])).map((s) => s.toLowerCase());
}

// 安全装置：テスト用アカウント以外への送信を止める（/api/emails への action=send を見る）。止めたら blocked に積む
async function guardSend(page, blocked) {
  const allowed = allowedRecipients();
  await page.route("**/api/emails*", (route) => {
    const req = route.request();
    if (req.method() !== "POST") return route.fallback();
    let body;
    try { body = req.postDataJSON(); } catch { return route.fallback(); }
    if (!body || (body.action && body.action !== "send")) return route.fallback();
    const bad = [...addressesIn(body.to), ...addressesIn(body.cc), ...addressesIn(body.bcc)].filter((a) => !allowed.has(a));
    if (bad.length === 0) return route.fallback();
    blocked.push(`送信を止めました（テスト用アカウント以外の宛先 ${bad.length} 件）`);
    return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "BLOCKED_BY_TEST_GUARD" }) });
  });
}

// 確認用のページを作る。外部への通信は読まずに止めて記録し、テスト用アカウント以外への送信も止める。
// 返り値: { context, page, errors, external, blocked, login }
//   login: account を渡したときのログインの成否（"OK" か "失敗（…）"）
export async function openTestPage(browser, baseUrl, { account = null, mobile = false } = {}) {
  const context = await browser.newContext(
    mobile
      ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
      : { viewport: { width: 1280, height: 800 } },
  );
  let login = null;
  if (account) {
    await addLoginCookie(context, baseUrl, account);
    login = await loginState(context, baseUrl);
  }
  const page = await context.newPage();
  const origin = new URL(baseUrl).origin;
  const errors = [];
  const external = new Set();
  const blocked = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.route("**/*", (route) => {
    const u = route.request().url();
    if (u.startsWith(origin) || u.startsWith("data:") || u.startsWith("blob:")) return route.fallback();
    external.add(new URL(u).origin);
    return route.abort();
  });
  await guardSend(page, blocked); // 後に登録したものが先に動く
  return { context, page, errors, external, blocked, login };
}
