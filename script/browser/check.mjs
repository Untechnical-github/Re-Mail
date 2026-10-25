#!/usr/bin/env node
// Playwright でページを開き、スクリーンショットとコンソールのエラーを出す（Claude Code のリモート環境での確認用）。
// 使い方: node script/browser/check.mjs [URL] [--mobile] [--login[=2]] [--wait=ミリ秒] [--out=ディレクトリ]
//   既定の URL は http://localhost:3000/ 、出力先は .playwright/（git 管理外）。
//   --login：テスト用アカウント（1つ目）でログインした状態で開く。--login=2 で2つ目（docs/claude/browser.md）。
//   --wait：読み込みの後、スクリーンショットまで待つ時間（メールの一覧を待つときなど。既定 0、上限 120 秒）。
// 依存は足さない。Playwright はリモート環境に入っているもの（/opt/node-tools）を使う。
// 外部への通信は読まずに止め、一覧だけ出す（このアプリは外部に通信しない決まりなので、出たら違反の手がかり）。
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { openTestPage } from "./session.mjs";

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
const loginArg = args.find((a) => a === "--login" || a.startsWith("--login="));
const account = loginArg ? Number(loginArg.split("=")[1] || 1) : null;
const waitArg = args.find((a) => a.startsWith("--wait="));
const waitMs = Math.min(Number(waitArg ? waitArg.slice(7) : 0) || 0, 120000);
const outArg = args.find((a) => a.startsWith("--out="));
const outDir = path.resolve(outArg ? outArg.slice(6) : ".playwright");

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const { page, errors, external, blocked, login } = await openTestPage(browser, url, { account, mobile });
  const res = await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
  if (waitMs) await page.waitForTimeout(waitMs);
  const file = path.join(outDir, `${account ? `login${account}-` : ""}${mobile ? "mobile" : "desktop"}.png`);
  await page.screenshot({ path: file, fullPage: true });
  process.stdout.write(
    [
      `status: ${res ? res.status() : "なし"}`,
      `final url: ${page.url()}`,
      `title: ${await page.title()}`,
      ...(account ? [`login(${account}): ${login}`] : []),
      `screenshot: ${file}`,
      `errors: ${errors.length ? "\n  " + errors.join("\n  ") : "なし"}`,
      `blocked external: ${external.size ? [...external].join(", ") : "なし"}`,
      ...(blocked.length ? [`blocked send: ${blocked.join(" / ")}`] : []),
    ].join("\n") + "\n",
  );
  await browser.close();
  process.exit(errors.length || (login && login !== "OK") ? 2 : 0);
})().catch((e) => {
  process.stderr.write(`失敗: ${e.message}\n`);
  process.exit(1);
});
