import { describe, it, expect } from "vitest";
import { replySubjectFor, buildReferences, pickSendAs, signatureToText, formatQuoteHeader, composeReplyBodies, escapeHtml, extractHtmlBodyInner, forwardSubjectFor, composeForwardBodies } from "./replyCompose";

describe("replySubjectFor", () => {
  it("Re: を1回だけ付ける", () => {
    expect(replySubjectFor("見積書の件")).toBe("Re: 見積書の件");
    expect(replySubjectFor("Re: 見積書の件")).toBe("Re: 見積書の件");
    expect(replySubjectFor("RE:見積書の件")).toBe("RE:見積書の件");
    expect(replySubjectFor("")).toBe("Re: ");
    expect(replySubjectFor("(件名なし)")).toBe("Re: ");
  });
});

describe("buildReferences", () => {
  it("元の References の後ろに元の Message-ID を足す", () => {
    expect(buildReferences("<a@example.com> <b@example.com>", "<c@example.com>")).toBe("<a@example.com> <b@example.com> <c@example.com>");
  });

  it("References が無ければ Message-ID だけ、重複は1回", () => {
    expect(buildReferences(undefined, "<c@example.com>")).toBe("<c@example.com>");
    expect(buildReferences("<c@example.com>", "<c@example.com>")).toBe("<c@example.com>");
  });

  it("長いスレッドでは直近のものだけ残す", () => {
    const refs = Array.from({ length: 30 }, (_, i) => `<m${i}@example.com>`).join(" ");
    const out = buildReferences(refs, "<last@example.com>").split(" ");
    expect(out).toHaveLength(20);
    expect(out[19]).toBe("<last@example.com>");
  });

  it("改行や不正な文字列は取り込まない", () => {
    expect(buildReferences("<a@example.com>\r\nBcc: x@example.com", undefined)).toBe("<a@example.com>");
  });
});

describe("pickSendAs", () => {
  const list = [
    { sendAsEmail: "me@example.com", isPrimary: true, isDefault: true, signature: "主署名" },
    { sendAsEmail: "sales@example.com", displayName: "営業部", signature: "営業署名" },
  ];

  it("元のメールがエイリアス宛てなら、そのエイリアスから返す", () => {
    expect(pickSendAs(list, "相手 <a@example.com>, Sales@Example.com", "me@example.com")?.sendAsEmail).toBe("sales@example.com");
  });

  it("それ以外は既定の送信元", () => {
    expect(pickSendAs(list, "me@example.com", "me@example.com")?.sendAsEmail).toBe("me@example.com");
    expect(pickSendAs(list, "", "me@example.com")?.sendAsEmail).toBe("me@example.com");
  });

  it("設定が取れなければ null", () => {
    expect(pickSendAs([], "x@example.com", "me@example.com")).toBeNull();
  });
});

describe("signatureToText", () => {
  it("HTML の署名をテキストにする", () => {
    expect(signatureToText('<div dir="ltr">山田 太郎<br>株式会社&nbsp;Example<div>Tel: 03-0000-0000</div></div>')).toBe("山田 太郎\n株式会社 Example\nTel: 03-0000-0000");
  });
});

describe("formatQuoteHeader", () => {
  it("日本語版 Gmail と同じ見出し", () => {
    expect(formatQuoteHeader(new Date(2026, 0, 1, 9, 5), "相手 <a@example.com>")).toBe("2026年1月1日(木) 09:05 相手 <a@example.com>:");
  });
});

describe("composeReplyBodies", () => {
  const quote = { header: "2026年1月1日(木) 09:05 相手 <a@example.com>:", originalText: "1行目\n2行目" };

  it("署名も引用もなければ本文だけ", () => {
    expect(composeReplyBodies({ text: "了解です" })).toEqual({ text: "了解です", html: '<div dir="ltr">了解です</div>' });
  });

  it("本文 → 署名 → 引用 の順。テキスト版は > で引用", () => {
    const r = composeReplyBodies({ text: "了解です\n明日伺います", signatureHtml: "<b>山田</b>", quote });
    expect(r.text).toBe("了解です\n明日伺います\n\n-- \n山田\n\n2026年1月1日(木) 09:05 相手 <a@example.com>:\n> 1行目\n> 2行目");
    const sigAt = r.html.indexOf("gmail_signature");
    const quoteAt = r.html.indexOf("gmail_quote");
    expect(sigAt).toBeGreaterThan(0);
    expect(quoteAt).toBeGreaterThan(sigAt);
    expect(r.html).toContain("了解です<br>明日伺います");
    expect(r.html).toContain('<div dir="ltr" class="gmail_attr">2026年1月1日(木) 09:05 相手 &lt;a@example.com&gt;:<br></div>');
  });

  it("元の HTML があれば引用にそれを使い、無ければテキストを HTML にして使う", () => {
    expect(composeReplyBodies({ text: "x", quote: { ...quote, originalHtml: "<p>元</p>" } }).html).toContain("<blockquote class=\"gmail_quote\" style=\"margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex\"><p>元</p></blockquote>");
    expect(composeReplyBodies({ text: "x", quote }).html).toContain(">1行目<br>2行目</blockquote>");
  });

  it("本文中の HTML 記号はそのまま文字として送る（タグとして解釈させない）", () => {
    expect(composeReplyBodies({ text: "<script>a & b</script>" }).html).toBe('<div dir="ltr">&lt;script&gt;a &amp; b&lt;/script&gt;</div>');
    expect(escapeHtml('"')).toBe("&quot;");
  });
});

describe("extractHtmlBodyInner", () => {
  it("body の中身と属性を取り出す", () => {
    expect(extractHtmlBodyInner('<html><head><style>x</style></head><body bgcolor="#fff"><p>本文</p></body></html>')).toEqual({ inner: "<p>本文</p>", attrs: ' bgcolor="#fff"' });
  });

  it("body が無ければ html の中、それも無ければそのまま", () => {
    expect(extractHtmlBodyInner("<html><p>a</p></html>")).toEqual({ inner: "<p>a</p>", attrs: "" });
    expect(extractHtmlBodyInner("<p>a</p>")).toEqual({ inner: "<p>a</p>", attrs: "" });
  });
});

describe("forwardSubjectFor", () => {
  it("Fwd: を1回だけ付ける", () => {
    expect(forwardSubjectFor("見積書")).toBe("Fwd: 見積書");
    expect(forwardSubjectFor("Fwd: 見積書")).toBe("Fwd: 見積書");
    expect(forwardSubjectFor("FW: 見積書")).toBe("FW: 見積書");
    expect(forwardSubjectFor("(件名なし)")).toBe("Fwd: ");
  });
});

describe("composeForwardBodies", () => {
  const original = { from: "相手 <a@example.com>", date: new Date(2026, 0, 1, 9, 5), subject: "見積書", to: "me@example.com", cc: "c@example.com", text: "本文1\n本文2" };

  it("日本語版 Gmail と同じ見出しで、Cc があれば Cc 行も入る", () => {
    const r = composeForwardBodies({ original });
    expect(r.text).toBe("\n\n---------- Forwarded message ---------\nFrom: 相手 <a@example.com>\nDate: 2026年1月1日(木) 9:05\nSubject: 見積書\nTo: me@example.com\nCc: c@example.com\n\n\n本文1\n本文2");
    expect(r.html).toContain("From: 相手 &lt;a@example.com&gt;<br>Date: 2026年1月1日(木) 9:05");
    expect(r.html).toContain("本文1<br>本文2");
  });

  it("署名は見出しより前、元の HTML があれば body の中身を使う", () => {
    const r = composeForwardBodies({ signatureHtml: "山田", original: { ...original, cc: undefined, html: '<html><body bgcolor="#eee"><p>元</p></body></html>' } });
    expect(r.html.indexOf("gmail_signature")).toBeLessThan(r.html.indexOf("Forwarded message"));
    expect(r.html).toContain('<div bgcolor="#eee"><p>元</p></div>');
    expect(r.text).not.toContain("Cc:");
    expect(r.text.startsWith("\n\n-- \n山田\n\n---------- Forwarded message")).toBe(true);
  });
});
