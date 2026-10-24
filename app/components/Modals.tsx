import { useState } from "react";
import type { RoomKeyStr } from "../lib/roomKey";
import type { MailAppHook } from "../hooks/useMailApp";
import type { Email } from "../types/email";
import { ComposeNewChatModal } from "./modals/ComposeNewChatModal";
import { ReplyTargetModal } from "./modals/ReplyTargetModal";
import { CategorizedActionSelect } from "./modals/CategorizedActionSelect";
import { AccountMenuModal } from "./modals/AccountMenuModal";
import { SettingsModal } from "./modals/SettingsModal";
import { ConfirmPinModal, ConfirmUnpinModal, ConfirmDeleteModal, ConfirmDeleteGroupModal, ConfirmHideModal } from "./modals/ConfirmModals";
export { EmailModal } from "./modals/EmailModal";
export { AttachmentModal } from "./modals/AttachmentModal";
export { SearchModal } from "./modals/SearchModal";
export { FilterToolModal } from "./modals/FilterToolModal";

export function Modals({ app }: { app: MailAppHook }) {
  // アカウントメニューで「ログアウト」を押したアカウント（確認を出している間だけ）
  const [logoutConfirm, setLogoutConfirm] = useState<string | null>(null);
  // 設定画面で開いているタブ（"common" か、アカウントのアドレス）
  const [settingsTab, setSettingsTab] = useState<string>("common");
  const { modal, renameInput, chatConfigs, messageConfigs, selectedIds, selectedSender } = app.state;
  const { setRenameInput, updateChatConfigByRoomKey, safeBack, exitAfterAction } = app.actions;
  const { hiddenChats, hiddenMsgs, pinnedChats, pinnedMsgs, nameChangedChats } = app.computed;

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

        {modal.type === "reset_select" && (() => {
          const scope = modal.resetScope || "all";
          const targetChatIds = new Set(modal.targets as string[]);
          const inScope = (roomId: string | undefined) => scope === "all" || (roomId !== undefined && targetChatIds.has(roomId));

          // 選択中チャットが非表示ということはあり得ない（非表示チャットはそもそも一覧に出ず選べない）ため、
          // specificスコープでは「非表示のチャット」欄は出さず、メッセージのみを対象にする
          const hideChatItems: string[] = scope === "all" ? hiddenChats : [];
          const hideMsgItems = (hiddenMsgs as Email[]).filter((m) => inScope(messageConfigs[app.actions.messageConfigKey(m.id)]?.roomId));
          const pinChatItems: string[] = scope === "all" ? pinnedChats : pinnedChats.filter((c: string) => targetChatIds.has(c));
          const pinMsgItems = (pinnedMsgs as Email[]).filter((m) => inScope(messageConfigs[app.actions.messageConfigKey(m.id)]?.roomId));
          const nameChatItems: string[] = scope === "all" ? nameChangedChats : nameChangedChats.filter((c: string) => targetChatIds.has(c));

          const key = (category: string, level: string, id: string) => `${category}:${level}:${id}`;
          const totalCount = hideChatItems.length + hideMsgItems.length + pinChatItems.length + pinMsgItems.length + nameChatItems.length;

          const renderChatRow = (category: string, c: string) => (
            <label key={key(category, "chat", c)} className="flex items-center gap-3 p-2 hover:bg-[#2B2D31] rounded cursor-pointer">
              <input type="checkbox" checked={selectedIds.includes(key(category, "chat", c))} onChange={() => app.actions.toggleSelection(key(category, "chat", c))} className="accent-[#5865F2]" />
              <span className="text-sm truncate">{chatConfigs[c as RoomKeyStr]?.customName || app.actions.roomLocalKey(c)}</span>
            </label>
          );
          const renderMsgRow = (category: string, m: Email) => {
            const roomId = messageConfigs[app.actions.messageConfigKey(m.id)]?.roomId;
            const chatName = roomId ? (chatConfigs[roomId]?.customName || app.actions.roomLocalKey(roomId)) : "不明なチャット";
            return (
              <label key={key(category, "msg", m.id)} className="flex items-center gap-3 p-2 hover:bg-[#2B2D31] rounded cursor-pointer">
                <input type="checkbox" checked={selectedIds.includes(key(category, "msg", m.id))} onChange={() => app.actions.toggleSelection(key(category, "msg", m.id))} className="accent-[#5865F2]" />
                <div className="text-sm truncate flex-1 flex flex-col gap-0.5">
                  <span className="text-[11px] text-[#5865F2] font-bold truncate">{chatName}</span>
                  <div className="text-gray-200 truncate">
                    <span className="text-gray-400 text-xs mr-2">{new Date(m.date).toLocaleDateString()}</span>
                    {m.subject || m.snippet || "(件名なし)"}
                  </div>
                </div>
              </label>
            );
          };

          return (
            <div className="flex flex-col max-h-[80vh]">
              <div className="p-4 border-b border-[#1E1F22]">
                <h2 className="text-lg font-bold text-white">設定のリセット</h2>
                <p className="text-xs text-gray-400 mt-1">
                  {scope === "all" ? "すべてのチャット・メッセージが対象です" : `選択した${targetChatIds.size}件のチャットが対象です`}
                </p>
              </div>
              <div className="p-2 overflow-y-auto flex-1 space-y-4">
                <div>
                  <div className="text-xs font-bold text-gray-400 mb-1.5 px-2">非表示</div>
                  {hideChatItems.length > 0 && (
                    <div className="mb-2">
                      <div className="text-[10px] font-bold text-gray-500 mb-1 px-2">チャット</div>
                      {hideChatItems.map((c: string) => renderChatRow("hide", c))}
                    </div>
                  )}
                  {hideMsgItems.length > 0 && (
                    <div>
                      <div className="text-[10px] font-bold text-gray-500 mb-1 px-2">メッセージ</div>
                      {hideMsgItems.map((m) => renderMsgRow("hide", m))}
                    </div>
                  )}
                  {hideChatItems.length === 0 && hideMsgItems.length === 0 && <div className="text-gray-500 text-xs p-2 px-4">対象はありません</div>}
                </div>
                <div className="border-t border-[#1E1F22]/50 pt-2">
                  <div className="text-xs font-bold text-gray-400 mb-1.5 px-2">ピン留め</div>
                  {pinChatItems.length > 0 && (
                    <div className="mb-2">
                      <div className="text-[10px] font-bold text-gray-500 mb-1 px-2">チャット</div>
                      {pinChatItems.map((c: string) => renderChatRow("pin", c))}
                    </div>
                  )}
                  {pinMsgItems.length > 0 && (
                    <div>
                      <div className="text-[10px] font-bold text-gray-500 mb-1 px-2">メッセージ</div>
                      {pinMsgItems.map((m) => renderMsgRow("pin", m))}
                    </div>
                  )}
                  {pinChatItems.length === 0 && pinMsgItems.length === 0 && <div className="text-gray-500 text-xs p-2 px-4">対象はありません</div>}
                </div>
                <div className="border-t border-[#1E1F22]/50 pt-2">
                  <div className="text-xs font-bold text-gray-400 mb-1.5 px-2">名前変更（チャットのみ）</div>
                  {nameChatItems.map((c: string) => renderChatRow("name", c))}
                  {nameChatItems.length === 0 && <div className="text-gray-500 text-xs p-2 px-4">対象はありません</div>}
                </div>
                {totalCount === 0 && <div className="text-gray-500 text-sm p-4 text-center">リセットできる項目がありません</div>}
              </div>
              <div className="p-4 border-t border-[#1E1F22] flex justify-end gap-3">
                <button onClick={() => safeBack()} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
                <button
                  disabled={selectedIds.length === 0}
                  onClick={() => { app.actions.executeResetSelection(selectedIds); exitAfterAction(); }}
                  className="px-4 py-2 bg-[#DA373C] text-white rounded text-sm font-bold hover:bg-[#a1282c] disabled:bg-[#3f4147] disabled:text-gray-500"
                >
                  リセットする ({selectedIds.length})
                </button>
              </div>
            </div>
          );
        })()}

      </div>
    </div>
  );
}
