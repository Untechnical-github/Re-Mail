import { describe, it, expect } from "vitest";
import { gmailOpenUrl, gmailDraftsUrl } from "./gmailLink";

describe("gmailOpenUrl", () => {
  it("アカウントとスレッドを指定して開く", () => {
    expect(gmailOpenUrl("user@example.com", "1a15f0aabbccdd01")).toBe("https://mail.google.com/mail/?authuser=user%40example.com#all/1a15f0aabbccdd01");
  });

  it("スレッドが無い・形が違う（送信直後の仮 ID など）ときは受信トレイを開く", () => {
    expect(gmailOpenUrl("user@example.com", "fake-123")).toBe("https://mail.google.com/mail/?authuser=user%40example.com#inbox");
    expect(gmailOpenUrl(null, null)).toBe("https://mail.google.com/mail/#inbox");
  });
});

describe("gmailDraftsUrl", () => {
  it("アカウントを選んで下書きを開く", () => {
    expect(gmailDraftsUrl("user@example.com")).toBe("https://mail.google.com/mail/?authuser=user%40example.com#drafts");
    expect(gmailDraftsUrl()).toBe("https://mail.google.com/mail/#drafts");
  });
});
