import { NextResponse } from "next/server";
import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "../../../auth"; // ※ auth.ts の場所に合わせる

export const runtime = 'edge';

export async function GET(request: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    // Cloudflare Edge専用のD1データベース呼び出し
    const db = getRequestContext().env.DB;
    const { results } = await db.prepare("SELECT * FROM configs").all();
    return NextResponse.json({ configs: results });
  } catch (error: any) {
    console.error("DB GET Error:", error);
    return NextResponse.json({ error: "Database Error", details: error.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await request.json();
    const db = getRequestContext().env.DB;
    
    await db.prepare(
      `INSERT INTO configs (chat_id, custom_name, is_pinned, is_hidden, hidden_at_date, unhide_on_new)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET
       custom_name=excluded.custom_name,
       is_pinned=excluded.is_pinned,
       is_hidden=excluded.is_hidden,
       hidden_at_date=excluded.hidden_at_date,
       unhide_on_new=excluded.unhide_on_new`
    ).bind(
      body.chat_id, 
      body.custom_name || null, 
      body.is_pinned ? 1 : 0, 
      body.is_hidden ? 1 : 0, 
      body.hidden_at_date || null, 
      body.unhide_on_new ? 1 : 0
    ).run();

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("DB POST Error:", error);
    return NextResponse.json({ error: "Database Error", details: error.message }, { status: 500 });
  }
}