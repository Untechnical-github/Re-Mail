// メールの移動・削除（ゴミ箱へ）で Gmail に付け外しするラベルと、送るメッセージ ID の整え方。
// サーバー（app/api/emails/route.ts）と画面（useMailApp.ts）の両方から使う

export type MoveDestination = "INBOX" | "ARCHIVE" | "SPAM" | "TRASH";

export type LabelChange = { addLabelIds: string[]; removeLabelIds: string[] };

// 純正 Gmail の「移動」と同じ付け外しにする。アーカイブは「受信箱から外す」だけで、付けるラベルは無い
// （Gmail にアーカイブというラベルは無い。以前は ARCHIVE を扱っておらず、何も変わらないまま画面だけ移って見えていた）
export function labelChangeFor(destination: unknown): LabelChange | null {
  switch (destination) {
    case "INBOX": return { addLabelIds: ["INBOX"], removeLabelIds: ["TRASH", "SPAM"] };
    case "ARCHIVE": return { addLabelIds: [], removeLabelIds: ["INBOX", "TRASH", "SPAM"] };
    case "SPAM": return { addLabelIds: ["SPAM"], removeLabelIds: ["INBOX", "TRASH"] };
    case "TRASH": return { addLabelIds: ["TRASH"], removeLabelIds: ["INBOX", "SPAM"] };
    default: return null;
  }
}

// Gmail のメッセージ ID は英数字。送信直後の仮 ID（fake-）は Gmail に無いので外す。重複も外す
const GMAIL_ID = /^[A-Za-z0-9]{1,64}$/;
export function sanitizeMessageIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  const out = new Set<string>();
  for (const id of ids) {
    if (typeof id === "string" && GMAIL_ID.test(id)) out.add(id);
  }
  return Array.from(out);
}

// Gmail の batchModify は1回に1000件まで
export const BATCH_MODIFY_LIMIT = 1000;
export function chunkIds(ids: string[], size = BATCH_MODIFY_LIMIT): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

// どのアカウントのメールかで ID を分ける（連携アカウントのメールは、そのアカウントのトークンで動かす必要がある）。
// accountOf が空を返したものは fallbackAccount（ログイン中のメインアカウント）として扱う
export function groupIdsByAccount(ids: string[], accountOf: (id: string) => string | undefined, fallbackAccount: string): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const account = accountOf(id) || fallbackAccount;
    const list = groups.get(account);
    if (list) list.push(id); else groups.set(account, [id]);
  }
  return groups;
}
