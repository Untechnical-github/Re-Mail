import { defineConfig } from "vitest/config";

// Edge Runtime非依存の純粋関数（app/lib配下）だけをテストするため、
// 環境はNode標準のままでよい（jsdomやedgeランタイムのエミュレーションは不要）
export default defineConfig({
  test: {
    include: ["app/**/*.test.ts"],
  },
});
