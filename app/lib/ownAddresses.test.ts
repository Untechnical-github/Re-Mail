import { describe, it, expect } from "vitest";
import {
  buildOwnAddressBook, ownAddressList, resolveOwnAddress, assignOwnAddresses, checkReceiveOnlyAddress, canSendFrom,
  isOwnAddressVisible, accountCheckState, toggleAccountChecks, toggleOwnAddressCheck, ownAddressCheckKey, MAX_RECEIVE_ONLY_ADDRESSES,
} from "./ownAddresses";
import { isMineEmail } from "./filterMatch";

const book = buildOwnAddressBook(
  "me@example.com",
  [
    { sendAsEmail: "me@example.com", canSend: true },
    { sendAsEmail: "Sales@Example.com", canSend: true },
    { sendAsEmail: "me+news@example.com", canSend: true },
    { sendAsEmail: "pending@example.com", canSend: false },
  ],
  ["info@example.org", "SALES@example.com"],
);

describe("buildOwnAddressBook", () => {
  it("主アドレスが先頭・小文字・重なりなし。受信専用から sendAs と重なるものを除く", () => {
    expect(ownAddressList(book)).toEqual(["me@example.com", "sales@example.com", "me+news@example.com", "pending@example.com", "info@example.org"]);
    expect(book.receiveOnly).toEqual(["info@example.org"]);
  });
  it("差出人に使えるのは主アドレスと確認済みの sendAs だけ", () => {
    expect(canSendFrom(book, "SALES@example.com")).toBe(true);
    expect(canSendFrom(book, "pending@example.com")).toBe(false);
    expect(canSendFrom(book, "info@example.org")).toBe(false);
    expect(canSendFrom(book, "me@example.com")).toBe(true);
  });
  it("sendAs が読めなかったときは主アドレスと受信専用アドレスだけ", () => {
    const b = buildOwnAddressBook("me@example.com", null, ["info@example.org"]);
    expect(ownAddressList(b)).toEqual(["me@example.com", "info@example.org"]);
    expect(b.sendable).toEqual(["me@example.com"]);
  });
  it("壊れた受信専用アドレスは捨て、件数に上限がある", () => {
    const many = Array.from({ length: MAX_RECEIVE_ONLY_ADDRESSES + 5 }, (_, i) => `a${i}@example.org`);
    const b = buildOwnAddressBook("me@example.com", null, ["not an address", ...many]);
    expect(b.receiveOnly.length).toBe(MAX_RECEIVE_ONLY_ADDRESSES);
    expect(b.receiveOnly).not.toContain("not an address");
  });
});

describe("resolveOwnAddress", () => {
  it("受信は To → Cc → Delivered-To の順に最初の自分のアドレス", () => {
    expect(resolveOwnAddress({ from: "a@example.net", to: "x@example.net, Sales <sales@example.com>", cc: "me@example.com" }, book, false)).toBe("sales@example.com");
    expect(resolveOwnAddress({ from: "a@example.net", to: "x@example.net", cc: "info@example.org, me@example.com" }, book, false)).toBe("info@example.org");
    expect(resolveOwnAddress({ from: "a@example.net", to: "list@example.net", cc: "", deliveredTo: "INFO@example.org, me@example.com" }, book, false)).toBe("info@example.org");
  });
  it("To に自分の複数のアドレスがあっても最初の1つだけ", () => {
    expect(resolveOwnAddress({ from: "a@example.net", to: "me+news@example.com, sales@example.com", cc: "" }, book, false)).toBe("me+news@example.com");
  });
  it("自分のアドレスが無ければ主アドレス（一覧に無いプラスアドレスも主アドレス）", () => {
    expect(resolveOwnAddress({ from: "a@example.net", to: "me+other@example.com", cc: "" }, book, false)).toBe("me@example.com");
  });
  it("送信は From。一覧に無い From は主アドレス", () => {
    expect(resolveOwnAddress({ from: "Me <SALES@example.com>", to: "a@example.net", cc: "" }, book, true)).toBe("sales@example.com");
    expect(resolveOwnAddress({ from: "x@example.net", to: "a@example.net", cc: "" }, book, true)).toBe("me@example.com");
  });
  it("部分一致で自分のアドレスにしない", () => {
    expect(resolveOwnAddress({ from: "a@example.net", to: "xsales@example.com", cc: "" }, book, false)).toBe("me@example.com");
  });
});

describe("assignOwnAddresses", () => {
  const mine = ownAddressList(book);
  const isOwn = (e: { from: string }) => isMineEmail(e, mine);
  it("受信専用アドレスのスレッドに主アドレスから返信したものは、その受信専用アドレスに入れる", () => {
    const emails = [
      { id: "r1", threadId: "t1", from: "a@example.net", to: "info@example.org", cc: "" },
      { id: "s1", threadId: "t1", from: "me@example.com", to: "a@example.net", cc: "" },
      { id: "s2", threadId: "t2", from: "me@example.com", to: "a@example.net", cc: "" },
      { id: "s3", threadId: "t1", from: "sales@example.com", to: "a@example.net", cc: "" },
    ];
    const m = assignOwnAddresses(emails, book, isOwn);
    expect(m.get("r1")).toBe("info@example.org");
    expect(m.get("s1")).toBe("info@example.org");
    expect(m.get("s2")).toBe("me@example.com");
    // From が主アドレスでないときは例外にしない
    expect(m.get("s3")).toBe("sales@example.com");
  });
  it("sendAs のスレッドの例外は無い（受信専用アドレスだけ）", () => {
    const emails = [
      { id: "r1", threadId: "t1", from: "a@example.net", to: "sales@example.com", cc: "" },
      { id: "s1", threadId: "t1", from: "me@example.com", to: "a@example.net", cc: "" },
    ];
    expect(assignOwnAddresses(emails, book, isOwn).get("s1")).toBe("me@example.com");
  });
});

describe("isMineEmail（自分のアドレス一覧）", () => {
  it("エイリアス・受信専用アドレスからのメールも自分のメール", () => {
    const mine = ownAddressList(book);
    expect(isMineEmail({ from: "Me <me+news@example.com>" }, mine)).toBe(true);
    expect(isMineEmail({ from: "info@example.org" }, mine)).toBe(true);
    expect(isMineEmail({ from: "sales@example.com" }, mine)).toBe(true);
    expect(isMineEmail({ from: "other@example.net" }, mine)).toBe(false);
    expect(isMineEmail({ from: "xinfo@example.org" }, mine)).toBe(false);
  });
});

describe("checkReceiveOnlyAddress", () => {
  it("形式・sendAs との重なり・登録済みを断る", () => {
    expect(checkReceiveOnlyAddress("bad", book).ok).toBe(false);
    expect(checkReceiveOnlyAddress("a b@example.org", book).ok).toBe(false);
    expect(checkReceiveOnlyAddress("user@localhost", book).ok).toBe(false);
    expect(checkReceiveOnlyAddress("Sales@example.com", book).ok).toBe(false);
    expect(checkReceiveOnlyAddress("me@example.com", book).ok).toBe(false);
    expect(checkReceiveOnlyAddress("info@example.org", book).ok).toBe(false);
    expect(checkReceiveOnlyAddress(" New@Example.org ", book)).toEqual({ ok: true, address: "new@example.org" });
  });
  it("上限ちょうどで断る", () => {
    const full = buildOwnAddressBook("me@example.com", null, Array.from({ length: MAX_RECEIVE_ONLY_ADDRESSES }, (_, i) => `a${i}@example.org`));
    expect(checkReceiveOnlyAddress("z@example.org", full).ok).toBe(false);
    const almost = buildOwnAddressBook("me@example.com", null, Array.from({ length: MAX_RECEIVE_ONLY_ADDRESSES - 1 }, (_, i) => `a${i}@example.org`));
    expect(checkReceiveOnlyAddress("z@example.org", almost).ok).toBe(true);
  });
});

describe("チェックボックス", () => {
  const acct = "me@example.com";
  const addrs = ["me@example.com", "sales@example.com"];
  it("既定はすべて表示。アカウントを外すと全アドレスが外れる", () => {
    expect(accountCheckState({}, {}, acct, addrs)).toBe("on");
    const off = toggleAccountChecks({}, {}, acct, addrs);
    expect(off.accounts[acct]).toBe(false);
    expect(addrs.every(a => !isOwnAddressVisible(off.accounts, off.own, acct, a))).toBe(true);
    const on = toggleAccountChecks(off.accounts, off.own, acct, addrs);
    expect(addrs.every(a => isOwnAddressVisible(on.accounts, on.own, acct, a))).toBe(true);
  });
  it("一部だけオンは中間。そこでアカウントを押すと全部オン", () => {
    const one = toggleOwnAddressCheck({}, {}, acct, addrs, "sales@example.com", false);
    expect(accountCheckState(one.accounts, one.own, acct, addrs)).toBe("mixed");
    expect(one.own[ownAddressCheckKey(acct, "sales@example.com")]).toBe(false);
    const all = toggleAccountChecks(one.accounts, one.own, acct, addrs);
    expect(accountCheckState(all.accounts, all.own, acct, addrs)).toBe("on");
  });
  it("全部外れた状態から1つだけオンにすると、ほかは外れたまま・アカウントはオン", () => {
    const off = toggleAccountChecks({}, {}, acct, addrs);
    const one = toggleOwnAddressCheck(off.accounts, off.own, acct, addrs, "sales@example.com", true);
    expect(one.accounts[acct]).toBe(true);
    expect(isOwnAddressVisible(one.accounts, one.own, acct, "me@example.com")).toBe(false);
    expect(isOwnAddressVisible(one.accounts, one.own, acct, "sales@example.com")).toBe(true);
  });
  it("今のアカウントのチェック（false）だけの古い状態は、全アドレスが外れて見える", () => {
    expect(accountCheckState({ [acct]: false }, {}, acct, addrs)).toBe("off");
  });
});
