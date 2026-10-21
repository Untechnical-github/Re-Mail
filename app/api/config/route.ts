import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { errorMessage } from "../../lib/errorMessage";
import { auth } from "../../../auth"; // ※ auth.ts の場所に合わせる
import { logError } from "../../lib/safeLog";
import { decryptSecret, encryptSecret } from "../../lib/tokenCrypto";
import { revealConfigName, sealConfigName, hasPlainRoomId } from "../../lib/configCrypto";


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
    type Row = { account_email: string; chat_id: string; custom_name?: string | null };
    const rows = results as Row[];
    // 暗号化する前に保存された行（平文の roomId）は、読んだついでに暗号化して書き戻す（段階2）。
    // 失敗しても画面への応答は止めない（次に読んだときにまた試す）
    const plainRows = rows.filter((row) => hasPlainRoomId(row.custom_name));
    if (plainRows.length > 0) {
      try {
        const stmts = await Promise.all(plainRows.map(async (row) => db.prepare(
          "UPDATE chat_configs SET custom_name = ? WHERE user_email = ? AND account_email = ? AND chat_id = ?"
        ).bind(await sealConfigName(row.custom_name, encryptSecret), session.user!.email, row.account_email, row.chat_id)));
        await db.batch(stmts);
      } catch (e) {
        logError("config.sealExisting", { count: plainRows.length }, e);
      }
    }
    // 暗号化して保存した値（相手の名前を含む roomId など）を、画面に返す前に復号する
    const configs = await Promise.all(rows.map(async (row) => ({
      ...row,
      custom_name: await revealConfigName(row.custom_name, decryptSecret),
    })));
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
      // 相手の名前を含む roomId は暗号化して保存する（D1 に平文の個人情報を書かない。絶対ルール1）
      (await sealConfigName(typeof body.custom_name === "string" ? body.custom_name : null, encryptSecret)) || null,
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
