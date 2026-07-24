// フィルターツール（作成/非表示/ピン留め/移動/削除）と検索バーで共有する、
// メールが自分の送信したものかどうかの判定・保存場所判定・条件マッチングロジック。

// メールが自分の送信したものかどうかの判定。バックエンドが返す「生の」メールデータには
// isMe フィールドが元々存在せず、送信直後にローカルで作った表示用オブジェクトにだけ isMe:true を
// 付けている。そのオブジェクトが後から（60秒毎の自動更新や再取得で）生データに上書きされると
// isMe が失われるため、From に自分のアドレスが含まれるかどうかのフォールバックを必ず併用する
export function isMineEmail(e: any, myEmail: string): boolean {
  return !!e.isMe || !!(myEmail && (e.from || "").includes(myEmail));
}

export type FindBarBoxKey = "inbox" | "archive" | "sent" | "spam" | "trash";

// メッセージがどの場所（受信箱・アーカイブ等）に属するかを判定する
function getBoxKey(e: any): FindBarBoxKey {
  const isTrash = e.labelIds?.includes("TRASH");
  const isSpam = e.labelIds?.includes("SPAM");
  const isInbox = e.labelIds?.includes("INBOX");
  const isSent = e.labelIds?.includes("SENT") || e.isMe;
  const isArchive = !isTrash && !isSpam && !isInbox && !isSent;
  return isSent ? "sent" : isTrash ? "trash" : isSpam ? "spam" : isInbox ? "inbox" : "archive";
}
export { getBoxKey as getFindBarBoxKey };

// FindBarBoxKey（小文字）⇔ Gmailラベル（大文字）の対応。フィルターツールのアクション（非表示/
// ピン留め/移動/削除）は実際のメール操作（ラベル書き換え等）がGmailラベル大文字キーを使うため必要
export const BOX_KEY_TO_LABEL: Record<FindBarBoxKey, string> = {
  inbox: "INBOX", archive: "ARCHIVE", sent: "SENT", spam: "SPAM", trash: "TRASH",
};

export type FilterAction = "hide" | "pin" | "move" | "delete";

// フィルターツールの非グループアクションにおける場所ごとの対象外ルール。
// 既存の選択モード（CategorizedActionSelect）の isBoxRestricted と同じルールを、
// FindBarBoxKey（小文字）ベースで使えるようにしたもの
export function isActionBoxRestricted(action: FilterAction, box: FindBarBoxKey): boolean {
  if (action === "pin" || action === "hide") return box === "trash" || box === "spam";
  if (action === "delete") return box === "trash" || box === "sent";
  if (action === "move") return box === "sent";
  return false;
}

export type TextField = "recipientName" | "recipientAddress" | "subject" | "body";
export type TextRule = { field: TextField; mode: "contains" | "not_contains"; keyword: string };
export type DateDirection = "received" | "sent";

export type FilterCriteria = {
  textRules?: TextRule[];
  dateRange?: { from?: string; to?: string; direction: DateDirection };
  boxes?: FindBarBoxKey[];
  hasAttachment?: boolean;
  isReply?: boolean;
  isForward?: boolean;
  format?: "html" | "text";
};

// メッセージの「相手」（自分が送信したなら宛先、受信したなら差出人）の生ヘッダー文字列を返す
function getPartnerRaw(email: any, myEmail: string): string {
  return isMineEmail(email, myEmail) ? (email.to || "") : (email.from || "");
}

function extractName(raw: string): string {
  return raw.split("<")[0].replace(/"/g, "").trim() || raw.trim();
}

function extractAddress(raw: string): string {
  const match = raw.match(/<([^>]+)>/);
  return ((match ? match[1] : raw) || "").trim();
}

function matchesTextRule(email: any, rule: TextRule, myEmail: string): boolean {
  let target = "";
  if (rule.field === "recipientName") target = extractName(getPartnerRaw(email, myEmail));
  else if (rule.field === "recipientAddress") target = extractAddress(getPartnerRaw(email, myEmail));
  else if (rule.field === "subject") target = email.subject || "";
  else target = email.body || "";

  const contains = target.toLowerCase().includes(rule.keyword.toLowerCase());
  return rule.mode === "contains" ? contains : !contains;
}

export function messageMatchesFilter(email: any, criteria: FilterCriteria, myEmail: string): boolean {
  if (criteria.textRules && criteria.textRules.length > 0) {
    if (!criteria.textRules.every(rule => matchesTextRule(email, rule, myEmail))) return false;
  }

  if (criteria.dateRange) {
    const { from, to, direction } = criteria.dateRange;
    const isSent = isMineEmail(email, myEmail);
    if (direction === "received" && isSent) return false;
    if (direction === "sent" && !isSent) return false;
    const emailDate = new Date(email.date);
    if (from && emailDate < new Date(from)) return false;
    if (to) {
      const toDate = new Date(to);
      toDate.setHours(23, 59, 59, 999);
      if (emailDate > toDate) return false;
    }
  }

  if (criteria.boxes && criteria.boxes.length > 0) {
    if (!criteria.boxes.includes(getBoxKey(email))) return false;
  }

  if (criteria.hasAttachment !== undefined) {
    const has = !!(email.attachments && email.attachments.length > 0);
    if (has !== criteria.hasAttachment) return false;
  }

  if (criteria.isReply !== undefined) {
    const isReply = !!(email.replyToId || email.inReplyTo);
    if (isReply !== criteria.isReply) return false;
  }

  if (criteria.isForward !== undefined) {
    if (!!email.isForward !== criteria.isForward) return false;
  }

  if (criteria.format !== undefined) {
    const isHtml = !!email.hasHtml;
    if (criteria.format === "html" && !isHtml) return false;
    if (criteria.format === "text" && isHtml) return false;
  }

  return true;
}

// FilterCriteria が実質的に何も条件を持っていないか（誤って全件マッチするのを防ぐガード用）
export function isEmptyFilterCriteria(criteria: FilterCriteria): boolean {
  return (
    !(criteria.textRules && criteria.textRules.length > 0) &&
    !criteria.dateRange &&
    !(criteria.boxes && criteria.boxes.length > 0) &&
    criteria.hasAttachment === undefined &&
    criteria.isReply === undefined &&
    criteria.isForward === undefined &&
    criteria.format === undefined
  );
}
