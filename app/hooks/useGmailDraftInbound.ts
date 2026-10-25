// Gmail の下書きとの同期（Gmail → Re:Mail）：純正 Gmail の下書きを、その宛先とのチャットの入力欄に「書きかけ」として出す。
// - 知る：起動したとき（アカウントごとに drafts.list を1回）と、差分同期で下書きが変わったときだけ一覧を取る。
//   知らない・変わった下書きだけ中身を取る（同時に3件まで）
// - 出す：To の最初（無ければ Cc、Bcc）の人との同じアカウントの個人チャット。無ければ下書きチャットを作る。
//   入力欄が既定のままなら黙って入れ、何か書いてあれば「ほかに下書きが○件」に並べる
// - 両方で書き換えたら黙って上書きせず、どちらを残すか聞く。純正で送信・削除されたら入力欄を戻す
// 中身は Gmail と画面のあいだを通すだけ（D1・ログに残さない）。HTML は入力欄に入れるときに安全化される（composeEditor.ts の load）
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { Email } from "../types/email";
import type { InlineImage } from "../lib/composeEditor";
import type { ComposeRecipient } from "../lib/composeRecipients";
import { type RoomKeyStr } from "../lib/roomKey";
import { loadDraft, saveDraft, removeDraft, draftRooms, type ComposeDraft } from "../lib/drafts";
import { textToComposeHtml, signatureOf, composeBodyText, composeHtmlToText, normalizeComposeHtml, COMPOSE_LIMITS } from "../lib/composeHtml";
import { replySubjectFor } from "../lib/replyCompose";
import { headersOf } from "../lib/outgoingMail";
import {
  EMPTY_LINK, draftFingerprint, isDefaultContent, planDraftReconcile, draftTargetAddress, draftRecipients, recipientsOrDefault, newestDraft, normalizeDraftCids,
  type GmailDraftMeta, type GmailDraftLink, type LocalDraftState,
} from "../lib/gmailDrafts";
import { logWarn } from "../lib/safeLog";
import type { Attachment } from "./useDrafts";
import type { GmailDraftSyncApi, RoomContent } from "./useGmailDraftSync";
import type { ComposeDialog } from "./useMailApp";
import type { SetState } from "./mailAppTypes";

type DraftFull = GmailDraftMeta & {
  from?: string;
  inReplyTo?: string;
  references?: string;
  html: string | null;
  text: string | null;
  inlineImages: { contentId: string; attachmentId: string; mimeType: string; size: number; filename?: string }[];
  attachments: { filename: string; mimeType: string; size: number }[];
};

// 「ほかに下書きが○件」の一覧の1件（宛先・件名・本文の冒頭・日時）
export type DraftChoice = { key: string; to: string; subject: string; preview: string; date: number; current: boolean };

const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp|bmp)$/;
// 下書きの中身を取りにいく数（同時）
const META_CONCURRENCY = 3;

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const worker = async () => { for (let k = i++; k < items.length; k = i++) out[k] = await fn(items[k]); };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// 今の時刻（描画の外で呼ぶ）
const nowMs = () => Date.now();
const shortPreview = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 60);

export function useGmailDraftInbound({
  gmailDrafts, settingsReady, selectedSender, draftReadyRoom, emailsRef, resolveDirectRoom, addDraftChat, partnerRecipient,
  setReplySubject, setReplyToMessage, setReplyAttachments, setRecipients, setRecipientsBase, setAttachError, loadCompose, insertedSignatureRef,
  setComposeDialog, showInfoToast, showErrorToast,
}: {
  gmailDrafts: GmailDraftSyncApi;
  settingsReady: boolean;
  selectedSender: RoomKeyStr | null;
  draftReadyRoom: string | null;
  emailsRef: MutableRefObject<Email[]>;
  resolveDirectRoom: (identifier: string, accountEmail?: string) => { room: RoomKeyStr; existing: boolean } | null;
  addDraftChat: (room: string) => void;
  partnerRecipient: (room: RoomKeyStr | null) => ComposeRecipient | null;
  setReplySubject: SetState<string>;
  setReplyToMessage: SetState<Email | null>;
  setReplyAttachments: SetState<Attachment[]>;
  setRecipients: SetState<ComposeRecipient[] | null>;
  setRecipientsBase: SetState<ComposeRecipient[] | null>;
  setAttachError: SetState<string | null>;
  loadCompose: (html: string, images: InlineImage[]) => void;
  insertedSignatureRef: MutableRefObject<string | null>;
  setComposeDialog: SetState<ComposeDialog | null>;
  showInfoToast: (message: string | null, durationMs?: number) => void;
  showErrorToast: (message: string) => void;
}) {
  const core = gmailDrafts.core;
  // チャットごとの「ほかの下書き」（入力欄に出していない Gmail の下書き）
  const [others, setOthers] = useState<Record<string, GmailDraftMeta[]>>({});
  // アカウントごとの「宛先のない下書き」と「100件を超えて扱えない下書き」の数
  const [orphans, setOrphans] = useState<Record<string, { noRecipient: number; more: number }>>({});
  // 取った下書きの宛先など（メッセージ ID ごと。変わっていなければ取り直さない）
  const metaCacheRef = useRef(new Map<string, GmailDraftMeta>());
  // 両方で書き換えられたチャットの、Gmail 側の下書き
  const conflictMetaRef = useRef(new Map<string, GmailDraftMeta>());
  // 「Gmail のほうを使う」で置き換える前の入力（「元に戻す」で1度だけ戻せる）
  const undoRef = useRef(new Map<string, RoomContent>());
  // 今のアカウントごとの、知っている下書きのメッセージ ID（差分同期で消えたら一覧を取り直す）
  const knownMsgIdsRef = useRef(new Map<string, Set<string>>());
  const latest = useRef({ partnerRecipient, resolveDirectRoom, addDraftChat });
  useEffect(() => { latest.current = { partnerRecipient, resolveDirectRoom, addDraftChat }; });

  const getJson = async <T,>(params: Record<string, string>): Promise<{ status: number | null; data: T | null }> => {
    try {
      const res = await fetch(`/api/emails?${new URLSearchParams(params).toString()}`, { cache: "no-store" });
      return { status: res.status, data: res.ok ? ((await res.json()) as T) : null };
    } catch {
      return { status: null, data: null };
    }
  };

  const getMeta = async (account: string, d: { draftId: string; messageId: string }): Promise<GmailDraftMeta | null> => {
    const hit = metaCacheRef.current.get(d.messageId);
    if (hit) return hit;
    const r = await getJson<GmailDraftMeta>({ draft: d.draftId, meta: "1", accountEmail: account });
    if (!r.data) return null;
    metaCacheRef.current.set(r.data.messageId, r.data);
    if (metaCacheRef.current.size > 500) metaCacheRef.current.delete(metaCacheRef.current.keys().next().value as string);
    return r.data;
  };

  // 端末の下書きの今の中身と、Gmail の下書きとのつながり（開いているチャットは画面の入力）
  const localOf = async (room: string): Promise<{ content: RoomContent["content"]; link: GmailDraftLink } | null> => {
    if (core.isOpen(room)) return { content: core.liveContent(), link: core.linkOf(room) };
    const d = await loadDraft(room);
    return d ? { content: core.fromDraft(d), link: d.gmail ?? EMPTY_LINK } : null;
  };

  // 返信元：下書きの In-Reply-To に一致するメール（読み込んでいなければ Gmail で探す）
  const findReplySource = async (account: string, inReplyTo: string | undefined): Promise<Email | null> => {
    if (!inReplyTo) return null;
    const mine = (e: Email) => (e.accountId || "").toLowerCase() === account.toLowerCase();
    const hit = emailsRef.current.find(e => e.messageIdHeader === inReplyTo && mine(e) && !e.isMissing);
    if (hit) return hit;
    const r = await getJson<{ found?: boolean; email?: Email }>({ lookupByMessageId: inReplyTo, accountEmail: account });
    return r.data?.found && r.data.email ? { ...r.data.email, accountId: account } : null;
  };

  // 下書きを入力欄（と端末の下書き）に入れる。本文中の画像が1枚でも取れなければ入れない（黙って欠けた下書きにしない）
  const applyDraft = async (room: string, meta: GmailDraftMeta, opts: { newChat?: boolean } = {}): Promise<boolean> => {
    const account = core.accountOf(room);
    const r = await getJson<DraftFull>({ draft: meta.draftId, accountEmail: account });
    const full = r.data;
    if (!full) return false;
    // 本文中の画像（cid:）は1枚ずつ取り、入力欄の決まりと同じ形（ii_ で始まる ID）にそろえる
    const imgs = full.inlineImages.slice(0, COMPOSE_LIMITS.maxImages);
    const fetched: { contentId: string; data: string; mimeType: string; size: number; filename: string }[] = [];
    for (const ref of imgs) {
      if (!IMAGE_TYPES.test(ref.mimeType.toLowerCase()) || ref.size > COMPOSE_LIMITS.maxImageBytes) { logWarn("draft.inbound.image", { count: imgs.length }); return false; }
      const d = await getJson<{ data?: string | null }>({ messageId: full.messageId, attachmentId: ref.attachmentId, accountEmail: account });
      if (!d.data?.data) { logWarn("draft.inbound.image", { status: d.status ?? undefined }); return false; }
      const b64 = d.data.data.replace(/-/g, "+").replace(/_/g, "/");
      fetched.push({ contentId: ref.contentId, data: b64 + "===".slice((b64.length + 3) % 4), mimeType: ref.mimeType.toLowerCase(), size: ref.size, filename: ref.filename || "image.png" });
    }
    const baseHtml = full.html || textToComposeHtml(full.text || "");
    const { html, map } = normalizeDraftCids(baseHtml, fetched.map(f => f.contentId), () => Math.random().toString(36).slice(2));
    const images: InlineImage[] = fetched.map(f => ({ cid: map[f.contentId], filename: f.filename, mimeType: f.mimeType, size: f.size, data: f.data }));
    // 送信先：下書きの To / Cc / Bcc をそのまま。チャットの相手を To に1人だけなら既定として扱う
    const list = draftRecipients(full);
    const partner = latest.current.partnerRecipient(room as RoomKeyStr)?.address || "";
    const recipients = recipientsOrDefault(list, partner);
    // 返信元：見つかって件名も「Re: 元の件名」のままなら返信元にする。見つからない・件名を変えてあれば、
    // 返信元なしで、スレッドの情報（threadId・In-Reply-To・References）と件名をそのまま残す
    const source = await findReplySource(account, full.inReplyTo);
    const replyTo = source && replySubjectFor(source.subject).replace(/\s+/g, "") === (full.subject || "").replace(/\s+/g, "") ? source : null;
    const threadRef = !replyTo && (full.inReplyTo || full.references) ? { threadId: full.threadId, inReplyTo: full.inReplyTo, references: full.references } : undefined;
    // 添付は一覧だけ（中身は保存・送信のときにサーバーが下書きから取り直す）
    const attachments: Attachment[] = full.attachments.map(a => ({ filename: a.filename, mimeType: a.mimeType, size: a.size, data: "", fromDraft: true }));
    const content: RoomContent["content"] = {
      subject: replyTo ? "" : full.subject, html, images, insertedSignature: signatureOf(html),
      replyToMessage: replyTo, attachments, recipients, recipientsBase: null,
    };
    const link: GmailDraftLink = {
      draftId: full.draftId, messageId: full.messageId, messageIdHeader: null, syncedFingerprint: draftFingerprint(content),
      threadRef, fromGmail: true, keepSignature: true,
    };
    if (opts.newChat) latest.current.addDraftChat(room);
    if (core.isOpen(room)) {
      // 開いているチャット：入力欄を入れ替える（入力欄が整えたあとの中身を、少しあとで「保存済み」とみなす）
      setReplySubject(content.subject);
      insertedSignatureRef.current = content.insertedSignature;
      setReplyToMessage(replyTo);
      setReplyAttachments(attachments);
      setRecipients(recipients);
      setRecipientsBase(null);
      setAttachError(null);
      core.setLink(room, link);
      loadCompose(html, images);
      rebaseSoon(room);
    }
    const draft: ComposeDraft = { ...content, updatedAt: full.internalDate || nowMs(), gmail: link };
    await saveDraft(room, draft);
    metaCacheRef.current.set(full.messageId, meta);
    return true;
  };

  // 入力欄が整えたあと（読み込みの直後と少しあと）の中身を「保存済み」とみなす（読み込んだだけで書き換えたことにしない）
  const rebaseTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const rebaseSoon = (room: string) => {
    rebaseTimersRef.current.forEach(clearTimeout);
    const rebase = (last: boolean) => {
      if (!core.isOpen(room)) return;
      const link = core.linkOf(room);
      if (!link.fromGmail) return;
      core.setLink(room, { ...link, syncedFingerprint: draftFingerprint(core.liveContent()), fromGmail: last ? undefined : true });
    };
    rebaseTimersRef.current = [setTimeout(() => rebase(false), 500), setTimeout(() => rebase(true), 1800)];
  };
  // Gmail から読み込んだ下書きのチャットを開いたときも同じ
  useEffect(() => {
    const room = selectedSender;
    if (!room || draftReadyRoom !== room) return;
    if (core.linkOf(room).fromGmail) rebaseSoon(room);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 開いたチャットの下書きを読み終えたときだけ
  }, [selectedSender, draftReadyRoom]);

  // 一覧から消えた（純正で送信・削除された）下書き
  const handleVanished = async (v: LocalDraftState) => {
    const local = await localOf(v.room);
    if (!local) return;
    if (v.dirty) {
      // 入力中の内容は消さず、下書きとのつながりだけ外す（次の保存では新しい下書きになる）
      core.setLink(v.room, { ...EMPTY_LINK });
      core.setNotice(v.room, "この下書きは Gmail で送信または削除されました。入力中の内容は残っています");
      return;
    }
    // 送信済みに同じメールがあれば「Gmail から送信されました」と伝える（照合は宛先・件名・本文の冒頭）
    const c = local.content;
    const list = c.recipients ?? (() => { const p = latest.current.partnerRecipient(v.room as RoomKeyStr); return p ? [p] : []; })();
    const h = headersOf(list);
    let sent = false;
    try {
      const res = await fetch("/api/emails", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "verifySent", accountEmail: core.accountOf(v.room), messageId: "<CAdraft0000000000@mail.gmail.com>", to: h.to, cc: h.cc, bcc: h.bcc,
          subject: c.replyToMessage ? replySubjectFor(c.replyToMessage.subject) : c.subject,
          body: composeHtmlToText(normalizeComposeHtml(c.html)), sentAfterMs: nowMs() - 24 * 3600_000,
        }),
      });
      sent = res.ok && !!((await res.json()) as { found?: boolean }).found;
    } catch { /* 確かめられなくても、入力欄は戻す（下書きはもう無い） */ }
    // 入力欄を既定に戻し、端末の下書きを消す
    core.sentRef.current.set(v.room, core.sentKey(c));
    if (core.isOpen(v.room)) {
      core.setLink(v.room, { ...EMPTY_LINK });
      setReplySubject(""); setReplyToMessage(null); setReplyAttachments([]); setAttachError(null); setRecipients(null); setRecipientsBase(null);
      insertedSignatureRef.current = null;
      loadCompose("", []);
    }
    await removeDraft(v.room);
    if (sent) showInfoToast("この下書きは Gmail から送信されました", 4000);
  };

  // 両方で書き換えられた：どちらを残すか聞く（答えるまで Gmail には上書きしない）
  const askConflict = (room: string) => {
    const meta = conflictMetaRef.current.get(room);
    if (!meta) return;
    void localOf(room).then(local => {
      if (!local) return;
      setComposeDialog({
        kind: "draftConflict",
        gmail: { preview: shortPreview(meta.snippet), date: meta.internalDate },
        local: { preview: shortPreview(composeBodyText(local.content.html)), date: nowMs() },
        onUseGmail: () => { void takeGmailVersion(room); },
        onUseLocal: () => { void keepLocalVersion(room); },
      });
    });
  };
  const raiseConflict = (room: string, meta: GmailDraftMeta) => {
    conflictMetaRef.current.set(room, meta);
    core.conflictRoomsRef.current.add(room);
    core.setNotice(room, { text: "この下書きは別の場所でも変更されました", actionLabel: "どちらを残すか選ぶ", onAction: () => askConflict(room) });
    if (core.isOpen(room)) askConflict(room);
  };
  const takeGmailVersion = async (room: string) => {
    const meta = conflictMetaRef.current.get(room);
    if (!meta) return;
    const before = await localOf(room);
    conflictMetaRef.current.delete(room);
    core.conflictRoomsRef.current.delete(room);
    if (!(await applyDraft(room, meta))) { core.setNotice(room, "Gmail の下書きを読み込めませんでした。時間をおいてもう一度お試しください（この端末の入力は残っています）"); return; }
    if (before) undoRef.current.set(room, before);
    core.setNotice(room, { text: "Gmail の下書きに置き換えました", actionLabel: "元に戻す", onAction: () => { void undo(room); } });
  };
  const keepLocalVersion = async (room: string) => {
    const meta = conflictMetaRef.current.get(room);
    conflictMetaRef.current.delete(room);
    core.conflictRoomsRef.current.delete(room);
    core.setNotice(room, null);
    if (!meta) return;
    // 今の Gmail の下書きを土台にして、この画面の入力で上書きする
    const link = core.linkOf(room).draftId ? core.linkOf(room) : (await loadDraft(room))?.gmail ?? EMPTY_LINK;
    core.setLink(room, { ...link, draftId: meta.draftId, messageId: meta.messageId, syncedFingerprint: null });
    void core.enqueue(room);
  };
  const undo = async (room: string) => {
    const before = undoRef.current.get(room);
    undoRef.current.delete(room);
    core.setNotice(room, null);
    if (!before) return;
    const link = core.linkOf(room);
    // 戻した入力は Gmail の下書きと違うので、次の保存で上書きする
    const restored: GmailDraftLink = { ...link, syncedFingerprint: null, fromGmail: undefined };
    if (core.isOpen(room)) {
      const c = before.content;
      setReplySubject(c.subject); insertedSignatureRef.current = c.insertedSignature; setReplyToMessage(c.replyToMessage);
      setReplyAttachments(c.attachments); setRecipients(c.recipients); setRecipientsBase(c.recipientsBase); setAttachError(null);
      core.setLink(room, restored);
      loadCompose(c.html, c.images);
    }
    await saveDraft(room, { ...before.content, updatedAt: nowMs(), gmail: restored });
  };

  // アカウントの Gmail の下書きを読み、チャットの入力欄と合わせる（保存と同じ列で順に行う）
  const refreshingRef = useRef(new Set<string>());
  const refreshAccount = (account: string) => {
    const key = account.toLowerCase();
    if (!account || refreshingRef.current.has(key)) return;
    refreshingRef.current.add(key);
    void core.enqueueTask(async () => {
      try { await refreshAccountNow(account); } finally { refreshingRef.current.delete(key); }
    });
  };
  const refreshAccountNow = async (account: string) => {
    if (!core.enabledForAccount(account)) return;
    const list = await getJson<{ drafts: { id: string; messageId: string; threadId?: string }[]; more: number }>({ drafts: "1", accountEmail: account });
    if (!list.data) { logWarn("draft.inbound.list", { status: list.status ?? undefined }); return; }
    const gmail = list.data.drafts.map(d => ({ draftId: d.id, messageId: d.messageId }));
    // 端末の下書き（このアカウントの分）
    const rooms = (await draftRooms()).filter(r => core.accountOf(r).toLowerCase() === account.toLowerCase());
    const locals: (LocalDraftState & { hasInput: boolean })[] = [];
    for (const room of rooms) {
      if (core.sendingRoomsRef.current.has(room)) continue;
      const l = await localOf(room);
      if (!l) continue;
      const dirty = draftFingerprint(l.content) !== l.link.syncedFingerprint;
      locals.push({ room, draftId: l.link.draftId, messageId: l.link.messageId, dirty, hasInput: !isDefaultContent(l.content) });
    }
    // 開いているチャットに端末の下書きがまだ無い（何も書いていない）ときも、出し先の候補に入れる
    const plan = planDraftReconcile(gmail, locals);
    for (const v of plan.vanished) await handleVanished(v);
    const need = [...plan.changed.map(c => ({ draftId: c.draftId, messageId: c.messageId })), ...plan.unknown];
    const metas = new Map<string, GmailDraftMeta>();
    (await mapLimit(need, META_CONCURRENCY, d => getMeta(account, d))).forEach(m => { if (m) metas.set(m.draftId, m); });
    // Gmail 側で書き換えられた：この画面で書き換えていなければ黙って入れ、書き換えていれば聞く
    for (const c of plan.changed) {
      const meta = metas.get(c.draftId);
      if (!meta || core.conflictRoomsRef.current.has(c.local.room)) continue;
      if (c.local.dirty) raiseConflict(c.local.room, meta);
      else await applyDraft(c.local.room, meta);
    }
    // 知らない下書き：出し先のチャットを決める
    const byRoom = new Map<string, { metas: GmailDraftMeta[]; existing: boolean }>();
    let noRecipient = 0;
    for (const u of plan.unknown) {
      const meta = metas.get(u.draftId);
      if (!meta) continue;
      const addr = draftTargetAddress(meta);
      const dest = addr ? latest.current.resolveDirectRoom(addr, account) : null;
      if (!dest) { noRecipient++; continue; }
      const cur = byRoom.get(dest.room) || { metas: [], existing: dest.existing };
      cur.metas.push(meta);
      byRoom.set(dest.room, cur);
    }
    const nextOthers: Record<string, GmailDraftMeta[]> = {};
    for (const [room, { metas: list2, existing }] of byRoom) {
      const local = locals.find(l => l.room === room);
      // 入力欄が既定のまま（何も書いていない・ほかの下書きともつながっていない）なら、一番新しいものを黙って入れる
      const canTake = !local || (!local.draftId && !local.hasInput);
      if (canTake) {
        const newest = newestDraft(list2);
        if (newest && (await applyDraft(room, newest, { newChat: !existing }))) {
          const rest = list2.filter(m => m.draftId !== newest.draftId);
          if (rest.length) nextOthers[room] = rest;
          continue;
        }
      }
      nextOthers[room] = list2;
    }
    setOthers(prev => {
      const next: Record<string, GmailDraftMeta[]> = {};
      for (const [room, v] of Object.entries(prev)) if (core.accountOf(room).toLowerCase() !== account.toLowerCase()) next[room] = v;
      return { ...next, ...nextOthers };
    });
    setOrphans(prev => ({ ...prev, [account.toLowerCase()]: { noRecipient, more: list.data!.more || 0 } }));
    knownMsgIdsRef.current.set(account.toLowerCase(), new Set(list.data.drafts.map(d => d.messageId)));
  };

  // 起動したとき（残っていた分を保存し終えたあと）に、アカウントごとに1回読む
  useEffect(() => {
    core.setInboundHandlers({
      onStartupFlushed: (account: string) => refreshAccount(account),
      // 保存が 409（ほかで書き換えられた）になったら、読み直して聞く
      onConflict: (room: string) => refreshAccount(core.accountOf(room)),
    });
  });

  // 差分同期で下書きが変わったとき（useMailSync.ts から呼ぶ）
  const onSyncResult = (account: string, draftChanged: boolean, deleted: string[]) => {
    if (!settingsReady) return;
    const known = knownMsgIdsRef.current.get(account.toLowerCase()) || new Set<string>();
    if (draftChanged || deleted.some(id => known.has(id))) refreshAccount(account);
  };

  // 「ほかに下書きが○件」から選ぶ
  const openPicker = (room: string) => {
    const list = others[room] || [];
    if (!list.length) return;
    void localOf(room).then(local => {
      const items: DraftChoice[] = [
        ...(local && !isDefaultContent(local.content) ? [{ key: "current", to: "", subject: local.content.subject, preview: shortPreview(composeBodyText(local.content.html)), date: nowMs(), current: true }] : []),
        ...list.map(m => ({ key: m.draftId, to: m.to, subject: m.subject, preview: shortPreview(m.snippet), date: m.internalDate, current: false })),
      ];
      setComposeDialog({
        kind: "draftPicker",
        items,
        onPick: (key: string) => {
          if (key === "current") return;
          const meta = list.find(m => m.draftId === key);
          if (!meta) return;
          void (async () => {
            // 今の入力は、先に Gmail に保存してから入れ替える（入力を失わない）
            if (local && !isDefaultContent(local.content)) await core.enqueue(room);
            const ok = await applyDraft(room, meta);
            if (!ok) { showErrorToast("Gmail の下書きを読み込めませんでした。時間をおいてもう一度お試しください。Gmail の下書きから開くこともできます。"); return; }
            refreshAccount(core.accountOf(room));
          })();
        },
      });
    });
  };

  return {
    // 開いているチャットの「ほかに下書きが○件」
    othersCount: selectedSender ? (others[selectedSender] || []).length : 0,
    openOthers: () => { if (selectedSender) openPicker(selectedSender); },
    // アカウントごとの「宛先のない下書き」「扱えない下書き」の数
    orphans,
    onSyncResult,
  };
}
