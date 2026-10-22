// Google に求める権限（OAuth スコープ）。最初のログイン（auth.ts）と、別のアカウントでもログインするとき
// （app/api/accounts/connect/route.ts）で同じものを使う。どのアカウントも同じ扱いにするため、ここ以外で書かない。
// 権限を増やすときは、理由を添えてユーザーに確認する（CLAUDE.md 絶対ルール1）
// - openid / email：どのアカウントかを確かめる
// - profile：名前とプロフィール画像（画面に出すだけ。認証や照合には使わない）
// - gmail.modify：メールの読み取り・送信・ラベルの付け外し（完全削除はできない）
export const GOOGLE_OAUTH_SCOPE = "openid email profile https://www.googleapis.com/auth/gmail.modify";
