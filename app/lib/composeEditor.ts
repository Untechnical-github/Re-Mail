// 書式付きの入力欄（ブラウザでだけ動く）。iframe の中の document を編集できる状態にし、親の画面のコードから
// イベントを付けて動かす。iframe の中にスクリプトは置かない。
//
// 守り（README §15「入力欄の iframe」）：
//   1. iframe の中の CSP（最初の HTML の <head> の先頭）：default-src 'none'。スクリプト・外部の CSS・フォント・画像を止める
//   2. 画面の CSP（nonce のスクリプトだけ）を iframe も受け継ぐ
//   3. 外から入る HTML は composeHtml.ts の安全化を必ず通す（貼り付け・ドロップ・下書き・引用・署名・画像）
//   4. 見張り（MutationObserver）：中身が変わるたびに、危ない要素・属性をすぐ取り除く（ブラウザの既定の動きで入ったものも）
// sandbox は "allow-same-origin allow-scripts"。Safari（WebKit）は allow-scripts の無い iframe の中のイベントを
// 親に渡さないため（README §19 の試作の結果）。sandbox はスクリプトの守りとしては働かないので、上の4枚で守る
import {
  COMPOSE_LIMITS, isDangerousElement, isDangerousAttribute, insertSafeHtml, replaceContent, mapImageSources,
  imageDimensions, makeInlineContentId, isComposeBodyEmpty, GMAIL_FONTS, type ImageSizeMode,
} from "./composeHtml";
import { logWarn } from "./safeLog";

export type InlineImage = { cid: string; filename: string; mimeType: string; size: number; data: string /* base64 */ };

export type EditorFormatState = {
  bold: boolean; italic: boolean; underline: boolean; strike: boolean;
  ol: boolean; ul: boolean; align: "left" | "center" | "right";
  face: string | null; size: string | null; link: string | null;
  hasSelection: boolean;
  // 選んだ範囲・画像の位置（親の画面の座標）。書式のバーをその近くに出すため
  rect: { left: number; top: number; bottom: number; width: number } | null;
  image: { cid: string | null; width: string | null } | null;
};

export type EditorCallbacks = {
  onChange: () => void;
  onFormatState: (s: EditorFormatState) => void;
  onFocus: () => void;
  onError: (message: string) => void;
  onLinkRequest: () => void;
  // 50万文字を超える貼り付けを、文字だけで貼るか聞く
  confirmPlainPaste: () => Promise<boolean>;
  // 画像以外のファイルを落としたとき（添付にする）
  onDropFiles: (files: File[]) => void;
};

const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp|bmp)$/;
// 1回の見張りで調べるノードの数の上限（巨大な貼り付けで固まらないように。残りは次の機会に回す）
const GUARD_BUDGET = 3000;

// iframe の最初の HTML。CSP の <meta> を <head> の先頭に置き、中身（本文・署名・引用）は読み終わってから DOM の操作で入れる
export function editorSrcDoc(allowRemoteImages: boolean): string {
  const img = allowRemoteImages ? "data: blob: cid: https:" : "data: blob: cid:";
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${img}; style-src 'unsafe-inline'; font-src data:">`
    + `<meta charset="utf-8"><style>`
    + `html,body{margin:0;background:transparent;color:#DBDEE1;font:15px/24px system-ui,-apple-system,"Segoe UI",sans-serif;caret-color:#fff}`
    + `body{padding:4px 8px;min-height:24px;outline:none;word-break:break-word;overflow-wrap:anywhere}`
    + `a{color:#00A8FC}img{max-width:100%;height:auto}img.remail-selected{outline:2px solid #5865F2}`
    + `blockquote.gmail_quote{color:#B5BAC1}table{border-collapse:collapse}td,th{border:1px solid #4E5058}`
    + `body.remail-folded [data-remail-fold]{display:none!important}`
    // 画面の色（暗い背景・明るい文字）は入力欄の見た目だけ。送る HTML には入れない
    + `font[color="#000000"]{color:inherit}`
    + `</style></head><body></body></html>`;
}

export class ComposeEditorController {
  private iframe: HTMLIFrameElement;
  private cb: EditorCallbacks;
  private doc: Document | null = null;
  private root: HTMLElement | null = null;
  private composing = false;
  private plainPasteUntil = 0;
  private observer: MutationObserver | null = null;
  private guardQueue: Node[] = [];
  private guardScheduled = false;
  private images = new Map<string, InlineImage & { url: string }>();
  private selectedImage: HTMLImageElement | null = null;
  private folded = true;
  // たたんでいる間の引用・署名（入力欄から外して脇に持っておく。見えない部分が入力欄に残っていると、
  // ブラウザのインデントなどの操作が巻き込んで消してしまうため。純正 Gmail も同じく、開くまで入力欄に入れない）
  private held: Node[] = [];
  private destroyed = false;
  private listeners: (() => void)[] = [];

  constructor(iframe: HTMLIFrameElement, cb: EditorCallbacks) {
    this.iframe = iframe;
    this.cb = cb;
  }

  // iframe の最初の HTML を読み終わったら呼ぶ
  attach(): boolean {
    const doc = this.iframe.contentDocument;
    if (!doc || !doc.body) return false;
    this.doc = doc;
    this.root = doc.body;
    doc.designMode = "on";
    try { doc.execCommand("defaultParagraphSeparator", false, "div"); } catch { /* 古いブラウザ */ }
    try { doc.execCommand("styleWithCSS", false, "false"); } catch { /* 古いブラウザ */ }
    const on = <K extends keyof DocumentEventMap>(type: K, fn: (e: DocumentEventMap[K]) => void) => {
      doc.addEventListener(type, fn as EventListener, true);
      this.listeners.push(() => doc.removeEventListener(type, fn as EventListener, true));
    };
    on("compositionstart", () => { this.composing = true; });
    on("compositionend", () => { this.composing = false; this.afterChange(); });
    on("input", () => { if (!this.composing) this.afterChange(); else this.resize(); });
    on("keydown", (e) => this.onKeyDown(e));
    on("paste", (e) => { void this.onPaste(e); });
    on("drop", (e) => { void this.onDrop(e); });
    on("dragover", (e) => { e.preventDefault(); });
    on("selectionchange", () => this.emitState());
    on("focus", () => this.cb.onFocus());
    on("click", (e) => this.onClick(e));
    // 見張り
    this.observer = new MutationObserver((records) => this.onMutations(records));
    this.observer.observe(this.root, { childList: true, subtree: true, attributes: true });
    // スマホでキーボードが出たときに、入力の位置が隠れないようにする
    const vv = window.visualViewport;
    if (vv) {
      const onResize = () => { if (this.doc?.hasFocus()) this.iframe.scrollIntoView({ block: "nearest" }); };
      vv.addEventListener("resize", onResize);
      this.listeners.push(() => vv.removeEventListener("resize", onResize));
    }
    this.setFolded(true);
    return true;
  }

  destroy(): void {
    this.destroyed = true;
    this.observer?.disconnect();
    for (const off of this.listeners) off();
    this.listeners = [];
    for (const img of this.images.values()) URL.revokeObjectURL(img.url);
    this.images.clear();
  }

  get ready(): boolean { return !!this.root && !this.destroyed; }

  // ---- 中身 ----

  // 中身をまるごと入れ替える（下書きの読み戻し・チャットの切り替え・署名や引用の入れ替え）。html の画像は cid: で、images にその中身
  setContent(html: string, images: InlineImage[]): void {
    if (!this.doc || !this.root) return;
    for (const img of this.images.values()) URL.revokeObjectURL(img.url);
    this.images.clear();
    for (const img of images.slice(0, COMPOSE_LIMITS.maxImages)) {
      try {
        const blob = new Blob([base64ToBytes(img.data)], { type: img.mimeType });
        this.images.set(img.cid, { ...img, url: URL.createObjectURL(blob) });
      } catch { /* 壊れた画像は入れない */ }
    }
    const withBlobs = mapImageSources(html, (src) => {
      if (!src.startsWith("cid:")) return src;
      const hit = this.images.get(src.slice(4));
      return hit ? hit.url : src;
    });
    replaceContent(this.doc, this.root, withBlobs, "trusted");
    // 本文中の画像には、どの cid の画像かの印を付ける（送る・保存するときに cid: に戻す）
    for (const el of Array.from(this.root.querySelectorAll("img"))) {
      const src = el.getAttribute("src") || "";
      for (const [cid, img] of this.images) if (img.url === src) el.setAttribute("data-remail-cid", cid);
    }
    this.held = [];
    this.markFold();
    if (this.folded) this.detachFold();
    this.resize();
    this.emitState();
  }

  // 今の中身（画像は cid:）。読み取りだけなので、innerHTML を読むのは安全
  getHtml(): string {
    if (!this.root) return "";
    // 脇に持っている引用・署名は後ろに付ける（送る・保存するときに整える〔normalizeComposeHtml〕と、純正の並びになる）
    const heldHtml = this.held.map(n => (n.nodeType === 1 ? (n as Element).outerHTML : "")).join("");
    return mapImageSources(this.root.innerHTML + heldHtml, (src) => {
      if (!src.startsWith("blob:")) return src;
      for (const [cid, img] of this.images) if (img.url === src) return `cid:${cid}`;
      return null; // 対応の無い blob: は送らない
    });
  }

  // 本文から参照されている画像だけ
  getImages(): InlineImage[] {
    if (!this.root) return [];
    const imgs = [...Array.from(this.root.querySelectorAll("img")), ...this.held.flatMap(n => (n.nodeType === 1 ? [...((n as Element).tagName === "IMG" ? [n as Element] : []), ...Array.from((n as Element).querySelectorAll("img"))] : []))];
    const used = new Set(imgs.map(i => i.getAttribute("src") || ""));
    return Array.from(this.images.values()).filter(i => used.has(i.url)).map(({ url: _url, ...rest }) => rest);
  }

  isBodyEmpty(): boolean { return isComposeBodyEmpty(this.getHtml()); }

  focus(): void { this.root?.focus(); }

  // 送れないチャット（受信専用など）では編集させない
  setEditable(editable: boolean): void { if (this.doc) this.doc.designMode = editable ? "on" : "off"; }

  setFolded(folded: boolean): void {
    this.folded = folded;
    this.root?.classList.toggle("remail-folded", folded);
    if (folded) this.detachFold(); else this.attachFold();
    this.resize();
  }
  get isFolded(): boolean { return this.folded; }
  hasFoldable(): boolean { return this.held.length > 0 || !!this.root?.querySelector("[data-remail-fold]"); }

  // たたむ：印の付いた引用・署名を入力欄から外して脇に持つ
  private detachFold(): void {
    const root = this.root;
    if (!root) return;
    const marked = Array.from(root.querySelectorAll("[data-remail-fold]")).filter(el => !el.parentElement?.closest("[data-remail-fold]"));
    for (const el of marked) { el.remove(); this.held.push(el); }
  }

  // 開く：脇に持っていた引用・署名を、入力欄の最後に戻す
  private attachFold(): void {
    const root = this.root;
    if (!root || !this.held.length) return;
    for (const n of this.held) root.appendChild(n);
    this.held = [];
  }

  // 引用・署名と、その前の区切りの行に印を付ける（「…」でたたむため。送る HTML からは消える）
  private markFold(): void {
    const root = this.root;
    if (!root) return;
    for (const el of Array.from(root.querySelectorAll("[data-remail-fold]"))) el.removeAttribute("data-remail-fold");
    const mark = (n: Element | null) => n?.setAttribute("data-remail-fold", "1");
    const quote = root.querySelector(".gmail_quote_container");
    if (quote) {
      mark(quote);
      if (quote.previousElementSibling?.tagName === "BR") mark(quote.previousElementSibling);
    }
    const prefix = root.querySelector(".gmail_signature_prefix");
    if (prefix) {
      mark(prefix);
      const br = prefix.nextElementSibling;
      if (br?.tagName === "BR") { mark(br); mark(br.nextElementSibling?.classList.contains("gmail_signature") ? br.nextElementSibling : null); }
      let prev = prefix.previousElementSibling;
      for (let k = 0; k < 2 && prev && prev.tagName === "DIV" && prev.children.length === 1 && prev.firstElementChild?.tagName === "BR" && !prev.textContent?.trim(); k++) {
        mark(prev);
        prev = prev.previousElementSibling;
      }
    }
    const sig = root.querySelector(".gmail_signature");
    if (sig) mark(sig);
  }

  // ---- 書式 ----

  exec(cmd: string, value?: string): boolean {
    if (!this.doc) return false;
    this.focus();
    let ok = false;
    try { ok = this.doc.execCommand(cmd, false, value); } catch { ok = false; }
    this.afterChange();
    return ok;
  }

  setFont(face: string | null): void {
    this.exec("fontName", face ?? GMAIL_FONTS.find(f => f.label === "Sans Serif")!.face);
  }

  // 標準は size="2"（整えるときに外す）
  setSize(size: string | null): void { this.exec("fontSize", size ?? "2"); }

  setColor(hex: string): void { this.exec("foreColor", hex); }

  setBackground(hex: string): void {
    if (!this.exec("hiliteColor", hex)) this.exec("backColor", hex);
  }

  // 引用（純正の「引用」ボタンと同じ gmail_quote の形）。引用の中なら外す
  toggleQuote(): void {
    if (!this.doc || !this.root) return;
    const block = this.closest("blockquote");
    if (block && block.classList.contains("gmail_quote") && !block.closest(".gmail_quote_container")) { this.exec("outdent"); return; }
    this.exec("formatBlock", "blockquote");
    const created = this.closest("blockquote");
    if (created && !created.getAttribute("style")) {
      created.setAttribute("class", "gmail_quote");
      created.setAttribute("style", "margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex");
    }
  }

  // リンク（http・https・mailto だけ）。文字を選んでいなければ URL をそのまま文字にする
  insertLink(url: string): boolean {
    const u = url.trim();
    if (!/^(https?:\/\/[^\s]+|mailto:[^\s]+)$/i.test(u)) { this.cb.onError("リンクにできるのは http・https・mailto のアドレスだけです。"); return false; }
    if (!this.doc) return false;
    const sel = this.doc.getSelection();
    this.focus();
    if (sel && !sel.isCollapsed) return this.exec("createLink", u);
    const a = this.doc.createElement("a");
    a.setAttribute("href", u);
    a.textContent = u;
    return insertSafeHtml(this.doc, a.outerHTML, "paste");
  }

  // ---- 画像 ----

  async insertImages(files: File[]): Promise<void> {
    if (!this.doc) return;
    for (const file of files) {
      if (!IMAGE_TYPES.test(file.type)) { this.cb.onError(`本文に入れられる画像は PNG・JPEG・GIF・WebP・BMP だけです（${file.name}）。`); continue; }
      if (file.size > COMPOSE_LIMITS.maxImageBytes) { this.cb.onError(`画像が大きすぎるため入れられません（1枚10MBまで）：${file.name}`); continue; }
      if (this.getImages().length >= COMPOSE_LIMITS.maxImages) { this.cb.onError(`本文に入れられる画像は${COMPOSE_LIMITS.maxImages}枚までです。`); return; }
      const data = await fileToBase64(file);
      const url = URL.createObjectURL(file);
      const cid = makeInlineContentId(this.images.size);
      const natural = await naturalSize(url);
      this.images.set(cid, { cid, filename: file.name || "image.png", mimeType: file.type, size: file.size, data, url });
      const dims = imageDimensions(natural.width, natural.height, "best");
      const img = this.doc.createElement("img");
      img.setAttribute("src", url);
      img.setAttribute("alt", file.name || "image.png");
      if (dims) { img.setAttribute("width", String(dims.width)); img.setAttribute("height", String(dims.height)); }
      img.setAttribute("data-remail-cid", cid);
      this.focus();
      insertSafeHtml(this.doc, `<div>${img.outerHTML}<br></div>`, "trusted");
    }
    this.afterChange();
  }

  async setImageSize(mode: ImageSizeMode): Promise<void> {
    const img = this.selectedImage;
    if (!img) return;
    const natural = await naturalSize(img.getAttribute("src") || "");
    const dims = imageDimensions(natural.width, natural.height, mode);
    if (dims) { img.setAttribute("width", String(dims.width)); img.setAttribute("height", String(dims.height)); }
    else { img.removeAttribute("width"); img.removeAttribute("height"); }
    this.afterChange();
  }

  removeSelectedImage(): void {
    const img = this.selectedImage;
    if (!img) return;
    this.selectImage(null);
    img.remove();
    this.afterChange();
  }

  private selectImage(img: HTMLImageElement | null): void {
    this.selectedImage?.classList.remove("remail-selected");
    this.selectedImage = img;
    img?.classList.add("remail-selected");
    this.emitState();
  }

  // ---- イベント ----

  private onClick(e: MouseEvent): void {
    const t = e.target as Element | null;
    if (t && t.tagName === "IMG") this.selectImage(t as HTMLImageElement);
    else if (this.selectedImage) this.selectImage(null);
    // リンクを開かせない（入力欄の中で移動しない）
    if (t?.closest?.("a")) e.preventDefault();
  }

  private onKeyDown(e: KeyboardEvent): void {
    // 変換中は、ショートカットも自動の整形も動かさない（Safari は確定の直後に keyCode 229 の keydown が来る）
    if (e.isComposing || this.composing || e.keyCode === 229) return;
    if ((e.key === "Backspace" || e.key === "Delete") && this.selectedImage) { e.preventDefault(); this.removeSelectedImage(); return; }
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && !e.shiftKey && !e.altKey && (key === "b" || key === "i" || key === "u")) {
      e.preventDefault();
      this.exec(key === "b" ? "bold" : key === "i" ? "italic" : "underline");
      return;
    }
    if ((mod && e.shiftKey && key === "x") || (e.altKey && e.shiftKey && (e.code === "Digit5" || key === "5" || key === "%"))) { e.preventDefault(); this.exec("strikeThrough"); return; }
    if (mod && !e.shiftKey && key === "k") { e.preventDefault(); this.cb.onLinkRequest(); return; }
    if (mod && (key === "\\" || e.code === "Backslash" || e.code === "IntlYen" || e.code === "IntlRo")) { e.preventDefault(); this.exec("removeFormat"); this.exec("unlink"); return; }
    if (mod && e.shiftKey && key === "v") { this.plainPasteUntil = Date.now() + 1000; return; }
    if (mod && !e.shiftKey && key === "y") { e.preventDefault(); this.exec("redo"); return; }
  }

  private async onPaste(e: ClipboardEvent): Promise<void> {
    if (!this.doc) return;
    e.preventDefault();
    if (e.clipboardData) await this.pasteData(e.clipboardData);
  }

  // 貼り付けの中身を入れる（画像・HTML・文字）。HTML は必ず安全化してから入れる
  async pasteData(dt: DataTransfer): Promise<void> {
    if (!this.doc) return;
    const files = clipboardImages(dt);
    const html = dt.getData("text/html");
    const text = dt.getData("text/plain");
    const plain = Date.now() < this.plainPasteUntil;
    this.plainPasteUntil = 0;
    if (files.length && !(html && /<[a-z]/i.test(html) && text)) { await this.insertImages(files); return; }
    const incoming = plain || !html ? text : html;
    if (this.currentLength() + incoming.length > COMPOSE_LIMITS.maxHtmlChars) {
      this.cb.onError("本文が長すぎるため貼り付けられません（本文は100万文字まで）。");
      return;
    }
    if (plain || !html) { this.exec("insertText", text); return; }
    if (html.length > COMPOSE_LIMITS.maxPasteChars) {
      if (await this.cb.confirmPlainPaste()) this.exec("insertText", text);
      return;
    }
    this.focus();
    insertSafeHtml(this.doc, html, "paste");
    this.afterChange();
  }

  private async onDrop(e: DragEvent): Promise<void> {
    if (!this.doc) return;
    const dt = e.dataTransfer;
    if (!dt) return;
    e.preventDefault();
    await this.dropData(dt, e.clientX, e.clientY);
  }

  // 落とした中身を入れる（画像は本文に、そのほかのファイルは添付に。HTML は必ず安全化してから入れる）
  async dropData(dt: DataTransfer, clientX: number, clientY: number): Promise<void> {
    if (!this.doc) return;
    const e = { clientX, clientY };
    const files = Array.from(dt.files || []);
    // 落とした場所にカーソルを置く
    const anyDoc = this.doc as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null; caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null };
    const range = anyDoc.caretRangeFromPoint?.(e.clientX, e.clientY) ?? (() => { const p = anyDoc.caretPositionFromPoint?.(e.clientX, e.clientY); if (!p) return null; const r = this.doc!.createRange(); r.setStart(p.offsetNode, p.offset); return r; })();
    if (range) { const sel = this.doc.getSelection(); sel?.removeAllRanges(); sel?.addRange(range); }
    if (files.length) {
      const images = files.filter(f => IMAGE_TYPES.test(f.type));
      const others = files.filter(f => !IMAGE_TYPES.test(f.type));
      if (images.length) await this.insertImages(images);
      if (others.length) this.cb.onDropFiles(others);
      return;
    }
    const html = dt.getData("text/html");
    const text = dt.getData("text/plain");
    if (html && html.length <= COMPOSE_LIMITS.maxPasteChars && this.currentLength() + html.length <= COMPOSE_LIMITS.maxHtmlChars) { this.focus(); insertSafeHtml(this.doc, html, "paste"); }
    else if (text && this.currentLength() + text.length <= COMPOSE_LIMITS.maxHtmlChars) this.exec("insertText", text);
    else this.cb.onError("本文が長すぎるため入れられません（本文は100万文字まで）。");
    this.afterChange();
  }

  private currentLength(): number {
    // 画像（blob: の URL）は数えない
    return (this.root?.innerHTML.length || 0);
  }

  // ---- 見張り ----

  private onMutations(records: MutationRecord[]): void {
    for (const r of records) {
      if (r.type === "childList") r.addedNodes.forEach(n => this.guardQueue.push(n));
      else if (r.type === "attributes" && r.target.nodeType === 1) this.guardQueue.push(r.target);
    }
    this.runGuard();
  }

  private runGuard(): void {
    let budget = GUARD_BUDGET;
    let removed = 0;
    while (this.guardQueue.length && budget > 0) {
      const node = this.guardQueue.pop()!;
      if (node.nodeType !== 1 || !node.isConnected) continue;
      const stack: Element[] = [node as Element];
      while (stack.length && budget > 0) {
        const el = stack.pop()!;
        budget--;
        const tag = el.tagName.toLowerCase();
        // <style> は引用・下書きのものは残すが、外部の CSS を読む @import や式を含むものは取り除く（安全化と同じ決まり）
        const badStyle = tag === "style" && /@import|expression\(|javascript:|-moz-binding|behavior\s*:/i.test(el.textContent || "");
        if (badStyle || isDangerousElement(tag) || tag === "form" || tag === "foreignobject" || el.namespaceURI !== "http://www.w3.org/1999/xhtml") {
          if (tag === "form") { while (el.firstChild) el.parentNode?.insertBefore(el.firstChild, el); }
          el.remove();
          removed++;
          continue;
        }
        for (const attr of Array.from(el.attributes)) {
          if (attr.name === "data-remail-cid" || attr.name === "data-remail-fold") continue;
          if (attr.name === "src" && tag === "img" && attr.value.startsWith("blob:")) continue;
          if (isDangerousAttribute(tag, attr.name, attr.value, "trusted")) { el.removeAttribute(attr.name); removed++; }
        }
        for (let c = el.lastElementChild; c; c = c.previousElementSibling) stack.push(c);
      }
      // 調べきれなかった分は次に回す
      if (stack.length) this.guardQueue.push(...stack);
    }
    if (removed > 0) logWarn("compose.guard", { count: removed });
    if (this.guardQueue.length && !this.guardScheduled) {
      this.guardScheduled = true;
      setTimeout(() => { this.guardScheduled = false; this.runGuard(); }, 0);
    }
  }

  // ---- 状態 ----

  private afterChange(): void {
    this.resize();
    this.keepCaretVisible();
    this.emitState();
    this.cb.onChange();
  }

  // 高さを中身に合わせる（上限は画面の約40%・13rem。超えたら中をスクロール）
  resize(): void {
    if (!this.root) return;
    const max = Math.min(window.innerHeight * 0.4, 13 * 16);
    const h = Math.max(32, Math.ceil(this.root.getBoundingClientRect().height));
    this.iframe.style.height = `${Math.min(h, max)}px`;
  }

  private keepCaretVisible(): void {
    const doc = this.doc;
    if (!doc) return;
    const rect = caretRect(doc);
    if (!rect) return;
    const se = doc.scrollingElement;
    if (!se) return;
    const vh = this.iframe.clientHeight;
    if (rect.bottom > vh) se.scrollTop += rect.bottom - vh + 4;
    else if (rect.top < 0) se.scrollTop += rect.top - 4;
  }

  private closest(tag: string): HTMLElement | null {
    const sel = this.doc?.getSelection();
    let n: Node | null = sel?.anchorNode ?? null;
    while (n && n !== this.root) {
      if (n.nodeType === 1 && (n as Element).tagName.toLowerCase() === tag) return n as HTMLElement;
      n = n.parentNode;
    }
    return null;
  }

  private emitState(): void {
    const doc = this.doc;
    if (!doc || this.composing) return;
    const q = (c: string) => { try { return doc.queryCommandState(c); } catch { return false; } };
    const v = (c: string) => { try { return String(doc.queryCommandValue(c) || ""); } catch { return ""; } };
    const sel = doc.getSelection();
    const inEditor = !!sel && sel.rangeCount > 0 && !!this.root?.contains(sel.anchorNode);
    const frameRect = this.iframe.getBoundingClientRect();
    let rect: EditorFormatState["rect"] = null;
    if (this.selectedImage) {
      const r = this.selectedImage.getBoundingClientRect();
      rect = { left: frameRect.left + r.left, top: frameRect.top + r.top, bottom: frameRect.top + r.bottom, width: r.width };
    } else if (inEditor && sel && !sel.isCollapsed) {
      const r = sel.getRangeAt(0).getBoundingClientRect();
      rect = { left: frameRect.left + r.left, top: frameRect.top + r.top, bottom: frameRect.top + r.bottom, width: r.width };
    }
    const link = this.closest("a");
    const align = q("justifyCenter") ? "center" : q("justifyRight") ? "right" : "left";
    const sizeVal = v("fontSize");
    this.cb.onFormatState({
      bold: q("bold"), italic: q("italic"), underline: q("underline"), strike: q("strikeThrough"),
      ol: q("insertOrderedList"), ul: q("insertUnorderedList"), align,
      face: v("fontName").replace(/["']/g, "").toLowerCase() || null,
      size: sizeVal && sizeVal !== "2" ? sizeVal : null,
      link: link?.getAttribute("href") ?? null,
      hasSelection: inEditor && !!sel && !sel.isCollapsed,
      rect,
      image: this.selectedImage ? { cid: this.selectedImage.getAttribute("data-remail-cid"), width: this.selectedImage.getAttribute("width") } : null,
    });
  }
}

// クリップボードの画像（Firefox は files ではなく items にだけ入れることがある）
function clipboardImages(dt: DataTransfer): File[] {
  const files = Array.from(dt.files || []).filter(f => IMAGE_TYPES.test(f.type));
  if (files.length) return files;
  const out: File[] = [];
  for (const item of Array.from(dt.items || [])) {
    if (item.kind === "file" && IMAGE_TYPES.test(item.type)) { const f = item.getAsFile(); if (f) out.push(f); }
  }
  return out;
}

// カーソルの位置。空の行では範囲の大きさが無いので、その行の要素の位置を使う
export function caretRect(doc: Document): DOMRect | null {
  const sel = doc.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const r = range.getClientRects()[0];
  if (r) return r;
  let n: Node | null = sel.focusNode;
  if (n && n.nodeType !== 1) n = n.parentNode;
  return n && n.nodeType === 1 ? (n as Element).getBoundingClientRect() : null;
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64.replace(/[^A-Za-z0-9+/=]/g, ""));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => { const s = String(reader.result || ""); resolve(s.slice(s.indexOf(",") + 1)); };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function naturalSize(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = url;
  });
}
