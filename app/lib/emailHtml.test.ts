import { describe, it, expect } from "vitest";
import { emailCsp, hasRemoteContent, prepareEmailHtml, replaceCidImages } from "./emailHtml";

describe("replaceCidImages", () => {
  const img = "data:image/png;base64,AAAA";
  it("cid: の参照を、大文字小文字・URL エンコードの違いを無視して置き換える", () => {
    const html = '<img src="cid:Logo@Example.com"><img src=cid:logo%40example.com><div style="background:url(cid:logo@example.com)">';
    expect(replaceCidImages(html, { "logo@example.com": img })).toBe(`<img src="${img}"><img src=${img}><div style="background:url(${img})">`);
  });

  it("取れなかった画像・壊れた URL エンコードの参照はそのまま残す", () => {
    expect(replaceCidImages('<img src="cid:none@example.com">', { "logo@example.com": img })).toBe('<img src="cid:none@example.com">');
    expect(replaceCidImages('<img src="cid:%E0%A4%A">', { x: img })).toBe('<img src="cid:%E0%A4%A">');
  });

  it("巨大な入力でも固まらない", () => {
    const big = "cid:" + "a".repeat(2_000_000);
    const start = performance.now();
    replaceCidImages(big, { a: img });
    expect(performance.now() - start).toBeLessThan(1500);
  });
});

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
