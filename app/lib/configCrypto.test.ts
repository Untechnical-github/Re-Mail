import { describe, it, expect } from "vitest";
import { sealRow, openRow, isReservedRow, isSealedChatId, SEALED_CHAT_ID_PREFIX } from "./configCrypto";

const enc = async (v: string) => `encv1:${Buffer.from(v).toString("base64")}`;
const dec = async (v: string) => { if (!v.startsWith("encv1:")) throw new Error("bad"); return Buffer.from(v.slice(6), "base64").toString(); };
const hmac = async (v: string) => Buffer.from(`h(${v})`).toString("base64url");
const c = { hmac, encrypt: enc, decrypt: dec };
const A = "user@example.com";

describe("行ごとの暗号化（chat_id と custom_name とアカウント）", () => {
  it("chat_id は元に戻せない決まった値に、custom_name とアカウントは元の chat_id ごと暗号化する。開くと元に戻る", async () => {
    const custom = JSON.stringify({ name: "田中さん", forceFetch: true, roomId: `${A}\u0000田中太郎` });
    const sealed = await sealRow("田中太郎", custom, c, A);
    expect(sealed.chatId.startsWith(SEALED_CHAT_ID_PREFIX)).toBe(true);
    for (const s of ["田中", A]) {
      expect(sealed.chatId).not.toContain(s);
      expect(sealed.customName).not.toContain(s);
    }
    expect((await sealRow("田中太郎", null, c, A)).chatId).toBe(sealed.chatId); // 同じ相手なら同じ値
    expect(await openRow(sealed.chatId, sealed.customName, c)).toEqual({ chatId: "田中太郎", customName: custom, accountEmail: A });
  });

  it("custom_name が空でも元に戻せる", async () => {
    const sealed = await sealRow("a@example.com", null, c, A);
    expect(await openRow(sealed.chatId, sealed.customName, c)).toEqual({ chatId: "a@example.com", customName: null, accountEmail: A });
  });

  it("古い形式の行（平文の chat_id・アカウントを持たない中身）は読まない。壊れた行も null で、例外にしない", async () => {
    expect(await openRow("田中太郎", "山田さん", c)).toBeNull();
    expect(await openRow("h1:xxx", "broken", c)).toBeNull();
    expect(await openRow("h1:xxx", await enc(JSON.stringify({ n: "x" })), c)).toBeNull();
    expect(await openRow("h1:xxx", await enc(JSON.stringify({ c: "田中太郎", n: "x" })), c)).toBeNull();
    expect(await openRow("h1:xxx", await enc("{壊れた"), c)).toBeNull();
    expect(await openRow("h1:xxx", null, c)).toBeNull();
  });

  it("鍵が無い（HMAC・暗号化が例外）ときは例外にし、平文の形を返さない", async () => {
    await expect(sealRow("田中太郎", null, { ...c, hmac: async () => { throw new Error("no key"); } }, A)).rejects.toThrow();
    await expect(sealRow("田中太郎", null, { ...c, encrypt: async () => { throw new Error("no key"); } }, A)).rejects.toThrow();
  });

  it("予約行（account_email が空）を見分ける", () => {
    expect(isReservedRow("")).toBe(true);
    expect(isReservedRow(A)).toBe(false);
    expect(isSealedChatId("h1:abc")).toBe(true);
    expect(isSealedChatId("__GLOBAL_SETTINGS__")).toBe(false);
  });
});
