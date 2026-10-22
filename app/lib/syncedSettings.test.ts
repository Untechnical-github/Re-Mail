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
