// 送信するメール（RFC 5322 / MIME）を組み立てる純粋関数。
// Gmail の upload エンドポイントにはメール本体をそのまま（base64 で包まずに）送るため、
// ここで作るメールは全体を 7bit の ASCII だけにする（日本語はヘッダーは RFC 2047、本文は base64）。

export type MimeAttachment = { filename: string; mimeType: string; data: string /* base64 */ };

export type MimeInput = {
  // 省略すると Gmail がアカウントの既定の送信元を入れる（純正と同じ）。エイリアスから送るときだけ指定する
  from?: string;
  // 送信元エイリアスに「返信先アドレス」が設定されているときに付ける（純正 Gmail と同じ）
  replyTo?: string;
  to: string;
  cc?: string;
  subject: string;
  text?: string;
  html?: string;
  attachments?: MimeAttachment[];
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

// 「"山田, 太郎" <a@example.com>, b@example.com」のような宛先の並びを1件ずつに分ける。
// 表示名の中のカンマで切らないよう、引用符と <> の中は区切りとみなさない
export function splitAddressList(list: string): string[] {
  const result: string[] = [];
  let cur = "";
  let inQuote = false;
  let inAngle = false;
  for (const ch of list) {
    if (ch === '"') inQuote = !inQuote;
    else if (ch === "<" && !inQuote) inAngle = true;
    else if (ch === ">" && !inQuote) inAngle = false;
    if ((ch === "," || ch === ";") && !inQuote && !inAngle) {
      if (cur.trim()) result.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) result.push(cur.trim());
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

export function buildMimeSegments(input: MimeInput): MimeSegment[] {
  const headers: string[] = [];
  // Date は付けない。純正 Gmail と同じ形式（送信者のタイムゾーン）で Gmail 側が付ける
  // 並びは純正 Gmail が送るメールと同じにする（MIME-Version → References → In-Reply-To → From → Date →
  // Message-ID → Subject → To → Cc）。Gmail は自分が付け直すヘッダーを並べ替えるが、それ以外はこの順のまま届くため
  headers.push("MIME-Version: 1.0");
  const inReplyTo = input.inReplyTo ? stripLineBreaks(input.inReplyTo).trim() : "";
  const references = input.references ? stripLineBreaks(input.references).trim() : inReplyTo;
  if (references) headers.push(`References: ${references}`);
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (input.from && input.from.trim()) headers.push(`From: ${formatAddressHeader(input.from)}`);
  if (input.date) headers.push(`Date: ${input.date.toUTCString().replace("GMT", "+0000")}`);
  if (input.messageId) headers.push(`Message-ID: ${stripLineBreaks(input.messageId).trim()}`);
  headers.push(`Subject: ${encodeHeaderText(input.subject || "")}`);
  headers.push(`To: ${formatAddressHeader(input.to || "")}`);
  if (input.cc && input.cc.trim()) headers.push(`Cc: ${formatAddressHeader(input.cc)}`);
  if (input.replyTo && input.replyTo.trim()) headers.push(`Reply-To: ${formatAddressHeader(input.replyTo)}`);

  const attachments = input.attachments || [];
  if (attachments.length === 0) {
    return [headers.join(CRLF) + CRLF, ...bodySegments(input.text, input.html)];
  }

  const b = newBoundary();
  const segments: MimeSegment[] = [
    headers.join(CRLF) + CRLF,
    `Content-Type: multipart/mixed; boundary="${b}"${CRLF}${CRLF}`,
    `--${b}${CRLF}`,
    ...bodySegments(input.text, input.html),
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

// 受信したヘッダーの encoded-word（=?UTF-8?B?...?= など）を日本語に戻す
export function decodeMimeHeader(header: string): string {
  if (!header) return "";
  const regex = /=\?([^?]+)\?([BQbq])\?([^?]+)\?=/g;
  // 長い件名は複数の encoded-word に分けて折り返されている。語と語の間の空白・改行は
  // 文字ではなく区切りなので取り除く（RFC 2047。残すと日本語の途中に空白が入る）
  return header.replace(/(\?=)\s+(?==\?)/g, "$1").replace(regex, (match, charset, encoding, text) => {
    try {
      if (encoding.toUpperCase() === 'B') {
        const binaryString = atob(text);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        return new TextDecoder(charset.toLowerCase() === 'shift_jis' ? 'shift_jis' : 'utf-8').decode(bytes);
      } else if (encoding.toUpperCase() === 'Q') {
        const qDecoded = text.replace(/_/g, ' ').replace(/=([a-fA-F0-9]{2})/g, (_: string, hex: string) => String.fromCharCode(parseInt(hex, 16)));
        const bytes = new Uint8Array(qDecoded.length);
        for (let i = 0; i < qDecoded.length; i++) {
          bytes[i] = qDecoded.charCodeAt(i);
        }
        return new TextDecoder(charset.toLowerCase() === 'shift_jis' ? 'shift_jis' : 'utf-8').decode(bytes);
      }
    } catch {
      return match;
    }
    return match;
  });
}
