#!/usr/bin/env node
// 【手元の PC で、本人が実行する】リモート環境の確認用に、テスト用 Google アカウントのリフレッシュトークンを取る。
// 使い方: node script/browser/get-refresh-token.mjs   （ローカルの next dev は止めておく。ポート 3000 を使う）
// - GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET は環境変数か .dev.vars から読む（ローカル開発と同じ OAuth クライアント）。
// - 戻り先はローカル開発と同じ http://localhost:3000/api/auth/callback/google なので、Google Cloud の設定は変えなくてよい。
// - スコープはアプリと同じ（app/lib/googleScopes.ts）。増やさない。
// - 結果は画面に出すだけで、ファイルには書かない。Claude に貼らず、リモート環境の設定（環境変数）に入れる。
import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";

const PORT = 3000;
const REDIRECT_URI = `http://localhost:${PORT}/api/auth/callback/google`;

function readDevVars() {
  const out = {};
  if (!fs.existsSync(".dev.vars")) return out;
  for (const line of fs.readFileSync(".dev.vars", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}
const vars = readDevVars();
const clientId = process.env.GOOGLE_CLIENT_ID || vars.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET || vars.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  process.stderr.write("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET が見つかりません（環境変数か .dev.vars に入れてください）\n");
  process.exit(1);
}
const scopeMatch = fs.readFileSync("app/lib/googleScopes.ts", "utf8").match(/GOOGLE_OAUTH_SCOPE\s*=\s*"([^"]+)"/);
if (!scopeMatch) {
  process.stderr.write("app/lib/googleScopes.ts からスコープを読めませんでした\n");
  process.exit(1);
}
const state = crypto.randomBytes(16).toString("hex");
const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: scopeMatch[1],
    access_type: "offline",
    prompt: "consent select_account",
    state,
  });

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url || "/", REDIRECT_URI);
  if (u.pathname !== "/api/auth/callback/google") { res.writeHead(404).end(); return; }
  const finish = (msg, code = 0) => {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end(msg);
    server.close();
    process.exitCode = code;
  };
  if (u.searchParams.get("state") !== state) return finish("state が一致しません。もう一度実行してください", 1);
  const code = u.searchParams.get("code");
  if (!code) return finish(`取得できませんでした: ${u.searchParams.get("error") || "不明"}`, 1);
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: REDIRECT_URI, grant_type: "authorization_code" }),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok || !tokens.refresh_token) return finish(`取得できませんでした: ${tokens.error || "リフレッシュトークンが返りませんでした"}`, 1);
    const profileRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const profile = await profileRes.json();
    process.stdout.write(
      [
        "",
        "取得できました。リモート環境の設定（環境変数）に次の2つを入れてください。Claude との会話には貼らないでください。",
        `RE_MAIL_TEST_EMAIL=${profile.emailAddress || "(取得できず。ログインしたアドレスを入れる)"}`,
        `RE_MAIL_TEST_REFRESH_TOKEN=${tokens.refresh_token}`,
        "",
      ].join("\n"),
    );
    finish("取得できました。ターミナルに戻ってください。このタブは閉じてかまいません。");
  } catch (e) {
    finish(`取得できませんでした: ${e instanceof Error ? e.message : String(e)}`, 1);
  }
});
server.on("error", (e) => {
  process.stderr.write(`ポート ${PORT} を使えません（ローカルの next dev を止めてください）: ${e.message}\n`);
  process.exit(1);
});
server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`ブラウザで次の URL を開き、テスト用のアカウントでログインしてください:\n${authUrl}\n`);
});
