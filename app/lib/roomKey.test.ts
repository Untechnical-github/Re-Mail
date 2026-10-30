import { describe, it, expect } from "vitest";
import { encodeRoomKey, decodeRoomKey, localKeyFor, splitLocalKey } from "./roomKey";

describe("roomKey", () => {
  it("encode/decodeの往復が一致する", () => {
    const encoded = encodeRoomKey("me@example.com", "田中太郎");
    expect(decodeRoomKey(encoded)).toEqual({ accountEmail: "me@example.com", localKey: "田中太郎", ownAddress: "me@example.com", partnerKey: "田中太郎" });
  });

  it("localKeyが空文字でも往復が一致する", () => {
    const encoded = encodeRoomKey("me@example.com", "");
    expect(decodeRoomKey(encoded)).toEqual({ accountEmail: "me@example.com", localKey: "", ownAddress: "me@example.com", partnerKey: "" });
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

  it("自分のアドレス（主アドレス以外）を入れると往復でアカウント・自分のアドレス・相手が戻る", () => {
    const encoded = encodeRoomKey("me@example.com", "田中太郎", "Sales@Example.com");
    const d = decodeRoomKey(encoded);
    expect(d.accountEmail).toBe("me@example.com");
    expect(d.ownAddress).toBe("sales@example.com");
    expect(d.partnerKey).toBe("田中太郎");
    // ローカルキー（D1 の chat_id）は自分のアドレス入り。もう一度 encode しても二重にならない
    expect(encodeRoomKey("me@example.com", d.localKey)).toBe(encoded);
    expect(encodeRoomKey("me@example.com", d.localKey, "other@example.com")).toBe(encoded);
  });

  it("主アドレスを自分のアドレスに渡したときは今までと同じキー（大文字小文字は問わない）", () => {
    expect(encodeRoomKey("me@example.com", "田中太郎", "ME@example.com")).toBe(encodeRoomKey("me@example.com", "田中太郎"));
    expect(encodeRoomKey("me@example.com", "田中太郎", "")).toBe(encodeRoomKey("me@example.com", "田中太郎"));
  });

  it("同じ相手でも自分のアドレスが違えば別のroomKeyになる", () => {
    const a = encodeRoomKey("me@example.com", "田中太郎");
    const b = encodeRoomKey("me@example.com", "田中太郎", "sales@example.com");
    const c = encodeRoomKey("me@example.com", "田中太郎", "info@example.com");
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("localKeyFor / splitLocalKey の往復", () => {
    const k = localKeyFor("group:abc", "info@example.com", "me@example.com");
    expect(splitLocalKey(k, "me@example.com")).toEqual({ ownAddress: "info@example.com", partnerKey: "group:abc" });
    expect(splitLocalKey("田中", "Me@Example.com")).toEqual({ ownAddress: "me@example.com", partnerKey: "田中" });
  });
});
