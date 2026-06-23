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

function getBody(payload: any): string {
  if (payload.body && payload.body.data) return decodeBase64Url(payload.body.data);
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body && part.body.data) return decodeBase64Url(part.body.data);
      if (part.parts) {
        const nestedBody = getBody(part);
        if (nestedBody) return nestedBody;
      }
    }
    for (const part of payload.parts) {
      if (part.mimeType === "text/html" && part.body && part.body.data) return decodeBase64Url(part.body.data);
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
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();
  return cleaned;
}

export async function GET(request: Request) {
  const session = await auth() as any; 
  // ★修正: リフレッシュトークンの更新に失敗していた場合、500エラーを出さずに「401」を返す
  if (!session || !session.accessToken || session.error === "RefreshAccessTokenError") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
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
    
    // ★修正: 鍵が古い・無効などの理由でGoogleから弾かれた場合も、500ではなく「401」を画面に返す
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
      const subject = getHeader(headers, "Subject") || "(件名なし)";
      const from = getHeader(headers, "From");
      const to = getHeader(headers, "To");
      const date = getHeader(headers, "Date");
      const labelIds = message.labelIds || []; 
      const rawBody = getBody(payload) || message.snippet || "";
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
  // ★修正: GETと同様、POST時も認証エラーを弾く
  if (!session || !session.accessToken || session.error === "RefreshAccessTokenError") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  
  try {
    const bodyData = await request.json();
    const { action } = bodyData;

    if (action === "send" || !action) {
      const { to, subject, body, threadId } = bodyData;
      
      // ★修正: 文字化けの元凶だった手動のMIMEエンコードを完全撤廃。
      // 綺麗なUTF-8文字列のまま組み立ててBase64化するだけでGmailは完璧に解釈します。
      const rawMessage = [
        `To: ${to || ""}`, 
        `Subject: ${subject || ""}`, 
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

      // ★追加: 送信成功の直後、そのメールに「INBOX（受信箱）」ラベルを付与する。
      // これによりリロード後もアーカイブ扱いにならず、正しく受信箱のチャットとして留まります。
      const sentData = await res.json();
      if (sentData && sentData.id) {
         await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${sentData.id}/modify`, {
            method: "POST",
            headers: { Authorization: `Bearer ${session.accessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ addLabelIds: ["INBOX"] })
         });
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