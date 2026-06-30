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

function getHtmlBody(payload: any): string {
  if (payload.mimeType === "text/html" && payload.body?.data) return decodeBase64Url(payload.body.data);
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/html" && part.body?.data) return decodeBase64Url(part.body.data);
      if (part.parts) {
        const nested = getHtmlBody(part);
        if (nested) return nested;
      }
    }
  }
  return "";
}

function cleanseBody(text: string): string {
  if (!text) return "";
  let cleaned = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  cleaned = cleaned.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  cleaned = cleaned.replace(/<br\s*\/?>/gi, "\n");
  cleaned = cleaned.replace(/<\/p>|<\/div>|<\/tr>|<\/li>/gi, "\n");
  cleaned = cleaned.replace(/<[^>]+>/g, "");
  cleaned = cleaned.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&zwnj;/g, "");
  // 各行をトリム → 空白行のみの行を空行に統一 → 連続する空行を1行に圧縮
  cleaned = cleaned.split("\n").map(l => l.trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return cleaned;
}

export async function GET(request: Request) {
  const session = await auth() as any;
  if (!session || !session.accessToken || session.error === "RefreshAccessTokenError") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);

  // 単一メッセージのHTML本文取得（モーダル表示用）
  const messageId = searchParams.get("messageId");
  if (messageId && searchParams.get("html") === "true") {
    if (messageId.startsWith("fake-")) return NextResponse.json({ htmlBody: null, hasHtml: false });
    try {
      const detailRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?fields=payload`,
        { headers: { Authorization: `Bearer ${session.accessToken}` } }
      );
      if (!detailRes.ok) return NextResponse.json({ htmlBody: null, hasHtml: false });
      const message = await detailRes.json();
      const htmlBody = getHtmlBody(message.payload);
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

    const parsedMessages = detailedMessages.map((message) => {
      const payload = message.payload;
      const headers = payload?.headers || [];
      
      // ★修正: 取得した生データを、フロントエンドに渡す前にすべて綺麗な日本語に解読する
      const subject = decodeMimeHeader(getHeader(headers, "Subject")) || "(件名なし)";
      const from = decodeMimeHeader(getHeader(headers, "From"));
      const to = decodeMimeHeader(getHeader(headers, "To"));
      const date = getHeader(headers, "Date");
      const labelIds = message.labelIds || []; 
      const rawBody = getTextBody(payload) || message.snippet || "";
      const cleansedBody = cleanseBody(rawBody);
      
      return { id: message.id, threadId: message.threadId, subject, from, to, date, body: cleansedBody, snippet: message.snippet, labelIds };
    });

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
      const { to, subject, body, threadId } = bodyData;
      
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
      
      const rawMessage = [
        `To: ${formattedTo || to || ""}`, 
        `Subject: ${encodedSubject}`, 
        "Content-Type: text/plain; charset=utf-8", 
        "", 
        body || ""
      ].join("\r\n");
      
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
      
      return NextResponse.json({ success: true });
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