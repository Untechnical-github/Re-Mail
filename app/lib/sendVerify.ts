// 送信の結果が分からないとき（5xx・タイムアウト・通信断）に、二重送信せずに
// 「本当に送れたか」を送信済みフォルダと照合するための純粋関数
import { splitAddressList, parseAddress } from "./mime";

// Gmail の送信 API の応答をどう扱うか。
// - retry: 429 は Gmail が受け付けを断った（送られていない）ので、待ってから再試行してよい
// - failed: 429 以外の 4xx も送られていないので、失敗として返す
// - unknown: 5xx は Gmail 側で送れている可能性があるので、再試行せず送信済みと照合する
export type SendOutcome = "ok" | "unauthorized" | "retry" | "failed" | "unknown";

export function classifySendStatus(status: number): SendOutcome {
  if (status >= 200 && status < 300) return "ok";
  if (status === 401) return "unauthorized";
  if (status === 429) return "retry";
  if (status >= 500) return "unknown";
  return "failed";
}

// 送信するメールに付ける Message-ID。照合に使うため送信前にこちらで決める。
// 形は純正 Gmail（<CA…@mail.gmail.com>）に揃え、Re:Mail から送ったことが分からないようにする
export function makeMessageId(randomBytes: Uint8Array): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let id = "CA";
  for (const b of randomBytes) id += chars[b % chars.length];
  return `<${id}@mail.gmail.com>`;
}

// クライアントから受け取った Message-ID を、そのままヘッダーに入れてよい形かどうか
export function isValidMessageId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 200 && /^<[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+>$/.test(value);
}

export function addressSet(list: string): Set<string> {
  return new Set(splitAddressList(list || "").map(e => parseAddress(e).address.toLowerCase()).filter(Boolean));
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

// 件名は折り返しや encoded-word の区切りで空白が変わりうるので、空白を除いて比べる
function normalizeSubject(s: string): string {
  return (s || "").replace(/\s+/g, "");
}

export type SentCandidate = {
  messageIdHeader: string;
  snippet: string; // Gmail が作る本文の冒頭（HTML の文字参照つき）
  subject: string; // 解読済み
  to: string; // 解読済み
  cc: string; // 解読済み
  internalDateMs: number;
};

export type SentExpectation = {
  messageId: string;
  subject: string;
  to: string;
  cc?: string;
  body?: string; // 送ろうとした本文（テキスト）
  sentAfterMs: number;
};

// 本文の冒頭を比べるための正規化。Gmail の snippet は文字参照（&#39; など）が入り、空白も詰められるので、
// 文字参照を戻したうえで空白をすべて除く
function normalizeForSnippet(s: string): string {
  return (s || "")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/\s+/g, "");
}

// 送信済みの1通が、今回送ろうとしたメールかどうか。
// Message-ID が一致すれば確実。Gmail が Message-ID を付け替えた場合に備えて、
// 宛先（To・Cc）・件名・時刻（送信を始めた1分前以降）・本文の冒頭がすべて一致する場合も同じメールとみなす。
// 同じ相手に同じ件名で続けて返信することはよくあるため、本文の冒頭まで見て取り違えを防ぐ
export function matchSentMessage(c: SentCandidate, e: SentExpectation): "messageId" | "fields" | null {
  if (c.messageIdHeader && c.messageIdHeader.trim() === e.messageId) return "messageId";
  if (c.internalDateMs < e.sentAfterMs - 60_000) return null;
  if (normalizeSubject(c.subject) !== normalizeSubject(e.subject)) return null;
  if (!sameSet(addressSet(c.to), addressSet(e.to))) return null;
  if (!sameSet(addressSet(c.cc), addressSet(e.cc || ""))) return null;
  const body = normalizeForSnippet(e.body || "");
  if (body) {
    const snippet = normalizeForSnippet(c.snippet);
    const n = Math.min(40, body.length, snippet.length);
    if (n === 0 || body.slice(0, n) !== snippet.slice(0, n)) return null;
  }
  return "fields";
}
