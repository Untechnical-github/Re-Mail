import type { FilterCriteria } from "../lib/filterMatch";

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
  // このグループの作成時に、まだ非表示になっていなかったのを新たに非表示にしたメンバーの一覧。
  // グループ削除時に、この一覧の分だけ非表示を解除する（グループ作成前から非表示だったものは触らない）
  groupHiddenMembers?: string[];
  // フィルターツールで作成したグループ用。存在する場合、このグループはアドレス集合ベースではなく
  // フィルター条件ベース（動的に再評価される）であることを示す
  filterCriteria?: FilterCriteria;
  // true の場合、フィルター条件に一致したメッセージを他の全ルーム（元の個別チャット等）から
  // 動的に除外する（groupedEmails側で毎回再計算されるため、明示的な復元処理は不要）
  filterHideOriginal?: boolean;
  // グループフィルター用。false の場合、作成時点（filterCreatedAt）より前の既存メールは
  // グループに含めず、それ以降に届いた新着メールだけを対象にする。未指定/true は既存メールも含める（デフォルト）
  filterIncludeExisting?: boolean;
  // フィルターツールの非グループ系アクション（非表示/ピン留め/移動/削除）を「継続」で保存した場合のみ設定される。
  // isGroup とは排他的に使う（filterAction が設定されている行はグループではない）
  filterAction?: "hide" | "pin" | "move" | "delete";
  // true = 継続（新着メールにも自動適用され続ける）。継続のフィルターのみこの行自体が永続化される
  filterContinuous?: boolean;
  // move専用: 移動先のGmailラベル（INBOX/ARCHIVE/SPAM/TRASH）
  filterDestination?: string;
  // 継続フィルターの作成時刻（ISO）
  filterCreatedAt?: string;
  // 継続フィルターが新着メールを最後に自動適用した時刻（ISO）。この時刻より新しい日時のメールだけが次回の自動走査対象になる
  filterLastAppliedAt?: string;
};

export type SelectionMode = "none" | "chat_select" | "msg_select" | "chat_hide" | "chat_delete" | "msg_hide" | "msg_delete" | "chat_pin" | "msg_pin" | "chat_reset" | "msg_reset" | "chat_move" | "msg_move";

export type ModalState = {
  type: "confirm_delete" | "confirm_hide" | "confirm_unhide" | "unhide_select" | "rename" | "confirm_pin" | "confirm_unpin" | "confirm_reset" | "select_move_dest" | "select_move_dest_context" | "confirm_move" | "categorized_action_select" | "select_reply_target" | "compose_new_chat" | "confirm_delete_group" | "search" | "account_menu" | "filter_tool";
  targetMode: "chat" | "msg" | "all_chats" | "current_chat" | "specific_chat";
  targets: any[];
  action?: "pin" | "hide" | "delete" | "move";
  refinedTargets?: string[];
  // compose_new_chat 用: "forward" のとき、宛先選択後のボタンは「転送」になり、
  // forwardMessage を選択した宛先へ転送する（新しいチャットを開いたりグループを作ったりはしない）
  composeMode?: "create" | "forward";
  forwardMessage?: any;
} | null;
