// linked_accounts テーブルに保存する refresh_token / access_token を、Cloudflareの環境変数
// TOKEN_ENCRYPTION_KEY（base64エンコードされた32バイトのAES鍵）でAES-256-GCM暗号化する。
// これらのトークンはGmailへの継続的なアクセスを許す長期的な資格情報のため、D1へ平文で
// 置くのはリスクが大きい（D1への読み取りアクセスがあれば誰でもそのアカウントを使えてしまう）。
//
// 後方互換のための設計:
// - TOKEN_ENCRYPTION_KEY が未設定の場合は暗号化せず平文のまま返す（既存の挙動を壊さないが、
//   本番運用前に必ず設定することを強く推奨する。設定漏れに気づけるようconsole.warnを出す）
// - 復号時、値が "encv1:" で始まらない場合は暗号化前の古いデータとみなしてそのまま返す
//   （鍵導入前に保存された既存の連携アカウントのトークンを引き続き使えるようにするため）
// - 呼び出し側（resolveAccessToken）は、読み取った値が平文だったときに再暗号化して
//   書き戻すことで、使われるたびに徐々に暗号化済みへ移行していく

const ENC_PREFIX = "encv1:";
let warnedMissingKey = false;

async function importKey(): Promise<CryptoKey | null> {
  const keyB64 = process.env.TOKEN_ENCRYPTION_KEY;
  if (!keyB64) {
    if (!warnedMissingKey) {
      console.warn("TOKEN_ENCRYPTION_KEY is not set. linked_accounts の refresh_token/access_token が平文のまま保存されます。運用前に設定してください。");
      warnedMissingKey = true;
    }
    return null;
  }
  const raw = Uint8Array.from(atob(keyB64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin);
}
function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export async function encryptSecret(plain: string): Promise<string> {
  if (!plain) return plain;
  const key = await importKey();
  if (!key) return plain;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain));
  return `${ENC_PREFIX}${toBase64(iv)}:${toBase64(new Uint8Array(ciphertext))}`;
}

export async function decryptSecret(stored: string | null | undefined): Promise<string> {
  if (!stored) return stored || "";
  if (!stored.startsWith(ENC_PREFIX)) return stored; // 鍵導入前の平文データ（後方互換）
  const key = await importKey();
  if (!key) {
    // 暗号化済みデータがあるのに鍵が無い（鍵をローテーション/削除してしまった等）場合は
    // 復号不能なので、呼び出し側がリフレッシュ失敗として扱えるよう例外にする
    throw new Error("Cannot decrypt: TOKEN_ENCRYPTION_KEY is not set but stored value is encrypted");
  }
  const [, ivB64, dataB64] = stored.split(":");
  const iv = fromBase64(ivB64);
  const ciphertext = fromBase64(dataB64);
  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, ciphertext as BufferSource);
  return new TextDecoder().decode(plainBuf);
}

// 値が既に暗号化済み（＝再暗号化不要）かどうか
export function isEncrypted(stored: string | null | undefined): boolean {
  return !!stored && stored.startsWith(ENC_PREFIX);
}
