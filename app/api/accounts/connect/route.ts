import { NextResponse, NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { auth } from "../../../../auth";
import { saveLinkedAccount } from "../../../lib/linkedAccountsStore";
import type { GoogleTokenResponse } from "../../../lib/googleToken";
import { logError } from "../../../lib/safeLog";


// 追加のGoogleアカウントを連携するための、NextAuth本体のログインとは別系統のOAuthフロー。
// このエンドポイント自身が「①Googleへリダイレクト」と「②codeを受け取ってトークン交換」の
// 両方を兼ねる（GoogleのOAuthコールバックは1つのURLに固定登録する必要があるため）。
// 事前に、GoogleのOAuthクライアント設定の「承認済みのリダイレクトURI」に、
// このルートの絶対URL（例: https://re-mail.eusng90912.workers.dev/api/accounts/connect）を追加しておく必要がある。
const STATE_COOKIE = "remail_link_state";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.redirect(new URL("/", request.url));

  const code = request.nextUrl.searchParams.get("code");
  const redirectUri = `${request.nextUrl.origin}/api/accounts/connect`;

  if (!code) {
    // ①: Googleの同意画面へリダイレクトする。CSRF対策のstateをhttpOnly cookieに保存しておき、
    // コールバック時に一致するか確認する
    const state = crypto.randomUUID();
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email https://www.googleapis.com/auth/gmail.modify",
      access_type: "offline",
      prompt: "consent select_account", // consent必須: refresh_tokenを毎回確実に受け取るため
      state,
    });
    const res = NextResponse.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
    res.cookies.set(STATE_COOKIE, state, { httpOnly: true, secure: true, sameSite: "lax", maxAge: 600, path: "/api/accounts/connect" });
    return res;
  }

  // ②: Googleからのコールバック。stateを検証してからcodeをトークンに交換する
  const returnedState = request.nextUrl.searchParams.get("state");
  const savedState = request.cookies.get(STATE_COOKIE)?.value;
  if (!returnedState || !savedState || returnedState !== savedState) {
    return NextResponse.redirect(new URL("/?accountLinkError=state_mismatch", request.url));
  }

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }),
    });
    const tokens = (await tokenRes.json()) as GoogleTokenResponse;
    if (!tokenRes.ok) throw tokens;
    if (!tokens.refresh_token) {
      // prompt=consentを必ず付けているので通常は起きないはずだが、念のため
      return NextResponse.redirect(new URL("/?accountLinkError=no_refresh_token", request.url));
    }

    const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const userInfo = (await userInfoRes.json()) as { email?: string; name?: string; picture?: string };
    const accountEmail = userInfo.email as string | undefined;
    if (!accountEmail) throw new Error("Failed to resolve account email from userinfo");

    // refresh_token/access_tokenはGmailへの継続的なアクセスを許す長期的な資格情報のため、
    // D1に平文では置かず暗号化してから保存する（TOKEN_ENCRYPTION_KEY未設定時は平文のまま。
    // tokenCrypto.ts参照）
    // トークンの暗号化・アドレスの置き換えは linkedAccountsStore.ts で行う。
    // name/pictureは表示専用（アイコン設定でアバターを出すため）で、認証・照合には一切使わない
    const db = getCloudflareContext().env.DB;
    await saveLinkedAccount(db, session.user.email, accountEmail, {
      refreshToken: tokens.refresh_token,
      accessToken: tokens.access_token || null,
      expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null,
      name: userInfo.name || null,
      picture: userInfo.picture || null,
    });

    const res = NextResponse.redirect(new URL(`/?accountLinked=${encodeURIComponent(accountEmail)}`, request.url));
    res.cookies.delete(STATE_COOKIE);
    return res;
  } catch (error: unknown) {
    logError("accounts.connect", {}, error);
    return NextResponse.redirect(new URL("/?accountLinkError=1", request.url));
  }
}
