import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // 位置引数の並びを保つために残している未使用の引数は、先頭に _ を付けて明示する
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", caughtErrors: "none" }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // ビルド・ローカル実行で生成されるファイル（Lint の対象外）
    ".open-next/**",
    ".wrangler/**",
    ".vercel/**",
    // Next.js が自動生成する型ファイル
    "types/validator.ts",
    "types/routes.d.ts",
    "types/cache-life.d.ts",
  ]),
]);

export default eslintConfig;
