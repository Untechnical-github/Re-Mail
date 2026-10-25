#!/usr/bin/env node
// Playwright でページを開き、スクリーンショットとコンソールのエラーを出す（Claude Code のリモート環境での確認用）。
// 使い方: node script/browser/check.mjs [URL] [--mobile] [--out=ディレクトリ]
//   既定の URL は http://localhost:3000/ 、出力先は .playwright/（git 管理外）。
// 依存は足さない。Playwright はリモート環境に入っているもの（/opt/node-tools）を使う。
// 外部への通信は読まずに止め、一覧だけ出す（このアプリは外部に通信しない決まりなので、出たら違反の手がかり）。
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";

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
  const file = path.join(outDir, `${mobile ? "mobile" : "desktop"}.png`);
  await page.screenshot({ path: file, fullPage: true });
  process.stdout.write(
    [
      `status: ${res ? res.status() : "なし"}`,
      `final url: ${page.url()}`,
      `title: ${await page.title()}`,
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
