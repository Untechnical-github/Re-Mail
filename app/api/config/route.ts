import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { errorMessage } from "../../lib/errorMessage";
import { auth } from "../../../auth"; // ※ auth.ts の場所に合わせる
import { logError, logInfo } from "../../lib/safeLog";
import { decryptSecret, encryptSecret, hmacId } from "../../lib/tokenCrypto";
import { revealConfigName, sealConfigName, hasPlainRoomId, sealRow, openRow, isReservedRow, isSealedChatId, SEALED_CHAT_ID_PREFIX, type RowCrypto } from "../../lib/configCrypto";

// D1 に相手の名前・アドレス・フィルターの語を平文で置かない（絶対ルール1）。
// chat_id は「h1:」＋HMAC に、元の chat_id と custom_name はまとめて暗号化して保存する（app/lib/configCrypto.ts）。
// 古いコードに戻しても壊れないよう2段階で入れる:
//   段階1（WRITE_SEALED = false）: 読むときは暗号化した行も平文の行も読める。保存はまだ平文
//   段階2（WRITE_SEALED = true）: 保存を暗号化に切り替え、平文の行は読んだときに暗号化して置き換える
const WRITE_SEALED = false;

const rowCrypto: RowCrypto = { hmac: hmacId, encrypt: encryptSecret, decrypt: decryptSecret };

type Row = {
  account_email: string;
  chat_id: string;
  custom_name?: string | null;
  is_pinned?: number | null;
  is_hidden?: number | null;
  hidden_at_date?: string | null;
  unhide_on_new?: number | null;
};

const UPSERT_SQL = `INSERT INTO chat_configs (user_email, account_email, chat_id, custom_name, is_pinned, is_hidden, hidden_at_date, unhide_on_new)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_email, account_email, chat_id) DO UPDATE SET
       custom_name=excluded.custom_name,
       is_pinned=excluded.is_pinned,
       is_hidden=excluded.is_hidden,
       hidden_at_date=excluded.hidden_at_date,
       unhide_on_new=excluded.unhide_on_new`;

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const userEmail = session.user.email;

  try {
    const { searchParams } = new URL(request.url);
    const accountEmail = searchParams.get("account_email");
    const db = getCloudflareContext().env.DB;
    const { results } = accountEmail
      ? await db.prepare("SELECT * FROM chat_configs WHERE user_email = ? AND account_email = ?").bind(userEmail, accountEmail).all()
      : await db.prepare("SELECT * FROM chat_configs WHERE user_email = ?").bind(userEmail).all();
    const rows = results as Row[];

    // 暗号化した行を元の形に戻す。同じ設定の暗号化した行と平文の行が両方あれば、暗号化した方（新しい方）を使う
    const opened = new Map<string, Row>();
    const plainRowsToSeal: Row[] = [];
    for (const row of rows) {
      if (isReservedRow(row.account_email)) { opened.set(`\u0000${row.chat_id}`, row); continue; }
      const o = await openRow(row.chat_id, row.custom_name, rowCrypto);
      if (!o) { logError("config.openRow", {}); continue; }
      const key = `${row.account_email}\u0000${o.chatId}`;
      const sealed = isSealedChatId(row.chat_id);
      if (!sealed) plainRowsToSeal.push(row);
      if (!sealed && opened.has(key)) continue;
      opened.set(key, { ...row, chat_id: o.chatId, custom_name: o.customName });
    }

    if (WRITE_SEALED) {
      // 段階2: 平文で残っている行を、暗号化した行に置き換える（同じバッチで書いて消すので、途中で失われない）。
      // 失敗しても画面への応答は止めない（次に読んだときにまた試す）
      // 同じ設定の暗号化した行が既にあれば、その（新しい方の）内容で書き直して平文の行を消す
      const toSeal = plainRowsToSeal;
      if (toSeal.length > 0) {
        try {
          const stmts = [];
          for (const row of toSeal) {
            const current = opened.get(`${row.account_email}\u0000${row.chat_id}`) || row;
            const sealed = await sealRow(row.chat_id, current.custom_name, rowCrypto);
            if (!sealed) continue;
            stmts.push(db.prepare(UPSERT_SQL).bind(userEmail, row.account_email, sealed.chatId, sealed.customName, current.is_pinned ?? 0, current.is_hidden ?? 0, current.hidden_at_date ?? null, current.unhide_on_new ?? 0));
            stmts.push(db.prepare("DELETE FROM chat_configs WHERE user_email = ? AND account_email = ? AND chat_id = ?").bind(userEmail, row.account_email, row.chat_id));
          }
          if (stmts.length > 0) {
            await db.batch(stmts);
            logInfo("config.sealRows", { count: stmts.length / 2 });
          }
        } catch (e) {
          logError("config.sealRows", { count: toSeal.length }, e);
        }
      }
    } else {
      // 段階1まで: 平文の roomId だけは暗号化して書き戻す（前の変更の続き）
      const plainRoomIdRows = rows.filter((row) => !isSealedChatId(row.chat_id) && hasPlainRoomId(row.custom_name));
      if (plainRoomIdRows.length > 0) {
        try {
          const stmts = await Promise.all(plainRoomIdRows.map(async (row) => db.prepare(
            "UPDATE chat_configs SET custom_name = ? WHERE user_email = ? AND account_email = ? AND chat_id = ?"
          ).bind(await sealConfigName(row.custom_name, encryptSecret), userEmail, row.account_email, row.chat_id)));
          await db.batch(stmts);
        } catch (e) {
          logError("config.sealExisting", { count: plainRoomIdRows.length }, e);
        }
      }
    }

    // 暗号化して保存した値（相手の名前を含む roomId など）を、画面に返す前に復号する
    const configs = await Promise.all(Array.from(opened.values()).map(async (row) => ({
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
  const userEmail = session.user.email;

  try {
    const body = await request.json();
    if (!body.account_email) return NextResponse.json({ error: "account_email is required" }, { status: 400 });
    if (typeof body.chat_id !== "string" || !body.chat_id) return NextResponse.json({ error: "chat_id is required" }, { status: 400 });
    const db = getCloudflareContext().env.DB;
    const customName = typeof body.custom_name === "string" ? body.custom_name : null;
    const flags = [body.is_pinned ? 1 : 0, body.is_hidden ? 1 : 0, body.hidden_at_date || null, body.unhide_on_new ? 1 : 0] as const;

    const sealed = WRITE_SEALED ? await sealRow(body.chat_id, customName, rowCrypto) : null;
    if (sealed) {
      // 暗号化した行を書き、同じ設定の平文の行が残っていれば消す
      await db.batch([
        db.prepare(UPSERT_SQL).bind(userEmail, body.account_email, sealed.chatId, sealed.customName, ...flags),
        db.prepare("DELETE FROM chat_configs WHERE user_email = ? AND account_email = ? AND chat_id = ?").bind(userEmail, body.account_email, body.chat_id),
      ]);
    } else {
      // 相手の名前を含む roomId は暗号化して保存する（D1 に平文の個人情報を書かない。絶対ルール1）
      await db.prepare(UPSERT_SQL).bind(
        userEmail, body.account_email, body.chat_id,
        (await sealConfigName(customName, encryptSecret)) || null,
        ...flags,
      ).run();
    }

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
    // 平文の行と暗号化した行のどちらで保存されていても消す
    const stmts = [db.prepare(`DELETE FROM chat_configs WHERE user_email = ? AND account_email = ? AND chat_id = ?`).bind(session.user.email, accountEmail, chatId)];
    const hashed = await hmacId(chatId);
    if (hashed) stmts.push(db.prepare(`DELETE FROM chat_configs WHERE user_email = ? AND account_email = ? AND chat_id = ?`).bind(session.user.email, accountEmail, `${SEALED_CHAT_ID_PREFIX}${hashed}`));
    await db.batch(stmts);

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    logError("config.delete", {}, error);
    return NextResponse.json({ error: "Database Error", details: errorMessage(error) }, { status: 500 });
  }
}
