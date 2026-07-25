import { describe, it, expect } from "vitest";
import { encodeRoomKey, decodeRoomKey } from "./roomKey";

describe("roomKey", () => {
  it("encode/decodeの往復が一致する", () => {
    const encoded = encodeRoomKey("me@example.com", "田中太郎");
    expect(decodeRoomKey(encoded)).toEqual({ accountEmail: "me@example.com", localKey: "田中太郎" });
  });

  it("localKeyが空文字でも往復が一致する", () => {
    const encoded = encodeRoomKey("me@example.com", "");
    expect(decodeRoomKey(encoded)).toEqual({ accountEmail: "me@example.com", localKey: "" });
  });

  it("同じlocalKeyでもaccountEmailが違えば異なるroomKeyになる", () => {
    const a = encodeRoomKey("a@example.com", "田中太郎");
    const b = encodeRoomKey("b@example.com", "田中太郎");
    expect(a).not.toBe(b);
  });

  it("区切り文字を含むlocalKeyはエラーになる", () => {
    expect(() => encodeRoomKey("me@example.com", "田中\u0000太郎")).toThrow();
  });

  it("区切り文字を含まないroomKeyのdecodeはエラーになる", () => {
    expect(() => decodeRoomKey("no-separator-here")).toThrow();
  });
});
