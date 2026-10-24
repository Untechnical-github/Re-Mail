// メールの詳細と添付のプレビューのモーダル（本文中の画像の読み込みを含む）・メッセージの折りたたみ。
// useMailApp.ts から分けた（動きは変えない。React のフックは使わない関数だけ）
import type { Session } from "next-auth";
import type { Email } from "../types/email";
import { getCachedAttachment, setCachedAttachment, attachmentIdCacheKey } from "../lib/attachmentCache";
import { replaceCidImages } from "../lib/emailHtml";
import type { SetState, EmailModalState, AttachmentModalState } from "./mailAppTypes";

// メールの本文中の画像（cid: で参照されるもの）
type InlineImageRef = { contentId: string; attachmentId: string; mimeType: string; size: number };
// 本文中に出す画像の1枚あたりの上限。これより大きいものは出さず、Gmail で開く案内にする（端末のメモリを守るため）
const INLINE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

export function useEmailModals({
  session, setEmailModal, setAttachmentModal, setExpandedMsgIds, showErrorToast,
}: {
  session: Session | null;
  setEmailModal: SetState<EmailModalState>;
  setAttachmentModal: SetState<AttachmentModalState>;
  setExpandedMsgIds: SetState<string[]>;
  showErrorToast: (message: string) => void;
}) {
  // 本文中の画像を1枚ずつ取りにいき、取れたものを本文に差し込む（本文は先に出しておき、あとから画像を足す）。
  // 取りにいくのは画像の数だけ（同時に3枚まで）。サーバーにもこの端末にも保存しない
  const loadInlineImages = async (email: Email, html: string, refs: InlineImageRef[], accountParam: string | null) => {
    const images: Record<string, string> = {};
    let failed = 0;
    const queue = [...refs];
    const worker = async () => {
      for (let ref = queue.shift(); ref; ref = queue.shift()) {
        if (ref.size > INLINE_IMAGE_MAX_BYTES) { failed++; continue; }
        try {
          const params = new URLSearchParams({ messageId: email.id, attachmentId: ref.attachmentId });
          if (accountParam) params.append("accountEmail", accountParam);
          const res = await fetch(`/api/emails?${params.toString()}`);
          const data = res.ok ? ((await res.json()) as { data?: string | null }) : null;
          if (!data?.data) { failed++; continue; }
          // data: URL に入れる種類は、形の正しいものだけにする（属性を壊す文字を入れない）
          const mime = /^image\/[\w.+-]{1,50}$/i.test(ref.mimeType) ? ref.mimeType : "image/png";
          images[ref.contentId.toLowerCase()] = `data:${mime};base64,${data.data.replace(/-/g, "+").replace(/_/g, "/")}`;
        } catch {
          failed++;
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    // 待っているあいだに別のメールを開いていたら差し込まない
    if (Object.keys(images).length > 0) {
      setEmailModal(prev => prev && prev.email.id === email.id && prev.htmlBody === html ? { ...prev, htmlBody: replaceCidImages(html, images) } : prev);
    }
    if (failed > 0) showErrorToast(`本文中の画像を ${failed} 枚表示できませんでした。「Gmail で開く」から純正 Gmail で確認できます。`);
  };

  const openEmailModal = async (email: Email) => {
    // メッセージをクリックした瞬間にブラウザのピンチズームを無効化（useLayoutEffect より前に実行）
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (meta) meta.content = 'width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no';
    setEmailModal({ email, htmlBody: null, isLoading: true });
    window.history.pushState({ action: "modal" }, "", window.location.href);
    if (email.id.startsWith("fake-")) {
      setEmailModal({ email, htmlBody: null, isLoading: false });
      return;
    }
    try {
      // キャッシュされた古いレスポンス（引用除去ロジック更新前のもの等）を掴まないよう、
      // 毎回ユニークなURLになるキャッシュバスターを付ける
      const htmlParams = new URLSearchParams({ messageId: email.id, html: "true", _t: Date.now().toString() });
      const emailAccountEmail = email.accountId || session?.user?.email || "";
      if (emailAccountEmail !== (session?.user?.email || "")) htmlParams.append("accountEmail", emailAccountEmail);
      const res = await fetch(`/api/emails?${htmlParams.toString()}`);
      if (res.ok) {
        const data = (await res.json()) as { htmlBody?: string | null; inlineImages?: InlineImageRef[] };
        setEmailModal(prev => prev ? { ...prev, htmlBody: data.htmlBody || null, isLoading: false } : null);
        if (data.htmlBody && data.inlineImages?.length) {
          void loadInlineImages(email, data.htmlBody, data.inlineImages, htmlParams.get("accountEmail"));
        }
      } else {
        setEmailModal(prev => prev ? { ...prev, isLoading: false } : null);
      }
    } catch {
      setEmailModal(prev => prev ? { ...prev, isLoading: false } : null);
    }
  };

  const closeEmailModal = () => {
    // このモーダルを開いた際に積んだ履歴が残ったままだと、閉じた直後にブラウザバックしても
    // その履歴を消費するだけの「何も起きない1回」になってしまう（もう1回押してようやく
    // チャット画面から戻れる、という不具合の原因）。履歴が残っていればここで消費しておく
    const state = window.history.state;
    if (state && (state.action || state.chat)) {
      window.history.back(); // popstate側で emailModal のクリアも行われる
    } else {
      setEmailModal(null);
    }
  };

  const openAttachmentModal = async (
    attachment: { filename: string; mimeType: string; size: number; attachmentId?: string; messageId: string; accountId?: string; cacheKey?: string },
    prefetchedBase64?: string
  ) => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (meta) meta.content = 'width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no';
    window.history.pushState({ action: "modal" }, "", window.location.href);
    if (prefetchedBase64) {
      setAttachmentModal({ ...attachment, base64: prefetchedBase64, isLoading: false });
      return;
    }
    setAttachmentModal({ ...attachment, base64: null, isLoading: true });
    const cacheKey = attachment.cacheKey || attachmentIdCacheKey(attachment.accountId || session?.user?.email || "", attachment.messageId, attachment.attachmentId);
    const cached = await getCachedAttachment(cacheKey);
    if (cached) {
      setAttachmentModal(prev => prev ? { ...prev, base64: cached, isLoading: false } : null);
      return;
    }
    // 送信直後のローカルのメールは attachmentId を持たず、問い合わせても取得できない
    if (!attachment.attachmentId) {
      setAttachmentModal(prev => prev ? { ...prev, isLoading: false } : null);
      return;
    }
    try {
      const attParams = new URLSearchParams({ messageId: attachment.messageId, attachmentId: attachment.attachmentId });
      if (attachment.accountId) attParams.append("accountEmail", attachment.accountId);
      const res = await fetch(`/api/emails?${attParams.toString()}`);
      if (res.ok) {
        const { data } = await res.json();
        if (data) {
          const base64 = (data as string).replace(/-/g, '+').replace(/_/g, '/');
          setCachedAttachment(cacheKey, base64);
          setAttachmentModal(prev => prev ? { ...prev, base64, isLoading: false } : null);
        } else {
          setAttachmentModal(prev => prev ? { ...prev, isLoading: false } : null);
        }
      } else {
        setAttachmentModal(prev => prev ? { ...prev, isLoading: false } : null);
      }
    } catch {
      setAttachmentModal(prev => prev ? { ...prev, isLoading: false } : null);
    }
  };

  const closeAttachmentModal = () => {
    // closeEmailModal と同じ理由で、開いた際に積んだ履歴が残っていればここで消費する
    const state = window.history.state;
    if (state && (state.action || state.chat)) {
      window.history.back(); // popstate側で attachmentModal のクリアも行われる
      return;
    }
    setAttachmentModal(null);
  };

  const toggleMsgExpand = (id: string) => {
    setExpandedMsgIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  return { openEmailModal, closeEmailModal, openAttachmentModal, closeAttachmentModal, toggleMsgExpand };
}
