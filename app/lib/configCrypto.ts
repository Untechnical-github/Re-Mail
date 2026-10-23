// chat_configs の行を暗号化して D1 に置くための変換（絶対ルール1）。
// D1 の chat_id（相手の名前・アドレス、またはメッセージ ID）を「h1:」＋HMAC に置き換え、
// 元の chat_id・custom_name（自分で付けた名前・グループのメンバー・フィルターの語など）・アカウントのアドレスは
// まとめて暗号化して custom_name に入れる。画面とのやり取りは元の chat_id と custom_name で行う。
// 暗号化・復号・HMAC の関数は呼び出し側から渡す（tokenCrypto.ts。テストでは差し替える）。
// 予約行（account_email が空。__GLOBAL_SETTINGS__ / __ACCOUNT_SETTINGS__）は chat_id を置き換えず、中身だけを暗号化する（configStore.ts）

type Crypt = (value: string) => Promise<string>;

export const SEALED_CHAT_ID_PREFIX = "h1:";

export type RowCrypto = {
  hmac: (value: string) => Promise<string>;
  encrypt: Crypt;
  decrypt: Crypt;
};

// account_email が空の行は予約行
export function isReservedRow(accountEmail: string | null | undefined): boolean {
  return !accountEmail;
}

export function isSealedChatId(chatId: string | null | undefined): boolean {
  return !!chatId && chatId.startsWith(SEALED_CHAT_ID_PREFIX);
}

// 保存する形にする。元のアカウントのアドレスも一緒に暗号化して持つ（account_email 列は HMAC にしてあるので、そこからは戻せない）
export async function sealRow(chatId: string, customName: string | null | undefined, c: RowCrypto, accountEmail: string): Promise<{ chatId: string; customName: string }> {
  const hashed = await c.hmac(chatId);
  const envelope = JSON.stringify({ c: chatId, n: customName ?? null, a: accountEmail });
  return { chatId: SEALED_CHAT_ID_PREFIX + hashed, customName: await c.encrypt(envelope) };
}

// D1 の行を、画面に返す形（元の chat_id・custom_name・アカウント）に戻す。
// sealRow の形でない行・復号できない行・アカウントを持たない行は null（その行は返さない。ほかの行の表示は止めない）
export async function openRow(chatId: string, customName: string | null | undefined, c: RowCrypto): Promise<{ chatId: string; customName: string | null; accountEmail: string } | null> {
  if (!isSealedChatId(chatId)) return null;
  try {
    const env = JSON.parse(await c.decrypt(customName || "")) as { c?: unknown; n?: unknown; a?: unknown };
    if (typeof env.c !== "string" || !env.c) return null;
    if (typeof env.a !== "string" || !env.a) return null;
    return { chatId: env.c, customName: typeof env.n === "string" ? env.n : null, accountEmail: env.a };
  } catch {
    return null;
  }
}
