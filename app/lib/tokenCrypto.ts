// D1 に置く個人情報（linked_accounts のトークン・アドレス・表示名、chat_configs の中身）を、Cloudflare の環境変数
// TOKEN_ENCRYPTION_KEY（base64 エンコードされた32バイトの AES 鍵）で AES-256-GCM 暗号化する。
// トークンは Gmail への継続的なアクセスを許す長期的な資格情報のため、D1 へ平文で置かない（絶対ルール1）。
//
// - 鍵が無ければ、暗号化・復号・HMAC のどれも例外にする（平文のまま D1 に書く道を作らない。API は 500 を返す）
// - 復号できるのは「encv1:」で始まる値だけ。それ以外は例外にする（古い平文の値は 2026-10-23 にすべて消した）
// - TOKEN_ENCRYPTION_KEY を変える・消すと、D1 の暗号化済みの値がすべて読めなくなる。鍵を足すときは新旧どちらも読めるようにする

const ENC_PREFIX = "encv1:";

// 鍵が無いことを、ほかの失敗（壊れた値・Google 側の失効など）と見分けるための例外
export class EncryptionKeyMissingError extends Error {
  constructor() {
    super("TOKEN_ENCRYPTION_KEY is not set");
    this.name = "EncryptionKeyMissingError";
  }
}

function readKeyBytes(): Uint8Array {
  const keyB64 = process.env.TOKEN_ENCRYPTION_KEY;
  if (!keyB64) throw new EncryptionKeyMissingError();
  return Uint8Array.from(atob(keyB64), (c) => c.charCodeAt(0));
}

async function importKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", readKeyBytes() as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin);
}
function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// 空の値は中身が無いので、そのまま返す（呼び出し側は空なら NULL を書く）
export async function encryptSecret(plain: string): Promise<string> {
  if (!plain) return plain;
  const key = await importKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain));
  return `${ENC_PREFIX}${toBase64(iv)}:${toBase64(new Uint8Array(ciphertext))}`;
}

export async function decryptSecret(stored: string | null | undefined): Promise<string> {
  if (!stored) return "";
  if (!stored.startsWith(ENC_PREFIX)) throw new Error("Cannot decrypt: value is not encrypted");
  const key = await importKey();
  const [, ivB64, dataB64] = stored.split(":");
  const iv = fromBase64(ivB64 || "");
  const ciphertext = fromBase64(dataB64 || "");
  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, ciphertext as BufferSource);
  return new TextDecoder().decode(plainBuf);
}

// D1 の chat_id（相手の名前やアドレス）とアドレスのキーを、元に戻せない決まった値に置き換えるための HMAC。
// 同じ値なら同じ結果になるので、行を探す・上書きする・消すことはできる。
// 鍵は TOKEN_ENCRYPTION_KEY から HKDF で別の用途の鍵を作って使う（新しいシークレットを増やさないため）
let hmacKeyPromise: Promise<CryptoKey> | null = null;
function importHmacKey(): Promise<CryptoKey> {
  // 鍵が無いときは覚えずに毎回例外にする（あとから鍵を入れたら動くように）
  const raw = readKeyBytes();
  if (!hmacKeyPromise) {
    hmacKeyPromise = (async () => {
      const base = await crypto.subtle.importKey("raw", raw as BufferSource, "HKDF", false, ["deriveKey"]);
      return crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode("remail-chat-id-hmac-v1") },
        base,
        { name: "HMAC", hash: "SHA-256", length: 256 },
        false,
        ["sign"],
      );
    })();
  }
  return hmacKeyPromise;
}

export async function hmacId(value: string): Promise<string> {
  const key = await importHmacKey();
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
  // 行のキーに使うので、URL でも安全な文字だけにする（43文字）
  return toBase64(sig).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
