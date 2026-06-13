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
  if (payload.body && payload.body.data) {
    return decodeBase64Url(payload.body.data);
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body && part.body.data) {
        return decodeBase64Url(part.body.data);
      }
      if (part.parts) {
        const nestedBody = getBody(part);
        if (nestedBody) return nestedBody;
      }
    }
    for (const part of payload.parts) {
      if (part.mimeType === "text/html" && part.body && part.body.data) {
        return decodeBase64Url(part.body.data);
      }
    }
  }
  return "";
}

// ★ 追加：HTMLタグや不要なCSS/JSを削ぎ落とし、純粋なテキストに変換するクレンジング関数
function cleanseBody(text: string): string {
  if (!text) return "";
  
  // 1. スタイルシートとスクリプトを中身ごと完全に削除
  let cleaned = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  cleaned = cleaned.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  
  // 2. ブロック要素や改行タグを、実際の改行コード（\n）に変換してレイアウトを維持
  cleaned = cleaned.replace(/<br\s*\/?>/gi, "\n");
  cleaned = cleaned.replace(/<\/p>|<\/div>|<\/tr>|<\/li>/gi, "\n");
  
  // 3. 残りのすべてのHTMLタグ（<...>）を削除
  cleaned = cleaned.replace(/<[^>]+>/g, "");
  
  // 4. 特殊なHTMLエンティティ（文字化けの原因）を通常の記号に復元
  cleaned = cleaned.replace(/&nbsp;/g, " ")
                   .replace(/&amp;/g, "&")
                   .replace(/&lt;/g, "<")
                   .replace(/&gt;/g, ">")
                   .replace(/&quot;/g, '"')
                   .replace(/&#39;/g, "'")
                   .replace(/&zwnj;/g, ""); // メルマガによくある見えない文字を削除
                   
  // 5. 連続しすぎる無駄な改行（3回以上）を2回に圧縮し、前後の空白をトリム
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();
  
  return cleaned;
}

export async function GET(request: Request) {
  const session = await auth() as any; 
  if (!session || !session.accessToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const maxResults = searchParams.get("maxResults") || "10";
  const q = searchParams.get("q") || "";
  const includeTrash = searchParams.get("includeTrash") === "true";
  const pageToken = searchParams.get("pageToken") || "";
  
  // ★ 追加：クライアントが「すでに持っているメールのID」を受け取る
  const knownIdsParam = searchParams.get("knownIds") || "";
  const knownIds = new Set(knownIdsParam.split(",").filter(Boolean));

  try {
    let apiUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxResults}`;

    if (q) apiUrl += `&q=${encodeURIComponent(q)}`;
    if (includeTrash) apiUrl += `&includeSpamTrash=true`;
    if (pageToken) apiUrl += `&pageToken=${pageToken}`;

    const listRes = await fetch(apiUrl, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });

    if (!listRes.ok) throw new Error("Failed to fetch messages list");
    
    const listData = await listRes.json();
    const messages = listData.messages || []; // Googleから取得した最新のIDリスト（最大100件）
    const nextPageToken = listData.nextPageToken || null;

    if (messages.length === 0) {
      return NextResponse.json({ messages: [], topIds: [], nextPageToken });
    }

    // ★ 追加：最新の正確な並び順を記録しておく
    const topIds = messages.map((m: any) => m.id);

    // ★ 追加：差分チェック！すでにクライアントが持っているIDはフェッチ対象から除外（これで通信が爆速化）
    const messagesToFetch = messages.filter((m: any) => !knownIds.has(m.id));

    const chunkSize = 20;
    const detailedMessages: any[] = [];

    // 新着（差分）のメッセージだけを詳細取得する
    for (let i = 0; i < messagesToFetch.length; i += chunkSize) {
      const chunk = messagesToFetch.slice(i, i + chunkSize);
      const chunkResults = await Promise.all(
        chunk.map(async (msg: { id: string }) => {
          const detailRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?fields=id,threadId,snippet,payload(headers,parts,body)`, {
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
      
      const rawBody = getBody(payload) || message.snippet || "";
      const cleansedBody = cleanseBody(rawBody); // 第1弾で追加したクレンジング

      return { id: message.id, threadId: message.threadId, subject, from, to, date, body: cleansedBody, snippet: message.snippet };
    });

    // ★ 変更：差分データ（parsedMessages）と一緒に、最新の並び順（topIds）をフロントに返す
    return NextResponse.json({ messages: parsedMessages, topIds, nextPageToken });
  } catch (error) {
    console.error("Gmail API Error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await auth() as any;
  if (!session || !session.accessToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { to, subject, body, threadId } = await request.json();

    const rawMessage = [
      `To: ${to}`,
      `Subject: =?utf-8?B?${encodeBase64(subject || "")}?=`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      body
    ].join("\r\n");

    const encodedMessage = encodeBase64(rawMessage).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const requestBody: any = { raw: encodedMessage };
    if (threadId) requestBody.threadId = threadId;

    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${session.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    if (!res.ok) throw new Error("Failed to send email");
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("POST Error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const session = await auth() as any; 
  if (!session || !session.accessToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { ids } = await request.json();
    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify", {
      method: "POST",
      headers: { Authorization: `Bearer ${session.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ids, addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] }),
    });

    if (!res.ok) throw new Error("Failed to delete emails");
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("DELETE Error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}