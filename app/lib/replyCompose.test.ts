import { describe, it, expect } from "vitest";
import { replySubjectFor, buildReferences, pickSendAs, signatureToText, formatQuoteHeader, composeReplyBodies, escapeHtml, extractHtmlBodyInner, forwardSubjectFor, composeForwardBodies, displayAddressList } from "./replyCompose";

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
  it("日本語版 Gmail と同じ見出しで、表示名の引用符は外す", () => {
    expect(formatQuoteHeader(new Date(2026, 0, 1, 9, 5), "相手 <a@example.com>")).toBe("2026年1月1日(木) 09:05 相手 <a@example.com>:");
    expect(formatQuoteHeader(new Date(2026, 0, 1, 9, 5), '"髙澤家" <a@example.com>')).toBe("2026年1月1日(木) 09:05 髙澤家 <a@example.com>:");
    expect(formatQuoteHeader(new Date(2026, 0, 1, 9, 5), "a@example.com")).toBe("2026年1月1日(木) 09:05 <a@example.com>:");
  });
});

describe("displayAddressList", () => {
  it("複数の宛先を、引用符なしの「表示名 <アドレス>」で並べる", () => {
    expect(displayAddressList('"山田, 太郎" <a@example.com>, b@example.com')).toBe("山田, 太郎 <a@example.com>, <b@example.com>");
  });
});

describe("composeReplyBodies", () => {
  const quote = { header: "2026年1月1日(木) 09:05 相手 <a@example.com>:", originalText: "1行目\n\n2行目\n" };

  it("署名も引用もなければ本文だけ", () => {
    expect(composeReplyBodies({ text: "了解です" })).toEqual({ text: "了解です", html: '<div dir="ltr">了解です</div>' });
  });

  // 純正 Gmail から実際に返信したメールのソース（署名の設定は既定のまま）と同じ並び・空行にする
  it("本文 → 引用 → 署名 の順。テキスト版は > で引用し、空行は > だけにする", () => {
    const r = composeReplyBodies({ text: "了解です\n明日伺います", signatureHtml: "<b>山田</b>", quote });
    expect(r.text).toBe("了解です\n明日伺います\n\n\n2026年1月1日(木) 09:05 相手 <a@example.com>:\n\n> 1行目\n>\n> 2行目\n>\n\n\n-- \n山田\n");
    const sigAt = r.html.indexOf("gmail_signature");
    const quoteAt = r.html.indexOf("gmail_quote");
    expect(quoteAt).toBeGreaterThan(0);
    expect(sigAt).toBeGreaterThan(quoteAt);
    expect(r.html.startsWith('<div dir="ltr">了解です<br>明日伺います</div><br><div class="gmail_quote gmail_quote_container">')).toBe(true);
    expect(r.html).toContain('<div dir="ltr" class="gmail_attr">2026年1月1日(木) 09:05 相手 &lt;a@example.com&gt;:<br></div>');
    expect(r.html.endsWith('</blockquote></div><div><br clear="all"></div><div><br></div><span class="gmail_signature_prefix">-- </span><br><div dir="ltr" class="gmail_signature" data-smartmail="gmail_signature"><b>山田</b></div>')).toBe(true);
  });

  it("引用が無くても、署名は本文の後に付く", () => {
    const r = composeReplyBodies({ text: "x", signatureHtml: "山田" });
    expect(r.text).toBe("x\n\n-- \n山田\n");
    expect(r.html.indexOf("gmail_signature")).toBeGreaterThan(r.html.indexOf("x"));
  });

  it("元の HTML があれば引用にそれを使い、無ければテキストを HTML にして使う", () => {
    expect(composeReplyBodies({ text: "x", quote: { ...quote, originalHtml: "<p>元</p>" } }).html).toContain("<blockquote class=\"gmail_quote\" style=\"margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex\"><p>元</p></blockquote>");
    expect(composeReplyBodies({ text: "x", quote: { ...quote, originalText: "1行目\n2行目" } }).html).toContain(">1行目<br>2行目</blockquote>");
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
  const original = { from: '"相手" <a@example.com>', date: new Date(2026, 0, 1, 9, 5), subject: "見積書", to: "me@example.com", cc: "相手 <c@example.com>", text: "本文1\n本文2\n" };

  // 純正 Gmail から実際に転送したメールのソースと同じ並び・空行・宛先の書き方にする
  it("日本語版 Gmail と同じ見出し。Cc があれば Cc 行も入り、表示名の無い宛先は <アドレス> と書く", () => {
    const r = composeForwardBodies({ text: "ご確認ください", original });
    expect(r.text).toBe("ご確認ください\n\n\n---------- Forwarded message ---------\nFrom: 相手 <a@example.com>\nDate: 2026年1月1日(木) 9:05\nSubject: 見積書\nTo: <me@example.com>\nCc: 相手 <c@example.com>\n\n\n本文1\n本文2\n");
    expect(r.html).toContain('From: <strong class="gmail_sendername" dir="auto">相手</strong> <span dir="auto">&lt;a@example.com&gt;</span><br>Date: 2026年1月1日(木) 9:05');
    expect(r.html).toContain("To:  &lt;me@example.com&gt;<br>Cc: 相手 &lt;c@example.com&gt;");
    expect(r.html).toContain("本文1<br>本文2");
  });

  it("見出しの外枠は純正 Gmail と同じ class（gmail_quote gmail_quote_container）", () => {
    const r = composeForwardBodies({ original });
    expect(r.html.startsWith('<div dir="ltr"><div><br><br><div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">---------- Forwarded message ---------<br>')).toBe(true);
  });

  it("署名は元の本文の後、元の HTML があれば body の中身を使う", () => {
    const r = composeForwardBodies({ signatureHtml: "山田", original: { ...original, cc: undefined, html: '<html><body bgcolor="#eee"><p>元</p></body></html>' } });
    expect(r.html.indexOf("gmail_signature")).toBeGreaterThan(r.html.indexOf('<div bgcolor="#eee"><p>元</p></div>'));
    expect(r.text).not.toContain("Cc:");
    expect(r.text.endsWith("本文1\n本文2\n\n\n-- \n山田\n")).toBe(true);
  });
});

describe("composeForwardBodies の元の HTML", () => {
  it("<body> の無い HTML は div で包まずそのまま入れる（純正と同じ）", () => {
    const r = composeForwardBodies({ original: { from: "a@example.com", date: new Date(2026, 0, 1), subject: "s", to: "b@example.com", text: "t", html: '<div dir="ltr">元</div>' } });
    expect(r.html).toContain('<br><br><div dir="ltr">元</div>\n');
    expect(r.html).not.toContain('<div><div dir="ltr">元</div></div>');
  });
});
