// 送信するメール（RFC 5322 / MIME）を組み立てる純粋関数。
// Gmail の upload エンドポイントにはメール本体をそのまま（base64 で包まずに）送るため、
// ここで作るメールは全体を 7bit の ASCII だけにする（日本語はヘッダーは RFC 2047、本文は base64）。

export type MimeAttachment = { filename: string; mimeType: string; data: string /* base64 */ };
// HTML 本文から cid: で参照する画像（転送で元のメールの本文中の画像を引き継ぐときに使う）
export type MimeInlinePart = MimeAttachment & { contentId: string /* <> なし */ };

export type MimeInput = {
  // 省略すると Gmail がアカウントの既定の送信元を入れる（純正と同じ）。エイリアスから送るときだけ指定する
  from?: string;
  // 送信元エイリアスに「返信先アドレス」が設定されているときに付ける（純正 Gmail と同じ）
  replyTo?: string;
  to: string;
  cc?: string;
  // Bcc は raw に入れて messages.send に渡す。Gmail が受信者側のメールからは取り除き、自分の送信済みにだけ残す（純正と同じ）
  bcc?: string;
  subject: string;
  text?: string;
  html?: string;
  attachments?: MimeAttachment[];
  inline?: MimeInlinePart[];
  inReplyTo?: string;
  references?: string;
  messageId?: string;
  date?: Date;
};

// 文字列はそのまま、{ base64 } は 76 文字ごとに改行を入れて書き出す。
// 添付は数十MBになりうるので、巨大な文字列を作り直さずに1つのバッファへ直接書き込むための形
export type MimeSegment = string | { base64: string };

const CRLF = "\r\n";

// ヘッダーに入れる値から改行を除く（改行を入れられると別のヘッダーを差し込まれるため）
export function stripLineBreaks(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}

export function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  // 1バイトずつ連結すると大きな本文で極端に遅くなるため、チャンク単位で変換する
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

// RFC 2047 の encoded-word にする。1語は75文字以内が決まりなので、UTF-8で45バイト
// （base64で60文字）ごとに区切り、文字の途中では切らない。語と語は折り返し（CRLF+空白）でつなぐ
export function encodeHeaderText(value: string): string {
  const clean = stripLineBreaks(value);
  if (/^[\x20-\x7E]*$/.test(clean)) return clean;
  const encoder = new TextEncoder();
  const words: string[] = [];
  let chunk = "";
  let chunkBytes = 0;
  for (const ch of Array.from(clean)) {
    const n = encoder.encode(ch).length;
    if (chunkBytes + n > 45 && chunk) {
      words.push(`=?UTF-8?B?${utf8ToBase64(chunk)}?=`);
      chunk = "";
      chunkBytes = 0;
    }
    chunk += ch;
    chunkBytes += n;
  }
  if (chunk) words.push(`=?UTF-8?B?${utf8ToBase64(chunk)}?=`);
  return words.join(`${CRLF} `);
}

// 中身の無いグループ（「undisclosed-recipients:;」）の名前の部分。宛先ではないので数えない
const EMPTY_GROUP = /^[^"<>@:]*:$/;

// 「"山田, 太郎" <a@example.com>, b@example.com」のような宛先の並びを1件ずつに分ける。
// 表示名の中のカンマで切らないよう、引用符と <> の中は区切りとみなさない。
// 純正 Gmail は Bcc だけで送ると To を「undisclosed-recipients:;」にするので、中身の無いグループは飛ばす
export function splitAddressList(list: string): string[] {
  const result: string[] = [];
  let cur = "";
  let inQuote = false;
  let inAngle = false;
  const push = () => {
    const entry = cur.trim();
    if (entry && !EMPTY_GROUP.test(entry)) result.push(entry);
    cur = "";
  };
  for (const ch of list) {
    if (ch === '"') inQuote = !inQuote;
    else if (ch === "<" && !inQuote) inAngle = true;
    else if (ch === ">" && !inQuote) inAngle = false;
    if ((ch === "," || ch === ";") && !inQuote && !inAngle) {
      push();
      continue;
    }
    cur += ch;
  }
  push();
  return result;
}

// 1件の宛先を { name, address } に分ける。<> が無ければ全体をアドレスとみなす
export function parseAddress(entry: string): { name: string; address: string } {
  const m = entry.match(/^(.*?)<([^>]+)>\s*$/);
  if (m) {
    const name = m[1].trim().replace(/^"(.*)"$/, "$1").replace(/\\"/g, '"').trim();
    return { name, address: m[2].trim() };
  }
  return { name: "", address: entry.trim().replace(/^"(.*)"$/, "$1") };
}

// To/Cc ヘッダー用に整形する。日本語の表示名は encoded-word にし、
// 英数字でも記号（カンマなど）を含む表示名は引用符で囲む
export function formatAddressHeader(list: string): string {
  return splitAddressList(stripLineBreaks(list))
    .map(entry => {
      const { name, address } = parseAddress(entry);
      if (!name) return address;
      if (!/^[\x20-\x7E]*$/.test(name)) return `${encodeHeaderText(name)} <${address}>`;
      if (/^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~ ]*$/.test(name)) return `${name} <${address}>`;
      return `"${name.replace(/(["\\])/g, "\\$1")}" <${address}>`;
    })
    .join(`,${CRLF} `);
}

// 添付ファイル名。純正 Gmail と同じく name / filename に encoded-word を入れ、
// RFC 2231 の filename*（正式な UTF-8 指定）も併記する
function attachmentNameParams(filename: string): { typeParam: string; dispositionParam: string } {
  const clean = stripLineBreaks(filename || "attachment");
  const quoted = /^[\x20-\x7E]*$/.test(clean)
    ? clean.replace(/(["\\])/g, "\\$1")
    : `=?UTF-8?B?${utf8ToBase64(clean)}?=`;
  const star = encodeURIComponent(clean).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return {
    typeParam: `name="${quoted}"`,
    dispositionParam: `filename="${quoted}"; filename*=UTF-8''${star}`,
  };
}

// MIME タイプとして安全な文字だけ残す（ヘッダーを壊されないように）
function safeMimeType(mimeType: string): string {
  return /^[\w.+-]+\/[\w.+-]+$/.test(mimeType || "") ? mimeType : "application/octet-stream";
}

// base64 として正しい文字だけにする（改行などが混ざっていても MIME の境界を壊させない）
export function cleanBase64(data: string): string {
  return /^[A-Za-z0-9+/=]*$/.test(data) ? data : data.replace(/[^A-Za-z0-9+/=]/g, "");
}

function textPart(contentType: string, content: string): MimeSegment[] {
  return [
    `Content-Type: ${contentType}; charset="UTF-8"${CRLF}`,
    `Content-Transfer-Encoding: base64${CRLF}${CRLF}`,
    { base64: utf8ToBase64(content) },
    CRLF,
  ];
}

function newBoundary(): string {
  return `remail_${crypto.randomUUID().replace(/-/g, "")}`;
}

// 本文部分（テキストのみ／HTMLのみ／両方なら multipart/alternative）
function bodySegments(text: string | undefined, html: string | undefined): MimeSegment[] {
  if (html && text) {
    const b = newBoundary();
    return [
      `Content-Type: multipart/alternative; boundary="${b}"${CRLF}${CRLF}`,
      `--${b}${CRLF}`, ...textPart("text/plain", text),
      `--${b}${CRLF}`, ...textPart("text/html", html),
      `--${b}--${CRLF}`,
    ];
  }
  if (html) return textPart("text/html", html);
  return textPart("text/plain", text || "");
}

// Content-ID として安全な文字だけにする（ヘッダーを壊されないように）
function safeContentId(id: string): string {
  return stripLineBreaks(id).replace(/^<|>$/g, "").replace(/[^\w.@+-]/g, "");
}

// 本文と、本文から参照されるインライン画像（multipart/related）。純正 Gmail が本文中に画像のあるメールを送るときと同じ形
function bodyWithInlineSegments(text: string | undefined, html: string | undefined, inline: MimeInlinePart[]): MimeSegment[] {
  if (inline.length === 0 || !html) return bodySegments(text, html);
  const b = newBoundary();
  const segments: MimeSegment[] = [
    `Content-Type: multipart/related; boundary="${b}"${CRLF}${CRLF}`,
    `--${b}${CRLF}`,
    ...bodySegments(text, html),
  ];
  for (const part of inline) {
    const { typeParam, dispositionParam } = attachmentNameParams(part.filename);
    const cid = safeContentId(part.contentId);
    segments.push(
      `--${b}${CRLF}`,
      `Content-Type: ${safeMimeType(part.mimeType)}; ${typeParam}${CRLF}`,
      `Content-Disposition: inline; ${dispositionParam}${CRLF}`,
      `Content-Transfer-Encoding: base64${CRLF}`,
      `Content-ID: <${cid}>${CRLF}`,
      `X-Attachment-Id: ${cid}${CRLF}${CRLF}`,
      { base64: cleanBase64(part.data || "") },
      CRLF,
    );
  }
  segments.push(`--${b}--${CRLF}`);
  return segments;
}

export function buildMimeSegments(input: MimeInput): MimeSegment[] {
  const headers: string[] = [];
  // Date は付けない。純正 Gmail と同じ形式（送信者のタイムゾーン）で Gmail 側が付ける
  // 並びは純正 Gmail が送るメールと同じにする（MIME-Version → References → In-Reply-To → From → Date →
  // Message-ID → Subject → To → Cc → Bcc）。Gmail は自分が付け直すヘッダーを並べ替えるが、それ以外はこの順のまま届くため
  headers.push("MIME-Version: 1.0");
  const inReplyTo = input.inReplyTo ? stripLineBreaks(input.inReplyTo).trim() : "";
  const references = input.references ? stripLineBreaks(input.references).trim() : inReplyTo;
  if (references) headers.push(`References: ${references}`);
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (input.from && input.from.trim()) headers.push(`From: ${formatAddressHeader(input.from)}`);
  if (input.date) headers.push(`Date: ${input.date.toUTCString().replace("GMT", "+0000")}`);
  if (input.messageId) headers.push(`Message-ID: ${stripLineBreaks(input.messageId).trim()}`);
  headers.push(`Subject: ${encodeHeaderText(input.subject || "")}`);
  // Bcc だけで送るときは To を付けない。受け取った側のメールには、純正と同じく Gmail が「To: undisclosed-recipients:;」を付ける。
  // こちらで「undisclosed-recipients:;」を入れると、Gmail API が 400（invalidArgument）で送信を断る（実機で確かめた）
  if (input.to && input.to.trim()) headers.push(`To: ${formatAddressHeader(input.to)}`);
  if (input.cc && input.cc.trim()) headers.push(`Cc: ${formatAddressHeader(input.cc)}`);
  if (input.bcc && input.bcc.trim()) headers.push(`Bcc: ${formatAddressHeader(input.bcc)}`);
  if (input.replyTo && input.replyTo.trim()) headers.push(`Reply-To: ${formatAddressHeader(input.replyTo)}`);

  const attachments = input.attachments || [];
  const inline = input.inline || [];
  if (attachments.length === 0) {
    return [headers.join(CRLF) + CRLF, ...bodyWithInlineSegments(input.text, input.html, inline)];
  }

  const b = newBoundary();
  const segments: MimeSegment[] = [
    headers.join(CRLF) + CRLF,
    `Content-Type: multipart/mixed; boundary="${b}"${CRLF}${CRLF}`,
    `--${b}${CRLF}`,
    ...bodyWithInlineSegments(input.text, input.html, inline),
  ];
  for (const att of attachments) {
    const { typeParam, dispositionParam } = attachmentNameParams(att.filename);
    segments.push(
      `--${b}${CRLF}`,
      `Content-Type: ${safeMimeType(att.mimeType)}; ${typeParam}${CRLF}`,
      `Content-Disposition: attachment; ${dispositionParam}${CRLF}`,
      `Content-Transfer-Encoding: base64${CRLF}${CRLF}`,
      { base64: cleanBase64(att.data || "") },
      CRLF,
    );
  }
  segments.push(`--${b}--${CRLF}`);
  return segments;
}

const LINE = 76;

function segmentLength(seg: MimeSegment): number {
  if (typeof seg === "string") return new TextEncoder().encode(seg).length;
  const len = seg.base64.length;
  return len + Math.ceil(len / LINE) * 2 - (len > 0 ? 2 : 0);
}

// セグメントを1つのバイト列にする。添付の base64 は巨大になりうるので、
// 改行入りの文字列を作り直さずに1文字ずつバッファへ書き込む（メモリを倍に使わないため）
export function assembleBytes(segments: MimeSegment[]): Uint8Array<ArrayBuffer> {
  const total = segments.reduce((sum, s) => sum + segmentLength(s), 0);
  const buf = new Uint8Array(total);
  const encoder = new TextEncoder();
  let off = 0;
  for (const seg of segments) {
    if (typeof seg === "string") {
      off += encoder.encodeInto(seg, buf.subarray(off)).written;
      continue;
    }
    const s = seg.base64;
    for (let i = 0; i < s.length; i++) {
      if (i > 0 && i % LINE === 0) { buf[off++] = 13; buf[off++] = 10; }
      buf[off++] = s.charCodeAt(i);
    }
  }
  return buf;
}

// Gmail の upload エンドポイント（uploadType=multipart）に送る本体。
// 1つ目のパートがメタデータ（threadId）、2つ目がメール本体そのもの
export function buildGmailUploadBody(message: MimeSegment[], threadId?: string): { body: Uint8Array<ArrayBuffer>; contentType: string } {
  const b = newBoundary();
  const metadata = JSON.stringify(threadId ? { threadId } : {});
  const segments: MimeSegment[] = [
    `--${b}${CRLF}Content-Type: application/json; charset=UTF-8${CRLF}${CRLF}${metadata}${CRLF}`,
    `--${b}${CRLF}Content-Type: message/rfc822${CRLF}${CRLF}`,
    ...message,
    `${CRLF}--${b}--${CRLF}`,
  ];
  return { body: assembleBytes(segments), contentType: `multipart/related; boundary=${b}` };
}

// メールの charset 名を、TextDecoder が受け付ける名前にそろえる。日本語のメールで使われる別名
// （cp932 など）は Workers の TextDecoder が知らないので、同じ文字の集まりの名前に置き換える
const CHARSET_ALIASES: Record<string, string> = {
  "cp932": "shift_jis", "ms932": "shift_jis", "windows-31j": "shift_jis", "x-sjis": "shift_jis", "sjis": "shift_jis", "shift-jis": "shift_jis", "x-ms-cp932": "shift_jis",
  "x-euc-jp": "euc-jp", "eucjp": "euc-jp",
  "iso-2022-jp-ms": "iso-2022-jp", "iso-2022-jp-1": "iso-2022-jp", "iso-2022-jp-2": "iso-2022-jp", "csiso2022jp": "iso-2022-jp",
  "utf8": "utf-8", "us-ascii": "utf-8", "ascii": "utf-8",
};

export function normalizeCharset(charset: string | undefined): string {
  const c = (charset || "").trim().replace(/^"|"$/g, "").toLowerCase();
  if (!c) return "utf-8";
  return CHARSET_ALIASES[c] || c;
}

// バイト列を指定の charset で文字にする。知らない charset なら UTF-8 として読む（壊れた入力でも例外にしない）
export function decodeBytes(bytes: Uint8Array, charset: string | undefined): string {
  try {
    return new TextDecoder(normalizeCharset(charset)).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

// Content-Type の値から charset を取り出す（無ければ undefined）
export function charsetOf(contentType: string | undefined): string | undefined {
  const m = (contentType || "").match(/charset\s*=\s*"?([^";\s]+)"?/i);
  return m ? m[1] : undefined;
}

function binaryToBytes(bin: string): Uint8Array {
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 0xff;
  return bytes;
}

// 受信したヘッダーの encoded-word（=?UTF-8?B?...?= / =?ISO-2022-JP?B?...?= など）を日本語に戻す。
// 長い件名は複数の語に分けて折り返されていて、送り手によっては1文字の途中で語が切れていることがあるため、
// 続いている同じ charset の語はバイト列をつなげてから1回で文字にする
export function decodeMimeHeader(header: string): string {
  if (!header) return "";
  // 語と語の間の空白・改行は文字ではなく区切りなので取り除く（RFC 2047）
  const src = header.replace(/(\?=)\s+(?==\?)/g, "$1");
  const re = /=\?([^?]+)\?([BQbq])\?([^?]*)\?=/g;
  let out = "";
  let last = 0;
  let pending: { charset: string; parts: Uint8Array[] } | null = null;
  const flush = () => {
    if (!pending) return;
    const total = pending.parts.reduce((n, b) => n + b.length, 0);
    const all = new Uint8Array(total);
    let off = 0;
    for (const b of pending.parts) { all.set(b, off); off += b.length; }
    out += decodeBytes(all, pending.charset);
    pending = null;
  };
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const [whole, rawCharset, encoding, text] = m;
    // 「charset*言語」の形（RFC 2231）は言語の部分を捨てる
    const charset = normalizeCharset(rawCharset.split("*")[0]);
    let bytes: Uint8Array;
    try {
      bytes = encoding.toUpperCase() === "B"
        ? binaryToBytes(atob(text))
        : binaryToBytes(text.replace(/_/g, " ").replace(/=([a-fA-F0-9]{2})/g, (_: string, hex: string) => String.fromCharCode(parseInt(hex, 16))));
    } catch {
      // 壊れた語はそのまま残す
      flush();
      out += src.slice(last, m.index) + whole;
      last = m.index + whole.length;
      continue;
    }
    if (m.index !== last) { flush(); out += src.slice(last, m.index); }
    if (pending && pending.charset !== charset) flush();
    if (!pending) pending = { charset, parts: [] };
    pending.parts.push(bytes);
    last = m.index + whole.length;
  }
  flush();
  return out + src.slice(last);
}
