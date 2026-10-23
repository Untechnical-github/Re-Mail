import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { encryptSecret, decryptSecret, hmacId, EncryptionKeyMissingError } from "./tokenCrypto";

// テスト用の鍵（本物の鍵ではない）
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

describe("tokenCrypto（鍵がある）", () => {
  beforeEach(() => { process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY; });

  it("hmacId は同じ値なら同じ、違う値なら違う結果になり、元の値を含まない", async () => {
    const a1 = await hmacId("田中太郎");
    expect(a1).toBe(await hmacId("田中太郎"));
    expect(a1).not.toBe(await hmacId("田中次郎"));
    expect(a1).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("暗号化して encv1: の値にし、復号すると元に戻る（日本語も）", async () => {
    const sealed = await encryptSecret("user@example.com 田中");
    expect(sealed.startsWith("encv1:")).toBe(true);
    expect(sealed).not.toContain("example.com");
    expect(await decryptSecret(sealed)).toBe("user@example.com 田中");
  });

  it("古い形式（encv1: でない平文）は読まずに例外にする", async () => {
    await expect(decryptSecret("rt-plain-token")).rejects.toThrow();
    await expect(decryptSecret("user@example.com")).rejects.toThrow();
  });

  it("壊れた暗号文は例外にする（固まらない）", async () => {
    await expect(decryptSecret("encv1:xxx")).rejects.toThrow();
    await expect(decryptSecret("encv1:")).rejects.toThrow();
  });

  it("空の値は空のまま", async () => {
    expect(await encryptSecret("")).toBe("");
    expect(await decryptSecret(null)).toBe("");
  });
});

describe("tokenCrypto（鍵が無い）", () => {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env.TOKEN_ENCRYPTION_KEY; delete process.env.TOKEN_ENCRYPTION_KEY; });
  afterEach(() => { process.env.TOKEN_ENCRYPTION_KEY = saved; });

  it("暗号化・復号・HMAC のどれも例外にし、平文を返さない", async () => {
    await expect(encryptSecret("rt-secret")).rejects.toBeInstanceOf(EncryptionKeyMissingError);
    await expect(hmacId("田中太郎")).rejects.toBeInstanceOf(EncryptionKeyMissingError);
    process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY;
    const sealed = await encryptSecret("rt-secret");
    delete process.env.TOKEN_ENCRYPTION_KEY;
    await expect(decryptSecret(sealed)).rejects.toBeInstanceOf(EncryptionKeyMissingError);
  });

  it("あとから鍵を入れれば HMAC が使える（鍵が無いことを覚えたままにしない）", async () => {
    await expect(hmacId("x")).rejects.toThrow();
    process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY;
    expect(await hmacId("x")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
