// 純正 Gmail で開くためのリンク。Re:Mail で表示や操作がうまくいかないとき、利用者が純正 Gmail で続けられるようにする（絶対ルール3）。
// authuser でアカウントを選ぶ（複数のアカウントでログインしていても、そのメールのアカウントで開くため）
export function gmailOpenUrl(accountEmail?: string | null, threadId?: string | null): string {
  const params = accountEmail ? `?authuser=${encodeURIComponent(accountEmail)}` : "";
  // Gmail API のスレッド ID（16進）は、Gmail の画面の URL でもそのまま使える
  const hash = threadId && /^[0-9a-f]{6,32}$/i.test(threadId) ? `#all/${threadId}` : "#inbox";
  return `https://mail.google.com/mail/${params}${hash}`;
}
