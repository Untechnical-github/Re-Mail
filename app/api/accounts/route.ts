import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { errorMessage } from "../../lib/errorMessage";
import { auth } from "../../../auth";
import { logError } from "../../lib/safeLog";
import { listLinkedAccounts, deleteLinkedAccount } from "../../lib/linkedAccountsStore";


export async function GET() {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const db = getCloudflareContext().env.DB;
    // アドレス・表示名・画像 URL は元に戻して返す（D1 では置き換え・暗号化している）
    return NextResponse.json({ accounts: await listLinkedAccounts(db, session.user.email) });
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
    await deleteLinkedAccount(db, session.user.email, accountEmail);

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    logError("accounts.unlink", {}, error);
    return NextResponse.json({ error: "Database Error", details: errorMessage(error) }, { status: 500 });
  }
}
