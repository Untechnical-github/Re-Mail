import { describe, it, expect } from "vitest";
import { draftFingerprint, planDraftSave, fitsKeepalive, KEEPALIVE_MAX_BYTES, judgeDraftSend, readGmailLink, isRetryableSaveStatus, EMPTY_LINK, type DraftContent } from "./gmailDrafts";

const content: DraftContent = { subject: "", html: "<div>本文</div>", images: [], attachments: [], replyToMessage: null, recipients: null };

describe("draftFingerprint", () => {
  it("同じ中身なら同じ、どこか変われば違う", () => {
    const fp = draftFingerprint(content);
    expect(draftFingerprint({ ...content })).toBe(fp);
    expect(draftFingerprint({ ...content, html: "<div>本文。</div>" })).not.toBe(fp);
    expect(draftFingerprint({ ...content, subject: "件名" })).not.toBe(fp);
    expect(draftFingerprint({ ...content, recipients: [{ address: "a@example.com", role: "cc" }] })).not.toBe(fp);
    expect(draftFingerprint({ ...content, attachments: [{ filename: "a.pdf", size: 1, mimeType: "application/pdf" }] })).not.toBe(fp);
    expect(draftFingerprint({ ...content, replyToMessage: { id: "m1" } })).not.toBe(fp);
  });
  it("端末に置ける形（英数字だけ）", () => {
    expect(draftFingerprint(content)).toMatch(/^[0-9a-z]{1,40}$/);
  });
});

describe("planDraftSave", () => {
  const link = { ...EMPTY_LINK };
  const plan = (over: Partial<Parameters<typeof planDraftSave>[0]>) => planDraftSave({ enabled: true, isGroup: false, content, link, recipientCount: 1, ...over });

  it("変わっていなければ保存しない（dirty でない）", () => {
    expect(plan({ link: { ...link, syncedFingerprint: draftFingerprint(content) } })).toBe("skip");
  });
  it("変わっていれば保存する", () => {
    expect(plan({})).toBe("save");
    expect(plan({ link: { ...link, draftId: "r1", syncedFingerprint: "old" } })).toBe("save");
  });
  it("同期がオフ・グループチャット・送信先が1人もいないときは保存しない", () => {
    expect(plan({ enabled: false })).toBe("skip");
    expect(plan({ isGroup: true })).toBe("skip");
    expect(plan({ recipientCount: 0 })).toBe("skip");
  });
  it("本文が空で添付も無く、送信先と返信元が既定に戻ったら、Gmail の下書きを消す", () => {
    const empty = { ...content, html: "<div><br></div>" };
    expect(plan({ content: empty, link: { ...link, draftId: "r1", syncedFingerprint: "old" } })).toBe("delete");
    // Gmail の下書きがまだ無ければ消すものは無い
    expect(plan({ content: empty })).toBe("forget");
    // 送信先を変えたまま・返信元を選んだまま・件名があるときは消さない
    expect(plan({ content: { ...empty, recipients: [{ address: "a@example.com", role: "to" }] }, link: { ...link, draftId: "r1" } })).toBe("save");
    expect(plan({ content: { ...empty, replyToMessage: { id: "m1" } }, link: { ...link, draftId: "r1" } })).toBe("save");
    expect(plan({ content: { ...empty, subject: "件名" }, link: { ...link, draftId: "r1" } })).toBe("save");
  });
  it("署名・引用だけが残っている本文は空とみなす", () => {
    expect(plan({ content: { ...content, html: '<div><br></div><div class="gmail_signature">署名</div>' }, link: { ...link, draftId: "r1" } })).toBe("delete");
  });
});

describe("fitsKeepalive", () => {
  it("上限ちょうどまでは送る。超えたら送らない（バイトで数える）", () => {
    expect(fitsKeepalive("a".repeat(KEEPALIVE_MAX_BYTES))).toBe(true);
    expect(fitsKeepalive("a".repeat(KEEPALIVE_MAX_BYTES + 1))).toBe(false);
    // 日本語は1文字3バイト
    expect(fitsKeepalive("あ".repeat(Math.floor(KEEPALIVE_MAX_BYTES / 3) + 1))).toBe(false);
  });
});

describe("judgeDraftSend（下書きの有無 × 送信済みに見つかるか）", () => {
  it("送れた", () => {
    expect(judgeDraftSend({ status: 200, id: "x", threadId: "t" })).toEqual({ kind: "sent", id: "x", threadId: "t" });
  });
  it("下書きが無く、送信済みに見つかった → ほかで送信済み", () => {
    expect(judgeDraftSend({ status: 409, error: "DRAFT_ALREADY_SENT" }).kind).toBe("alreadySent");
  });
  it("下書きが無く、送信済みにも無い → 新しいメールとして送るか聞く（勝手に messages.send しない）", () => {
    expect(judgeDraftSend({ status: 404, error: "DRAFT_GONE" }).kind).toBe("askNew");
  });
  it("送れたか分からないが下書きが残っている → 送られていない。再送するか聞く", () => {
    expect(judgeDraftSend({ status: 502, error: "SEND_UNCONFIRMED" }).kind).toBe("askResend");
    expect(judgeDraftSend({ status: null, verify: { found: false, draftExists: true } }).kind).toBe("askResend");
  });
  it("送れたか分からず、下書きも無く、送信済みにも無い → 確かめてもらう", () => {
    expect(judgeDraftSend({ status: 502, error: "SEND_UNVERIFIED" }).kind).toBe("unverified");
    expect(judgeDraftSend({ status: null, verify: { found: false, draftExists: false } }).kind).toBe("unverified");
    expect(judgeDraftSend({ status: null, verify: null }).kind).toBe("unverified");
  });
  it("通信が切れたが送信済みに見つかった → 送れた", () => {
    expect(judgeDraftSend({ status: null, verify: { found: true, id: "x" } })).toEqual({ kind: "sent", id: "x", threadId: undefined });
  });
  it("そのほかの失敗は理由をそのまま返す", () => {
    expect(judgeDraftSend({ status: 400, error: "INVALID_RECIPIENTS" })).toEqual({ kind: "failed", status: 400, code: "INVALID_RECIPIENTS", reason: undefined });
  });
});

describe("readGmailLink / isRetryableSaveStatus", () => {
  it("壊れた値は捨てる", () => {
    expect(readGmailLink(null)).toBeUndefined();
    expect(readGmailLink({ draftId: "r-123", messageId: "18abcdef", messageIdHeader: "<CAx@mail.gmail.com>", syncedFingerprint: "abc1" }))
      .toEqual({ draftId: "r-123", messageId: "18abcdef", messageIdHeader: "<CAx@mail.gmail.com>", syncedFingerprint: "abc1", createAttempted: undefined });
    expect(readGmailLink({ draftId: "a/b", messageId: "<x>", messageIdHeader: "a\r\nBcc: x", syncedFingerprint: 1 }))
      .toEqual({ draftId: null, messageId: null, messageIdHeader: null, syncedFingerprint: null, createAttempted: undefined });
  });
  it("送り直すのは 429・5xx・通信断だけ", () => {
    expect(isRetryableSaveStatus(null)).toBe(true);
    expect(isRetryableSaveStatus(429)).toBe(true);
    expect(isRetryableSaveStatus(503)).toBe(true);
    expect(isRetryableSaveStatus(400)).toBe(false);
    expect(isRetryableSaveStatus(409)).toBe(false);
  });
});
