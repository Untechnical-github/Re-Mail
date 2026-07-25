import { describe, it, expect } from "vitest";
import { groupEmailsByRoom, mergeAccountGroups, applyFilterGroups } from "./groupEmails";
import { Email } from "../types/email";
import { ChatConfig } from "../types/mail";
import { LocalKey, RoomKeyStr, asLocalKey, encodeRoomKey, decodeRoomKey } from "./roomKey";

const ME = "me@example.com";

function mkEmail(overrides: Partial<Email> & { id: string }): Email {
  return {
    threadId: overrides.id,
    subject: "件名",
    from: "unknown@example.com",
    to: ME,
    date: "2026-01-01T00:00:00.000Z",
    body: "本文",
    snippet: "本文",
    labelIds: ["INBOX"],
    ...overrides,
  };
}

describe("groupEmailsByRoom", () => {
  it("単一相手の基本グルーピング", () => {
    const emails = [mkEmail({ id: "1", from: "田中太郎 <tanaka@example.com>", to: ME })];
    const groups = groupEmailsByRoom(emails, ME, {} as Record<LocalKey, ChatConfig>);
    expect(Object.keys(groups)).toEqual(["田中太郎"]);
    expect(groups[asLocalKey("田中太郎")]).toHaveLength(1);
  });

  it("表示名ルームとアドレスルームが同一人物として統合される", () => {
    const emails = [
      // 表示名が分からない段階（アドレスそのものがルームキーになる）
      mkEmail({ id: "1", from: "tanaka@example.com", to: ME, date: "2026-01-01T00:00:00.000Z" }),
      // 後から表示名付きで届いた受信メール
      mkEmail({ id: "2", from: "田中太郎 <tanaka@example.com>", to: ME, date: "2026-01-02T00:00:00.000Z" }),
    ];
    const groups = groupEmailsByRoom(emails, ME, {} as Record<LocalKey, ChatConfig>);
    expect(Object.keys(groups)).toEqual(["田中太郎"]);
    expect(groups[asLocalKey("田中太郎")].map(e => e.id).sort()).toEqual(["1", "2"]);
  });

  it("送信済みメールが正しい相手の部屋に統合される", () => {
    const emails = [
      mkEmail({ id: "1", from: "田中太郎 <tanaka@example.com>", to: ME }),
      mkEmail({ id: "2", isMe: true, from: ME, to: "tanaka@example.com", labelIds: ["SENT", "INBOX"] }),
    ];
    const groups = groupEmailsByRoom(emails, ME, {} as Record<LocalKey, ChatConfig>);
    expect(Object.keys(groups)).toEqual(["田中太郎"]);
    expect(groups[asLocalKey("田中太郎")].map(e => e.id).sort()).toEqual(["1", "2"]);
    // 送信済みメールのINBOXラベルは強制的に剥奪される
    const sent = groups[asLocalKey("田中太郎")].find(e => e.id === "2")!;
    expect(sent.labelIds).not.toContain("INBOX");
  });

  it("通常グループ（アドレスベース）が受信・送信双方を集約する", () => {
    const chatConfigs: Record<LocalKey, ChatConfig> = {
      [asLocalKey("group:1")]: {
        isGroup: true,
        groupMembers: ["田中太郎", "鈴木花子"],
        groupMemberAddresses: ["tanaka@example.com", "suzuki@example.com"],
        groupMode: "normal",
      },
    } as Record<LocalKey, ChatConfig>;
    const emails = [
      mkEmail({ id: "1", from: "田中太郎 <tanaka@example.com>", to: ME }),
      mkEmail({ id: "2", isMe: true, from: ME, to: "tanaka@example.com, suzuki@example.com", labelIds: ["SENT"] }),
      mkEmail({ id: "3", from: "全く関係ない人 <other@example.com>", to: ME }),
    ];
    const groups = groupEmailsByRoom(emails, ME, chatConfigs);
    expect(groups[asLocalKey("group:1")].map(e => e.id).sort()).toEqual(["1", "2"]);
    // 一斉送信メールはメンバー個別チャットにも反映される
    expect(groups[asLocalKey("田中太郎")].map(e => e.id)).toContain("2");
  });

  it("フィルターグループ（filterCriteria持ち）はアカウント単位の集約対象外にする（applyFilterGroupsの責務のため）", () => {
    const chatConfigs: Record<LocalKey, ChatConfig> = {
      [asLocalKey("filter:1")]: {
        isGroup: true,
        filterCriteria: { conditionSets: [{ textRules: [{ field: "subject", mode: "contains", keyword: "報告" }] }] },
      },
    } as Record<LocalKey, ChatConfig>;
    const emails = [mkEmail({ id: "1", subject: "月次報告", from: "田中太郎 <tanaka@example.com>", to: ME })];
    const groups = groupEmailsByRoom(emails, ME, chatConfigs);
    expect(groups[asLocalKey("filter:1")]).toBeUndefined();
  });
});

describe("applyFilterGroups", () => {
  it("条件に一致すれば送信済みメールも集約する", () => {
    const room = encodeRoomKey(ME, asLocalKey("filter:1"));
    const chatConfigs: Record<RoomKeyStr, ChatConfig> = {
      [room]: {
        isGroup: true,
        filterCriteria: { conditionSets: [{ textRules: [{ field: "subject", mode: "contains", keyword: "報告" }] }] },
      },
    } as Record<RoomKeyStr, ChatConfig>;
    const emails = [
      mkEmail({ id: "1", subject: "月次報告", from: "田中太郎 <tanaka@example.com>", to: ME, accountId: ME }),
      mkEmail({ id: "2", subject: "報告に関する送信", isMe: true, from: ME, to: "tanaka@example.com", labelIds: ["SENT"], accountId: ME }),
      mkEmail({ id: "3", subject: "無関係な件名", from: "田中太郎 <tanaka@example.com>", to: ME, accountId: ME }),
    ];
    const result = applyFilterGroups({} as Record<RoomKeyStr, Email[]>, chatConfigs, emails, ME);
    expect(result[room].map(e => e.id)).toEqual(["1", "2"]);
  });

  it("元のメッセージを非表示にするがONの場合、集約された送信済みメールも元のルームから除外される", () => {
    const room = encodeRoomKey(ME, asLocalKey("filter:1"));
    const chatConfigs: Record<RoomKeyStr, ChatConfig> = {
      [room]: {
        isGroup: true,
        filterCriteria: { conditionSets: [{ textRules: [{ field: "subject", mode: "contains", keyword: "報告" }] }] },
        filterHideOriginal: true,
      },
    } as Record<RoomKeyStr, ChatConfig>;
    const sentEmail = mkEmail({ id: "2", subject: "報告に関する送信", isMe: true, from: ME, to: "tanaka@example.com", labelIds: ["SENT"], accountId: ME });
    const originalRoom = asLocalKey("田中太郎") as unknown as RoomKeyStr;
    const merged: Record<RoomKeyStr, Email[]> = { [originalRoom]: [sentEmail] };
    const emails = [sentEmail];
    const result = applyFilterGroups(merged, chatConfigs, emails, ME);
    expect(result[room].map(e => e.id)).toEqual(["2"]);
    expect(result[originalRoom]).toEqual([]);
  });

  it("複数アカウント分のメールをまたいで集約できる", () => {
    const room = encodeRoomKey(ME, asLocalKey("filter:1"));
    const chatConfigs: Record<RoomKeyStr, ChatConfig> = {
      [room]: {
        isGroup: true,
        filterCriteria: { conditionSets: [{ textRules: [{ field: "subject", mode: "contains", keyword: "報告" }] }] },
      },
    } as Record<RoomKeyStr, ChatConfig>;
    const otherAccount = "me2@example.com";
    const emails = [
      mkEmail({ id: "1", subject: "月次報告", from: "田中太郎 <tanaka@example.com>", to: ME, accountId: ME }),
      mkEmail({ id: "2", subject: "週次報告", from: "鈴木花子 <suzuki@example.com>", to: otherAccount, accountId: otherAccount }),
    ];
    const result = applyFilterGroups({} as Record<RoomKeyStr, Email[]>, chatConfigs, emails, ME);
    expect(result[room].map(e => e.id).sort()).toEqual(["1", "2"]);
  });

  it("criteria.accountEmail を指定すると、そのアカウントのメールだけに絞り込まれる", () => {
    const room = encodeRoomKey(ME, asLocalKey("filter:1"));
    const otherAccount = "me2@example.com";
    const chatConfigs: Record<RoomKeyStr, ChatConfig> = {
      [room]: {
        isGroup: true,
        filterCriteria: {
          conditionSets: [{ textRules: [{ field: "subject", mode: "contains", keyword: "報告" }] }],
          accountEmail: otherAccount,
        },
      },
    } as Record<RoomKeyStr, ChatConfig>;
    const emails = [
      mkEmail({ id: "1", subject: "月次報告", from: "田中太郎 <tanaka@example.com>", to: ME, accountId: ME }),
      mkEmail({ id: "2", subject: "週次報告", from: "鈴木花子 <suzuki@example.com>", to: otherAccount, accountId: otherAccount }),
    ];
    const result = applyFilterGroups({} as Record<RoomKeyStr, Email[]>, chatConfigs, emails, ME);
    expect(result[room].map(e => e.id)).toEqual(["2"]);
  });

  it("filterHideOriginalがONの場合、一致したメッセージを他のルーム（複合キー・他アカウント含む）から除外する", () => {
    const room = encodeRoomKey(ME, asLocalKey("filter:1"));
    const otherRoom = encodeRoomKey(ME, asLocalKey("田中太郎"));
    const chatConfigs: Record<RoomKeyStr, ChatConfig> = {
      [room]: {
        isGroup: true,
        filterCriteria: { conditionSets: [{ textRules: [{ field: "subject", mode: "contains", keyword: "報告" }] }] },
        filterHideOriginal: true,
      },
    } as Record<RoomKeyStr, ChatConfig>;
    const email = mkEmail({ id: "1", subject: "月次報告", from: "田中太郎 <tanaka@example.com>", to: ME, accountId: ME });
    const merged: Record<RoomKeyStr, Email[]> = { [otherRoom]: [email] } as Record<RoomKeyStr, Email[]>;
    const result = applyFilterGroups(merged, chatConfigs, [email], ME);
    expect(result[room].map(e => e.id)).toEqual(["1"]);
    expect(result[otherRoom]).toEqual([]);
  });
});

describe("mergeAccountGroups", () => {
  it("2アカウントに同姓同名の相手がいても、roomKeyが異なるため別チャットとして分離される", () => {
    const groupsA = groupEmailsByRoom(
      [mkEmail({ id: "a1", from: "田中太郎 <tanaka@a.example.com>", to: "me@a.example.com" })],
      "me@a.example.com",
      {} as Record<LocalKey, ChatConfig>,
    );
    const groupsB = groupEmailsByRoom(
      [mkEmail({ id: "b1", from: "田中太郎 <tanaka@b.example.com>", to: "me@b.example.com" })],
      "me@b.example.com",
      {} as Record<LocalKey, ChatConfig>,
    );
    const merged = mergeAccountGroups([
      { accountEmail: "me@a.example.com", groups: groupsA },
      { accountEmail: "me@b.example.com", groups: groupsB },
    ]);

    expect(Object.keys(merged)).toHaveLength(2);
    const decoded = Object.keys(merged).map(k => decodeRoomKey(k));
    expect(decoded.every(d => d.localKey === "田中太郎")).toBe(true);
    expect(new Set(decoded.map(d => d.accountEmail))).toEqual(new Set(["me@a.example.com", "me@b.example.com"]));

    const [roomA] = Object.keys(merged).filter(k => decodeRoomKey(k).accountEmail === "me@a.example.com");
    const [roomB] = Object.keys(merged).filter(k => decodeRoomKey(k).accountEmail === "me@b.example.com");
    expect(merged[roomA as keyof typeof merged].map(e => e.id)).toEqual(["a1"]);
    expect(merged[roomB as keyof typeof merged].map(e => e.id)).toEqual(["b1"]);
  });
});
