// D1 のキーにしている自分のアドレス（user_email・account_email）を、元に戻せない決まった値に置き換える。
// Re:Mail をほかの人も使うので、D1 だけが漏れても利用者のアドレス一覧が分からないようにする（絶対ルール1）。
// HMAC の計算は呼び出し側から渡す（tokenCrypto.ts の hmacId。テストでは差し替える）

export const ADDRESS_KEY_PREFIX = "a1:";

// 大文字小文字や前後の空白の違いで別の値にならないようにする（違うと「自分の設定が見つからない」になるため）
export function normalizeAddress(email: string): string {
  return (email || "").trim().toLowerCase();
}

export function isAddressKey(value: string | null | undefined): boolean {
  return !!value && value.startsWith(ADDRESS_KEY_PREFIX);
}

type Hmac = (value: string) => Promise<string | null>;

// アドレスを D1 のキーにする値。鍵が無ければ null（呼び出し側は平文のまま扱う）
export async function addressKeyFor(email: string, hmac: Hmac): Promise<string | null> {
  const n = normalizeAddress(email);
  if (!n) return null;
  // chat_id の HMAC と同じ鍵を使うので、用途の違う値と重ならないよう前に印を付けて計算する
  const h = await hmac(`addr:${n}`);
  return h ? ADDRESS_KEY_PREFIX + h : null;
}

// 移行の途中は平文の行と置き換えた行が混ざるので、両方で探す
export async function lookupKeysFor(email: string, hmac: Hmac): Promise<string[]> {
  const keys = [email];
  const hashed = await addressKeyFor(email, hmac);
  if (hashed) keys.push(hashed);
  return keys;
}
