import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { errorMessage } from "../../lib/errorMessage";
import { auth } from "../../../auth"; // ※ auth.ts の場所に合わせる
import { logError } from "../../lib/safeLog";


export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { searchParams } = new URL(request.url);
    const accountEmail = searchParams.get("account_email");
    const db = getCloudflareContext().env.DB;
    const { results } = accountEmail
      ? await db.prepare("SELECT * FROM chat_configs WHERE user_email = ? AND account_email = ?").bind(session.user.email, accountEmail).all()
      : await db.prepare("SELECT * FROM chat_configs WHERE user_email = ?").bind(session.user.email).all();
    return NextResponse.json({ configs: results });
  } catch (error: unknown) {
    logError("config.get", {}, error);
    return NextResponse.json({ error: "Database Error", details: errorMessage(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await request.json();
    if (!body.account_email) return NextResponse.json({ error: "account_email is required" }, { status: 400 });
    const db = getCloudflareContext().env.DB;

    await db.prepare(
      `INSERT INTO chat_configs (user_email, account_email, chat_id, custom_name, is_pinned, is_hidden, hidden_at_date, unhide_on_new)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_email, account_email, chat_id) DO UPDATE SET
       custom_name=excluded.custom_name,
       is_pinned=excluded.is_pinned,
       is_hidden=excluded.is_hidden,
       hidden_at_date=excluded.hidden_at_date,
       unhide_on_new=excluded.unhide_on_new`
    ).bind(
      session.user.email,
      body.account_email,
      body.chat_id,
      body.custom_name || null,
      body.is_pinned ? 1 : 0,
      body.is_hidden ? 1 : 0,
      body.hidden_at_date || null,
      body.unhide_on_new ? 1 : 0
    ).run();

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    logError("config.save", {}, error);
    return NextResponse.json({ error: "Database Error", details: errorMessage(error) }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { searchParams } = new URL(request.url);
    const chatId = searchParams.get("chat_id");
    const accountEmail = searchParams.get("account_email");
    if (!chatId) return NextResponse.json({ error: "chat_id is required" }, { status: 400 });
    if (!accountEmail) return NextResponse.json({ error: "account_email is required" }, { status: 400 });

    const db = getCloudflareContext().env.DB;
    await db.prepare(`DELETE FROM chat_configs WHERE user_email = ? AND account_email = ? AND chat_id = ?`)
      .bind(session.user.email, accountEmail, chatId).run();

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    logError("config.delete", {}, error);
    return NextResponse.json({ error: "Database Error", details: errorMessage(error) }, { status: 500 });
  }
}
