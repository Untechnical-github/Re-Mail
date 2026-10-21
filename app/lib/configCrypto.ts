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
