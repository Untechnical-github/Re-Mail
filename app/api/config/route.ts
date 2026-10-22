import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { errorMessage } from "../../lib/errorMessage";
import { auth } from "../../../auth"; // ※ auth.ts の場所に合わせる
import { logError, logInfo } from "../../lib/safeLog";
import { decryptSecret, encryptSecret, hmacId } from "../../lib/tokenCrypto";
import { stripPinnedBodies } from "../../lib/pinnedIds";
import { addressKeyFor, isAddressKey } from "../../lib/addressKey";
import { WRITE_HASHED_ADDRESS } from "../../lib/addressStage";
import { revealConfigName, sealConfigName, sealRow, openRow, isReservedRow, isSealedChatId, SEALED_CHAT_ID_PREFIX, type RowCrypto } from "../../lib/configCrypto";

// D1 に個人情報を平文で置かない（絶対ルール1）。
// - chat_id（相手の名前・アドレス）は「h1:」＋HMAC、元の chat_id と custom_name（名前変更・グループ・フィルターの語）は
//   まとめて暗号化して保存する（app/lib/configCrypto.ts）
// - user_email・account_email（自分のアドレス）は「a1:」＋HMAC に置き換え、元の account_email は暗号化した中身に持たせる
//   （app/lib/addressKey.ts）。Re:Mail をほかの人も使うので、D1 だけが漏れても利用者の一覧が分からないようにする
// 画面とのやり取りは、これまでどおり元のアドレス・chat_id・custom_name で行う。
//
// 古いコードに戻しても壊れないよう、段階を分けて入れる（段階は app/lib/addressStage.ts で切り替える）

const rowCrypto: RowCrypto = { hmac: hmacId, encrypt: encryptSecret, decrypt: decryptSecret };

type Row = {
  user_email: string;
  account_email: string;
  chat_id: string;
  custom_name?: string | null;
  is_pinned?: number | null;
  is_hidden?: number | null;
  hidden_at_date?: string | null;
  unhide_on_new?: number | null;
};

// 画面に返す形（元のアドレス・chat_id・custom_name）と、元になった D1 の行
type OpenedRow = Omit<Row, "user_email"> & { source: Row; rank: number };

const UPSERT_SQL = `INSERT INTO chat_configs (user_email, account_email, chat_id, custom_name, is_pinned, is_hidden, hidden_at_date, unhide_on_new)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_email, account_email, chat_id) DO UPDATE SET
       custom_name=excluded.custom_name,
       is_pinned=excluded.is_pinned,
       is_hidden=excluded.is_hidden,
       hidden_at_date=excluded.hidden_at_date,
       unhide_on_new=excluded.unhide_on_new`;

const DELETE_ROW_SQL = "DELETE FROM chat_configs WHERE user_email = ? AND account_email = ? AND chat_id = ?";

// 本人のアドレスの、平文と置き換えた値（移行の途中は両方の行がありうる）
async function userKeys(email: string): Promise<{ plain: string; hashed: string | null }> {
  return { plain: email, hashed: await addressKeyFor(email, hmacId) };
}

// これから保存するときに使う account_email の値（段階1では平文のまま）
async function targetAccountKey(accountEmail: string): Promise<string> {
  if (isReservedRow(accountEmail)) return "";
  if (!WRITE_HASHED_ADDRESS) return accountEmail;
  return (await addressKeyFor(accountEmail, hmacId)) || accountEmail;
}

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await userKeys(session.user.email);
  const targetUser = WRITE_HASHED_ADDRESS && user.hashed ? user.hashed : user.plain;

  try {
    const { searchParams } = new URL(request.url);
    const accountFilter = searchParams.get("account_email");
    const db = getCloudflareContext().env.DB;
    const { results } = user.hashed
      ? await db.prepare("SELECT * FROM chat_configs WHERE user_email IN (?, ?)").bind(user.plain, user.hashed).all()
      : await db.prepare("SELECT * FROM chat_configs WHERE user_email = ?").bind(user.plain).all();
    const rows = results as Row[];

    // それぞれの行を元の形に戻す。同じ設定が古い形と新しい形の両方にあれば、新しい形（rank が高い方）を使い、
    // 使わなかった方は「同じ設定の古い行」として後で消す。開けなかった行は消さずにそのまま残す（失わないため）
    const opened = new Map<string, OpenedRow>();
    const duplicates: Row[] = [];
    for (const row of rows) {
      const reserved = isReservedRow(row.account_email);
      let chatId = row.chat_id;
      let customName = row.custom_name ?? null;
      let accountEmail = row.account_email;
      if (!reserved) {
        const o = await openRow(row.chat_id, row.custom_name, rowCrypto);
        if (!o) { logError("config.openRow", {}); continue; }
        chatId = o.chatId;
        customName = o.customName;
        if (isAddressKey(row.account_email)) {
          // アドレスを置き換えた行は、暗号化した中身に元のアドレスを持っている
          if (!o.accountEmail) { logError("config.openRow.noAccount", {}); continue; }
          accountEmail = o.accountEmail;
        }
        // メールの中身を D1 に置かない（絶対ルール1）。以前の形式で残っていた本体は、ここで取り除く
        customName = stripPinnedBodies(customName) ?? null;
      }
      const rank = (isAddressKey(row.user_email) ? 4 : 0) + (isAddressKey(row.account_email) ? 2 : 0) + (isSealedChatId(row.chat_id) ? 1 : 0);
      const key = `${accountEmail}\u0000${chatId}`;
      const prev = opened.get(key);
      if (prev && prev.rank >= rank) { duplicates.push(row); continue; }
      if (prev) duplicates.push(prev.source);
      opened.set(key, {
        account_email: accountEmail, chat_id: chatId, custom_name: customName,
        is_pinned: row.is_pinned, is_hidden: row.is_hidden, hidden_at_date: row.hidden_at_date, unhide_on_new: row.unhide_on_new,
        source: row, rank,
      });
    }

    // 古い形の行・本体の残っている行を、今の保存の形に置き換える（同じバッチで書いて消すので途中で失われない）。
    // 失敗しても画面への応答は止めない（次に読んだときにまた試す）
    try {
      const stmts = [];
      let rewritten = 0;
      for (const o of opened.values()) {
        const reserved = isReservedRow(o.account_email);
        const account = await targetAccountKey(o.account_email);
        let chat = o.chat_id;
        let custom = o.custom_name ?? null;
        if (!reserved) {
          const sealed = await sealRow(o.chat_id, o.custom_name, rowCrypto, WRITE_HASHED_ADDRESS ? o.account_email : undefined);
          if (sealed) { chat = sealed.chatId; custom = sealed.customName; }
          else custom = (await sealConfigName(custom, encryptSecret)) ?? null;
        }
        const src = o.source;
        const sameKeys = src.user_email === targetUser && src.account_email === account && src.chat_id === chat;
        // 中身を書き直す必要があるか：本体が残っている、または（段階2で）元のアドレスをまだ中身に持っていない
        let contentStale = false;
        if (!reserved && isSealedChatId(src.chat_id)) {
          const srcOpened = await openRow(src.chat_id, src.custom_name, rowCrypto);
          contentStale = !srcOpened
            || stripPinnedBodies(srcOpened.customName) !== srcOpened.customName
            || (WRITE_HASHED_ADDRESS && !srcOpened.accountEmail);
        } else if (!reserved) {
          contentStale = true; // 平文の chat_id の行は暗号化して置き換える
        }
        if (sameKeys && !contentStale) continue;
        if (!reserved && !isSealedChatId(chat)) continue; // 鍵が無く暗号化できないときは、今の行をそのまま使う
        stmts.push(db.prepare(UPSERT_SQL).bind(targetUser, account, chat, custom, o.is_pinned ?? 0, o.is_hidden ?? 0, o.hidden_at_date ?? null, o.unhide_on_new ?? 0));
        if (!sameKeys) stmts.push(db.prepare(DELETE_ROW_SQL).bind(src.user_email, src.account_email, src.chat_id));
        rewritten++;
      }
      for (const row of duplicates) stmts.push(db.prepare(DELETE_ROW_SQL).bind(row.user_email, row.account_email, row.chat_id));
      if (stmts.length > 0) {
        await db.batch(stmts);
        logInfo("config.migrateRows", { count: rewritten });
      }
    } catch (e) {
      logError("config.migrateRows", { count: rows.length }, e);
    }

    // 暗号化して保存した値（相手の名前を含む roomId など）を、画面に返す前に復号する
    const configs = await Promise.all(Array.from(opened.values())
      .filter(o => !accountFilter || o.account_email === accountFilter)
      .map(async (o) => ({
        account_email: o.account_email, chat_id: o.chat_id,
        custom_name: await revealConfigName(o.custom_name, decryptSecret),
        is_pinned: o.is_pinned, is_hidden: o.is_hidden, hidden_at_date: o.hidden_at_date, unhide_on_new: o.unhide_on_new,
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
  const user = await userKeys(session.user.email);
  const targetUser = WRITE_HASHED_ADDRESS && user.hashed ? user.hashed : user.plain;

  try {
    const body = await request.json();
    if (!body.account_email) return NextResponse.json({ error: "account_email is required" }, { status: 400 });
    if (typeof body.chat_id !== "string" || !body.chat_id) return NextResponse.json({ error: "chat_id is required" }, { status: 400 });
    const accountEmail = String(body.account_email);
    const db = getCloudflareContext().env.DB;
    // メールの中身（以前の形式のピン留めの本体）は、送られてきても保存しない（絶対ルール1）
    const customName = stripPinnedBodies(typeof body.custom_name === "string" ? body.custom_name : null) ?? null;
    const flags = [body.is_pinned ? 1 : 0, body.is_hidden ? 1 : 0, body.hidden_at_date || null, body.unhide_on_new ? 1 : 0] as const;

    const account = await targetAccountKey(accountEmail);
    const sealed = await sealRow(body.chat_id, customName, rowCrypto, WRITE_HASHED_ADDRESS ? accountEmail : undefined);
    const chat = sealed ? sealed.chatId : body.chat_id;
    const custom = sealed ? sealed.customName : ((await sealConfigName(customName, encryptSecret)) || null);
    // 同じ設定の古い形の行（平文のアドレス・平文の chat_id）が残っていれば消す
    const userKeysList = [user.plain, user.hashed || user.plain];
    const accountKeys = [accountEmail, (await addressKeyFor(accountEmail, hmacId)) || accountEmail];
    const chatKeys = [body.chat_id, chat];
    await db.batch([
      db.prepare(UPSERT_SQL).bind(targetUser, account, chat, custom, ...flags),
      db.prepare(`DELETE FROM chat_configs WHERE user_email IN (?, ?) AND account_email IN (?, ?) AND chat_id IN (?, ?)
                  AND NOT (user_email = ? AND account_email = ? AND chat_id = ?)`)
        .bind(...userKeysList, ...accountKeys, ...chatKeys, targetUser, account, chat),
    ]);

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    logError("config.save", {}, error);
    return NextResponse.json({ error: "Database Error", details: errorMessage(error) }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await userKeys(session.user.email);

  try {
    const { searchParams } = new URL(request.url);
    const chatId = searchParams.get("chat_id");
    const accountEmail = searchParams.get("account_email");
    if (!chatId) return NextResponse.json({ error: "chat_id is required" }, { status: 400 });
    if (!accountEmail) return NextResponse.json({ error: "account_email is required" }, { status: 400 });

    const db = getCloudflareContext().env.DB;
    // 古い形・新しい形のどれで保存されていても消す
    const sealedChat = await hmacId(chatId);
    const userKeysList = [user.plain, user.hashed || user.plain];
    const accountKeys = [accountEmail, (await addressKeyFor(accountEmail, hmacId)) || accountEmail];
    const chatKeys = [chatId, sealedChat ? `${SEALED_CHAT_ID_PREFIX}${sealedChat}` : chatId];
    await db.prepare("DELETE FROM chat_configs WHERE user_email IN (?, ?) AND account_email IN (?, ?) AND chat_id IN (?, ?)")
      .bind(...userKeysList, ...accountKeys, ...chatKeys).run();

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    logError("config.delete", {}, error);
    return NextResponse.json({ error: "Database Error", details: errorMessage(error) }, { status: 500 });
  }
}
