import { describe, it, expect } from "vitest";
import {
  LIMITS, TRUNCATED_NOTICE, getTextBody, getHtmlBody, extractAttachments, extractHtmlLinks, stripHtmlQuote,
  looksLikeForward, stripLooseCssRules, removeTagBlocks, cleanseBody, parseMessageDetail, type GmailMessagePart,
} from "./messageParse";

const b64url = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_");

// 壊れた・悪意のある入力でも、この時間内に終わること（後戻りが爆発する正規表現を使っていないこと）を確かめる
const FAST_MS = 1500;
const timed = <T,>(fn: () => T): { value: T; ms: number } => {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
};

describe("MIME の木をたどる処理", () => {
  it("text/plain を優先し、無ければ text/html", () => {
    const payload: GmailMessagePart = { mimeType: "multipart/alternative", parts: [
      { mimeType: "text/html", body: { data: b64url("<p>html</p>") } },
      { mimeType: "text/plain", body: { data: b64url("plain") } },
    ] };
    expect(getTextBody(payload)).toBe("plain");
    expect(getTextBody({ mimeType: "multipart/alternative", parts: [{ mimeType: "text/html", body: { data: b64url("<p>h</p>") } }] })).toBe("<p>h</p>");
  });

  it("入れ子が深すぎるメールでも落ちず、上限より深いパートは見ない", () => {
    let deep: GmailMessagePart = { mimeType: "text/plain", body: { data: b64url("奥の本文") } };
    for (let i = 0; i < 5000; i++) deep = { mimeType: "multipart/mixed", parts: [deep] };
    const { value, ms } = timed(() => getTextBody(deep));
    expect(value).toBe("");
    expect(ms).toBeLessThan(FAST_MS);
    expect(getHtmlBody(deep)).toBe("");
    expect(extractAttachments(deep)).toEqual([]);
  });

  it("パートが大量でも上限までしか見ない", () => {
    const parts = Array.from({ length: 10_000 }, (_, i) => ({ mimeType: "application/pdf", filename: `a${i}.pdf`, body: { attachmentId: `id${i}`, size: 1 } }));
    const atts = extractAttachments({ mimeType: "multipart/mixed", parts });
    expect(atts.length).toBeLessThan(LIMITS.mimeParts);
  });

  it("壊れた base64 でも例外にしない", () => {
    expect(getTextBody({ mimeType: "text/plain", body: { data: "***" } })).toBe("");
  });
});

describe("extractHtmlLinks", () => {
  it("リンクの文字と URL を取り出す（URL そのままの文字や重複は除く）", () => {
    const html = '<a href="https://example.com/a">詳細はこちら</a> <A HREF=https://example.com/b><b>申し込む</b></A> <a href="https://example.com/c">https://example.com/c</a> <a href="https://example.com/d">詳細はこちら</a> <abbr>x</abbr>';
    expect(extractHtmlLinks(html)).toEqual([
      { text: "詳細はこちら", href: "https://example.com/a" },
      { text: "申し込む", href: "https://example.com/b" },
    ]);
  });

  it("閉じタグの無い <a> が大量にあっても固まらない", () => {
    const html = '<a href="https://example.com/x">'.repeat(100_000);
    const { value, ms } = timed(() => extractHtmlLinks(html));
    expect(value).toEqual([]);
    expect(ms).toBeLessThan(FAST_MS);
  });

  it("取り出すリンクは上限まで", () => {
    const html = Array.from({ length: 1000 }, (_, i) => `<a href="https://example.com/${i}">リンク${i}</a>`).join("");
    expect(extractHtmlLinks(html)).toHaveLength(LIMITS.links);
  });
});

describe("stripHtmlQuote", () => {
  it("gmail_quote・gmail_attr・blockquote から後ろを切る", () => {
    expect(stripHtmlQuote('<div>本文</div><div class="gmail_quote"><div>引用</div></div>')).toBe("<div>本文</div>");
    expect(stripHtmlQuote('<p>本文</p><div dir="ltr" class="gmail_attr">日時</div>')).toBe("<p>本文</p>");
    expect(stripHtmlQuote("<p>本文</p><blockquote>引用</blockquote>")).toBe("<p>本文</p>");
  });

  it("本文の中に gmail_quote という語があるだけなら切らない", () => {
    expect(stripHtmlQuote("<p>gmail_quote の話</p>")).toBe("<p>gmail_quote の話</p>");
  });

  it("巨大なタグでも固まらない", () => {
    const html = "<div " + "a".repeat(1_000_000) + " gmail_quote>";
    const { ms } = timed(() => stripHtmlQuote(html));
    expect(ms).toBeLessThan(FAST_MS);
  });
});

describe("looksLikeForward", () => {
  it("件名の Fwd: か、引用でない転送の見出しで判定する", () => {
    expect(looksLikeForward("Fwd: x", "")).toBe(true);
    expect(looksLikeForward("x", "メモ\n---------- Forwarded message ---------\nFrom: a")).toBe(true);
    expect(looksLikeForward("x", "> ---------- Forwarded message ---------")).toBe(false);
    expect(looksLikeForward("x", "普通の本文")).toBe(false);
  });
});

describe("stripLooseCssRules", () => {
  it("紛れ込んだ CSS の宣言だけを消す", () => {
    expect(stripLooseCssRules("本文\n.cls { color: red; font-size: 12px; }\n続き")).toBe("本文\n\n続き");
    expect(stripLooseCssRules("数式 {a, b} はそのまま")).toBe("数式 {a, b} はそのまま");
  });

  it("閉じていない { が大量にあっても固まらない", () => {
    const text = "x { a: b; ".repeat(9_000);
    const { ms } = timed(() => stripLooseCssRules(text));
    expect(ms).toBeLessThan(FAST_MS);
  });

  it("長すぎる本文では何もしない", () => {
    const text = ".c { color: red; }" + "あ".repeat(LIMITS.cssRuleChars);
    expect(stripLooseCssRules(text)).toBe(text);
  });
});

describe("removeTagBlocks", () => {
  it("閉じたブロックだけを消し、閉じていなければ残す", () => {
    expect(removeTagBlocks("a<style>x</style>b<STYLE type=x>y</STYLE>c", "style")).toBe("abc");
    expect(removeTagBlocks("a<style>x", "style")).toBe("a<style>x");
  });

  it("閉じていない <style が大量にあっても固まらない", () => {
    const { ms } = timed(() => removeTagBlocks("<style>".repeat(200_000), "style"));
    expect(ms).toBeLessThan(FAST_MS);
  });
});

describe("cleanseBody", () => {
  it("タグ・文字参照・引用を取り除く", () => {
    expect(cleanseBody("<p>こんにちは&nbsp;&#x1F600;</p><style>.a{}</style>\n\n2026年1月1日(木) 9:00 相手 <a@example.com>:\n> 前のメール")).toBe("こんにちは 😀");
  });

  it("上限を超える本文は整形せず、先頭だけを生のまま出す", () => {
    const text = "<b>x</b>".repeat(LIMITS.bodyChars);
    const out = cleanseBody(text);
    expect(out.endsWith(TRUNCATED_NOTICE)).toBe(true);
    expect(out.length).toBe(LIMITS.bodyChars + TRUNCATED_NOTICE.length);
    expect(out.startsWith("<b>x</b>")).toBe(true);
  });
});

describe("parseMessageDetail", () => {
  it("ヘッダーと本文・Cc・Reply-To・References を取り出す", () => {
    const m = parseMessageDetail({
      id: "abc123", threadId: "t1", snippet: "s", labelIds: ["INBOX"],
      payload: { mimeType: "text/plain", headers: [
        { name: "Subject", value: "=?UTF-8?B?" + btoa(String.fromCharCode(...new TextEncoder().encode("件名"))) + "?=" },
        { name: "From", value: "相手 <a@example.com>" }, { name: "To", value: "me@example.com" },
        { name: "Cc", value: "c@example.com" }, { name: "Reply-To", value: "r@example.com" },
        { name: "Message-ID", value: "<m@example.com>" }, { name: "References", value: "<r1@example.com>" },
      ], body: { data: b64url("本文") } },
    });
    expect(m).toMatchObject({ subject: "件名", cc: "c@example.com", replyTo: "r@example.com", references: "<r1@example.com>", body: "本文", messageIdHeader: "<m@example.com>" });
  });

  it("payload が無い・壊れていても例外にしない", () => {
    expect(parseMessageDetail({ id: "abc123", threadId: "t1" })).toMatchObject({ subject: "(件名なし)", body: "", attachments: [] });
  });
});

describe("本文の charset", () => {
  const b64url = (bytes: number[]) => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
  const jis = [0x1b, 0x24, 0x42, 0x46, 0x7c, 0x4b, 0x5c, 0x38, 0x6c, 0x1b, 0x28, 0x42];
  const sjis = [0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea];
  const part = (mimeType: string, charset: string, bytes: number[]) => ({ mimeType, headers: [{ name: "Content-Type", value: `${mimeType}; charset="${charset}"` }], body: { data: b64url(bytes) } });

  it("ISO-2022-JP の text/plain を文字化けさせずに読む", () => {
    expect(getTextBody(part("text/plain", "ISO-2022-JP", jis))).toBe("日本語");
  });

  it("multipart の中の Shift_JIS のテキストと HTML も、それぞれの charset で読む", () => {
    const payload = { mimeType: "multipart/alternative", parts: [part("text/plain", "Shift_JIS", sjis), part("text/html", "Shift_JIS", [0x3c, 0x70, 0x3e, ...sjis, 0x3c, 0x2f, 0x70, 0x3e])] };
    expect(getTextBody(payload)).toBe("日本語");
    expect(getHtmlBody(payload)).toBe("<p>日本語</p>");
  });

  it("charset が無ければ UTF-8 として読む", () => {
    expect(getTextBody({ mimeType: "text/plain", body: { data: b64url(Array.from(new TextEncoder().encode("あい"))) } })).toBe("あい");
  });
});
