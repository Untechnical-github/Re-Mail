import { describe, it, expect } from "vitest";
import { toPublicSession } from "./publicSession";

describe("toPublicSession", () => {
  it("アクセストークンなどサーバーだけが使う値を取り除き、ほかはそのまま返す", () => {
    const s = { user: { email: "user@example.com", name: "U" }, expires: "2027-01-01", accessToken: "ya29.x", error: undefined };
    expect(toPublicSession(s)).toEqual({ user: { email: "user@example.com", name: "U" }, expires: "2027-01-01", error: undefined });
    expect(s.accessToken).toBe("ya29.x"); // 元のオブジェクトは変えない
  });

  it("ログインしていない（null）や配列はそのまま", () => {
    expect(toPublicSession(null)).toBeNull();
    expect(toPublicSession([1])).toEqual([1]);
  });
});
