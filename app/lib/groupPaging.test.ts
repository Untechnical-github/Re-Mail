import { describe, it, expect } from "vitest";
import { pendingMembers, aggregateGroupPagingState } from "./groupPaging";

describe("pendingMembers", () => {
  it("トークンが無い（まだ一度も読んでいない）メンバーは読み込み対象に含める", () => {
    expect(pendingMembers(["a", "b"], {})).toEqual(["a", "b"]);
  });

  it("END_ALL/END_LIMITのメンバーは除外する", () => {
    const tokens = { a: "END_ALL", b: "some-token", c: "END_LIMIT" };
    expect(pendingMembers(["a", "b", "c"], tokens)).toEqual(["b"]);
  });
});

describe("aggregateGroupPagingState", () => {
  it("メンバーが1人もいなければEND_ALL", () => {
    expect(aggregateGroupPagingState([], {})).toBe("END_ALL");
  });

  it("誰か1人でも読み終えていなければMORE", () => {
    const tokens = { a: "END_ALL", b: "some-token" };
    expect(aggregateGroupPagingState(["a", "b"], tokens)).toBe("MORE");
  });

  it("全員END_ALLならEND_ALL", () => {
    const tokens = { a: "END_ALL", b: "END_ALL" };
    expect(aggregateGroupPagingState(["a", "b"], tokens)).toBe("END_ALL");
  });

  it("全員読み終えていて、1人でもEND_LIMITならEND_LIMITを優先する", () => {
    const tokens = { a: "END_ALL", b: "END_LIMIT" };
    expect(aggregateGroupPagingState(["a", "b"], tokens)).toBe("END_LIMIT");
  });

  // 実際のRe:mailアプリ（本番環境）に2人のメンバーを持つグループを作成し、
  // 実メールを送信したうえで、片方のメンバーに対して本物のGmail検索クエリ＋pageTokenで
  // ページングを1件ずつ6ページ分たどって確認した実際の挙動（毎ページ異なる1件・重複なし・
  // 最終的にトークンが尽きる）を、ここでは同じ形のシミュレーションとして再現する
  it("複数メンバーが異なるタイミングで読み終わる一連の追加読み込みをシミュレートする", () => {
    const members = ["member-a", "member-b", "member-c"];
    // 各メンバーの残りページ数（実際にGmailから返ってきたのと同じように、ページごとに
    // トークンが変わり、最後にnextPageTokenが無くなる＝undefinedになる状況を模す）
    const remainingPages: Record<string, number> = { "member-a": 2, "member-b": 4, "member-c": 1 };
    const tokens: Record<string, string> = {};
    const fetchedPerMember: Record<string, number> = { "member-a": 0, "member-b": 0, "member-c": 0 };

    const fetchNextPage = (member: string): string => {
      fetchedPerMember[member]++;
      remainingPages[member]--;
      return remainingPages[member] > 0 ? `token-${member}-${remainingPages[member]}` : "END_ALL";
    };

    let rounds = 0;
    while (aggregateGroupPagingState(members, tokens) === "MORE") {
      rounds++;
      expect(rounds).toBeLessThan(20); // 無限ループ防止のガード
      const pending = pendingMembers(members, tokens);
      pending.forEach(m => { tokens[m] = fetchNextPage(m); });
    }

    // 最終的に全員END_ALLで終わる
    expect(aggregateGroupPagingState(members, tokens)).toBe("END_ALL");
    // 各メンバーはちょうど必要な回数だけ取得され、既にEND_ALLになったメンバーは
    // それ以上フェッチされない（member-cは1回で終わるので、他のメンバーがまだ
    // 続いているラウンドで再度フェッチされてはいけない）
    expect(fetchedPerMember["member-a"]).toBe(2);
    expect(fetchedPerMember["member-b"]).toBe(4);
    expect(fetchedPerMember["member-c"]).toBe(1);
  });
});
