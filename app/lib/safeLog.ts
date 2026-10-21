// 個人情報を出さないログ。console.* を直接使わず、必ずここを通す（eslint の no-console で強制している）。
// 本番で出すのは「処理名・HTTP ステータス・Gmail のエラー理由コード・メッセージ／スレッド ID・件数・所要時間」だけ。
// メールアドレス・名前・件名・本文・トークン・生の応答は、形を確かめて通らないものはすべて捨てる。
// 開発環境（npm run dev）でだけ、原因を追いやすいようエラーの中身もそのまま出す。

export type LogFields = {
  status?: number;
  reason?: string; // Gmail / OAuth のエラー理由コード（例: rateLimitExceeded, invalid_grant）
  messageId?: string; // Gmail のメッセージ ID（意味を持たない16進の文字列）
  threadId?: string;
  count?: number;
  durationMs?: number;
};

export type SafeLogRecord = { level: "error" | "warn" | "info"; op: string } & LogFields & { errorName?: string };

const OP_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const GMAIL_ID_RE = /^[0-9a-f]{6,32}$/i;
const REASON_RE = /^[A-Za-z_]{1,64}$/;
const ERROR_NAME_RE = /^[A-Za-z]{1,40}$/;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

// エラーの中から、出してよいもの（エラーの種類名と理由コード）だけを取り出す。
// message は URL の検索語やアドレスを含みうるので出さない
function pickFromError(detail: unknown): { errorName?: string; reason?: string } {
  if (!detail || typeof detail !== "object") return {};
  const out: { errorName?: string; reason?: string } = {};
  const name = (detail as { name?: unknown }).name;
  if (typeof name === "string" && ERROR_NAME_RE.test(name)) out.errorName = name;
  // OAuth のエラー応答（{ error: "invalid_grant" }）と Gmail のエラー応答（{ error: { errors: [{ reason }] } }）
  const err = (detail as { error?: unknown }).error;
  if (typeof err === "string" && REASON_RE.test(err)) out.reason = err;
  const gmailReason = (err as { errors?: { reason?: unknown }[] } | undefined)?.errors?.[0]?.reason;
  if (typeof gmailReason === "string" && REASON_RE.test(gmailReason)) out.reason = gmailReason;
  return out;
}

// 出力する1行分を組み立てる（テストできるよう、出力とは分けておく）
export function buildLogRecord(level: SafeLogRecord["level"], op: string, fields: LogFields = {}, detail?: unknown): SafeLogRecord {
  const record: SafeLogRecord = { level, op: OP_RE.test(op) ? op : "invalid-op" };
  if (isNum(fields.status)) record.status = fields.status;
  if (isNum(fields.count)) record.count = fields.count;
  if (isNum(fields.durationMs)) record.durationMs = Math.round(fields.durationMs);
  if (typeof fields.messageId === "string" && GMAIL_ID_RE.test(fields.messageId)) record.messageId = fields.messageId;
  if (typeof fields.threadId === "string" && GMAIL_ID_RE.test(fields.threadId)) record.threadId = fields.threadId;
  const picked = pickFromError(detail);
  const reason = typeof fields.reason === "string" && REASON_RE.test(fields.reason) ? fields.reason : picked.reason;
  if (reason) record.reason = reason;
  if (picked.errorName) record.errorName = picked.errorName;
  return record;
}

const isDev = process.env.NODE_ENV === "development";

function write(level: SafeLogRecord["level"], op: string, fields?: LogFields, detail?: unknown) {
  const line = JSON.stringify(buildLogRecord(level, op, fields, detail));
  const out = level === "error" ? console.error : level === "warn" ? console.warn : console.info;
  if (isDev && detail !== undefined) out(line, detail);
  else out(line);
}

export const logError = (op: string, fields?: LogFields, detail?: unknown) => write("error", op, fields, detail);
export const logWarn = (op: string, fields?: LogFields, detail?: unknown) => write("warn", op, fields, detail);
export const logInfo = (op: string, fields?: LogFields) => write("info", op, fields);
