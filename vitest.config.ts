import { defineConfig } from "vitest/config";

// Workers 非依存の純粋関数（app/lib配下）だけをテストするため、
// 環境はNode標準のままでよい（jsdomやWorkersランタイムのエミュレーションは不要）
export default defineConfig({
  test: {
    include: ["app/**/*.test.ts"],
  },
});
