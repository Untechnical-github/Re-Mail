import { NextResponse } from "next/server";
import { auth } from "../../../auth"; 

export const runtime = 'edge';

function getHeader(headers: any[], name: string): string {
  const header = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return header ? header.value : "";
}

function decodeBase64Url(base64Url: string) {
  try {
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const binString = atob(base64);
    const bytes = Uint8Array.from(binString, (m) => m.codePointAt(0)!);
    return new TextDecoder().decode(bytes);
  } catch (e) {
    return "";
  }
}

function encodeBase64(text: string) {
  const bytes = new TextEncoder().encode(text);
  const binString = Array.from(bytes).map(byte => String.fromCodePoint(byte)).join('');
  return btoa(binString);
}

// ★追加: Gmail特有の暗号(MIMEエンコード)を綺麗な日本語に解読するデコーダー
function decodeMimeHeader(header: string): string {
  if (!header) return "";
  const regex = /=\?([^?]+)\?([BQbq])\?([^?]+)\?=/g;
  return header.replace(regex, (match, charset, encoding, text) => {
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
    } catch (e) {
      return match;
    }
    return match;
  });
}

function getTextBody(payload: any): string {
  if (payload.body && payload.body.data) return decodeBase64Url(payload.body.data);
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body && part.body.data) return decodeBase64Url(part.body.data);
      if (part.parts) {
        const nestedBody = getTextBody(part);
        if (nestedBody) return nestedBody;
      }
    }
    for (const part of payload.parts) {
      if (part.mimeType === "text/html" && part.body && part.body.data) return decodeBase64Url(part.body.data);
    }
  }
  return "";
}

// S/MIME署名ファイル（smime.p7s など）は、メールの本文とは無関係な電子署名データで、
// Gmail自身も添付ファイルとして表示しない。銀行系のメールなどで必ず付与されることが多いため、
// re:mailでも同様に一覧から除外する
function isSmimeSignaturePart(mimeType: string, filename: string): boolean {
  const mt = mimeType.toLowerCase();
  if (mt === 'application/pkcs7-signature' || mt === 'application/x-pkcs7-signature') return true;
  return /^smime\.p7[sm]$/i.test(filename.trim());
}

function extractAttachments(payload: any): Array<{ filename: string; mimeType: string; size: number; attachmentId: string }> {
  const results: Array<{ filename: string; mimeType: string; size: number; attachmentId: string }> = [];
  function walk(part: any) {
    if (!part) return;
    if (part.body?.attachmentId && part.filename?.trim()) {
      const disp = (part.headers || []).find((h: any) => h.name?.toLowerCase() === 'content-disposition')?.value?.toLowerCase() ?? '';
      const mimeType = part.mimeType || 'application/octet-stream';
      if (!disp.startsWith('inline') && !isSmimeSignaturePart(mimeType, part.filename)) {
        results.push({ filename: part.filename, mimeType, size: part.body.size || 0, attachmentId: part.body.attachmentId });
      }
    }
    if (part.parts) part.parts.forEach(walk);
  }
  walk(payload);
  return results;
}

function extractHtmlLinks(html: string): Array<{text: string, href: string}> {
  const links: Array<{text: string, href: string}> = [];
  const seen = new Set<string>();
  const re = /<a\b[^>]*?\bhref=["']?(https?:\/\/[^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = m[1].trim();
    const rawText = m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    // テキストが空・長すぎ・そのままURLの場合はスキップ
    if (rawText && rawText.length > 0 && rawText.length <= 150 && !rawText.startsWith("http")) {
      if (!seen.has(rawText)) {
        seen.add(rawText);
        links.push({ text: rawText, href });
      }
    }
  }
  return links;
}

// multipart/related や multipart/alternative が何重にもネストしていても取りこぼさないよう、
// 木構造を最後まで走査してすべての text/html パートを集め、最も内容量の多いものを採用する
// （マーケティングメールなどで、装飾用の小さいhtml断片が本文より先に見つかってしまうのを防ぐ）
function getHtmlBody(payload: any): string {
  const candidates: string[] = [];
  function walk(part: any) {
    if (!part) return;
    if (part.mimeType === "text/html" && part.body?.data) {
      const decoded = decodeBase64Url(part.body.data);
      if (decoded) candidates.push(decoded);
    }
    if (part.parts) part.parts.forEach(walk);
  }
  walk(payload);
  if (candidates.length === 0) return "";
  return candidates.reduce((longest, cur) => (cur.length > longest.length ? cur : longest));
}

// HTML版の返信引用ブロックを除去する。Gmailは "gmail_attr"（差出人/日時の一行）+
// "gmail_quote"（引用本文）というdivで、他クライアントは<blockquote>で末尾に引用を付与する。
// これらは常にメール本文の末尾に置かれるため、最初に見つかった開始位置から後ろを丸ごと切り落とす
function stripHtmlQuote(html: string): string {
  if (!html) return html;
  let cut = html.length;
  const patterns = [/<div[^>]*class=["'][^"']*gmail_attr[^"']*["'][^>]*>/i, /<div[^>]*class=["'][^"']*gmail_quote[^"']*["'][^>]*>/i, /<blockquote\b/i];
  for (const re of patterns) {
    const idx = html.search(re);
    if (idx !== -1 && idx < cut) cut = idx;
  }
  return html.slice(0, cut).trim();
}

// 件名が「Fwd:/Fw:」で始まる、または本文にGmail標準の転送マーカー（"---------- Forwarded
// message ---------"、日本語版Gmailでもこの部分は英語のまま）が含まれる場合は転送メールとみなす。
// 転送メールの本文は「引用文」ではなく転送された内容そのものなので、
// stripHtmlQuote/stripQuotedReply で誤って切り捨てないようにするための判定
function looksLikeForward(subject: string, bodyForCheck: string): boolean {
  if (/^\s*(fwd|fw)\s*:/i.test(subject || "")) return true;
  if (/forwarded message/i.test(bodyForCheck || "")) return true;
  return false;
}

// 一部のメール（Yahoo!メールなど）は text/plain パートの生成が壊れており、
// <style>ブロックの中身（CSSの宣言）がタグなしでそのまま紛れ込んでいることがある。
// 通常の文章にはまず現れない「セレクタ { プロパティ: 値; ... }」という並びを検出して除去する
function stripLooseCssRules(text: string): string {
  return text.replace(/[^\n{}]{0,80}\{\s*(?:[\w-]+\s*:\s*[^;{}]+;\s*)+\}/g, "");
}

// 返信メールの末尾に自動付与される「引用元」ブロック（Gmailの
// 「YYYY年M月D日(曜) H:MM 差出人 <email>:」+「> 本文」形式、および
// 英語版の「On ... wrote:」形式）を検出して取り除く。
// チャットUIでは代わりに「どのメッセージへの返信か」を専用のチップで表示するため、
// 本文側にこの定型引用文が残っていると二重表示・ノイズになる
function stripQuotedReply(text: string): string {
  if (!text) return text;
  let stripped = text.replace(/\n{0,2}\d{4}年\d{1,2}月\d{1,2}日\([日月火水木金土]\)\s*\d{1,2}:\d{2}\s+[^\n]*?:\s*[\s\S]*$/, "");
  stripped = stripped.replace(/\n{0,2}On\s.{0,150}?wrote:\s*[\s\S]*$/i, "");
  // 上記の定型文に一致しなくても、末尾に「>」始まりの引用行が続く場合は削る
  const lines = stripped.split("\n");
  let cut = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (l === "" || l.startsWith(">")) { cut = i; } else { break; }
  }
  return lines.slice(0, cut).join("\n").trim();
}

// &#8199; (10進) や &#x1F680; (16進) のようなHTML数値文字参照をデコードする。
// マーケティングメールがクリップ回避などの目的で埋め込む大量の不可視文字（figure space等）が
// 名前付きエンティティのデコードだけでは素通しになり、そのまま文字列として表示されてしまうため
function decodeNumericEntity(codeStr: string, isHex: boolean): string {
  const cp = parseInt(codeStr, isHex ? 16 : 10);
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10FFFF) return "";
  try { return String.fromCodePoint(cp); } catch { return ""; }
}

function cleanseBody(text: string, isForward = false): string {
  if (!text) return "";
  let cleaned = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  cleaned = cleaned.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
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
function parseMessageDetail(message: any) {
  const payload = message.payload;
  const headers = payload?.headers || [];

  const subject = decodeMimeHeader(getHeader(headers, "Subject")) || "(件名なし)";
  const from = decodeMimeHeader(getHeader(headers, "From"));
  const to = decodeMimeHeader(getHeader(headers, "To"));
  const date = getHeader(headers, "Date");
  const labelIds = message.labelIds || [];
  // Discord風の「返信先」チップ表示のため、Message-ID / In-Reply-To を保持しておく
  const messageIdHeader = getHeader(headers, "Message-ID") || undefined;
  const rawBody = getTextBody(payload) || message.snippet || "";
  const rawHtmlForCheck = getHtmlBody(payload);
  const isForward = looksLikeForward(subject, rawBody) || looksLikeForward(subject, rawHtmlForCheck);
  // 転送メールはGmail側の都合でIn-Reply-Toが付与されていることがあるが、
  // 会話上の「返信」ではなく別内容の転送なので、re:mail側の返信チップは出さない
  const inReplyTo = isForward ? undefined : (getHeader(headers, "In-Reply-To") || undefined);
  let cleansedBody = cleanseBody(rawBody, isForward);
  // CSSの除去などで本文が空になってしまった場合は、Gmail側で生成されたスニペットに差し替える
  if (!cleansedBody.trim() && message.snippet) cleansedBody = cleanseBody(message.snippet, isForward);
  const htmlBodyForLinks = isForward ? rawHtmlForCheck.trim() : stripHtmlQuote(rawHtmlForCheck);
  const htmlLinks = htmlBodyForLinks ? extractHtmlLinks(htmlBodyForLinks) : [];

  const attachments = extractAttachments(payload);
  return { id: message.id, threadId: message.threadId, subject, from, to, date, body: cleansedBody, snippet: message.snippet, labelIds, htmlLinks, attachments, messageIdHeader, inReplyTo };
}

export async function GET(request: Request) {
  const session = await auth() as any;
  if (!session || !session.accessToken || session.error === "RefreshAccessTokenError") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);

  const messageId = searchParams.get("messageId");

  // 添付ファイルデータの取得
  const attachmentId = searchParams.get("attachmentId");
  if (messageId && attachmentId) {
    if (messageId.startsWith("fake-")) return NextResponse.json({ data: null });
    try {
      const res = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
        { headers: { Authorization: `Bearer ${session.accessToken}` } }
      );
      if (!res.ok) return NextResponse.json({ data: null });
      const json = await res.json();
      return NextResponse.json({ data: json.data ?? null });
    } catch {
      return NextResponse.json({ data: null });
    }
  }

  // 返信元メッセージの単体検索（Discord風の返信チップで、未読み込みの過去メールへジャンプする用）。
  // ページを何十件も読み込んで探すのではなく、Gmailの rfc822msgid: 検索で
  // Message-ID を直接指定し、1〜2回のAPI呼び出しで存在有無と場所を判定する
  const lookupByMessageId = searchParams.get("lookupByMessageId");
  if (lookupByMessageId) {
    try {
      const searchRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=1&includeSpamTrash=true&q=${encodeURIComponent(`rfc822msgid:${lookupByMessageId}`)}`,
        { headers: { Authorization: `Bearer ${session.accessToken}` } }
      );
      if (!searchRes.ok) return NextResponse.json({ found: false });
      const searchData = await searchRes.json();
      const hit = (searchData.messages || [])[0];
      if (!hit) return NextResponse.json({ found: false });

      const detailRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${hit.id}?fields=id,threadId,snippet,labelIds,payload(headers,parts,body)`,
        { headers: { Authorization: `Bearer ${session.accessToken}` } }
      );
      if (!detailRes.ok) return NextResponse.json({ found: false });
      const message = await detailRes.json();
      return NextResponse.json({ found: true, email: parseMessageDetail(message) });
    } catch {
      return NextResponse.json({ found: false });
    }
  }

  // 単一メッセージのHTML本文取得（モーダル表示用）
  if (messageId && searchParams.get("html") === "true") {
    if (messageId.startsWith("fake-")) return NextResponse.json({ htmlBody: null, hasHtml: false });
    try {
      const detailRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?fields=payload`,
        { headers: { Authorization: `Bearer ${session.accessToken}` } }
      );
      if (!detailRes.ok) return NextResponse.json({ htmlBody: null, hasHtml: false });
      const message = await detailRes.json();
      const rawHtml = getHtmlBody(message.payload);
      const subject = decodeMimeHeader(getHeader(message.payload?.headers || [], "Subject"));
      // 転送メールの場合、本文が「引用文」ではなく転送された内容そのものなので切り捨てない
      const htmlBody = looksLikeForward(subject, rawHtml) ? rawHtml.trim() : stripHtmlQuote(rawHtml);
      return NextResponse.json({ htmlBody: htmlBody || null, hasHtml: !!htmlBody });
    } catch {
      return NextResponse.json({ htmlBody: null, hasHtml: false });
    }
  }

  const maxResults = searchParams.get("maxResults") || "10";
  const q = searchParams.get("q") || "";
  const includeTrash = searchParams.get("includeTrash") === "true";
  const pageToken = searchParams.get("pageToken") || "";
  const knownIdsParam = searchParams.get("knownIds") || "";
  const knownIds = new Set(knownIdsParam.split(",").filter(Boolean));

  try {
    let apiUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxResults}`;
    if (q) apiUrl += `&q=${encodeURIComponent(q)}`;
    if (includeTrash) apiUrl += `&includeSpamTrash=true`;
    if (pageToken) apiUrl += `&pageToken=${pageToken}`;

    const listRes = await fetch(apiUrl, { headers: { Authorization: `Bearer ${session.accessToken}` } });
    if (listRes.status === 401) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!listRes.ok) throw new Error("Failed to fetch messages list");
    
    const listData = await listRes.json();
    const messages = listData.messages || [];
    const nextPageToken = listData.nextPageToken || null;

    if (messages.length === 0) return NextResponse.json({ messages: [], topIds: [], nextPageToken });

    const topIds = messages.map((m: any) => m.id);
    const messagesToFetch = messages.filter((m: any) => !knownIds.has(m.id));

    const chunkSize = 20;
    const detailedMessages: any[] = [];
    for (let i = 0; i < messagesToFetch.length; i += chunkSize) {
      const chunk = messagesToFetch.slice(i, i + chunkSize);
      const chunkResults = await Promise.all(
        chunk.map(async (msg: { id: string }) => {
          const detailRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?fields=id,threadId,snippet,labelIds,payload(headers,parts,body)`, {
            headers: { Authorization: `Bearer ${session.accessToken}` },
          });
          return detailRes.json();
        })
      );
      detailedMessages.push(...chunkResults);
    }

    const parsedMessages = detailedMessages.map(parseMessageDetail);

    return NextResponse.json({ messages: parsedMessages, topIds, nextPageToken });
  } catch (error) {
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await auth() as any;
  if (!session || !session.accessToken || session.error === "RefreshAccessTokenError") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  
  try {
    const bodyData = await request.json();
    const { action } = bodyData;

    // ① メールの送信
    if (action === "send" || !action) {
      const { to, subject, body, bodyHtml, threadId, inReplyTo } = bodyData;

      const formattedTo = (to || "").split(',').map((addr: string) => {
        const match = addr.match(/^(.*?)(<[^>]+>)$/);
        if (match) {
          const namePart = match[1].trim().replace(/^"|"$/g, '').trim();
          const emailPart = match[2].trim();
          if (namePart) { return `=?utf-8?B?${encodeBase64(namePart)}?= ${emailPart}`; }
          return emailPart;
        }
        return addr.trim();
      }).join(', ');

      const encodedSubject = subject ? `=?utf-8?B?${encodeBase64(subject)}?=` : "";

      const headerLines = [
        `To: ${formattedTo || to || ""}`,
        `Subject: ${encodedSubject}`,
      ];
      // In-Reply-To / References を設定しておくことで、返信メールのボディに
      // 引用文を埋め込まなくても、チャットUI側で「どのメッセージへの返信か」を判定できる
      const safeInReplyTo = typeof inReplyTo === "string" ? inReplyTo.replace(/[\r\n]/g, "").trim() : "";
      if (safeInReplyTo) {
        headerLines.push(`In-Reply-To: ${safeInReplyTo}`);
        headerLines.push(`References: ${safeInReplyTo}`);
      }
      // 転送メールなど、元のHTMLメールをそのまま保持して送りたい場合は bodyHtml を使う
      // （Gmail転送と同じく体裁・情報の欠落を防ぐため、cleanseBodyで加工したテキストは使わない）
      if (bodyHtml) {
        headerLines.push("MIME-Version: 1.0", "Content-Type: text/html; charset=utf-8", "", bodyHtml);
      } else {
        headerLines.push("Content-Type: text/plain; charset=utf-8", "", body || "");
      }

      const rawMessage = headerLines.join("\r\n");
      
      const encodedMessage = encodeBase64(rawMessage).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const requestBody: any = { raw: encodedMessage };
      if (threadId) requestBody.threadId = threadId;

      const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method: "POST", headers: { Authorization: `Bearer ${session.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      
      if (res.status === 401) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        return NextResponse.json({ error: "Failed to send email", details: errorData }, { status: res.status });
      }

      // ★修正: 送信したメールを受信箱(INBOX)に強制移動させていた余計な modify 処理を完全撤廃。
      // これにより、送信したメールは本家Gmailと同じく、無条件で綺麗な「送信済み（アーカイブ状態）」として統合されます。

      // Gmailが実際に採番したメッセージID/スレッドIDをクライアントへ返す。
      // グループチャットで送信したメールをリロード後も正しく識別するために必要
      const sentData = await res.json().catch(() => ({} as any));
      return NextResponse.json({ success: true, id: sentData.id, threadId: sentData.threadId });
    }

    // ③ メールの削除（完全削除含む）
    if (action === "delete") {
      const { permanentIds, trashIds } = bodyData;
      
      if (permanentIds && permanentIds.length > 0) {
        // ★修正: 送信直後のフェイクID (fake-...) はGmailサーバーに存在しないため、確実に除外してエラーを防ぐ
        const realPermanentIds = permanentIds.filter((id: string) => !id.startsWith("fake-"));
        
        if (realPermanentIds.length > 0) {
          const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/batchDelete", {
            method: "POST", 
            headers: { Authorization: `Bearer ${session.accessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ ids: realPermanentIds }),
          });
          if (res.status === 401) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
      }
      if (trashIds && trashIds.length > 0) {
        const realTrashIds = trashIds.filter((id: string) => !id.startsWith("fake-"));
        if (realTrashIds.length > 0) {
          const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify", {
            method: "POST", headers: { Authorization: `Bearer ${session.accessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ ids: realTrashIds, addLabelIds: ["TRASH"], removeLabelIds: ["INBOX", "SPAM"] }),
          });
          if (res.status === 401) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
      }
      return NextResponse.json({ success: true });
    }

    if (action === "move") {
      const { ids, destination } = bodyData;
      let addLabelIds: string[] = [];
      let removeLabelIds: string[] = [];
      
      if (destination === "INBOX") { addLabelIds = ["INBOX"]; removeLabelIds = ["TRASH", "SPAM"]; }
      else if (destination === "TRASH") { addLabelIds = ["TRASH"]; removeLabelIds = ["INBOX", "SPAM"]; }
      else if (destination === "SPAM") { addLabelIds = ["SPAM"]; removeLabelIds = ["INBOX", "TRASH"]; }

      const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify", {
        method: "POST", headers: { Authorization: `Bearer ${session.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ids, addLabelIds, removeLabelIds }),
      });

      if (res.status === 401) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      if (!res.ok) throw new Error("Failed to move emails");
      return NextResponse.json({ success: true });
    }

    if (action === "delete") {
      const { permanentIds, trashIds } = bodyData;
      if (permanentIds && permanentIds.length > 0) {
        const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/batchDelete", {
          method: "POST", headers: { Authorization: `Bearer ${session.accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ ids: permanentIds }),
        });
        if (res.status === 401) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      if (trashIds && trashIds.length > 0) {
        const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify", {
          method: "POST", headers: { Authorization: `Bearer ${session.accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ ids: trashIds, addLabelIds: ["TRASH"], removeLabelIds: ["INBOX", "SPAM"] }),
        });
        if (res.status === 401) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}