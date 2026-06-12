// app/api/auth/[...nextauth]/route.ts
import NextAuth from "next-auth";
import { authOptions } from "../../../../auth"; // ← 先ほど作った auth.ts へのパス

const handler = NextAuth(authOptions);

// Next.jsのルール通り、GETとPOSTだけをexportする
export { handler as GET, handler as POST };