// chat_configs.custom_name（JSON）のうち、相手の名前・アドレスを含む値を暗号化して D1 に置くための変換。
// 今はメッセージ単位のピン留め・非表示の roomId（「アカウント＋相手の名前」の複合キー）が対象。
// 暗号化・復号の関数は呼び出し側から渡す（tokenCrypto.ts の encryptSecret / decryptSecret。テストでは差し替える）。
//
// 古いコードに戻しても壊れないよう、2段階で入れる:
// 段階1: 読むときに roomIdEnc を復号して roomId として返す（保存はまだ平文の roomId）
// 段階2: 保存するときに roomId を roomIdEnc に置き換える（段階1のコードは roomIdEnc を読めるので、戻しても壊れない）

type Crypt = (value: string) => Promise<string>;

function parseObject(customName: string | null | undefined): Record<string, unknown> | null {
  if (!customName || !customName.startsWith("{")) return null;
  try {
    const v = JSON.parse(customName);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// D1 から読んだ custom_name を、画面に返す形にする（roomIdEnc → roomId）。
// 復号できなければ roomId を空にする（空でもメッセージ単位の設定として扱われ、どのルームにも属さないだけで壊れない）
export async function revealConfigName(customName: string | null | undefined, decrypt: Crypt): Promise<string | null | undefined> {
  const obj = parseObject(customName);
  if (!obj || typeof obj.roomIdEnc !== "string") return customName;
  const { roomIdEnc, ...rest } = obj;
  let roomId = "";
  try { roomId = await decrypt(roomIdEnc as string); } catch { roomId = ""; }
  return JSON.stringify({ ...rest, roomId });
}

// 保存する custom_name の roomId を暗号化して roomIdEnc に置き換える（段階2で使う）
export async function sealConfigName(customName: string | null | undefined, encrypt: Crypt): Promise<string | null | undefined> {
  const obj = parseObject(customName);
  if (!obj || typeof obj.roomId !== "string" || !obj.roomId) return customName;
  const { roomId, ...rest } = obj;
  return JSON.stringify({ ...rest, roomIdEnc: await encrypt(roomId as string) });
}

// 平文の roomId が残っている（段階2より前に保存された）行か
export function hasPlainRoomId(customName: string | null | undefined): boolean {
  const obj = parseObject(customName);
  return !!obj && typeof obj.roomId === "string" && !!obj.roomId;
}

// ---- 行ごとの暗号化（chat_id と custom_name をまとめて隠す） ----
// D1 の chat_id（相手の名前・アドレス、またはメッセージ ID）を「h1:」＋HMAC に置き換え、
// 元の chat_id と custom_name（自分で付けた名前・グループのメンバー・フィルターの語など）は
// まとめて暗号化して custom_name に入れる。画面とのやり取りは、これまでどおり元の chat_id と custom_name で行う

export const SEALED_CHAT_ID_PREFIX = "h1:";

export type RowCrypto = {
  hmac: (value: string) => Promise<string | null>;
  encrypt: Crypt;
  decrypt: Crypt;
};

// account_email が空の行は __GLOBAL_SETTINGS__ などの予約行（個人情報を含まない）なので、そのまま扱う
export function isReservedRow(accountEmail: string | null | undefined): boolean {
  return !accountEmail;
}

export function isSealedChatId(chatId: string | null | undefined): boolean {
  return !!chatId && chatId.startsWith(SEALED_CHAT_ID_PREFIX);
}

// 保存する形にする。鍵が無い（HMAC が作れない）ときは null（呼び出し側は平文のまま保存する）
export async function sealRow(chatId: string, customName: string | null | undefined, c: RowCrypto): Promise<{ chatId: string; customName: string } | null> {
  const hashed = await c.hmac(chatId);
  if (!hashed) return null;
  const envelope = JSON.stringify({ c: chatId, n: customName ?? null });
  return { chatId: SEALED_CHAT_ID_PREFIX + hashed, customName: await c.encrypt(envelope) };
}

// D1 の行を、画面に返す形（元の chat_id と custom_name）に戻す。暗号化していない行はそのまま。
// 復号できない行は null（その行は返さない。ほかの行の表示は止めない）
export async function openRow(chatId: string, customName: string | null | undefined, c: RowCrypto): Promise<{ chatId: string; customName: string | null } | null> {
  if (!isSealedChatId(chatId)) return { chatId, customName: customName ?? null };
  try {
    const env = JSON.parse(await c.decrypt(customName || "")) as { c?: unknown; n?: unknown };
    if (typeof env.c !== "string" || !env.c) return null;
    return { chatId: env.c, customName: typeof env.n === "string" ? env.n : null };
  } catch {
    return null;
  }
}
