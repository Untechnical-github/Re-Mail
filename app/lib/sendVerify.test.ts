import { describe, it, expect } from "vitest";
import { classifySendStatus, gmailErrorReason, makeMessageId, isValidMessageId, matchSentMessage, type SentCandidate } from "./sendVerify";

describe("classifySendStatus", () => {
  it("429 だけ再試行、5xx は照合、それ以外の 4xx は失敗", () => {
    expect(classifySendStatus(200)).toBe("ok");
    expect(classifySendStatus(401)).toBe("unauthorized");
    expect(classifySendStatus(429)).toBe("retry");
    expect(classifySendStatus(500)).toBe("unknown");
    expect(classifySendStatus(503)).toBe("unknown");
    expect(classifySendStatus(400)).toBe("failed");
    expect(classifySendStatus(403)).toBe("failed");
    expect(classifySendStatus(413)).toBe("failed");
  });

  it("レート制限の 403 は送られていないので再試行、それ以外の 403 は失敗", () => {
    expect(classifySendStatus(403, "rateLimitExceeded")).toBe("retry");
    expect(classifySendStatus(403, "userRateLimitExceeded")).toBe("retry");
    expect(classifySendStatus(403, "insufficientPermissions")).toBe("failed");
    expect(classifySendStatus(400, "rateLimitExceeded")).toBe("failed");
  });
});

describe("gmailErrorReason", () => {
  it("Gmail のエラー応答から理由コードを取り出す（実機で返ってきた形）", () => {
    expect(gmailErrorReason({ error: { code: 403, errors: [{ reason: "rateLimitExceeded" }] } })).toBe("rateLimitExceeded");
    expect(gmailErrorReason({ error: { code: 403, status: "RESOURCE_EXHAUSTED" } })).toBe("rateLimitExceeded");
    expect(gmailErrorReason(null)).toBeUndefined();
    expect(gmailErrorReason("x")).toBeUndefined();
  });
});

describe("makeMessageId / isValidMessageId", () => {
  it("純正 Gmail と同じ形で、検証を通る", () => {
    const id = makeMessageId(new Uint8Array(40).map((_, i) => i * 7));
    expect(id).toMatch(/^<CA[A-Za-z0-9]{40}@mail\.gmail\.com>$/);
    expect(isValidMessageId(id)).toBe(true);
  });

  it("改行や空白を含むものは通さない", () => {
    expect(isValidMessageId("<a@b>\r\nBcc: x@example.com")).toBe(false);
    expect(isValidMessageId("<a b@example.com>")).toBe(false);
    expect(isValidMessageId(123)).toBe(false);
    expect(isValidMessageId("<" + "a".repeat(300) + "@example.com>")).toBe(false);
  });
});

describe("matchSentMessage", () => {
  const sentAfterMs = Date.UTC(2026, 0, 1, 10, 0, 0);
  const expected = { messageId: "<CAabc@mail.gmail.com>", subject: "Re: 見積書の件", to: "相手 <a@example.com>", cc: "b@example.com", body: "承知しました。\n明日の 10 時に伺います。It's fine.", sentAfterMs };
  const base: SentCandidate = { messageIdHeader: "<other@mail.gmail.com>", snippet: "承知しました。 明日の 10 時に伺います。It&#39;s fine. 2026年1月1日(木) 相手 &lt;a@example.com&gt;:", subject: "Re: 見積書の件", to: "a@example.com", cc: "B@example.com", internalDateMs: sentAfterMs + 2000 };

  it("Message-ID が一致すれば、ほかが違っても同じメール", () => {
    expect(matchSentMessage({ ...base, messageIdHeader: "<CAabc@mail.gmail.com>", subject: "x" }, expected)).toBe("messageId");
  });

  it("Message-ID が付け替えられていても、宛先・件名・時刻が一致すれば同じメール（大文字小文字・表示名・空白は無視）", () => {
    expect(matchSentMessage({ ...base, subject: "Re:  見積書の件" }, expected)).toBe("fields");
  });

  it("件名・To・Cc・時刻のどれかが違えば別のメール", () => {
    expect(matchSentMessage({ ...base, subject: "Re: 別件" }, expected)).toBeNull();
    expect(matchSentMessage({ ...base, to: "c@example.com" }, expected)).toBeNull();
    expect(matchSentMessage({ ...base, cc: "" }, expected)).toBeNull();
    expect(matchSentMessage({ ...base, internalDateMs: sentAfterMs - 5 * 60_000 }, expected)).toBeNull();
  });

  it("同じ件名・宛先でも本文の冒頭が違えば別のメール（続けて返信した場合の取り違えを防ぐ）", () => {
    expect(matchSentMessage({ ...base, snippet: "了解です" }, expected)).toBeNull();
    expect(matchSentMessage({ ...base, snippet: "" }, expected)).toBeNull();
  });

  it("Cc なしで送った場合、Cc 付きの送信済みとは一致しない", () => {
    expect(matchSentMessage(base, { ...expected, cc: undefined })).toBeNull();
    expect(matchSentMessage({ ...base, cc: "" }, { ...expected, cc: undefined })).toBe("fields");
  });

  it("Bcc も照らし合わせる（Bcc だけの送信でも一致を見つけられる）", () => {
    const bccOnly = { ...expected, to: "", cc: undefined, bcc: "x@example.com, Y <y@example.com>" };
    const sent = { ...base, to: "", cc: "", bcc: "Y@example.com, x@example.com" };
    expect(matchSentMessage(sent, bccOnly)).toBe("fields");
    expect(matchSentMessage({ ...sent, bcc: "x@example.com" }, bccOnly)).toBeNull();
    expect(matchSentMessage({ ...sent, bcc: undefined }, bccOnly)).toBeNull();
    expect(matchSentMessage({ ...base, bcc: "z@example.com" }, expected)).toBeNull();
  });
});
