// テスト用の Google アカウントでログインした状態（NextAuth のセッション Cookie）を作る。
// Google のログイン画面は自動では通れないので、環境変数のリフレッシュトークンから Cookie を作る：
//   RE_MAIL_TEST_EMAIL          … テスト用アカウントのアドレス
//   RE_MAIL_TEST_REFRESH_TOKEN  … そのアカウントのリフレッシュトークン（script/browser/get-refresh-token.mjs で手元の PC で取る）
// アクセストークンは入れず期限切れにしておくので、最初の通信でサーバー（auth.ts）が Google から取り直す。
// Cookie はメモリの中だけで使い、ファイルやログに書かない。
import fs from "node:fs";
import path from "node:path";
import { encode } from "@auth/core/jwt";

const COOKIE_NAME = "authjs.session-token"; // http://localhost のときの名前（https では __Secure- が付く）

function authSecret() {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  const file = path.resolve(".playwright/dev-auth-secret");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  throw new Error("AUTH_SECRET がありません。先に script/browser/dev.sh で開発サーバーを起動してください");
}

export function hasTestAccount() {
  return Boolean(process.env.RE_MAIL_TEST_EMAIL && process.env.RE_MAIL_TEST_REFRESH_TOKEN);
}

// Playwright の BrowserContext にログイン済みの Cookie を入れる
export async function addLoginCookie(context, baseUrl) {
  if (!hasTestAccount()) {
    throw new Error(
      "RE_MAIL_TEST_EMAIL と RE_MAIL_TEST_REFRESH_TOKEN がありません。docs/claude/browser.md の手順で環境の設定に入れてください",
    );
  }
  const email = process.env.RE_MAIL_TEST_EMAIL;
  const value = await encode({
    token: { email, sub: email, name: null, picture: null, expiresAt: 0, refreshToken: process.env.RE_MAIL_TEST_REFRESH_TOKEN },
    secret: authSecret(),
    salt: COOKIE_NAME,
    maxAge: 60 * 60,
  });
  await context.addCookies([{ name: COOKIE_NAME, value, url: new URL(baseUrl).origin, httpOnly: true, sameSite: "Lax" }]);
}
