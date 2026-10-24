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
      // React Compiler を使う前提のルール。Re:Mail は React Compiler を使っておらず、
      // イベント処理の中のコードまで「描画中」と判定する誤検知が多いため、知らせるだけ（警告）にする
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/immutability": "warn",
      // ログにメールアドレスや本文を出さないよう、console は直接使わず app/lib/safeLog.ts を通す
      "no-console": "error",
    },
  },
  {
    // 生の HTML の文字列を DOM に直接入れない（相手が送ってきたメールの HTML がスクリプトとして動く入口になるため）。
    // 入力欄に HTML を入れるときは app/lib/composeHtml.ts の安全化（insertSafeHtml / replaceContent / safeFragment）を通す。
    // 例外は composeHtml.ts の中の1か所だけ（その行に理由を書いて外している）
    files: ["app/**/*.ts", "app/**/*.tsx"],
    rules: {
      "no-restricted-syntax": ["error",
        { selector: "AssignmentExpression[left.property.name=/^(innerHTML|outerHTML)$/]", message: "innerHTML / outerHTML に代入しない。composeHtml.ts の安全化を通して入れる" },
        { selector: "CallExpression[callee.property.name=/^(insertAdjacentHTML|write|writeln)$/]", message: "insertAdjacentHTML / document.write を使わない。composeHtml.ts の安全化を通して入れる" },
        { selector: "CallExpression[callee.property.name='execCommand'][arguments.0.value=/^insertHTML$/i]", message: "execCommand(\"insertHTML\") は composeHtml.ts の insertSafeHtml だけで使う" },
        { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: "dangerouslySetInnerHTML を使わない" },
      ],
    },
  },
  {
    // safeLog だけは、形を確かめた項目を console に書き出す役目なので console を使ってよい
    files: ["app/lib/safeLog.ts"],
    rules: { "no-console": "off" },
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
