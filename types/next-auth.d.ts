import "next-auth";

declare module "next-auth" {
  interface Session {
    accessToken?: string;
    // リフレッシュトークンが失効したとき "RefreshAccessTokenError" が入る（auth.ts の session コールバック参照）
    error?: string;
  }
}
