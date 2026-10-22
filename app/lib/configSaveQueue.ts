// 設定（ピン留め・非表示・名前変更・グループ・フィルター・共通設定）を D1 に保存するときの送り直し。
// 設定の保存は「その行を今の値で上書きする」だけなので、何度送っても結果は同じ（メールの送信とは違い、二重になる害がない）。
// そのため、通信断・5xx・429 で失敗したら、少しずつ間隔を空けて自動で送り直す（絶対ルール3：黙って失わない）。
// - 同じ行（key）に新しい保存が来たら、古い保存の送り直しはやめて新しい値だけを送る（古い値で上書きし直さないため）
// - 401・400 など、送り直しても変わらない失敗はすぐにあきらめて知らせる
// - 送り直す中身は端末に保存しない（設定には相手の名前などが入るため。再読み込みすると消えることは画面で伝える）

export type SaveResult = "ok" | "retry" | "fatal";

// fetch の結果（ステータス。通信できなかったときは null）を、成功・送り直す・あきらめる に分ける
export function classifySaveStatus(status: number | null): SaveResult {
  if (status === null) return "retry";
  if (status >= 200 && status < 300) return "ok";
  if (status === 408 || status === 429 || status >= 500) return "retry";
  return "fatal";
}

// 1回目の失敗から、2秒・5秒・15秒・30秒・60秒あとに送り直す（合計で約2分。それでもだめなら知らせる）
export const CONFIG_RETRY_DELAYS_MS = [2000, 5000, 15000, 30000, 60000];

export type SaveQueueOptions = {
  delaysMs?: number[];
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  // 失敗が始まった（自動で送り直す）。失敗が続いている間は何度も呼ばない
  onRetrying?: (key: string) => void;
  // 失敗していた保存が、すべて送り直しで保存できた
  onRecovered?: () => void;
  // 送り直してもだめだった・送り直しても変わらない失敗だった
  onGaveUp?: (key: string) => void;
};

type Entry = { version: number; send: () => Promise<Response>; attempt: number; timer: unknown };

export function createSaveQueue(opts: SaveQueueOptions = {}) {
  const delays = opts.delaysMs ?? CONFIG_RETRY_DELAYS_MS;
  const schedule = opts.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const cancel = opts.cancel ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const entries = new Map<string, Entry>();
  // 送り直し待ちの key。空から1つ目が入ったときだけ「送り直します」と知らせる
  const failing = new Set<string>();
  let gaveUpInEpisode = false;
  let nextVersion = 0;

  const endEpisodeIfDone = (recovered: boolean) => {
    if (failing.size > 0) return;
    if (recovered && !gaveUpInEpisode) opts.onRecovered?.();
    gaveUpInEpisode = false;
  };

  const run = async (key: string, version: number): Promise<void> => {
    const entry = entries.get(key);
    if (!entry || entry.version !== version) return;
    entry.timer = undefined;
    let status: number | null;
    try {
      status = (await entry.send()).status;
    } catch {
      status = null;
    }
    // 待っている間に同じ行へ新しい保存が来ていたら、この結果は使わない（新しい保存が自分で結果を出す）
    const current = entries.get(key);
    if (!current || current.version !== version) return;
    const result = classifySaveStatus(status);
    if (result === "ok") {
      entries.delete(key);
      const wasFailing = failing.delete(key);
      if (wasFailing) endEpisodeIfDone(true);
      return;
    }
    if (result === "retry" && current.attempt < delays.length) {
      if (failing.size === 0) opts.onRetrying?.(key);
      failing.add(key);
      const delay = delays[current.attempt];
      current.attempt += 1;
      current.timer = schedule(() => { void run(key, version); }, delay);
      return;
    }
    entries.delete(key);
    failing.delete(key);
    if (!gaveUpInEpisode) opts.onGaveUp?.(key);
    gaveUpInEpisode = true;
    endEpisodeIfDone(false);
  };

  return {
    // 保存する。同じ key の送り直し待ちがあれば、それをやめてこちらを送る。1回目の送信が終わったら解決する
    save(key: string, send: () => Promise<Response>): Promise<void> {
      const prev = entries.get(key);
      if (prev?.timer !== undefined) cancel(prev.timer);
      const version = ++nextVersion;
      entries.set(key, { version, send, attempt: 0, timer: undefined });
      return run(key, version);
    },
    // 通信が戻ったときなど、待たずに今すぐ送り直す
    flush(): void {
      entries.forEach((entry, key) => {
        if (entry.timer === undefined) return;
        cancel(entry.timer);
        void run(key, entry.version);
      });
    },
    // まだ保存できていない設定があるか（ページを閉じる前の確認に使う）
    hasPending(): boolean {
      return failing.size > 0;
    },
  };
}

export type SaveQueue = ReturnType<typeof createSaveQueue>;
