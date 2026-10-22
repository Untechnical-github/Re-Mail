import { describe, it, expect } from "vitest";
import { sanitizeSyncedSettings, syncedSettingsKey } from "./syncedSettings";

describe("sanitizeSyncedSettings", () => {
  it("決まった名前・型の値だけを残す（知らない名前・違う型・自由な文字列は捨てる）", () => {
    expect(sanitizeSyncedSettings({ inbox: true, spam: "yes", iconLabels: false, note: "user@example.com", limit: 50 })).toEqual({ inbox: true, iconLabels: false });
    expect(sanitizeSyncedSettings(null)).toEqual({});
    expect(sanitizeSyncedSettings([true])).toEqual({});
    expect(sanitizeSyncedSettings("{}")).toEqual({});
  });

  it("アカウントの表示チェックボックスは、アドレスの形のキーと真偽値だけを、上限の件数まで残す", () => {
    const many = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`u${i}@example.com`, true]));
    expect(Object.keys(sanitizeSyncedSettings({ accounts: many }).accounts || {})).toHaveLength(50);
    expect(sanitizeSyncedSettings({ accounts: { "a@example.com": false, "not an address": true, "b@example.com": "no", [`${"x".repeat(400)}@example.com`]: true } }))
      .toEqual({ accounts: { "a@example.com": false } });
    expect(sanitizeSyncedSettings({ accounts: ["a@example.com"] })).toEqual({});
  });
});

describe("syncedSettingsKey", () => {
  it("名前の順番が違っても同じ設定なら同じ値になり、値が違えば違う値になる", () => {
    expect(syncedSettingsKey({ inbox: true, accounts: { "a@example.com": true, "b@example.com": false } }))
      .toBe(syncedSettingsKey({ accounts: { "b@example.com": false, "a@example.com": true }, inbox: true }));
    expect(syncedSettingsKey({ inbox: true })).not.toBe(syncedSettingsKey({ inbox: false }));
  });
});

describe("共通設定とアカウント設定", () => {
  it("updatedAt は 0 以上の数だけを残す", async () => {
    const { sanitizeSyncedSettings } = await import("./syncedSettings");
    expect(sanitizeSyncedSettings({ updatedAt: 5 })).toEqual({ updatedAt: 5 });
    expect(sanitizeSyncedSettings({ updatedAt: -1 })).toEqual({});
    expect(sanitizeSyncedSettings({ updatedAt: "5" })).toEqual({});
    expect(sanitizeSyncedSettings({ updatedAt: Infinity })).toEqual({});
  });

  it("画面が持つ共通設定だけを取り出す（updatedAt と移した alwaysLoadImages は外す）", async () => {
    const { pickCommonSettings } = await import("./syncedSettings");
    expect(pickCommonSettings({ inbox: true, iconLabels: false, alwaysLoadImages: true, updatedAt: 9, accounts: { "a@example.com": true } }))
      .toEqual({ inbox: true, iconLabels: false, accounts: { "a@example.com": true } });
  });

  it("アカウント設定は決まった名前の真偽値だけを残す", async () => {
    const { sanitizeAccountSettings } = await import("./syncedSettings");
    expect(sanitizeAccountSettings({ alwaysLoadImages: true, inbox: true, note: "x" })).toEqual({ alwaysLoadImages: true });
    expect(sanitizeAccountSettings({ alwaysLoadImages: "yes" })).toEqual({});
    expect(sanitizeAccountSettings(null)).toEqual({});
  });

  it("写しのうち一番新しいものを選び、同じ時刻（古い行どうし）ならログイン中のアカウントの分を選ぶ", async () => {
    const { newestCommonSettings } = await import("./syncedSettings");
    expect(newestCommonSettings([{ settings: { inbox: true, updatedAt: 10 }, preferred: true }, { settings: { inbox: false, updatedAt: 20 }, preferred: false }])).toEqual({ inbox: false, updatedAt: 20 });
    expect(newestCommonSettings([{ settings: { inbox: false }, preferred: false }, { settings: { inbox: true }, preferred: true }])).toEqual({ inbox: true });
    expect(newestCommonSettings([])).toEqual({});
  });
});
