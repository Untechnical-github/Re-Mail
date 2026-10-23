// D1 のキーにしている自分のアドレス（user_email・account_email）を、元に戻せない決まった値に置き換える。
// D1 だけが漏れても利用者のアドレス一覧が分からないようにする（絶対ルール1）。
// HMAC の計算は呼び出し側から渡す（tokenCrypto.ts の hmacId。鍵が無ければ例外。テストでは差し替える）

export const ADDRESS_KEY_PREFIX = "a1:";

// 大文字小文字や前後の空白の違いで別の値にならないようにする（違うと「自分の設定が見つからない」になるため）
export function normalizeAddress(email: string): string {
  return (email || "").trim().toLowerCase();
}

export function isAddressKey(value: string | null | undefined): boolean {
  return !!value && value.startsWith(ADDRESS_KEY_PREFIX);
}

type Hmac = (value: string) => Promise<string>;

// アドレスを D1 のキーにする値。空のアドレスは例外（誰のものでもない行を作らない）
export async function addressKeyFor(email: string, hmac: Hmac): Promise<string> {
  const n = normalizeAddress(email);
  if (!n) throw new Error("address is empty");
  // chat_id の HMAC と同じ鍵を使うので、用途の違う値と重ならないよう前に印を付けて計算する
  return ADDRESS_KEY_PREFIX + (await hmac(`addr:${n}`));
}
