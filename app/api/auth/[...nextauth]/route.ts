// app/api/auth/[...nextauth]/route.ts
import type { NextRequest } from "next/server";
import { handlers } from "../../../../auth";
import { toPublicSession } from "../../../lib/publicSession";

// /api/auth/session の応答（ブラウザに返るセッション）からは、Gmail のアクセストークンを取り除く。
// セッション Cookie の更新（Set-Cookie）はそのまま通す
async function withoutServerOnlyFields(req: NextRequest, handler: (req: NextRequest) => Promise<Response>): Promise<Response> {
  const res = await handler(req);
  if (!new URL(req.url).pathname.endsWith("/session")) return res;
  if (!(res.headers.get("content-type") || "").includes("application/json")) return res;
  const json = await res.json().catch(() => undefined);
  const headers = new Headers(res.headers);
  // 中身を作り直すので、長さは付け直させる
  headers.delete("content-length");
  return new Response(JSON.stringify(toPublicSession(json) ?? null), { status: res.status, headers });
}

export const GET = (req: NextRequest) => withoutServerOnlyFields(req, handlers.GET);
export const POST = (req: NextRequest) => withoutServerOnlyFields(req, handlers.POST);
