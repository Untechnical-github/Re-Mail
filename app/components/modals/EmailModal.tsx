import { useState, useRef, useEffect, useLayoutEffect, useCallback } from "react";
import { BodyWithLinks } from "../ui";
import type { MailAppHook } from "../../hooks/useMailApp";
import { logError } from "../../lib/safeLog";
import { prepareEmailHtml, hasRemoteContent } from "../../lib/emailHtml";
import { gmailOpenUrl } from "../../lib/gmailLink";

export function EmailModal({ app }: { app: MailAppHook }) {
  const { emailModal } = app.state;
  const { closeEmailModal } = app.actions;

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  // 「画像を表示」を押したメールの ID。メールごとに押す（設定として覚えない）。別のメールを開けば元に戻る
  const [remoteAllowedFor, setRemoteAllowedFor] = useState<string | null>(null);

  // レンダー直後・ペイント前にビューポートをロック（モーダル開閉と同期）
  useLayoutEffect(() => {
    if (!emailModal) return;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    const original = meta?.content ?? '';
    if (meta) meta.content = 'width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no';
    return () => { if (meta) meta.content = original; };
  }, [!!emailModal]); // eslint-disable-line react-hooks/exhaustive-deps

  // モーダルが閉じたら window リスナーをクリーンアップ
  useEffect(() => {
    if (!emailModal) { cleanupRef.current?.(); cleanupRef.current = null; }
  }, [emailModal]);

  // アンマウント時のクリーンアップ
  useEffect(() => { return () => { cleanupRef.current?.(); }; }, []);

  const onIframeLoad = useCallback(() => {
    if (cleanupRef.current) { cleanupRef.current(); cleanupRef.current = null; }

    const iframe = iframeRef.current;
    if (!iframe) return;
    const doc = iframe.contentDocument;
    if (!doc?.body) return;

    const bodyEl = doc.body;
    const htmlEl = doc.documentElement as HTMLElement;

    // ズームのセットアップでどこかが例外を投げても、本文自体は必ず見える状態にする
    // （zoom設定に失敗しただけで本文が真っ暗/非表示のままになるのを防ぐ）
    let fitScale = 1;
    const state = { x: 0, y: 0, scale: 1 };
    let naturalWidth = 1, naturalHeight = 1, frameWidth = 1, frameHeight = 1;
    let clamp = () => {};
    let updateTransform = () => {};

    try {
      // overflow 設定前に自然な寸法を計測（設定後は scrollWidth が clientWidth に変わるため）
      naturalWidth = Math.max(bodyEl.scrollWidth, 1);
      naturalHeight = Math.max(bodyEl.scrollHeight, 1);
      frameWidth = Math.max(iframe.clientWidth, 1);
      frameHeight = Math.max(iframe.clientHeight, 1);

      // body 幅を固定（リフロー防止）。html 自体は元のiframeサイズ（frameWidth/frameHeight）の
      // ままにする。overflow:hidden のクリップはhtmlの実サイズ基準で働くため、htmlを広げなくても
      // transform（scale + translate）で body の任意の位置を映すことができる。
      // ★以前は html を naturalWidth*5 に拡げていたが、レスポンシブなメールテンプレート
      // （メディアクエリでレイアウトを切り替えるもの）だと、この幅の変更でメール内のCSSが
      // 「デスクトップ幅」と誤認して再レイアウトしてしまい、幅を固定したbody内で内容が
      // はみ出す→拡大時に右側が見切れる/欠けるという不具合の原因になっていた
      bodyEl.style.width = naturalWidth + 'px';

      // ネイティブスクロール無効化（transform で制御するため）
      htmlEl.style.overflow = 'hidden';
      bodyEl.style.overflow = 'hidden';
      fitScale = Math.max(0.01, Math.min(1, frameWidth / naturalWidth));
      state.scale = fitScale;

      updateTransform = () => {
        bodyEl.style.transform = `translate3d(${state.x}px,${state.y}px,0) scale(${state.scale})`;
      };

      clamp = () => {
        const cW = naturalWidth * state.scale;
        const cH = naturalHeight * state.scale;
        state.x = cW <= frameWidth ? 0 : Math.max(frameWidth - cW, Math.min(0, state.x));
        state.y = cH <= frameHeight ? 0 : Math.max(frameHeight - cH, Math.min(0, state.y));
      };

      clamp();
      updateTransform();
    } catch (e) {
      logError("attachment.imageZoom", {}, e);
    } finally {
      bodyEl.style.opacity = '1'; // ズーム設定の成否に関わらず必ず表示する（flash 防止 兼 フォールバック）
    }

    // カーソル/ピンチ中心を固定してズーム
    const applyZoom = (newScale: number, pivotX: number, pivotY: number) => {
      const clamped = Math.max(fitScale, Math.min(5, newScale));
      const bpX = (pivotX - state.x) / state.scale;
      const bpY = (pivotY - state.y) / state.scale;
      state.x = pivotX - bpX * clamped;
      state.y = pivotY - bpY * clamped;
      state.scale = clamped;
      clamp();
      updateTransform();
    };

    // ホイール: ctrlKey → ズーム、else → パン（transform で制御、ネイティブスクロールなし）
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey) {
        applyZoom(state.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX, e.clientY);
      } else {
        const d = e.deltaMode === 0 ? 1 : 20;
        state.x -= e.deltaX * d;
        state.y -= e.deltaY * d;
        clamp();
        updateTransform();
      }
    };

    // マウスドラッグ（iframe 外に出ても追跡できるよう window に登録）
    let isDragging = false, iframeOffsetX = 0, iframeOffsetY = 0;
    let dragStartX = 0, dragStartY = 0, dragStartSX = 0, dragStartSY = 0;

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const r = iframe.getBoundingClientRect();
      iframeOffsetX = r.left; iframeOffsetY = r.top;
      isDragging = true;
      dragStartX = e.clientX; dragStartY = e.clientY; // iframe 座標系
      dragStartSX = state.x; dragStartSY = state.y;
      htmlEl.style.cursor = 'grabbing';
    };
    const onWinMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      // ボタンが離されていたらドラッグ終了（iframe 内 mouseup は window に伝播しないため）
      if (!(e.buttons & 1)) { isDragging = false; htmlEl.style.cursor = ''; return; }
      // parent 座標 → iframe 座標に変換してデルタを計算
      state.x = dragStartSX + (e.clientX - iframeOffsetX) - dragStartX;
      state.y = dragStartSY + (e.clientY - iframeOffsetY) - dragStartY;
      clamp();
      updateTransform();
    };
    const onWinMouseUp = () => {
      if (!isDragging) return;
      isDragging = false;
      htmlEl.style.cursor = '';
    };

    // タッチ: 1本指パン・2本指ピンチズーム
    const getDist = (t: TouchList) => {
      const dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY;
      return Math.sqrt(dx * dx + dy * dy);
    };
    const getMid = (t: TouchList) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });

    let isPinching = false, lastTX = 0, lastTY = 0;
    let pinchStartDist = 0, pinchStartScale = 1;
    let pinchStartBodyX = 0, pinchStartBodyY = 0; // ジェスチャー開始時のピンチ中心 (body 座標)

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        lastTX = e.touches[0].clientX; lastTY = e.touches[0].clientY;
      } else if (e.touches.length >= 2) {
        isPinching = true;
        pinchStartDist = getDist(e.touches);
        pinchStartScale = state.scale;
        const startMid = getMid(e.touches);
        pinchStartBodyX = (startMid.x - state.x) / state.scale;
        pinchStartBodyY = (startMid.y - state.y) / state.scale;
        e.preventDefault();
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.cancelable) e.preventDefault();
      if (e.touches.length === 1 && !isPinching) {
        state.x += e.touches[0].clientX - lastTX;
        state.y += e.touches[0].clientY - lastTY;
        clamp();
        updateTransform();
        lastTX = e.touches[0].clientX; lastTY = e.touches[0].clientY;
      } else if (e.touches.length >= 2) {
        const dist = getDist(e.touches), mid = getMid(e.touches);
        // スケール: ジェスチャー開始時からの累積比率
        const newScale = Math.max(fitScale, Math.min(5, pinchStartScale * dist / pinchStartDist));
        // パン: ピンチ開始点 (body 座標固定) が現在のピンチ中心に来るよう offset を更新
        state.x = mid.x - pinchStartBodyX * newScale;
        state.y = mid.y - pinchStartBodyY * newScale;
        state.scale = newScale;
        clamp();
        updateTransform();
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) {
        isPinching = false;
        if (e.touches.length === 1) { lastTX = e.touches[0].clientX; lastTY = e.touches[0].clientY; }
      }
    };

    window.addEventListener('mousemove', onWinMouseMove);
    window.addEventListener('mouseup', onWinMouseUp);
    doc.addEventListener('wheel', onWheel, { passive: false });
    doc.addEventListener('mousedown', onMouseDown);
    doc.addEventListener('mouseup', onWinMouseUp); // iframe 内での mouseup（window には伝播しないため）
    doc.addEventListener('touchstart', onTouchStart, { passive: false });
    doc.addEventListener('touchmove', onTouchMove, { passive: false });
    doc.addEventListener('touchend', onTouchEnd);

    cleanupRef.current = () => {
      window.removeEventListener('mousemove', onWinMouseMove);
      window.removeEventListener('mouseup', onWinMouseUp);
    };
  }, []);

  if (!emailModal) return null;

  const { email, htmlBody, isLoading } = emailModal;
  const showHtml = !isLoading && !!htmlBody;
  const showText = !isLoading && !htmlBody;
  // 外部の画像を毎回読み込むかは、そのメールのアカウントの設定に従う
  const allowRemote = app.actions.alwaysLoadImagesFor(email.accountId) || remoteAllowedFor === email.id;
  const remoteBlocked = showHtml && !allowRemote && hasRemoteContent(htmlBody!);

  return (
    <div
      className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-2 sm:p-4"
      onClick={closeEmailModal}
    >
      <div
        className="bg-[#2B2D31] rounded-lg shadow-2xl w-full max-w-3xl flex flex-col border border-[#1E1F22]"
        style={{ height: "92dvh" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ヘッダー */}
        <div className="flex items-start gap-3 p-4 border-b border-[#1E1F22] flex-shrink-0">
          <div className="flex-1 min-w-0">
            <div className="font-bold text-white text-sm leading-snug break-words">
              {email.subject || "(件名なし)"}
            </div>
            <div className="text-[11px] text-gray-400 mt-1 truncate">{email.from}</div>
            {/* 宛先は設定に関係なく出す。Bcc は自分が送ったメール（送信済み）にだけ残っている */}
            {([["To", email.to], ["Cc", email.cc], ["Bcc", email.bcc]] as const).map(([label, value]) => value ? (
              <div key={label} className="text-[11px] text-gray-400 truncate" title={value}>
                <span className="text-gray-500">{label}: </span>{value}
              </div>
            ) : null)}
            <div className="text-[11px] text-gray-500">
              {new Date(email.date).toLocaleString("ja-JP")}
            </div>
          </div>
          {/* Re:Mail の表示で足りないとき（崩れる・添付が見られない など）に、純正 Gmail で同じメールを開けるようにする */}
          <a
            href={gmailOpenUrl(email.accountId || app.auth.session?.user?.email, email.threadId)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-bold text-[#5865F2] hover:text-white flex-shrink-0 px-1 pt-0.5"
          >
            Gmail で開く
          </a>
          <button
            onClick={closeEmailModal}
            className="text-gray-400 hover:text-white text-xl font-bold flex-shrink-0 leading-none"
          >
            ×
          </button>
        </div>

        {/* 外部の画像は既定で読み込まない（読み込むと送信者に開封が伝わるため） */}
        {remoteBlocked && (
          <div className="flex items-center gap-2 px-4 py-2 text-xs text-gray-300 bg-[#1E1F22] border-b border-[#1E1F22] flex-shrink-0">
            <span className="flex-1 min-w-0">外部の画像を読み込んでいません</span>
            <button onClick={() => setRemoteAllowedFor(email.id)} className="flex-shrink-0 font-bold px-2 py-0.5 rounded border border-[#4E5058] text-gray-200 hover:text-white">
              画像を表示
            </button>
          </div>
        )}

        {/* コンテンツ - 両モードとも h-full で同一高さ */}
        <div className="flex-1 min-h-0">
          {isLoading && (
            <div className="flex items-center justify-center h-full text-gray-400 text-sm">
              読み込み中...
            </div>
          )}
          {showHtml && (
            <iframe
              ref={iframeRef}
              srcDoc={prepareEmailHtml(htmlBody!, allowRemote)}
              sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin"
              className="w-full h-full border-none block bg-white"
              title="メール本文"
              onLoad={onIframeLoad}
            />
          )}
          {showText && (
            <div className="overflow-y-auto h-full p-4 bg-white">
              <pre className="text-gray-800 text-sm whitespace-pre-wrap break-words font-sans leading-relaxed select-text">
                <BodyWithLinks text={email.body || ""} />
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
