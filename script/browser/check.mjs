#!/usr/bin/env node
// Playwright でページを開き、スクリーンショットとコンソールのエラーを出す（Claude Code のリモート環境での確認用）。
// 使い方: node script/browser/check.mjs [URL] [--mobile] [--login] [--wait=ミリ秒] [--out=ディレクトリ]
//   既定の URL は http://localhost:3000/ 、出力先は .playwright/（git 管理外）。
//   --login：テスト用アカウントでログインした状態で開く（session.mjs。環境変数の準備は docs/claude/browser.md）。
//   --wait：読み込みの後、スクリーンショットまで待つ時間（メールの一覧を待つときなど。既定 0）。
// 依存は足さない。Playwright はリモート環境に入っているもの（/opt/node-tools）を使う。
// 外部への通信は読まずに止め、一覧だけ出す（このアプリは外部に通信しない決まりなので、出たら違反の手がかり）。
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { addLoginCookie } from "./session.mjs";

// createRequire の解決は NODE_PATH を見るので、リモート環境の全体に入った playwright が見つかる
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  process.stderr.write("playwright が見つかりません。Claude Code のリモート環境で実行してください。\n");
  process.exit(1);
}

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith("--")) || "http://localhost:3000/";
const mobile = args.includes("--mobile");
const login = args.includes("--login");
const waitArg = args.find((a) => a.startsWith("--wait="));
const waitMs = Math.min(Number(waitArg ? waitArg.slice(7) : 0) || 0, 120000);
const outArg = args.find((a) => a.startsWith("--out="));
const outDir = path.resolve(outArg ? outArg.slice(6) : ".playwright");
const origin = new URL(url).origin;

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext(
    mobile
      ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
      : { viewport: { width: 1280, height: 800 } },
  );
  if (login) await addLoginCookie(context, url);
  // ログインが通ったかを、ページを開く前に確かめる（失敗するとページ側がすぐログアウトして理由が消えるため。トークンが切れていたら、ユーザーに取り直してもらう。手順は docs/remote-browser-check.md）
  let loginState = "";
  if (login) {
    const sessionRes = await context.request.get(`${origin}/api/auth/session`);
    const session = sessionRes.ok() ? await sessionRes.json().catch(() => null) : null;
    loginState = !session?.user
      ? "失敗（セッションがありません）"
      : session.error
        ? `失敗（${session.error}。トークンが切れたか、GOOGLE_CLIENT_ID がトークンを取ったものと違う）`
        : "OK";
  }
  const page = await context.newPage();
  const errors = [];
  const external = new Set();
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.route("**/*", (route) => {
    const u = route.request().url();
    if (u.startsWith(origin) || u.startsWith("data:") || u.startsWith("blob:")) return route.continue();
    external.add(new URL(u).origin);
    return route.abort();
  });
  const res = await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
  if (waitMs) await page.waitForTimeout(waitMs);
  const file = path.join(outDir, `${login ? "login-" : ""}${mobile ? "mobile" : "desktop"}.png`);
  await page.screenshot({ path: file, fullPage: true });
  process.stdout.write(
    [
      `status: ${res ? res.status() : "なし"}`,
      `final url: ${page.url()}`,
      `title: ${await page.title()}`,
      ...(login ? [`login: ${loginState}`] : []),
      `screenshot: ${file}`,
      `errors: ${errors.length ? "\n  " + errors.join("\n  ") : "なし"}`,
      `blocked external: ${external.size ? [...external].join(", ") : "なし"}`,
    ].join("\n") + "\n",
  );
  await browser.close();
  process.exit(errors.length ? 2 : 0);
})().catch((e) => {
  process.stderr.write(`失敗: ${e.message}\n`);
  process.exit(1);
});
