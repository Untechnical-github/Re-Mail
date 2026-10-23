import { describe, it, expect } from "vitest";
import { planReply } from "./recipients";

const ME = "me@example.com";

describe("planReply", () => {
  it("Cc なし・To が自分だけなら、全員に返信の切り替えは出さない", () => {
    const p = planReply({ from: "相手 <a@example.com>", to: ME }, [ME]);
    expect(p.senderOnly).toEqual({ to: "相手 <a@example.com>", cc: "" });
    expect(p.extra).toEqual([]);
  });

  it("Cc がある場合、既定（相手のみ）は差出人だけ、全員に返信なら Cc も入る", () => {
    const p = planReply({ from: "相手 <a@example.com>", to: ME, cc: "山田 <b@example.com>, c@example.com" }, [ME]);
    expect(p.senderOnly).toEqual({ to: "相手 <a@example.com>", cc: "" });
    expect(p.all).toEqual({ to: "相手 <a@example.com>", cc: "山田 <b@example.com>, c@example.com" });
    expect(p.extra.map(e => e.address)).toEqual(["b@example.com", "c@example.com"]);
  });

  it("自分が Cc に入っている場合、自分は宛先から外す（大文字小文字は無視）", () => {
    const p = planReply({ from: "a@example.com", to: "b@example.com", cc: "Me@Example.com, c@example.com" }, [ME]);
    expect(p.all).toEqual({ to: "a@example.com, b@example.com", cc: "c@example.com" });
    expect(p.extra.map(e => `${e.field}:${e.address}`)).toEqual(["to:b@example.com", "cc:c@example.com"]);
  });

  it("Reply-To があれば、差出人ではなく Reply-To に返す（全員に返信でも差出人は入れない）", () => {
    const p = planReply({ from: "noreply@example.com", replyTo: "support@example.com", to: ME, cc: "c@example.com" }, [ME]);
    expect(p.senderOnly.to).toBe("support@example.com");
    expect(p.all).toEqual({ to: "support@example.com", cc: "c@example.com" });
  });

  it("To が複数なら、全員に返信で残りの To も To に入る", () => {
    const p = planReply({ from: "a@example.com", to: `${ME}, b@example.com, "Doe, John" <j@example.com>` }, [ME]);
    expect(p.senderOnly.to).toBe("a@example.com");
    expect(p.all).toEqual({ to: 'a@example.com, b@example.com, "Doe, John" <j@example.com>', cc: "" });
    expect(p.extra).toHaveLength(2);
  });

  it("自分が送ったメールへの返信は、元の To に返す（全員に返信なら元の Cc も）", () => {
    const p = planReply({ from: `自分 <${ME}>`, to: "a@example.com", cc: "b@example.com" }, [ME]);
    expect(p.senderOnly.to).toBe("a@example.com");
    expect(p.all).toEqual({ to: "a@example.com", cc: "b@example.com" });
  });

  it("To と Cc の重複は1回だけにする", () => {
    const p = planReply({ from: "a@example.com", to: `${ME}, b@example.com`, cc: "B@example.com, a@example.com" }, [ME]);
    expect(p.all).toEqual({ to: "a@example.com, b@example.com", cc: "" });
  });

  it("自分宛てに自分で送ったメールは、自分に返す", () => {
    const p = planReply({ from: ME, to: ME }, [ME]);
    expect(p.senderOnly.to).toBe(ME);
  });
});
