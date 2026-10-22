import { describe, it, expect } from "vitest";
import { revealConfigName, sealConfigName, hasPlainRoomId, sealRow, openRow, isReservedRow, isSealedChatId, SEALED_CHAT_ID_PREFIX } from "./configCrypto";

const enc = async (v: string) => `encv1:${Buffer.from(v).toString("base64")}`;
const dec = async (v: string) => { if (!v.startsWith("encv1:")) throw new Error("bad"); return Buffer.from(v.slice(6), "base64").toString(); };

describe("configCrypto", () => {
  const plain = JSON.stringify({ forceFetch: true, roomId: "user@example.com\u0000相手" });

  it("保存するときは roomId を暗号化して roomIdEnc に置き換え、ほかの値はそのまま", async () => {
    const sealed = await sealConfigName(plain, enc);
    expect(sealed).not.toContain("相手");
    expect(JSON.parse(sealed!)).toEqual({ forceFetch: true, roomIdEnc: await enc("user@example.com\u0000相手") });
    expect(hasPlainRoomId(sealed)).toBe(false);
    expect(hasPlainRoomId(plain)).toBe(true);
  });

  it("読むときは roomIdEnc を復号して roomId に戻す（暗号化前の行はそのまま）", async () => {
    const sealed = await sealConfigName(plain, enc);
    expect(JSON.parse((await revealConfigName(sealed, dec))!)).toEqual(JSON.parse(plain));
    expect(await revealConfigName(plain, dec)).toBe(plain);
  });

  it("JSON でない名前・roomId の無い設定・壊れた JSON は変えない", async () => {
    for (const v of ["山田さん", JSON.stringify({ name: "G", isGroup: true }), "{壊れた", null, undefined, ""]) {
      expect(await sealConfigName(v, enc)).toBe(v);
      expect(await revealConfigName(v, dec)).toBe(v);
    }
  });

  it("復号できなければ roomId を空にして返す（例外にしない）", async () => {
    expect(JSON.parse((await revealConfigName(JSON.stringify({ forceFetch: true, roomIdEnc: "broken" }), dec))!)).toEqual({ forceFetch: true, roomId: "" });
  });
});

describe("行ごとの暗号化（chat_id と custom_name）", () => {
  const hmac = async (v: string) => Buffer.from(`h(${v})`).toString("base64url");
  const c = { hmac, encrypt: enc, decrypt: dec };

  it("chat_id は元に戻せない決まった値に、custom_name は元の chat_id ごと暗号化する。開くと元に戻る", async () => {
    const sealed = (await sealRow("田中太郎", JSON.stringify({ name: "田中さん", isGroup: false }), c))!;
    expect(sealed.chatId.startsWith(SEALED_CHAT_ID_PREFIX)).toBe(true);
    expect(sealed.chatId).not.toContain("田中");
    expect(sealed.customName).not.toContain("田中");
    expect((await sealRow("田中太郎", null, c))!.chatId).toBe(sealed.chatId); // 同じ相手なら同じ値
    expect(await openRow(sealed.chatId, sealed.customName, c)).toEqual({ chatId: "田中太郎", customName: JSON.stringify({ name: "田中さん", isGroup: false }) });
  });

  it("custom_name が空でも元に戻せる", async () => {
    const sealed = (await sealRow("a@example.com", null, c))!;
    expect(await openRow(sealed.chatId, sealed.customName, c)).toEqual({ chatId: "a@example.com", customName: null });
  });

  it("暗号化していない行はそのまま、壊れた行は null", async () => {
    expect(await openRow("田中太郎", "山田さん", c)).toEqual({ chatId: "田中太郎", customName: "山田さん" });
    expect(await openRow("h1:xxx", "broken", c)).toBeNull();
    expect(await openRow("h1:xxx", await enc(JSON.stringify({ n: "x" })), c)).toBeNull();
  });

  it("鍵が無ければ暗号化しない（null）", async () => {
    expect(await sealRow("田中太郎", null, { ...c, hmac: async () => null })).toBeNull();
  });

  it("予約行（account_email が空）を見分ける", () => {
    expect(isReservedRow("")).toBe(true);
    expect(isReservedRow("user@example.com")).toBe(false);
    expect(isSealedChatId("h1:abc")).toBe(true);
    expect(isSealedChatId("__GLOBAL_SETTINGS__")).toBe(false);
  });
});

describe("アカウントのアドレスも一緒に持つ", () => {
  const c = { hmac: async (v: string) => Buffer.from(`h(${v})`).toString("base64url"), encrypt: enc, decrypt: dec };
  it("accountEmail を渡すと、開いたときに元のアドレスが戻る（渡さなければ無い）", async () => {
    const s1 = (await sealRow("相手", "名前", c, "user@example.com"))!;
    expect(s1.customName).not.toContain("user@example.com");
    expect(await openRow(s1.chatId, s1.customName, c)).toEqual({ chatId: "相手", customName: "名前", accountEmail: "user@example.com" });
    const s2 = (await sealRow("相手", "名前", c))!;
    expect(await openRow(s2.chatId, s2.customName, c)).toEqual({ chatId: "相手", customName: "名前" });
  });
});
