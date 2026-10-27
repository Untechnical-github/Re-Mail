import { describe, it, expect } from "vitest";
import { groupEmailsByRoom, mergeAccountGroups, applyFilterGroups, mailPartnerOf, roomPartner } from "./groupEmails";
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
  it("同じアドレスで表示名が違うメールは、いちばん新しい表示名の1つのチャットにまとめる", () => {
    const emails = [
      mkEmail({ id: "1", from: "髙澤家 <family@example.com>", date: "2026-02-01T00:00:00.000Z" }),
      mkEmail({ id: "2", from: "高澤悠樹 <family@example.com>", date: "2026-01-01T00:00:00.000Z" }),
      mkEmail({ id: "3", from: ME, to: "高澤悠樹 <family@example.com>", labelIds: ["SENT"], date: "2026-01-02T00:00:00.000Z" }),
    ];
    const groups = groupEmailsByRoom(emails, ME, {} as Record<LocalKey, ChatConfig>);
    expect(Object.keys(groups)).toEqual(["髙澤家"]);
    expect(groups[asLocalKey("髙澤家")].map(e => e.id).sort()).toEqual(["1", "2", "3"]);
  });

  it("表示名が違うとき、設定（ピン留めなど）のある名前のチャットを優先する", () => {
    const emails = [
      mkEmail({ id: "1", from: "髙澤家 <family@example.com>", date: "2026-02-01T00:00:00.000Z" }),
      mkEmail({ id: "2", from: "高澤悠樹 <family@example.com>", date: "2026-01-01T00:00:00.000Z" }),
    ];
    const configs = { [asLocalKey("高澤悠樹")]: { isPinned: true } } as unknown as Record<LocalKey, ChatConfig>;
    const groups = groupEmailsByRoom(emails, ME, configs);
    expect(Object.keys(groups)).toEqual(["高澤悠樹"]);
  });

  it("エイリアス（別のアドレスから送信）で送ったメールは、自分が送ったメールとして相手のチャットに入る", () => {
    const ALIAS = "alias@example.com";
    const emails = [
      mkEmail({ id: "1", from: "田中太郎 <tanaka@example.com>", to: ALIAS }),
      mkEmail({ id: "2", from: `自分 <${ALIAS}>`, to: "田中太郎 <tanaka@example.com>", labelIds: ["SENT"] }),
    ];
    const groups = groupEmailsByRoom(emails, ME, {} as Record<LocalKey, ChatConfig>, [ALIAS]);
    expect(Object.keys(groups)).toEqual(["田中太郎"]);
    expect(groups[asLocalKey("田中太郎")].find(e => e.id === "2")!.isMe).toBe(true);
  });

  it("エイリアスが別のアカウントのとき、そこから届いたメール（受信箱にある）は受け取ったメールとし、Gmail の「送信済み」を画面では外す", () => {
    const FAMILY = "family@example.com";
    const emails = [
      mkEmail({ id: "1", from: `家族 <${FAMILY}>`, to: ME, labelIds: ["UNREAD", "SENT", "INBOX"] }),
      // アーカイブ済み（INBOX なし）でも、To / Cc に自分がいれば受け取ったメール
      mkEmail({ id: "2", from: `家族 <${FAMILY}>`, to: `${FAMILY}`, cc: ME, labelIds: ["SENT"] }),
      // エイリアスで自分が誰かに送ったメールは、自分のメール
      mkEmail({ id: "3", from: `家族 <${FAMILY}>`, to: "田中太郎 <tanaka@example.com>", labelIds: ["SENT"] }),
    ];
    const groups = groupEmailsByRoom(emails, ME, {} as Record<LocalKey, ChatConfig>, [ME, FAMILY]);
    const family = groups[asLocalKey("家族")];
    expect(family.map(e => e.id).sort()).toEqual(["1", "2"]);
    expect(family.every(e => !e.isMe && !(e.labelIds || []).includes("SENT"))).toBe(true);
    expect(family.find(e => e.id === "1")!.labelIds).toEqual(["UNREAD", "INBOX"]);
    expect(groups[asLocalKey("田中太郎")].map(e => e.id)).toEqual(["3"]);
    // 元のメールのラベルは変えない
    expect(emails[0].labelIds).toEqual(["UNREAD", "SENT", "INBOX"]);
  });

  it("同じ表示名でもアドレスが1つだけなら、名前はそのまま", () => {
    const emails = [mkEmail({ id: "1", from: "Google <no-reply@example.com>" }), mkEmail({ id: "2", from: "Google <alerts@example.com>" })];
    const groups = groupEmailsByRoom(emails, ME, {} as Record<LocalKey, ChatConfig>);
    expect(Object.keys(groups)).toEqual(["Google"]);
  });

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
        filterCriteria: { accountEmail: ME, conditionSets: [{ textRules: [{ field: "subject", mode: "contains", keyword: "報告" }] }] },
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
        filterCriteria: { accountEmail: ME, conditionSets: [{ textRules: [{ field: "subject", mode: "contains", keyword: "報告" }] }] },
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
        filterCriteria: { accountEmail: ME, conditionSets: [{ textRules: [{ field: "subject", mode: "contains", keyword: "報告" }] }] },
        filterHideOriginal: true,
      },
    } as Record<RoomKeyStr, ChatConfig>;
    const sentEmail = mkEmail({ id: "2", subject: "報告に関する送信", isMe: true, from: ME, to: "tanaka@example.com", labelIds: ["SENT"], accountId: ME });
    const originalRoom = encodeRoomKey(ME, asLocalKey("田中太郎"));
    const merged: Record<RoomKeyStr, Email[]> = { [originalRoom]: [sentEmail] };
    const emails = [sentEmail];
    const result = applyFilterGroups(merged, chatConfigs, emails, ME);
    expect(result[room].map(e => e.id)).toEqual(["2"]);
    expect(result[originalRoom]).toEqual([]);
  });

  it("ほかのアカウントのメールは混ぜない（そのグループのアカウントのメールだけ）", () => {
    const room = encodeRoomKey(ME, asLocalKey("filter:1"));
    const chatConfigs: Record<RoomKeyStr, ChatConfig> = {
      [room]: {
        isGroup: true,
        filterCriteria: { accountEmail: ME, conditionSets: [{ textRules: [{ field: "subject", mode: "contains", keyword: "報告" }] }] },
      },
    } as Record<RoomKeyStr, ChatConfig>;
    const otherAccount = "me2@example.com";
    const emails = [
      mkEmail({ id: "1", subject: "月次報告", from: "田中太郎 <tanaka@example.com>", to: ME, accountId: ME }),
      mkEmail({ id: "2", subject: "週次報告", from: "鈴木花子 <suzuki@example.com>", to: otherAccount, accountId: otherAccount }),
    ];
    const result = applyFilterGroups({} as Record<RoomKeyStr, Email[]>, chatConfigs, emails, ME);
    expect(result[room].map(e => e.id)).toEqual(["1"]);
  });

  it("ほかのアカウントのグループは、そのアカウントのメールだけを集める", () => {
    const otherAccount = "me2@example.com";
    const room = encodeRoomKey(otherAccount, asLocalKey("filter:1"));
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
        filterCriteria: { accountEmail: ME, conditionSets: [{ textRules: [{ field: "subject", mode: "contains", keyword: "報告" }] }] },
        filterHideOriginal: true,
      },
    } as Record<RoomKeyStr, ChatConfig>;
    const email = mkEmail({ id: "1", subject: "月次報告", from: "田中太郎 <tanaka@example.com>", to: ME, accountId: ME });
    // 同じメールが（取得の都合で）ほかのアカウントのルームにも入っていても、そちらは消さない
    const otherAccountRoom = encodeRoomKey("me2@example.com", asLocalKey("田中太郎"));
    const merged: Record<RoomKeyStr, Email[]> = { [otherRoom]: [email], [otherAccountRoom]: [email] } as Record<RoomKeyStr, Email[]>;
    const result = applyFilterGroups(merged, chatConfigs, [email], ME);
    expect(result[room].map(e => e.id)).toEqual(["1"]);
    expect(result[otherRoom]).toEqual([]);
    expect(result[otherAccountRoom].map(e => e.id)).toEqual(["1"]);
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

describe("groupMemberAddresses", () => {
  it("保存したメンバーのアドレスだけを使う（小文字にそろえる）", async () => {
    const { groupMemberAddresses } = await import("./groupEmails");
    expect([...groupMemberAddresses({ isGroup: true, groupMembers: ["田中", "鈴木"], groupMemberAddresses: ["Tanaka@Example.com", "suzuki@example.com"] } as ChatConfig)])
      .toEqual(["tanaka@example.com", "suzuki@example.com"]);
  });

  it("アドレスが保存されていない・数が合わない（壊れた）グループは空にし、受信メールから推定しない", async () => {
    const { groupMemberAddresses } = await import("./groupEmails");
    expect(groupMemberAddresses({ isGroup: true, groupMembers: ["田中"] } as ChatConfig).size).toBe(0);
    expect(groupMemberAddresses({ isGroup: true, groupMembers: ["田中", "鈴木"], groupMemberAddresses: ["tanaka@example.com"] } as ChatConfig).size).toBe(0);
    expect(groupMemberAddresses({ isGroup: true, groupMembers: ["田中"], groupMemberAddresses: [5] } as unknown as ChatConfig).size).toBe(0);
  });
});

describe("groupEmailsByRoom：Reply-To と送ったメールの入れ先", () => {
  const none = {} as Record<LocalKey, ChatConfig>;
  const ids = (list: Email[] | undefined) => (list || []).map(e => e.id).sort();

  it("Reply-To（表示名あり）のあるメールは、Reply-To の表示名のルームにまとまる", () => {
    const groups = groupEmailsByRoom([
      mkEmail({ id: "1", from: "受付 <noreply@example.com>", replyTo: "山田 <yamada@example.com>" }),
      mkEmail({ id: "2", from: "山田 <yamada@example.com>" }),
    ], ME, none);
    expect(Object.keys(groups)).toEqual(["山田"]);
    expect(ids(groups[asLocalKey("山田")])).toEqual(["1", "2"]);
  });

  it("Reply-To に表示名が無ければアドレスのルームにし、同じアドレスの表示名ルームがあればそちらへまとめる", () => {
    const only = groupEmailsByRoom([mkEmail({ id: "1", from: "受付 <noreply@example.com>", replyTo: "yamada@example.com" })], ME, none);
    expect(Object.keys(only)).toEqual(["yamada@example.com"]);
    const merged = groupEmailsByRoom([
      mkEmail({ id: "1", from: "受付 <noreply@example.com>", replyTo: "yamada@example.com" }),
      mkEmail({ id: "2", from: "山田 <yamada@example.com>" }),
    ], ME, none);
    expect(Object.keys(merged)).toEqual(["山田"]);
    expect(ids(merged[asLocalKey("山田")])).toEqual(["1", "2"]);
  });

  it("問い合わせフォームの形：From が共通でも Reply-To が人ごとに違えば、別々のルームになる", () => {
    const groups = groupEmailsByRoom([
      mkEmail({ id: "1", from: "お問い合わせフォーム <form@example.com>", replyTo: "a@example.com" }),
      mkEmail({ id: "2", from: "お問い合わせフォーム <form@example.com>", replyTo: "b@example.com" }),
    ], ME, none);
    expect(Object.keys(groups).sort()).toEqual(["a@example.com", "b@example.com"]);
    expect(groups[asLocalKey("お問い合わせフォーム")]).toBeUndefined();
  });

  it("Reply-To が自分（エイリアスを含む）なら無視して From のルームにする", () => {
    const groups = groupEmailsByRoom([
      mkEmail({ id: "1", from: "田中 <tanaka@example.com>", replyTo: ME }),
      mkEmail({ id: "2", from: "鈴木 <suzuki@example.com>", replyTo: "Alias <alias@example.com>" }),
    ], ME, none, ["alias@example.com"]);
    expect(Object.keys(groups).sort()).toEqual(["田中", "鈴木"].sort());
  });

  it("自分が送ったメールは、To / Cc / Bcc に入っている相手のチャットすべてに入る", () => {
    const groups = groupEmailsByRoom([
      mkEmail({ id: "1", from: "田中 <tanaka@example.com>" }),
      mkEmail({ id: "2", from: "鈴木 <suzuki@example.com>" }),
      mkEmail({ id: "3", from: "佐藤 <sato@example.com>" }),
      mkEmail({ id: "4", from: "受付 <noreply@example.com>", replyTo: "yamada@example.com" }),
      mkEmail({ id: "s", isMe: true, from: ME, to: "tanaka@example.com", cc: "鈴木 <suzuki@example.com>", bcc: "yamada@example.com", labelIds: ["SENT"] }),
    ], ME, none);
    expect(ids(groups[asLocalKey("田中")])).toEqual(["1", "s"]);
    expect(ids(groups[asLocalKey("鈴木")])).toEqual(["2", "s"]);
    expect(ids(groups[asLocalKey("yamada@example.com")])).toEqual(["4", "s"]);
    expect(ids(groups[asLocalKey("佐藤")])).toEqual(["3"]);
  });

  it("どのチャットにも当たらなければ、To の最初（無ければ Cc、Bcc）の名前で新しいルームを作る。あとの送ったメールもそこに入る", () => {
    const groups = groupEmailsByRoom([
      mkEmail({ id: "s1", isMe: true, from: ME, to: "", cc: "", bcc: "秘密 <bcc@example.com>", labelIds: ["SENT"], date: "2026-01-01T00:00:00.000Z" }),
      mkEmail({ id: "s2", isMe: true, from: ME, to: "x@example.com", cc: "秘密 <bcc@example.com>", labelIds: ["SENT"], date: "2026-01-02T00:00:00.000Z" }),
    ], ME, none);
    expect(ids(groups[asLocalKey("秘密")])).toEqual(["s1", "s2"]);
    expect(groups[asLocalKey("x@example.com")]).toBeUndefined();
  });

  it("純正 Gmail から Bcc だけで送ったメール（To が undisclosed-recipients:;）は、Bcc の相手のチャットに入る", () => {
    const groups = groupEmailsByRoom([
      mkEmail({ id: "1", from: "田中 <tanaka@example.com>" }),
      mkEmail({ id: "s1", isMe: true, from: ME, to: "undisclosed-recipients:;", bcc: "tanaka@example.com", labelIds: ["SENT"] }),
      mkEmail({ id: "s2", isMe: true, from: ME, to: "undisclosed-recipients:;", bcc: "秘密 <bcc@example.com>", labelIds: ["SENT"] }),
    ], ME, none);
    expect(ids(groups[asLocalKey("田中")])).toEqual(["1", "s1"]);
    expect(ids(groups[asLocalKey("秘密")])).toEqual(["s2"]);
    expect(Object.keys(groups).some(k => k.includes("undisclosed"))).toBe(false);
  });

  it("部分一致ではルームに入れない（「田中」のルームに「田中太郎」宛てのメールを入れない）", () => {
    const groups = groupEmailsByRoom([
      mkEmail({ id: "1", from: "田中 <tanaka@example.com>" }),
      mkEmail({ id: "s", isMe: true, from: ME, to: "田中太郎 <taro@example.com>", labelIds: ["SENT"] }),
    ], ME, none);
    expect(ids(groups[asLocalKey("田中")])).toEqual(["1"]);
    expect(ids(groups[asLocalKey("田中太郎")])).toEqual(["s"]);
  });

  it("グループの規則は変わらない（宛先の集合がメンバーと完全一致する送信メールだけがグループに入る）", () => {
    const chatConfigs: Record<LocalKey, ChatConfig> = {
      [asLocalKey("group:1")]: { isGroup: true, groupMembers: ["田中", "鈴木"], groupMemberAddresses: ["tanaka@example.com", "suzuki@example.com"] },
    } as Record<LocalKey, ChatConfig>;
    const groups = groupEmailsByRoom([
      mkEmail({ id: "1", from: "田中 <tanaka@example.com>" }),
      mkEmail({ id: "g", isMe: true, from: ME, to: "tanaka@example.com, suzuki@example.com", labelIds: ["SENT"] }),
      mkEmail({ id: "c", isMe: true, from: ME, to: "tanaka@example.com", cc: "suzuki@example.com", labelIds: ["SENT"] }),
    ], ME, chatConfigs);
    expect(ids(groups[asLocalKey("group:1")])).toEqual(["1", "g"]);
    expect(ids(groups[asLocalKey("田中")])).toEqual(["1", "c", "g"]);
    expect(ids(groups[asLocalKey("鈴木")])).toEqual(["g"]);
  });
});

describe("mailPartnerOf", () => {
  it("Reply-To（自分以外）を優先し、無ければ From", () => {
    expect(mailPartnerOf({ from: "受付 <a@example.com>", replyTo: "山田 <Y@example.com>" }, [ME])).toEqual({ name: "山田", address: "y@example.com", roomName: "山田", viaReplyTo: true });
    expect(mailPartnerOf({ from: "受付 <a@example.com>", replyTo: ME }, [ME])).toMatchObject({ address: "a@example.com", roomName: "受付", viaReplyTo: false });
    expect(mailPartnerOf({ from: "a@example.com" }, [ME])).toMatchObject({ address: "a@example.com", roomName: "a@example.com" });
  });
});

describe("roomPartner", () => {
  it("受信メールがあれば Reply-To 優先で相手を決める", () => {
    expect(roomPartner([mkEmail({ id: "1", from: "受付 <a@example.com>", replyTo: "山田 <y@example.com>" })], "山田", ME)).toEqual({ name: "山田", address: "y@example.com" });
  });
  it("送ったメールしか無ければ、ルーム名に合う宛先（無ければ最初の宛先）", () => {
    const sent = mkEmail({ id: "s", isMe: true, from: ME, to: "x@example.com, 鈴木 <suzuki@example.com>", bcc: "z@example.com" });
    expect(roomPartner([sent], "鈴木", ME)).toEqual({ name: "鈴木", address: "suzuki@example.com" });
    expect(roomPartner([sent], "z@example.com", ME)).toEqual({ name: "", address: "z@example.com" });
    expect(roomPartner([sent], "別の人", ME)).toEqual({ name: "", address: "x@example.com" });
    expect(roomPartner([], "a@example.com", ME)).toEqual({ name: "", address: "" });
  });
});
