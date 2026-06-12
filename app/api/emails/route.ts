import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "../auth/[...nextauth]/route";

// --- ヘルパー関数: ヘッダー配列から特定の項目の値を取り出す ---
function getHeader(headers: any[], name: string): string {
  const header = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return header ? header.value : "";
}

// --- ヘルパー関数: Gmailの複雑な構造から本文のBase64データを探してデコードする ---
function getBody(payload: any): string {
  // 1. 一番シンプルな平文テキストの場合
  if (payload.body && payload.body.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf-8");
  }

  // 2. 複数のパーツ（テキストとHTMLなど）に分かれている場合（再帰的に探索）
  if (payload.parts) {
    for (const part of payload.parts) {
      // プレーンテキスト(text/plain)を最優先で取得
      if (part.mimeType === "text/plain" && part.body && part.body.data) {
        return Buffer.from(part.body.data, "base64url").toString("utf-8");
      }
      // text/plainが見つからず、さらにネストしている場合は再帰探査
      if (part.parts) {
        const nestedBody = getBody(part);
        if (nestedBody) return nestedBody;
      }
    }
    
    // text/plainがなくてHTMLだけの場合は代替手段として取得
    for (const part of payload.parts) {
      if (part.mimeType === "text/html" && part.body && part.body.data) {
        return Buffer.from(part.body.data, "base64url").toString("utf-8");
      }
    }
  }

  return "";
}

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  
  if (!session || !session.accessToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const maxResults = searchParams.get("maxResults") || "10";
  const q = searchParams.get("q") || "";
  const includeTrash = searchParams.get("includeTrash") === "true";
  // フロントエンドからページ移動用のトークンを受け取る
  const pageToken = searchParams.get("pageToken") || "";

  try {
    let apiUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxResults}`;

    if (q) {
      apiUrl += `&q=${encodeURIComponent(q)}`;
    }
    if (includeTrash) {
      apiUrl += `&includeSpamTrash=true`;
    }
    // トークンがあればURLに追加
    if (pageToken) {
      apiUrl += `&pageToken=${pageToken}`;
    }

    const listRes = await fetch(apiUrl, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });

    if (!listRes.ok) {
      const errorText = await listRes.text();
      console.error("Google API からの拒否理由:", errorText);
      throw new Error("Failed to fetch messages list");
    }
    
    const listData = await listRes.json();
    const messages = listData.messages || [];
    // Googleから返ってきた「次のページ用のトークン」を保持
    const nextPageToken = listData.nextPageToken || null;

    const detailedMessages = await Promise.all(
      messages.map(async (msg: { id: string }) => {
        const detailRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}`, {
          headers: { Authorization: `Bearer ${session.accessToken}` },
        });
        return detailRes.json();
      })
    );

    const parsedMessages = detailedMessages.map((message) => {
      const payload = message.payload;
      const headers = payload?.headers || [];

      const subject = getHeader(headers, "Subject") || "(件名なし)";
      const from = getHeader(headers, "From");
      const to = getHeader(headers, "To"); // ★ここを追加
      const date = getHeader(headers, "Date");
      const body = getBody(payload) || message.snippet || "";

      return {
        id: message.id,
        threadId: message.threadId,
        subject,
        from,
        to, // ★ここを追加
        date,
        body,
        snippet: message.snippet
      };
    });

    // messages と一緒に nextPageToken もフロントエンドに返します
    return NextResponse.json({ messages: parsedMessages, nextPageToken });

  } catch (error) {
    console.error("Gmail API Error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

// --- app/api/emails/route.ts の下部を以下で上書き ---

// メールの送信・返信・転送 API
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || !session.accessToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // threadId があれば返信としてスレッドに結合
    const { to, subject, body, threadId } = await request.json();

    const rawMessage = [
      `To: ${to}`,
      `Subject: =?utf-8?B?${Buffer.from(subject || "").toString("base64")}?=`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      body
    ].join("\r\n");

    const encodedMessage = Buffer.from(rawMessage)
      .toString("base64")
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const requestBody: any = { raw: encodedMessage };
    if (threadId) {
      requestBody.threadId = threadId;
    }

    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    if (!res.ok) throw new Error("Failed to send email");
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("POST Error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

// メールのまとめて削除 API
export async function DELETE(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || !session.accessToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // 削除対象のメールIDの配列を受け取る
    const { ids } = await request.json();

    // Gmailの batchModify API を使って、一括でゴミ箱(TRASH)ラベルを付け、INBOXラベルを外す
    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ids: ids,
        addLabelIds: ["TRASH"],
        removeLabelIds: ["INBOX"]
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("削除エラー詳細:", errText);
      throw new Error("Failed to delete emails");
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("DELETE Error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}