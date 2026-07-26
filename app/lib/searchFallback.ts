// SearchModal のサーバー検索フォールバック（クライアント側に読み込み済みのメールだけでは
// 0件のとき、Gmail本体を対象に検索する）が、同じキーワード×対象フィールドに対して
// 何度もGmail APIを叩いてクォータを浪費しないようにするための判定ロジック。
// Reactのエフェクト・レンダリングから切り離した純粋な形にして、ユニットテストできるようにしてある。

export type SearchField = "subject" | "body";

function searchKey(kwLower: string, field: SearchField): string {
  return `${kwLower}::${field}`;
}

// ローカル（読み込み済みメールだけ）の検索結果が0件で、かつこのキーワード×フィールドの
// 組み合わせをまだ一度も試していない場合だけ、サーバー検索を実行すべきと判定する
export function shouldTriggerServerSearch(
  alreadySearched: ReadonlySet<string>,
  kwLower: string,
  field: SearchField,
  localMatchCount: number
): boolean {
  if (localMatchCount > 0) return false;
  return !alreadySearched.has(searchKey(kwLower, field));
}

// このキーワード×フィールドに対してサーバー検索を実行した（＝これ以降は同じ組み合わせで
// 二度と撃たない）ことを記録する
export function markServerSearched(alreadySearched: Set<string>, kwLower: string, field: SearchField): void {
  alreadySearched.add(searchKey(kwLower, field));
}
