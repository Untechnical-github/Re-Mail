import { describe, it, expect } from "vitest";
import { addressKeyFor, normalizeAddress, isAddressKey, ADDRESS_KEY_PREFIX } from "./addressKey";

const hmac = async (v: string) => Buffer.from(`h(${v})`).toString("base64url");

describe("addressKey", () => {
  it("大文字小文字・前後の空白が違っても同じ値になり、元のアドレスを含まない", async () => {
    const a = await addressKeyFor("User@Example.com ", hmac);
    expect(a).toBe(await addressKeyFor("user@example.com", hmac));
    expect(a.startsWith(ADDRESS_KEY_PREFIX)).toBe(true);
    expect(a).not.toContain("user@example.com");
    expect(isAddressKey(a)).toBe(true);
    expect(isAddressKey("user@example.com")).toBe(false);
  });

  it("違うアドレスは違う値になる", async () => {
    expect(await addressKeyFor("a@example.com", hmac)).not.toBe(await addressKeyFor("b@example.com", hmac));
  });

  it("空のアドレス・鍵が無い（HMAC が例外）ときは例外にし、平文のアドレスをキーにしない", async () => {
    await expect(addressKeyFor("  ", hmac)).rejects.toThrow();
    await expect(addressKeyFor("a@example.com", async () => { throw new Error("no key"); })).rejects.toThrow();
    expect(normalizeAddress(" A@B.c ")).toBe("a@b.c");
  });
});
