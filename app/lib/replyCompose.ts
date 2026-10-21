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

// 日本語版 Gmail の引用の見出し「2026年1月1日(木) 10:00 山田 太郎 <a@example.com>:」
export function formatQuoteHeader(date: Date, from: string): string {
  const weekday = ["日", "月", "火", "水", "木", "金", "土"][date.getDay()];
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日(${weekday}) ${hh}:${mm} ${from}:`;
}

export type ReplyComposeInput = {
  text: string; // 利用者が書いた本文
  signatureHtml?: string; // sendAs の署名（無ければ付けない）
  quote?: { header: string; originalText: string; originalHtml?: string };
};

// テキスト版と HTML 版の本文を作る。並びは純正 Gmail と同じ「本文 → 署名（-- の後）→ 引用」
export function composeReplyBodies(input: ReplyComposeInput): { text: string; html: string } {
  const sig = (input.signatureHtml || "").trim();
  const sigText = sig ? signatureToText(sig) : "";

  let text = input.text;
  if (sigText) text += `\n\n-- \n${sigText}`;
  if (input.quote) {
    const quoted = input.quote.originalText.split(/\r?\n/).map(l => `> ${l}`).join("\n");
    text += `\n\n${input.quote.header}\n${quoted}`;
  }

  let html = `<div dir="ltr">${textToHtml(input.text)}`;
  if (sig) {
    html += `<br clear="all"><div><br></div><span class="gmail_signature_prefix">-- </span><br><div dir="ltr" class="gmail_signature" data-smartmail="gmail_signature">${sig}</div>`;
  }
  html += "</div>";
  if (input.quote) {
    const original = input.quote.originalHtml?.trim() ? input.quote.originalHtml : textToHtml(input.quote.originalText);
    html += `<br><div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">${escapeHtml(input.quote.header)}<br></div>`
      + `<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">${original}</blockquote></div>`;
  }
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
  signatureHtml?: string;
  original: { from: string; date: Date; subject: string; to: string; cc?: string; text: string; html?: string };
};

// 転送の本文を純正 Gmail と同じ並び（署名 → 「---------- Forwarded message ---------」の見出し → 元の本文）で作る。
// 見出しの文言は日本語版 Gmail でも英語のまま
export function composeForwardBodies(input: ForwardComposeInput): { text: string; html: string } {
  const o = input.original;
  const sig = (input.signatureHtml || "").trim();
  const headerLines = [
    "---------- Forwarded message ---------",
    `From: ${o.from}`,
    `Date: ${formatForwardDate(o.date)}`,
    `Subject: ${o.subject}`,
    `To: ${o.to}`,
    ...(o.cc ? [`Cc: ${o.cc}`] : []),
  ];

  let text = "";
  if (sig) text += `\n\n-- \n${signatureToText(sig)}`;
  text += `\n\n${headerLines.join("\n")}\n\n\n${o.text}`;

  let html = '<div dir="ltr">';
  if (sig) html += `<br clear="all"><div><br></div><span class="gmail_signature_prefix">-- </span><br><div dir="ltr" class="gmail_signature" data-smartmail="gmail_signature">${sig}</div>`;
  html += `<br><div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">${headerLines.map(escapeHtml).join("<br>")}<br></div><br><br>`;
  if (o.html && o.html.trim()) {
    const { inner, attrs } = extractHtmlBodyInner(o.html);
    html += `<div${attrs}>${inner}</div>`;
  } else {
    html += textToHtml(o.text);
  }
  html += "</div></div>";
  return { text, html };
}
