// 書式付きの入力欄の HTML を、安全にし（危ない要素・属性・URL を取り除く）、純正 Gmail の作成画面が作るのと同じ形に整え、
// テキスト版を作る。形はすべて、純正 Gmail から実際に送ったメールのソース（__fixtures__/gmailCompose.json）に合わせてある。
//
// 入力欄の HTML（下書き・引用・貼り付け・ドロップ）は、相手が送ってきたメールを含むので信頼しない（絶対ルール1）。
// 入力欄の iframe に外から HTML を入れるときは、必ずこのファイルの関数（insertSafeHtml / safeFragment）を通す。
// ほかのファイルで innerHTML・insertAdjacentHTML・execCommand("insertHTML") を使わない（ESLint で止めている）
import {
  parseHtml, serializeHtml, getAttr, setAttr, removeAttr, hasClass, textContent, escapeText,
  type HtmlNode, type HtmlElement,
} from "./htmlTree";
import { escapeHtml } from "./replyCompose";

// 上限（絶対ルール3）。超えたら入れない・打ち切る
export const COMPOSE_LIMITS = {
  maxHtmlChars: 1_000_000, // 本文の HTML（画像を除く）
  maxPasteChars: 500_000, // 1回の貼り付け
  maxDepth: 100, // 入れ子の深さ。超えた部分は文字だけにする
  maxImageBytes: 10 * 1024 * 1024, // 本文中の画像1枚
  maxImages: 20, // 本文中の画像の枚数
} as const;

// 純正 Gmail（日本語）のフォントの候補。face は純正が送る HTML の値
export const GMAIL_FONTS: { label: string; face: string }[] = [
  { label: "Ｐゴシック", face: "ms pgothic, sans-serif" },
  { label: "Ｐ明朝", face: "ms pmincho, sans-serif" },
  { label: "ゴシック", face: "ms gothic, monospace" },
  { label: "Sans Serif", face: "arial, sans-serif" },
  { label: "Serif", face: "times new roman, serif" },
  { label: "固定幅", face: "monospace" },
  { label: "幅広", face: "arial black, sans-serif" },
  { label: "幅狭", face: "arial narrow, sans-serif" },
  { label: "Comic Sans MS", face: "comic sans ms, sans-serif" },
  { label: "Garamond", face: "garamond, times new roman, serif" },
  { label: "Georgia", face: "georgia, serif" },
  { label: "Tahoma", face: "tahoma, sans-serif" },
  { label: "Trebuchet MS", face: "trebuchet ms, sans-serif" },
  { label: "Verdana", face: "verdana, sans-serif" },
];
// 文字の大きさ（標準は何も付けない）
export const GMAIL_SIZES: { label: string; size: string | null }[] = [
  { label: "小", size: "1" }, { label: "標準", size: null }, { label: "大", size: "4" }, { label: "最大", size: "6" },
];
// 色の一覧（純正の作成画面と同じ 64 色。文字の色・背景の色で共通）
export const GMAIL_COLORS: string[] = [
  "#000000", "#444444", "#666666", "#999999", "#cccccc", "#eeeeee", "#f3f3f3", "#ffffff",
  "#ff0000", "#ff9900", "#ffff00", "#00ff00", "#00ffff", "#0000ff", "#9900ff", "#ff00ff",
  "#f4cccc", "#fce5cd", "#fff2cc", "#d9ead3", "#d0e0e3", "#cfe2f3", "#d9d2e9", "#ead1dc",
  "#ea9999", "#f9cb9c", "#ffe599", "#b6d7a8", "#a2c4c9", "#9fc5e8", "#b4a7d6", "#d5a6bd",
  "#e06666", "#f6b26b", "#ffd966", "#93c47d", "#76a5af", "#6fa8dc", "#8e7cc3", "#c27ba0",
  "#cc0000", "#e69138", "#f1c232", "#6aa84f", "#45818e", "#3d85c6", "#674ea7", "#a64d79",
  "#990000", "#b45f06", "#bf9000", "#38761d", "#134f5c", "#0b5394", "#351c75", "#741b47",
  "#660000", "#783f04", "#7f6000", "#274e13", "#0c343d", "#073763", "#20124d", "#4c1130",
];

// 純正が作る形
export const INDENT_STYLE = "margin:0 0 0 40px;border:none;padding:0px";
export const QUOTE_STYLE = "margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex";
const SIGNATURE_PREFIX = '<span class="gmail_signature_prefix">-- </span><br>';

// 本文中の画像の大きさ。純正の作成画面の「最適」は幅 558px まで、「小」はその 0.4 倍、「元のサイズ」は width/height を付けない
export const IMAGE_BEST_FIT_WIDTH = 558;
export type ImageSizeMode = "small" | "best" | "original";
export function imageDimensions(naturalWidth: number, naturalHeight: number, mode: ImageSizeMode): { width: number; height: number } | null {
  if (mode === "original" || !(naturalWidth > 0) || !(naturalHeight > 0)) return null;
  const bestW = Math.min(naturalWidth, IMAGE_BEST_FIT_WIDTH);
  const bestH = Math.round((naturalHeight * bestW) / naturalWidth);
  if (mode === "best") return { width: bestW, height: bestH };
  return { width: Math.floor(bestW * 0.4), height: Math.floor(bestH * 0.4) };
}

// 本文中の画像の Content-ID（純正と同じ「ii_<8文字><番号>」）
export function makeInlineContentId(index: number, now: number = Date.now(), random: () => number = Math.random): string {
  const head = now.toString(36).slice(-4).padStart(4, "0");
  let tail = "";
  for (let i = 0; i < 4; i++) tail += Math.floor(random() * 36).toString(36);
  return `ii_${head}${tail}${index}`;
}

// ---------------------------------------------------------------------------
// 安全化
// ---------------------------------------------------------------------------

export type SanitizeMode = "paste" | "trusted";

// 中身ごと取り除く要素（スクリプト・外部の読み込み・フォーム部品・数式・画像のベクター）
const DROP_WITH_CONTENT = new Set([
  "script", "iframe", "frame", "frameset", "object", "embed", "applet", "param", "noscript", "noembed", "noframes",
  "template", "title", "xmp", "plaintext", "svg", "math", "select", "textarea", "button", "input", "option", "optgroup",
  "datalist", "meta", "link", "base", "head", "audio", "video", "source", "track", "canvas", "portal", "slot",
]);
// 要素だけ外して中身は残す
const UNWRAP = new Set(["html", "body", "form", "label", "fieldset", "legend", "main", "picture", "output"]);
// 危ない URL の属性
const URL_ATTRS = new Set(["href", "src", "cite", "action", "formaction", "background", "poster", "longdesc", "usemap", "lowsrc", "dynsrc", "xlink:href", "data", "codebase", "manifest", "icon", "profile"]);

function normalizeUrl(value: string): string {
  // 制御文字・空白を除いて小文字にする（「java\tscript:」「 JAVASCRIPT:」を見抜く）
  let out = "";
  for (const c of value) { const code = c.charCodeAt(0); if (code > 0x20 && code !== 0x7f) out += c; }
  return out.toLowerCase();
}

function urlScheme(value: string): string {
  const v = normalizeUrl(value);
  const colon = v.indexOf(":");
  if (colon < 0) return "";
  const head = v.slice(0, colon);
  return /^[a-z][a-z0-9+.-]*$/.test(head) && v.indexOf("/") !== 0 && (v.indexOf("/") < 0 || v.indexOf("/") > colon) ? head : "";
}

const SAFE_IMAGE_DATA = /^data:image\/(png|jpeg|jpg|gif|webp|bmp);/;

// 属性の URL として安全か
export function isSafeUrl(tag: string, attr: string, value: string, mode: SanitizeMode): boolean {
  const scheme = urlScheme(value);
  if (scheme === "javascript" || scheme === "vbscript" || scheme === "livescript" || scheme === "mocha") return false;
  if (scheme === "data") return tag === "img" && attr === "src" && SAFE_IMAGE_DATA.test(normalizeUrl(value));
  if (tag === "img" && attr === "src") return scheme === "" || ["http", "https", "cid", "blob"].includes(scheme);
  if (attr === "href") {
    if (mode === "paste") return ["http", "https", "mailto"].includes(scheme);
    return scheme === "" || ["http", "https", "mailto", "tel", "cid"].includes(scheme);
  }
  // そのほかの URL の属性（cite・background など）は使わないので外す
  return false;
}

// style 属性を宣言の並びにする（括弧・引用符の中の ; では切らない）
export function parseStyle(style: string): [string, string][] {
  const out: [string, string][] = [];
  let depth = 0;
  let quote = "";
  let cur = "";
  const push = () => {
    const colon = cur.indexOf(":");
    if (colon > 0) {
      const prop = cur.slice(0, colon).trim().toLowerCase();
      const value = cur.slice(colon + 1).trim();
      if (prop && value && /^-?[a-z][a-z0-9-]*$/.test(prop)) out.push([prop, value]);
    }
    cur = "";
  };
  for (const c of style.slice(0, 20_000)) {
    if (quote) { if (c === quote) quote = ""; cur += c; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === "(") depth++;
    if (c === ")") depth = Math.max(0, depth - 1);
    if (c === ";" && depth === 0) { push(); continue; }
    cur += c;
  }
  push();
  return out;
}

// 色を純正と同じ書き方にする：style の中では rgb(r,g,b)（空白なし）
export function normalizeCssColor(v: string): string {
  const s = v.trim().toLowerCase();
  const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split("").map(c => c + c).join("") : hex[1];
    return `rgb(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)})`;
  }
  return s.replace(/\s*,\s*/g, ",").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")");
}

// <font color> に入れる形（#rrggbb）
export function cssColorToHex(v: string): string | null {
  const s = normalizeCssColor(v);
  const rgb = s.match(/^rgba?\((\d{1,3}),(\d{1,3}),(\d{1,3})(?:,([\d.]+))?\)$/);
  if (rgb) {
    if (rgb[4] !== undefined && Number(rgb[4]) === 0) return null;
    return "#" + [rgb[1], rgb[2], rgb[3]].map(n => Math.min(255, Number(n)).toString(16).padStart(2, "0")).join("");
  }
  const named: Record<string, string> = { black: "#000000", white: "#ffffff", red: "#ff0000", blue: "#0000ff", green: "#008000", yellow: "#ffff00", gray: "#808080", grey: "#808080" };
  return named[s] || null;
}

// 宣言の値に危ないものが入っていないか（スクリプト・古い IE の式・外部の読み込み）
function isSafeCssValue(value: string, mode: SanitizeMode): boolean {
  const v = normalizeUrl(value);
  if (v.includes("expression(") || v.includes("javascript:") || v.includes("vbscript:") || v.includes("behavior:") || v.includes("-moz-binding") || v.includes("@import")) return false;
  if (v.includes("url(")) {
    // 貼り付けでは外部の画像を持ち込まない。引用・下書きは元のまま残す（入力欄の CSP が読み込みを止める）
    if (mode === "paste") return /url\((['"]?)(data:image\/(png|jpeg|gif|webp);|cid:)/.test(v);
  }
  return true;
}

export function serializeStyle(decls: [string, string][]): string {
  return decls.map(([p, v]) => `${p}:${v}`).join(";");
}

// 属性名として正しい形か
const isValidAttrName = (name: string) => /^[a-z_:][a-z0-9_:.-]*$/.test(name) && name.length <= 64;

// 危ない属性か（安全化と見張り〔composeEditor の MutationObserver〕で同じ決まりを使う）
export function isDangerousAttribute(tag: string, name: string, value: string, mode: SanitizeMode = "trusted"): boolean {
  const n = name.toLowerCase();
  if (!isValidAttrName(n)) return true;
  if (n.startsWith("on") || n === "srcdoc" || n === "formaction" || n === "action" || n === "is" || n.startsWith("xmlns") || n === "ping") return true;
  if (URL_ATTRS.has(n) && !isSafeUrl(tag, n, value, mode)) return true;
  if (n === "srcset") return true; // 画像の候補を外部から読ませない
  // style は属性ごとは落とさず、安全化で宣言ごとに落とす（cleanStyle）
  return false;
}

export function isDangerousElement(name: string): boolean {
  return DROP_WITH_CONTENT.has(name) || name.includes(":") && /^(svg|math|xlink|html):/.test(name);
}

function cleanStyle(value: string, mode: SanitizeMode): string {
  return serializeStyle(parseStyle(value).filter(([, v]) => isSafeCssValue(v, mode)));
}

// 木を安全にする（新しい木を返す）。trusted は引用・下書き・署名（書式は残し、危ないものだけ取る）、
// paste は貼り付け・ドロップ（さらに §2 の書式に当たるものだけ残す）
export function sanitizeNodes(nodes: HtmlNode[], mode: SanitizeMode): HtmlNode[] {
  const out: HtmlNode[] = [];
  for (const node of nodes) {
    if (node.type === "text") { out.push({ type: "text", value: node.value }); continue; }
    const name = node.name;
    if (isDangerousElement(name)) continue;
    if (name === "style") {
      // 貼り付けでは外す。引用・下書きでは残すが、外部の読み込みや式は消す（中身ごと）
      if (mode === "paste") continue;
      const css = textContent(node.children);
      const v = normalizeUrl(css);
      if (v.includes("@import") || v.includes("expression(") || v.includes("javascript:") || v.includes("-moz-binding") || v.includes("behavior:")) continue;
      out.push({ type: "el", name: "style", attrs: [], children: [{ type: "text", value: css }] });
      continue;
    }
    const children = sanitizeNodes(node.children, mode);
    if (UNWRAP.has(name) || name.includes(":") || name.includes("-")) { out.push(...children); continue; }
    const attrs: [string, string][] = [];
    for (const [k, v] of node.attrs) {
      if (isDangerousAttribute(name, k, v, mode)) continue;
      if (k === "style") { const s = cleanStyle(v, mode); if (s) attrs.push([k, s]); continue; }
      if (k === "target") continue; // 入力欄の中でリンクを開かせない
      attrs.push([k, v]);
    }
    if (name === "img" && !attrs.some(([k]) => k === "src")) continue;
    out.push({ type: "el", name, attrs, children });
  }
  return mode === "paste" ? reduceToGmailFormatting(out) : out;
}

// ---------------------------------------------------------------------------
// 貼り付けの書式を、純正の作成画面にある書式だけに減らす（ほかのページのクラス・巨大なフォント・固定の幅を持ち込まない）
// ---------------------------------------------------------------------------

const TABLE_TAGS = new Set(["table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col"]);
const TABLE_ATTRS = new Set(["border", "cellpadding", "cellspacing", "width", "height", "align", "valign", "bgcolor", "colspan", "rowspan", "span", "style"]);
const TABLE_STYLE_PROPS = /^(border(-[a-z-]+)?|padding(-[a-z]+)?|background(-color)?|color|text-align|vertical-align|width|height|min-width|max-width|font-weight|font-style|white-space|border-collapse|border-spacing)$/;
const BLOCK_TO_DIV = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "header", "footer", "aside", "nav", "address", "center", "figure", "figcaption", "dl", "dt", "dd", "pre", "details", "summary"]);

function fontFaceFromCss(family: string): string | null {
  const f = family.toLowerCase().replace(/["']/g, "");
  for (const g of GMAIL_FONTS) if (f.startsWith(g.face.split(",")[0])) return g.face;
  if (/(^|,)\s*(courier|monospace|consolas|menlo)/.test(f)) return "monospace";
  return null;
}

function wrapEl(name: string, attrs: [string, string][], children: HtmlNode[]): HtmlElement {
  return { type: "el", name, attrs, children };
}

// インラインの style（太字・斜体・下線・取り消し線・色・背景・フォント）を純正のタグに置き換える
function styleToTags(style: string, children: HtmlNode[], keepFontFace: boolean): HtmlNode[] {
  let inner = children;
  let fontAttrs: [string, string][] = [];
  let background: string | null = null;
  for (const [p, v] of parseStyle(style)) {
    const val = v.toLowerCase();
    if (p === "font-weight" && (val === "bold" || val === "bolder" || Number(val) >= 600)) inner = [wrapEl("b", [], inner)];
    else if (p === "font-style" && val === "italic") inner = [wrapEl("i", [], inner)];
    else if (p === "text-decoration" || p === "text-decoration-line") {
      if (val.includes("underline")) inner = [wrapEl("u", [], inner)];
      if (val.includes("line-through")) inner = [wrapEl("strike", [], inner)];
    } else if (p === "color") { const hex = cssColorToHex(v); if (hex && hex !== "#000000") fontAttrs.push(["color", hex]); }
    else if (p === "background-color" || p === "background") { const hex = cssColorToHex(v); if (hex && hex !== "#ffffff") background = normalizeCssColor(hex); }
    else if (p === "font-family" && keepFontFace) { const face = fontFaceFromCss(v); if (face) fontAttrs.push(["face", face]); }
  }
  fontAttrs = fontAttrs.filter((a, i, all) => all.findIndex(b => b[0] === a[0]) === i);
  if (fontAttrs.length) inner = [wrapEl("font", fontAttrs, inner)];
  if (background) inner = [wrapEl("span", [["style", `background-color:${background}`]], inner)];
  return inner;
}

function reduceToGmailFormatting(nodes: HtmlNode[]): HtmlNode[] {
  const out: HtmlNode[] = [];
  for (const node of nodes) {
    if (node.type === "text") { out.push(node); continue; }
    const name = node.name;
    const children = reduceToGmailFormatting(node.children);
    const style = getAttr(node, "style") || "";
    if (TABLE_TAGS.has(name)) {
      const attrs: [string, string][] = [];
      for (const [k, v] of node.attrs) {
        if (!TABLE_ATTRS.has(k)) continue;
        if (k === "style") {
          const s = serializeStyle(parseStyle(v).filter(([p]) => TABLE_STYLE_PROPS.test(p)).map(([p, val]) => [p, /color|background|border/.test(p) ? val.replace(/#[0-9a-fA-F]{3,6}\b|rgba?\([^)]*\)/g, c => normalizeCssColor(c)) : val]));
          if (s) attrs.push(["style", s]);
        } else attrs.push([k, v]);
      }
      out.push(wrapEl(name, attrs, children));
      continue;
    }
    switch (name) {
      case "b": case "strong": out.push(wrapEl("b", [], children)); break;
      case "i": case "em": case "cite": case "var": out.push(wrapEl("i", [], children)); break;
      case "u": case "ins": out.push(wrapEl("u", [], children)); break;
      case "s": case "strike": case "del": out.push(wrapEl("strike", [], children)); break;
      case "br": out.push(wrapEl("br", [], [])); break;
      case "a": {
        const href = getAttr(node, "href");
        out.push(href ? wrapEl("a", [["href", href]], children) : wrapEl("span", [], children));
        break;
      }
      case "img": {
        const attrs: [string, string][] = [];
        for (const k of ["src", "alt", "width", "height"]) { const v = getAttr(node, k); if (v !== undefined) attrs.push([k, v]); }
        out.push(wrapEl("img", attrs, []));
        break;
      }
      case "font": {
        const attrs: [string, string][] = [];
        const face = getAttr(node, "face"); const color = getAttr(node, "color"); const size = getAttr(node, "size");
        if (face && GMAIL_FONTS.some(f => f.face === face.toLowerCase())) attrs.push(["face", face.toLowerCase()]);
        if (size && ["1", "4", "6"].includes(size)) attrs.push(["size", size]);
        if (color) { const hex = cssColorToHex(color); if (hex) attrs.push(["color", hex]); }
        out.push(...(attrs.length ? [wrapEl("font", attrs, children)] : children));
        break;
      }
      case "ol": case "ul": out.push(wrapEl(name, [], children.filter(c => c.type === "el" || c.value.trim()))); break;
      case "li": out.push(wrapEl("li", [], children)); break;
      case "blockquote": out.push(wrapEl("blockquote", [["style", INDENT_STYLE]], children)); break;
      case "span": out.push(...styleToTags(style, children, true)); break;
      default: {
        if (BLOCK_TO_DIV.has(name)) {
          const align = parseStyle(style).find(([p]) => p === "text-align")?.[1].toLowerCase();
          const attrs: [string, string][] = align && ["center", "right", "left"].includes(align) ? [["style", `text-align:${align}`]] : [];
          out.push(wrapEl("div", attrs, styleToTags(style, children, true)));
        } else out.push(...children);
      }
    }
  }
  return out;
}

// HTML の文字列を安全にする
export function sanitizeHtml(html: string, mode: SanitizeMode): string {
  return serializeHtml(sanitizeNodes(parseHtml(html, { maxDepth: COMPOSE_LIMITS.maxDepth }), mode));
}

// ---------------------------------------------------------------------------
// 純正の形に整える
// ---------------------------------------------------------------------------

export type ComposeKind = "new" | "reply";

const isEl = (n: HtmlNode | undefined, name?: string): n is HtmlElement => !!n && n.type === "el" && (!name || n.name === name);
const isBlankText = (n: HtmlNode) => n.type === "text" && !n.value.replace(/[\s ]/g, "");
const isEmptyLineDiv = (n: HtmlNode | undefined): n is HtmlElement => isEl(n, "div") && n.attrs.length === 0 && n.children.filter(c => !isBlankText(c)).length === 1 && isEl(n.children.find(c => !isBlankText(c)), "br");
const isBrClearAll = (n: HtmlNode | undefined) => isEl(n, "div") && n.children.filter(c => !isBlankText(c)).length === 1 && isEl(n.children.find(c => !isBlankText(c)), "br") && getAttr(n.children.find(c => !isBlankText(c)) as HtmlElement, "clear") === "all";
const INLINE = new Set(["b", "i", "u", "strike", "font", "span", "a", "img", "br", "sub", "sup", "small", "big", "code", "tt", "kbd", "mark", "abbr", "q", "wbr", "s", "em", "strong"]);
const isInline = (n: HtmlNode) => n.type === "text" || INLINE.has(n.name);

export type ComposeParts = {
  body: HtmlNode[]; // 本文（行の並び）
  quote: HtmlElement | null; // 引用（gmail_quote）
  signature: HtmlNode[] | null; // 署名の中身（gmail_signature の子）
};

// ブラウザごとに違うタグ・書き方を、純正の書き方にそろえる（本文の部分だけ。引用・署名の中は触らない）
function canonicalizeBody(nodes: HtmlNode[]): HtmlNode[] {
  const out: HtmlNode[] = [];
  for (const node of nodes) {
    if (node.type === "text") { out.push(node); continue; }
    // 返信の引用（元のメール）と署名の中は触らない。本文の中の引用（引用のボタンで作ったもの）は本文と同じに整える
    if (hasClass(node, "gmail_quote_container") || hasClass(node, "gmail_signature") || (node.name === "div" && hasClass(node, "gmail_quote") && node.children.some(c => isEl(c) && hasClass(c, "gmail_attr")))) { out.push(node); continue; }
    let children = canonicalizeBody(node.children);
    // Chrome のインデントなどで外側の <div dir="ltr"> が割れたり中に入り込んだりしたものは、外して中身だけにする（純正の行には dir が無い）
    if (node.name === "div" && node.attrs.length === 1 && node.attrs[0][0] === "dir" && node.attrs[0][1] === "ltr" && children.some(c => c.type === "el" && !INLINE.has(c.name))) {
      out.push(...children);
      continue;
    }
    const attrs = node.attrs.filter(([k]) => !k.startsWith("data-remail") && k !== "contenteditable" && k !== "spellcheck");
    const el: HtmlElement = { type: "el", name: node.name, attrs, children };
    switch (node.name) {
      case "strong": el.name = "b"; break;
      case "em": el.name = "i"; break;
      case "s": case "del": el.name = "strike"; break;
      case "p": el.name = "div"; break;
    }
    // Firefox は配置を align 属性で付けるので、純正と同じ style にする
    const alignAttr = el.name === "div" ? getAttr(el, "align")?.toLowerCase() : undefined;
    if (alignAttr !== undefined) {
      removeAttr(el, "align");
      if (["center", "right", "left", "justify"].includes(alignAttr) && getAttr(el, "style") === undefined) setAttr(el, "style", `text-align:${alignAttr}`);
    }
    const style = getAttr(el, "style");
    if (style !== undefined) {
      const decls = parseStyle(style);
      if (el.name === "span" && !getAttr(el, "class")) {
        // span の style（Safari などが付ける）を純正のタグにする。背景の色だけは span のまま
        const bg = decls.find(([p]) => p === "background-color");
        const rest = serializeStyle(decls.filter(([p]) => p !== "background-color"));
        let inner: HtmlNode[] = rest ? styleToTags(rest, children, true) : children;
        if (bg) inner = [wrapEl("span", [["style", `background-color:${normalizeCssColor(bg[1])}`]], inner)];
        out.push(...inner);
        continue;
      }
      if (el.name === "blockquote" && !hasClass(el, "gmail_quote")) setAttr(el, "style", INDENT_STYLE);
      else if (el.name === "div") {
        const align = decls.find(([p]) => p === "text-align")?.[1].toLowerCase();
        if (align && ["center", "right", "left", "justify"].includes(align)) setAttr(el, "style", `text-align:${align}`);
        else removeAttr(el, "style");
      } else setAttr(el, "style", serializeStyle(decls.map(([p, v]) => [p, /color|background/.test(p) ? normalizeCssColor(v) : v])));
    }
    if (el.name === "blockquote" && !hasClass(el, "gmail_quote") && style === undefined) setAttr(el, "style", INDENT_STYLE);
    if (el.name === "font") {
      const color = getAttr(el, "color");
      if (color) { const hex = cssColorToHex(color); if (hex) setAttr(el, "color", hex); }
      // 「標準」の大きさ（size="2"）は純正は付けない
      if (getAttr(el, "size") === "2") removeAttr(el, "size");
      if (el.attrs.length === 0) { out.push(...el.children); continue; }
    }
    // 中身の無い行は <div><br></div>（純正と同じ）
    if (el.name === "div" && children.every(isBlankText)) children = el.children = [{ type: "el", name: "br", attrs: [], children: [] }];
    // 文字の後ろの <br> は行の終わりの印なので消す（画像の後ろの <br> は純正も残す。WebKit はリストの項目にも付ける）
    if ((el.name === "div" || el.name === "li") && children.length > 1) {
      const last = children[children.length - 1];
      const prev = children[children.length - 2];
      const tagOf = (x: HtmlNode) => (x.type === "el" ? x.name : "#text");
      const prevTag = tagOf(prev);
      if (tagOf(last) === "br" && prevTag !== "img" && prevTag !== "br" && (prevTag === "#text" || INLINE.has(prevTag))) el.children = children.slice(0, -1);
    }
    out.push(el);
  }
  return out;
}

// 入力欄の中身を、本文・引用・署名に分ける。区切りの行（引用の前の <br>、署名の前の空行2つ）は捨てる
export function splitCompose(nodes: HtmlNode[]): ComposeParts {
  let quote: HtmlElement | null = null;
  let signature: HtmlNode[] | null = null;
  const strip = (list: HtmlNode[]): HtmlNode[] => {
    const out: HtmlNode[] = [];
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      if (n.type === "el") {
        if (!quote && (hasClass(n, "gmail_quote_container") || (n.name === "div" && hasClass(n, "gmail_quote") && n.children.some(c => isEl(c) && hasClass(c, "gmail_attr"))))) {
          quote = n;
          // 引用の前の <br> は区切り
          while (out.length && (isBlankText(out[out.length - 1]))) out.pop();
          if (isEl(out[out.length - 1], "br")) out.pop();
          continue;
        }
        if (hasClass(n, "gmail_signature_prefix")) {
          // 「-- 」の前の空行2つ（新しいメール）か「<br clear="all">の行＋空行」（返信）は区切り
          while (out.length && isBlankText(out[out.length - 1])) out.pop();
          for (let k = 0; k < 2; k++) {
            const last = out[out.length - 1];
            if (isEmptyLineDiv(last) || isBrClearAll(last)) out.pop(); else break;
          }
          // 「-- 」の後ろの <br> と署名
          let j = i + 1;
          while (j < list.length && isBlankText(list[j])) j++;
          if (isEl(list[j], "br")) j++;
          while (j < list.length && isBlankText(list[j])) j++;
          if (isEl(list[j]) && hasClass(list[j] as HtmlElement, "gmail_signature")) { signature = (list[j] as HtmlElement).children; i = j; }
          else i = j - 1;
          if (signature === null) signature = [];
          continue;
        }
        if (hasClass(n, "gmail_signature")) { signature = n.children; continue; }
        if (!quote || !signature) {
          const children = strip(n.children);
          out.push({ ...n, children });
          continue;
        }
      }
      out.push(n);
    }
    return out;
  };
  let body = strip(nodes);
  // 外側の <div dir="ltr">（純正が全体を包むもの）は外す。中身が1つでも残ったら行として扱う
  while (body.filter(n => !isBlankText(n)).length === 1 && isEl(body.find(n => !isBlankText(n)), "div") && getAttr(body.find(n => !isBlankText(n)) as HtmlElement, "dir") === "ltr" && !getAttr(body.find(n => !isBlankText(n)) as HtmlElement, "class")) {
    body = (body.find(n => !isBlankText(n)) as HtmlElement).children;
  }
  return { body, quote, signature };
}

// 本文の行を整える：先頭や間に裸で置かれた文字は行（<div>）に入れる。最後の空の行の並びはそのまま残す
function toLines(body: HtmlNode[], kind: ComposeKind): HtmlNode[] {
  const lines: HtmlNode[] = [];
  let run: HtmlNode[] = [];
  const flush = () => {
    // <br> で区切られた裸の文字は1行ずつ
    let cur: HtmlNode[] = [];
    const pushLine = () => {
      const meaningful = cur.filter(n => !isBlankText(n));
      lines.push(wrapEl("div", [], meaningful.length ? trimLine(cur) : [wrapEl("br", [], [])]));
      cur = [];
    };
    if (run.every(isBlankText)) { run = []; return; }
    for (const n of run) {
      if (isEl(n, "br")) pushLine();
      else cur.push(n);
    }
    if (cur.some(n => !isBlankText(n))) pushLine();
    run = [];
  };
  for (const n of body) {
    if (isInline(n)) run.push(n);
    else { flush(); lines.push(n); }
  }
  flush();
  if (lines.length === 0) lines.push(wrapEl("div", [], [wrapEl("br", [], [])]));
  // 返信は、純正と同じく1行目を <div dir="ltr"> の直下に置く
  if (kind === "reply") {
    const first = lines[0];
    const emptyFirst = isEmptyLineDiv(first as HtmlNode | undefined);
    if (!emptyFirst && isEl(first, "div") && first.attrs.length === 0 && first.children.every(isInline)) return [...first.children, ...lines.slice(1)];
  }
  return lines;
}

function trimLine(nodes: HtmlNode[]): HtmlNode[] {
  const out = [...nodes];
  while (out.length && isBlankText(out[0])) out.shift();
  while (out.length && isBlankText(out[out.length - 1])) out.pop();
  return out;
}

// 引用のかたまり（純正の返信と同じ形）。header は「2026年1月1日(木) 10:00 名前 <a@example.com>:」
export function buildQuoteHtml(header: string, originalHtml: string | null, originalText: string): string {
  // 見出しのアドレスは、純正と同じく mailto のリンクにする
  const headerHtml = escapeHtml(header).replace(/&lt;([^&\s]+@[^&\s]+)&gt;/, (_m, addr: string) => `&lt;<a href="mailto:${addr}">${addr}</a>&gt;`);
  const original = originalHtml && originalHtml.trim()
    ? sanitizeHtml(originalHtml, "trusted")
    : `<div dir="ltr">${escapeHtml(originalText).replace(/\r?\n/g, "<br>")}</div>`;
  return `<div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">${headerHtml}<br></div>`
    + `<blockquote class="gmail_quote" style="${QUOTE_STYLE}">${original}\n</blockquote></div>`;
}

// 入力欄の中身（本文・引用・署名）から、送る HTML を組み立てる。並びは純正と同じ「本文 → 引用 → 署名」
export function assembleCompose(parts: { body: HtmlNode[]; quote: HtmlNode | null; signature: HtmlNode[] | null }, kind: ComposeKind): string {
  const body = serializeHtml(toLines(canonicalizeBody(parts.body), kind));
  const sig = parts.signature && parts.signature.some(n => !isBlankText(n)) ? serializeHtml(parts.signature) : "";
  if (kind === "reply") {
    let html = `<div dir="ltr">${body}</div>`;
    if (parts.quote) html += `<br>${serializeHtml([parts.quote])}`;
    if (sig) html += `<div><br clear="all"></div><div><br></div>${SIGNATURE_PREFIX}<div dir="ltr" class="gmail_signature">${sig}</div>`;
    return html;
  }
  const sigHtml = sig ? `<div><br></div><div><br></div>${SIGNATURE_PREFIX}<div dir="ltr" class="gmail_signature" data-smartmail="gmail_signature">${sig}</div>` : "";
  const quoteHtml = parts.quote ? `<br>${serializeHtml([parts.quote])}` : "";
  return `<div dir="ltr">${body}${sigHtml}</div>${quoteHtml}`;
}

// 入力欄だけの印（たたむ印・画像の cid の印・選んでいる画像の印）を外す。送る HTML に残さない
function stripEditorMarks(nodes: HtmlNode[]): HtmlNode[] {
  return nodes.map(n => {
    if (n.type === "text") return n;
    const attrs = n.attrs
      .filter(([k]) => !k.startsWith("data-remail"))
      .map(([k, v]) => [k, k === "class" ? v.split(/\s+/).filter(c => c && !c.startsWith("remail-")).join(" ") : v] as [string, string])
      .filter(([k, v]) => !(k === "class" && !v));
    return { ...n, attrs, children: stripEditorMarks(n.children) };
  });
}

// 入力欄の HTML を読む（安全にして、入力欄だけの印を外す）
function readCompose(html: string): HtmlNode[] {
  return stripEditorMarks(sanitizeNodes(parseHtml(html.slice(0, COMPOSE_LIMITS.maxHtmlChars * 2), { maxDepth: COMPOSE_LIMITS.maxDepth }), "trusted"));
}

// 入力欄の HTML を、安全にして純正の形に整える（保存・送信の前に必ず通す）。引用があれば返信の形にする
export function normalizeComposeHtml(html: string, kindHint?: ComposeKind): string {
  const parts = splitCompose(readCompose(html));
  const kind: ComposeKind = kindHint ?? (parts.quote ? "reply" : "new");
  return assembleCompose(parts, kind);
}

// 署名を入れ替える（無ければ足す）。null なら外す
export function withSignature(html: string, signatureHtml: string | null, kind: ComposeKind): string {
  const parts = splitCompose(readCompose(html));
  const sig = signatureHtml && signatureHtml.trim() ? sanitizeNodes(parseHtml(signatureHtml, { maxDepth: COMPOSE_LIMITS.maxDepth }), "trusted") : null;
  return assembleCompose({ ...parts, signature: sig }, kind);
}

// 引用を入れる・外す
export function withQuote(html: string, quoteHtml: string | null): string {
  const parts = splitCompose(readCompose(html));
  const quote = quoteHtml ? (sanitizeNodes(parseHtml(quoteHtml, { maxDepth: COMPOSE_LIMITS.maxDepth }), "trusted").find(n => isEl(n)) as HtmlElement | undefined) ?? null : null;
  return assembleCompose({ ...parts, quote }, quote ? "reply" : "new");
}

// 今の署名（の HTML）。手で書き換えたかを、入れたときの署名と比べるのに使う
export function signatureOf(html: string): string | null {
  const parts = splitCompose(readCompose(html));
  return parts.signature ? serializeHtml(parts.signature) : null;
}

export function sameSignature(a: string | null, b: string | null): boolean {
  const norm = (s: string | null) => (s ? composeHtmlToText(s).replace(/\s+/g, "") : "");
  return norm(a) === norm(b);
}

// 署名・引用を除いた本文に、文字・画像・表があるか（送信ボタンを押せるか）
export function isComposeBodyEmpty(html: string): boolean {
  const { body } = splitCompose(stripEditorMarks(parseHtml(html, { maxDepth: COMPOSE_LIMITS.maxDepth })));
  let found = false;
  const walk = (list: HtmlNode[]) => {
    for (const n of list) {
      if (found) return;
      if (n.type === "text") { if (n.value.replace(/[\s ​]/g, "")) found = true; continue; }
      if (n.name === "img" || n.name === "table") { found = true; return; }
      walk(n.children);
    }
  };
  walk(body);
  return !found;
}

// 引用が入っているか
export function hasQuote(html: string): boolean {
  return splitCompose(stripEditorMarks(parseHtml(html, { maxDepth: COMPOSE_LIMITS.maxDepth }))).quote !== null;
}

// 署名・引用を除いた本文のテキスト（送ったメールの吹き出しに出す）
export function composeBodyText(html: string): string {
  const { body } = splitCompose(readCompose(html));
  return composeHtmlToText(serializeHtml(body)).replace(/\r\n/g, "\n").replace(/\n+$/, "");
}

// HTML が参照している本文中の画像の Content-ID
export function imageCids(html: string): Set<string> {
  const out = new Set<string>();
  mapImageSources(html, (src) => { if (src.startsWith("cid:")) out.add(src.slice(4)); return src; });
  return out;
}

// 文字だけの下書き（古い形）を、純正と同じ行の HTML にする
export function textToComposeHtml(text: string): string {
  const lines = (text || "").replace(/\r\n?/g, "\n").split("\n");
  return lines.map(l => (l ? `<div>${escapeText(l)}</div>` : "<div><br></div>")).join("");
}

// 本文中の画像の src を置き換える（編集中の blob: ⇔ 送る・保存するときの cid:）。map が null を返したら画像を外す
export function mapImageSources(html: string, map: (src: string, el: { alt?: string }) => string | null): string {
  const walk = (list: HtmlNode[]): HtmlNode[] => {
    const out: HtmlNode[] = [];
    for (const n of list) {
      if (n.type === "el" && n.name === "img") {
        const src = getAttr(n, "src") || "";
        const next = map(src, { alt: getAttr(n, "alt") });
        if (next === null) continue;
        out.push({ ...n, attrs: n.attrs.map(([k, v]) => [k, k === "src" ? next : v] as [string, string]) });
        continue;
      }
      out.push(n.type === "el" ? { ...n, children: walk(n.children) } : n);
    }
    return out;
  };
  return serializeHtml(walk(parseHtml(html, { maxDepth: COMPOSE_LIMITS.maxDepth })));
}

// ---------------------------------------------------------------------------
// テキスト版（純正が送る text/plain と同じ形）
// ---------------------------------------------------------------------------

export function composeHtmlToText(html: string): string {
  const nodes = parseHtml(html, { maxDepth: COMPOSE_LIMITS.maxDepth });
  const raw = renderText(nodes);
  // 行末の空白を除く（署名の区切りの「-- 」は残す）。最後は改行で終える。改行は CRLF（純正と同じ）
  const lines = raw.split("\n").map(l => (l === "-- " ? l : l.replace(/[ \t ]+$/, "")));
  let text = lines.join("\n");
  if (text && !text.endsWith("\n")) text += "\n";
  return text.replace(/\n/g, "\r\n");
}

function renderText(nodes: HtmlNode[]): string {
  // 足していく文字列の末尾を毎回調べると、長い本文で時間が2乗に伸びる（文字列の作り直しが起きる）ので、
  // 断片の配列に足し、末尾の2文字だけを別に覚えておく
  const chunks: string[] = [];
  let tail = "";
  let length = 0;
  const add = (v: string) => { if (!v) return; chunks.push(v); length += v.length; tail = (tail + v).slice(-2); };
  const atLineStart = () => length === 0 || tail.endsWith("\n");
  const newline = () => { if (!atLineStart()) add("\n"); };
  const ensureBlank = () => { newline(); if (length > 0 && tail !== "\n\n") add("\n"); };
  const quoteLines = (inner: string, extraTail: boolean) => {
    const lines = inner.split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    if (extraTail) lines.push("");
    for (const l of lines) add((l ? `> ${l}` : ">") + "\n");
  };
  const walk = (list: HtmlNode[]) => {
    for (const n of list) {
      if (n.type === "text") {
        let v = n.value.replace(/[\s]+/g, " ").replace(/ /g, " ");
        if (atLineStart()) v = v.replace(/^ +/, "");
        add(v);
        continue;
      }
      switch (n.name) {
        case "br":
          // 純正は署名の前の <br clear="all"> をテキスト版の改行にしない
          if (getAttr(n, "clear") !== "all") add("\n");
          break;
        case "style": case "head": case "title": case "script": break;
        case "b": case "strong": case "i": case "em": case "u": {
          const inner = renderText(n.children);
          if (inner.trim()) add(`*${inner}*`); else add(inner);
          break;
        }
        case "a": {
          const inner = renderText(n.children);
          const href = getAttr(n, "href") || "";
          add(inner);
          const t = inner.trim();
          if (href && t !== href && `mailto:${t}` !== href) add(` <${href}>`);
          break;
        }
        case "img": add(`[image: ${getAttr(n, "alt") || "image.png"}]`); break;
        case "ol": case "ul": {
          if (length > 0) { newline(); add("\n"); }
          let k = 0;
          for (const li of n.children) {
            if (!isEl(li, "li")) continue;
            k++;
            newline();
            add(n.name === "ol" ? `   ${k}. ` : "   - ");
            add(renderText(li.children).replace(/\n+$/, "").replace(/\n/g, "\n     "));
          }
          newline();
          add("\n");
          break;
        }
        case "blockquote": {
          if (hasClass(n, "gmail_quote")) {
            ensureBlank();
            quoteLines(renderText(n.children).replace(/^\n+/, ""), false);
            add("\n");
          } else {
            ensureBlank();
            walk(n.children);
            newline();
            add("\n");
          }
          break;
        }
        case "table": {
          newline();
          const rows: HtmlElement[] = [];
          const collect = (list: HtmlNode[]) => { for (const c of list) if (isEl(c)) { if (c.name === "tr") rows.push(c); else if (["thead", "tbody", "tfoot"].includes(c.name)) collect(c.children); } };
          collect(n.children);
          for (const tr of rows) {
            const cells = tr.children.filter((c): c is HtmlElement => isEl(c) && (c.name === "td" || c.name === "th")).map(c => renderText(c.children).replace(/\s+/g, " ").trim());
            add(cells.join(" ") + "\n");
          }
          break;
        }
        default: {
          if (n.name === "div" && hasClass(n, "gmail_quote_container")) {
            // 返信の引用：見出し・空行・「> 」の行・最後に「>」の行（純正と同じ）
            newline();
            for (const c of n.children) {
              if (isEl(c, "blockquote") && hasClass(c, "gmail_quote")) { add("\n"); quoteLines(renderText(c.children), true); }
              else walk([c]);
            }
            break;
          }
          const block = !INLINE.has(n.name);
          if (block) newline();
          walk(n.children);
          if (block) newline();
        }
      }
    }
  };
  walk(nodes);
  return chunks.join("");
}

// ---------------------------------------------------------------------------
// ブラウザでだけ使う（入力欄の iframe に入れる）。ここだけで DOMParser と insertHTML を使う
// ---------------------------------------------------------------------------

// 安全にした HTML を、iframe の document のノードにする（DOMParser の document ではスクリプトは動かない・読み込みもしない）
export function safeFragment(doc: Document, html: string, mode: SanitizeMode): DocumentFragment {
  const safe = sanitizeHtml(html, mode);
  const parsed = new DOMParser().parseFromString(`<!doctype html><body>${safe}`, "text/html");
  const frag = doc.createDocumentFragment();
  for (const child of Array.from(parsed.body.childNodes)) frag.appendChild(doc.importNode(child, true));
  return frag;
}

// 入力欄の中身をまるごと入れ替える（下書きの読み戻し・チャットの切り替え。元に戻すの履歴には残さない）
export function replaceContent(doc: Document, root: HTMLElement, html: string, mode: SanitizeMode = "trusted"): void {
  const frag = safeFragment(doc, html, mode);
  while (root.firstChild) root.removeChild(root.firstChild);
  root.appendChild(frag);
}

// カーソルの位置に安全にした HTML を入れる（貼り付け・ドロップ。元に戻すの履歴に残すため execCommand を使う）
export function insertSafeHtml(doc: Document, html: string, mode: SanitizeMode): boolean {
  const safe = sanitizeHtml(html, mode);
  // eslint-disable-next-line no-restricted-syntax -- 安全化した HTML だけを、元に戻すの履歴に残る形で入れる（このファイルだけの例外）
  return doc.execCommand("insertHTML", false, safe);
}
