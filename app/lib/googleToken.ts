// Googleのアクセストークン取得・リフレッシュを一元化する。メインアカウント（auth.tsのjwtコールバック）と
// 追加連携アカウント（フェーズ4のメール取得）の両方がこの関数を通ることで、リフレッシュロジックの
// 二重管理を避ける。
//
// 同一アカウントに対して同時に複数リクエストが来ても、リフレッシュ処理は1回だけ実行されるよう
// メモリ上でPromiseを共有する（Edge Runtimeはリクエストごとにインスタンスが分離される場合があるため、
// これは「同一インスタンス内での同時実行」を防ぐ簡易的な対策に留まる。より厳密な排他制御が必要になった
// 場合は、D1に一時的な「リフレッシュ中フラグ」を持たせる方式に拡張できる）
type TokenResult = { accessToken: string; expiresAt: number; refreshToken?: string };

const inFlightRefreshes = new Map<string, Promise<TokenResult>>();

export async function getValidAccessToken(
  accountEmail: string,
  currentAccessToken: string | null,
  expiresAt: number | null,
  refreshToken: string,
): Promise<TokenResult> {
  if (currentAccessToken && expiresAt && Date.now() < expiresAt - 60_000) {
    return { accessToken: currentAccessToken, expiresAt };
  }

  const existing = inFlightRefreshes.get(accountEmail);
  if (existing) return existing;

  const refreshPromise = (async () => {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });
    const tokens: any = await res.json();
    if (!res.ok) throw tokens;
    // Googleは新しいリフレッシュトークンを返す場合があり、その場合は呼び出し側で保存し直す必要がある
    // （ローテーション後に古いリフレッシュトークンを使い続けるとinvalid_grantで失効するため）
    return {
      accessToken: tokens.access_token as string,
      expiresAt: Date.now() + tokens.expires_in * 1000,
      refreshToken: tokens.refresh_token as string | undefined,
    };
  })();

  inFlightRefreshes.set(accountEmail, refreshPromise);
  try {
    return await refreshPromise;
  } finally {
    inFlightRefreshes.delete(accountEmail);
  }
}
