import { describe, it, expect } from "vitest";
import {
  normalizeRecipients, recipientsFromHeader, recipientsHeader, summarizeRecipients, pickMoveTarget, excludesPartner,
  replyChoices, originalParticipants, quoteGoesToOutsiders, isValidRecipientAddress, recipientsKey, validateSendHeaders, sentRecipientCounts, receivedRole, MAX_RECIPIENTS,
  type ComposeRecipient,
} from "./composeRecipients";

const ME = "me@example.com";
const ALIAS = "alias@example.com";

describe("normalizeRecipients", () => {
  it("同じアドレスは1回だけ、立場は To > Cc > Bcc の順で残す（大文字小文字は区別しない）", () => {
    const { recipients } = normalizeRecipients([
      { address: "a@example.com", role: "bcc" },
      { address: "b@example.com", role: "cc" },
      { address: "A@example.com", name: "山田", role: "cc" },
      { address: "b@example.com", role: "to" },
      { address: "a@example.com", role: "bcc" },
    ]);
    expect(recipients).toEqual([
      { address: "a@example.com", name: "山田", role: "cc" },
      { address: "b@example.com", role: "to" },
    ]);
  });

  it("形が正しくないアドレス・長すぎるアドレス・知らない立場は足さない", () => {
    const long = `${"a".repeat(310)}@example.com`;
    const r = normalizeRecipients([
      { address: "not-an-address", role: "to" },
      { address: "a@example.com\r\nBcc: evil@example.com", role: "to" },
      { address: "x <y@example.com>", role: "to" },
      { address: long, role: "to" },
      { address: "ok@example.com", role: "reply" },
      null, "a@example.com",
      { address: "ok@example.com", role: "to" },
    ]);
    expect(r.recipients).toEqual([{ address: "ok@example.com", role: "to" }]);
    expect(r.invalid).toBe(7);
  });

  it("合計 500 件で止める（超えた分は数えて捨てる）", () => {
    const list = Array.from({ length: MAX_RECIPIENTS + 3 }, (_, i) => ({ address: `u${i}@example.com`, role: "to" }));
    const r = normalizeRecipients(list);
    expect(r.recipients).toHaveLength(MAX_RECIPIENTS);
    expect(r.overLimit).toBe(3);
  });

  it("巨大な配列でも固まらない", () => {
    const list = Array.from({ length: 100_000 }, () => ({ address: "same@example.com", role: "to" }));
    const r = normalizeRecipients(list);
    expect(r.recipients).toHaveLength(1);
  });

  it("表示名から改行と区切りの記号を除く", () => {
    const { recipients } = normalizeRecipients([{ address: "a@example.com", name: 'Ya"ma\r\nda <x>', role: "to" }]);
    expect(recipients[0].name).toBe("Ya ma da x");
  });

  it("配列でなければ空", () => {
    expect(normalizeRecipients("a@example.com").recipients).toEqual([]);
  });
});

describe("isValidRecipientAddress", () => {
  it("ふつうのアドレスだけ通す", () => {
    expect(isValidRecipientAddress("a.b+c@example.co.jp")).toBe(true);
    expect(isValidRecipientAddress("a@b")).toBe(false);
    expect(isValidRecipientAddress("a,b@example.com")).toBe(false);
    expect(isValidRecipientAddress("")).toBe(false);
    expect(isValidRecipientAddress(1)).toBe(false);
  });
});

describe("recipientsFromHeader / recipientsHeader", () => {
  it("ヘッダーの並びを送信先にし、立場ごとのヘッダーに戻せる", () => {
    const list = [
      ...recipientsFromHeader('"山田, 太郎" <yamada@example.com>, b@example.com', "to"),
      ...recipientsFromHeader("鈴木 <suzuki@example.com>", "cc"),
      ...recipientsFromHeader("c@example.com", "bcc"),
    ];
    expect(list.map(r => r.role)).toEqual(["to", "to", "cc", "bcc"]);
    expect(recipientsHeader(list, "to")).toBe('"山田, 太郎" <yamada@example.com>, b@example.com');
    expect(recipientsHeader(list, "cc")).toBe('"鈴木" <suzuki@example.com>');
    expect(recipientsHeader(list, "bcc")).toBe("c@example.com");
  });
});

describe("summarizeRecipients", () => {
  it("1人なら名前だけ、複数なら「ほかN名」と Cc・Bcc の数（0 のものは出さない）", () => {
    const one: ComposeRecipient[] = [{ address: "y@example.com", name: "山田", role: "to" }];
    expect(summarizeRecipients(one)).toBe("山田さん");
    expect(summarizeRecipients([...one, { address: "b@example.com", role: "cc" }, { address: "c@example.com", role: "bcc" }])).toBe("山田さん ほか2名（Cc 1・Bcc 1）");
    expect(summarizeRecipients([...one, { address: "b@example.com", role: "to" }])).toBe("山田さん ほか1名");
    expect(summarizeRecipients([{ address: "c@example.com", role: "bcc" }])).toBe("c@example.com（Bcc 1）");
    expect(summarizeRecipients([])).toBe("");
  });
});

describe("pickMoveTarget / excludesPartner", () => {
  const list: ComposeRecipient[] = [
    { address: "bcc1@example.com", role: "bcc" },
    { address: "cc1@example.com", role: "cc" },
    { address: "cc2@example.com", role: "cc" },
  ];
  it("To の最初、無ければ Cc の最初、無ければ Bcc の最初（追加した順）", () => {
    expect(pickMoveTarget(list)?.address).toBe("cc1@example.com");
    expect(pickMoveTarget([...list, { address: "to1@example.com", role: "to" }])?.address).toBe("to1@example.com");
    expect(pickMoveTarget([list[0]])?.address).toBe("bcc1@example.com");
    expect(pickMoveTarget([])).toBeNull();
  });
  it("相手を含まず1人以上いるときだけ true（0人・相手不明は false）", () => {
    expect(excludesPartner(list, "partner@example.com")).toBe(true);
    expect(excludesPartner([...list, { address: "Partner@Example.com", role: "bcc" }], "partner@example.com")).toBe(false);
    expect(excludesPartner([], "partner@example.com")).toBe(false);
    expect(excludesPartner(list, "山田")).toBe(false);
  });
});

describe("replyChoices", () => {
  const partner: ComposeRecipient = { address: "partner@example.com", name: "相手", role: "to" };
  it("返信は相手＋差出人（Reply-To 優先）、全員に返信は相手＋To（To）＋Cc（Cc）。自分とエイリアスを除き、重なりは1つ", () => {
    const c = replyChoices({
      from: "差出人 <sender@example.com>",
      replyTo: "返信先 <reply@example.com>",
      to: `${ME}, partner@example.com, other@example.com`,
      cc: `${ALIAS}, cc@example.com, other@example.com`,
    }, partner, [ME, ALIAS]);
    expect(c.needsChoice).toBe(true);
    expect(c.reply).toEqual([partner, { address: "reply@example.com", name: "返信先", role: "to" }]);
    expect(c.replyAll.map(r => `${r.role}:${r.address}`)).toEqual([
      "to:partner@example.com", "to:reply@example.com", "to:other@example.com", "cc:cc@example.com",
    ]);
    expect(c.replyAll.some(r => r.role === "bcc")).toBe(false);
  });

  it("自分と相手以外がいなければ選ばせない", () => {
    const c = replyChoices({ from: "相手 <partner@example.com>", to: ME }, partner, [ME]);
    expect(c.needsChoice).toBe(false);
    expect(c.reply).toEqual([partner]);
  });

  it("自分が送ったメールを返信元にしても、自分は宛先に入らない", () => {
    const c = replyChoices({ from: ME, to: "x@example.com", cc: ME }, partner, [ME]);
    expect(c.reply.map(r => r.address)).toEqual(["partner@example.com", "x@example.com"]);
  });
});

describe("originalParticipants", () => {
  it("差出人（Reply-To 優先）・To・Cc を元の立場付きで、自分とエイリアスを除いて出す", () => {
    const list = originalParticipants({ from: "s@example.com", replyTo: "r@example.com", to: `${ME}, t@example.com`, cc: `${ALIAS}, c@example.com` }, [ME, ALIAS]);
    expect(list.map(r => `${r.role}:${r.address}`)).toEqual(["to:r@example.com", "to:t@example.com", "cc:c@example.com"]);
  });
});

describe("quoteGoesToOutsiders", () => {
  const src = { from: "s@example.com", replyTo: "r@example.com", to: ME, cc: "c@example.com" };
  it("送信先に元のやり取りの人が1人もいないときだけ true", () => {
    expect(quoteGoesToOutsiders([{ address: "new@example.com", role: "to" }], src, [ME])).toBe(true);
    expect(quoteGoesToOutsiders([{ address: "new@example.com", role: "to" }, { address: "C@example.com", role: "bcc" }], src, [ME])).toBe(false);
    expect(quoteGoesToOutsiders([{ address: "s@example.com", role: "to" }], src, [ME])).toBe(false);
    expect(quoteGoesToOutsiders([{ address: "r@example.com", role: "to" }], src, [ME])).toBe(false);
  });
  it("自分は元のやり取りの人に数えない。返信元が無ければ false", () => {
    expect(quoteGoesToOutsiders([{ address: ME, role: "to" }], src, [ME])).toBe(true);
    expect(quoteGoesToOutsiders([{ address: "new@example.com", role: "to" }], null, [ME])).toBe(false);
  });
});

describe("recipientsKey", () => {
  it("並び順に左右されない", () => {
    const a: ComposeRecipient[] = [{ address: "a@example.com", role: "to" }, { address: "B@example.com", role: "cc" }];
    expect(recipientsKey(a)).toBe(recipientsKey([a[1], { address: "A@example.com", role: "to" }]));
    expect(recipientsKey(a)).not.toBe(recipientsKey([{ address: "a@example.com", role: "cc" }, a[1]]));
  });
});

describe("validateSendHeaders", () => {
  it("To / Cc / Bcc をそのまま通し、件数を数える", () => {
    const r = validateSendHeaders({ to: '"山田, 太郎" <a@example.com>', cc: "b@example.com", bcc: "鈴木 <c@example.com>, d@example.com" });
    expect(r).toEqual({ ok: true, count: 4, headers: { to: '"山田, 太郎" <a@example.com>', cc: "b@example.com", bcc: "鈴木 <c@example.com>, d@example.com" } });
  });
  it("Bcc だけでも送れる。1件も無ければ NO_RECIPIENTS", () => {
    expect(validateSendHeaders({ bcc: "b@example.com" }).ok).toBe(true);
    expect(validateSendHeaders({ to: "", cc: " " })).toEqual({ ok: false, error: "NO_RECIPIENTS" });
  });
  it("改行・形が正しくない・文字列でない値は INVALID_RECIPIENTS", () => {
    expect(validateSendHeaders({ to: "a@example.com\r\nBcc: x@example.com" })).toEqual({ ok: false, error: "INVALID_RECIPIENTS" });
    expect(validateSendHeaders({ to: "山田" })).toEqual({ ok: false, error: "INVALID_RECIPIENTS" });
    expect(validateSendHeaders({ to: ["a@example.com"] })).toEqual({ ok: false, error: "INVALID_RECIPIENTS" });
  });
  it("合計 500 件を超えたら TOO_MANY_RECIPIENTS", () => {
    const list = (n: number) => Array.from({ length: n }, (_, i) => `u${i}@example.com`).join(", ");
    expect(validateSendHeaders({ to: list(300), bcc: list(200) }).ok).toBe(true);
    expect(validateSendHeaders({ to: list(300), bcc: list(201) })).toEqual({ ok: false, error: "TOO_MANY_RECIPIENTS" });
    expect(validateSendHeaders({ to: "a".repeat(600_000) })).toEqual({ ok: false, error: "TOO_MANY_RECIPIENTS" });
  });
});

describe("sentRecipientCounts / receivedRole", () => {
  it("送ったメールの人数（0 のものは出さない）", () => {
    expect(sentRecipientCounts({ to: "a@example.com", cc: '"山田, 太郎" <b@example.com>, c@example.com', bcc: "d@example.com" })).toBe("To 1・Cc 2・Bcc 1");
    expect(sentRecipientCounts({ to: "a@example.com" })).toBe("To 1");
    expect(sentRecipientCounts({ bcc: "d@example.com" })).toBe("Bcc 1");
  });
  it("受け取ったメールの自分の立場（エイリアスを含む）", () => {
    expect(receivedRole({ to: `相手 <a@example.com>, ${ME}` }, [ME])).toBe("To");
    expect(receivedRole({ to: "a@example.com", cc: `Me <${ALIAS.toUpperCase()}>` }, [ME, ALIAS])).toBe("Cc");
    expect(receivedRole({ to: "list@example.com" }, [ME])).toBe("宛先に自分なし");
  });
});
