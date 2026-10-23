// Gmail API のメッセージ（生データ）から、画面に出す本文・添付・リンクなどを取り出す処理。
// 長さや入れ子の深さが決まっていない入力を扱うので、どれも上限を設けて、超えたら処理を打ち切る（絶対ルール3）。
// Cloudflare Workers では処理中に時計が進まないため「○ミリ秒で打ち切る」はできない。代わりに、
// 後戻りが爆発する正規表現を使わず（indexOf で前から1回なめる）、入力の長さと数に上限を設ける
import { decodeMimeHeader, decodeBytes, charsetOf } from "./mime";

// Gmail API の生データ（必要なフィールドだけ）
export type GmailHeader = { name: string; value: string };
export type GmailMessagePart = {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailMessagePart[];
};
export type GmailMessage = { id: string; threadId: string; snippet?: string; labelIds?: string[]; payload?: GmailMessagePart };

// 入力の上限。超えた分は処理せず打ち切る（壊れたメールや悪意のあるメールで Worker や画面を固めないため）
export const LIMITS = {
  mimeDepth: 30, // MIME パートの入れ子の深さ
  mimeParts: 500, // 1通で見る MIME パートの数
  bodyChars: 300_000, // 整形する本文テキストの長さ。超えたら整形せずに生のまま（先頭だけ）出す
  cssRuleChars: 100_000, // 紛れ込んだ CSS を探す本文の長さ
  htmlChars: 2_000_000, // リンク抽出・転送判定にかける HTML の長さ
  links: 300, // 取り出すリンクの数
} as const;

export const TRUNCATED_NOTICE = "\n…(長文のため以下省略。全文は Gmail で確認してください)";

export function getHeader(headers: GmailHeader[], name: string): string {
  const header = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return header ? header.value : "";
}

// Gmail の body.data（base64url）を文字にする。Gmail API はテキストのパートを UTF-8 に直して返す
// （Content-Type の charset は元の Shift_JIS などのまま残る）ことを実機で確かめたので、まず UTF-8 として読む。
// UTF-8 として正しくないバイト列のときだけ、書かれている charset で読み直す
export function decodeBase64Url(base64Url: string, charset?: string) {
  try {
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const binString = atob(base64);
    const bytes = Uint8Array.from(binString, (m) => m.charCodeAt(0) & 0xff);
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      // ISO-2022-JP は ASCII だけでできているので UTF-8 としても正しく見える。
      // 漢字への切り替え（ESC $ B / ESC $ @）が入っていれば ISO-2022-JP として読む
      if (/\x1b\$[B@]/.test(text)) return decodeBytes(bytes, "iso-2022-jp");
      return text;
    } catch {
      return decodeBytes(bytes, charset);
    }
  } catch {
    return "";
  }
}

// パートの Content-Type ヘッダーにある charset
export function partCharset(part: GmailMessagePart): string | undefined {
  const ct = (part.headers || []).find((h) => h.name.toLowerCase() === "content-type")?.value;
  return charsetOf(ct);
}

// MIME の木を、深さとパート数の上限つきでたどる（深すぎる入れ子でスタックを使い切らないように）
export function walkParts(root: GmailMessagePart | undefined, visit: (part: GmailMessagePart) => void): void {
  let count = 0;
  const walk = (part: GmailMessagePart | undefined, depth: number) => {
    if (!part || depth > LIMITS.mimeDepth || count >= LIMITS.mimeParts) return;
    count++;
    visit(part);
    if (Array.isArray(part.parts)) for (const child of part.parts) walk(child, depth + 1);
  };
  walk(root, 0);
}

// テキスト本文。単一パートならその中身、複数パートなら木の順で最初の text/plain、無ければ最初の text/html
export function getTextBody(payload: GmailMessagePart): string {
  if (payload.body && payload.body.data) return decodeBase64Url(payload.body.data, partCharset(payload));
  // コールバックの中で代入すると型の絞り込みが効かないので、入れ物に入れて受け取る
  const found: { plain?: GmailMessagePart; html?: GmailMessagePart } = {};
  walkParts(payload, (part) => {
    if (part === payload || !part.body?.data) return;
    if (!found.plain && part.mimeType === "text/plain") found.plain = part;
    else if (!found.html && part.mimeType === "text/html") found.html = part;
  });
  const picked = found.plain || found.html;
  if (picked && picked.body?.data) return decodeBase64Url(picked.body.data, partCharset(picked));
  return "";
}

// S/MIME署名ファイル（smime.p7s など）は、メールの本文とは無関係な電子署名データで、
// Gmail自身も添付ファイルとして表示しない。銀行系のメールなどで必ず付与されることが多いため、
// re:mailでも同様に一覧から除外する
export function isSmimeSignaturePart(mimeType: string, filename: string): boolean {
  const mt = mimeType.toLowerCase();
  if (mt === 'application/pkcs7-signature' || mt === 'application/x-pkcs7-signature') return true;
  return /^smime\.p7[sm]$/i.test(filename.trim());
}

// 添付として並べるパート。
// html を渡したときは純正 Gmail と同じく、本文の HTML から cid: で参照されている画像は本文の中に出すので並べず、
// 参照されていないインラインのパート（Content-Disposition: inline）は添付として並べる（どこにも出ずに消えないように）。
// html を渡さないときは、これまでどおりインラインのパートを並べない
export function extractAttachments(payload: GmailMessagePart | undefined, html?: string): Array<{ filename: string; mimeType: string; size: number; attachmentId: string }> {
  const results: Array<{ filename: string; mimeType: string; size: number; attachmentId: string }> = [];
  walkParts(payload, (part) => {
    if (!part.body?.attachmentId) return;
    const headers = part.headers || [];
    const disp = headers.find((h) => h.name?.toLowerCase() === 'content-disposition')?.value?.toLowerCase() ?? '';
    const mimeType = part.mimeType || 'application/octet-stream';
    const contentId = (headers.find((h) => h.name?.toLowerCase() === 'content-id')?.value || '').trim().replace(/^<|>$/g, '');
    const name = part.filename?.trim() || '';
    if (isSmimeSignaturePart(mimeType, name)) return;
    if (html === undefined) {
      if (name && !disp.startsWith('inline')) results.push({ filename: name, mimeType, size: part.body.size || 0, attachmentId: part.body.attachmentId });
      return;
    }
    if (contentId && referencesContentId(html, contentId)) return;
    // 名前のない画像（iPhone のメールの本文中の写真など）も、消さずに添付として並べる
    const filename = name || (mimeType.startsWith('image/') && (disp.startsWith('inline') || contentId) ? `image.${mimeType.slice(6).replace(/[^a-z0-9]/gi, '') || 'img'}` : '');
    if (filename) results.push({ filename, mimeType, size: part.body.size || 0, attachmentId: part.body.attachmentId });
  });
  return results;
}

// Content-ID を持つパート（HTML 本文から cid: で参照される画像など）。転送で本文中の画像を引き継ぐために使う
export function extractContentIdParts(payload: GmailMessagePart | undefined): Array<{ filename: string; mimeType: string; size: number; attachmentId: string; contentId: string }> {
  const results: Array<{ filename: string; mimeType: string; size: number; attachmentId: string; contentId: string }> = [];
  walkParts(payload, (part) => {
    if (!part.body?.attachmentId) return;
    const raw = (part.headers || []).find((h) => h.name?.toLowerCase() === "content-id")?.value || "";
    const contentId = raw.trim().replace(/^<|>$/g, "");
    if (!contentId) return;
    results.push({ filename: part.filename || contentId, mimeType: part.mimeType || "application/octet-stream", size: part.body.size || 0, attachmentId: part.body.attachmentId, contentId });
  });
  return results;
}

// HTML が cid: でその画像を参照しているか（大文字小文字は区別しない。URL エンコードされた形も見る）
export function referencesContentId(html: string, contentId: string): boolean {
  const h = (html || "").toLowerCase();
  const id = contentId.toLowerCase();
  return h.includes(`cid:${id}`) || h.includes(`cid:${encodeURIComponent(id).toLowerCase()}`);
}

// HTML 本文の <a href="http..."> から「リンクの文字 → URL」を取り出す。
// 閉じタグの無い <a> が大量にあると正規表現では文末まで何度も探し直して固まるため、indexOf で前から1回なめる
export function extractHtmlLinks(html: string): Array<{text: string, href: string}> {
  const links: Array<{text: string, href: string}> = [];
  const seen = new Set<string>();
  const src = html.length > LIMITS.htmlChars ? html.slice(0, LIMITS.htmlChars) : html;
  const lower = src.toLowerCase();
  let pos = 0;
  while (links.length < LIMITS.links) {
    const open = lower.indexOf("<a", pos);
    if (open === -1) break;
    const next = lower.charAt(open + 2);
    if (next !== ">" && !/\s/.test(next)) { pos = open + 2; continue; }
    const tagEnd = lower.indexOf(">", open);
    if (tagEnd === -1) break;
    const close = lower.indexOf("</a>", tagEnd);
    if (close === -1) break;
    // タグ1つ分（長くても4000文字）だけを見るので、ここの正規表現は短い文字列にしかかからない
    const tag = src.slice(open, Math.min(tagEnd + 1, open + 4000));
    const hrefMatch = tag.match(/\bhref\s*=\s*["']?(https?:\/\/[^"'\s>]+)/i);
    if (hrefMatch) {
      const rawText = src.slice(tagEnd + 1, close).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      // テキストが空・長すぎ・そのままURLの場合はスキップ
      if (rawText && rawText.length <= 150 && !rawText.startsWith("http") && !seen.has(rawText)) {
        seen.add(rawText);
        links.push({ text: rawText, href: hrefMatch[1].trim() });
      }
    }
    pos = close + 4;
  }
  return links;
}

// multipart/related や multipart/alternative が何重にもネストしていても取りこぼさないよう、
// 木構造を最後まで走査してすべての text/html パートを集め、最も内容量の多いものを採用する
// （マーケティングメールなどで、装飾用の小さいhtml断片が本文より先に見つかってしまうのを防ぐ）
export function getHtmlBody(payload: GmailMessagePart | undefined): string {
  const candidates: string[] = [];
  walkParts(payload, (part) => {
    if (part.mimeType === "text/html" && part.body?.data) {
      const decoded = decodeBase64Url(part.body.data, partCharset(part));
      if (decoded) candidates.push(decoded);
    }
  });
  if (candidates.length === 0) return "";
  return candidates.reduce((longest, cur) => (cur.length > longest.length ? cur : longest));
}

// HTML版の返信引用ブロックを除去する。Gmailは "gmail_attr"（差出人/日時の一行）+
// "gmail_quote"（引用本文）というdivで、他クライアントは<blockquote>で末尾に引用を付与する。
// これらは常にメール本文の末尾に置かれるため、最初に見つかった開始位置から後ろを丸ごと切り落とす
export function stripHtmlQuote(html: string): string {
  if (!html) return html;
  const lower = html.toLowerCase();
  let cut = html.length;
  // class に gmail_attr / gmail_quote を持つ <div> の開始位置。正規表現でタグ全体を探すと、
  // 巨大なタグで後戻りが爆発するため、目印の語を indexOf で探してから、それを含むのが <div ...> かを確かめる
  for (const key of ["gmail_attr", "gmail_quote"]) {
    let from = 0;
    for (let tries = 0; tries < 1000; tries++) {
      const idx = lower.indexOf(key, from);
      if (idx === -1 || idx >= cut) break;
      const tagStart = lower.lastIndexOf("<", idx);
      const tagClose = tagStart === -1 ? -1 : lower.indexOf(">", tagStart);
      if (tagStart !== -1 && lower.startsWith("<div", tagStart) && tagClose > idx && idx - tagStart < 4000 && /\bclass\s*=/.test(lower.slice(tagStart, idx))) {
        cut = tagStart;
        break;
      }
      from = idx + key.length;
    }
  }
  const bq = lower.indexOf("<blockquote");
  if (bq !== -1 && bq < cut && /[\s>/]/.test(lower.charAt(bq + 11))) cut = bq;
  return html.slice(0, cut).trim();
}

// 件名が「Fwd:/Fw:」で始まる、または本文にGmail標準の転送マーカー（"---------- Forwarded
// message ---------"、日本語版Gmailでもこの部分は英語のまま）が引用符（"> "）なしで
// 含まれる場合は転送メールとみなす。「転送メールへの返信」だと、返信本文が引用した
// 転送内容の中にこのマーカーが "> " 付きで含まれてしまうため、引用行は対象から除外する
// （そうしないと、転送への返信自体が転送メール扱いされ、返信タグが消えたり
// 引用文除去がスキップされて元メッセージがそのまま表示され続けてしまう）
export function looksLikeForward(subject: string, bodyForCheck: string): boolean {
  if (/^\s*(fwd|fw)\s*:/i.test(subject || "")) return true;
  const src = (bodyForCheck || "").slice(0, LIMITS.htmlChars);
  const idx = src.toLowerCase().indexOf("forwarded message");
  if (idx === -1) return false;
  const lineStart = src.lastIndexOf("\n", idx) + 1;
  return !src.slice(lineStart, idx).trim().startsWith(">");
}

// 一部のメール（Yahoo!メールなど）は text/plain パートの生成が壊れており、
// <style>ブロックの中身（CSSの宣言）がタグなしでそのまま紛れ込んでいることがある。
// 通常の文章にはまず現れない「セレクタ { プロパティ: 値; ... }」という並びを検出して除去する
export function stripLooseCssRules(text: string): string {
  // 長すぎる本文や { を含まない本文では何もしない（見た目を整えるだけの処理なので、打ち切っても困らない）
  if (text.length > LIMITS.cssRuleChars || !text.includes("{")) return text;
  // { から次の { か } までしか進まないので、閉じていない { が大量にあっても全体で1回なめるだけで済む。
  // 中身が「プロパティ: 値;」の並び（2000文字以内）のときだけ消す
  return text.replace(/[^\n{}]{0,80}\{([^{}]{0,2000})\}/g, (m, inner: string) =>
    /^\s*(?:[\w-]+\s*:\s*[^;{}]+;\s*)+$/.test(inner) ? "" : m
  );
}

// 返信メールの末尾に自動付与される「引用元」ブロックを検出して取り除く。
// チャットUIでは代わりに「どのメッセージへの返信か」を専用のチップで表示するため、
// 本文側にこの定型引用文が残っていると二重表示・ノイズになる。
// メールクライアントごとに「YYYY年M月D日(曜) H:MM 差出人:」「On ... wrote:」
// 「差出人さんは書きました:」等、引用ヘッダーの文言はまちまちだが、引用本文自体は
// どのクライアントも共通して各行を "> " で始める（RFC的な慣習）ため、
// 特定の文言にマッチさせるのではなく、最初に現れる "> " 行を引用ブロックの開始とみなし、
// その直前の行が引用ヘッダーらしければ一緒に切り落とす、という汎用的な方式にする
export function stripQuotedReply(text: string): string {
  if (!text) return text;
  const lines = text.split("\n");
  let quoteStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^>/.test(lines[i].trim())) { quoteStart = i; break; }
  }
  if (quoteStart === -1) {
    // 引用元の本文が空などの理由で "> " 行自体が残っていない場合でも、
    // 日付ヘッダー行（「YYYY年M月D日(曜) H:MM 差出人:」）だけが末尾に取り残されることがあるため、
    // 定番の日英ヘッダー文言は保険として除去する
    let stripped = text.replace(/\n{0,2}\d{4}年\d{1,2}月\d{1,2}日\([日月火水木金土]\)\s*\d{1,2}:\d{2}\s+[^\n]*?:\s*[\s\S]*$/, "");
    stripped = stripped.replace(/\n{0,2}On\s.{0,150}?wrote:\s*[\s\S]*$/i, "");
    return stripped.trim();
  }
  let cut = quoteStart;
  // 日付ヘッダー行と引用本文の間に空行が挟まっていることがあるため、
  // 直前の1行だけでなく、空行をさかのぼって実際のヘッダー行を探す
  let headerIdx = cut - 1;
  while (headerIdx >= 0 && lines[headerIdx].trim() === "") headerIdx--;
  if (headerIdx >= 0) {
    const candidateLine = lines[headerIdx].trim();
    const looksLikeQuoteHeader = /\d{4}年\d{1,2}月\d{1,2}日|さんは書きました|^on\s.+wrote:?$/i.test(candidateLine);
    if (looksLikeQuoteHeader) cut = headerIdx;
  }
  return lines.slice(0, cut).join("\n").trim();
}

// &#8199; (10進) や &#x1F680; (16進) のようなHTML数値文字参照をデコードする。
// マーケティングメールがクリップ回避などの目的で埋め込む大量の不可視文字（figure space等）が
// 名前付きエンティティのデコードだけでは素通しになり、そのまま文字列として表示されてしまうため
export function decodeNumericEntity(codeStr: string, isHex: boolean): string {
  const cp = parseInt(codeStr, isHex ? 16 : 10);
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10FFFF) return "";
  try { return String.fromCodePoint(cp); } catch { return ""; }
}

// <style>…</style> のようなブロックを取り除く。閉じタグが無いと正規表現では文末まで何度も探し直すため、
// indexOf で前から1回なめる。閉じタグが見つからなければ、そこから後ろは触らない
export function removeTagBlocks(text: string, tag: string): string {
  const lower = text.toLowerCase();
  const open = `<${tag}`;
  const close = `</${tag}>`;
  let out = "";
  let pos = 0;
  while (pos < text.length) {
    const start = lower.indexOf(open, pos);
    if (start === -1) break;
    const end = lower.indexOf(close, start);
    if (end === -1) break;
    out += text.slice(pos, start);
    pos = end + close.length;
  }
  return out + text.slice(pos);
}

export function cleanseBody(text: string, isForward = false): string {
  if (!text) return "";
  // 長すぎる本文は整形せず、生のまま先頭だけを出す（整形の正規表現で Worker を固めないため）
  if (text.length > LIMITS.bodyChars) return text.slice(0, LIMITS.bodyChars) + TRUNCATED_NOTICE;
  let cleaned = removeTagBlocks(text, "style");
  cleaned = removeTagBlocks(cleaned, "script");
  cleaned = cleaned.replace(/<br\s*\/?>/gi, "\n");
  cleaned = cleaned.replace(/<\/p>|<\/div>|<\/tr>|<\/li>/gi, "\n");
  cleaned = cleaned.replace(/<[^>]+>/g, "");
  cleaned = cleaned.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&zwnj;/g, "").replace(/&shy;/g, "");
  cleaned = cleaned.replace(/&#(\d+);/g, (_, dec) => decodeNumericEntity(dec, false));
  cleaned = cleaned.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => decodeNumericEntity(hex, true));
  cleaned = stripLooseCssRules(cleaned);
  // 転送メールの本文は引用文ではなく転送された内容そのものなので、誤って切り捨てない
  if (!isForward) cleaned = stripQuotedReply(cleaned);
  // 各行をトリム → 空白行のみの行を空行に統一 → 連続する空行を1行に圧縮
  cleaned = cleaned.split("\n").map(l => l.trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return cleaned;
}

// 一覧取得・返信元の単体検索の両方で使う、メッセージ生データ→フロントエンド向け整形の共通処理
export function parseMessageDetail(message: GmailMessage) {
  const payload = message.payload;
  const headers = payload?.headers || [];

  const subject = decodeMimeHeader(getHeader(headers, "Subject")) || "(件名なし)";
  const from = decodeMimeHeader(getHeader(headers, "From"));
  // メルマガ等では実際の「To」ヘッダーが空・汎用的な値のことがあり、Gmail自身は
  // 実配送先を示す「Delivered-To」ヘッダーで表示を補っている。同様にフォールバックする
  const to = decodeMimeHeader(getHeader(headers, "To")) || decodeMimeHeader(getHeader(headers, "Delivered-To"));
  const cc = decodeMimeHeader(getHeader(headers, "Cc")) || undefined;
  const replyTo = decodeMimeHeader(getHeader(headers, "Reply-To")) || undefined;
  // Bcc は自分が送ったメール（送信済み）にだけ残る。受け取ったメールには無い
  const bcc = decodeMimeHeader(getHeader(headers, "Bcc")) || undefined;
  const date = getHeader(headers, "Date");
  const labelIds = message.labelIds || [];
  // Discord風の「返信先」チップ表示のため、Message-ID / In-Reply-To を保持しておく
  const messageIdHeader = getHeader(headers, "Message-ID") || undefined;
  const references = getHeader(headers, "References") || undefined;
  const rawBody = (payload ? getTextBody(payload) : "") || message.snippet || "";
  const rawHtmlForCheck = getHtmlBody(payload);
  // HTML側は引用が "> " ではなく <blockquote>/gmail_quote 等のタグで表現されるため、
  // 先に引用部分を取り除いた「自分の文章」だけを転送判定に使う。
  // そうしないと、転送メールへの返信（引用としてFwd内容がHTML側に残る）まで
  // 転送メール扱いされてしまう
  const htmlOwnContent = stripHtmlQuote(rawHtmlForCheck);
  const isForward = looksLikeForward(subject, rawBody) || looksLikeForward(subject, htmlOwnContent);
  // 転送メールはGmail側の都合でIn-Reply-Toが付与されていることがあるが、
  // 会話上の「返信」ではなく別内容の転送なので、re:mail側の返信チップは出さない
  const inReplyTo = isForward ? undefined : (getHeader(headers, "In-Reply-To") || undefined);
  let cleansedBody = cleanseBody(rawBody, isForward);
  // CSSの除去などで本文が空になってしまった場合は、Gmail側で生成されたスニペットに差し替える
  if (!cleansedBody.trim() && message.snippet) cleansedBody = cleanseBody(message.snippet, isForward);
  const htmlBodyForLinks = isForward ? rawHtmlForCheck.trim() : htmlOwnContent;
  const htmlLinks = htmlBodyForLinks ? extractHtmlLinks(htmlBodyForLinks) : [];

  const attachments = extractAttachments(payload, rawHtmlForCheck);
  const hasHtml = !!htmlBodyForLinks;
  return { id: message.id, threadId: message.threadId, subject, from, to, cc, bcc, replyTo, date, body: cleansedBody, snippet: message.snippet, labelIds, htmlLinks, attachments, messageIdHeader, references, inReplyTo, isForward, hasHtml };
}
