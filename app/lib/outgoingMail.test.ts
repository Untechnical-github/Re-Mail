import { describe, it, expect } from "vitest";
import { finalizeOutgoing, headersOf, fromHeaderOf, type FinalizeInput } from "./outgoingMail";
import { withSignature, withQuote, buildQuoteHtml } from "./composeHtml";

const base: FinalizeInput = {
  accountEmail: "me@example.com",
  html: '<div dir="ltr">本文</div>',
  images: [],
  attachments: [],
  to: "a@example.com",
  subject: "件名",
  replyToMessage: null,
  alias: null,
  maxTotalBytes: 25 * 1024 * 1024,
};

describe("finalizeOutgoing", () => {
  it("送信と下書きの保存で同じ入力なら同じ中身になる（同じ関数を通す）", () => {
    expect(finalizeOutgoing(base)).toEqual(finalizeOutgoing({ ...base }));
  });

  it("たたんでいる引用・署名（入力欄の HTML の後ろに付いている分）も落とさずに入れる", () => {
    const sig = "<div>署名の人</div>";
    const quote = buildQuoteHtml("2026年10月25日(日) 9:05 a <a@example.com>:", null, "元の本文");
    // 入力欄では印（data-remail-fold）を付けてたたみ、脇に持っている。getHtml はそれも後ろに付けて返す
    const html = withQuote(withSignature("<div>返事</div>", sig, "reply"), quote).replace('class="gmail_quote', 'data-remail-fold="1" class="gmail_quote');
    const r = finalizeOutgoing({ ...base, html, replyToMessage: { subject: "相談", threadId: "t1", messageIdHeader: "<m1@example.com>", references: "<m0@example.com>" } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.bodyHtml).toContain("gmail_signature");
    expect(r.payload.bodyHtml).toContain("gmail_quote");
    expect(r.payload.bodyHtml).toContain("元の本文");
    expect(r.payload.bodyHtml).not.toContain("data-remail-fold");
    expect(r.payload.body).toContain("署名の人");
    expect(r.payload.body).toContain("元の本文");
    // 画面に出す本文には署名・引用を入れない
    expect(r.bodyText).toBe("返事");
  });

  it("返信は件名を「Re: 元の件名」に揃え、threadId・In-Reply-To・References を付ける", () => {
    const r = finalizeOutgoing({ ...base, subject: "入力した件名", replyToMessage: { subject: "相談", threadId: "t1", messageIdHeader: "<m1@example.com>", references: "<m0@example.com>" } });
    expect(r.ok && r.payload).toMatchObject({ subject: "Re: 相談", threadId: "t1", inReplyTo: "<m1@example.com>", references: "<m0@example.com> <m1@example.com>" });
  });

  it("本文から参照している画像だけをインライン画像にする", () => {
    const img = (cid: string) => ({ cid, filename: `${cid}.png`, mimeType: "image/png", size: 10, data: "QQ==" });
    const r = finalizeOutgoing({ ...base, html: '<div>a<img src="cid:ii_a"></div>', images: [img("ii_a"), img("ii_b")] });
    expect(r.ok && r.payload.inlineImages?.map(i => i.contentId)).toEqual(["ii_a"]);
  });

  it("添付と画像の合計が上限ちょうどなら通し、1バイトでも超えたら止める", () => {
    const att = (size: number) => [{ filename: "a.bin", mimeType: "application/octet-stream", size, data: "QQ==" }];
    expect(finalizeOutgoing({ ...base, maxTotalBytes: 100, attachments: att(100) }).ok).toBe(true);
    expect(finalizeOutgoing({ ...base, maxTotalBytes: 100, attachments: att(101) })).toEqual({ ok: false, error: "tooLarge" });
  });

  it("本文の HTML が長すぎれば止める", () => {
    expect(finalizeOutgoing({ ...base, html: `<div>${"あ".repeat(1_000_001)}</div>` })).toEqual({ ok: false, error: "tooLong" });
  });
});

describe("headersOf / fromHeaderOf", () => {
  it("送信先を To / Cc / Bcc に分ける", () => {
    expect(headersOf([{ address: "a@example.com", role: "to" }, { address: "b@example.com", role: "cc" }, { address: "c@example.com", role: "bcc" }]))
      .toEqual({ to: "a@example.com", cc: "b@example.com", bcc: "c@example.com" });
  });
  it("既定のアドレスからは From を付けない。エイリアスは表示名つき", () => {
    expect(fromHeaderOf({ sendAsEmail: "me@example.com", isPrimary: true })).toBeUndefined();
    expect(fromHeaderOf({ sendAsEmail: "alias@example.com", displayName: "別名" })).toBe("別名 <alias@example.com>");
    expect(fromHeaderOf(null)).toBeUndefined();
  });
});
