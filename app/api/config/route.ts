import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { errorMessage } from "../../lib/errorMessage";
import { auth } from "../../../auth"; // ※ auth.ts の場所に合わせる
import { logError } from "../../lib/safeLog";
import { decryptSecret } from "../../lib/tokenCrypto";
import { revealConfigName } from "../../lib/configCrypto";
import { openAndMigrateConfigs, saveConfig, deleteConfig } from "../../lib/configStore";

// 設定の保存の形（暗号化・アドレスの置き換え）と移行は app/lib/configStore.ts にまとめてある

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { searchParams } = new URL(request.url);
    const accountFilter = searchParams.get("account_email");
    const db = getCloudflareContext().env.DB;
    const opened = await openAndMigrateConfigs(db, session.user.email);
    // 暗号化して保存した値（相手の名前を含む roomId など）を、画面に返す前に復号する
    const configs = await Promise.all(opened
      .filter(o => !accountFilter || o.account_email === accountFilter)
      .map(async (o) => ({ ...o, custom_name: await revealConfigName(o.custom_name, decryptSecret) })));
    return NextResponse.json({ configs });
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
    if (typeof body.chat_id !== "string" || !body.chat_id) return NextResponse.json({ error: "chat_id is required" }, { status: 400 });
    const db = getCloudflareContext().env.DB;
    await saveConfig(db, session.user.email, {
      chat_id: body.chat_id,
      account_email: String(body.account_email),
      custom_name: typeof body.custom_name === "string" ? body.custom_name : null,
      is_pinned: !!body.is_pinned,
      is_hidden: !!body.is_hidden,
      hidden_at_date: body.hidden_at_date || null,
      unhide_on_new: !!body.unhide_on_new,
    });
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
    await deleteConfig(db, session.user.email, chatId, accountEmail);
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    logError("config.delete", {}, error);
    return NextResponse.json({ error: "Database Error", details: errorMessage(error) }, { status: 500 });
  }
}
