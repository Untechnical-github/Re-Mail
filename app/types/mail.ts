export type ChatConfig = {
  customName?: string;
  isPinned?: boolean;
  isHidden?: boolean;
  hiddenAtDate?: string;
  unhideOnNew?: boolean;
  forceFetch?: boolean;
  persistedData?: any;
  roomId?: string;
};

export type SelectionMode = "none" | "chat_select" | "msg_select" | "chat_hide" | "chat_delete" | "msg_hide" | "msg_delete" | "chat_pin" | "msg_pin" | "chat_reset" | "msg_reset" | "chat_move" | "msg_move";

export type ModalState = {
  type: "confirm_delete" | "confirm_hide" | "confirm_unhide" | "unhide_select" | "rename" | "confirm_pin" | "confirm_unpin" | "confirm_reset" | "select_move_dest" | "select_move_dest_context" | "confirm_move" | "categorized_action_select";
  targetMode: "chat" | "msg" | "all_chats" | "current_chat" | "specific_chat";
  targets: any[];
  action?: "pin" | "hide" | "delete" | "move";
  refinedTargets?: string[];
} | null;
