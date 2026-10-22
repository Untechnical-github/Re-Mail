// auth.ts
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { getValidAccessToken } from "./app/lib/googleToken";
import { logError } from "./app/lib/safeLog";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { promoteLinkedAccount } from "./app/lib/linkedAccountsStore";
import { GOOGLE_OAUTH_SCOPE } from "./app/lib/googleScopes";

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
          scope: GOOGLE_OAUTH_SCOPE,
          prompt: "consent",
          access_type: "offline", // ★重要: これがあることでリフレッシュトークンがもらえる
          response_type: "code",
        },
      },
    }),
  ],
  callbacks: {
    async jwt({ token, account, trigger, session }) {
      // ⓪ ログイン中のアカウントだけをログアウトし、ほかにログインしているアカウントの1つに引き継ぐ（画面の useSession().update から）。
      // 引き継げるのは、今のアカウントに一緒にログインしているアカウントだけ（D1 に付いているものだけ。ほかの人のアカウントにはなれない）
      if (trigger === "update" && session && typeof (session as { switchTo?: unknown }).switchTo === "string" && token.email) {
        const to = (session as { switchTo: string }).switchTo;
        try {
          const next = await promoteLinkedAccount(getCloudflareContext().env.DB, token.email, to);
          if (!next) return token;
          return {
            ...token,
            sub: to,
            email: to,
            // 名前が取れていないときはアドレスを名前にしない（画面にアドレスが2回出るため。名前なしとして扱う）
            name: next.name ?? null,
            picture: next.picture ?? null,
            accessToken: next.accessToken ?? undefined,
            // 保存されたアクセストークンが無ければ、次の通信ですぐ取り直させる
            expiresAt: next.accessToken && next.expiresAt ? next.expiresAt : 0,
            refreshToken: next.refreshToken,
            error: undefined,
          };
        } catch (error: unknown) {
          logError("auth.switchAccount", {}, error);
          return token;
        }
      }

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

      // ③ 有効期限が切れていた場合：裏側でGoogleにアクセスし、新しい鍵をもらう（ユーザーには見えない）。
      // 追加連携アカウント（フェーズ4）と同じリフレッシュロジック・同時実行対策を共有する
      try {
        const result = await getValidAccessToken(
          token.email as string,
          null, // 期限切れと判定済みなので必ずリフレッシュさせる
          null,
          token.refreshToken as string,
        );

        return {
          ...token,
          accessToken: result.accessToken,
          expiresAt: result.expiresAt,
          // Googleは新しいリフレッシュトークンを返さない場合があるため、その場合は古いものを使い回す
          refreshToken: result.refreshToken ?? token.refreshToken,
        };
      } catch (error: unknown) {
        logError("token.refresh.main", {}, error);
        // Googleが「リフレッシュトークン自体が無効」と明言した場合のみ致命的エラーにする。
        // ネットワーク瞬断やGoogle側の一時的な障害まで同じ扱いにすると、
        // 一時的な不調のたびにサインアウト＆リロードが走ってしまうため。
        const code = (error as { error?: string } | null)?.error;
        const isPermanent = code === "invalid_grant" || code === "invalid_client";
        if (isPermanent) {
          return { ...token, error: "RefreshAccessTokenError" };
        }
        // 一時的な失敗：古いトークンのまま返し、次回アクセス時に再試行させる
        return token;
      }
    },
    async session({ session, token }) {
      // セッションオブジェクトにアクセストークンとエラー状態を乗せてAPIルートで使えるようにする
      session.accessToken = token.accessToken as string | undefined;
      session.error = token.error as string | undefined;
      return session;
    },
  },
});