import { describe, it, expect } from "vitest";
import { isEmptyDraft } from "./drafts";

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
});
