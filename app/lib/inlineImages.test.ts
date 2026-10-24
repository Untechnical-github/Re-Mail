import { describe, it, expect } from "vitest";
import { validateInlineImages, INLINE_IMAGE_LIMITS } from "./inlineImages";
import { buildMimeSegments } from "./mime";

const img = (i: number) => ({ contentId: `ii_abcdefgh${i}`, filename: "画像.png", mimeType: "image/png", data: "iVBORw0KGgo=" });

describe("validateInlineImages", () => {
  it("正しい形の画像だけを受け付ける", () => {
    const r = validateInlineImages([img(0), img(1)]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.images.map(i => i.contentId)).toEqual(["ii_abcdefgh0", "ii_abcdefgh1"]);
  });
  it("1つでも形が違えば全体を断る（黙って落とさない）", () => {
    expect(validateInlineImages([img(0), { ...img(1), contentId: "<x>" }]).ok).toBe(false);
    expect(validateInlineImages([{ ...img(0), mimeType: "image/svg+xml" }]).ok).toBe(false);
    expect(validateInlineImages([{ ...img(0), mimeType: "text/html" }]).ok).toBe(false);
    expect(validateInlineImages([img(0), img(0)]).ok).toBe(false);
    expect(validateInlineImages("x").ok).toBe(false);
    expect(validateInlineImages([null]).ok).toBe(false);
  });
  it("枚数と大きさの上限", () => {
    expect(validateInlineImages(Array.from({ length: INLINE_IMAGE_LIMITS.maxImages + 1 }, (_, i) => img(i))).ok).toBe(false);
    expect(validateInlineImages([{ ...img(0), data: "A".repeat(Math.ceil(INLINE_IMAGE_LIMITS.maxImageBytes * 4 / 3) + 8) }]).ok).toBe(false);
  });
  it("純正と同じ multipart/related のインライン画像になる（Content-ID・inline・X-Attachment-Id）", () => {
    const r = validateInlineImages([img(0)]);
    if (!r.ok) throw new Error("ng");
    const text = buildMimeSegments({ to: "a@example.com", subject: "s", text: "t", html: '<div><img src="cid:ii_abcdefgh0"></div>', inline: r.images }).map(x => (typeof x === "string" ? x : "")).join("");
    expect(text).toMatch(/Content-Type: multipart\/related;/);
    expect(text).toMatch(/Content-Disposition: inline; filename\*?=/);
    expect(text).toMatch(/^Content-ID: <ii_abcdefgh0>$/m);
    expect(text).toMatch(/^X-Attachment-Id: ii_abcdefgh0$/m);
  });
});
