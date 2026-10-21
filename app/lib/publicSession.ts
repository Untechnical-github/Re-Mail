// ブラウザに返すセッションから、サーバーだけが使う値（Gmail のアクセストークン）を取り除く。
// ページの上で何かのスクリプトが動いても、Gmail を読み書きできる鍵を持ち出せないようにするため（絶対ルール1）。
// サーバー側（API ルート）は auth() でこれまでどおりアクセストークンを受け取れる
const SERVER_ONLY_FIELDS = ["accessToken", "refreshToken", "expiresAt"] as const;

export function toPublicSession(session: unknown): unknown {
  if (!session || typeof session !== "object" || Array.isArray(session)) return session;
  const copy: Record<string, unknown> = { ...(session as Record<string, unknown>) };
  for (const f of SERVER_ONLY_FIELDS) delete copy[f];
  return copy;
}
