// HTML を小さな木（要素・文字）にして、また HTML に戻す純粋関数。
// 入力欄の HTML の安全化・整形（composeHtml.ts）で使う。ブラウザの DOM が無いところ（テスト・Worker）でも同じに動くよう、
// DOMParser を使わず自前で読む。後戻りする正規表現は使わず、先頭から1回なめるだけにする（巨大な入力・壊れた HTML で固まらない）

export type HtmlText = { type: "text"; value: string };
export type HtmlElement = { type: "el"; name: string; attrs: [string, string][]; children: HtmlNode[] };
export type HtmlNode = HtmlText | HtmlElement;

// 終わりのタグを持たない要素
export const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
// 中身を文字として読む要素（中のタグを読まない）。読んだあと、安全化でまるごと捨てるか残すかを決める
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript", "plaintext"]);
// 開いたときに、開いている <p> を閉じる要素
const CLOSES_P = new Set(["address", "article", "aside", "blockquote", "center", "details", "dir", "div", "dl", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "main", "menu", "nav", "ol", "p", "pre", "section", "table", "ul"]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", trade: "™", hellip: "…",
  mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•", middot: "·", yen: "¥", euro: "€",
  times: "×", divide: "÷", laquo: "«", raquo: "»", shy: "­", zwj: "‍", zwnj: "‌", tab: "\t", newline: "\n",
  colon: ":", lpar: "(", rpar: ")", sol: "/", bsol: "\\", semi: ";", comma: ",", period: ".", excl: "!", quest: "?",
};

// 文字参照（&amp; &#106; &#x6A; など）を文字に戻す。URL の「jav&#x61;script:」も見抜けるように、属性の値でも使う
export function decodeEntities(s: string): string {
  if (s.indexOf("&") < 0) return s;
  let out = "";
  let i = 0;
  while (i < s.length) {
    const amp = s.indexOf("&", i);
    if (amp < 0) { out += s.slice(i); break; }
    out += s.slice(i, amp);
    let j = amp + 1;
    if (s[j] === "#") {
      j++;
      const hex = s[j] === "x" || s[j] === "X";
      if (hex) j++;
      const start = j;
      while (j < s.length && j - start < 8 && (hex ? /[0-9a-fA-F]/.test(s[j]) : /[0-9]/.test(s[j]))) j++;
      if (j > start) {
        const code = parseInt(s.slice(start, j), hex ? 16 : 10);
        out += code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "�";
        if (s[j] === ";") j++;
        i = j;
        continue;
      }
    } else {
      const start = j;
      while (j < s.length && j - start < 12 && /[a-zA-Z0-9]/.test(s[j])) j++;
      const name = s.slice(start, j);
      const ch = NAMED_ENTITIES[name] ?? NAMED_ENTITIES[name.toLowerCase()];
      if (name && ch !== undefined) {
        out += ch;
        if (s[j] === ";") j++;
        i = j;
        continue;
      }
    }
    out += "&";
    i = amp + 1;
  }
  return out;
}

const isSpace = (c: string) => c === " " || c === "\n" || c === "\t" || c === "\r" || c === "\f";
const isNameChar = (c: string) => /[a-zA-Z0-9:_.-]/.test(c);

export type ParseOptions = { maxDepth?: number };

// HTML を読んで木にする。入れ子が maxDepth を超えた部分は、タグを読まずに文字だけにする（上限で打ち切る）
export function parseHtml(html: string, opts: ParseOptions = {}): HtmlNode[] {
  const maxDepth = opts.maxDepth ?? 100;
  const root: HtmlElement = { type: "el", name: "#root", attrs: [], children: [] };
  const stack: HtmlElement[] = [root];
  const lower = html.toLowerCase();
  const top = () => stack[stack.length - 1];
  const addText = (v: string) => {
    if (!v) return;
    const kids = top().children;
    const last = kids[kids.length - 1];
    if (last && last.type === "text") last.value += v;
    else kids.push({ type: "text", value: v });
  };
  const popTo = (name: string): boolean => {
    for (let k = stack.length - 1; k > 0; k--) {
      if (stack[k].name === name) { stack.length = k; return true; }
    }
    return false;
  };
  const closeIfOpen = (name: string, stopAt: Set<string>) => {
    for (let k = stack.length - 1; k > 0; k--) {
      const n = stack[k].name;
      if (n === name) { stack.length = k; return; }
      if (stopAt.has(n)) return;
    }
  };
  const LIST_SCOPE = new Set(["ul", "ol", "table", "div", "blockquote", "td", "th"]);
  const TABLE_SCOPE = new Set(["table"]);
  const ROW_SCOPE = new Set(["tr", "table"]);

  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) { addText(decodeEntities(html.slice(i))); break; }
    if (lt > i) addText(decodeEntities(html.slice(i, lt)));
    i = lt;
    const next = html[i + 1];
    // コメント・<!DOCTYPE>・<?xml?> は読み飛ばす
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (next === "!" || next === "?") {
      const end = html.indexOf(">", i + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }
    // 終わりのタグ
    if (next === "/") {
      let j = i + 2;
      const start = j;
      while (j < n && isNameChar(html[j])) j++;
      const name = lower.slice(start, j);
      const end = html.indexOf(">", j);
      i = end < 0 ? n : end + 1;
      if (!name) continue;
      if (name === "br") { if (stack.length <= maxDepth) top().children.push({ type: "el", name: "br", attrs: [], children: [] }); continue; }
      popTo(name);
      continue;
    }
    // 始まりのタグ
    if (!/[a-zA-Z]/.test(next || "")) { addText("<"); i++; continue; }
    let j = i + 1;
    const nameStart = j;
    while (j < n && isNameChar(html[j])) j++;
    const name = lower.slice(nameStart, j);
    const attrs: [string, string][] = [];
    let selfClosing = false;
    // 属性
    while (j < n) {
      while (j < n && (isSpace(html[j]) || html[j] === "/")) { if (html[j] === "/" && html[j + 1] === ">") selfClosing = true; j++; }
      if (j >= n || html[j] === ">") break;
      const aStart = j;
      while (j < n && !isSpace(html[j]) && html[j] !== ">" && html[j] !== "=" && !(html[j] === "/" && html[j + 1] === ">")) j++;
      const aName = lower.slice(aStart, j);
      while (j < n && isSpace(html[j])) j++;
      let value = "";
      if (html[j] === "=") {
        j++;
        while (j < n && isSpace(html[j])) j++;
        const q = html[j];
        if (q === '"' || q === "'") {
          const close = html.indexOf(q, j + 1);
          const end = close < 0 ? n : close;
          value = html.slice(j + 1, end);
          j = end + 1;
        } else {
          const vStart = j;
          while (j < n && !isSpace(html[j]) && html[j] !== ">") j++;
          value = html.slice(vStart, j);
        }
      }
      if (aName && !attrs.some(([k]) => k === aName)) attrs.push([aName, decodeEntities(value)]);
    }
    i = j < n ? j + 1 : n;
    if (!name) continue;

    // 中身を文字として読む要素：終わりのタグまでをまとめて1つの文字にする
    if (RAW_TEXT_ELEMENTS.has(name)) {
      const closeAt = name === "plaintext" ? -1 : lower.indexOf(`</${name}`, i);
      const end = closeAt < 0 ? n : closeAt;
      const raw = html.slice(i, end);
      const el: HtmlElement = { type: "el", name, attrs, children: raw ? [{ type: "text", value: raw }] : [] };
      if (stack.length <= maxDepth) top().children.push(el);
      i = closeAt < 0 ? n : (html.indexOf(">", closeAt) < 0 ? n : html.indexOf(">", closeAt) + 1);
      continue;
    }

    // 上限より深いところはタグを読まず、文字だけを残す
    if (stack.length > maxDepth) continue;

    // 書き方の省略（<p> の中の <div>、<li> の中の <li> など）をブラウザと同じように閉じる
    if (CLOSES_P.has(name)) closeIfOpen("p", LIST_SCOPE);
    if (name === "li") closeIfOpen("li", new Set(["ul", "ol"]));
    if (name === "dt" || name === "dd") { closeIfOpen("dt", new Set(["dl"])); closeIfOpen("dd", new Set(["dl"])); }
    if (name === "tr") { closeIfOpen("td", ROW_SCOPE); closeIfOpen("th", ROW_SCOPE); closeIfOpen("tr", TABLE_SCOPE); }
    if (name === "td" || name === "th") { closeIfOpen("td", ROW_SCOPE); closeIfOpen("th", ROW_SCOPE); }
    if (name === "tbody" || name === "thead" || name === "tfoot") { closeIfOpen("tr", TABLE_SCOPE); closeIfOpen("tbody", TABLE_SCOPE); closeIfOpen("thead", TABLE_SCOPE); closeIfOpen("tfoot", TABLE_SCOPE); }
    if (name === "option") closeIfOpen("option", new Set(["select"]));

    const el: HtmlElement = { type: "el", name, attrs, children: [] };
    top().children.push(el);
    if (!VOID_ELEMENTS.has(name) && !selfClosing) stack.push(el);
  }
  return root.children;
}

export function escapeText(s: string): string {
  let out = "";
  for (const c of s) out += c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === " " ? "&nbsp;" : c;
  return out;
}

export function escapeAttr(s: string): string {
  let out = "";
  for (const c of s) out += c === "&" ? "&amp;" : c === '"' ? "&quot;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c;
  return out;
}

// 木を HTML に戻す。属性の値・文字は必ずエスケープするので、戻した HTML をブラウザが読み直しても同じ木になる
export function serializeHtml(nodes: HtmlNode[]): string {
  let out = "";
  const walk = (list: HtmlNode[]) => {
    for (const node of list) {
      if (node.type === "text") { out += escapeText(node.value); continue; }
      out += `<${node.name}`;
      for (const [k, v] of node.attrs) out += ` ${k}="${escapeAttr(v)}"`;
      out += ">";
      if (VOID_ELEMENTS.has(node.name)) continue;
      // style の中身は文字として書く（エスケープすると CSS が壊れる）。「</」は書かせない
      if (node.name === "style") out += node.children.map(c => (c.type === "text" ? c.value : "")).join("").replace(/<\//g, "<\\/");
      else walk(node.children);
      out += `</${node.name}>`;
    }
  };
  walk(nodes);
  return out;
}

export function getAttr(el: HtmlElement, name: string): string | undefined {
  const hit = el.attrs.find(([k]) => k === name);
  return hit ? hit[1] : undefined;
}

export function setAttr(el: HtmlElement, name: string, value: string): void {
  const hit = el.attrs.find(([k]) => k === name);
  if (hit) hit[1] = value;
  else el.attrs.push([name, value]);
}

export function removeAttr(el: HtmlElement, name: string): void {
  el.attrs = el.attrs.filter(([k]) => k !== name);
}

export function hasClass(el: HtmlElement, cls: string): boolean {
  return (getAttr(el, "class") || "").split(/\s+/).includes(cls);
}

// 木の中の文字だけをつなげる
export function textContent(nodes: HtmlNode[]): string {
  let out = "";
  const walk = (list: HtmlNode[]) => { for (const n of list) { if (n.type === "text") out += n.value; else walk(n.children); } };
  walk(nodes);
  return out;
}
