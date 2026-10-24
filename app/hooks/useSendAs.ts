// 送信元の設定（自分のアドレスとエイリアス・署名）。useMailApp.ts から分けた（動きは変えない）。
// アカウントごとの sendAs を取りにいき、読めた分を sendAsByAccount に持つ
import { useState, useEffect, useRef } from "react";
import type { SendAsInfo } from "../lib/replyCompose";
import { logWarn } from "../lib/safeLog";

// sessionEmail: ログインのセッションを持つアカウント / openRoomAccount: 開いているチャットのアカウント（無ければ ""）/
// sendAsAccountsKey: ログイン中のすべてのアカウント（カンマ区切り）
export function useSendAs({ sessionEmail, openRoomAccount, sendAsAccountsKey }: { sessionEmail: string; openRoomAccount: string; sendAsAccountsKey: string }) {
  // アカウントごとの送信元（自分のアドレスとエイリアス）。開いたチャットのアカウントの分だけ取りにいく（下の getSendAs）
  const [sendAsByAccount, setSendAsByAccount] = useState<Record<string, SendAsInfo[]>>({});
  const sendAsByAccountRef = useRef(sendAsByAccount);
  useEffect(() => { sendAsByAccountRef.current = sendAsByAccount; }, [sendAsByAccount]);
  // 自分のアドレスとエイリアス（読み込めている分）。返信の宛先・Reply-To・受け取った立場の判定で「自分」を除くのに使う
  const myAddressesFor = (account: string): string[] => [account, ...(sendAsByAccount[account] || []).map(s => s.sendAsEmail)].filter(Boolean);

  // 送信元（自分のアドレスとエイリアス）と署名の設定。アカウントごとに一度だけ取りにいく（送信のたびに API を呼ばない）。
  // 読めなかったときは null を返し、次の送信で取り直す
  const sendAsCacheRef = useRef(new Map<string, { promise: Promise<SendAsInfo[] | null>; at: number }>());
  const getSendAs = (account: string): Promise<SendAsInfo[] | null> => {
    // Gmail で署名を変えたときに、再読み込みしなくても反映されるよう10分で取り直す
    const cached = sendAsCacheRef.current.get(account);
    if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.promise;
    const myEmail = sessionEmail;
    const params = new URLSearchParams({ sendAs: "1" });
    if (account !== myEmail) params.append("accountEmail", account);
    const loadOnce = async (): Promise<SendAsInfo[] | null> => {
      try {
        const res = await fetch(`/api/emails?${params.toString()}`);
        if (!res.ok) { logWarn("sendAs.load", { status: res.status }); return null; }
        const data = (await res.json()) as { sendAs?: SendAsInfo[] };
        return data.sendAs || [];
      } catch (e) {
        logWarn("sendAs.load", {}, e);
        return null;
      }
    };
    // 開いた直後はメールの一括取得で Gmail のレート制限に触れやすく、実機テストでもここが失敗した。
    // すぐ「署名なしで送りますか」と聞かないよう、少し待ってから1回だけ取り直す
    const promise = (async () => {
      const first = await loadOnce();
      if (first !== null) return first;
      await new Promise(r => setTimeout(r, 4000));
      return loadOnce();
    })();
    sendAsCacheRef.current.set(account, { promise, at: Date.now() });
    void promise.then(v => { if (v === null) sendAsCacheRef.current.delete(account); });
    return promise;
  };

  // 返信欄に出す「送信元」：送るときと同じ決め方（元のメールが自分のエイリアス宛てならそのエイリアス）で、実際の From を出す。
  // 送信元の設定はアカウントごとに10分に1回だけ取る（getSendAs のキャッシュ）。開いた直後の一括取得とぶつからないよう少し待つ
  // チャットのまとめ方（Reply-To が自分のエイリアスなら無視する）と返信の宛先（自分のエイリアスを除く）に要るので、
  // 起動時にログイン中のすべてのアカウントの分を1回ずつ取る（開いているチャットのアカウントを先に。1件ずつ間をあけて、
  // 開いた直後のメールの一括取得と Gmail のレート制限でぶつからないようにする）。読めなかった分は、チャットを開いたときに取り直す
  useEffect(() => {
    const all = sendAsAccountsKey ? sendAsAccountsKey.split(",") : [];
    const order = [openRoomAccount, ...all.filter(a => a !== openRoomAccount)].filter(a => a && !sendAsByAccountRef.current[a]);
    if (order.length === 0) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      // 読めなかった分は、Gmail の利用上限が戻るのを待って取り直す（最大3回。署名を入力欄に入れるのに要るため）
      let pending = order;
      for (let round = 0; round < 3 && pending.length; round++) {
        if (round > 0) await new Promise(r => setTimeout(r, 20_000 * round));
        const failed: string[] = [];
        for (const account of pending) {
          if (cancelled) return;
          const list = await getSendAs(account);
          if (cancelled) return;
          if (list) setSendAsByAccount(prev => ({ ...prev, [account]: list }));
          else failed.push(account);
          await new Promise(r => setTimeout(r, 1500));
        }
        pending = failed;
      }
    }, 1500);
    return () => { cancelled = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- アカウントの顔ぶれ・開いているチャットのアカウントが変わったときだけ取りにいく（関数は描画ごとに作り直されるため入れない）
  }, [openRoomAccount, sendAsAccountsKey]);

  return { sendAsByAccount, setSendAsByAccount, myAddressesFor, getSendAs };
}
