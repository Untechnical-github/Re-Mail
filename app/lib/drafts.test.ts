import { describe, it, expect } from "vitest";
import { isEmptyDraft, hasDraftContent } from "./drafts";

describe("isEmptyDraft", () => {
  const empty = { subject: "", body: "", replyToMessage: null, attachments: [] };

  it("空白だけなら空とみなす（空の下書きを溜めない）", () => {
    expect(isEmptyDraft(empty)).toBe(true);
    expect(isEmptyDraft({ ...empty, subject: "  ", body: "\n " })).toBe(true);
  });

  it("本文・件名・返信先・添付のどれかがあれば空ではない", () => {
    expect(isEmptyDraft({ ...empty, body: "あ" })).toBe(false);
    expect(isEmptyDraft({ ...empty, subject: "件名" })).toBe(false);
    expect(isEmptyDraft({ ...empty, replyToMessage: { id: "a", threadId: "", subject: "", from: "", to: "", date: "", body: "", snippet: "", labelIds: [] } })).toBe(false);
    expect(isEmptyDraft({ ...empty, attachments: [{ filename: "a.pdf", mimeType: "application/pdf", size: 1, data: "QQ==" }] })).toBe(false);
  });

  it("送信先を自分で変えていれば（既定でなければ）空ではない", () => {
    expect(isEmptyDraft({ ...empty, recipients: null })).toBe(true);
    expect(isEmptyDraft({ ...empty, recipients: [] })).toBe(false);
    expect(isEmptyDraft({ ...empty, recipients: [{ address: "a@example.com", role: "cc" }] })).toBe(false);
  });
});

describe("hasDraftContent", () => {
  const empty = { subject: "", body: "", replyToMessage: null, attachments: [] };

  it("送信先を変えただけなら書いた内容は無い（新しいチャットを片付けてよい）", () => {
    expect(hasDraftContent({ ...empty, recipients: [{ address: "a@example.com", role: "cc" }] } as typeof empty)).toBe(false);
    expect(hasDraftContent({ ...empty, subject: " ", body: "\n " })).toBe(false);
  });

  it("本文・件名・返信元・添付のどれかがあれば内容がある", () => {
    expect(hasDraftContent({ ...empty, body: "あ" })).toBe(true);
    expect(hasDraftContent({ ...empty, subject: "件名" })).toBe(true);
    expect(hasDraftContent({ ...empty, replyToMessage: { id: "a", threadId: "", subject: "", from: "", to: "", date: "", body: "", snippet: "", labelIds: [] } })).toBe(true);
    expect(hasDraftContent({ ...empty, attachments: [{ filename: "a.pdf", mimeType: "application/pdf", size: 1, data: "QQ==" }] })).toBe(true);
  });
});
