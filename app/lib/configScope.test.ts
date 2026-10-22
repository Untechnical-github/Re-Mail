import { describe, it, expect } from "vitest";
import { isSharedConfig } from "./configScope";

describe("isSharedConfig", () => {
  it("対象アカウントを決めていないフィルター（アクション・フィルターグループ）だけが全アカウント共通", () => {
    expect(isSharedConfig({ filterAction: "hide", filterCriteria: {} })).toBe(true);
    expect(isSharedConfig({ isGroup: true, filterCriteria: {} })).toBe(true);
    expect(isSharedConfig({ filterAction: "hide", filterCriteria: { accountEmail: "a@example.com" } })).toBe(false);
    expect(isSharedConfig({ isGroup: true, filterCriteria: { accountEmail: "a@example.com" } })).toBe(false);
  });
  it("宛先で作るグループ・チャットの設定・空は共通にしない", () => {
    expect(isSharedConfig({ isGroup: true })).toBe(false);
    expect(isSharedConfig({})).toBe(false);
    expect(isSharedConfig(undefined)).toBe(false);
    expect(isSharedConfig(null)).toBe(false);
  });
});
