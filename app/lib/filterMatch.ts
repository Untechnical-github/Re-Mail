// フィルターツール（作成/非表示/ピン留め/移動/削除）と検索バーで共有する、
// メールが自分の送信したものかどうかの判定・保存場所判定・条件マッチングロジック。

// From ヘッダーから実アドレス部分だけを厳密に取り出す（"表示名 <addr>" 形式ならaddr、
// なければヘッダー全体をそのままアドレスとみなす）。大文字小文字を無視して比較できるよう
// 小文字化・trimまで行う
function extractFromAddress(raw: string): string {
  const match = (raw || "").match(/<([^>]+)>/);
  return ((match ? match[1] : raw) || "").trim().toLowerCase();
}

// メールが自分の送信したものかどうかの判定。バックエンドが返す「生の」メールデータには
// isMe フィールドが元々存在せず、送信直後にローカルで作った表示用オブジェクトにだけ isMe:true を
// 付けている。そのオブジェクトが後から（60秒毎の自動更新や再取得で）生データに上書きされると
// isMe が失われるため、From が自分のアドレスと完全一致するかのフォールバックを必ず併用する。
// myEmailは単一アドレスでも、複数アドレス（メイン＋連携）の配列でも渡せる。
// 注意: 部分一致（.includes）で判定すると、例えば自分が a@gmail.com のとき
// ba@gmail.com からのメールを「自分の送信」と誤判定してしまうため、必ず完全一致で比較する
export function isMineEmail(e: any, myEmail: string | string[]): boolean {
  if (e.isMe) return true;
  const candidates = (Array.isArray(myEmail) ? myEmail : [myEmail]).filter(Boolean).map(a => a.trim().toLowerCase());
  if (candidates.length === 0) return false;
  const fromAddr = extractFromAddress(e.from || "");
  if (!fromAddr) return false;
  return candidates.includes(fromAddr);
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
export type DateDirection = "received" | "sent";
export type TextRule = {
  field: TextField;
  mode: "contains" | "not_contains";
  keyword: string;
};

// AND結合された1つの条件セット（方向・テキスト条件・期間・添付・返信・転送・形式）。
// FilterCriteria.conditionSets はこれの配列で、いずれか1つのセットに一致すればOK（OR結合）
export type ConditionSet = {
  // このセット全体を受信メールのみ/送信メールのみに絞り込む（未指定=問わない）。
  // テキスト条件のうち相手の名前/アドレスは、この値に応じてどちらのヘッダーを見るか決まる
  // （受信なら差出人、送信なら宛先。未指定＝問わないのときは相手＝自分でない方を見る）
  direction?: DateDirection;
  textRules?: TextRule[];
  dateRange?: { from?: string; to?: string };
  hasAttachment?: boolean;
  isReply?: boolean;
  isForward?: boolean;
  format?: "html" | "text";
};

export type FilterCriteria = {
  // OR結合される条件セットの配列。空/未指定は「内容条件なし＝保存場所条件だけで絞り込む」を意味する
  conditionSets?: ConditionSet[];
  boxes?: FindBarBoxKey[];
  // 対象アカウント（連携アカウントのメールアドレス）。未指定/空文字列＝アカウントを問わない。
  // グループ化のフィルターは受信専用のため、複数アカウントのメールをまたいで集約できる
  accountEmail?: string;
  // 後方互換用: conditionSets 導入前の旧バージョンで保存されたフラットな単一条件データ。
  // conditionSets が無いときだけ getConditionSets() 経由で読み込まれる
  textRules?: TextRule[];
  dateRange?: { from?: string; to?: string };
  hasAttachment?: boolean;
  isReply?: boolean;
  isForward?: boolean;
  format?: "html" | "text";
};

function isConditionSetEmpty(set: ConditionSet): boolean {
  return (
    !(set.textRules && set.textRules.length > 0) &&
    !set.dateRange &&
    set.hasAttachment === undefined &&
    set.isReply === undefined &&
    set.isForward === undefined &&
    set.format === undefined
  );
}

// FilterCriteria から、実際にOR評価すべき条件セットの配列を取り出す（新旧データ形式を吸収する）
export function getConditionSets(criteria: FilterCriteria): ConditionSet[] {
  if (criteria.conditionSets) return criteria.conditionSets;
  const legacy: ConditionSet = {
    textRules: criteria.textRules, dateRange: criteria.dateRange,
    hasAttachment: criteria.hasAttachment, isReply: criteria.isReply, isForward: criteria.isForward, format: criteria.format,
  };
  return isConditionSetEmpty(legacy) ? [] : [legacy];
}

// メッセージの「相手」（自分が送信したなら宛先、受信したなら差出人）の生ヘッダー文字列を返す。
// TextRule.direction が未指定の古いデータ向けの後方互換フォールバックにのみ使う
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

// <input type="date"> の "YYYY-MM-DD" 文字列を、閲覧者のローカルタイムゾーンでのその日の
// 開始/終了時刻として解釈する。new Date("YYYY-MM-DD") は日付のみの文字列をUTC 0時として
// パースする仕様のため、そのまま使うと日本時間などUTCより進んでいるタイムゾーンでは、
// 同じ「7月24日」のメールでも午前中に送受信されたものだけ前日UTC扱いになって
// 期間フィルターから漏れてしまう（同じ日の一部のメールだけ対象外になるバグの原因だった）
function parseLocalDayStart(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1, 0, 0, 0, 0);
}
function parseLocalDayEnd(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1, 23, 59, 59, 999);
}

function matchesTextRule(email: any, rule: TextRule, myEmail: string, direction: DateDirection | undefined): boolean {
  let target = "";
  if (rule.field === "recipientName" || rule.field === "recipientAddress") {
    const raw = direction ? (direction === "sent" ? (email.to || "") : (email.from || "")) : getPartnerRaw(email, myEmail);
    target = rule.field === "recipientName" ? extractName(raw) : extractAddress(raw);
  } else if (rule.field === "subject") target = email.subject || "";
  else target = email.body || "";

  const contains = target.toLowerCase().includes(rule.keyword.toLowerCase());
  return rule.mode === "contains" ? contains : !contains;
}

function matchesConditionSet(email: any, set: ConditionSet, myEmail: string): boolean {
  if (set.direction) {
    const isSent = isMineEmail(email, myEmail);
    if (set.direction === "received" && isSent) return false;
    if (set.direction === "sent" && !isSent) return false;
  }

  if (set.textRules && set.textRules.length > 0) {
    if (!set.textRules.every(rule => matchesTextRule(email, rule, myEmail, set.direction))) return false;
  }

  if (set.dateRange) {
    const { from, to } = set.dateRange;
    const emailDate = new Date(email.date);
    if (isNaN(emailDate.getTime())) return false; // 日時が壊れている/未解析のメールは期間条件付きでは対象外にする
    if (from && emailDate < parseLocalDayStart(from)) return false;
    if (to && emailDate > parseLocalDayEnd(to)) return false;
  }

  if (set.hasAttachment !== undefined) {
    const has = !!(email.attachments && email.attachments.length > 0);
    if (has !== set.hasAttachment) return false;
  }

  if (set.isReply !== undefined) {
    const isReply = !!(email.replyToId || email.inReplyTo);
    if (isReply !== set.isReply) return false;
  }

  if (set.isForward !== undefined) {
    if (!!email.isForward !== set.isForward) return false;
  }

  if (set.format !== undefined) {
    const isHtml = !!email.hasHtml;
    if (set.format === "html" && !isHtml) return false;
    if (set.format === "text" && isHtml) return false;
  }

  return true;
}

export function messageMatchesFilter(email: any, criteria: FilterCriteria, myEmail: string): boolean {
  // email.accountId が無い（accountId導入前のデータ・ローカルfake等）場合は myEmail 名義として扱う。
  // このメール自身が実際に属するアカウントを、以降の受信/送信（isMineEmail）判定にも使う。
  // myEmailを呼び出し元がメインアカウント固定で渡していても、連携アカウントのメールに対して
  // 正しく「自分＝そのメールの所属アカウント」で送受信判定できるようにするため
  const emailAccount = email.accountId || myEmail;
  if (criteria.accountEmail && emailAccount !== criteria.accountEmail) return false;

  if (criteria.boxes && criteria.boxes.length > 0) {
    if (!criteria.boxes.includes(getBoxKey(email))) return false;
  }

  const sets = getConditionSets(criteria);
  if (sets.length > 0) {
    if (!sets.some(set => matchesConditionSet(email, set, emailAccount))) return false;
  }

  return true;
}

// チャット一覧のタブ種別。フィルターツールで作成したグループ（isGroup && filterCriteria）は
// アドレスベースの通常グループとは別の「フィルター」タブに分類する
export type ChatListTab = "individual" | "group" | "filter";
export function chatConfigTab(cfg: any): ChatListTab {
  if (!cfg?.isGroup) return "individual";
  return cfg.filterCriteria ? "filter" : "group";
}

// FilterCriteria が実質的に何も条件を持っていないか（誤って全件マッチするのを防ぐガード用）
export function isEmptyFilterCriteria(criteria: FilterCriteria): boolean {
  return getConditionSets(criteria).length === 0 && !(criteria.boxes && criteria.boxes.length > 0) && !criteria.accountEmail;
}
