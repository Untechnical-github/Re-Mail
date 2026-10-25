import { describe, it, expect } from "vitest";
import {
  encodeHeaderText, splitAddressList, parseAddress, formatAddressHeader,
  buildMimeSegments, assembleBytes, buildGmailUploadBody, buildDraftUploadBody, cleanBase64, utf8ToBase64, decodeMimeHeader,
} from "./mime";

// テスト用: encoded-word を元の文字列に戻す
function decodeWords(header: string): string {
  // 隣り合う encoded-word の間の空白は無視する決まり（RFC 2047）
  return header.replace(/\r\n /g, " ").replace(/\?=\s+=\?/g, "?==?").replace(/=\?UTF-8\?B\?([^?]+)\?=/g, (_, b64) => {
    const bin = atob(b64);
    return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
  }).trim();
}

const toText = (segs: ReturnType<typeof buildMimeSegments>) => new TextDecoder().decode(assembleBytes(segs));

describe("encodeHeaderText", () => {
  it("ASCII はそのまま", () => {
    expect(encodeHeaderText("Hello world")).toBe("Hello world");
  });

  it("日本語の長い件名は 75 文字以内の語に分けて折り返し、元に戻せる", () => {
    const subject = "【重要】来週の打ち合わせ資料について（第3回プロジェクト定例会議のご案内）🙏";
    const encoded = encodeHeaderText(subject);
    for (const line of encoded.split("\r\n")) expect(line.trim().length).toBeLessThanOrEqual(75);
    expect(decodeWords(encoded)).toBe(subject);
  });

  it("改行を含む値でヘッダーを差し込ませない", () => {
    expect(encodeHeaderText("a\r\nBcc: evil@example.com")).not.toMatch(/\r\nBcc/);
  });
});

describe("splitAddressList / parseAddress", () => {
  it("表示名の中のカンマで切らない", () => {
    expect(splitAddressList('"山田, 太郎" <a@example.com>, b@example.com')).toEqual(['"山田, 太郎" <a@example.com>', "b@example.com"]);
  });

  it("中身の無いグループ（undisclosed-recipients:;）は宛先として数えない", () => {
    expect(splitAddressList("undisclosed-recipients:;")).toEqual([]);
    expect(splitAddressList(" undisclosed-recipients: ; ")).toEqual([]);
    expect(splitAddressList("undisclosed-recipients:;, a@example.com")).toEqual(["a@example.com"]);
    // 引用符の中のコロンは表示名の一部なので残す
    expect(splitAddressList('"営業部:" <a@example.com>')).toEqual(['"営業部:" <a@example.com>']);
    // 巨大な入力でも固まらない
    expect(splitAddressList(":".repeat(100_000) + ";")).toEqual([":".repeat(100_000)]);
  });

  it("表示名とアドレスに分ける", () => {
    expect(parseAddress('"山田 太郎" <a@example.com>')).toEqual({ name: "山田 太郎", address: "a@example.com" });
    expect(parseAddress("b@example.com")).toEqual({ name: "", address: "b@example.com" });
  });
});

describe("formatAddressHeader", () => {
  it("日本語の表示名は encoded-word、記号入りの英字名は引用符で囲む", () => {
    const out = formatAddressHeader('"山田 太郎" <a@example.com>, "Doe, John" <j@example.com>, c@example.com');
    expect(out).toContain("<a@example.com>");
    expect(out).toContain('"Doe, John" <j@example.com>');
    expect(out).toContain("c@example.com");
    expect(decodeWords(out.split(",\r\n ")[0])).toBe("山田 太郎 <a@example.com>");
  });
});

describe("buildMimeSegments", () => {
  it("全体が ASCII だけで、1行 998 バイト以内", () => {
    const text = toText(buildMimeSegments({
      to: "相手 <a@example.com>", cc: "b@example.com", subject: "日本語の件名",
      text: "本文です。".repeat(500),
      attachments: [{ filename: "見積書.pdf", mimeType: "application/pdf", data: utf8ToBase64("x".repeat(10000)) }],
    }));
    expect(/^[\x00-\x7F]*$/.test(text)).toBe(true);
    for (const line of text.split("\r\n")) expect(line.length).toBeLessThanOrEqual(998);
  });

  it("Cc・In-Reply-To・References・Message-ID が入る", () => {
    const text = toText(buildMimeSegments({
      to: "a@example.com", cc: "b@example.com, c@example.com", subject: "Re: hi", text: "ok",
      inReplyTo: "<orig@example.com>", messageId: "<new@example.com>",
    }));
    expect(text).toMatch(/^Cc: b@example.com,\r\n c@example.com$/m);
    expect(text).toMatch(/^In-Reply-To: <orig@example.com>$/m);
    expect(text).toMatch(/^References: <orig@example.com>$/m);
    expect(text).toMatch(/^Message-ID: <new@example.com>$/m);
  });

  it("Bcc は Cc の直後に入り、日本語の表示名だけ encoded-word にして <アドレス> は残す", () => {
    const text = toText(buildMimeSegments({
      to: "a@example.com", cc: "b@example.com", bcc: "山田 太郎 <yamada@example.com>, c@example.com", subject: "s", text: "t", replyTo: "r@example.com",
    }));
    const lines = text.split("\r\n");
    const cc = lines.findIndex(l => l.startsWith("Cc: "));
    expect(lines[cc + 1]).toMatch(/^Bcc: =\?UTF-8\?B\?[^?]+\?= <yamada@example.com>,$/);
    expect(lines[cc + 2]).toBe(" c@example.com");
    expect(lines[cc + 3]).toBe("Reply-To: r@example.com");
    expect(decodeWords(lines[cc + 1].slice(5).replace(/ <.*$/, ""))).toBe("山田 太郎");
  });

  it("Bcc が空なら Bcc ヘッダーを出さない。改行を入れられても別のヘッダーを差し込ませない", () => {
    expect(toText(buildMimeSegments({ to: "a@example.com", bcc: "  ", subject: "s", text: "t" }))).not.toMatch(/^Bcc:/m);
    const text = toText(buildMimeSegments({ to: "a@example.com", bcc: "b@example.com\r\nX-Evil: 1", subject: "s", text: "t" }));
    expect(text).not.toMatch(/^X-Evil/m);
    expect(text).toMatch(/^Bcc: b@example.com X-Evil: 1$/m);
  });

  it("Bcc だけ（To も Cc も空）なら To を付けない（undisclosed-recipients:; を入れると Gmail API が送信を断る）", () => {
    const text = toText(buildMimeSegments({ to: "", bcc: "b@example.com", subject: "s", text: "t" }));
    expect(text).toMatch(/^Bcc: b@example.com$/m);
    expect(text).not.toMatch(/^To:/m);
  });

  it("To が空でも Cc があれば To は付けない", () => {
    const text = toText(buildMimeSegments({ to: "  ", cc: "c@example.com", bcc: "b@example.com", subject: "s", text: "t" }));
    expect(text).not.toMatch(/^To:/m);
    expect(text).toMatch(/^Cc: c@example.com$/m);
  });

  it("From・Reply-To は指定したときだけ入り、日本語の表示名は encoded-word になる", () => {
    const withFrom = toText(buildMimeSegments({ to: "a@example.com", subject: "s", text: "t", from: "営業部 <sales@example.com>", replyTo: "support@example.com" }));
    expect(withFrom).toMatch(/^From: =\?UTF-8\?B\?[^?]+\?= <sales@example.com>$/m);
    expect(withFrom).toMatch(/^Reply-To: support@example.com$/m);
    const without = toText(buildMimeSegments({ to: "a@example.com", subject: "s", text: "t" }));
    expect(without).not.toMatch(/^From:/m);
    expect(without).not.toMatch(/^Reply-To:/m);
  });

  it("References を指定すれば In-Reply-To とは別にそれを使う", () => {
    const text = toText(buildMimeSegments({ to: "a@example.com", subject: "s", text: "t", inReplyTo: "<b@example.com>", references: "<a@example.com> <b@example.com>" }));
    expect(text).toMatch(/^References: <a@example.com> <b@example.com>$/m);
    expect(text).toMatch(/^In-Reply-To: <b@example.com>$/m);
  });

  it("Cc が空なら Cc ヘッダーを出さない", () => {
    const text = toText(buildMimeSegments({ to: "a@example.com", cc: " ", subject: "s", text: "t" }));
    expect(text).not.toMatch(/^Cc:/m);
  });

  it("日本語のファイル名は encoded-word と filename* の両方で入る", () => {
    const text = toText(buildMimeSegments({
      to: "a@example.com", subject: "s", text: "t",
      attachments: [{ filename: "見積書 (最終).pdf", mimeType: "application/pdf", data: "QUJD" }],
    }));
    const m = text.match(/filename="(=\?UTF-8\?B\?[^"]+\?=)"; filename\*=UTF-8''(\S+)/);
    expect(m).not.toBeNull();
    expect(decodeWords(m![1])).toBe("見積書 (最終).pdf");
    expect(decodeURIComponent(m![2])).toBe("見積書 (最終).pdf");
  });

  it("添付の base64 は 76 文字で改行され、混ざった改行で境界を壊させない", () => {
    const data = utf8ToBase64("y".repeat(300));
    const text = toText(buildMimeSegments({
      to: "a@example.com", subject: "s", text: "t",
      attachments: [{ filename: "a.bin", mimeType: "x\r\nBad: 1", data: data + "\r\n--evil" }],
    }));
    expect(text).toContain("Content-Type: application/octet-stream;");
    expect(text).not.toContain("--evil");
    const lines = text.split("\r\n");
    const start = lines.findIndex(l => l.startsWith(data.slice(0, 20)));
    expect(lines[start].length).toBe(76);
  });

  it("テキストと HTML の両方があれば multipart/alternative", () => {
    const text = toText(buildMimeSegments({ to: "a@example.com", subject: "s", text: "t", html: "<p>t</p>" }));
    expect(text).toMatch(/Content-Type: multipart\/alternative/);
    expect(text).toMatch(/Content-Type: text\/plain; charset="UTF-8"/);
    expect(text).toMatch(/Content-Type: text\/html; charset="UTF-8"/);
  });
});

describe("assembleBytes", () => {
  it("計算した長さと実際の書き込み量が一致する（76の倍数ちょうども）", () => {
    for (const n of [0, 1, 75, 76, 77, 152, 153]) {
      const b64 = "A".repeat(n);
      const bytes = assembleBytes(["x", { base64: b64 }, "y"]);
      const expected = "x" + (b64.match(/.{1,76}/g) || []).join("\r\n") + "y";
      expect(new TextDecoder().decode(bytes)).toBe(expected);
    }
  });
});

describe("buildGmailUploadBody", () => {
  it("メタデータに threadId、2つ目のパートにメール本体が入る", () => {
    const { body, contentType } = buildGmailUploadBody(["Subject: s\r\n\r\nbody"], "thread123");
    const text = new TextDecoder().decode(body);
    const boundary = contentType.match(/boundary=(\S+)/)![1];
    expect(contentType).toMatch(/^multipart\/related; boundary=/);
    expect(text).toContain('{"threadId":"thread123"}');
    expect(text).toContain("Content-Type: message/rfc822\r\n\r\nSubject: s\r\n\r\nbody");
    expect(text.endsWith(`--${boundary}--\r\n`)).toBe(true);
  });
});

describe("cleanBase64", () => {
  it("base64 以外の文字を除く", () => {
    expect(cleanBase64("QU\r\nJD")).toBe("QUJD");
  });
});

describe("decodeMimeHeader", () => {
  it("折り返された複数の encoded-word を、間に空白を入れずに戻す", () => {
    const subject = "【重要】来週の打ち合わせ資料について（第3回プロジェクト定例会議のご案内）";
    expect(decodeMimeHeader(encodeHeaderText(subject))).toBe(subject);
  });

  it("Q エンコードと、encoded-word でない部分の空白はそのまま", () => {
    expect(decodeMimeHeader("Re: =?UTF-8?Q?caf=C3=A9_au_lait?= today")).toBe("Re: café au lait today");
  });

  it("壊れた base64 でも例外にせず元の文字列を返す", () => {
    expect(decodeMimeHeader("=?UTF-8?B?***?=")).toBe("=?UTF-8?B?***?=");
  });

  it("Date ヘッダーは自分では付けない（Gmail が付ける）", () => {
    const text = new TextDecoder().decode(assembleBytes(buildMimeSegments({ to: "a@example.com", subject: "s", text: "t" })));
    expect(text).not.toMatch(/^Date:/m);
  });
});

describe("ヘッダーの並び", () => {
  it("純正 Gmail と同じく MIME-Version → References → In-Reply-To → … → Subject → To → Cc の順", () => {
    const text = new TextDecoder().decode(assembleBytes(buildMimeSegments({
      to: "a@example.com", cc: "b@example.com", subject: "s", text: "t", inReplyTo: "<x@example.com>", messageId: "<m@example.com>",
    })));
    const names = text.split("\r\n\r\n")[0].split("\r\n").filter(l => /^[A-Za-z-]+:/.test(l)).map(l => l.split(":")[0]);
    expect(names.slice(0, 7)).toEqual(["MIME-Version", "References", "In-Reply-To", "Message-ID", "Subject", "To", "Cc"]);
  });
});

describe("decodeMimeHeader の charset", () => {
  const b64 = (bytes: number[]) => Buffer.from(bytes).toString("base64");
  // 「日本語」の ISO-2022-JP と Shift_JIS のバイト列
  const jis = [0x1b, 0x24, 0x42, 0x46, 0x7c, 0x4b, 0x5c, 0x38, 0x6c, 0x1b, 0x28, 0x42];
  const sjis = [0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea];

  it("ISO-2022-JP・Shift_JIS・cp932（別名）の件名を戻す", () => {
    expect(decodeMimeHeader(`=?ISO-2022-JP?B?${b64(jis)}?=`)).toBe("日本語");
    expect(decodeMimeHeader(`=?Shift_JIS?B?${b64(sjis)}?=`)).toBe("日本語");
    expect(decodeMimeHeader(`=?cp932?B?${b64(sjis)}?=`)).toBe("日本語");
    expect(decodeMimeHeader(`Re: =?iso-2022-jp?B?${b64(jis)}?= です`)).toBe("Re: 日本語 です");
  });

  it("1文字の途中で語が分かれていても、つなげてから戻す", () => {
    const bytes = Array.from(new TextEncoder().encode("見積"));
    const w1 = `=?UTF-8?B?${b64(bytes.slice(0, 4))}?=`;
    const w2 = `=?UTF-8?B?${b64(bytes.slice(4))}?=`;
    expect(decodeMimeHeader(`${w1}\r\n ${w2}`)).toBe("見積");
  });

  it("知らない charset は UTF-8 として読み、例外にしない", () => {
    expect(decodeMimeHeader(`=?x-unknown?B?${b64(Array.from(new TextEncoder().encode("あ")))}?=`)).toBe("あ");
  });
});

describe("インライン画像（multipart/related）", () => {
  it("添付が無ければ related の中に本文と画像、添付があれば mixed の中に related を入れる", () => {
    const inline = [{ filename: "blue.png", mimeType: "image/png", data: "iVBORw0KGgo=", contentId: "<blue_square@example>" }];
    const a = new TextDecoder().decode(assembleBytes(buildMimeSegments({ to: "a@example.com", subject: "s", text: "t", html: '<img src="cid:blue_square@example">', inline })));
    expect(a).toMatch(/^Content-Type: multipart\/related; boundary=/m);
    expect(a).toContain("Content-ID: <blue_square@example>");
    expect(a).toContain("Content-Disposition: inline;");
    const b = new TextDecoder().decode(assembleBytes(buildMimeSegments({ to: "a@example.com", subject: "s", text: "t", html: "x", inline, attachments: [{ filename: "a.pdf", mimeType: "application/pdf", data: "QQ==" }] })));
    expect(b.indexOf("multipart/mixed")).toBeLessThan(b.indexOf("multipart/related"));
    expect(b.indexOf("multipart/related")).toBeLessThan(b.indexOf("multipart/alternative"));
  });

  it("Content-ID に改行や記号を入れられてもヘッダーを壊さない", () => {
    const inline = [{ filename: "x.png", mimeType: "image/png", data: "QQ==", contentId: "a>\r\nBcc: evil@example.com" }];
    const t = new TextDecoder().decode(assembleBytes(buildMimeSegments({ to: "a@example.com", subject: "s", html: "x", inline })));
    expect(t).not.toMatch(/^Bcc:/m);
  });
});
