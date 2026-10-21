import { describe, it, expect } from "vitest";
import { emailCsp, hasRemoteContent, prepareEmailHtml } from "./emailHtml";

describe("emailCsp", () => {
  it("既定ではリモートの画像・CSS・フォントを読み込ませない", () => {
    const csp = emailCsp(false);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("img-src data: blob: cid:");
    expect(csp).not.toMatch(/img-src \*/);
    expect(csp).not.toMatch(/style-src \*/);
  });

  it("「画像を表示」の後はリモートを許すが、スクリプトは許さない", () => {
    const csp = emailCsp(true);
    expect(csp).toMatch(/img-src \*/);
    expect(csp).not.toContain("script-src");
    expect(csp).toContain("default-src 'none'");
  });
});

describe("hasRemoteContent", () => {
  it("リモートの画像・背景・CSS を見つける", () => {
    expect(hasRemoteContent('<img src="https://example.com/a.png">')).toBe(true);
    expect(hasRemoteContent("<img alt=x src=//example.com/a.png>")).toBe(true);
    expect(hasRemoteContent('<td style="background:url(\'http://example.com/b.png\')">')).toBe(true);
    expect(hasRemoteContent('<table background="https://example.com/c.png">')).toBe(true);
    expect(hasRemoteContent('<link rel="stylesheet" href="https://example.com/s.css">')).toBe(true);
  });

  it("埋め込み画像やリンクだけなら false", () => {
    expect(hasRemoteContent('<img src="cid:abc"><img src="data:image/png;base64,AAAA"><a href="https://example.com">x</a>')).toBe(false);
  });
});

describe("prepareEmailHtml", () => {
  it("head の先頭に CSP を入れる", () => {
    const out = prepareEmailHtml('<html><head><link rel="stylesheet" href="https://example.com/s.css"></head><body>x</body></html>', false);
    expect(out.indexOf("Content-Security-Policy")).toBeLessThan(out.indexOf("<link"));
  });

  it("head が無ければ包んで入れる", () => {
    const out = prepareEmailHtml("<p>本文</p>", false);
    expect(out.startsWith('<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy"')).toBe(true);
    expect(out).toContain("<body><p>本文</p></body>");
  });

  it("外部へ移動させる meta refresh を取り除く", () => {
    const out = prepareEmailHtml('<head><META HTTP-EQUIV="Refresh" content="0;url=https://example.com/track"></head>', false);
    expect(out).not.toMatch(/refresh/i);
  });
});
