import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { editorSrcDoc } from "./composeEditor";

// 入力欄の iframe の守り（README §15「入力欄の iframe」）が、知らないうちに外れていないかを CI で止める。
// 攻撃の文字列を実際のブラウザで入れる E2E は remail-e2e/editor-test（CI では動かせないので作業報告に結果を書く）

describe("入力欄の iframe の中の CSP", () => {
  it("最初の HTML の <head> の先頭に CSP を置き、中身は入れない", () => {
    const html = editorSrcDoc(false);
    expect(html.startsWith('<!doctype html><html><head><meta http-equiv="Content-Security-Policy"')).toBe(true);
    expect(html).toMatch(/<body><\/body><\/html>$/);
  });
  it("default-src 'none' でスクリプトを止める。script-src・unsafe-eval・nonce を書かない", () => {
    const csp = editorSrcDoc(false).match(/content="([^"]+)"/)![1];
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toMatch(/script-src|unsafe-eval|nonce-/);
    expect(csp).toContain("img-src data: blob: cid:");
    expect(csp).toContain("font-src data:");
    expect(csp).not.toMatch(/connect-src|frame-src|form-action|https:.*(style|font)/);
  });
  it("「毎回読み込む」のときだけ、画像に https: を足す（CSS・フォントは足さない）", () => {
    const csp = editorSrcDoc(true).match(/content="([^"]+)"/)![1];
    expect(csp).toContain("img-src data: blob: cid: https:");
    expect(csp).toMatch(/font-src data:(;|$)/);
    expect(csp).toMatch(/style-src 'unsafe-inline'(;|$)/);
  });
});

describe("iframe の sandbox", () => {
  it("入力欄の iframe は allow-same-origin allow-scripts だけ（README §18.3）", () => {
    const src = readFileSync("app/components/ComposeEditor.tsx", "utf8");
    const sandboxes = src.match(/sandbox="[^"]*"/g) || [];
    expect(sandboxes).toEqual(['sandbox="allow-same-origin allow-scripts"']);
  });
  it("メール本文を表示する iframe には allow-scripts・allow-forms・allow-top-navigation を付けない", () => {
    // モーダルは app/components/modals/ に、画面の部品（チャット一覧・トーク画面・入力欄）は app/components/ に分けてあるので、その中のファイルもすべて見る
    const modalFiles = readdirSync("app/components/modals").filter(f => f.endsWith(".tsx")).map(f => `app/components/modals/${f}`);
    expect(modalFiles).toContain("app/components/modals/EmailModal.tsx");
    // 入力欄の iframe（ComposeEditor.tsx）は上のテストで別に見る
    const componentFiles = readdirSync("app/components").filter(f => f.endsWith(".tsx") && f !== "ComposeEditor.tsx").map(f => `app/components/${f}`);
    expect(componentFiles).toContain("app/components/Modals.tsx");
    for (const file of ["app/page.tsx", ...componentFiles, ...modalFiles]) {
      const src = readFileSync(file, "utf8");
      for (const s of src.match(/sandbox="[^"]*"/g) || []) expect(s).not.toMatch(/allow-scripts|allow-forms|allow-top-navigation/);
    }
  });
});
