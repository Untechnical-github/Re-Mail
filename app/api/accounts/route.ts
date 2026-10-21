import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { errorMessage } from "../../lib/errorMessage";
import { auth } from "../../../auth";
import { logError } from "../../lib/safeLog";


export async function GET() {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const db = getCloudflareContext().env.DB;
    const { results } = await db.prepare("SELECT account_email, needs_reauth, name, picture FROM linked_accounts WHERE user_email = ?").bind(session.user.email).all();
    return NextResponse.json({ accounts: results });
  } catch (error: unknown) {
    logError("accounts.list", {}, error);
    return NextResponse.json({ error: "Database Error", details: errorMessage(error) }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { searchParams } = new URL(request.url);
    const accountEmail = searchParams.get("account_email");
    if (!accountEmail) return NextResponse.json({ error: "account_email is required" }, { status: 400 });

    const db = getCloudflareContext().env.DB;
    // 連携解除は linked_accounts のみ削除する。関連する chat_configs はあえて残す
    // （再連携すればそのまま復元されるため、ここで一緒に消す必要はない）
    await db.prepare("DELETE FROM linked_accounts WHERE user_email = ? AND account_email = ?").bind(session.user.email, accountEmail).run();

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    logError("accounts.unlink", {}, error);
    return NextResponse.json({ error: "Database Error", details: errorMessage(error) }, { status: 500 });
  }
}
