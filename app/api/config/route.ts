import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { errorMessage } from "../../lib/errorMessage";
import { auth } from "../../../auth"; // ※ auth.ts の場所に合わせる
import { logError } from "../../lib/safeLog";
import { decryptSecret } from "../../lib/tokenCrypto";
import { revealConfigName } from "../../lib/configCrypto";
import { openSessionConfigs, saveSessionConfig, deleteSessionConfig, saveCommonSettings, saveAccountSettings, sessionAccountList, openGlobalSettings, GLOBAL_SETTINGS_CHAT_ID } from "../../lib/configStore";
import { listLinkedAccounts } from "../../lib/linkedAccountsStore";

// ログイン中のアカウントに連携しているアカウント（ログインできた＝同じ人なので、その設定も読み書きしてよい）
async function linkedOf(db: CloudflareEnv["DB"], userEmail: string): Promise<string[]> {
  return (await listLinkedAccounts(db, userEmail)).map(a => a.account_email).filter(Boolean);
}

// 設定の保存の形（暗号化・アドレスの置き換え）と移行は app/lib/configStore.ts にまとめてある

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { searchParams } = new URL(request.url);
    const accountFilter = searchParams.get("account_email");
    const db = getCloudflareContext().env.DB;
    const { configs: opened, accountSettings } = await openSessionConfigs(db, session.user.email, await linkedOf(db, session.user.email));
    // 暗号化して保存した値（相手の名前を含む roomId など）を、画面に返す前に復号する
    const configs = await Promise.all(opened
      .filter(o => !accountFilter || o.account_email === accountFilter)
      .map(async (o) => ({
        ...o,
        // 共通の設定は暗号化して保存しているので、復号した JSON を返す
        custom_name: !o.account_email && o.chat_id === GLOBAL_SETTINGS_CHAT_ID
          ? JSON.stringify(await openGlobalSettings(o.custom_name))
          : await revealConfigName(o.custom_name, decryptSecret),
      })));
    return NextResponse.json({ configs, accountSettings });
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
    const db = getCloudflareContext().env.DB;
    const linked = await linkedOf(db, session.user.email);
    // 共通設定（どのアカウントでログインしても同じ。ログイン中の全アカウントに書く）
    if (body.global_settings !== undefined) {
      const settings = await saveCommonSettings(db, session.user.email, linked, body.global_settings);
      return NextResponse.json({ success: true, settings });
    }
    // アカウント設定（そのアカウントの置き場所に書く。ログイン中のアカウントのものだけ）
    if (body.account_settings !== undefined) {
      const account = sessionAccountList(session.user.email, linked).find(a => a.toLowerCase() === String(body.account_email || "").toLowerCase());
      if (!account) return NextResponse.json({ error: "Unknown account" }, { status: 400 });
      const settings = await saveAccountSettings(db, account, body.account_settings);
      return NextResponse.json({ success: true, settings });
    }
    if (!body.account_email) return NextResponse.json({ error: "account_email is required" }, { status: 400 });
    if (typeof body.chat_id !== "string" || !body.chat_id) return NextResponse.json({ error: "chat_id is required" }, { status: 400 });
    // shared（すべてのアカウントが対象のフィルターなど）は全アカウントに、それ以外はそのチャットのアカウントに書く
    await saveSessionConfig(db, session.user.email, linked, {
      chat_id: body.chat_id,
      account_email: String(body.account_email),
      custom_name: typeof body.custom_name === "string" ? body.custom_name : null,
      is_pinned: !!body.is_pinned,
      is_hidden: !!body.is_hidden,
      hidden_at_date: body.hidden_at_date || null,
      unhide_on_new: !!body.unhide_on_new,
    }, body.scope === "shared" ? "shared" : undefined);
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
    await deleteSessionConfig(db, session.user.email, await linkedOf(db, session.user.email), chatId, accountEmail, searchParams.get("scope") === "shared" ? "shared" : undefined);
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    logError("config.delete", {}, error);
    return NextResponse.json({ error: "Database Error", details: errorMessage(error) }, { status: 500 });
  }
}
