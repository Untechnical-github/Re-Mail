import { useState } from "react";
import { signOut } from "next-auth/react";
import { WarningIcon } from "./ui";
import { keysOf, type RoomKeyStr } from "../lib/roomKey";
import type { MailAppHook } from "../hooks/useMailApp";
import type { Email } from "../types/email";
import type { ModalState } from "../types/mail";
import { clearDeviceData } from "../lib/deviceData";
import { ROLE_HINTS } from "../lib/composeRecipients";
import { ComposeNewChatModal } from "./modals/ComposeNewChatModal";
import { ModalTabs, accountTabLabel } from "./modals/shared";
import { ReplyTargetModal } from "./modals/ReplyTargetModal";
import { CategorizedActionSelect } from "./modals/CategorizedActionSelect";
export { EmailModal } from "./modals/EmailModal";
export { AttachmentModal } from "./modals/AttachmentModal";
export { SearchModal } from "./modals/SearchModal";
export { FilterToolModal } from "./modals/FilterToolModal";

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

export function Modals({ app }: { app: MailAppHook }) {
  // アカウントメニューで「ログアウト」を押したアカウント（確認を出している間だけ）
  const [logoutConfirm, setLogoutConfirm] = useState<string | null>(null);
  // 設定画面で開いているタブ（"common" か、アカウントのアドレス）
  const [settingsTab, setSettingsTab] = useState<string>("common");
  const { modal, renameInput, chatConfigs, messageConfigs, selectedIds, selectedSender, checkTrash, checkSpam, checkInbox, checkArchive, checkSent, revealedCrossPrompts } = app.state;
  const { executeConfirmedAction, executePin, setRenameInput, updateChatConfigByRoomKey, safeBack, exitAfterAction } = app.actions;
  const { groupedEmails, allUniqueEmails, hiddenChats, hiddenMsgs, pinnedChats, pinnedMsgs, nameChangedChats } = app.computed;

  if (!modal || modal.type === "search" || modal.type === "filter_tool") return null;

  const getActionableEmails = (targets: string[], targetMode: string) => {
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
  };

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={(e) => e.stopPropagation()}>
      <div className="bg-[#313338] rounded-md shadow-2xl w-full max-w-sm border border-[#1E1F22]">

        {modal.type === "categorized_action_select" && (
          <CategorizedActionSelect app={app} modal={modal} />
        )}

        {(modal.type === "compose_new_chat" || modal.type === "select_recipients") && (
          <ComposeNewChatModal app={app} modal={modal} />
        )}

        {modal.type === "account_menu" && (() => {
          // ログインしているアカウントを、どれも同じ扱いで並べる（最初にログインしたアカウントを特別に見せない）
          const me = app.auth?.session?.user?.email || "";
          const accounts = [me, ...((app.state.linkedAccounts as string[]) || [])].filter(Boolean);
          const profiles = app.state.linkedAccountProfiles as Record<string, { name?: string; picture?: string }>;
          const reauth = (app.state.reauthNeededAccounts as string[]) || [];
          return (
          <div className="p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-white">ログイン中のアカウント</h2>
              <button onClick={() => { setLogoutConfirm(null); safeBack(); }} className="text-gray-400 hover:text-white font-bold text-lg px-1 transition flex-shrink-0">×</button>
            </div>

            <div className="flex flex-col gap-1 mb-4">
              {accounts.map((a) => {
                const needsReauth = reauth.includes(a);
                const profile = a === me ? { name: app.auth?.session?.user?.name || undefined, picture: app.auth?.session?.user?.image || undefined } : profiles?.[a];
                return (
                  <div key={a} className="bg-[#2B2D31] rounded px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        {/* eslint-disable-next-line @next/next/no-img-element -- アカウントの小さなプロフィール画像。next/image の最適化は Worker の中継が増えるので使わない（ほかのアカウント画像と同じ） */}
                        <img
                          src={profile?.picture || `/api/avatar?name=${encodeURIComponent(profile?.name || a)}`}
                          alt=""
                          referrerPolicy="no-referrer"
                          className="w-8 h-8 rounded-full flex-shrink-0"
                        />
                        <div className="min-w-0">
                          {profile?.name && <div className="text-sm font-bold text-gray-200 truncate">{profile.name}</div>}
                          <div className={`truncate ${profile?.name ? "text-[11px] text-gray-400" : "text-sm text-gray-200"}`}>{a}</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {logoutConfirm === a ? (
                          <>
                            <button onClick={() => { setLogoutConfirm(null); void app.actions.logoutAccount(a); }} className="text-xs font-bold text-red-400 hover:text-red-300 px-1">はい</button>
                            <button onClick={() => setLogoutConfirm(null)} className="text-xs font-bold text-gray-400 hover:text-white px-1">いいえ</button>
                          </>
                        ) : (
                          <>
                            {needsReauth && (
                              <button
                                // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- API ルートが Google のログイン画面へ転送するので、ページごと移動する必要がある
                                onClick={() => { window.location.href = "/api/accounts/connect"; }}
                                className="text-xs font-bold text-[#FEE75C] hover:text-white px-2 flex items-center gap-1"
                                title="ログインが切れています。再ログインしてください"
                              >
                                <WarningIcon className="w-3.5 h-3.5" /> 再ログイン
                              </button>
                            )}
                            <button onClick={() => setLogoutConfirm(a)} className="text-xs font-bold text-red-400 hover:text-red-300 px-2">ログアウト</button>
                          </>
                        )}
                      </div>
                    </div>
                    {logoutConfirm === a && (
                      <div className="text-[11px] text-gray-400 mt-1">このアカウントだけログアウトします。ほかのアカウントはそのまま使えます。このアカウントの設定は残り、もう一度ログインすれば元どおりに使えます</div>
                    )}
                    {needsReauth && logoutConfirm !== a && (
                      <div className="text-[11px] text-[#FEE75C] mt-1">
                        ログインが切れているため、このアカウントのメールが読み込めていません。「再ログイン」からログインし直してください。
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="flex flex-col gap-2">
              <button
                // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- API ルートが Google のログイン画面へ転送するので、ページごと移動する必要がある
                onClick={() => { window.location.href = "/api/accounts/connect"; }}
                className="w-full text-left px-3 py-2.5 rounded bg-[#2B2D31] text-sm text-gray-200 hover:bg-[#35373C] transition font-bold"
              >
                + 別のアカウントでもログイン
              </button>
              <button
                onClick={async () => {
                  // ログアウトの前に、端末に残したメールの中身・下書き・添付を消す（共有の PC で次の人に見られないように）
                  await clearDeviceData();
                  await signOut({ callbackUrl: "/" });
                }}
                className="w-full text-left px-3 py-2.5 rounded bg-[#2B2D31] text-sm text-red-400 hover:bg-[#35373C] transition font-bold"
              >
                {accounts.length > 1 ? "すべてのアカウントからログアウト" : "ログアウト"}
              </button>
            </div>
          </div>
          );
        })()}

        {modal.type === "settings" && (() => {
          const me = app.auth?.session?.user?.email || "";
          const accounts = [me, ...((app.state.linkedAccounts as string[]) || [])].filter(Boolean);
          const profiles = app.state.linkedAccountProfiles as Record<string, { name?: string; picture?: string }>;
          const profileOf = (a: string) => a === me ? { name: app.auth?.session?.user?.name || undefined, picture: app.auth?.session?.user?.image || undefined } : profiles?.[a];
          const toggleClass = (on: boolean) => `flex-1 py-2 rounded text-sm font-bold transition ${on ? "bg-[#5865F2] text-white" : "bg-[#2B2D31] text-gray-400 hover:bg-[#35373C]"}`;
          // ログアウトしたアカウントのタブを開いたままにしない
          const tab = settingsTab === "common" || accounts.includes(settingsTab) ? settingsTab : "common";
          const tabs = [
            { key: "common", label: "共通", title: "どのアカウントでも同じ設定" },
            ...accounts.map(a => ({ key: a, label: accountTabLabel(a, profileOf(a)?.name), title: a })),
          ];
          return (
          <div className="p-5 overflow-y-auto" style={{ maxHeight: "85dvh" }}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-white">設定</h2>
              <button onClick={() => safeBack()} className="text-gray-400 hover:text-white font-bold text-lg px-1 transition flex-shrink-0">×</button>
            </div>

            <ModalTabs tabs={tabs} active={tab} onChange={setSettingsTab} />

            {/* 共通設定：どのアカウントでログインしても同じ（あとから追加したアカウントにも使われる） */}
            {tab === "common" && (
              <>
                <div className="text-[11px] text-gray-500 mb-3">どのアカウントでログインしても同じ設定になります。あとから追加したアカウントにも使われます。一覧の上の受信箱〜ゴミ箱・アカウントの表示のチェックも共通設定です</div>
                <div className="bg-[#2B2D31] rounded p-3">
                  <div className="text-sm font-bold text-gray-200 mb-1">送信ボタン・アクションバー・場所の表示</div>
                  <div className="text-xs text-gray-500 mb-3">送信ボタンや移動・削除などのボタン、受信箱〜ゴミ箱の表示を、文字ラベルとシンプルなアイコンのどちらで表示するか選べます（実験的な機能です）</div>
                  <div className="flex gap-2">
                    <button onClick={() => app.actions.setUseIconLabels(false)} className={toggleClass(!app.state.useIconLabels)}>文字</button>
                    <button onClick={() => app.actions.setUseIconLabels(true)} className={toggleClass(app.state.useIconLabels)}>アイコン</button>
                  </div>
                </div>
                {/* 宛先の表示（既定はオフ）。メールの詳細には、設定に関係なく To / Cc（送ったメールなら Bcc も）を出す */}
                {([
                  ["送ったメールに宛先の人数を表示する", "送ったメールの時間の横に「To 1・Cc 2・Bcc 1」のように出します", app.state.showSentRecipients, app.actions.setShowSentRecipients],
                  ["受け取ったメールに、自分がどの欄で受け取ったかを表示する", "受け取ったメールの時間の横に「To」か「Cc」を出します。どちらにも自分がいないときは「宛先に自分なし」と出します（Bcc・メーリングリスト・自動転送のどれかは分かりません）", app.state.showReceivedRecipients, app.actions.setShowReceivedRecipients],
                ] as const).map(([title, desc, on, set]) => (
                  <div key={title} className="bg-[#2B2D31] rounded p-3 mt-3">
                    <div className="text-sm font-bold text-gray-200 mb-1">{title}</div>
                    <div className="text-xs text-gray-500 mb-1">{desc}</div>
                    <div className="text-[11px] text-gray-500 mb-3">To：宛先 ／ Cc：ほかの人にも見せる（{ROLE_HINTS.cc}）／ Bcc：こっそり送る（{ROLE_HINTS.bcc}）</div>
                    <div className="flex gap-2">
                      <button onClick={() => set(false)} className={toggleClass(!on)}>オフ</button>
                      <button onClick={() => set(true)} className={toggleClass(on)}>オン</button>
                    </div>
                  </div>
                ))}
              </>
            )}

            {/* アカウントごとの設定：そのアカウントのメールにだけ使われる。そのアカウントだけでログインしたときも同じ */}
            {tab !== "common" && (() => {
              const a = tab;
              const profile = profileOf(a);
              const always = app.actions.alwaysLoadImagesFor(a);
              return (
                <>
                  <div className="flex items-center gap-2 mb-3 min-w-0">
                    {/* eslint-disable-next-line @next/next/no-img-element -- アカウントの小さなプロフィール画像。next/image の最適化は Worker の中継が増えるので使わない（ほかのアカウント画像と同じ） */}
                    <img
                      src={profile?.picture || `/api/avatar?name=${encodeURIComponent(profile?.name || a)}`}
                      alt=""
                      referrerPolicy="no-referrer"
                      className="w-6 h-6 rounded-full flex-shrink-0"
                    />
                    <div className="min-w-0">
                      {profile?.name && <div className="text-xs font-bold text-gray-300 truncate">{profile.name}</div>}
                      <div className="text-[11px] text-gray-500 truncate">{a} の設定（このアカウントのメールにだけ使われます）</div>
                    </div>
                  </div>
                  <div className="bg-[#2B2D31] rounded p-3">
                    <div className="text-sm font-bold text-gray-200 mb-1">メールの外部の画像</div>
                    <div className="text-xs text-gray-500 mb-3">「毎回読み込む」にすると、このアカウントのメールを開くたびに「画像を表示」を押さなくても画像が出ます。ただし画像を読み込んだ時点で、送り手に「メールを開いたこと・開いた日時・おおよその場所（IP アドレス）」が伝わることがあります</div>
                    <div className="flex gap-2">
                      <button onClick={() => app.actions.setAccountSetting(a, { alwaysLoadImages: false })} className={toggleClass(!always)}>押したときだけ</button>
                      <button onClick={() => app.actions.setAccountSetting(a, { alwaysLoadImages: true })} className={toggleClass(always)}>毎回読み込む</button>
                    </div>
                  </div>
                  {/* 既読：Gmail の既読と同じ（UNREAD ラベル）。既定はオフ（開いただけでは既読にしない） */}
                  {([
                    ["autoReadOnOpenChat", "チャットを開いたら既読にする", "オンにすると、このアカウントのチャットを開いたとき、そのチャットに表示されているメールを Gmail でも既読にします。開いている間に届いたメールも既読にします（画面を見ていないときは既読にしません）"],
                    ["autoReadOnOpenMail", "メールを開いたら既読にする", "オンにすると、このアカウントのメールを開いて詳細を表示したとき、そのメールを Gmail でも既読にします"],
                  ] as const).map(([key, title, desc]) => {
                    const on = !!app.state.accountSettings[a]?.[key];
                    return (
                      <div key={key} className="bg-[#2B2D31] rounded p-3 mt-3">
                        <div className="text-sm font-bold text-gray-200 mb-1">{title}</div>
                        <div className="text-xs text-gray-500 mb-3">{desc}</div>
                        <div className="flex gap-2">
                          <button onClick={() => app.actions.setAccountSetting(a, { [key]: false })} className={toggleClass(!on)}>オフ</button>
                          <button onClick={() => app.actions.setAccountSetting(a, { [key]: true })} className={toggleClass(on)}>オン</button>
                        </div>
                      </div>
                    );
                  })}
                </>
              );
            })()}
          </div>
          );
        })()}

        {modal.type === "confirm_pin" && (() => {
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
        })()}

        {modal.type === "confirm_unpin" && (
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
        )}

        {modal.type === "confirm_delete" && (() => {
          const targetEmails = getActionableEmails(modal.targets, modal.targetMode);
          
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
        })()}

        {modal.type === "confirm_delete_group" && (
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
        )}

        {modal.type === "confirm_hide" && (() => {
          if (modal.targetMode === "chat") {
            return <ChatHideConfirm app={app} modal={modal} />;
          }
          const targetEmails = getActionableEmails(modal.targets, modal.targetMode);
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
        })()}

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
