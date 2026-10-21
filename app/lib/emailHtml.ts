// HTML メールを iframe で表示する前の下ごしらえ（純粋関数）。
// リモートの画像・CSS・フォントは、読み込んだ時点で送信者に「開封した・いつ・どこで」が伝わる（トラッキング）ので、
// 利用者が「画像を表示」を押すまで読み込ませない（絶対ルール1）。CSP で塞ぐので、書き方の抜け道があっても通らない

// リモートの読み込みを塞ぐ／許す CSP。スクリプトはどちらでも動かさない（iframe の sandbox でも止めている）
export function emailCsp(allowRemote: boolean): string {
  return allowRemote
    ? "default-src 'none'; img-src * data: blob: cid:; style-src * 'unsafe-inline'; font-src * data:; media-src * data: blob:"
    : "default-src 'none'; img-src data: blob: cid:; style-src 'unsafe-inline'; font-src data:; media-src data: blob:";
}

// 「画像を表示」ボタンを出すかどうか。リモートの画像・背景・スタイルシートを含むか
export function hasRemoteContent(html: string): boolean {
  const s = html.length > 2_000_000 ? html.slice(0, 2_000_000) : html;
  return /<img\b[^>]*?\bsrc\s*=\s*["']?\s*(?:https?:)?\/\//i.test(s)
    || /\burl\(\s*["']?\s*(?:https?:)?\/\//i.test(s)
    || /\bbackground\s*=\s*["']?\s*(?:https?:)?\/\//i.test(s)
    || /<link\b[^>]*?\bhref\s*=\s*["']?\s*(?:https?:)?\/\//i.test(s);
}

const BASE_STYLE =
  '<style>*{box-sizing:border-box;}img{max-width:100%;height:auto;}body{margin:0;padding:16px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;word-break:break-word;opacity:0;transform-origin:0 0;will-change:transform;}</style>';

// iframe の srcDoc に入れる HTML を作る。CSP はほかの何より先に効くよう、head の先頭に入れる
export function prepareEmailHtml(raw: string, allowRemote: boolean): string {
  // <meta http-equiv="refresh"> は iframe の中を外部の URL へ移動させられる（CSP では止まらない）ので取り除く
  // （<meta …> を1つずつ切り出してから中身を見る。タグ全体を1つの正規表現で探すと、巨大なタグで後戻りが爆発する）
  const cleaned = raw.replace(/<meta\b[^>]*>/gi, (tag) => (/http-equiv\s*=\s*["']?\s*refresh/i.test(tag) ? "" : tag));
  const inject =
    `<meta http-equiv="Content-Security-Policy" content="${emailCsp(allowRemote)}">` +
    '<base target="_blank">' +
    BASE_STYLE;
  if (/<head[\s>]/i.test(cleaned)) {
    return cleaned.replace(/(<head[^>]*>)/i, `$1${inject}`);
  }
  return `<!DOCTYPE html><html><head>${inject}</head><body>${cleaned}</body></html>`;
}
