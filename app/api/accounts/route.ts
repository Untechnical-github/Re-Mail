import { NextResponse } from "next/server";
import { getRequestContext } from "@cloudflare/next-on-pages";
import { auth } from "../../../auth";

export const runtime = 'edge';

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const db = getRequestContext().env.DB;
    const { results } = await db.prepare("SELECT account_email, needs_reauth FROM linked_accounts WHERE user_email = ?").bind(session.user.email).all();
    return NextResponse.json({ accounts: results });
  } catch (error: any) {
    console.error("DB GET Error:", error);
    return NextResponse.json({ error: "Database Error", details: error.message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { searchParams } = new URL(request.url);
    const accountEmail = searchParams.get("account_email");
    if (!accountEmail) return NextResponse.json({ error: "account_email is required" }, { status: 400 });

    const db = getRequestContext().env.DB;
    // 連携解除は linked_accounts のみ削除する。関連する chat_configs はあえて残す
    // （再連携すればそのまま復元されるため、ここで一緒に消す必要はない）
    await db.prepare("DELETE FROM linked_accounts WHERE user_email = ? AND account_email = ?").bind(session.user.email, accountEmail).run();

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("DB DELETE Error:", error);
    return NextResponse.json({ error: "Database Error", details: error.message }, { status: 500 });
  }
}
