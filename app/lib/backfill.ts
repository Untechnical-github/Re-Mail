// D1 の全行を、今の保存の形（アドレスの置き換え・相手名や設定の暗号化・ピン留めの本体の削除）に置き換える。
// 設定は「その人が Re:Mail を開いたとき」に置き換わるので、二度と開かない人の行は平文のまま残ってしまう。
// それを残さないよう、Worker の定期実行（worker.ts の scheduled）から呼ぶ。
// 置き換え方は、開いたときと同じ処理（configStore.ts・linkedAccountsStore.ts）をそのまま使う
import { openAndMigrateConfigs } from "./configStore";
import { listLinkedAccounts } from "./linkedAccountsStore";
import { WRITE_HASHED_ADDRESS } from "./addressStage";
import { logError, logInfo } from "./safeLog";

type Db = CloudflareEnv["DB"];

// まだ置き換えていない（user_email が平文の）利用者を、1回に maxUsers 人まで処理する。
// 開けない行がある人で毎回つまらないよう、順番はばらばらにする
export async function runBackfill(db: Db, maxUsers = 20): Promise<{ configUsers: number; linkedUsers: number }> {
  // 段階2（アドレスも置き換えて保存する）になるまでは何もしない（段階1のコードに戻せる状態を保つため）
  if (!WRITE_HASHED_ADDRESS) return { configUsers: 0, linkedUsers: 0 };
  let configUsers = 0;
  let linkedUsers = 0;
  try {
    const { results } = await db.prepare(
      "SELECT DISTINCT user_email FROM chat_configs WHERE user_email NOT LIKE 'a1:%' ORDER BY random() LIMIT ?"
    ).bind(maxUsers).all();
    for (const { user_email } of results as { user_email: string }[]) {
      try {
        await openAndMigrateConfigs(db, user_email);
        configUsers++;
      } catch (e) {
        // 1人の失敗で、ほかの人の置き換えは止めない
        logError("backfill.configs", {}, e);
      }
    }
  } catch (e) {
    logError("backfill.configs.list", {}, e);
  }
  try {
    const { results } = await db.prepare(
      "SELECT DISTINCT user_email FROM linked_accounts WHERE user_email NOT LIKE 'a1:%' ORDER BY random() LIMIT ?"
    ).bind(maxUsers).all();
    for (const { user_email } of results as { user_email: string }[]) {
      try {
        await listLinkedAccounts(db, user_email);
        linkedUsers++;
      } catch (e) {
        logError("backfill.linked", {}, e);
      }
    }
  } catch (e) {
    logError("backfill.linked.list", {}, e);
  }
  if (configUsers || linkedUsers) logInfo("backfill", { count: configUsers + linkedUsers });
  return { configUsers, linkedUsers };
}
