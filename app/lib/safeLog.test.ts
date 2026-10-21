import { describe, it, expect } from "vitest";
import { buildLogRecord } from "./safeLog";

describe("buildLogRecord", () => {
  it("許可した項目だけを出す", () => {
    expect(buildLogRecord("error", "send.gmail", { status: 503, messageId: "18c2f0a1b2c3d4e5", threadId: "18c2f0a1b2c3d4e5", count: 3, durationMs: 12.6 }))
      .toEqual({ level: "error", op: "send.gmail", status: 503, messageId: "18c2f0a1b2c3d4e5", threadId: "18c2f0a1b2c3d4e5", count: 3, durationMs: 13 });
  });

  it("ID 欄にアドレスや件名が入っても出さない", () => {
    const r = buildLogRecord("error", "x", { messageId: "user@example.com", threadId: "見積書の件", reason: "user@example.com" });
    expect(r).toEqual({ level: "error", op: "x" });
  });

  it("処理名に個人情報を混ぜられたら処理名ごと伏せる", () => {
    expect(buildLogRecord("error", "refresh user@example.com").op).toBe("invalid-op");
  });

  it("エラーからは種類名と理由コードだけを取り出し、メッセージ本文は出さない", () => {
    const err = new TypeError("fetch failed for https://gmail.googleapis.com/...?q=from:user@example.com");
    const r = buildLogRecord("error", "list", {}, err);
    expect(r).toEqual({ level: "error", op: "list", errorName: "TypeError" });
    expect(JSON.stringify(r)).not.toContain("example.com");
  });

  it("OAuth と Gmail のエラー応答から理由コードを拾う", () => {
    expect(buildLogRecord("error", "refresh", {}, { error: "invalid_grant", error_description: "Token for user@example.com expired" }).reason).toBe("invalid_grant");
    expect(buildLogRecord("error", "send", {}, { error: { code: 429, message: "Quota for user@example.com", errors: [{ reason: "rateLimitExceeded" }] } }).reason).toBe("rateLimitExceeded");
  });

  it("理由コードの欄に文章が入っていたら出さない", () => {
    expect(buildLogRecord("error", "x", {}, { error: "Token for user@example.com expired" }).reason).toBeUndefined();
  });

  it("文字列や null のエラーでも落ちない", () => {
    expect(buildLogRecord("warn", "x", {}, "user@example.com")).toEqual({ level: "warn", op: "x" });
    expect(buildLogRecord("warn", "x", {}, null)).toEqual({ level: "warn", op: "x" });
  });
});
