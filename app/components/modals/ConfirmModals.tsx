import { useState } from "react";
import { keysOf, type RoomKeyStr } from "../../lib/roomKey";
import type { MailAppHook } from "../../hooks/useMailApp";
import type { Email } from "../../types/email";
import type { ModalState } from "../../types/mail";

function ChatHideConfirm({ app, modal }: { app: MailAppHook; modal: NonNullable<ModalState> }) {
  const [unhideOnNew, setUnhideOnNew] = useState(false);
  const { safeBack, exitAfterAction, updateChatConfigByRoomKey, setSelectedSender } = app.actions;
  const { selectedSender } = app.state;

  const handleExecute = () => {
    modal.targets.forEach((target: string) => {
      updateChatConfigByRoomKey(target as RoomKeyStr, { isHidden: true, hiddenAtDate: new Date().toISOString(), unhideOnNew });
    });
    if (selectedSender !== null && modal.targets.includes(selectedSender)) setSelectedSender(null);
    exitAfterAction();
  };

  return (
    <div className="p-5">
      <h2 className="text-lg font-bold text-white mb-2">非表示(Re:Mailのみ)</h2>
      <p className="text-sm text-gray-300 mb-4 leading-relaxed">
        選択した{modal.targets.length}件のチャットをRe:Mailの画面上から隠します。
      </p>
      <label className="flex items-center gap-3 cursor-pointer hover:bg-[#2B2D31] p-2 rounded transition mb-6 text-sm text-gray-200">
        <input
          type="checkbox"
          checked={unhideOnNew}
          onChange={(e) => setUnhideOnNew(e.target.checked)}
          className="accent-[#5865F2] w-4 h-4"
        />
        新着メッセージがあった際に自動で非表示を解除する
      </label>
      <div className="flex justify-end gap-3">
        <button onClick={() => safeBack()} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
        <button onClick={handleExecute} className="px-4 py-2 bg-[#5865F2] text-white rounded text-sm font-bold hover:bg-[#4752C4]">非表示にする</button>
      </div>
    </div>
  );
}

// 確認のモーダルで、選んだチャット／メッセージのうち、いま表示している場所（受信箱〜ゴミ箱のチェック）のメールを集める
function getActionableEmails(app: MailAppHook, targets: string[], targetMode: string) {
  const { checkTrash, checkSpam, checkInbox, checkArchive, checkSent, revealedCrossPrompts } = app.state;
  const { groupedEmails, allUniqueEmails } = app.computed;
  let result: Email[] = [];
  if (targetMode === "chat") {
    targets.forEach((chat: string) => {
      const chatEmails = groupedEmails[chat as RoomKeyStr] || [];
      result.push(...chatEmails.filter((e) => {
        const isTrash = e.labelIds?.includes("TRASH");
        const isSpam = e.labelIds?.includes("SPAM");
        const isInbox = e.labelIds?.includes("INBOX");
        const isSent = e.labelIds?.includes("SENT") || e.isMe; // ★追加
        const isArchive = !isTrash && !isSpam && !isInbox && !isSent; // ★修正
        
        // ★修正: checkSent の判定を追加
        const isCurrentBox = (isTrash && checkTrash) || (isSpam && checkSpam) || (isInbox && checkInbox) || (isSent && checkSent) || (isArchive && checkArchive);
        return isCurrentBox || revealedCrossPrompts.includes(e.id);
      }));
    });
  } else {
    result = allUniqueEmails.filter((e) => targets.includes(e.id));
  }
  return result;
}

// ピン留め（永続読み込み）の確認
export function ConfirmPinModal({ app, modal }: { app: MailAppHook; modal: NonNullable<ModalState> }) {
  const { chatConfigs, messageConfigs } = app.state;
  const { executePin, safeBack } = app.actions;
  const isChatMode = modal.targetMode === "chat";
  const existingForcePinnedChats = keysOf(chatConfigs).filter(k =>
    chatConfigs[k]?.isPinned && chatConfigs[k]?.forceFetch
  );
  const existingPinnedMsgCount = keysOf(messageConfigs).filter(k =>
    messageConfigs[k]?.isPinned && messageConfigs[k]?.forceFetch
  ).length;
  const newToPin = isChatMode
    ? modal.targets.filter((t: string) => !existingForcePinnedChats.includes(t as RoomKeyStr))
    : modal.targets;
  const willExceedLimit = isChatMode
    ? existingForcePinnedChats.length + newToPin.length > 10
    : existingPinnedMsgCount + newToPin.length > 100;
  const limitText = isChatMode
    ? `現在 ${existingForcePinnedChats.length} 件 / 上限 10 件`
    : `現在 ${existingPinnedMsgCount} 件 / 上限 100 件`;

  return (
    <div className="p-5">
      <h2 className="text-lg font-bold text-white mb-2">ピン留め（永続読み込み）</h2>
      <p className="text-sm text-gray-300 mb-2 leading-relaxed">
        選択した {modal.targets.length} 件の{isChatMode ? "チャット" : "メッセージ"}を永続読み込みでピン留めします。
      </p>
      <p className="text-xs text-gray-400 mb-6">{limitText}</p>
      {willExceedLimit && (
        <p className="text-xs text-[#DA373C] mb-4">
          上限を超えるため実行できません。既存のピン留めを解除してください。
        </p>
      )}
      <div className="flex justify-end gap-3">
        <button onClick={() => safeBack()} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
        <button
          onClick={() => executePin()}
          disabled={willExceedLimit}
          className={`px-4 py-2 rounded text-sm font-bold text-white transition ${willExceedLimit ? 'bg-[#3f4147] text-gray-500 cursor-not-allowed' : 'bg-[#5865F2] hover:bg-[#4752C4]'}`}
        >
          ピン留めする
        </button>
      </div>
    </div>
  );
}

// ピン留めの解除の確認
export function ConfirmUnpinModal({ app, modal }: { app: MailAppHook; modal: NonNullable<ModalState> }) {
  const { executeConfirmedAction, safeBack } = app.actions;
  return (
    <div className="p-5">
      <h2 className="text-lg font-bold text-white mb-2">ピン留めを解除</h2>
      <p className="text-sm text-gray-300 mb-6 leading-relaxed">
        選択した {modal.targets.length} 件の{modal.targetMode === "chat" ? "チャット" : "メッセージ"}のピン留めを解除しますか？
      </p>
      <div className="flex justify-end gap-3">
        <button onClick={() => safeBack()} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
        <button onClick={executeConfirmedAction} className="px-4 py-2 bg-[#5865F2] text-white rounded text-sm font-bold hover:bg-[#4752C4]">解除する</button>
      </div>
    </div>
  );
}

// 削除の確認
export function ConfirmDeleteModal({ app, modal }: { app: MailAppHook; modal: NonNullable<ModalState> }) {
  const { executeConfirmedAction, safeBack } = app.actions;
  const targetEmails = getActionableEmails(app, modal.targets, modal.targetMode);
  
  // ★修正: 対象となるのは「送信済みでもゴミ箱でもない」メールのみ
  const liveEmails = targetEmails.filter(e => !e.labelIds?.includes("SENT") && !e.isMe && !e.labelIds?.includes("TRASH"));
  
  const inboxCount = liveEmails.filter(e => e.labelIds?.includes("INBOX")).length;
  const spamCount = liveEmails.filter(e => e.labelIds?.includes("SPAM")).length;
  const archiveCount = liveEmails.filter(e => !e.labelIds?.includes("INBOX") && !e.labelIds?.includes("SPAM")).length;
  
  const toTrashCount = inboxCount + archiveCount + spamCount;
  
  return (
    <div className="p-5">
      <h2 className="text-lg font-bold text-white mb-2">削除の確認</h2>
      <p className="text-sm text-gray-300 mb-4 leading-relaxed">
        選択したアイテムを削除します。(対象: 合計 {liveEmails.length} 件)
      </p>
      <div className="bg-[#2B2D31] p-3 rounded border border-[#1E1F22] mb-5 space-y-2 text-[13px] text-gray-300">
        <div className="font-bold text-gray-400 border-b border-[#1E1F22] pb-1 mb-2 text-xs">【処理の内訳】</div>
        {toTrashCount > 0 ? (
          <div>
            ・受信箱: {inboxCount}件 / アーカイブ: {archiveCount}件 / 迷惑: {spamCount}件 <br/>
            <span className="text-[#FEE75C] ml-3">→ ゴミ箱へ移動します。</span>
          </div>
        ) : (
          <div className="text-gray-500">削除可能なアイテムがありません。</div>
        )}
      </div>
      <div className="flex justify-end gap-3">
        <button onClick={() => safeBack()} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
        <button onClick={executeConfirmedAction} disabled={toTrashCount === 0} className="px-4 py-2 bg-[#DA373C] text-white rounded text-sm font-bold hover:bg-[#a1282c] disabled:bg-[#3f4147] disabled:text-gray-500">削除する</button>
      </div>
    </div>
  );
}

// グループチャットの削除の確認
export function ConfirmDeleteGroupModal({ app, modal }: { app: MailAppHook; modal: NonNullable<ModalState> }) {
  const { safeBack, exitAfterAction } = app.actions;
  return (
    <div className="p-5">
      <h2 className="text-lg font-bold text-white mb-2">グループチャットの削除</h2>
      <p className="text-sm text-gray-300 mb-6 leading-relaxed">
        選択した{modal.targets.length}件のグループチャットのみを削除します。<br/>
        <span className="text-[#5865F2] font-bold">グループに含まれる個別のチャットや、実際のメール自体は削除されません。</span>
      </p>
      <div className="flex justify-end gap-3">
        <button onClick={() => safeBack()} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
        <button
          onClick={() => {
            modal.targets.forEach((room: string) => app.actions.deleteChatConfigByRoomKey(room as RoomKeyStr));
            exitAfterAction();
          }}
          className="px-4 py-2 bg-[#DA373C] text-white rounded text-sm font-bold hover:bg-[#a1282c]"
        >
          削除する
        </button>
      </div>
    </div>
  );
}

// 非表示の確認（チャットは ChatHideConfirm）
export function ConfirmHideModal({ app, modal }: { app: MailAppHook; modal: NonNullable<ModalState> }) {
  const { executeConfirmedAction, safeBack } = app.actions;
  if (modal.targetMode === "chat") {
    return <ChatHideConfirm app={app} modal={modal} />;
  }
  const targetEmails = getActionableEmails(app, modal.targets, modal.targetMode);
  const hideableCount = targetEmails.filter(e => !e.labelIds?.includes("TRASH") && !e.labelIds?.includes("SPAM")).length;

  return (
    <div className="p-5">
      <h2 className="text-lg font-bold text-white mb-2">非表示(Re:Mailのみ)</h2>
      <p className="text-sm text-gray-300 mb-6 leading-relaxed">
        選択した項目をRe:Mailの画面上から隠します。<br/>
        <span className="text-[#5865F2] font-bold">（対象となる受信箱・アーカイブ・送信済みのメール: {hideableCount}件）</span>
      </p>
      <div className="flex justify-end gap-3">
        <button onClick={() => safeBack()} className="px-4 py-2 hover:underline text-gray-300 text-sm">キャンセル</button>
        <button onClick={executeConfirmedAction} className="px-4 py-2 bg-[#5865F2] text-white rounded text-sm font-bold hover:bg-[#4752C4]">非表示にする</button>
      </div>
    </div>
  );
}
