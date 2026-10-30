import { describe, it, expect } from "vitest";
import { sanitizeSyncedSettings, syncedSettingsKey, sanitizeAccountSettings } from "./syncedSettings";
import { MAX_RECEIVE_ONLY_ADDRESSES } from "./ownAddresses";

describe("sanitizeSyncedSettings", () => {
  it("決まった名前・型の値だけを残す（知らない名前・違う型・自由な文字列は捨てる）", () => {
    expect(sanitizeSyncedSettings({ inbox: true, spam: "yes", iconLabels: false, note: "user@example.com", limit: 50 })).toEqual({ inbox: true, iconLabels: false });
    expect(sanitizeSyncedSettings(null)).toEqual({});
    expect(sanitizeSyncedSettings([true])).toEqual({});
    expect(sanitizeSyncedSettings("{}")).toEqual({});
    // 外部の画像の設定は今はアカウント設定なので、共通設定には残さない
    expect(sanitizeSyncedSettings({ alwaysLoadImages: true, inbox: false })).toEqual({ inbox: false });
  });

  it("アカウントの表示チェックボックスは、アドレスの形のキーと真偽値だけを、上限の件数まで残す", () => {
    const many = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`u${i}@example.com`, true]));
    expect(Object.keys(sanitizeSyncedSettings({ accounts: many }).accounts || {})).toHaveLength(50);
    expect(sanitizeSyncedSettings({ accounts: { "a@example.com": false, "not an address": true, "b@example.com": "no", [`${"x".repeat(400)}@example.com`]: true } }))
      .toEqual({ accounts: { "a@example.com": false } });
    expect(sanitizeSyncedSettings({ accounts: ["a@example.com"] })).toEqual({});
  });

  it("以前の共通設定にあった宛先の表示設定（送った・受け取ったメール）は、写すために真偽値だけを読む", () => {
    expect(sanitizeSyncedSettings({ showSentRecipients: true, showReceivedRecipients: false })).toEqual({ showSentRecipients: true, showReceivedRecipients: false });
    expect(sanitizeSyncedSettings({ showSentRecipients: "true", showReceivedRecipients: 1 })).toEqual({});
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

  it("画面が持つ共通設定だけを取り出す（updatedAt は外す）", async () => {
    const { pickCommonSettings } = await import("./syncedSettings");
    // 宛先の表示は今はアカウント設定なので、共通設定としては保存しない
    expect(pickCommonSettings({ inbox: true, iconLabels: false, showSentRecipients: true, showReceivedRecipients: false, updatedAt: 9, accounts: { "a@example.com": true } }))
      .toEqual({ inbox: true, iconLabels: false, accounts: { "a@example.com": true } });
  });

  it("アカウント設定は決まった名前の真偽値だけを残す", async () => {
    const { sanitizeAccountSettings } = await import("./syncedSettings");
    expect(sanitizeAccountSettings({ alwaysLoadImages: true, inbox: true, note: "x" })).toEqual({ alwaysLoadImages: true });
    expect(sanitizeAccountSettings({ alwaysLoadImages: "yes" })).toEqual({});
    expect(sanitizeAccountSettings(null)).toEqual({});
    expect(sanitizeAccountSettings({ showSentRecipients: true, showReceivedRecipients: false })).toEqual({ showSentRecipients: true, showReceivedRecipients: false });
    expect(sanitizeAccountSettings({ showSentRecipients: "true", showReceivedRecipients: 1 })).toEqual({});
  });

  it("以前の共通設定の宛先の表示を、まだ決めていないアカウントにだけ写す", async () => {
    const { legacyAccountSettingsToCopy } = await import("./syncedSettings");
    const accounts = { "a@example.com": {}, "b@example.com": { showSentRecipients: false }, "c@example.com": { showSentRecipients: true, showReceivedRecipients: false } };
    expect(legacyAccountSettingsToCopy({ showSentRecipients: true, showReceivedRecipients: true }, accounts)).toEqual({
      "a@example.com": { showSentRecipients: true, showReceivedRecipients: true },
      "b@example.com": { showReceivedRecipients: true },
    });
    // 共通設定に無い・読めなかったときは何も写さない
    expect(legacyAccountSettingsToCopy({ inbox: true }, accounts)).toEqual({});
    expect(legacyAccountSettingsToCopy(null, accounts)).toEqual({});
    expect(legacyAccountSettingsToCopy({ showSentRecipients: false }, {})).toEqual({});
  });

  it("写しのうち一番新しいものを選び、同じ時刻ならログインのセッションを持つアカウントの分を選ぶ", async () => {
    const { newestCommonSettings } = await import("./syncedSettings");
    expect(newestCommonSettings([{ settings: { inbox: true, updatedAt: 10 }, preferred: true }, { settings: { inbox: false, updatedAt: 20 }, preferred: false }])).toEqual({ inbox: false, updatedAt: 20 });
    expect(newestCommonSettings([{ settings: { inbox: false }, preferred: false }, { settings: { inbox: true }, preferred: true }])).toEqual({ inbox: true });
    expect(newestCommonSettings([])).toEqual({});
  });
});

describe("自分のアドレスの設定", () => {
  it("ownAddresses（チェックボックス）は「アカウント 自分のアドレス」の形のキーだけ残す", () => {
    const s = sanitizeSyncedSettings({ ownAddresses: { "me@example.com sales@example.com": false, "broken": false, "me@example.com x y@example.com": true, "me@example.com info@example.org": "no" } });
    expect(s.ownAddresses).toEqual({ "me@example.com sales@example.com": false });
  });
  it("receiveOnlyAddresses は形の正しいアドレスだけ・小文字・重なりなし・上限まで", () => {
    const many = Array.from({ length: MAX_RECEIVE_ONLY_ADDRESSES + 3 }, (_, i) => `a${i}@example.org`);
    const s = sanitizeAccountSettings({ receiveOnlyAddresses: ["Info@Example.org", "info@example.org", "bad", 1, ...many] });
    expect(s.receiveOnlyAddresses?.[0]).toBe("info@example.org");
    expect(s.receiveOnlyAddresses?.length).toBe(MAX_RECEIVE_ONLY_ADDRESSES);
    expect(s.receiveOnlyAddresses).not.toContain("bad");
    expect(sanitizeAccountSettings({ receiveOnlyAddresses: "info@example.org" }).receiveOnlyAddresses).toBeUndefined();
  });
});
