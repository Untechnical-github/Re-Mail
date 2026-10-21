import { describe, it, expect } from "vitest";
import { revealConfigName, sealConfigName, hasPlainRoomId } from "./configCrypto";

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
