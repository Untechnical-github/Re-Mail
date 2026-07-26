// グループチャットの「追加読み込み」における、メンバーごとのページングトークンから
// 全体の状態（まだ続きがあるか／全員読み終えたか）を導く純粋なロジック。
// useMailApp.ts の fetchGroupLoadMore/fetchCrossboxForRoom から使う。
// グループのローカルキー自体（group:xxxx）はGmail検索語にならないため、メンバーごとに
// 独立してfrom:/to:検索＋pageTokenを進める必要があり、そのトークン状態をここでまとめて判定する。

export const PAGING_DONE_STATES = ["END_ALL", "END_LIMIT"] as const;
export type PagingDoneState = (typeof PAGING_DONE_STATES)[number];

function isDone(token: string | undefined): boolean {
  return !!token && (PAGING_DONE_STATES as readonly string[]).includes(token);
}

// まだ読み終えていない（END_ALL/END_LIMITではない）メンバーだけを返す
export function pendingMembers(members: string[], tokens: Record<string, string>): string[] {
  return members.filter(m => !isDone(tokens[m]));
}

// 全メンバーのトークン状態から、グループ全体としての次のchatNextPageTokenを決める。
// 全員が読み終わっていなければ "MORE"（呼び出し側はここに毎回変わる値を入れて自動読み込みの
// トリガーにする）。全員読み終えていれば、1人でもRe:mailの読み込み上限に達していたら
// "END_LIMIT" を優先し、そうでなければ "END_ALL" を返す
export function aggregateGroupPagingState(members: string[], tokens: Record<string, string>): "MORE" | PagingDoneState {
  if (members.length === 0) return "END_ALL";
  const allDone = members.every(m => isDone(tokens[m]));
  if (!allDone) return "MORE";
  return members.some(m => tokens[m] === "END_LIMIT") ? "END_LIMIT" : "END_ALL";
}
