// アカウントを1つだけログアウトする・連携を外す（ほかのアカウントはそのまま。端末のそのアカウントのデータを消す）。
// useMailApp.ts から分けた（動きは変えない）
import type { MutableRefObject } from "react";
import { signOut, type useSession } from "next-auth/react";
import type { Session } from "next-auth";
import type { Email } from "../types/email";
import { clearDeviceData, clearAccountDeviceData, DEVICE_OWNER_KEY } from "../lib/deviceData";
import { type RoomKeyStr, decodeRoomKey } from "../lib/roomKey";
import { logError } from "../lib/safeLog";
import type { SetState } from "./mailAppTypes";

export function useAccounts({
  session, updateSession, linkedAccountsRef, setLinkedAccounts, reauthNeededAccounts, setReauthNeededAccounts, setLinkedAccountProfiles,
  setEmails, setPersistedEmails, setCurrentNextPageTokens, selectedSender, setSelectedSender, showInfoToast, showErrorToast,
}: {
  session: Session | null;
  updateSession: ReturnType<typeof useSession>["update"];
  linkedAccountsRef: MutableRefObject<string[]>;
  setLinkedAccounts: SetState<string[]>;
  reauthNeededAccounts: string[];
  setReauthNeededAccounts: SetState<string[]>;
  setLinkedAccountProfiles: SetState<Record<string, { name?: string; picture?: string }>>;
  setEmails: SetState<Email[]>;
  setPersistedEmails: SetState<Email[]>;
  setCurrentNextPageTokens: SetState<Record<string, string | null>>;
  selectedSender: RoomKeyStr | null;
  setSelectedSender: SetState<RoomKeyStr | null>;
  showInfoToast: (message: string | null, durationMs?: number) => void;
  showErrorToast: (message: string) => void;
}) {
  // アカウント連携の解除。D1のlinked_accounts行だけを消す（chat_configsは再連携時に復元できるようあえて残す。
  // /api/accounts のDELETEハンドラ自体の方針と同じ）。ローカル側はそのアカウント分のメールを一覧から
  // 即座に取り除き、開いていたチャットがそのアカウントのものだった場合は閉じる
  // アカウントを1つだけログアウトする。ほかのアカウントはログインしたまま使える。
  // ログインのセッションを持っているアカウントをログアウトするときは、ほかのアカウントの1つにセッションを引き継ぐ
  // （サーバーの auth.ts）。ほかに使えるアカウントが無ければ、すべてログアウトする
  const logoutAccount = async (account: string) => {
    const me = session?.user?.email || "";
    if (account.toLowerCase() !== me.toLowerCase()) {
      await unlinkAccount(account);
      showInfoToast(`${account} からログアウトしました`, 2500);
      return;
    }
    const next = linkedAccountsRef.current.find(a => !reauthNeededAccounts.includes(a));
    if (!next) {
      await clearDeviceData();
      await signOut({ callbackUrl: "/" });
      return;
    }
    showInfoToast(`${account} からログアウトしています…`);
    try {
      const updated = await updateSession({ switchTo: next });
      if ((updated?.user?.email || "").toLowerCase() !== next.toLowerCase()) throw new Error("switch failed");
    } catch (e) {
      logError("accounts.logoutOne", {}, e);
      showErrorToast("ログアウトできませんでした。通信状況を確認して、もう一度お試しください。");
      return;
    }
    // ログアウトしたアカウントの端末のデータ（添付・ピン留めの中身・下書き）だけを消し、残りのアカウントの分は残す
    await clearAccountDeviceData(me);
    try {
      localStorage.setItem(DEVICE_OWNER_KEY, next);
      localStorage.removeItem("remail_selected_sender");
      localStorage.removeItem("remail_scroll_main");
    } catch { /* 端末の保存領域が使えなくても続ける */ }
    window.location.reload();
  };

  const unlinkAccount = async (accountEmail: string) => {
    const myEmail = session?.user?.email || "";
    setLinkedAccounts(prev => prev.filter(a => a !== accountEmail));
    linkedAccountsRef.current = linkedAccountsRef.current.filter(a => a !== accountEmail);
    setReauthNeededAccounts(prev => prev.filter(a => a !== accountEmail));
    setLinkedAccountProfiles(prev => {
      const next = { ...prev };
      delete next[accountEmail];
      return next;
    });
    setEmails(prev => prev.filter((e) => (e.accountId || myEmail) !== accountEmail));
    setCurrentNextPageTokens(prev => {
      const next = { ...prev };
      delete next[accountEmail];
      return next;
    });
    if (selectedSender) {
      try {
        if (decodeRoomKey(selectedSender).accountEmail === accountEmail) {
          setSelectedSender(null);
          if (typeof window !== "undefined") {
            localStorage.removeItem("remail_selected_sender");
            localStorage.removeItem("remail_scroll_main");
          }
        }
      } catch { /* 複合キーでない古いデータは無視 */ }
    }
    setPersistedEmails(prev => prev.filter((e) => (e.accountId || myEmail) !== accountEmail));
    // 端末に残したそのアカウントの添付・ピン留めの中身・下書きを消す
    await clearAccountDeviceData(accountEmail);
    try {
      const res = await fetch(`/api/accounts?account_email=${encodeURIComponent(accountEmail)}`, { method: "DELETE" });
      if (!res.ok) showErrorToast("ログアウトがサーバーに反映されなかった可能性があります。再読み込みして確認してください。");
    } catch (e) {
      logError("accounts.unlink", {}, e);
      showErrorToast("ログアウトがサーバーに反映されなかった可能性があります。通信状況を確認してください。");
    }
  };

  return { logoutAccount, unlinkAccount };
}
