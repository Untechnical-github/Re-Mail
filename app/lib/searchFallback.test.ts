import { describe, it, expect } from "vitest";
import { shouldTriggerServerSearch, markServerSearched } from "./searchFallback";

describe("shouldTriggerServerSearch", () => {
  it("ローカル結果が0件なら初回はサーバー検索すべきと判定する", () => {
    const seen = new Set<string>();
    expect(shouldTriggerServerSearch(seen, "keyword", "subject", 0)).toBe(true);
    expect(shouldTriggerServerSearch(seen, "keyword", "body", 0)).toBe(true);
  });

  it("ローカル結果が1件以上あればサーバー検索しない", () => {
    const seen = new Set<string>();
    expect(shouldTriggerServerSearch(seen, "keyword", "subject", 3)).toBe(false);
  });

  it("同じキーワード×フィールドは、一度searchedとして記録すれば再度の呼び出しでは発火しない", () => {
    const seen = new Set<string>();
    // 1回目のレンダー相当: 発火すべき
    expect(shouldTriggerServerSearch(seen, "keyword", "subject", 0)).toBe(true);
    markServerSearched(seen, "keyword", "subject");

    // allUniqueEmailsが他の理由（60秒ポーリング等）で更新され、同じ副作用が
    // 再評価されても、ローカル結果が引き続き0件のままなら二度と発火しない
    for (let i = 0; i < 10; i++) {
      expect(shouldTriggerServerSearch(seen, "keyword", "subject", 0)).toBe(false);
    }
  });

  it("subjectとbodyは独立して管理される（片方だけ検索済みでも、もう片方は撃てる）", () => {
    const seen = new Set<string>();
    markServerSearched(seen, "keyword", "subject");
    expect(shouldTriggerServerSearch(seen, "keyword", "subject", 0)).toBe(false);
    expect(shouldTriggerServerSearch(seen, "keyword", "body", 0)).toBe(true);
  });

  it("キーワードが変われば新しい組み合わせとして再び検索できる", () => {
    const seen = new Set<string>();
    markServerSearched(seen, "old-keyword", "subject");
    expect(shouldTriggerServerSearch(seen, "new-keyword", "subject", 0)).toBe(true);
  });

  it("モーダルを開き直す想定（Setをクリア）で、同じキーワードも再び検索できる", () => {
    const seen = new Set<string>();
    markServerSearched(seen, "keyword", "subject");
    seen.clear();
    expect(shouldTriggerServerSearch(seen, "keyword", "subject", 0)).toBe(true);
  });
});
