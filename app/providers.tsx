"use client";
// ログイン状態（next-auth）をページ全体に配る。layout.tsx をサーバー側の部品にするため、ここに分けた
import { SessionProvider } from "next-auth/react";

export default function Providers({ children }: { children: React.ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>;
}
