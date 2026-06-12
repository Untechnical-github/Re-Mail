import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "../../../auth";
import { getRequestContext } from "@cloudflare/next-on-pages";

// D1からそのユーザーの全チャット設定を取得するAPI
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || !session.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // CloudflareのコンテキストからD1のバインディング（DB）を取得
    const { env } = getRequestContext();
    const db = (env as any).DB;

    // 自分のメールアドレスに紐づくチャット設定をすべて取得
    const { results } = await db
      .prepare("SELECT * FROM chat_configs WHERE user_email = ?")
      .bind(session.user.email)
      .all();

    return NextResponse.json({ configs: results });
  } catch (error) {
    console.error("D1 GET Error:", error);
    return NextResponse.json({ error: "Database Error" }, { status: 500 });
  }
}

// チャット設定をD1に保存・更新するAPI
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || !session.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { chat_id, custom_name, is_pinned, is_hidden, hidden_at_date, unhide_on_new } = await request.json();
    const user_email = session.user.email;

    const { env } = getRequestContext();
    const db = (env as any).DB;

    // データがあれば更新（UPDATE）、なければ新規挿入（INSERT）するSQL (UPSERT句)
    await db
      .prepare(`
        INSERT INTO chat_configs (user_email, chat_id, custom_name, is_pinned, is_hidden, hidden_at_date, unhide_on_new)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ON CONFLICT(user_email, chat_id) DO UPDATE SET
          custom_name = COALESCE(?3, custom_name),
          is_pinned = COALESCE(?4, is_pinned),
          is_hidden = COALESCE(?5, is_hidden),
          hidden_at_date = COALESCE(?6, hidden_at_date),
          unhide_on_new = COALESCE(?7, unhide_on_new)
      `)
      .bind(
        user_email,
        chat_id,
        custom_name !== undefined ? custom_name : null,
        is_pinned !== undefined ? (is_pinned ? 1 : 0) : null,
        is_hidden !== undefined ? (is_hidden ? 1 : 0) : null,
        hidden_at_date !== undefined ? hidden_at_date : null,
        unhide_on_new !== undefined ? (unhide_on_new ? 1 : 0) : null
      )
      .run();

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("D1 POST Error:", error);
    return NextResponse.json({ error: "Database Error" }, { status: 500 });
  }
}