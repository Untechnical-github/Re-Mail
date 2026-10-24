import { useState } from "react";
import type { RoomKeyStr } from "../lib/roomKey";
import type { MailAppHook } from "../hooks/useMailApp";
import { ComposeNewChatModal } from "./modals/ComposeNewChatModal";
import { ReplyTargetModal } from "./modals/ReplyTargetModal";
import { CategorizedActionSelect } from "./modals/CategorizedActionSelect";
import { AccountMenuModal } from "./modals/AccountMenuModal";
import { SettingsModal } from "./modals/SettingsModal";
import { ConfirmPinModal, ConfirmUnpinModal, ConfirmDeleteModal, ConfirmDeleteGroupModal, ConfirmHideModal } from "./modals/ConfirmModals";
import { ResetSelectModal } from "./modals/ResetSelectModal";
export { EmailModal } from "./modals/EmailModal";
export { AttachmentModal } from "./modals/AttachmentModal";
export { SearchModal } from "./modals/SearchModal";
export { FilterToolModal } from "./modals/FilterToolModal";

export function Modals({ app }: { app: MailAppHook }) {
  // アカウントメニューで「ログアウト」を押したアカウント（確認を出している間だけ）
  const [logoutConfirm, setLogoutConfirm] = useState<string | null>(null);
  // 設定画面で開いているタブ（"common" か、アカウントのアドレス）
  const [settingsTab, setSettingsTab] = useState<string>("common");
  const { modal, renameInput, selectedSender } = app.state;
  const { setRenameInput, updateChatConfigByRoomKey, safeBack } = app.actions;

  if (!modal || modal.type === "search" || modal.type === "filter_tool") return null;

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={(e) => e.stopPropagation()}>
      <div className="bg-[#313338] rounded-md shadow-2xl w-full max-w-sm border border-[#1E1F22]">

        {modal.type === "categorized_action_select" && (
          <CategorizedActionSelect app={app} modal={modal} />
        )}

        {(modal.type === "compose_new_chat" || modal.type === "select_recipients") && (
          <ComposeNewChatModal app={app} modal={modal} />
        )}

        {modal.type === "account_menu" && <AccountMenuModal app={app} logoutConfirm={logoutConfirm} setLogoutConfirm={setLogoutConfirm} />}

        {modal.type === "settings" && <SettingsModal app={app} settingsTab={settingsTab} setSettingsTab={setSettingsTab} />}

        {modal.type === "confirm_pin" && <ConfirmPinModal app={app} modal={modal} />}

        {modal.type === "confirm_unpin" && <ConfirmUnpinModal app={app} modal={modal} />}

        {modal.type === "confirm_delete" && <ConfirmDeleteModal app={app} modal={modal} />}

        {modal.type === "confirm_delete_group" && <ConfirmDeleteGroupModal app={app} modal={modal} />}

        {modal.type === "confirm_hide" && <ConfirmHideModal app={app} modal={modal} />}

        {modal.type === "select_send_account" && (() => {
          // 返信欄の「送信元」の切り替え。選んだアカウントで、同じ相手とのチャットを開く
          const me = app.auth?.session?.user?.email || "";
          const accounts = [me, ...((app.state.linkedAccounts as string[]) || [])].filter(Boolean);
          const current = selectedSender ? app.actions.roomAccountEmail(selectedSender) : "";
          const profiles = app.state.linkedAccountProfiles as Record<string, { name?: string; picture?: string }>;
          const reauth = (app.state.reauthNeededAccounts as string[]) || [];
          return (
            <div className="p-5">
              <h2 className="text-lg font-bold text-white mb-1">送信元のアカウント</h2>
              <div className="text-xs text-gray-500 mb-4">選んだアカウントで、この相手とのチャットを開きます（やり取りが無ければ新しいチャットになります）。入力中の本文・添付・送信先は引き継ぎ、返信元は外します（スレッドはアカウントごとのため）</div>
              <div className="flex flex-col gap-1 mb-4">
                {accounts.map((a) => {
                  const isCurrent = a.toLowerCase() === current.toLowerCase();
                  const needsReauth = reauth.includes(a);
                  const profile = a === me ? { name: app.auth?.session?.user?.name || undefined, picture: app.auth?.session?.user?.image || undefined } : profiles?.[a];
                  return (
                    <button
                      key={a}
                      disabled={isCurrent || needsReauth}
                      onClick={() => { void app.actions.switchSendAccount(a); }}
                      className={`w-full flex items-center gap-2 px-3 py-2 rounded text-left transition ${isCurrent ? "bg-[#5865F2]/20 border border-[#5865F2]" : needsReauth ? "bg-[#1E1F22] opacity-50 cursor-not-allowed" : "bg-[#2B2D31] hover:bg-[#35373C]"}`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element -- アカウントの小さなプロフィール画像。next/image の最適化は Worker の中継が増えるので使わない（ほかのアカウント画像と同じ） */}
                      <img src={profile?.picture || `/api/avatar?name=${encodeURIComponent(profile?.name || a)}`} alt="" referrerPolicy="no-referrer" className="w-7 h-7 rounded-full flex-shrink-0" />
                      <div className="min-w-0 flex-1">
                        {profile?.name && <div className="text-sm font-bold text-gray-200 truncate">{profile.name}</div>}
                        <div className={`truncate ${profile?.name ? "text-[11px] text-gray-400" : "text-sm text-gray-200"}`}>{a}</div>
                      </div>
                      <span className="text-[11px] font-bold flex-shrink-0 text-gray-400">{isCurrent ? "使用中" : needsReauth ? "再ログインが必要" : ""}</span>
                    </button>
                  );
                })}
              </div>
              {/* エイリアスは選ぶものではなく、純正 Gmail と同じく元のメールの宛先に合わせて自動で決まる（pickSendAs） */}
              {(() => {
                const aliases = ((app.state.sendAsByAccount as Record<string, { sendAsEmail: string }[]>)[current] || []).filter(a => a.sendAsEmail.toLowerCase() !== current.toLowerCase());
                if (aliases.length === 0) return null;
                return (
                  <div className="text-[11px] text-gray-500 mb-4">
                    {current} のエイリアス：{aliases.map(a => a.sendAsEmail).join("、")}。どのアドレスから送るかは、純正 Gmail と同じく返信元のメールの宛先に合わせて自動で決まります（返信元が無いときは Gmail の既定の送信元）
                  </div>
                );
              })()}
              <button onClick={() => safeBack()} className="w-full py-2 hover:underline text-gray-400 text-sm">キャンセル</button>
            </div>
          );
        })()}

        {modal.type === "select_reply_target" && <ReplyTargetModal app={app} />}

        {modal.type === "rename" && (
          <div className="p-5">
            <h2 className="text-lg font-bold text-white mb-4">名前の変更</h2>
            <input
              type="text"
              value={renameInput}
              onChange={(e) => setRenameInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  updateChatConfigByRoomKey(modal.targets[0] as RoomKeyStr, { customName: renameInput.trim() || undefined });
                  safeBack();
                }
              }}
              className="w-full bg-[#1E1F22] text-white px-3 py-2 rounded focus:outline-none focus:ring-1 focus:ring-[#5865F2] mb-4"
              autoFocus
              placeholder="カスタム名を入力..."
            />
            <div className="flex justify-end gap-3">
              <button onClick={() => safeBack()} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
              <button
                onClick={() => {
                  updateChatConfigByRoomKey(modal.targets[0] as RoomKeyStr, { customName: renameInput.trim() || undefined });
                  safeBack();
                }}
                className="px-4 py-2 bg-[#5865F2] text-white rounded text-sm font-bold hover:bg-[#4752C4]"
              >
                変更する
              </button>
            </div>
          </div>
        )}

        {modal.type === "reset_select" && <ResetSelectModal app={app} modal={modal} />}

      </div>
    </div>
  );
}
