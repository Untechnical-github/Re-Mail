import { NextResponse } from "next/server";
import type { Session } from "next-auth";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { auth } from "../../../auth";
import { getValidAccessToken } from "../../lib/googleToken";
import { encryptSecret, decryptSecret, EncryptionKeyMissingError } from "../../lib/tokenCrypto";
import { findLinkedAccount } from "../../lib/linkedAccountsStore";
import { buildMimeSegments, buildGmailUploadBody, buildDraftUploadBody, decodeMimeHeader, type MimeSegment } from "../../lib/mime";
import { type GmailHeader, type GmailMessage, getHeader, getHtmlBody, getTextBody, extractAttachments, extractContentIdParts, referencesContentId, stripHtmlQuote, looksLikeForward, parseMessageDetail, parseInternalDate, topReceivedTime } from "../../lib/messageParse";
import type { MimeInlinePart } from "../../lib/mime";
import { summarizeHistory, draftHistory, type GmailHistoryRecord } from "../../lib/historySync";
import { classifySendStatus, isRateLimitReason, gmailErrorReason, makeMessageId, isValidMessageId, matchSentMessage, addressSet, type SendOutcome, type SentExpectation } from "../../lib/sendVerify";
import { logError, logWarn, logInfo } from "../../lib/safeLog";
import { labelChangeFor, readLabelChange, sanitizeMessageIds, chunkIds } from "../../lib/mailboxOps";
import { validateSendHeaders } from "../../lib/composeRecipients";
import { validateInlineImages } from "../../lib/inlineImages";


// Gmail API の生データ（必要なフィールドだけ）

// Gmail APIが429（レート制限）や一時的な5xxを返した場合に、指数バックオフ＋ジッターで
// 数回だけ再試行する。特に多アカウント連携時・大きなメールボックスでの一括取得（メッセージ
// 一覧・メッセージ詳細の並列取得）でクォータに触れやすいため、ここで吸収して黙って失敗しないようにする
async function fetchWithRetry(url: string, init: RequestInit, maxRetries = 3): Promise<Response> {
  let lastRes: Response | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, init);
    // Gmail はレート制限を 403（rateLimitExceeded など）でも返すので、それも待ってから取り直す
    const rateLimited403 = res.status === 403 && await isRateLimited403(res);
    if (res.status !== 429 && res.status < 500 && !rateLimited403) return res;
    lastRes = res;
    if (attempt === maxRetries) return res;
    // 実機テストでは、画面を開いたときの一括取得（詳細 約100件）で利用上限に触れ、15秒ほどで戻った。
    // レート制限のときはそれをまたげるよう 2秒 → 4秒 → 8秒 と待つ（Retry-After があればそれに従う、最大10秒）。
    // Workers は待っている間 CPU 時間を使わないので、費用はほぼ増えない
    const retryAfterSec = Number(res.headers.get("Retry-After"));
    const backoffMs = res.status >= 500
      ? 300 * Math.pow(2, attempt) + Math.random() * 200
      : Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? Math.min(retryAfterSec * 1000, 10_000) : 2000 * Math.pow(2, attempt) + Math.random() * 500;
    await new Promise(r => setTimeout(r, backoffMs));
  }
  return lastRes!;
}

// 403 がレート制限によるものか。本文は呼び出し側でも読むので、複製を読む
async function isRateLimited403(res: Response): Promise<boolean> {
  try {
    return isRateLimitReason(gmailErrorReason(await res.clone().json()));
  } catch {
    return false;
  }
}

const GMAIL_SEND_URL ="https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart";
// 35MB のアップロードでも十分に終わる長さ。これを超えたら「結果不明」として送信済みと照合する
const SEND_TIMEOUT_MS = 90_000;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
// メールの詳細表示で、本文中に出す画像の上限（1通あたり。超えた分は表示せず、Gmail で開く案内を出す）
const INLINE_IMAGE_LIMIT = 30;

// 送信は fetchWithRetry を通さない（5xx やタイムアウトでも Gmail 側では送れていることがあり、
// 再試行すると二重送信になる）。再試行するのは、Gmail が受け付けを断った（＝送られていない）429 とレート制限の 403 だけ
async function postSendOnce(upload: { body: Uint8Array<ArrayBuffer>; contentType: string }, accessToken: string, url: string = GMAIL_SEND_URL): Promise<{ outcome: SendOutcome; res?: Response }> {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": upload.contentType },
        body: upload.body,
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch (e) {
      // タイムアウト・通信断。Gmail に届いたかどうか分からない
      logWarn("send.noResponse", {}, e);
      return { outcome: "unknown" };
    }
    const reason = res.status === 403 ? gmailErrorReason(await res.clone().json().catch(() => null)) : undefined;
    const outcome = classifySendStatus(res.status, reason);
    if (outcome !== "retry") return { outcome, res };
    logWarn("send.rateLimited", { status: res.status, count: attempt });
    if (attempt === maxAttempts) return { outcome: "failed", res };
    const retryAfterSec = Number(res.headers.get("Retry-After"));
    const waitMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? Math.min(retryAfterSec * 1000, 10_000) : 500 * 2 ** attempt + Math.random() * 300;
    await sleep(waitMs);
  }
  return { outcome: "failed" };
}

type ForwardAttachmentsResult =
  | { ok: true; attachments: { filename: string; mimeType: string; data: string }[]; inline: MimeInlinePart[] }
  // 失敗した段階・HTTP ステータス・Gmail の理由コードだけを持つ（個人情報は入れない）。原因を追えるよう画面側にも返す
  | { ok: false; stage: "list" | "tooLarge" | "get" | "empty" | "exception"; status?: number; reason?: string };

// 転送する元のメールの添付を Gmail から取り直す。合計が 25MB を超える、または1つでも取れない場合は失敗。
// 本文の HTML が cid: で参照している画像（本文中の画像）は、添付ではなくインライン画像として返す（純正 Gmail と同じ）
async function loadForwardAttachments(accessToken: string, messageId: string, bodyHtml: string): Promise<ForwardAttachmentsResult> {
  const auth = { headers: { Authorization: `Bearer ${accessToken}` } };
  const base = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}`;
  const fail = async (stage: "list" | "get", res: Response): Promise<ForwardAttachmentsResult> => {
    const reason = gmailErrorReason(await res.json().catch(() => null));
    logWarn(`forward.attachments.${stage}`, { status: res.status, reason, messageId });
    return { ok: false, stage, status: res.status, reason };
  };
  try {
    const msgRes = await fetchWithRetry(`${base}?fields=payload`, auth);
    if (!msgRes.ok) return fail("list", msgRes);
    const payload = ((await msgRes.json()) as GmailMessage).payload;
    const inlineList = extractContentIdParts(payload).filter(p => referencesContentId(bodyHtml, p.contentId));
    const inlineIds = new Set(inlineList.map(p => p.attachmentId));
    // 本文から参照される画像は、添付の一覧からは外す（同じ画像が添付とインラインに二重に付かないように）
    // 本文から参照されていないインラインの画像も、画面と同じく添付として引き継ぐ（黙って落とさない）
    const list = extractAttachments(payload, bodyHtml).filter(a => !inlineIds.has(a.attachmentId));
    const total = [...list, ...inlineList].reduce((sum, a) => sum + (a.size || 0), 0);
    if (total > 25 * 1024 * 1024) { logWarn("forward.attachments.tooLarge", { messageId, count: list.length }); return { ok: false, stage: "tooLarge" }; }
    const download = async (attachmentId: string): Promise<string | ForwardAttachmentsResult> => {
      const res = await fetchWithRetry(`${base}/attachments/${encodeURIComponent(attachmentId)}`, auth);
      if (!res.ok) return fail("get", res);
      const data = ((await res.json()) as { data?: string }).data;
      if (!data) { logWarn("forward.attachments.empty", { messageId }); return { ok: false, stage: "empty" }; }
      // Gmail は base64url で返すので、MIME 用の通常の base64 に直す
      const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
      return b64 + "===".slice((b64.length + 3) % 4);
    };
    const out: { filename: string; mimeType: string; data: string }[] = [];
    // 大きな添付を一度に何本も抱えないよう、1つずつ取る
    for (const att of list) {
      const data = await download(att.attachmentId);
      if (typeof data !== "string") return data;
      out.push({ filename: att.filename, mimeType: att.mimeType, data });
    }
    const inline: MimeInlinePart[] = [];
    for (const part of inlineList) {
      const data = await download(part.attachmentId);
      if (typeof data !== "string") return data;
      inline.push({ filename: part.filename, mimeType: part.mimeType, data, contentId: part.contentId });
    }
    return { ok: true, attachments: out, inline };
  } catch (e) {
    logError("forward.attachments", { messageId }, e);
    return { ok: false, stage: "exception" };
  }
}

type GmailListResponse = { messages?: { id: string; threadId: string }[] };
type GmailMetadataMessage = { id: string; threadId: string; internalDate?: string; snippet?: string; payload?: { headers?: GmailHeader[] } };

// 結果が分からなかった送信が、実際には送れていたかを送信済みフォルダで確かめる。
// まず Message-ID で探し、Gmail が Message-ID を付け替えていた場合に備えて、
// 直近の送信済みを宛先・件名・時刻で照合する。Gmail の検索に反映されるまで少しかかるので2回見る
async function findSentMessage(accessToken: string, exp: SentExpectation): Promise<{ id: string; threadId: string } | null> {
  const auth = { headers: { Authorization: `Bearer ${accessToken}` } };
  const base = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
  for (const delay of [1500, 4000]) {
    await sleep(delay);
    try {
      const byIdRes = await fetchWithRetry(`${base}?maxResults=1&fields=messages(id,threadId)&q=${encodeURIComponent(`rfc822msgid:${exp.messageId.slice(1, -1)}`)}`, auth);
      // 見つからないとき、Gmail は fields で絞った一覧を JSON でない空の本文で返すことがある（2026-10-25 に実機で確認）。
      // そのまま json() すると例外になり、下の宛先・件名での照合まで進まなかったので、読めなければ「無し」とする
      if (byIdRes.ok) {
        const hit = ((await byIdRes.json().catch(() => ({}))) as GmailListResponse).messages?.[0];
        if (hit) return hit;
      }
      const afterSec = Math.floor((exp.sentAfterMs - 60_000) / 1000);
      const recentRes = await fetchWithRetry(`${base}?maxResults=10&fields=messages(id)&q=${encodeURIComponent(`in:sent after:${afterSec}`)}`, auth);
      if (!recentRes.ok) continue;
      const recent = ((await recentRes.json().catch(() => ({}))) as GmailListResponse).messages || [];
      for (const m of recent) {
        const metaRes = await fetchWithRetry(
          `${base}/${encodeURIComponent(m.id)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=Subject&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Bcc&fields=id,threadId,internalDate,snippet,payload/headers`,
          auth
        );
        if (!metaRes.ok) continue;
        const meta = (await metaRes.json()) as GmailMetadataMessage;
        const h = meta.payload?.headers || [];
        const matched = matchSentMessage({
          messageIdHeader: getHeader(h, "Message-ID"),
          snippet: meta.snippet || "",
          subject: decodeMimeHeader(getHeader(h, "Subject")),
          to: decodeMimeHeader(getHeader(h, "To")),
          cc: decodeMimeHeader(getHeader(h, "Cc")),
          // 送信済みのメールには Bcc が残る（Bcc だけで送ったメールも照合できるように）
          bcc: decodeMimeHeader(getHeader(h, "Bcc")),
          internalDateMs: Number(meta.internalDate || 0),
        }, exp);
        if (matched) return { id: meta.id, threadId: meta.threadId };
      }
    } catch {
      // 照合中の通信エラーは「見つからなかった」と同じ扱いにし、次の回か利用者の確認に回す
    }
  }
  return null;
}

const GMAIL_DRAFTS_URL = "https://gmail.googleapis.com/gmail/v1/users/me/drafts";
const GMAIL_DRAFTS_UPLOAD_URL = "https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts";
// Re:Mail で扱う Gmail の下書きの数（超えた分は「Gmail で開く」）
const DRAFT_LIST_MAX = 100;
type GmailDraftResponse = { id?: string; message?: { id?: string; threadId?: string } };

// Gmail の下書き ID（r1234… / r-1234…）とメッセージ ID（16進）の形
function isValidDraftId(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v);
}
function isValidGmailId(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{6,32}$/i.test(v);
}

type DraftState =
  | { state: "ok"; messageId: string; threadId?: string }
  | { state: "gone" }
  | { state: "unauthorized" }
  | { state: "error"; status: number; reason?: string };

// 下書きが今どうなっているか（drafts.get の minimal。中身は読まない）。404 は「ほかで送信・削除された」
async function getDraftState(accessToken: string, draftId: string): Promise<DraftState> {
  try {
    const res = await fetchWithRetry(`${GMAIL_DRAFTS_URL}/${encodeURIComponent(draftId)}?format=minimal&fields=id,message(id,threadId,labelIds)`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (res.status === 404) return { state: "gone" };
    if (res.status === 401) return { state: "unauthorized" };
    if (!res.ok) {
      const reason = gmailErrorReason(await res.json().catch(() => null));
      logWarn("draft.get.failed", { status: res.status, reason });
      return { state: "error", status: res.status >= 400 ? res.status : 502, reason };
    }
    const d = (await res.json()) as GmailDraftResponse & { message?: { labelIds?: string[] } };
    // 純正から送られた下書きは、しばらく同じ ID で送ったメール（DRAFT ラベルなし）が返る（2026-10-25 に実機で確認）。
    // DRAFT ラベルが無ければ、もう下書きではない（ほかで送信された）として扱う
    if (!d.message?.id || !(d.message.labelIds || []).includes("DRAFT")) return { state: "gone" };
    return { state: "ok", messageId: d.message.id, threadId: d.message.threadId };
  } catch (e) {
    logWarn("draft.get.noResponse", {}, e);
    return { state: "error", status: 502 };
  }
}

// 新しく作ろうとして結果を受け取れなかったとき（タブを閉じたときの保存など）に、同じ中身の下書きがもうできていないかを探す
// （二重に作らないため）。Gmail は下書きの Message-ID を保存のときに付け替えるので、Message-ID では探せない。
// 新しい順に10件まで、宛先・件名・HTML が同じものを探す。一覧を読めなかった（開いた直後のレート制限など）ときは
// 「見つからない」と区別して返す（読めないまま作ると二重にできていた：2026-10-25 に実機で確認）
const SAME_DRAFT_SCAN = 10;
async function findSameDraft(accessToken: string, exp: SentExpectation, html: string): Promise<{ id: string | null } | { error: number; reason?: string }> {
  try {
    // fields=drafts(id) で絞ると応答を読めず0件になっていた（2026-10-25 に実機で確認）ので、絞らずに取る
    const res = await fetchWithRetry(`${GMAIL_DRAFTS_URL}?maxResults=${SAME_DRAFT_SCAN}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) return { error: res.status, reason: gmailErrorReason(await res.json().catch(() => null)) };
    const ids = (((await res.json().catch(() => ({}))) as { drafts?: { id?: string }[] }).drafts || []).map(d => d.id).filter(isValidDraftId);
    for (const id of ids) if (await draftEquals(accessToken, id, exp, html)) return { id };
    logInfo("draft.findSame", { count: ids.length });
    return { id: null };
  } catch {
    return { error: 502 };
  }
}


// 下書きの宛先・件名・HTML が、これから保存するものと同じか（中身は比べるだけで、ログにも返り値にも出さない）
async function draftEquals(accessToken: string, draftId: string, exp: SentExpectation, html: string): Promise<boolean> {
  if (!html) return false;
  try {
    const res = await fetchWithRetry(`${GMAIL_DRAFTS_URL}/${encodeURIComponent(draftId)}?format=full&fields=message(payload)`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) return false;
    const payload = ((await res.json()) as { message?: GmailMessage }).message?.payload;
    if (!payload) return false;
    const norm = (s: string) => s.replace(/\r\n/g, "\n").trim();
    const h = payload.headers || [];
    const sameAddr = (a: string, b: string | undefined) => [...addressSet(decodeMimeHeader(a))].sort().join(",") === [...addressSet(b || "")].sort().join(",");
    return norm(decodeMimeHeader(getHeader(h, "Subject"))) === norm(exp.subject)
      && sameAddr(getHeader(h, "To"), exp.to) && sameAddr(getHeader(h, "Cc"), exp.cc) && sameAddr(getHeader(h, "Bcc"), exp.bcc)
      && norm(getHtmlBody(payload)) === norm(html);
  } catch {
    return false;
  }
}

// 下書きを送って結果が分からなかったとき：下書きが残っていれば送られていない（draftExists）。無ければ送信済みと照合する
async function verifyDraftSend(accessToken: string, draftId: string, exp: SentExpectation): Promise<{ found: { id: string; threadId: string } | null; draftExists: boolean }> {
  await sleep(1500);
  const st = await getDraftState(accessToken, draftId);
  if (st.state === "ok") return { found: null, draftExists: true };
  const found = await findSentMessage(accessToken, exp);
  logInfo("draft.send.verified", { count: found ? 1 : 0 });
  return { found, draftExists: false };
}

// 画面から届いた「下書きから取り直す添付」の一覧（名前と大きさ）。壊れていれば null
function readDraftAttachmentList(v: unknown): { filename: string; size: number }[] | null {
  if (!Array.isArray(v) || v.length > 50) return null;
  const out: { filename: string; size: number }[] = [];
  for (const x of v) {
    const o = x as { filename?: unknown; size?: unknown } | null;
    if (!o || typeof o.filename !== "string" || o.filename.length > 255 || typeof o.size !== "number" || !Number.isFinite(o.size) || o.size < 0) return null;
    out.push({ filename: o.filename, size: o.size });
  }
  return out;
}

// 下書きの添付を、今の下書きのメールから取り直す（名前と大きさで合わせる。添付の ID は下書きを保存するたびに変わるため）
async function loadDraftAttachments(accessToken: string, draftId: string, want: { filename: string; size: number }[]): Promise<{ ok: true; attachments: { filename: string; mimeType: string; data: string }[] } | { ok: false; stage: "get" | "missing" | "download" | "tooLarge" | "exception"; status?: number }> {
  const auth = { headers: { Authorization: `Bearer ${accessToken}` } };
  try {
    const res = await fetchWithRetry(`${GMAIL_DRAFTS_URL}/${encodeURIComponent(draftId)}?format=full&fields=message(id,payload)`, auth);
    if (!res.ok) { logWarn("draft.attachments.get", { status: res.status }); return { ok: false, stage: "get", status: res.status }; }
    const m = ((await res.json()) as { message?: GmailMessage }).message;
    if (!m?.id) return { ok: false, stage: "get" };
    const html = getHtmlBody(m.payload);
    const pool = extractAttachments(m.payload, html);
    if (want.reduce((n, w) => n + w.size, 0) > 25 * 1024 * 1024) return { ok: false, stage: "tooLarge" };
    const out: { filename: string; mimeType: string; data: string }[] = [];
    // 大きな添付を一度に何本も抱えないよう、1つずつ取る
    for (const w of want) {
      const i = pool.findIndex(a => a.filename === w.filename && a.size === w.size);
      if (i < 0) { logWarn("draft.attachments.missing", { count: want.length }); return { ok: false, stage: "missing" }; }
      const [a] = pool.splice(i, 1);
      const r = await fetchWithRetry(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(m.id)}/attachments/${encodeURIComponent(a.attachmentId)}`, auth);
      if (!r.ok) { logWarn("draft.attachments.download", { status: r.status }); return { ok: false, stage: "download", status: r.status }; }
      const data = ((await r.json()) as { data?: string }).data;
      if (!data) return { ok: false, stage: "download" };
      // Gmail は base64url で返すので、MIME 用の通常の base64 に直す
      const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
      out.push({ filename: a.filename, mimeType: a.mimeType, data: b64 + "===".slice((b64.length + 3) % 4) });
    }
    return { ok: true, attachments: out };
  } catch (e) {
    logError("draft.attachments", {}, e);
    return { ok: false, stage: "exception" };
  }
}

type PreparedMime =
  | { ok: true; segments: MimeSegment[]; messageId: string; threadId?: string; exp: SentExpectation }
  | { ok: false; response: NextResponse };

// 送信・下書きの保存で同じ MIME を作る（宛先・本文中の画像・添付・大きさを確かめる。転送では元のメールの添付を取り直す）
async function prepareSendMime(bodyData: Record<string, unknown>, accessToken: string): Promise<PreparedMime> {
  const { subject, body, bodyHtml, threadId, inReplyTo, references, from, replyTo } = bodyData;
  // 宛先（To / Cc / Bcc）は画面の送信先から作られて届く。件数（合計500）・長さ・改行をここでも確かめ、
  // 1件も無い・壊れているときは送らない（宛先を勝手に直さない）
  const checked = validateSendHeaders({ to: bodyData.to, cc: bodyData.cc, bcc: bodyData.bcc });
  if (!checked.ok) {
    logWarn("send.invalidRecipients", { reason: checked.error });
    return { ok: false, response: NextResponse.json({ error: checked.error }, { status: 400 }) };
  }
  const { to, cc, bcc } = checked.headers;
  const attachments = (Array.isArray(bodyData.attachments) ? bodyData.attachments : []) as { filename: string; mimeType: string; data: string }[];
  const html = typeof bodyHtml === "string" ? bodyHtml : "";

  // 転送: 元のメールの添付も純正 Gmail と同じく一緒に送る。添付の ID は取り直すたびに変わることがあるため、
  // クライアントから受け取らず、ここで元のメールから読み直す。1つでも取れなければ送らない（黙って添付を落とさない）
  // 転送で、元のメールの本文中の画像（cid: で参照されるもの）
  const inline: MimeInlinePart[] = [];
  const forwardFrom = bodyData.forwardAttachmentsFrom;
  if (typeof forwardFrom === "string" && forwardFrom) {
    if (!/^[0-9a-f]{6,32}$/i.test(forwardFrom)) return { ok: false, response: NextResponse.json({ error: "FORWARD_ATTACHMENTS_FAILED" }, { status: 400 }) };
    const forwarded = await loadForwardAttachments(accessToken, forwardFrom, html);
    if (!forwarded.ok) {
      const { stage, status, reason } = forwarded;
      return { ok: false, response: NextResponse.json({ error: "FORWARD_ATTACHMENTS_FAILED", stage, status, reason }, { status: 502 }) };
    }
    attachments.push(...forwarded.attachments);
    inline.push(...forwarded.inline);
  }

  // Gmail から読み込んだ下書きの添付（中身は画面に持たない）。保存・送信のときに、今の下書きから取り直して付ける。
  // 1つでも取れなければ送らない・保存しない（黙って落とさない）。下書きが無い（messages.send）ときも取れない
  if (bodyData.draftAttachments !== undefined) {
    const want = readDraftAttachmentList(bodyData.draftAttachments);
    if (!want) return { ok: false, response: NextResponse.json({ error: "DRAFT_ATTACHMENTS_FAILED" }, { status: 400 }) };
    if (want.length > 0) {
      if (!isValidDraftId(bodyData.draftId)) return { ok: false, response: NextResponse.json({ error: "DRAFT_ATTACHMENTS_FAILED", stage: "noDraft" }, { status: 409 }) };
      const got = await loadDraftAttachments(accessToken, bodyData.draftId, want);
      if (!got.ok) return { ok: false, response: NextResponse.json({ error: "DRAFT_ATTACHMENTS_FAILED", stage: got.stage, status: got.status }, { status: 502 }) };
      attachments.push(...got.attachments);
    }
  }

  // 本文中の画像（書式付きの入力欄で入れたもの）。HTML から cid: で参照する。形・件数・大きさ・種類をここでも確かめる
  if (bodyData.inlineImages !== undefined) {
    const checkedInline = validateInlineImages(bodyData.inlineImages);
    if (!checkedInline.ok) {
      logWarn("send.invalidInlineImages", { count: Array.isArray(bodyData.inlineImages) ? bodyData.inlineImages.length : 0 });
      return { ok: false, response: NextResponse.json({ error: "INVALID_INLINE_IMAGES" }, { status: 400 }) };
    }
    inline.push(...checkedInline.images);
  }

  // 添付ファイルの合計サイズをサーバー側でも検証する（upload エンドポイントの上限はメール全体で
  // 35MB。添付は base64 で約1.37倍に膨らむため、純正 Gmail と同じ 25MB を上限にする）
  const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;
  if (attachments.length > 0 || inline.length > 0) {
    // 本文中の画像（インライン）も合計に入れる
    const totalBytes = [...attachments, ...inline].reduce((sum, a) => sum + Math.floor(((a.data || "").length * 3) / 4), 0);
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      return { ok: false, response: NextResponse.json({ error: "Attachments too large", details: { totalBytes, limit: MAX_TOTAL_ATTACHMENT_BYTES } }, { status: 413 }) };
    }
  }

  // Message-ID は送信前に決めておく（結果が分からないときの照合に使う）。
  // クライアントが付けてきた場合はそれを使う（ブラウザ側の通信断のあとにクライアントからも照合できるように。
  // 下書きは保存のたびに同じ Message-ID を使う）
  const messageId = isValidMessageId(bodyData.messageId) ? bodyData.messageId : makeMessageId(crypto.getRandomValues(new Uint8Array(40)));
  const sentAfterMs = Date.now();
  const text = typeof body === "string" ? body : "";

  // 転送など、元の HTML をそのまま保ちたい場合は bodyHtml を使い、テキスト版と一緒に
  // multipart/alternative で送る（受信側が HTML を表示できない場合にも読めるように）
  const segments = buildMimeSegments({
    to,
    cc: cc || undefined,
    bcc: bcc || undefined,
    subject: typeof subject === "string" ? subject : "",
    text: text || (html ? undefined : ""),
    html: html || undefined,
    attachments,
    inline,
    inReplyTo: typeof inReplyTo === "string" ? inReplyTo : undefined,
    references: typeof references === "string" ? references : undefined,
    // エイリアスから送るときだけ From を付ける（付けなければ Gmail が既定の送信元を純正と同じ形で入れる）。
    // 登録されていないアドレスを指定しても、Gmail 側で既定の送信元に置き換えられる
    from: typeof from === "string" ? from : undefined,
    replyTo: typeof replyTo === "string" ? replyTo : undefined,
    messageId,
  });
  return {
    ok: true, segments, messageId,
    threadId: typeof threadId === "string" && threadId ? threadId : undefined,
    exp: { messageId, subject: typeof subject === "string" ? subject : "", to, cc, bcc, body: text, sentAfterMs },
  };
}

// accountEmail が未指定、またはメインアカウント自身の場合はNextAuthのセッションが持つ
// トークンをそのまま使う。追加連携アカウントの場合は linked_accounts からリフレッシュトークンを引き、
// フェーズ2の getValidAccessToken で有効なアクセストークンを得る（必要ならD1に書き戻す）
async function resolveAccessToken(session: Session, accountEmail: string | null): Promise<string | null> {
  if (!accountEmail || accountEmail === session.user?.email) {
    return session.accessToken || null;
  }

  const db = getCloudflareContext().env.DB;
  // D1 ではアドレスを置き換えて保存している。更新は見つかった行に対して行う。
  // 暗号化の鍵が無いときは例外のまま上に返す（呼び出し側が 500 にする。再連携の問題ではないため）
  const row = await findLinkedAccount(db, session.user?.email || "", accountEmail);
  if (!row?.refresh_token) return null;

  // refresh_token/access_token は D1 に暗号化して保存している（tokenCrypto.ts）。
  // 壊れて復号できない値は再連携が必要なものとして扱う（null）。鍵が無いのは運用の問題なので例外のまま返す
  let storedRefreshToken: string;
  let storedAccessToken: string | null;
  try {
    storedRefreshToken = await decryptSecret(row.refresh_token);
    storedAccessToken = row.access_token ? await decryptSecret(row.access_token) : null;
  } catch (error) {
    if (error instanceof EncryptionKeyMissingError) throw error;
    logError("token.decrypt", {}, error);
    return null;
  }

  try {
    const result = await getValidAccessToken(accountEmail, storedAccessToken, row.expires_at ?? null, storedRefreshToken);
    const tokenChanged = result.accessToken !== storedAccessToken || result.expiresAt !== row.expires_at || !!result.refreshToken;
    if (tokenChanged || row.needs_reauth) {
      // Googleがリフレッシュトークンをローテーションした場合（result.refreshTokenが返る場合）は
      // 必ずD1側も更新する。ここを怠ると古いrefresh_tokenが残り続け、次回のリフレッシュ時に
      // invalid_grantで失効する（auth.tsのメインアカウント側と同じ理由でrefreshToken ?? 旧値を使う）。
      // 成功した以上、以前 needs_reauth が立っていてもここで解除する
      const nextRefreshToken = result.refreshToken ?? storedRefreshToken;
      const [encryptedAccessToken, encryptedRefreshToken] = await Promise.all([
        encryptSecret(result.accessToken),
        encryptSecret(nextRefreshToken),
      ]);
      await db.prepare(
        "UPDATE linked_accounts SET access_token = ?, expires_at = ?, refresh_token = ?, needs_reauth = 0 WHERE user_email = ? AND account_email = ?"
      ).bind(encryptedAccessToken, result.expiresAt, encryptedRefreshToken, row.user_email, row.account_email).run();
    }
    return result.accessToken;
  } catch (error: unknown) {
    logError("token.refresh.linked", {}, error);
    // invalid_grant/invalid_client はリフレッシュトークン自体が失効した恒久的なエラー
    // （auth.tsのメインアカウント側と同じ判定基準）。ネットワーク瞬断等の一時的な失敗まで
    // 再連携要求にしてしまうと、ユーザーに不要な再連携を何度も求めることになるため、
    // 恒久的なエラーのときだけ needs_reauth を立てる
    const code = (error as { error?: string } | null)?.error;
    const isPermanent = code === "invalid_grant" || code === "invalid_client";
    if (isPermanent) {
      await db.prepare(
        "UPDATE linked_accounts SET needs_reauth = 1 WHERE user_email = ? AND account_email = ?"
      ).bind(row.user_email, row.account_email).run().catch((e: unknown) => logError("token.markReauth", {}, e));
    }
    return null;
  }
}

export async function GET(request: Request) {
  const session = await auth();
  if (!session || !session.user?.email || session.error === "RefreshAccessTokenError") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  let accessToken: string | null;
  try {
    accessToken = await resolveAccessToken(session, searchParams.get("accountEmail"));
  } catch (e) {
    // 暗号化の鍵が無いなど、サーバー側の問題（再連携では直らないので 401 にしない）
    logError("token.resolve", {}, e);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
  if (!accessToken) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Gmail の下書きの一覧（Gmail → Re:Mail の同期。最大100件。超えた分は件数だけ返す）。中身は返さない
  if (searchParams.get("drafts") === "1") {
    try {
      const res = await fetchWithRetry(`${GMAIL_DRAFTS_URL}?maxResults=${DRAFT_LIST_MAX}`, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (res.status === 401) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      if (!res.ok) {
        const reason = gmailErrorReason(await res.json().catch(() => null));
        logWarn("drafts.list", { status: res.status, reason });
        return NextResponse.json({ error: "DRAFTS_LIST_FAILED", reason }, { status: res.status >= 400 ? res.status : 502 });
      }
      const d = (await res.json().catch(() => ({}))) as { drafts?: { id?: string; message?: { id?: string; threadId?: string } }[]; nextPageToken?: string; resultSizeEstimate?: number };
      const drafts = (d.drafts || [])
        .filter(x => isValidDraftId(x.id) && isValidGmailId(x.message?.id))
        .map(x => ({ id: x.id as string, messageId: x.message!.id as string, threadId: x.message?.threadId }));
      // 100件を超えた分（Re:Mail では扱わない。画面で「Gmail で開く」を出す）
      const more = d.nextPageToken ? Math.max(1, (d.resultSizeEstimate || 0) - drafts.length) : 0;
      logInfo("drafts.list", { count: drafts.length });
      return NextResponse.json({ drafts, more });
    } catch (e) {
      logError("drafts.list", {}, e);
      return NextResponse.json({ error: "DRAFTS_LIST_FAILED" }, { status: 502 });
    }
  }

  // Gmail の下書き1件。meta=1 なら出し先を決めるための宛先・件名・冒頭だけ、そうでなければ入力欄に入れる中身
  // （HTML は画面が入力欄の安全化を通してから入れる。本文中の画像と添付は一覧だけを返し、中身は要るときに取る）
  const draftParam = searchParams.get("draft");
  if (draftParam !== null) {
    if (!isValidDraftId(draftParam)) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    const meta = searchParams.get("meta") === "1";
    try {
      const url = meta
        ? `${GMAIL_DRAFTS_URL}/${encodeURIComponent(draftParam)}?format=metadata&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Bcc&metadataHeaders=Subject&fields=id,message(id,threadId,labelIds,internalDate,snippet,payload/headers)`
        : `${GMAIL_DRAFTS_URL}/${encodeURIComponent(draftParam)}?format=full&fields=id,message(id,threadId,labelIds,internalDate,snippet,payload)`;
      const res = await fetchWithRetry(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (res.status === 404) return NextResponse.json({ error: "DRAFT_GONE" }, { status: 404 });
      if (res.status === 401) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      if (!res.ok) {
        const reason = gmailErrorReason(await res.json().catch(() => null));
        logWarn("drafts.get", { status: res.status, reason });
        return NextResponse.json({ error: "DRAFT_GET_FAILED", reason }, { status: res.status >= 400 ? res.status : 502 });
      }
      const d = (await res.json()) as { id?: string; message?: GmailMessage & { labelIds?: string[]; internalDate?: string; snippet?: string } };
      const m = d.message;
      // 純正から送られた直後は、同じ ID で送ったメール（DRAFT ラベルなし）が返る。もう下書きではない
      if (!m?.id || !(m.labelIds || []).includes("DRAFT")) return NextResponse.json({ error: "DRAFT_GONE" }, { status: 404 });
      const h = m.payload?.headers || [];
      const head = {
        draftId: draftParam, messageId: m.id, threadId: m.threadId, internalDate: Number(m.internalDate || 0),
        to: decodeMimeHeader(getHeader(h, "To")), cc: decodeMimeHeader(getHeader(h, "Cc")), bcc: decodeMimeHeader(getHeader(h, "Bcc")),
        subject: decodeMimeHeader(getHeader(h, "Subject")), snippet: m.snippet || "",
      };
      if (meta) return NextResponse.json(head);
      const html = getHtmlBody(m.payload).trim();
      const text = m.payload ? getTextBody(m.payload) : "";
      const inlineImages = html
        ? extractContentIdParts(m.payload)
            .filter(p => p.mimeType.toLowerCase().startsWith("image/") && referencesContentId(html, p.contentId))
            .slice(0, INLINE_IMAGE_LIMIT)
            .map(p => ({ contentId: p.contentId, attachmentId: p.attachmentId, mimeType: p.mimeType, size: p.size, filename: p.filename }))
        : [];
      const inlineIds = new Set(inlineImages.map(i => i.attachmentId));
      const attachments = extractAttachments(m.payload, html).filter(a => !inlineIds.has(a.attachmentId)).slice(0, 50)
        .map(a => ({ filename: a.filename, mimeType: a.mimeType, size: a.size }));
      return NextResponse.json({
        ...head, from: decodeMimeHeader(getHeader(h, "From")),
        inReplyTo: getHeader(h, "In-Reply-To") || undefined, references: getHeader(h, "References") || undefined,
        html: html || null, text: text || null, inlineImages, attachments,
      });
    } catch (e) {
      logError("drafts.get", {}, e);
      return NextResponse.json({ error: "DRAFT_GET_FAILED" }, { status: 502 });
    }
  }

  const messageId = searchParams.get("messageId");

  // 添付ファイルデータの取得
  const attachmentId = searchParams.get("attachmentId");
  if (messageId && attachmentId) {
    if (messageId.startsWith("fake-")) return NextResponse.json({ data: null });
    try {
      const res = await fetchWithRetry(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (!res.ok) {
        logWarn("attachments.get", { status: res.status, messageId });
        return NextResponse.json({ data: null });
      }
      const json = await res.json();
      return NextResponse.json({ data: json.data ?? null });
    } catch (e) {
      logError("attachments.get", {}, e);
      return NextResponse.json({ data: null });
    }
  }

  // 送信元（自分のアドレスとエイリアス）と署名の設定。返信を純正 Gmail と同じ送信元・署名で送るために使う
  if (searchParams.get("sendAs") === "1") {
    try {
      const res = await fetchWithRetry("https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs", { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!res.ok) {
        logWarn("sendAs.list", { status: res.status });
        return NextResponse.json({ error: "Failed to load sendAs" }, { status: res.status });
      }
      const data = (await res.json()) as { sendAs?: { sendAsEmail: string; displayName?: string; replyToAddress?: string; signature?: string; isPrimary?: boolean; isDefault?: boolean; verificationStatus?: string }[] };
      // 確認が済んでいないエイリアスからは送れないので除く
      const sendAs = (data.sendAs || [])
        .filter(s => s.isPrimary || s.verificationStatus === "accepted")
        .map(s => ({ sendAsEmail: s.sendAsEmail, displayName: s.displayName, replyToAddress: s.replyToAddress, signature: s.signature, isPrimary: !!s.isPrimary, isDefault: !!s.isDefault }));
      return NextResponse.json({ sendAs });
    } catch (e) {
      logError("sendAs.list", {}, e);
      return NextResponse.json({ error: "Failed to load sendAs" }, { status: 500 });
    }
  }

  // 差分の同期。historyId を渡すと、そこから後の変化（新着・削除・ラベルの変化）だけを返す。
  // 渡さなければ、今の historyId（これから先の変化を取る起点）だけを返す。
  // 起点が古すぎて Gmail が履歴を持っていなければ reset: true を返し、画面側は一覧を取り直す
  if (searchParams.get("sync") === "1") {
    const auth = { headers: { Authorization: `Bearer ${accessToken}` } };
    const base = "https://gmail.googleapis.com/gmail/v1/users/me";
    const startHistoryId = searchParams.get("historyId") || "";
    try {
      if (!/^\d{1,20}$/.test(startHistoryId)) {
        const pr = await fetchWithRetry(`${base}/profile?fields=historyId`, auth);
        if (!pr.ok) { logWarn("sync.profile", { status: pr.status }); return NextResponse.json({ error: "SYNC_FAILED" }, { status: pr.status === 401 ? 401 : 502 }); }
        return NextResponse.json({ historyId: ((await pr.json()) as { historyId?: string }).historyId || null });
      }
      const records: GmailHistoryRecord[] = [];
      let latestHistoryId = startHistoryId;
      let pageToken = "";
      // 長く開いていなかった場合でも、取りにいくのは最大5ページ（2,500件の変化）まで
      for (let page = 0; page < 5; page++) {
        const params = new URLSearchParams({ startHistoryId, maxResults: "500" });
        for (const t of ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"]) params.append("historyTypes", t);
        if (pageToken) params.set("pageToken", pageToken);
        const hr = await fetchWithRetry(`${base}/history?${params.toString()}`, auth);
        if (hr.status === 404) return NextResponse.json({ reset: true });
        if (hr.status === 401) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        if (!hr.ok) { logWarn("sync.history", { status: hr.status }); return NextResponse.json({ error: "SYNC_FAILED" }, { status: 502 }); }
        const data = (await hr.json()) as { history?: GmailHistoryRecord[]; historyId?: string; nextPageToken?: string };
        records.push(...(data.history || []));
        if (data.historyId) latestHistoryId = data.historyId;
        if (!data.nextPageToken) { pageToken = ""; break; }
        pageToken = data.nextPageToken;
      }
      // 変化が多すぎて最後まで取れなかったときは、取り直してもらう（取りこぼしを残さない）
      if (pageToken) return NextResponse.json({ reset: true });
      const summary = summarizeHistory(records);
      // 下書き（DRAFT ラベル）のメールは一覧に出さないので詳細を取らない。変わったことだけを返し、画面が下書きの一覧を取り直す
      const drafts = draftHistory(records);
      const draftIds = new Set(drafts.addedDraftIds);
      const addedMail = summary.added.filter(id => !draftIds.has(id));
      const toFetch = addedMail.slice(0, 100);
      const messages: ReturnType<typeof parseMessageDetail>[] = [];
      const missingAdded: string[] = [];
      // 新しく届いたメールだけ詳細を取る。一度に投げる数は10件まで（レート制限に触れないように）
      for (let i = 0; i < toFetch.length; i += 10) {
        await Promise.all(toFetch.slice(i, i + 10).map(async (id) => {
          const res = await fetchWithRetry(`${base}/messages/${id}?fields=id,threadId,snippet,labelIds,internalDate,payload(headers,parts,body)`, auth);
          if (res.status === 404) { missingAdded.push(id); return; }
          if (!res.ok) { logWarn("sync.detail", { status: res.status, messageId: id }); return; }
          messages.push(parseMessageDetail((await res.json()) as GmailMessage));
        }));
      }
      // 詳細を取れなかった新着があるときは、次回もう一度その位置から取り直せるよう historyId を進めない
      const fetchedAll = messages.length + missingAdded.length === toFetch.length && addedMail.length <= 100;
      return NextResponse.json({
        historyId: fetchedAll ? latestHistoryId : startHistoryId,
        messages,
        labelUpdates: Object.entries(summary.labels).map(([id, labelIds]) => ({ id, labelIds })),
        deleted: [...summary.deleted, ...missingAdded],
        draftChanged: drafts.changed,
      });
    } catch (e) {
      logError("sync", {}, e);
      return NextResponse.json({ error: "SYNC_FAILED" }, { status: 500 });
    }
  }

  // ピン留めしたメールを ID で取り直す（D1 には ID しか保存しないため、端末のキャッシュに無い分だけ取りに来る）。
  // Gmail 側で削除されて見つからない ID は missing として返し、画面で「このメールは存在しません」と出す
  const idsParam = searchParams.get("ids");
  if (idsParam !== null) {
    const ids = Array.from(new Set(idsParam.split(",").filter(id => /^[0-9a-f]{6,32}$/i.test(id)))).slice(0, 50);
    const messages: ReturnType<typeof parseMessageDetail>[] = [];
    const missing: string[] = [];
    // 一時的な理由（レート制限など）で読み込めなかったもの。画面で「読み込めなかった」と知らせ、あとで取り直す
    const failedIds: string[] = [];
    // 一覧取得と同じく、同時に投げる数を20件までにする（レート制限に触れないように）
    for (let i = 0; i < ids.length; i += 20) {
      await Promise.all(ids.slice(i, i + 20).map(async (id) => {
        try {
          const res = await fetchWithRetry(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?fields=id,threadId,snippet,labelIds,internalDate,payload(headers,parts,body)`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );
          if (res.status === 404 || res.status === 400) { missing.push(id); return; }
          if (!res.ok) { logWarn("emails.byId", { status: res.status, messageId: id }); failedIds.push(id); return; }
          messages.push(parseMessageDetail((await res.json()) as GmailMessage));
        } catch (e) {
          // 1件の失敗でほかのメールまで止めない。取れなかったものは次の読み込みで取り直す
          logWarn("emails.byId", { messageId: id }, e);
          failedIds.push(id);
        }
      }));
    }
    return NextResponse.json({ messages, missing, failedIds });
  }

  // 返信元メッセージの単体検索（Discord風の返信チップで、未読み込みの過去メールへジャンプする用）。
  // ページを何十件も読み込んで探すのではなく、Gmailの rfc822msgid: 検索で
  // Message-ID を直接指定し、1〜2回のAPI呼び出しで存在有無と場所を判定する
  const lookupByMessageId = searchParams.get("lookupByMessageId");
  if (lookupByMessageId) {
    try {
      const searchRes = await fetchWithRetry(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=1&includeSpamTrash=true&q=${encodeURIComponent(`rfc822msgid:${lookupByMessageId}`)}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (!searchRes.ok) return NextResponse.json({ found: false });
      const searchData = await searchRes.json();
      const hit = (searchData.messages || [])[0];
      if (!hit) return NextResponse.json({ found: false });

      const detailRes = await fetchWithRetry(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${hit.id}?fields=id,threadId,snippet,labelIds,internalDate,payload(headers,parts,body)`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (!detailRes.ok) return NextResponse.json({ found: false });
      const message = await detailRes.json();
      return NextResponse.json({ found: true, email: parseMessageDetail(message) });
    } catch (e) {
      logError("emails.lookupByMessageId", {}, e);
      return NextResponse.json({ found: false });
    }
  }

  // 単一メッセージのHTML本文取得（モーダル表示用）
  if (messageId && searchParams.get("html") === "true") {
    if (messageId.startsWith("fake-")) return NextResponse.json({ htmlBody: null, hasHtml: false });
    try {
      const detailRes = await fetchWithRetry(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?fields=payload,internalDate`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (!detailRes.ok) {
        logWarn("emails.html", { status: detailRes.status, messageId });
        return NextResponse.json({ htmlBody: null, hasHtml: false });
      }
      const message = await detailRes.json();
      const rawHtml = getHtmlBody(message.payload);
      // 返信・転送で引用するときは、元のメールを引用部分も含めて丸ごと返す（純正 Gmail はやり取り全体を入れ子で引用するため）。
      // テキスト版も、画面用に整形する前のものを返す
      if (searchParams.get("full") === "true") {
        const rawText = message.payload ? getTextBody(message.payload) : "";
        // 受け取った時刻も返す（引用・転送の見出しの時刻。端末のキャッシュにある古いメールは持っていないため）
        return NextResponse.json({ htmlBody: rawHtml.trim() || null, textBody: rawText || null, hasHtml: !!rawHtml.trim(), internalDate: parseInternalDate(message.internalDate) ?? null, receivedAt: topReceivedTime(message.payload?.headers || []) ?? null });
      }
      const subject = decodeMimeHeader(getHeader(message.payload?.headers || [], "Subject"));
      // HTML側の引用は "> " ではなく <blockquote>/gmail_quote タグで表現されるため、
      // 転送判定は先に引用を取り除いた「自分の文章」だけに対して行う。
      // 生のHTMLのまま判定すると、引用の中に隠れた転送マーカーを拾って
      // 「転送への返信」まで転送メール扱いされ、引用が丸ごと表示されてしまう
      const htmlOwnContent = stripHtmlQuote(rawHtml);
      const htmlBody = looksLikeForward(subject, htmlOwnContent) ? rawHtml.trim() : htmlOwnContent;
      // 本文が cid: で参照している画像（本文中の画像）。中身は画面が1枚ずつ取りにいく（ここで全部を待つと本文の表示が遅れるため）
      const inlineImages = htmlBody
        ? extractContentIdParts(message.payload)
            .filter(p => p.mimeType.toLowerCase().startsWith("image/") && referencesContentId(htmlBody, p.contentId))
            .slice(0, INLINE_IMAGE_LIMIT)
            .map(p => ({ contentId: p.contentId, attachmentId: p.attachmentId, mimeType: p.mimeType, size: p.size }))
        : [];
      return NextResponse.json({ htmlBody: htmlBody || null, hasHtml: !!htmlBody, inlineImages });
    } catch (e) {
      logError("emails.html", {}, e);
      return NextResponse.json({ htmlBody: null, hasHtml: false });
    }
  }

  const maxResults = searchParams.get("maxResults") || "10";
  const q = searchParams.get("q") || "";
  const includeTrash = searchParams.get("includeTrash") === "true";
  const pageToken = searchParams.get("pageToken") || "";
  const knownIdsParam = searchParams.get("knownIds") || "";
  const knownIds = new Set(knownIdsParam.split(",").filter(Boolean));

  try {
    let apiUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxResults}`;
    // 下書き（DRAFT）は一覧に出さない（送ったメールの吹き出しのように見えてしまうため。下書きは drafts=1 で別に読み、入力欄に出す）
    const listQuery = q ? `${q} -in:drafts` : "-in:drafts";
    apiUrl += `&q=${encodeURIComponent(listQuery)}`;
    if (includeTrash) apiUrl += `&includeSpamTrash=true`;
    if (pageToken) apiUrl += `&pageToken=${pageToken}`;

    const listRes = await fetchWithRetry(apiUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (listRes.status === 401) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (listRes.status === 429) return NextResponse.json({ error: "Rate limited" }, { status: 429 });
    if (!listRes.ok) {
      logError("emails.list", { status: listRes.status });
      throw new Error("Failed to fetch messages list");
    }
    
    const listData = await listRes.json();
    const messages = listData.messages || [];
    const nextPageToken = listData.nextPageToken || null;

    if (messages.length === 0) return NextResponse.json({ messages: [], topIds: [], nextPageToken });

    const topIds = messages.map((m: { id: string }) => m.id);
    const messagesToFetch = messages.filter((m: { id: string }) => !knownIds.has(m.id));

    const chunkSize = 20;
    const detailedMessages: GmailMessage[] = [];
    // 詳細を取れなかった（レート制限・一時的な障害など）メールの数
    const failedIds: string[] = [];
    for (let i = 0; i < messagesToFetch.length; i += chunkSize) {
      const chunk = messagesToFetch.slice(i, i + chunkSize);
      const chunkResults = await Promise.all(
        chunk.map(async (msg: { id: string }) => {
          const detailRes = await fetchWithRetry(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?fields=id,threadId,snippet,labelIds,internalDate,payload(headers,parts,body)`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          // レート制限等で最終的に失敗した場合、エラーレスポンスのJSONを本物のメッセージとして
          // 誤ってパースしてしまわないよう、ここで弾く（そのメッセージ1件だけ今回は諦める。
          // 次回のポーリング/追加読み込みで再取得を試みる）
          if (!detailRes.ok) {
            logWarn("emails.detail", { status: detailRes.status, messageId: msg.id });
            // 消えたメール（404）以外は「読み込めなかった」として数え、画面で知らせる（黙って欠けさせない）
            if (detailRes.status !== 404) failedIds.push(msg.id);
            return null;
          }
          return (detailRes.json() as Promise<GmailMessage>).catch(() => null);
        })
      );
      detailedMessages.push(...chunkResults.filter((m): m is GmailMessage => !!m));
    }

    // 念のため、検索から漏れた下書きも外す
    const parsedMessages = detailedMessages.filter(m => !(m.labelIds || []).includes("DRAFT")).map(parseMessageDetail);

    return NextResponse.json({ messages: parsedMessages, topIds, nextPageToken, failedIds });
  } catch (e) {
    logError("emails.get", {}, e);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session || !session.user?.email || session.error === "RefreshAccessTokenError") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const bodyData = await request.json();
    const { action } = bodyData;
    const accessToken = await resolveAccessToken(session, bodyData.accountEmail || null);
    if (!accessToken) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // ① メールの送信
    if (action === "send" || !action) {
      const prep = await prepareSendMime(bodyData, accessToken);
      if (!prep.ok) return prep.response;
      const { segments, messageId, threadId, exp } = prep;
      // raw を JSON に入れる通常の send は数MBで失敗するため、上限 35MB の upload エンドポイントに
      // メール本体をそのまま送る（JSON 用に base64 で包み直さないので、サイズも約 1.37 倍に膨らまない）
      const upload = buildGmailUploadBody(segments, threadId);

      const { outcome, res } = await postSendOnce(upload, accessToken);

      if (outcome === "unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      if (outcome === "failed") {
        // Gmail の生の応答は宛先などを含みうるので、理由コードだけを返す
        const reason = gmailErrorReason(await res?.json().catch(() => null));
        logError("send.failed", { status: res?.status, reason });
        return NextResponse.json({ error: "Failed to send email", reason, messageId }, { status: res?.status || 500 });
      }
      if (outcome === "unknown") {
        if (res) logWarn("send.serverError", { status: res.status });
        const found = await findSentMessage(accessToken, exp);
        if (found) {
          logInfo("send.verifiedSent", { messageId: found.id, threadId: found.threadId });
          return NextResponse.json({ success: true, id: found.id, threadId: found.threadId, messageId, verified: true });
        }
        logError("send.unconfirmed");
        // 自動では再送しない。送れていないことを伝え、再送するかは利用者に決めてもらう
        return NextResponse.json({ error: "SEND_UNCONFIRMED", messageId }, { status: 502 });
      }

      // ★修正: 送信したメールを受信箱(INBOX)に強制移動させていた余計な modify 処理を完全撤廃。
      // これにより、送信したメールは本家Gmailと同じく、無条件で綺麗な「送信済み（アーカイブ状態）」として統合されます。

      // Gmailが実際に採番したメッセージID/スレッドIDをクライアントへ返す。
      // グループチャットで送信したメールをリロード後も正しく識別するために必要
      const sentData = (await res!.json().catch(() => ({}))) as { id?: string; threadId?: string };
      return NextResponse.json({ success: true, id: sentData.id, threadId: sentData.threadId, messageId });
    }

    // ② Gmail の下書きに保存する（新しく作る・上書きする）。中身は Gmail にだけ置き、ここでは通すだけ（ログにも出さない）。
    // 上書きの前に今の下書きのメッセージ ID を確かめ、ほかで書き換えられていたら上書きしない（409）。
    // ほかで送信・削除されていたら 404（DRAFT_GONE）
    if (action === "draftSave") {
      const rawId = bodyData.draftId;
      if (rawId !== undefined && rawId !== null && !isValidDraftId(rawId)) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
      const expect = isValidGmailId(bodyData.expectMessageId) ? bodyData.expectMessageId : null;
      const prep = await prepareSendMime(bodyData, accessToken);
      if (!prep.ok) return prep.response;
      const { segments, threadId } = prep;
      const html = typeof bodyData.bodyHtml === "string" ? bodyData.bodyHtml : "";
      let targetId: string | null = isValidDraftId(rawId) ? rawId : null;
      if (targetId) {
        const cur = await getDraftState(accessToken, targetId);
        if (cur.state === "unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        if (cur.state === "gone") return NextResponse.json({ error: "DRAFT_GONE" }, { status: 404 });
        if (cur.state === "error") return NextResponse.json({ error: "DRAFT_SAVE_FAILED", reason: cur.reason }, { status: cur.status });
        if (expect && cur.messageId !== expect) {
          // 中身が今から保存するものと同じなら、書き換えの競合ではない（タブを閉じたときの保存が届いていた、など）
          if (await draftEquals(accessToken, targetId, prep.exp, html)) {
            return NextResponse.json({ success: true, draftId: targetId, gmailMessageId: cur.messageId, threadId: cur.threadId, unchanged: true });
          }
          logInfo("draft.conflict", { messageId: cur.messageId });
          return NextResponse.json({ error: "DRAFT_CONFLICT", messageId: cur.messageId }, { status: 409 });
        }
      } else if (bodyData.mayExist === true) {
        // 前に作ろうとして結果を受け取れなかった（タブを閉じたときの保存など）。同じ中身の下書きがあれば、
        // それを上書きする（二重に作らない）。探せなかったときは作らずに失敗で返す（画面が少しあとで送り直す）
        const found = await findSameDraft(accessToken, prep.exp, html);
        if ("error" in found) {
          logWarn("draft.findSame.failed", { status: found.error, reason: found.reason });
          return NextResponse.json({ error: "DRAFT_SAVE_FAILED", reason: found.reason }, { status: found.error >= 400 ? found.error : 502 });
        }
        targetId = found.id;
      }
      const upload = buildDraftUploadBody(segments, targetId || undefined, threadId);
      let res: Response | undefined;
      try {
        // 上書き（update）は何度送っても同じ結果なので、429・5xx は待って送り直す。新しく作る（create）は
        // 5xx で送り直すと二重にできることがあるため、受け付けを断られた 429 だけ送り直す（postSendOnce と同じ）
        res = targetId
          ? await fetchWithRetry(`${GMAIL_DRAFTS_UPLOAD_URL}/${encodeURIComponent(targetId)}?uploadType=multipart`, {
              method: "PUT", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": upload.contentType }, body: upload.body,
            })
          : (await postSendOnce(upload, accessToken, `${GMAIL_DRAFTS_UPLOAD_URL}?uploadType=multipart`)).res;
      } catch (e) {
        logWarn("draft.save.noResponse", {}, e);
      }
      if (res?.status === 401) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      if (targetId && res?.status === 404) return NextResponse.json({ error: "DRAFT_GONE" }, { status: 404 });
      if (!res || !res.ok) {
        const reason = gmailErrorReason(await res?.json().catch(() => null));
        logWarn("draft.save.failed", { status: res?.status, reason });
        // 新しく作ろうとして結果が分からないときは、できていたかを中身で探す
        if (!targetId && (!res || res.status >= 500)) {
          const found = await findSameDraft(accessToken, prep.exp, html);
          const made = "id" in found ? found.id : null;
          const st = made ? await getDraftState(accessToken, made) : null;
          if (made && st?.state === "ok") return NextResponse.json({ success: true, draftId: made, gmailMessageId: st.messageId, threadId: st.threadId });
        }
        return NextResponse.json({ error: "DRAFT_SAVE_FAILED", reason }, { status: res && res.status >= 400 ? res.status : 502 });
      }
      const d = (await res.json().catch(() => ({}))) as GmailDraftResponse;
      logInfo("draft.saved", { messageId: d.message?.id });
      return NextResponse.json({ success: true, draftId: d.id, gmailMessageId: d.message?.id, threadId: d.message?.threadId });
    }

    // ③ Gmail の下書きを送る（drafts.send）。下書きがある入力は必ずこれで送り、失敗しても messages.send に切り替えない。
    // withContent のときは今の中身で置き換えて送る。自動では再送しない（429 だけ待って送り直す。postSendOnce と同じ）
    if (action === "draftSend") {
      if (!isValidDraftId(bodyData.draftId)) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
      const draftId: string = bodyData.draftId;
      const withContent = bodyData.withContent === true;
      const prep = await prepareSendMime(bodyData, accessToken);
      if (!prep.ok) return prep.response;
      const { segments, messageId, threadId, exp } = prep;
      const upload = withContent
        ? buildDraftUploadBody(segments, draftId, threadId)
        : { body: new TextEncoder().encode(JSON.stringify({ id: draftId })), contentType: "application/json" };
      const { outcome, res } = await postSendOnce(upload, accessToken, withContent ? `${GMAIL_DRAFTS_UPLOAD_URL}/send?uploadType=multipart` : `${GMAIL_DRAFTS_URL}/send`);
      if (outcome === "unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      if (outcome === "ok") {
        const sent = (await res!.json().catch(() => ({}))) as { id?: string; threadId?: string };
        logInfo("draft.sent", { messageId: sent.id });
        return NextResponse.json({ success: true, id: sent.id, threadId: sent.threadId, messageId });
      }
      // ほかで送信・削除された下書きは 404 のほか、送ったあとの下書きでは 400 invalidArgument が返る（2026-10-25 に実機で確認）。
      // どちらのときも下書きが残っているかを見て、無くなっていれば「ほかで送信・削除された」として扱う
      const gone = outcome === "failed" && (res?.status === 404 || (res?.status === 400 && (await getDraftState(accessToken, draftId)).state === "gone"));
      if (gone) {
        // ほかで送信・削除された。送信済みに同じメールがあれば「送信済み」、無ければ利用者に確かめる（ここでは送らない）。
        // 純正から送られたのは少し前のことがあるので、照合する時刻の幅を広げる
        const found = await findSentMessage(accessToken, { ...exp, sentAfterMs: exp.sentAfterMs - 24 * 3600_000 });
        logInfo("draft.send.gone", { count: found ? 1 : 0 });
        return found
          ? NextResponse.json({ error: "DRAFT_ALREADY_SENT", id: found.id, threadId: found.threadId }, { status: 409 })
          : NextResponse.json({ error: "DRAFT_GONE" }, { status: 404 });
      }
      if (outcome === "failed") {
        const reason = gmailErrorReason(await res?.json().catch(() => null));
        logError("draft.send.failed", { status: res?.status, reason });
        return NextResponse.json({ error: "Failed to send email", reason, messageId }, { status: res?.status || 500 });
      }
      // 送れたか分からない：下書きが残っていれば送られていない。無ければ送信済みと照合する（自動では再送しない）
      if (res) logWarn("draft.send.serverError", { status: res.status });
      const verdict = await verifyDraftSend(accessToken, draftId, exp);
      if (verdict.found) return NextResponse.json({ success: true, id: verdict.found.id, threadId: verdict.found.threadId, messageId, verified: true });
      return NextResponse.json({ error: verdict.draftExists ? "SEND_UNCONFIRMED" : "SEND_UNVERIFIED", messageId }, { status: 502 });
    }

    // ④ Gmail の下書きを消す（純正の「下書きを破棄」と同じ）。ほかで書き換えられていたら消さない（409）
    if (action === "draftDelete") {
      if (!isValidDraftId(bodyData.draftId)) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
      const draftId: string = bodyData.draftId;
      const expect = isValidGmailId(bodyData.expectMessageId) ? bodyData.expectMessageId : null;
      const cur = await getDraftState(accessToken, draftId);
      if (cur.state === "unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      if (cur.state === "gone") return NextResponse.json({ success: true, gone: true });
      if (cur.state === "error") return NextResponse.json({ error: "DRAFT_DELETE_FAILED", reason: cur.reason }, { status: cur.status });
      if (expect && cur.messageId !== expect) return NextResponse.json({ error: "DRAFT_CONFLICT", messageId: cur.messageId }, { status: 409 });
      const res = await fetchWithRetry(`${GMAIL_DRAFTS_URL}/${encodeURIComponent(draftId)}`, { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } });
      if (res.status === 401) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      if (!res.ok && res.status !== 404) {
        const reason = gmailErrorReason(await res.json().catch(() => null));
        logWarn("draft.delete.failed", { status: res.status, reason });
        return NextResponse.json({ error: "DRAFT_DELETE_FAILED", reason }, { status: res.status >= 400 ? res.status : 502 });
      }
      logInfo("draft.deleted", { messageId: cur.messageId });
      return NextResponse.json({ success: true });
    }

    // ブラウザと Worker の間の通信が切れて送信の結果を受け取れなかったときに、
    // クライアントから「そのメールが送れていたか」を確かめる（再送はしない）
    if (action === "verifySent") {
      const { messageId, to, cc, bcc, subject, body, sentAfterMs } = bodyData;
      if (!isValidMessageId(messageId) || typeof sentAfterMs !== "number") {
        return NextResponse.json({ error: "Invalid request" }, { status: 400 });
      }
      const exp: SentExpectation = {
        messageId, subject: typeof subject === "string" ? subject : "",
        to: typeof to === "string" ? to : "", cc: typeof cc === "string" ? cc : "", bcc: typeof bcc === "string" ? bcc : "",
        body: typeof body === "string" ? body : "", sentAfterMs,
      };
      // 下書きを送ったとき：下書きが残っていれば送られていない
      if (isValidDraftId(bodyData.draftId)) {
        const verdict = await verifyDraftSend(accessToken, bodyData.draftId, exp);
        return NextResponse.json(verdict.found ? { found: true, id: verdict.found.id, threadId: verdict.found.threadId } : { found: false, draftExists: verdict.draftExists });
      }
      const found = await findSentMessage(accessToken, exp);
      return NextResponse.json(found ? { found: true, id: found.id, threadId: found.threadId } : { found: false });
    }

    // メールの移動・削除（ゴミ箱へ）。どちらもラベルの付け外しで、純正 Gmail の「移動」「削除」と同じ。
    // 完全削除（batchDelete）は gmail.modify のスコープでは使えないので扱わない（スコープは増やさない：絶対ルール1）。
    // Gmail が失敗したら、そのステータスと理由コードを返す（成功と返して画面だけ移ったように見せない：絶対ルール3）
    // 既読・未読にする（read が true なら既読、false なら未読）も、同じくラベルの付け外しで行う
    if (action === "move" || action === "delete" || action === "markRead") {
      if (action === "delete" && bodyData.permanentIds !== undefined) {
        return NextResponse.json({ error: "Permanent delete is not supported" }, { status: 400 });
      }
      if (action === "markRead" && typeof bodyData.read !== "boolean") return NextResponse.json({ error: "Invalid request" }, { status: 400 });
      const change = action === "markRead" ? readLabelChange(bodyData.read) : labelChangeFor(action === "delete" ? "TRASH" : bodyData.destination);
      if (!change) return NextResponse.json({ error: "Invalid destination" }, { status: 400 });
      const ids = sanitizeMessageIds(action === "delete" ? bodyData.trashIds : bodyData.ids);
      if (ids.length === 0) return NextResponse.json({ success: true, count: 0 });
      for (const chunk of chunkIds(ids)) {
        const res = await fetchWithRetry("https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify", {
          method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ ids: chunk, ...change }),
        });
        if (res.status === 401) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        if (!res.ok) {
          const reason = gmailErrorReason(await res.json().catch(() => null));
          logWarn(`${action}.failed`, { status: res.status, reason, count: chunk.length });
          return NextResponse.json({ error: `Failed to ${action}`, reason }, { status: res.status >= 400 ? res.status : 502 });
        }
      }
      return NextResponse.json({ success: true, count: ids.length });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (e) {
    logError("emails.post", {}, e);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}