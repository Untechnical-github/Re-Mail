# 入力欄・HTML・CSP の決まり（入力欄・`composeHtml.ts`・`composeEditor.ts`・`ComposeEditor.tsx`・CSP・`securityHeaders.ts`・iframe に触るときだけ読む）

詳しい仕様は README §15.6（`grep -n "15.6" README.md` で探して、その節だけ読む）。

- **メール本文を表示する iframe**（`EmailModal` など）の `sandbox` に `allow-scripts` / `allow-forms` / `allow-top-navigation` などを足さない。
- **入力欄の iframe** だけは `sandbox="allow-same-origin allow-scripts"`（Safari が allow-scripts の無い iframe のイベントを親に渡さないため。README §18.3・§19）。ほかの項目は足さない。表示の iframe と部品・設定を共有しない。
- 守りは4枚。どれも外さない：
  1. iframe の中の CSP（`editorSrcDoc`。`<head>` の先頭）。`script-src`・スクリプトの `'unsafe-inline'`・nonce を足さない。
  2. 画面の CSP（`securityHeaders.ts` / `worker.ts`）。`script-src` に `'unsafe-inline'` を戻さない。CSP を `next.config.ts` に入れない。
  3. 入れるときの安全化：入る経路（下書き・端末の下書き・引用・署名・貼り付け・ドロップ・画像）はすべて `composeHtml.ts` の `insertSafeHtml` / `replaceContent` / `safeFragment` を通す。生の HTML を `innerHTML`・`outerHTML`・`insertAdjacentHTML`・`document.write`・`execCommand("insertHTML")`・`dangerouslySetInnerHTML` で入れない（ESLint で止めている。例外は `composeHtml.ts` の1か所）。
  4. 見張り（MutationObserver）。
- CSP の `report-uri` / `report-to` は付けない（第三者に送らない）。
- 入力欄・`composeHtml.ts`・CSP・`securityHeaders.ts` を変えたら、`remail-e2e/editor-test` の攻撃の E2E（`node editor-test/build.mjs && node editor-test/run-attacks.mjs 2>&1 | tail -40`）を全ブラウザで通す。CI では動かせないので結果を報告に書く。
