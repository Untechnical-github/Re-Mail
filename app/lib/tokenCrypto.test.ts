import { describe, it, expect, beforeAll } from "vitest";

describe("hmacId", () => {
  beforeAll(() => {
    // テスト用の鍵（本物の鍵ではない）
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  });

  it("同じ値なら同じ、違う値なら違う結果になり、元の値を含まない", async () => {
    const { hmacId } = await import("./tokenCrypto");
    const a1 = await hmacId("田中太郎");
    const a2 = await hmacId("田中太郎");
    const b = await hmacId("田中次郎");
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(a1).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
