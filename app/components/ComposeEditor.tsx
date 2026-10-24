"use client";
// 書式付きの入力欄（画面の部品）。編集の処理は app/lib/composeEditor.ts、HTML の安全化・整形は app/lib/composeHtml.ts。
// 書式のボタンは、文字を選んだとき（選んだ範囲の近くの小さなバー）と、送信スペースを開いて「Aa」を押したとき（すべての書式）だけ出す
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ComposeEditorController, editorSrcDoc, type EditorFormatState, type InlineImage } from "../lib/composeEditor";
import { GMAIL_COLORS, GMAIL_FONTS, GMAIL_SIZES, type ImageSizeMode } from "../lib/composeHtml";

export type ComposeEditorApi = {
  getHtml: () => string;
  getImages: () => InlineImage[];
  setContent: (html: string, images: InlineImage[]) => void;
  focus: () => void;
};

type Props = {
  // 中身を入れ替えるときに増やす（チャットの切り替え・下書きの読み戻し・署名や引用の入れ替え）
  loadSeq: number;
  loadHtml: string;
  loadImages: InlineImage[];
  allowRemoteImages: boolean;
  disabled: boolean;
  placeholder: string;
  bodyEmpty: boolean;
  fullBarOpen: boolean;
  apiRef: React.MutableRefObject<ComposeEditorApi | null>;
  onChange: (html: string, images: InlineImage[]) => void;
  onFocus: () => void;
  onError: (message: string) => void;
  onDropFiles: (files: File[]) => void;
  onOpenFullBar: () => void;
};

const EMPTY_STATE: EditorFormatState = { bold: false, italic: false, underline: false, strike: false, ol: false, ul: false, align: "left", face: null, size: null, link: null, hasSelection: false, rect: null, image: null };

// ボタンを押しても入力欄の選択が外れないよう、押した瞬間の既定の動きを止める
const keep = (e: React.PointerEvent | React.MouseEvent) => e.preventDefault();

function Btn({ label, active, onClick, children, wide }: { label: string; active?: boolean; onClick: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onPointerDown={keep}
      onMouseDown={keep}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={`${wide ? "px-2" : "w-8"} h-8 flex items-center justify-center rounded text-sm transition flex-shrink-0 ${active ? "bg-[#5865F2] text-white" : "text-gray-300 hover:bg-[#3f4147] hover:text-white"}`}
    >
      {children}
    </button>
  );
}

function Menu({ label, current, children }: { label: string; current: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative flex-shrink-0">
      <button type="button" title={label} aria-label={label} aria-expanded={open} onPointerDown={keep} onMouseDown={keep} onClick={(e) => { e.stopPropagation(); setOpen(!open); }} className="h-8 px-2 rounded text-xs text-gray-300 hover:bg-[#3f4147] hover:text-white max-w-[9rem] truncate">
        {current} ▾
      </button>
      {open && (
        <div role="menu" className="absolute bottom-9 left-0 z-[70] bg-[#2B2D31] border border-[#1E1F22] rounded shadow-xl p-1 max-h-64 overflow-y-auto min-w-[10rem]">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function ColorGrid({ onPick }: { onPick: (kind: "text" | "background", hex: string) => void }) {
  const [kind, setKind] = useState<"text" | "background">("text");
  return (
    <div className="p-1 w-[15.5rem]">
      <div className="flex gap-1 mb-2">
        {(["text", "background"] as const).map(k => (
          <button key={k} type="button" onPointerDown={keep} onMouseDown={keep} onClick={(e) => { e.stopPropagation(); setKind(k); }} className={`flex-1 text-xs font-bold rounded py-1 ${kind === k ? "bg-[#5865F2] text-white" : "bg-[#1E1F22] text-gray-300"}`}>
            {k === "text" ? "文字の色" : "背景の色"}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-8 gap-1">
        {GMAIL_COLORS.map(c => (
          <button key={c} type="button" title={c} aria-label={c} onPointerDown={keep} onMouseDown={keep} onClick={(e) => { e.stopPropagation(); onPick(kind, c); }} className="w-6 h-6 rounded-sm border border-black/30" style={{ backgroundColor: c }} />
        ))}
      </div>
    </div>
  );
}

export function ComposeEditor(props: Props) {
  const { loadSeq, loadHtml, loadImages, allowRemoteImages, disabled, placeholder, bodyEmpty, fullBarOpen, apiRef } = props;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const ctrlRef = useRef<ComposeEditorController | null>(null);
  const cbRef = useRef(props);
  useEffect(() => { cbRef.current = props; });
  const [ready, setReady] = useState(false);
  const [fmt, setFmt] = useState<EditorFormatState>(EMPTY_STATE);
  const [folded, setFolded] = useState(true);
  const [hasFoldable, setHasFoldable] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [plainAsk, setPlainAsk] = useState<((v: boolean) => void) | null>(null);
  const changeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  // 「メールの外部の画像」の設定が変わったら iframe を作り直す（中の CSP は最初の HTML でしか決められないため）
  const srcDoc = useMemo(() => editorSrcDoc(allowRemoteImages), [allowRemoteImages]);

  // iframe を読み終わったら編集できる状態にする
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    let ctrl: ComposeEditorController | null = null;
    const onLoad = () => {
      ctrl?.destroy();
      ctrl = new ComposeEditorController(iframe, {
        onChange: () => {
          if (changeTimer.current) clearTimeout(changeTimer.current);
          changeTimer.current = setTimeout(() => {
            const c = ctrlRef.current;
            if (!c) return;
            cbRef.current.onChange(c.getHtml(), c.getImages());
            setHasFoldable(c.hasFoldable());
          }, 250);
        },
        onFormatState: setFmt,
        onFocus: () => cbRef.current.onFocus(),
        onError: (m) => cbRef.current.onError(m),
        onLinkRequest: () => { setLinkUrl(""); setLinkOpen(true); },
        confirmPlainPaste: () => new Promise<boolean>((resolve) => setPlainAsk(() => resolve)),
        onDropFiles: (files) => cbRef.current.onDropFiles(files),
      });
      if (!ctrl.attach()) { cbRef.current.onError("入力欄を準備できませんでした。再読み込みしてください。"); return; }
      ctrlRef.current = ctrl;
      setReady(true);
    };
    iframe.addEventListener("load", onLoad);
    // すでに読み終わっていたとき
    if (iframe.contentDocument?.readyState === "complete" && iframe.contentDocument.body) onLoad();
    return () => { iframe.removeEventListener("load", onLoad); ctrl?.destroy(); ctrlRef.current = null; setReady(false); };
  }, [srcDoc]);

  // 中身の入れ替え
  useEffect(() => {
    const c = ctrlRef.current;
    if (!ready || !c) return;
    c.setContent(loadHtml, loadImages);
    setFolded(true);
    c.setFolded(true);
    setHasFoldable(c.hasFoldable());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 入れ替えの番号が変わったときだけ入れる（入力のたびに入れ直さない）
  }, [loadSeq, ready]);

  useEffect(() => {
    apiRef.current = ready && ctrlRef.current ? {
      getHtml: () => ctrlRef.current?.getHtml() ?? "",
      getImages: () => ctrlRef.current?.getImages() ?? [],
      setContent: (html, images) => { ctrlRef.current?.setContent(html, images); setHasFoldable(!!ctrlRef.current?.hasFoldable()); },
      focus: () => ctrlRef.current?.focus(),
    } : null;
  }, [ready, apiRef]);

  // 送れないチャット（受信専用など）では編集させない
  useEffect(() => {
    if (ready) ctrlRef.current?.setEditable(!disabled);
  }, [disabled, ready]);

  const c = () => ctrlRef.current;
  const run = (fn: (ctrl: ComposeEditorController) => void) => { const ctrl = c(); if (ctrl) fn(ctrl); };
  const currentFont = GMAIL_FONTS.find(f => fmt.face && f.face.split(",")[0] === fmt.face.split(",")[0].trim())?.label || "Sans Serif";
  const currentSize = GMAIL_SIZES.find(s => s.size === fmt.size)?.label || "標準";

  const linkButton = <Btn label="リンク（Ctrl+K）" active={!!fmt.link} onClick={() => { setLinkUrl(fmt.link || ""); setLinkOpen(true); }}>🔗</Btn>;
  const colorMenu = (
    <Menu label="文字の色・背景の色" current="色">
      {(close) => <ColorGrid onPick={(kind, hex) => { run(x => (kind === "text" ? x.setColor(hex) : x.setBackground(hex))); close(); }} />}
    </Menu>
  );

  // 文字を選んだときの小さなバー（スマホでは画面の下＝キーボードの上に出す）
  const floating = !disabled && (fmt.hasSelection || fmt.image) && fmt.rect;
  const floatStyle: React.CSSProperties | undefined = floating && fmt.rect ? (() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    const narrow = typeof window !== "undefined" && window.innerWidth < 768;
    if (narrow && vv) return { position: "fixed", left: 8, right: 8, top: vv.offsetTop + vv.height - 52 };
    const top = Math.max(8, fmt.rect.top - 48);
    return { position: "fixed", left: Math.max(8, Math.min(fmt.rect.left, (typeof window !== "undefined" ? window.innerWidth : 800) - 360)), top };
  })() : undefined;

  return (
    <div className="flex-1 min-w-0 relative" onClick={(e) => e.stopPropagation()}>
      {/* すべての書式（「Aa」で開く。送信スペースを開いているときだけ） */}
      {fullBarOpen && !disabled && (
        <div className="flex flex-wrap items-center gap-0.5 mb-1 pb-1 border-b border-[#2B2D31]" role="toolbar" aria-label="書式">
          <Menu label="フォント" current={currentFont}>
            {(close) => GMAIL_FONTS.map(f => (
              <button key={f.label} type="button" role="menuitemradio" aria-checked={currentFont === f.label} onPointerDown={keep} onMouseDown={keep} onClick={(e) => { e.stopPropagation(); run(x => x.setFont(f.face)); close(); }} className="block w-full text-left px-2 py-1 rounded text-sm text-gray-200 hover:bg-[#3f4147]" style={{ fontFamily: f.face }}>{f.label}</button>
            ))}
          </Menu>
          <Menu label="文字の大きさ" current={currentSize}>
            {(close) => GMAIL_SIZES.map(s => (
              <button key={s.label} type="button" role="menuitemradio" aria-checked={currentSize === s.label} onPointerDown={keep} onMouseDown={keep} onClick={(e) => { e.stopPropagation(); run(x => x.setSize(s.size)); close(); }} className="block w-full text-left px-2 py-1 rounded text-gray-200 hover:bg-[#3f4147]">{s.label}</button>
            ))}
          </Menu>
          <Btn label="太字（Ctrl+B）" active={fmt.bold} onClick={() => run(x => x.exec("bold"))}><b>B</b></Btn>
          <Btn label="斜体（Ctrl+I）" active={fmt.italic} onClick={() => run(x => x.exec("italic"))}><i>I</i></Btn>
          <Btn label="下線（Ctrl+U）" active={fmt.underline} onClick={() => run(x => x.exec("underline"))}><u>U</u></Btn>
          <Btn label="取り消し線（Ctrl+Shift+X）" active={fmt.strike} onClick={() => run(x => x.exec("strikeThrough"))}><s>S</s></Btn>
          {colorMenu}
          <Btn label="左揃え" active={fmt.align === "left"} onClick={() => run(x => x.exec("justifyLeft"))}>⯇</Btn>
          <Btn label="中央揃え" active={fmt.align === "center"} onClick={() => run(x => x.exec("justifyCenter"))}>≡</Btn>
          <Btn label="右揃え" active={fmt.align === "right"} onClick={() => run(x => x.exec("justifyRight"))}>⯈</Btn>
          <Btn label="番号付きリスト" active={fmt.ol} onClick={() => run(x => x.exec("insertOrderedList"))}>1.</Btn>
          <Btn label="箇条書き" active={fmt.ul} onClick={() => run(x => x.exec("insertUnorderedList"))}>•</Btn>
          <Btn label="インデント解除" onClick={() => run(x => x.exec("outdent"))}>⇤</Btn>
          <Btn label="インデント" onClick={() => run(x => x.exec("indent"))}>⇥</Btn>
          <Btn label="引用" onClick={() => run(x => x.toggleQuote())}>❝</Btn>
          {linkButton}
          <Btn label="本文に画像を入れる" onClick={() => imageInputRef.current?.click()}>🖼</Btn>
          <Btn label="書式をクリア（Ctrl+\）" onClick={() => run(x => { x.exec("removeFormat"); x.exec("unlink"); })}>Tx</Btn>
          <input ref={imageInputRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/bmp" multiple hidden onChange={(e) => { const files = Array.from(e.target.files || []); e.target.value = ""; run(x => { void x.insertImages(files); }); }} />
        </div>
      )}

      <div className="relative">
        <iframe
          ref={iframeRef}
          title="本文"
          // 入力欄だけは allow-scripts を付ける（Safari で入力のイベントを受けるため。README §18.3）。
          // 守りは中の CSP・画面の CSP・入れるときの安全化・見張り。メール本文を表示する iframe には付けない
          sandbox="allow-same-origin allow-scripts"
          srcDoc={srcDoc}
          className="block w-full border-0 bg-transparent"
          style={{ height: 32, maxHeight: "min(40dvh, 13rem)" }}
        />
        {bodyEmpty && (
          <div className="absolute left-2 top-1 text-[15px] leading-6 text-gray-500 pointer-events-none truncate max-w-[calc(100%-1rem)] px-2">{placeholder}</div>
        )}
      </div>

      {/* 引用と署名は「…」にたたむ（押すと開いて中も編集できる） */}
      {hasFoldable && (
        <button type="button" title={folded ? "引用・署名を表示" : "引用・署名をたたむ"} aria-label={folded ? "引用・署名を表示" : "引用・署名をたたむ"} onPointerDown={keep} onMouseDown={keep} onClick={(e) => { e.stopPropagation(); const next = !folded; setFolded(next); run(x => x.setFolded(next)); }} className="ml-2 mt-0.5 px-2 h-5 leading-none rounded bg-[#4E5058] text-gray-200 text-xs font-bold hover:bg-[#5865F2]">
          …
        </button>
      )}

      {floating && (
        <div style={floatStyle} className="z-[75] flex items-center gap-0.5 bg-[#2B2D31] border border-[#1E1F22] rounded-lg shadow-xl p-1 overflow-x-auto" role="toolbar" aria-label="選んだ文字の書式">
          {fmt.image ? (
            <>
              {([["small", "小"], ["best", "最適"], ["original", "元のサイズ"]] as [ImageSizeMode, string][]).map(([m, l]) => (
                <Btn key={m} label={`画像の大きさ：${l}`} wide onClick={() => run(x => { void x.setImageSize(m); })}><span className="text-xs">{l}</span></Btn>
              ))}
              <Btn label="画像を削除" wide onClick={() => run(x => x.removeSelectedImage())}><span className="text-xs text-red-300">削除</span></Btn>
            </>
          ) : (
            <>
              <Btn label="太字（Ctrl+B）" active={fmt.bold} onClick={() => run(x => x.exec("bold"))}><b>B</b></Btn>
              <Btn label="斜体（Ctrl+I）" active={fmt.italic} onClick={() => run(x => x.exec("italic"))}><i>I</i></Btn>
              <Btn label="下線（Ctrl+U）" active={fmt.underline} onClick={() => run(x => x.exec("underline"))}><u>U</u></Btn>
              {linkButton}
              {colorMenu}
              <Btn label="書式をクリア（Ctrl+\）" onClick={() => run(x => { x.exec("removeFormat"); x.exec("unlink"); })}>Tx</Btn>
              <Btn label="その他の書式" wide onClick={() => props.onOpenFullBar()}><span className="text-xs">その他</span></Btn>
            </>
          )}
        </div>
      )}

      {/* リンクの入力（http・https・mailto だけ） */}
      {linkOpen && (
        <div className="fixed inset-0 bg-black/70 z-[90] flex items-center justify-center p-4" onClick={(e) => { e.stopPropagation(); setLinkOpen(false); }}>
          <div role="dialog" aria-modal="true" aria-label="リンク" className="bg-[#313338] rounded-lg shadow-2xl w-full max-w-sm border border-[#1E1F22] p-5" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-white mb-3">リンク</h2>
            <input autoFocus type="url" inputMode="url" value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="https://" onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); if (ctrlRef.current?.insertLink(linkUrl)) setLinkOpen(false); } }} className="w-full bg-[#1E1F22] text-sm text-gray-200 px-3 py-2 rounded focus:outline-none focus:ring-1 focus:ring-[#5865F2]" />
            <p className="text-[11px] text-gray-400 mt-2">http・https・mailto のアドレスだけ使えます</p>
            <div className="flex justify-end gap-3 mt-4">
              {fmt.link && <button type="button" onClick={() => { run(x => x.exec("unlink")); setLinkOpen(false); }} className="px-4 py-2 hover:underline text-gray-300 text-sm">リンクを外す</button>}
              <button type="button" onClick={() => setLinkOpen(false)} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
              <button type="button" onClick={() => { if (ctrlRef.current?.insertLink(linkUrl)) setLinkOpen(false); }} className="px-4 py-2 bg-[#5865F2] text-white rounded text-sm font-bold hover:bg-[#4752C4]">リンクにする</button>
            </div>
          </div>
        </div>
      )}

      {/* 50万文字を超える貼り付け */}
      {plainAsk && (
        <div className="fixed inset-0 bg-black/70 z-[90] flex items-center justify-center p-4" onClick={(e) => { e.stopPropagation(); plainAsk(false); setPlainAsk(null); }}>
          <div role="dialog" aria-modal="true" className="bg-[#313338] rounded-lg shadow-2xl w-full max-w-sm border border-[#1E1F22] p-5" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm text-gray-200 mb-5 leading-relaxed">貼り付ける内容が大きすぎるため（50万文字まで）、書式付きでは貼り付けられません。文字だけで貼り付けますか？</p>
            <div className="flex justify-end gap-3">
              <button type="button" onClick={() => { plainAsk(false); setPlainAsk(null); }} className="px-4 py-2 hover:underline text-gray-300 text-sm">やめる</button>
              <button type="button" onClick={() => { plainAsk(true); setPlainAsk(null); }} className="px-4 py-2 bg-[#5865F2] text-white rounded text-sm font-bold hover:bg-[#4752C4]">文字だけで貼り付ける</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
