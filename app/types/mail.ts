export type GroupMode = "normal" | "inbound_only" | "outbound_only";

export type ChatConfig = {
  customName?: string;
  isPinned?: boolean;
  isHidden?: boolean;
  hiddenAtDate?: string;
  unhideOnNew?: boolean;
  forceFetch?: boolean;
  persistedData?: any;
  roomId?: string;
  isGroup?: boolean;
  groupMembers?: string[];
  // groupMembers と同じ並び順でのメンバーの実メールアドレス。作成時に一度だけ確定させて保存する
  // （メンバー数分だけの固定サイズなので、送信のたびに増え続けるデータにはならない）
  groupMemberAddresses?: string[];
  groupMode?: GroupMode;
};

export type SelectionMode = "none" | "chat_select" | "msg_select" | "chat_hide" | "chat_delete" | "msg_hide" | "msg_delete" | "chat_pin" | "msg_pin" | "chat_reset" | "msg_reset" | "chat_move" | "msg_move";

export type ModalState = {
  type: "confirm_delete" | "confirm_hide" | "confirm_unhide" | "unhide_select" | "rename" | "confirm_pin" | "confirm_unpin" | "confirm_reset" | "select_move_dest" | "select_move_dest_context" | "confirm_move" | "categorized_action_select" | "select_reply_target" | "compose_new_chat" | "confirm_delete_group";
  targetMode: "chat" | "msg" | "all_chats" | "current_chat" | "specific_chat";
  targets: any[];
  action?: "pin" | "hide" | "delete" | "move";
  refinedTargets?: string[];
} | null;
