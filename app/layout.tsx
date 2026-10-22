import Providers from "./providers";
import "./globals.css";

// ページを開くたびにサーバーで描画する。CSP の nonce は開くたびに変わり、Next.js がそれを起動用のスクリプトに
// 付けるので、ビルド時に作った HTML（nonce が無い）を返すとスクリプトが止まって画面が動かなくなるため
export const dynamic = "force-dynamic";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
