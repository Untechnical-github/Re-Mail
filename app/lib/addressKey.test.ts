import { describe, it, expect } from "vitest";
import { addressKeyFor, lookupKeysFor, normalizeAddress, isAddressKey, ADDRESS_KEY_PREFIX } from "./addressKey";

const hmac = async (v: string) => Buffer.from(`h(${v})`).toString("base64url");

describe("addressKey", () => {
  it("大文字小文字・前後の空白が違っても同じ値になり、元のアドレスを含まない", async () => {
    const a = await addressKeyFor("User@Example.com ", hmac);
    expect(a).toBe(await addressKeyFor("user@example.com", hmac));
    expect(a!.startsWith(ADDRESS_KEY_PREFIX)).toBe(true);
    expect(a).not.toContain("user@example.com");
    expect(isAddressKey(a)).toBe(true);
    expect(isAddressKey("user@example.com")).toBe(false);
  });

  it("違うアドレスは違う値になる", async () => {
    expect(await addressKeyFor("a@example.com", hmac)).not.toBe(await addressKeyFor("b@example.com", hmac));
  });

  it("鍵が無い・空のアドレスは null", async () => {
    expect(await addressKeyFor("a@example.com", async () => null)).toBeNull();
    expect(await addressKeyFor("  ", hmac)).toBeNull();
    expect(normalizeAddress(" A@B.c ")).toBe("a@b.c");
  });

  it("探すときは平文と置き換えた値の両方を使う（移行の途中のため）", async () => {
    expect(await lookupKeysFor("a@example.com", hmac)).toEqual(["a@example.com", await addressKeyFor("a@example.com", hmac)]);
    expect(await lookupKeysFor("a@example.com", async () => null)).toEqual(["a@example.com"]);
  });
});
