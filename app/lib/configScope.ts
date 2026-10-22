// 設定をどのアカウントの置き場所に保存するか。
// すべてのアカウントが対象のフィルター（対象アカウントを決めていないアクションフィルター・フィルターグループ）は
// ログイン中の全アカウントに写しを持つ（shared）。それ以外（チャットの設定・1つのアカウントだけのフィルター・
// 宛先で作るグループ）は、そのアカウントの置き場所に持つ
type ScopeInput = { filterAction?: unknown; isGroup?: boolean; filterCriteria?: { accountEmail?: string } | null };

export function isSharedConfig(cfg: ScopeInput | undefined | null): boolean {
  if (!cfg) return false;
  const isFilter = !!cfg.filterAction || (!!cfg.isGroup && !!cfg.filterCriteria);
  return isFilter && !cfg.filterCriteria?.accountEmail;
}
