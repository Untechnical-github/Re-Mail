// Gmail の下書きとの同期（Re:Mail → Gmail）：書きかけを Gmail の下書きに保存する・中身が既定に戻ったら消す。
// 保存するのは「チャットを離れたとき」「タブ・アプリを離れたとき」「タブを閉じるとき」「起動したとき（残っていた分）」
// 「入力が1分止まったとき」だけ（打つたびには呼ばない）。中身は Gmail にだけ置き、Worker は通すだけ（絶対ルール1）。
// 端末の下書き（drafts.ts）は今どおり残し、Gmail への保存が失敗しても次の機会に送り直す（絶対ルール3）
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { Email } from "../types/email";
import type { ChatConfig } from "../types/mail";
import type { InlineImage } from "../lib/composeEditor";
import type { ComposeRecipient } from "../lib/composeRecipients";
import { type RoomKeyStr, decodeRoomKey } from "../lib/roomKey";
import { loadDraft, saveDraft, updateDraftLink, draftRooms, type ComposeDraft } from "../lib/drafts";
import { EMPTY_LINK, draftFingerprint, planDraftSave, fitsKeepalive, isRetryableSaveStatus, SAVE_RETRY_DELAYS_MS, type DraftContent, type GmailDraftLink } from "../lib/gmailDrafts";
import { makeMessageId } from "../lib/sendVerify";
import { logWarn } from "../lib/safeLog";
import type { Attachment, CarriedDraft } from "./useDrafts";
import type { OutgoingContent, PreparedOutgoing } from "./useSend";

export type DraftLinkRef = MutableRefObject<{ room: string; link: GmailDraftLink } | null>;
type PrepareFn = (c: OutgoingContent, opts?: { noFetch?: boolean }) => Promise<PreparedOutgoing>;

// 入力欄の近くに小さく出す知らせ（トーストは出さない）
const NOTICE = {
  failed: "Gmail に保存できていません（この端末には残っています）",
  reauth: "ログインの有効期限が切れたため Gmail に保存できていません。再読み込みしてください（この端末には残っています）",
  noSendAs: "署名と送信元の設定を読み込めないため Gmail に保存できていません（この端末には残っています）",
  tooLarge: "添付ファイルと本文中の画像が25MBを超えるため、Gmail の下書きには保存していません（この端末には残っています）",
  tooLong: "本文が長すぎるため、Gmail の下書きには保存していません（この端末には残っています）",
  conflict: "この下書きは別の場所でも変更されたため、Gmail に上書きしていません（この端末には残っています）",
  gone: "この下書きは Gmail で送信または削除されました。入力中の内容は残っています",
} as const;

// 1分止まったら保存する
const IDLE_SAVE_MS = 60_000;
// タブを閉じるときに送る中身は、打つのが止まってから作っておく
const KEEPALIVE_PREP_MS = 2_000;
// 起動したときに残っていた分は、1件ずつ間をあけて保存する
const STARTUP_GAP_MS = 2_000;

type RoomContent = { content: DraftContent & { insertedSignature: string | null; images: InlineImage[]; attachments: Attachment[]; replyToMessage: Email | null; recipients: ComposeRecipient[] | null; recipientsBase: ComposeRecipient[] | null }; link: GmailDraftLink };

export function useGmailDraftSync({
  selectedSender, draftReadyRoom, replySubject, composeHtml, composeImages, replyToMessage, replyAttachments, recipients, recipientsBase,
  insertedSignatureRef, currentCompose, linkRef, carryDraftRef, chatConfigsRef, partnerRecipient, prepareRef, isEnabled, settingsReady, accounts,
}: {
  selectedSender: RoomKeyStr | null;
  draftReadyRoom: string | null;
  replySubject: string;
  composeHtml: string;
  composeImages: InlineImage[];
  replyToMessage: Email | null;
  replyAttachments: Attachment[];
  recipients: ComposeRecipient[] | null;
  recipientsBase: ComposeRecipient[] | null;
  insertedSignatureRef: MutableRefObject<string | null>;
  currentCompose: () => { html: string; images: InlineImage[] };
  linkRef: DraftLinkRef;
  carryDraftRef: MutableRefObject<CarriedDraft | null>;
  chatConfigsRef: MutableRefObject<Record<RoomKeyStr, ChatConfig>>;
  partnerRecipient: (room: RoomKeyStr | null) => ComposeRecipient | null;
  prepareRef: MutableRefObject<PrepareFn | null>;
  // そのアカウントで同期するか（アカウント設定。既定はオン）
  isEnabled: (account: string) => boolean;
  // アカウント設定を読み終えたか（読み終えるまでは同期しない。オフにしている人の分を保存しないため）
  settingsReady: boolean;
  // ログインしているアカウント（起動時に残っていた分を保存する対象）
  accounts: string[];
}) {
  const [notices, setNotices] = useState<Record<string, string>>({});
  const setNotice = (room: string, text: string | null) => setNotices(prev => {
    if ((prev[room] ?? null) === text) return prev;
    const next = { ...prev };
    if (text) next[room] = text; else delete next[room];
    return next;
  });

  // 送っている間は保存しない（送信と保存が入れ違って、送ったあとに下書きが残る・二重にできるのを防ぐ）
  const sendingRoomsRef = useRef(new Set<string>());
  // 保存は1件ずつ順に行う（同じ下書きを同時に書き換えて、自分どうしで競合にしないため）
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const queuedRef = useRef(new Set<string>());
  const retryRef = useRef(new Map<string, { count: number; timer: ReturnType<typeof setTimeout> | null }>());

  // 開いているチャットの今の入力（描画のたびに更新する。非同期の保存から読む）
  const live = { room: selectedSender, ready: !!selectedSender && draftReadyRoom === selectedSender, replySubject, replyToMessage, replyAttachments, recipients, recipientsBase };
  const liveRef = useRef(live);

  const settingsRef = useRef({ isEnabled, settingsReady });
  useEffect(() => { settingsRef.current = { isEnabled, settingsReady }; });

  const accountOf = (room: string) => { try { return decodeRoomKey(room).accountEmail; } catch { return ""; } };
  const enabledFor = (room: string) => settingsRef.current.settingsReady && !!accountOf(room) && settingsRef.current.isEnabled(accountOf(room));
  const isOpen = (room: string) => liveRef.current.ready && liveRef.current.room === room;

  const linkOf = (room: string): GmailDraftLink => (linkRef.current?.room === room ? linkRef.current.link : EMPTY_LINK);
  // 同期の状態を書き換える（開いているチャットなら手元の分も、端末の下書きにも）
  const setLink = (room: string, link: GmailDraftLink) => {
    if (linkRef.current?.room === room) linkRef.current = { room, link };
    void updateDraftLink(room, link);
  };

  const liveContent = (): RoomContent["content"] => {
    const l = liveRef.current;
    const now = currentCompose();
    return {
      subject: l.replySubject, html: now.html, images: now.images, insertedSignature: insertedSignatureRef.current,
      replyToMessage: l.replyToMessage, attachments: l.replyAttachments, recipients: l.recipients, recipientsBase: l.recipientsBase,
    };
  };
  const fromDraft = (d: ComposeDraft): RoomContent["content"] => ({
    subject: d.subject, html: d.html, images: d.images || [], insertedSignature: d.insertedSignature ?? null,
    replyToMessage: d.replyToMessage, attachments: d.attachments, recipients: d.recipients ?? null, recipientsBase: d.recipientsBase ?? null,
  });
  const effectiveRecipientsOf = (room: string, list: ComposeRecipient[] | null): ComposeRecipient[] => {
    if (list) return list;
    const p = partnerRecipient(room as RoomKeyStr);
    return p ? [p] : [];
  };
  const toOutgoing = (room: string, c: RoomContent["content"]): OutgoingContent => ({
    room: room as RoomKeyStr, subject: c.subject, html: c.html, images: c.images, insertedSignature: c.insertedSignature,
    replyToMessage: c.replyToMessage, attachments: c.attachments, recipients: effectiveRecipientsOf(room, c.recipients),
  });

  const scheduleRetry = (room: string) => {
    const r = retryRef.current.get(room) || { count: 0, timer: null };
    if (r.count >= SAVE_RETRY_DELAYS_MS.length) return;
    if (r.timer) clearTimeout(r.timer);
    r.timer = setTimeout(() => { r.timer = null; void enqueue(room); }, SAVE_RETRY_DELAYS_MS[r.count]);
    r.count++;
    retryRef.current.set(room, r);
  };
  const resetRetry = (room: string) => {
    const r = retryRef.current.get(room);
    if (r?.timer) clearTimeout(r.timer);
    retryRef.current.delete(room);
  };

  type SaveResponse = { error?: string; draftId?: string; gmailMessageId?: string; messageIdHeader?: string };
  const post = async (body: Record<string, unknown>): Promise<{ status: number | null; data: SaveResponse }> => {
    try {
      const res = await fetch("/api/emails", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return { status: res.status, data: (await res.json().catch(() => ({}))) as SaveResponse };
    } catch {
      return { status: null, data: {} };
    }
  };

  // 失敗の知らせと送り直し。401 は再ログインの案内、404 はほかで送信・削除された、409 はほかで書き換えられた
  const handleFailure = (room: string, status: number | null, error?: string) => {
    if (status === 401) { setNotice(room, NOTICE.reauth); return; }
    if (error === "DRAFT_GONE") {
      // 入力は消さず、Gmail の下書きとのつながりだけ外す（次の保存では新しい下書きになる）
      setLink(room, { ...EMPTY_LINK });
      setNotice(room, NOTICE.gone);
      return;
    }
    if (error === "DRAFT_CONFLICT") { setNotice(room, NOTICE.conflict); return; }
    logWarn("draft.save.failed", { status: status ?? undefined, reason: error });
    setNotice(room, NOTICE.failed);
    if (isRetryableSaveStatus(status)) scheduleRetry(room);
  };

  const saveRoom = async (room: string, given?: RoomContent) => {
    if (sendingRoomsRef.current.has(room) || !enabledFor(room)) return;
    if (chatConfigsRef.current[room as RoomKeyStr]?.isGroup) return;
    let c: RoomContent["content"];
    let link: GmailDraftLink;
    if (given) ({ content: c, link } = given);
    else if (isOpen(room)) { c = liveContent(); link = linkOf(room); }
    else {
      const d = await loadDraft(room);
      if (!d) return;
      c = fromDraft(d);
      link = d.gmail ?? EMPTY_LINK;
    }
    const list = effectiveRecipientsOf(room, c.recipients);
    const plan = planDraftSave({ enabled: true, isGroup: false, content: c, link, recipientCount: list.length });
    if (plan === "skip") return;
    const fp = draftFingerprint(c);
    if (plan === "forget") { setLink(room, { ...link, syncedFingerprint: fp }); setNotice(room, null); return; }
    if (plan === "delete") {
      const r = await post({ action: "draftDelete", accountEmail: accountOf(room), draftId: link.draftId, expectMessageId: link.messageId });
      if (r.status === 200) { resetRetry(room); setNotice(room, null); setLink(room, { ...EMPTY_LINK, syncedFingerprint: fp }); return; }
      handleFailure(room, r.status, r.data.error);
      return;
    }
    const prepare = prepareRef.current;
    if (!prepare) return;
    const prep = await prepare(toOutgoing(room, c));
    if (!prep.ok) {
      // 完成形にできないときは保存しない（署名・引用の欠けた下書きを Gmail に置かない）
      setNotice(room, prep.kind === "noSendAs" ? NOTICE.noSendAs : prep.kind === "tooLarge" ? NOTICE.tooLarge : prep.kind === "tooLong" ? NOTICE.tooLong : NOTICE.failed);
      if (prep.kind === "noSendAs" || prep.kind === "noQuote") scheduleRetry(room);
      return;
    }
    // Message-ID は下書きごとに1つ持つ（Gmail が付け替えたもの）。新しく作るときは「作ろうとした」ことを先に残す
    // （結果を受け取れなかったら、次は同じ中身の下書きを探してから作る。二重にしないため）
    const header = link.messageIdHeader || makeMessageId(crypto.getRandomValues(new Uint8Array(40)));
    const mayExist = !link.draftId && !!link.createAttempted;
    if (!link.draftId) { link = { ...link, messageIdHeader: header, createAttempted: true }; setLink(room, link); }
    const r = await post({ action: "draftSave", ...prep.payload, messageId: header, draftId: link.draftId, expectMessageId: link.messageId, mayExist });
    if (r.status === 200 && r.data.draftId) {
      resetRetry(room);
      setNotice(room, null);
      // Message-ID は Gmail が付け替えたものを持つ（読めなかったときは送ったもの）
      setLink(room, { draftId: r.data.draftId, messageId: r.data.gmailMessageId || null, messageIdHeader: r.data.messageIdHeader || header, syncedFingerprint: fp });
      return;
    }
    handleFailure(room, r.status, r.data.error);
  };

  // 今 Gmail に保存しているチャット（タブを閉じるときの保存と重ねて、二重に作らないため）
  const savingRef = useRef<string | null>(null);
  const enqueue = (room: string, given?: RoomContent): Promise<void> => {
    if (!given && queuedRef.current.has(room)) return queueRef.current;
    queuedRef.current.add(room);
    queueRef.current = queueRef.current.then(async () => {
      queuedRef.current.delete(room);
      savingRef.current = room;
      try { await saveRoom(room, given); } catch (e) { logWarn("draft.sync", {}, e); } finally { savingRef.current = null; }
    });
    return queueRef.current;
  };

  // ---- 保存のきっかけ ----
  // 1. ほかのチャットへ移るとき（送信元の切り替え・送信先を変えて移るときは、持っていった先で保存するのでここでは保存しない）。
  // liveRef を今の入力に書き換える前に、移る前のチャットの入力を保存する（入力欄はまだ移る前の中身のまま。移り先の下書きは非同期で読み戻す）
  useEffect(() => {
    const before = liveRef.current;
    liveRef.current = live;
    const prev = before.room;
    if (!prev || prev === live.room || !before.ready || carryDraftRef.current?.fromRoom === prev) return;
    const now = currentCompose();
    const content: RoomContent["content"] = {
      subject: before.replySubject, html: now.html, images: now.images, insertedSignature: insertedSignatureRef.current,
      replyToMessage: before.replyToMessage, attachments: before.replyAttachments, recipients: before.recipients, recipientsBase: before.recipientsBase,
    };
    const link = linkOf(prev);
    // 打ってすぐ（端末の保存の待ち時間のうち）に移った分も端末に残す
    void saveDraft(prev, { ...content, updatedAt: Date.now(), gmail: link });
    void enqueue(prev, { content, link });
  });

  // 5. 入力が1分止まったとき
  const keepaliveRef = useRef<{ room: string; fp: string; body: string } | null>(null);
  useEffect(() => {
    const room = selectedSender;
    if (!room || draftReadyRoom !== room) return;
    const idle = setTimeout(() => { void enqueue(room); }, IDLE_SAVE_MS);
    // タブを閉じるときに送る中身を作っておく（閉じるときは待てないため）。通信が要る補いはしない
    const prep = setTimeout(() => {
      void (async () => {
        keepaliveRef.current = null;
        if (!enabledFor(room) || chatConfigsRef.current[room]?.isGroup || sendingRoomsRef.current.has(room)) return;
        const c = liveContent();
        let link = linkOf(room);
        const list = effectiveRecipientsOf(room, c.recipients);
        if (planDraftSave({ enabled: true, isGroup: false, content: c, link, recipientCount: list.length }) !== "save") return;
        const prepare = prepareRef.current;
        const p = prepare ? await prepare(toOutgoing(room, c), { noFetch: true }) : null;
        if (!p?.ok) return;
        if (!link.messageIdHeader) { link = { ...link, messageIdHeader: makeMessageId(crypto.getRandomValues(new Uint8Array(40))) }; setLink(room, link); }
        const body = JSON.stringify({ action: "draftSave", ...p.payload, messageId: link.messageIdHeader, draftId: link.draftId, expectMessageId: link.messageId, mayExist: !link.draftId && !!link.createAttempted });
        // 大きいもの（添付・画像付き・長い本文）は keepalive の上限を超えるので送らない（次に起動したときに保存する）
        if (fitsKeepalive(body)) keepaliveRef.current = { room, fp: draftFingerprint(c), body };
      })();
    }, KEEPALIVE_PREP_MS);
    return () => { clearTimeout(idle); clearTimeout(prep); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 入力の中身が変わったときだけ数え直す
  }, [selectedSender, draftReadyRoom, replySubject, composeHtml, composeImages, replyToMessage, replyAttachments, recipients]);

  // 2. タブ・アプリを離れたとき  3. タブを閉じる・再読み込みするとき（fetch の keepalive）
  useEffect(() => {
    const onHidden = () => {
      const room = liveRef.current.room;
      if (document.visibilityState === "hidden" && room && liveRef.current.ready) void enqueue(room);
    };
    const onPageHide = () => {
      const k = keepaliveRef.current;
      const room = liveRef.current.room;
      // 保存の途中・待ちがあれば送らない（先に離れたとき〔visibilitychange〕の保存と重ねて二重に作らない。届かなければ次の起動で拾う）
      if (!k || !room || k.room !== room || !liveRef.current.ready || queuedRef.current.has(room) || savingRef.current === room) return;
      const c = liveContent();
      const link = linkOf(room);
      // 作っておいた中身が今の入力と同じで、まだ保存していないときだけ送る
      if (draftFingerprint(c) !== k.fp || link.syncedFingerprint === k.fp) return;
      try {
        void fetch("/api/emails", { method: "POST", headers: { "Content-Type": "application/json" }, body: k.body, keepalive: true }).catch(() => {});
      } catch { /* 送れなくても、端末の下書きから次に起動したときに保存する */ }
      // 結果は受け取れないので、新しく作ったかもしれないことだけ残す（次は同じ中身の下書きを探してから作る）
      if (!link.draftId) setLink(room, { ...link, createAttempted: true });
    };
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", onPageHide);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 中で使う値は ref から読む
  }, []);

  // 4. 起動したとき：端末にまだ保存していない下書きが残っていれば、送信元の設定を読み終えてから1件ずつ保存する
  // アカウントは後から読み込まれる（連携しているアカウント）ので、まだ見ていないアカウントの分だけを見る
  const flushedAccountsRef = useRef(new Set<string>());
  const accountsKey = accounts.join(",");
  useEffect(() => {
    if (!settingsReady || !accountsKey) return;
    const fresh = new Set(accountsKey.split(",").map(a => a.toLowerCase()).filter(a => a && !flushedAccountsRef.current.has(a)));
    if (fresh.size === 0) return;
    fresh.forEach(a => flushedAccountsRef.current.add(a));
    void (async () => {
      const rooms = (await draftRooms()).filter(r => fresh.has(accountOf(r).toLowerCase()));
      for (const room of rooms) {
        if (isOpen(room)) continue;
        const d = await loadDraft(room);
        if (!d || !enabledFor(room)) continue;
        if (draftFingerprint(fromDraft(d)) === d.gmail?.syncedFingerprint) continue;
        await enqueue(room);
        await new Promise(r => setTimeout(r, STARTUP_GAP_MS));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 設定を読み終えたとき・アカウントが増えたときだけ
  }, [settingsReady, accountsKey]);

  // ---- 送信から使うもの ----
  const api = {
    sendingRoomsRef,
    // 保存の途中なら終わるのを待つ
    waitIdle: () => queueRef.current,
    // 送るときに使う Gmail の下書き（同期していない・下書きが無ければ null）
    linkForSend: (room: string): GmailDraftLink | null => {
      if (!enabledFor(room) || chatConfigsRef.current[room as RoomKeyStr]?.isGroup) return null;
      const link = linkOf(room);
      return link.draftId ? link : null;
    },
    // 最後に Gmail に保存してから、入力を変えたか
    isDirtyNow: (room: string): boolean => isOpen(room) && draftFingerprint(liveContent()) !== linkOf(room).syncedFingerprint,
    // 送った・ほかで送信済みだった・下書きが無くなっていた：Gmail の下書きとのつながりを外す
    forgetLink: (room: string) => { resetRetry(room); setNotice(room, null); setLink(room, { ...EMPTY_LINK }); },
    // 入力中の内容を持ってほかのチャットへ移ったとき：同じアカウントなら Gmail の下書きもそのまま持っていく。
    // 送信元のアカウントを変えたときは、元のアカウントの下書きを消す（同じ内容が2つのアカウントに残らないように）
    onCarried: (fromRoom: string, toRoom: string, fromLink: GmailDraftLink | undefined) => {
      if (!fromLink?.draftId) return;
      const sameAccount = accountOf(fromRoom).toLowerCase() === accountOf(toRoom).toLowerCase();
      if (sameAccount && linkRef.current?.room === toRoom && !linkRef.current.link.draftId) {
        setLink(toRoom, { ...fromLink, syncedFingerprint: null });
        return;
      }
      void post({ action: "draftDelete", accountEmail: accountOf(fromRoom), draftId: fromLink.draftId, expectMessageId: fromLink.messageId });
    },
    // 開いているチャットの知らせ
    notice: selectedSender ? notices[selectedSender] ?? null : null,
  };
  return api;
}

export type GmailDraftSyncApi = ReturnType<typeof useGmailDraftSync>;
