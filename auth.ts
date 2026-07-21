// auth.ts
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

export const { handlers, signIn, signOut, auth } = NextAuth({
  trustHost: true,
  secret: process.env.AUTH_SECRET,
  session: {
    strategy: "jwt",
    // ログインセッション自体は最低1年間保持する（Googleのリフレッシュトークンでアクセストークンは別途自動更新される）
    maxAge: 60 * 60 * 24 * 400, // 400日
    updateAge: 60 * 60 * 24, // 1日ごとにセッションの有効期限を延長
  },
  jwt: {
    maxAge: 60 * 60 * 24 * 400,
  },
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      authorization: {
        params: {
          scope: "openid email profile https://www.googleapis.com/auth/gmail.modify",
          prompt: "consent",
          access_type: "offline", // ★重要: これがあることでリフレッシュトークンがもらえる
          response_type: "code",
        },
      },
    }),
  ],
  callbacks: {
    async jwt({ token, account }) {
      // ① 初回ログイン時：Googleから貰った鍵と、その有効期限、そして「更新用のマスターキー（リフレッシュトークン）」を保存する
      if (account) {
        return {
          ...token,
          accessToken: account.access_token,
          expiresAt: account.expires_at ? account.expires_at * 1000 : Date.now() + 3600 * 1000,
          refreshToken: account.refresh_token,
        };
      }

      // ② その後の通信時：現在の時刻が有効期限より前（1分ほどの余裕を持たせる）なら、今の鍵をそのまま使う
      if (Date.now() < (token.expiresAt as number) - 60 * 1000) {
        return token;
      }

      // ③ 有効期限が切れていた場合：裏側でGoogleにアクセスし、新しい鍵をもらう（ユーザーには見えない）
      try {
        const response = await fetch("https://oauth2.googleapis.com/token", {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: process.env.GOOGLE_CLIENT_ID!,
            client_secret: process.env.GOOGLE_CLIENT_SECRET!,
            grant_type: "refresh_token",
            refresh_token: token.refreshToken as string,
          }),
          method: "POST",
        });

        const tokens = await response.json();

        if (!response.ok) throw tokens;

        return {
          ...token,
          accessToken: tokens.access_token,
          expiresAt: Date.now() + tokens.expires_in * 1000,
          // Googleは新しいリフレッシュトークンを返さない場合があるため、その場合は古いものを使い回す
          refreshToken: tokens.refresh_token ?? token.refreshToken,
        };
      } catch (error: any) {
        console.error("Error refreshing access token", error);
        // Googleが「リフレッシュトークン自体が無効」と明言した場合のみ致命的エラーにする。
        // ネットワーク瞬断やGoogle側の一時的な障害まで同じ扱いにすると、
        // 一時的な不調のたびにサインアウト＆リロードが走ってしまうため。
        const isPermanent = error?.error === "invalid_grant" || error?.error === "invalid_client";
        if (isPermanent) {
          return { ...token, error: "RefreshAccessTokenError" };
        }
        // 一時的な失敗：古いトークンのまま返し、次回アクセス時に再試行させる
        return token;
      }
    },
    async session({ session, token }) {
      // セッションオブジェクトにアクセストークンとエラー状態を乗せてAPIルートで使えるようにする
      (session as any).accessToken = token.accessToken;
      (session as any).error = token.error;
      return session;
    },
  },
});