#!/usr/bin/env node
// テスト用アカウントの Gmail を API で直接読み、送受信の結果を確かめる（Re:Mail の画面を通さない照合用）。
// 使い方: node script/browser/gmail-inspect.mjs [--account=1|2] [--q=検索語] [--max=件数] [--body]
//   例: node script/browser/gmail-inspect.mjs --account=2 --q='subject:"[re-mail-test]" newer_than:1h'
// 出すもの: id・threadId・ラベル・ヘッダー（From/To/Cc/Bcc/Subject/Date/Message-ID/In-Reply-To/References/Content-Type）・
//           MIME の各部分（種類・ファイル名・文字コード・大きさ）。本文は --body のときだけ、各部分の先頭 2000 字まで。
// 読むだけで、送信・変更はしない。テスト用アカウント（環境変数）にしか使えない。
import { testAccount } from "./session.mjs";

const args = process.argv.slice(2);
const opt = (name, def) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : def; };
const accountNo = Number(opt("account", "1"));
const q = opt("q", "newer_than:1d");
const max = Math.min(Math.max(Number(opt("max", "5")) || 5, 1), 20);
const showBody = args.includes("--body");
const BODY_LIMIT = 2000;
const HEADERS = ["From", "To", "Cc", "Bcc", "Subject", "Date", "Message-ID", "In-Reply-To", "References", "Content-Type"];

const out = (s) => process.stdout.write(s + "\n");

async function accessToken(refreshToken) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID || "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  const t = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`トークンを取れませんでした（${t.error || res.status}）。docs/remote-browser-check.md の B で取り直してもらう`);
  return t.access_token;
}

function decodeB64Url(s) {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function walk(part, depth, lines) {
  if (depth > 20) return; // 壊れた・深すぎる MIME で止まらないように
  const h = Object.fromEntries((part.headers || []).map((x) => [x.name.toLowerCase(), x.value]));
  const ct = h["content-type"] || part.mimeType || "";
  const charset = (ct.match(/charset="?([^";]+)/i) || [])[1] || "";
  const size = part.body?.size ?? 0;
  const disp = (h["content-disposition"] || "").split(";")[0];
  lines.push(`${"  ".repeat(depth + 1)}- ${part.mimeType}${part.filename ? ` "${part.filename}"` : ""}${charset ? ` charset=${charset}` : ""}${disp ? ` ${disp}` : ""}${h["content-id"] ? ` cid=${h["content-id"]}` : ""} ${size}B`);
  if (showBody && part.body?.data && /^text\//.test(part.mimeType)) {
    const text = decodeB64Url(part.body.data).toString("utf8");
    lines.push(text.slice(0, BODY_LIMIT).replace(/^/gm, `${"  ".repeat(depth + 2)}| `) + (text.length > BODY_LIMIT ? "\n      …（省略）" : ""));
  }
  for (const p of (part.parts || []).slice(0, 100)) walk(p, depth + 1, lines);
}

(async () => {
  const acc = testAccount(accountNo);
  if (!acc) throw new Error(`テスト用アカウント ${accountNo} の環境変数がありません`);
  const token = await accessToken(acc.refreshToken);
  const api = async (p) => {
    const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${p}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`Gmail API ${r.status}`);
    return r.json();
  };
  const list = await api(`messages?maxResults=${max}&includeSpamTrash=true&q=${encodeURIComponent(q)}`);
  out(`account ${accountNo}: ${acc.email}  q=${q}  件数=${(list.messages || []).length}`);
  for (const m of list.messages || []) {
    const msg = await api(`messages/${m.id}?format=full`);
    const h = Object.fromEntries((msg.payload?.headers || []).map((x) => [x.name.toLowerCase(), x.value]));
    out(`\n== id=${msg.id} threadId=${msg.threadId} labels=${(msg.labelIds || []).join(",")}`);
    for (const name of HEADERS) if (h[name.toLowerCase()] !== undefined) out(`  ${name}: ${h[name.toLowerCase()]}`);
    const lines = [];
    walk(msg.payload, 0, lines);
    out("  MIME:\n" + lines.join("\n"));
  }
})().catch((e) => {
  process.stderr.write(`失敗: ${e.message}\n`);
  process.exit(1);
});
