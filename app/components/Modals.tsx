import { useState } from "react";
import type { MailAppHook } from "../hooks/useMailApp";
import { ComposeNewChatModal } from "./modals/ComposeNewChatModal";
import { ReplyTargetModal } from "./modals/ReplyTargetModal";
import { CategorizedActionSelect } from "./modals/CategorizedActionSelect";
import { AccountMenuModal } from "./modals/AccountMenuModal";
import { SettingsModal } from "./modals/SettingsModal";
import { ConfirmPinModal, ConfirmUnpinModal, ConfirmDeleteModal, ConfirmDeleteGroupModal, ConfirmHideModal } from "./modals/ConfirmModals";
import { ResetSelectModal } from "./modals/ResetSelectModal";
import { RenameModal } from "./modals/RenameModal";
import { SelectSendAccountModal } from "./modals/SelectSendAccountModal";
export { EmailModal } from "./modals/EmailModal";
export { AttachmentModal } from "./modals/AttachmentModal";
export { SearchModal } from "./modals/SearchModal";
export { FilterToolModal } from "./modals/FilterToolModal";

export function Modals({ app }: { app: MailAppHook }) {
  // アカウントメニューで「ログアウト」を押したアカウント（確認を出している間だけ）
  const [logoutConfirm, setLogoutConfirm] = useState<string | null>(null);
  // 設定画面で開いているタブ（"common" か、アカウントのアドレス）
  const [settingsTab, setSettingsTab] = useState<string>("common");
  const { modal } = app.state;

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

        {modal.type === "select_send_account" && <SelectSendAccountModal app={app} />}

        {modal.type === "select_reply_target" && <ReplyTargetModal app={app} />}

        {modal.type === "rename" && <RenameModal app={app} modal={modal} />}

        {modal.type === "reset_select" && <ResetSelectModal app={app} modal={modal} />}

      </div>
    </div>
  );
}
