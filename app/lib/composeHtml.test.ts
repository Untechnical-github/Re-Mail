import { describe, it, expect } from "vitest";
import fixtures from "./__fixtures__/gmailCompose.json";
import {
  composeHtmlToText, normalizeComposeHtml, sanitizeHtml, isComposeBodyEmpty, withSignature, withQuote, signatureOf, sameSignature,
  buildQuoteHtml, mapImageSources, textToComposeHtml, imageDimensions, makeInlineContentId, isDangerousAttribute, isSafeUrl,
  normalizeCssColor, cssColorToHex, parseStyle, INDENT_STYLE, COMPOSE_LIMITS,
} from "./composeHtml";

// 純正 Gmail から実際に送ったメールの HTML とテキスト版（アドレス・名前・署名は例の値に置き換えてある）
const F = fixtures as Record<"format" | "image" | "table" | "reply", { html: string; text: string }>;

describe("テキスト版（純正の text/plain と同じ）", () => {
  for (const key of ["format", "image", "table", "reply"] as const) {
    it(`見本 ${key} の HTML から、純正と同じテキスト版を作る`, () => {
      expect(composeHtmlToText(F[key].html)).toBe(F[key].text);
    });
  }
});

describe("純正の形に整える", () => {
  it("純正の形の HTML（画像入りの新しいメール・返信）は、整えても変わらない", () => {
    expect(normalizeComposeHtml(F.image.html)).toBe(F.image.html.trim());
    expect(normalizeComposeHtml(F.reply.html)).toBe(F.reply.html.trim());
  });

  it("書式・表の見本は、整えてもテキスト版と書式が変わらない", () => {
    for (const key of ["format", "table"] as const) {
      const n = normalizeComposeHtml(F[key].html);
      expect(composeHtmlToText(n)).toBe(F[key].text);
      expect(normalizeComposeHtml(n)).toBe(n);
    }
    const n = normalizeComposeHtml(F.format.html);
    for (const frag of ['<b>太字</b>', '<i>斜体</i>', '<u>下線</u>', '<strike>取り消し線</strike>', '<font face="times new roman, serif">',
      '<font face="arial, sans-serif" size="1">', '<font color="#ff0000">', '<span style="background-color:rgb(255,255,0)">',
      '<div style="text-align:center">', '<ol><li>', '<ul><li>', `<blockquote style="${INDENT_STYLE}">`, 'class="gmail_quote"',
      '<a href="https://example.com/path?a=1&amp;b=2">']) {
      expect(n).toContain(frag);
    }
  });

  it("ブラウザごとの書き方を純正の書き方にそろえる", () => {
    const n = (h: string) => normalizeComposeHtml(h, "new");
    expect(n("<p>一</p><p>二</p>")).toBe('<div dir="ltr"><div>一</div><div>二</div></div>');
    expect(n("<div><strong>a</strong><em>b</em><s>c</s><del>d</del></div>")).toBe('<div dir="ltr"><div><b>a</b><i>b</i><strike>c</strike><strike>d</strike></div></div>');
    expect(n('<div><span style="font-weight: bold;">a</span><span style="font-style: italic; text-decoration: underline;">b</span></div>')).toBe('<div dir="ltr"><div><b>a</b><u><i>b</i></u></div></div>');
    expect(n('<div style="text-align: center;">a</div>')).toBe('<div dir="ltr"><div style="text-align:center">a</div></div>');
    expect(n('<blockquote style="margin: 0 0 0 40px; border: none; padding: 0px;"><div>a</div></blockquote>')).toBe(`<div dir="ltr"><blockquote style="${INDENT_STYLE}"><div>a</div></blockquote></div>`);
    expect(n('<div><span style="background-color: rgb(255, 255, 0);">a</span></div>')).toBe('<div dir="ltr"><div><span style="background-color:rgb(255,255,0)">a</span></div></div>');
    expect(n('<div><font color="rgb(255, 0, 0)">a</font></div>')).toBe('<div dir="ltr"><div><font color="#ff0000">a</font></div></div>');
  });

  it("Safari の「1行目だけ裸の文字」や <br> だけの行も、1行ずつの <div> にする", () => {
    expect(normalizeComposeHtml("一<div>二</div>", "new")).toBe('<div dir="ltr"><div>一</div><div>二</div></div>');
    expect(normalizeComposeHtml("一<br>二<br><br>三", "new")).toBe('<div dir="ltr"><div>一</div><div>二</div><div><br></div><div>三</div></div>');
    expect(normalizeComposeHtml("<div></div><div>a<br></div>", "new")).toBe('<div dir="ltr"><div><br></div><div>a</div></div>');
  });

  it("返信は、1行目を <div dir=\"ltr\"> の直下に置く（純正と同じ）", () => {
    const html = withQuote('<div dir="ltr"><div>一</div><div>二</div></div>', buildQuoteHtml("2026年1月1日(木) 10:00 相手 <other@example.com>:", null, "元の本文"));
    expect(html.startsWith('<div dir="ltr">一<div>二</div></div><br><div class="gmail_quote gmail_quote_container">')).toBe(true);
    expect(html).toContain('&lt;<a href="mailto:other@example.com">other@example.com</a>&gt;:');
  });

  it("入力欄だけの印（data-remail-*）は送る HTML に残さない", () => {
    expect(normalizeComposeHtml('<div data-remail-fold="1">a</div>', "new")).toBe('<div dir="ltr"><div>a</div></div>');
  });
});

describe("署名と引用", () => {
  const sig = '<div dir="ltr">署名テスト</div>';
  it("新しいメールの署名は、本文の後ろに空行2つと「-- 」を挟んで入る（純正と同じ）", () => {
    expect(withSignature("<div>本文</div>", sig, "new")).toBe(`<div dir="ltr"><div>本文</div><div><br></div><div><br></div><span class="gmail_signature_prefix">-- </span><br><div dir="ltr" class="gmail_signature" data-smartmail="gmail_signature">${sig}</div></div>`);
  });
  it("署名を入れ替えると、署名の部分だけが変わる", () => {
    const a = withSignature("<div>本文</div>", sig, "new");
    const b = withSignature(a, '<div dir="ltr">別の署名</div>', "new");
    expect(b).toContain("別の署名");
    expect(b).not.toContain("署名テスト");
    expect(b.match(/gmail_signature_prefix/g)?.length).toBe(1);
    expect(signatureOf(b)).toBe('<div dir="ltr">別の署名</div>');
  });
  it("署名を手で書き換えたかを、入れたときの署名と比べて分かる", () => {
    expect(sameSignature('<div dir="ltr">署名テスト</div>', "<div>署名テスト</div>")).toBe(true);
    expect(sameSignature('<div dir="ltr">署名テスト（直した）</div>', "<div>署名テスト</div>")).toBe(false);
  });
  it("引用は本文と署名の間に入り、外すと消える", () => {
    const withSig = withSignature("<div>本文</div>", sig, "reply");
    const q = withQuote(withSig, buildQuoteHtml("見出し:", null, "元"));
    expect(q.indexOf("gmail_quote_container")).toBeLessThan(q.indexOf("gmail_signature_prefix"));
    expect(q.indexOf("本文")).toBeLessThan(q.indexOf("gmail_quote_container"));
    const removed = withQuote(q, null);
    expect(removed).not.toContain("gmail_quote");
    expect(removed).toContain("署名テスト");
  });
  it("引用の元のメールの危ないものは、入れる前に取り除く", () => {
    const q = buildQuoteHtml("見出し:", '<div>元<img src=x onerror="alert(1)"><script>alert(2)</script></div>', "");
    expect(q).not.toMatch(/onerror|<script/i);
  });
});

describe("本文が空か", () => {
  it("署名と引用だけなら空、文字・画像・表があれば空ではない", () => {
    const empty = withQuote(withSignature("<div><br></div>", "<div>署名</div>", "reply"), buildQuoteHtml("h:", null, "元"));
    expect(isComposeBodyEmpty(empty)).toBe(true);
    expect(isComposeBodyEmpty(withSignature("<div>&nbsp;</div>", "<div>署名</div>", "new"))).toBe(true);
    expect(isComposeBodyEmpty("<div>a</div>")).toBe(false);
    expect(isComposeBodyEmpty('<div><img src="cid:ii_x0"></div>')).toBe(false);
    expect(isComposeBodyEmpty("<table><tr><td></td></tr></table>")).toBe(false);
  });
});

describe("安全化", () => {
  const attacks = [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "<IMG SRC=x OnErRoR=alert(1)>",
    '<img src="x" onerror\n=\n"alert(1)">',
    "<svg onload=alert(1)>",
    "<svg><script>alert(1)</script></svg>",
    '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
    '<a href="javascript:alert(1)">x</a>',
    '<a href="JaVaScRiPt:alert(1)">x</a>',
    '<a href="jav&#x61;script:alert(1)">x</a>',
    '<a href="jav&#97;script&colon;alert(1)">x</a>',
    '<a href="  java\tscript:alert(1)">x</a>',
    '<a href="vbscript:msgbox(1)">x</a>',
    '<a href="data:text/html,<script>alert(1)</script>">x</a>',
    '<math><a xlink:href="javascript:alert(1)">x</a></math>',
    '<math href="javascript:alert(1)">x</math>',
    '<base href="https://evil.example/">',
    '<meta http-equiv="refresh" content="0;url=https://evil.example/">',
    '<form action="https://evil.example/"><input name=a><button formaction="javascript:alert(1)">b</button></form>',
    '<object data="https://evil.example/x.swf"></object><embed src="https://evil.example/x">',
    '<link rel="stylesheet" href="https://evil.example/x.css">',
    '<div style="background:url(https://evil.example/t.png)">x</div>',
    '<div style="width:expression(alert(1))">x</div>',
    '<style>@import url(https://evil.example/x.css);</style>',
    '<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">',
    '<noscript><img src=x onerror=alert(1)></noscript>',
    '<template><img src=x onerror=alert(1)></template>',
    '<div onclick="alert(1)" onmouseover=alert(1)>x</div>',
    '<img srcset="https://evil.example/t.png 1x">',
  ];
  const DANGER = /<script|onerror|onload|onclick|onmouseover|javascript:|vbscript:|data:text|<iframe|<svg|<math|<base|<meta|<form|<input|<button|<object|<embed|<link|expression\(|@import|evil\.example\/t\.png|evil\.example\/x|srcset|svg\+xml|<noscript|<template/i;
  for (const a of attacks) {
    it(`取り除く: ${a.slice(0, 50)}`, () => {
      expect(sanitizeHtml(a, "paste")).not.toMatch(DANGER);
      expect(sanitizeHtml(a, "trusted")).not.toMatch(/<script|onerror|onload|onclick|onmouseover|javascript:|vbscript:|data:text|<iframe|<svg|<math|<base|<meta|<form|<input|<button|<object|<embed|<link|expression\(|@import|srcset|svg\+xml|<noscript|<template/i);
      expect(normalizeComposeHtml(a)).not.toMatch(/<script|onerror|onload|onclick|onmouseover|javascript:|vbscript:|data:text|<iframe|<svg|<math|<base|<meta|<form|<input|<button|<object|<embed|<link|expression\(|@import|srcset|svg\+xml|<noscript|<template/i);
    });
  }

  it("純正の書式（引用・下書き）は残す", () => {
    const html = F.format.html;
    const out = sanitizeHtml(html, "trusted");
    expect(composeHtmlToText(out)).toBe(F.format.text);
    expect(out).toContain('class="gmail_signature"');
  });

  it("貼り付けでは、ほかのページのクラス・幅・大きなフォントを持ち込まず、§2 の書式に置き換える", () => {
    const out = sanitizeHtml('<p class="x" style="width:900px;font-size:40px;font-weight:700;color:#ff0000">a</p><span style="font-family:Georgia">g</span><h1>見出し</h1>', "paste");
    expect(out).toBe('<div><font color="#ff0000"><b>a</b></font></div><font face="georgia, serif">g</font><div>見出し</div>');
  });

  it("貼り付けた表は、表の見た目の属性と style を残し、色を純正の書き方にする", () => {
    const out = sanitizeHtml('<table class="t" border="1" style="border-collapse:collapse;border:1px solid #999;position:absolute"><tr><td style="padding:4px;background:#eee;font-size:30px" onclick="x()">a</td></tr></table>', "paste");
    expect(out).toBe('<table border="1" style="border-collapse:collapse;border:1px solid rgb(153,153,153)"><tr><td style="padding:4px;background:rgb(238,238,238)">a</td></tr></table>');
  });

  it("リンクは貼り付けでは http・https・mailto だけ残す", () => {
    expect(isSafeUrl("a", "href", "https://example.com", "paste")).toBe(true);
    expect(isSafeUrl("a", "href", "mailto:a@example.com", "paste")).toBe(true);
    expect(isSafeUrl("a", "href", "ftp://example.com", "paste")).toBe(false);
    expect(isSafeUrl("img", "src", "data:image/png;base64,AAAA", "paste")).toBe(true);
    expect(isSafeUrl("img", "src", "cid:ii_abc0", "trusted")).toBe(true);
    expect(isDangerousAttribute("div", "onClick", "x")).toBe(true);
    expect(isDangerousAttribute("a", "href", "java\nscript:x")).toBe(true);
  });

  it("深い入れ子は上限で打ち切り、文字だけにする（固まらない）", () => {
    const deep = "<div>".repeat(5000) + "深い" + "</div>".repeat(5000);
    const start = Date.now();
    const out = sanitizeHtml(deep, "trusted");
    expect(Date.now() - start).toBeLessThan(2000);
    expect(out).toContain("深い");
    expect((out.match(/<div>/g) || []).length).toBeLessThanOrEqual(COMPOSE_LIMITS.maxDepth + 1);
  });

  it("巨大な入力・閉じていないタグ・壊れた属性でも固まらない", () => {
    const big = "<b>あ".repeat(200_000);
    const start = Date.now();
    sanitizeHtml(big, "paste");
    sanitizeHtml('<a href="' + "x".repeat(500_000), "paste");
    sanitizeHtml("<" + "a ".repeat(200_000), "trusted");
    composeHtmlToText("<div>" + "a<br>".repeat(100_000) + "</div>");
    expect(Date.now() - start).toBeLessThan(5000);
  });
});

describe("画像", () => {
  it("大きさは純正と同じ（最適は幅 558 まで、小はその 0.4 倍、元のサイズは付けない）", () => {
    expect(imageDimensions(1600, 900, "best")).toEqual({ width: 558, height: 314 });
    expect(imageDimensions(1600, 900, "small")).toEqual({ width: 223, height: 125 });
    expect(imageDimensions(240, 120, "best")).toEqual({ width: 240, height: 120 });
    expect(imageDimensions(1600, 900, "original")).toBeNull();
  });
  it("Content-ID は純正と同じ「ii_<8文字><番号>」", () => {
    expect(makeInlineContentId(0, 1_700_000_000_000, () => 0.5)).toMatch(/^ii_[0-9a-z]{8}0$/);
  });
  it("blob: を cid: に置き換え、対応の無い画像は外す", () => {
    const html = '<div><img src="blob:https://x/1" alt="a.png"><img src="blob:https://x/2"></div>';
    expect(mapImageSources(html, (src) => (src.endsWith("/1") ? "cid:ii_abcdefgh0" : null))).toBe('<div><img src="cid:ii_abcdefgh0" alt="a.png"></div>');
  });
});

describe("そのほか", () => {
  it("文字だけの古い下書きを行の HTML にする", () => {
    expect(textToComposeHtml("a\n\n<b>")).toBe("<div>a</div><div><br></div><div>&lt;b&gt;</div>");
  });
  it("色と style の書き方", () => {
    expect(normalizeCssColor("#999")).toBe("rgb(153,153,153)");
    expect(normalizeCssColor("rgb( 1, 2 ,3 )")).toBe("rgb(1,2,3)");
    expect(cssColorToHex("rgb(255, 0, 0)")).toBe("#ff0000");
    expect(parseStyle('font-family:"a;b", serif; color : red')).toEqual([["font-family", '"a;b", serif'], ["color", "red"]]);
  });
});

describe("ブラウザごとの違い（実機の E2E で見つかったもの）", () => {
  it("Firefox の align 属性を純正の style にする", () => {
    expect(normalizeComposeHtml('<div align="center">中央</div>', "new")).toBe('<div dir="ltr"><div style="text-align:center">中央</div></div>');
  });
  it("WebKit のリストの項目の最後の <br> を外す", () => {
    expect(normalizeComposeHtml("<ol><li>番号<br></li></ol>", "new")).toBe('<div dir="ltr"><ol><li>番号</li></ol></div>');
  });
  it("入力欄だけの印（たたむ印・画像の印・選んでいる画像）は、引用・署名の中でも外す", () => {
    const html = '<div dir="ltr">本文</div><br data-remail-fold="1"><div class="gmail_quote gmail_quote_container" data-remail-fold="1"><div dir="ltr" class="gmail_attr">h:<br></div><blockquote class="gmail_quote" style="padding-left:1ex"><img class="remail-selected" data-remail-cid="ii_a0" src="cid:ii_a0"></blockquote></div><div data-remail-fold="1"><br clear="all"></div><div data-remail-fold="1"><br></div><span class="gmail_signature_prefix" data-remail-fold="1">-- </span><br data-remail-fold="1"><div dir="ltr" class="gmail_signature" data-remail-fold="1">署名</div>';
    const n = normalizeComposeHtml(html);
    expect(n).not.toMatch(/data-remail|remail-selected/);
    expect(n).toBe('<div dir="ltr">本文</div><br><div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">h:<br></div><blockquote class="gmail_quote" style="padding-left:1ex"><img src="cid:ii_a0"></blockquote></div><div><br clear="all"></div><div><br></div><span class="gmail_signature_prefix">-- </span><br><div dir="ltr" class="gmail_signature">署名</div>');
  });
});

describe("Chrome のインデント・引用のボタン（本番の E2E で見つかったもの）", () => {
  it("割れた外側の <div dir=\"ltr\"> と、インデントの中に入り込んだものは外す", () => {
    const html = '<div dir="ltr"><div>一</div><div>二</div></div><blockquote style="margin: 0 0 0 40px; border: none; padding: 0px;"><div dir="ltr"><div style="text-align: left;"><div>インデント</div></div></div></blockquote><div>三</div>';
    expect(normalizeComposeHtml(html, "new")).toBe(`<div dir="ltr"><div>一</div><div>二</div><blockquote style="${INDENT_STYLE}"><div style="text-align:left"><div>インデント</div></div></blockquote><div>三</div></div>`);
  });
  it("本文の中の引用（引用のボタン）は整え、返信の引用の中は触らない", () => {
    const html = '<div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex"><font face="arial, sans-serif" size="2">引用の行</font></blockquote></div><br><div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">h:<br></div><blockquote class="gmail_quote" style="x:y"><font size="2">元</font></blockquote></div>';
    const n = normalizeComposeHtml(html, "reply");
    expect(n).toContain('<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex"><font face="arial, sans-serif">引用の行</font></blockquote>');
    expect(n).toContain('<font size="2">元</font>');
  });
  it("たたんで脇に持っていた署名が本文の後ろ（外側の囲みの外）にあっても、純正の並びに戻す", () => {
    const html = '<div dir="ltr"><div>本文</div></div><div><br></div><div><br></div><span class="gmail_signature_prefix">-- </span><br><div dir="ltr" class="gmail_signature" data-smartmail="gmail_signature"><div dir="ltr">署名</div></div>';
    expect(normalizeComposeHtml(html, "new")).toBe('<div dir="ltr"><div>本文</div><div><br></div><div><br></div><span class="gmail_signature_prefix">-- </span><br><div dir="ltr" class="gmail_signature" data-smartmail="gmail_signature"><div dir="ltr">署名</div></div></div>');
  });
});
