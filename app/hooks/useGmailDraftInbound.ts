// Gmail の下書きとの同期（Gmail → Re:Mail）：純正 Gmail の下書きを、その宛先とのチャットの入力欄に「書きかけ」として出す。
// - 知る：起動したとき（アカウントごとに drafts.list を1回）と、差分同期で下書きが変わったときだけ一覧を取る。
//   知らない・変わった下書きだけ中身を取る（同時に3件まで）
// - 出す：To の最初（無ければ Cc、Bcc）の人との同じアカウント・同じ自分のアドレス（From）の個人チャット。無ければ下書きチャットを作る。
//   入力欄が既定のままなら黙って入れ、何か書いてあれば「ほかに下書きが○件」に並べる
// - 両方で書き換えたら黙って上書きせず、どちらを残すか聞く。純正で送信・削除されたら入力欄を戻す
// 中身は Gmail と画面のあいだを通すだけ（D1・ログに残さない）。HTML は入力欄に入れるときに安全化される（composeEditor.ts の load）
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { Email } from "../types/email";
import type { InlineImage } from "../lib/composeEditor";
import { recipientsFromHeader, type ComposeRecipient } from "../lib/composeRecipients";
import { type RoomKeyStr } from "../lib/roomKey";
import { loadDraft, saveDraft, removeDraft, draftRooms, type ComposeDraft } from "../lib/drafts";
import { textToComposeHtml, signatureOf, composeBodyText, composeHtmlToText, normalizeComposeHtml, COMPOSE_LIMITS } from "../lib/composeHtml";
import { replySubjectFor } from "../lib/replyCompose";
import { headersOf } from "../lib/outgoingMail";
import {
  EMPTY_LINK, draftFingerprint, normalizedFingerprint, hasUnsavedChanges, isDefaultContent, planDraftReconcile, draftTargetAddress, draftRecipients, recipientsOrDefault, newestDraft, normalizeDraftCids,
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
// 下書きの一覧を読めなかったときに読み直すまでの時間（ミリ秒）
const LIST_RETRY_MS = [30_000, 120_000, 300_000];
// 下書きの中身を取りにいく数（同時）
const META_CONCURRENCY = 3;
// Gmail 側だけの変更を黙って入れ直したときの知らせ（入力欄の近くに小さく。入力を Gmail に保存できた・送った・つながりを外したときに消える）
const NOTICE_UPDATED_FROM_GMAIL = "Gmail で変更された内容に更新しました";

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
  gmailDrafts, settingsReady, selectedSender, draftReadyRoom, emailsRef, resolveDirectRoom, addDraftChat, partnerRecipient, draftOwnAddress,
  setReplySubject, setReplyToMessage, setReplyAttachments, setRecipients, setRecipientsBase, setAttachError, loadCompose, insertedSignatureRef,
  setComposeDialog, showInfoToast, showErrorToast, isMailReady, isEditorReady,
}: {
  gmailDrafts: GmailDraftSyncApi;
  settingsReady: boolean;
  selectedSender: RoomKeyStr | null;
  draftReadyRoom: string | null;
  emailsRef: MutableRefObject<Email[]>;
  resolveDirectRoom: (identifier: string, accountEmail?: string, ownAddress?: string) => { room: RoomKeyStr; existing: boolean } | null;
  // 下書きを出す自分のアドレス（From が自分のアドレスならそれ。無ければ主アドレス。useMailApp.ts）
  draftOwnAddress: (account: string, from: string | undefined, threadId: string | undefined) => string;
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
  // 最初のメールの一覧を読み終えたか（読み終える前は、出し先の既存のチャットが分からない）
  isMailReady: () => boolean;
  // 入力欄の部品が出たか（出るまでは入力欄が整えたあとの中身を読めない）
  isEditorReady: () => boolean;
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
  const latest = useRef({ partnerRecipient, resolveDirectRoom, addDraftChat, draftOwnAddress });
  useEffect(() => { latest.current = { partnerRecipient, resolveDirectRoom, addDraftChat, draftOwnAddress }; });

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
  // 今の中身の（HTML を整えたうえでの）指紋。読み込みのあいだに打った分があるかを、入力欄を書き換える直前に見る
  const currentNfp = async (room: string): Promise<string | null> => {
    const l = await localOf(room);
    return l ? normalizedFingerprint(l.content) : null;
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

  // 下書きを入力欄（と端末の下書き）に入れる。本文中の画像が1枚でも取れなければ入れない（黙って欠けた下書きにしない）。
  // expectNfp を渡したときは、書き換える直前に今の中身がその指紋のままかを見て、違えば（読み込みのあいだに打った）入れない（stale）
  const applyDraft = async (room: string, meta: GmailDraftMeta, opts: { newChat?: boolean; expectNfp?: string | null } = {}): Promise<"ok" | "failed" | "stale"> => {
    const account = core.accountOf(room);
    const r = await getJson<DraftFull>({ draft: meta.draftId, accountEmail: account });
    const full = r.data;
    if (!full) return "failed";
    // 本文中の画像（cid:）は1枚ずつ取り、入力欄の決まりと同じ形（ii_ で始まる ID）にそろえる
    const imgs = full.inlineImages.slice(0, COMPOSE_LIMITS.maxImages);
    const fetched: { contentId: string; data: string; mimeType: string; size: number; filename: string }[] = [];
    for (const ref of imgs) {
      if (!IMAGE_TYPES.test(ref.mimeType.toLowerCase()) || ref.size > COMPOSE_LIMITS.maxImageBytes) { logWarn("draft.inbound.image", { count: imgs.length }); return "failed"; }
      const d = await getJson<{ data?: string | null }>({ messageId: full.messageId, attachmentId: ref.attachmentId, accountEmail: account });
      if (!d.data?.data) { logWarn("draft.inbound.image", { status: d.status ?? undefined }); return "failed"; }
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
      threadRef, fromGmail: true, keepSignature: true, baseNormFp: normalizedFingerprint(content),
      // 純正で選んだ差出人（エイリアス）。保存・送信のときに同じ差出人を使う
      fromAddress: recipientsFromHeader(full.from || "", "to")[0]?.address || undefined,
    };
    if (opts.expectNfp !== undefined && (await currentNfp(room)) !== opts.expectNfp) return "stale";
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
    return "ok";
  };

  // 入力欄が整えたあとの中身を「保存済み」とみなす。入力欄の部品が出るのを待ち（出るまでは画面の値しか読めない）、
  // 整えたうえでの指紋が読み込んだときと同じあいだだけ合わせる（自分で書いたものは合わせない）。15秒で終える
  const rebaseTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const rebaseSoon = (room: string) => {
    if (rebaseTimerRef.current) clearInterval(rebaseTimerRef.current);
    const startedAt = nowMs();
    rebaseTimerRef.current = setInterval(() => {
      const link = core.linkOf(room);
      const done = !core.isOpen(room) || !link.fromGmail || nowMs() - startedAt > 15_000;
      if (!done && isEditorReady()) {
        const live = core.liveContent();
        if (link.baseNormFp && normalizedFingerprint(live) === link.baseNormFp) {
          const fp = draftFingerprint(live);
          if (fp !== link.syncedFingerprint) core.setLink(room, { ...link, syncedFingerprint: fp });
        }
        return;
      }
      if (rebaseTimerRef.current) clearInterval(rebaseTimerRef.current);
      rebaseTimerRef.current = null;
      if (core.isOpen(room) && link.fromGmail) core.setLink(room, { ...link, fromGmail: undefined });
    }, 700);
  };
  // Gmail から読み込んだ下書きのチャットを開いたときも同じ
  useEffect(() => {
    const room = selectedSender;
    if (!room || draftReadyRoom !== room) return;
    if (core.linkOf(room).fromGmail) rebaseSoon(room);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 開いたチャットの下書きを読み終えたときだけ
  }, [selectedSender, draftReadyRoom]);

  // 一覧から消えた（純正で送信・削除された）下書き。nfp は消えたと判断したときの中身の指紋
  const handleVanished = async (v: LocalDraftState, nfp: string) => {
    const local = await localOf(v.room);
    if (!local) return;
    // 判断したあとに打った分があれば、書き換えていたものとして扱う（入力を消さない）
    if (v.dirty || normalizedFingerprint(local.content) !== nfp) { await keepInput(v.room, local); return; }
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
    // 照合を待つあいだに打った分があれば、消さずに残す
    const now = await localOf(v.room);
    if (now && normalizedFingerprint(now.content) !== nfp) { await keepInput(v.room, now); return; }
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
  // 消えた下書きの入力を残す：入力中の内容は消さず、下書きとのつながりだけ外す（次の保存では新しい下書きになる。スレッドと差出人は残す）
  const keepInput = async (room: string, local: { content: RoomContent["content"]; link: GmailDraftLink }) => {
    const unlinked: GmailDraftLink = { ...EMPTY_LINK, threadRef: local.link.threadRef, fromAddress: local.link.fromAddress };
    core.setLink(room, unlinked);
    // Gmail の下書きにしか無かった添付は、もう取り出せない。黙って落とさず、外したことと名前を伝える
    const atts: Attachment[] = local.content.attachments;
    const lost = atts.filter(a => a.fromDraft);
    if (!lost.length) { core.setNotice(room, "この下書きは Gmail で送信または削除されました。入力中の内容は残っています"); return; }
    const kept = atts.filter(a => !a.fromDraft);
    if (core.isOpen(room)) setReplyAttachments(kept);
    await saveDraft(room, { ...local.content, attachments: kept, updatedAt: nowMs(), gmail: unlinked });
    core.setNotice(room, `この下書きは Gmail で送信または削除されました。入力中の内容は残っていますが、Gmail の下書きにあった添付ファイル（${lost.map(a => a.filename).join("、")}）は取り出せないため外しました。必要なら付け直してください`);
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
    if ((await applyDraft(room, meta)) !== "ok") { core.setNotice(room, "Gmail の下書きを読み込めませんでした。時間をおいてもう一度お試しください（この端末の入力は残っています）"); return; }
    if (before) undoRef.current.set(room, before);
    core.setNotice(room, { text: "Gmail の下書きに置き換えました", actionLabel: "元に戻す", onAction: () => { void undo(room); } });
  };
  const keepLocalVersion = async (room: string) => {
    const meta = conflictMetaRef.current.get(room);
    conflictMetaRef.current.delete(room);
    core.conflictRoomsRef.current.delete(room);
    core.setNotice(room, null);
    if (!meta) return;
    // この画面の入力で Gmail の下書きを上書きする（本人が選んだので、そのあと Gmail 側がまた変わっていても確かめずに上書きする）
    const link = core.linkOf(room).draftId ? core.linkOf(room) : (await loadDraft(room))?.gmail ?? EMPTY_LINK;
    core.setLink(room, { ...link, draftId: meta.draftId, messageId: null, syncedFingerprint: null, fromGmail: undefined });
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
  const listRetryRef = useRef(new Map<string, number>());
  const refreshAccount = (account: string) => {
    const key = account.toLowerCase();
    if (!account || refreshingRef.current.has(key)) return;
    refreshingRef.current.add(key);
    void (async () => {
      try {
        // 最初のメールの一覧を読み終えるまで待つ（読む前に出し先を決めると、既存のチャットが見つからず
        // 同じ相手の下書きチャットを別に作ってしまっていた：2026-10-25 に実機で確認）。
        // 待つのは保存の列の外で行う（列の中で待つと、送信が保存の列を待って最大2分止まっていた）
        for (let i = 0; i < 120 && !isMailReady(); i++) await new Promise(r => setTimeout(r, 1000));
        if (!isMailReady()) { setTimeout(() => refreshAccount(account), LIST_RETRY_MS[0]); return; }
        await core.enqueueTask(() => refreshAccountNow(account));
      } finally {
        refreshingRef.current.delete(key);
      }
    })();
  };
  const refreshAccountNow = async (account: string) => {
    if (!core.enabledForAccount(account)) return;
    const list = await getJson<{ drafts: { id: string; messageId: string; threadId?: string }[]; more: number }>({ drafts: "1", accountEmail: account });
    if (!list.data) {
      logWarn("draft.inbound.list", { status: list.status ?? undefined });
      // 開いた直後のレート制限・通信断などは、少しあとで読み直す（3回まで）
      const n = listRetryRef.current.get(account.toLowerCase()) || 0;
      if (list.status !== 401 && n < LIST_RETRY_MS.length) {
        listRetryRef.current.set(account.toLowerCase(), n + 1);
        setTimeout(() => refreshAccount(account), LIST_RETRY_MS[n]);
      }
      return;
    }
    listRetryRef.current.delete(account.toLowerCase());
    const more = list.data.more || 0;
    const gmail = list.data.drafts.map(d => ({ draftId: d.id, messageId: d.messageId }));
    // 端末の下書き（このアカウントの分）
    const rooms = (await draftRooms()).filter(r => core.accountOf(r).toLowerCase() === account.toLowerCase());
    const locals: (LocalDraftState & { nfp: string })[] = [];
    for (const room of rooms) {
      if (core.sendingRoomsRef.current.has(room)) continue;
      const l = await localOf(room);
      if (!l) continue;
      // Gmail から読み込んだばかりで入力欄が整えただけのものは、書き換えたことにしない
      locals.push({ room, draftId: l.link.draftId, messageId: l.link.messageId, dirty: hasUnsavedChanges(l.content, l.link), nfp: normalizedFingerprint(l.content) });
    }
    // 判断したときの中身の指紋（入力欄を書き換える直前に、読み込みのあいだに打った分が無いかを見る）
    const nfpOf = (room: string) => locals.find(l => l.room === room)?.nfp ?? null;
    const plan = planDraftReconcile(gmail, locals);
    // 一覧は新しい順に100件まで。それより多いときは、一覧に無いだけで消えていないことがあるので1件ずつ確かめる
    // （404 のときだけ消えたとする。残っていれば変わったかを見る。確かめられなければ何もしない）
    let vanished = plan.vanished;
    const extraMsgIds: string[] = [];
    if (more > 0 && vanished.length) {
      const checked = await mapLimit(vanished, META_CONCURRENCY, async v => ({ v, r: await getJson<GmailDraftMeta>({ draft: v.draftId as string, meta: "1", accountEmail: account }) }));
      vanished = [];
      for (const { v, r } of checked) {
        if (r.status === 404) { vanished.push(v); continue; }
        if (!r.data) continue;
        extraMsgIds.push(r.data.messageId);
        metaCacheRef.current.set(r.data.messageId, r.data);
        if (r.data.messageId !== v.messageId) plan.changed.push({ local: v, draftId: r.data.draftId, messageId: r.data.messageId });
      }
    }
    for (const v of vanished) await handleVanished(v, nfpOf(v.room) ?? "");
    const need = [...plan.changed.map(c => ({ draftId: c.draftId, messageId: c.messageId })), ...plan.unknown];
    const metas = new Map<string, GmailDraftMeta>();
    (await mapLimit(need, META_CONCURRENCY, d => getMeta(account, d))).forEach(m => { if (m) metas.set(m.draftId, m); });
    // Gmail 側で書き換えられた：この画面で書き換えていなければ黙って入れ、書き換えていれば聞く。
    // 読み込みのあいだに打った分があれば（stale）、書き換えていたものとして聞く
    for (const c of plan.changed) {
      const meta = metas.get(c.draftId);
      if (!meta || core.conflictRoomsRef.current.has(c.local.room)) continue;
      if (c.local.dirty) { raiseConflict(c.local.room, meta); continue; }
      const res = await applyDraft(c.local.room, meta, { expectNfp: nfpOf(c.local.room) });
      if (res === "stale") raiseConflict(c.local.room, meta);
      // 見ている最中に中身が変わるので、気づけるように知らせる（開いていないチャットにも付けておき、開いたときに見える）
      else if (res === "ok") core.setNotice(c.local.room, NOTICE_UPDATED_FROM_GMAIL);
    }
    // 知らない下書き：出し先のチャットを決める
    const byRoom = new Map<string, { metas: GmailDraftMeta[]; existing: boolean }>();
    let noRecipient = 0;
    for (const u of plan.unknown) {
      const meta = metas.get(u.draftId);
      if (!meta) continue;
      const addr = draftTargetAddress(meta);
      // Gmail の下書きは From で、どの自分のアドレスのチャットに出すかを決める
      const dest = addr ? latest.current.resolveDirectRoom(addr, account, latest.current.draftOwnAddress(account, meta.from, meta.threadId)) : null;
      if (!dest) { noRecipient++; continue; }
      const cur = byRoom.get(dest.room) || { metas: [], existing: dest.existing };
      cur.metas.push(meta);
      byRoom.set(dest.room, cur);
    }
    const nextOthers: Record<string, GmailDraftMeta[]> = {};
    for (const [room, { metas: list2, existing }] of byRoom) {
      // 入力欄が既定のまま（何も書いていない・ほかの下書きともつながっていない）なら、一番新しいものを黙って入れる。
      // 一覧を読んでいるあいだに打ち始めているかもしれないので、今の中身で決める
      const now = await localOf(room);
      const canTake = !now || (!now.link.draftId && isDefaultContent(now.content));
      if (canTake) {
        const newest = newestDraft(list2);
        if (newest && (await applyDraft(room, newest, { newChat: !existing, expectNfp: now ? normalizedFingerprint(now.content) : null })) === "ok") {
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
    setOrphans(prev => ({ ...prev, [account.toLowerCase()]: { noRecipient, more } }));
    knownMsgIdsRef.current.set(account.toLowerCase(), new Set([...list.data.drafts.map(d => d.messageId), ...extraMsgIds]));
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
            // 今の入力は、先に Gmail に保存してから入れ替える（入力を失わない）。保存できなかった（送信先が無い・25MB を超える・
            // 通信断・競合中など）ときは入れ替えない
            const before = await localOf(room);
            if (before && !isDefaultContent(before.content)) {
              await core.enqueue(room);
              const after = await localOf(room);
              if (after && !isDefaultContent(after.content) && hasUnsavedChanges(after.content, after.link)) {
                showErrorToast("今の入力を Gmail の下書きに保存できなかったため、入れ替えませんでした。入力は残っています。入力欄の近くの知らせを確かめてから、もう一度お試しください。");
                return;
              }
            }
            const res = await applyDraft(room, meta, { expectNfp: await currentNfp(room) });
            if (res === "stale") { showErrorToast("読み込みの途中で入力が変わったため、入れ替えませんでした。入力は残っています。もう一度選んでください。"); return; }
            if (res === "failed") { showErrorToast("Gmail の下書きを読み込めませんでした。時間をおいてもう一度お試しください。Gmail の下書きから開くこともできます。"); return; }
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
