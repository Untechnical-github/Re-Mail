import { NextResponse } from "next/server";

export const runtime = 'edge';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const name = searchParams.get("name") || "U";
  
  // 表示用の頭文字を1文字抽出
  const initial = name.charAt(0).toUpperCase();

  // 名前の文字列から一貫したハッシュ値を計算（毎回同じ名前には同じ色が割り当てられる）
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  
  // チャット画面（ダークテーマ）に馴染むミドル〜ダークトーンのHSLカラーに調整
  const h = Math.abs(hash) % 360;
  const s = 55; // 鮮やかさ
  const l = 45; // 明るさ
  const backgroundColor = `hsl(${h}, ${s}%, ${l}%)`;

  // 超軽量なSVG画像を生成
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40">
      <rect width="40" height="40" fill="${backgroundColor}"/>
      <text x="20" y="25" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="16" font-weight="bold" fill="#ffffff" text-anchor="middle">${initial}</text>
    </svg>
  `.trim();

  // Cloudflareのエッジサーバーに完全に保存させる（2回目以降はサーバーすら叩かれず0秒返却）
  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=2592000, s-maxage=2592000, immutable",
    },
  });
}