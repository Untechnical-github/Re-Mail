import { useSession, signOut } from "next-auth/react";
import { useState, useEffect, useMemo, useRef } from "react";
import { ChatConfig, MessageConfig, SelectionMode, ModalState } from "../types/mail";
import { Email } from "../types/email";
import { clearDeviceData, clearAccountDeviceData, DEVICE_OWNER_KEY } from "../lib/deviceData";
import { isComposeBodyEmpty } from "../lib/composeHtml";
import type { InlineImage } from "../lib/composeEditor";
import type { ComposeEditorApi } from "../components/ComposeEditor";
import { ChatListTab, chatConfigTab } from "../lib/filterMatch";
import { RoomKeyStr, asLocalKey, encodeRoomKey, decodeRoomKey, keysOf } from "../lib/roomKey";
import { type AccountSettings } from "../lib/syncedSettings";

import { type ComposeRecipient } from "../lib/composeRecipients";
import { missingPinnedEmail } from "../lib/pinnedIds";
import { loadPinnedCache, savePinnedCache } from "../lib/pinnedCache";
import { logError, logWarn } from "../lib/safeLog";
import { useSendAs } from "./useSendAs";
import { useConfigs } from "./useConfigs";
import { useDrafts, useDraftChatCleanup } from "./useDrafts";
import { useMailboxActions } from "./useMailboxActions";
import { useCompose } from "./useCompose";
import { useSend } from "./useSend";
import { useEmailModals } from "./useEmailModals";
import { useMailSync } from "./useMailSync";
import { useLoadMore } from "./useLoadMore";
import { useFindBar } from "./useFindBar";
import { useRooms } from "./useRooms";
import { useChatList } from "./useChatList";
import { useChatNavigation } from "./useChatNavigation";
import type { EmailModalState, AttachmentModalState } from "./mailAppTypes";
import { getSavedBoxSettings, getSavedAccountSettings } from "../lib/mailAppHelpers";

// 入力欄の確認画面（送信先を外す・チャットを移る・送信先を置き換える・返信／全員に返信・引用の注意）
export type ComposeDialog =
  | { kind: "confirm"; message: string; confirmLabel: string; cancelLabel?: string; onConfirm: () => void; onCancel?: () => void }
  | { kind: "replyChoice"; reply: ComposeRecipient[]; replyAll: ComposeRecipient[]; onPick: (list: ComposeRecipient[]) => void };

export function useMailApp() {
  const { data: session, status, update: updateSession } = useSession();
  const [emails, setEmails] = useState<Email[]>([]);
  const [persistedEmails, setPersistedEmails] = useState<Email[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedSender, setSelectedSender] = useState<RoomKeyStr | null>(() => {
    if (typeof window === "undefined") return null;
    // リロードやタブを閉じても開いていたメッセージ画面を復元できるよう localStorage に保存する
    const saved = localStorage.getItem("remail_selected_sender");
    if (!saved) return null;
    try {
      decodeRoomKey(saved);
      return saved as RoomKeyStr;
    } catch {
      // 読めない値は無視する（開いていたチャットを復元しないだけで、ほかは止めない）
      return null;
    }
  });
  const [chatConfigs, setChatConfigs] = useState<Record<RoomKeyStr, ChatConfig>>({} as Record<RoomKeyStr, ChatConfig>);
  // 個別メッセージ単位の設定（ピン留め・非表示）。room単位のchatConfigsとはキー空間が異なる
  // （chatConfigsのキーは相手名/group:xxxxのようなroom、こちらはGmailメッセージIDそのもの）
  const [messageConfigs, setMessageConfigs] = useState<Record<RoomKeyStr, MessageConfig>>({} as Record<RoomKeyStr, MessageConfig>);

  const [isLoadingMore, setIsLoadingMore] = useState(false);
  // メッセージ画面上部に表示するCtrl+F風の検索バー（キーワードのハイライト・上下移動を兼ねる）。
  // 検索モーダルの結果からジャンプして開く場合と、メッセージ画面の検索ボタンから直接開く場合がある
  const [findBarOpen, setFindBarOpen] = useState(false);
  const [findBarKeyword, setFindBarKeyword] = useState("");
  const [findBarMatchIndex, setFindBarMatchIndex] = useState(-1);
  // 検索バーの対象フィールド（件名/本文）。両方ONなら両方、片方だけなら片方の中のみを検索・ハイライト対象にする
  const [findBarSearchSubject, setFindBarSearchSubjectState] = useState(true);
  const [findBarSearchBody, setFindBarSearchBodyState] = useState(true);
  // 検索バー独自の場所フィルター（既存のチェックボックスとは非同期＝別管理）。件名/本文の絞り込みとは別枠で表示する
  const [findBarBoxFilter, setFindBarBoxFilter] = useState<Record<"inbox" | "archive" | "sent" | "spam" | "trash", boolean>>({
    inbox: true, archive: true, sent: true, spam: true, trash: true,
  });
  const skipFindBarAutoCloseRef = useRef(false);
  const hasPushedFindBarRef = useRef(false);
  // 設定画面での実験的なトグル: アクションバー・ボックスフィルター・送信ボタンの文字ラベルを
  // シンプルな単色アイコン表示に切り替える。この端末のブラウザにだけ保存する
  const [useIconLabels, setUseIconLabels] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("remail_use_icon_labels") === "true";
  });
  useEffect(() => {
    if (typeof window !== "undefined") localStorage.setItem("remail_use_icon_labels", String(useIconLabels));
  }, [useIconLabels]);
  // アカウント設定（アカウントごと。名前と型は app/lib/syncedSettings.ts の ACCOUNT_SETTING_TYPES）。
  // 今は「メールの外部の画像を、押さずに毎回読み込むか」だけ（既定はオフ。読み込むと送り手に開封が伝わる）。
  // そのアカウントの D1 の置き場所に持ち、ログアウトしても変えない。読み込むまでは既定（オフ）のまま
  const [accountSettings, setAccountSettings] = useState<Record<string, AccountSettings>>({});
  // 宛先の表示設定（共通設定・既定はオフ）。送ったメールに「To 1・Cc 2・Bcc 1」、受け取ったメールに自分の立場（To / Cc）を出す
  const [showSentRecipients, setShowSentRecipients] = useState(false);
  const [showReceivedRecipients, setShowReceivedRecipients] = useState(false);
  const [checkInbox, setCheckInbox] = useState<boolean>(() => getSavedBoxSettings()?.inbox ?? true);
  const [checkArchive, setCheckArchive] = useState<boolean>(() => getSavedBoxSettings()?.archive ?? true);
  const [checkSpam, setCheckSpam] = useState<boolean>(() => getSavedBoxSettings()?.spam ?? false);
  const [checkTrash, setCheckTrash] = useState<boolean>(() => getSavedBoxSettings()?.trash ?? false);
  const [checkSent, setCheckSent] = useState<boolean>(() => getSavedBoxSettings()?.sent ?? false);
  // アカウント別の表示チェックボックス。キーはアカウントのメールアドレス、値がfalseのアカウントのメールは
  // 個人/グループ/フィルターのどのタブでも表示されず、そのアカウントのメールしかないチャットは一覧からも消える
  const [checkAccounts, setCheckAccounts] = useState<Record<string, boolean>>(() => getSavedAccountSettings() ?? {});
  useEffect(() => {
    if (typeof window !== "undefined") localStorage.setItem("remail_account_settings", JSON.stringify(checkAccounts));
  }, [checkAccounts]);
  // メールの所属アカウント（e.accountId、未設定ならメインアカウント）がチェックボックスでオフになっていないか判定する。
  // 場所（受信箱/アーカイブ等）のチェックとは独立した、ハードなフィルター（revealedCrossPromptsによる個別解除は無い）
  const isAccountVisible = (accountId?: string) => checkAccounts[accountId || (session?.user?.email || "")] !== false;
  // チャット画面のタブ（個人チャット / グループチャット / フィルター）。設定ではなく画面の状態なので、
  // この端末のブラウザにだけ保存する（D1には保存しない＝他の端末には同期されない）ので、
  // リロード・タブを閉じる・ログアウトをまたいでも維持されるが、別端末には影響しない
  const [activeChatTab, setActiveChatTab] = useState<ChatListTab>(() => {
    if (typeof window === "undefined") return "individual";
    const saved = localStorage.getItem("remail_active_chat_tab");
    return saved === "group" || saved === "filter" ? saved : "individual";
  });
  useEffect(() => {
    if (typeof window !== "undefined") localStorage.setItem("remail_active_chat_tab", activeChatTab);
  }, [activeChatTab]);

  // タブ（個人/グループ/フィルター）ごとに一覧のスクロール位置を独立して保持する。
  // 切り替え前に必ず「今表示しているタブ」のスクロール位置を保存してから切り替える
  // （切り替え後に読み取ると、DOMは既に新タブの中身になっており、スクロール量も
  //   短い一覧に合わせてブラウザ側でクランプされてしまっていることがあるため）
  const changeChatTab = (newTab: ChatListTab) => {
    if (newTab === activeChatTab) return;
    if (typeof window !== "undefined") {
      const asideEl = document.querySelector("aside > div.flex-1.overflow-y-auto");
      if (asideEl) localStorage.setItem(`remail_scroll_aside_${activeChatTab}`, (asideEl as HTMLElement).scrollTop.toString());
    }
    setActiveChatTab(newTab);
  };

  // 切り替え後、そのタブ自身の保存済みスクロール位置を復元する
  useEffect(() => {
    if (typeof window === "undefined") return;
    requestAnimationFrame(() => {
      const saved = localStorage.getItem(`remail_scroll_aside_${activeChatTab}`);
      const asideEl = document.querySelector("aside > div.flex-1.overflow-y-auto");
      if (asideEl) (asideEl as HTMLElement).scrollTop = saved ? parseInt(saved, 10) : 0;
    });
  }, [activeChatTab]);

  // 開いているメッセージ画面が個人/グループ/フィルターのどれかに応じて、
  // チャット一覧のタブも自動的に合わせる（一覧から今開いているチャットが消えないように）
  useEffect(() => {
    if (!selectedSender) return;
    const wantTab = chatConfigTab(chatConfigs[selectedSender]);
    if (wantTab !== activeChatTab) changeChatTab(wantTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSender, chatConfigs]);
  // アカウントごとのGmail一覧取得ページトークン。キーはaccountEmail、値がnullならそのアカウントは
  // 読み込み終わり（トークン未取得＝まだ読み込んでいないアカウントとは区別する）
  const [currentNextPageTokens, setCurrentNextPageTokens] = useState<Record<string, string | null>>({});

  const [chatNextPageToken, setChatNextPageToken] = useState<string | null>("FIRST_PAGE");

  const [chatStatusMessage, setChatStatusMessage] = useState<string | null>(null);
  const [msgStatusMessage, setMsgStatusMessage] = useState<string | null>(null);
  const [isLoadingMoreChats, setIsLoadingMoreChats] = useState(false);

  const loadingMoreChatsRef = useRef(false);
  const loadingMoreMsgRef = useRef(false);
  const currentNextPageTokensRef = useRef<Record<string, string | null>>({});

  // 連携済みアカウントのメールアドレス一覧（メインアカウント自身は含まない）
  const [linkedAccounts, setLinkedAccounts] = useState<string[]>([]);
  const linkedAccountsRef = useRef<string[]>([]);
  useEffect(() => { linkedAccountsRef.current = linkedAccounts; }, [linkedAccounts]);
  // リフレッシュトークンが失効し再連携が必要な連携アカウント（linkedAccountsの部分集合）。
  // トークンリフレッシュに失敗しても連携アカウントのフェッチは黙ってスキップされるだけなので、
  // ここに載っているアカウントはUI側で警告バッジ等を出し、再連携（/api/accounts/connect）へ誘導する
  const [reauthNeededAccounts, setReauthNeededAccounts] = useState<string[]>([]);
  // 一覧の取得で、詳細を読み込めなかったメール（レート制限など）。アカウントごとのメッセージ ID。あれば画面で知らせる
  const [unloadedIds, setUnloadedIds] = useState<Record<string, string[]>>({});
  const unloadedCount = Object.values(unloadedIds).reduce((n, ids) => n + ids.length, 0);
  // 連携アカウントの表示専用プロフィール（名前・アバター画像）。認証・照合ロジックには一切使わず、
  // アカウントメニューやアイコン表示設定でのアバター表示だけに使う。連携済みでも古いデータや
  // 未再連携のアカウントはキーが無い場合があり、その時はメールアドレスから生成したアバターにフォールバックする
  const [linkedAccountProfiles, setLinkedAccountProfiles] = useState<Record<string, { name?: string; picture?: string }>>({});

  const [replySubject, setReplySubject] = useState("");
  // 入力欄の HTML（本文・引用・署名を1つの HTML のまま持つ。本文中の画像は cid:）と本文中の画像。
  // 入力欄（ComposeEditor）が変わるたびに少し待って知らせてくる。中身を入れ替えるときは loadCompose で editorLoad の番号を増やす
  const [composeHtml, setComposeHtml] = useState("");
  const [composeImages, setComposeImages] = useState<InlineImage[]>([]);
  const [editorLoad, setEditorLoad] = useState<{ seq: number; html: string; images: InlineImage[] }>({ seq: 0, html: "", images: [] });
  const editorApiRef = useRef<ComposeEditorApi | null>(null);
  // 最後に入れた署名（手で書き換えたかを見分けるため。下書きにも残す）
  const insertedSignatureRef = useRef<string | null>(null);
  const composeBodyEmpty = useMemo(() => isComposeBodyEmpty(composeHtml), [composeHtml]);
  const loadCompose = (html: string, images: InlineImage[]) => {
    setComposeHtml(html);
    setComposeImages(images);
    setEditorLoad(prev => ({ seq: prev.seq + 1, html, images }));
  };
  const onEditorChange = (html: string, images: InlineImage[]) => { setComposeHtml(html); setComposeImages(images); };
  // 今の入力欄の中身（知らせの待ち時間のあいだに打った分も含める）
  const currentCompose = (): { html: string; images: InlineImage[] } => {
    const api = editorApiRef.current;
    return api ? { html: api.getHtml(), images: api.getImages() } : { html: composeHtml, images: composeImages };
  };
  const [isSending, setIsSending] = useState(false);
  const [replyToMessage, setReplyToMessage] = useState<Email | null>(null);
  // 非同期の処理（送信元の設定を待つあいだ）で、まだ同じ返信元を選んでいるかを見るため
  const replyToMessageRef = useRef<Email | null>(null);
  useEffect(() => { replyToMessageRef.current = replyToMessage; }, [replyToMessage]);
  // 作成中のメールに添付するファイル（送信するまではローカルのbase64として保持する）
  const [replyAttachments, setReplyAttachments] = useState<{ filename: string; mimeType: string; size: number; data: string }[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  // 入力中の送信先（To / Cc / Bcc）。null は既定（開いているチャットの相手を To に1人）のまま。
  // recipientsBase は返信元を選んで置き換えたときの内容（そこから自分で変えたかの判定に使う。null は既定）
  const [recipients, setRecipients] = useState<ComposeRecipient[] | null>(null);
  const [recipientsBase, setRecipientsBase] = useState<ComposeRecipient[] | null>(null);
  const [composeDialog, setComposeDialog] = useState<ComposeDialog | null>(null);
  // 送信スペース（送信元・送信先・返信元・件名）を開いているか。送信スペースを押す・リプライを押すと開き、
  // 送信スペース以外を押す・メッセージ一覧のスクロールが始まるとたたむ（page.tsx。スクロールは TalkView.tsx から呼ぶ）
  const [composeActive, setComposeActive] = useState(false);

  // UI表示用: 複合キーからアカウント内のローカルな識別子（表示名など）だけを取り出す。
  // customNameが無いチャットのフォールバック表示など、Modals.tsx側で複合キーをそのまま
  // 画面に出してしまわないようにするために使う（roomKeyの直接パースを一元化するルールのため、
  // UI側はこのヘルパー経由でのみローカル部分を取得する）
  const roomLocalKey = (room: string): string => {
    try { return decodeRoomKey(room).localKey; } catch { return room; }
  };

  // UI表示用: 複合キーが属するアカウントのメールアドレスを取り出す（アカウントバッジ表示用）
  const roomAccountEmail = (room: string): string => {
    try { return decodeRoomKey(room).accountEmail; } catch { return session?.user?.email || ""; }
  };

  const openRoomAccount = selectedSender ? roomAccountEmail(selectedSender) : "";
  const sendAsAccountsKey = [session?.user?.email || "", ...((linkedAccounts as string[]) || [])].filter(Boolean).join(",");
  const { sendAsByAccount, setSendAsByAccount, myAddressesFor, getSendAs } = useSendAs({ sessionEmail: session?.user?.email || "", openRoomAccount, sendAsAccountsKey });

  const selectedSenderRef = useRef(selectedSender);
  useEffect(() => { selectedSenderRef.current = selectedSender; }, [selectedSender]);

  const [hasMouse, setHasMouse] = useState(true);
  const [isMobile, setIsMobile] = useState(false);
  const [selectionMode, setSelectionMode] = useState<SelectionMode>("none");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [modal, setModal] = useState<ModalState>(null);
  const [renameInput, setRenameInput] = useState("");
  const touchTimer = useRef<NodeJS.Timeout | null>(null);
  const [revealedCrossPrompts, setRevealedCrossPrompts] = useState<string[]>([]);
  // 返信元メッセージへジャンプしようとして見つからなかった場合のトースト表示
  const [replyNotFoundToast, setReplyNotFoundToast] = useState(false);
  const isJumpingToReplyRef = useRef(false);
  // 送信・転送・移動・削除など、alert()に頼らず一貫してユーザーに伝えたい汎用エラートースト
  const [errorToast, setErrorToast] = useState<string | null>(null);
  const errorToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 送信の結果が分からず、送信済みにも見つからなかったときの「再送しますか？」の確認
  // actionLabel は確認ダイアログの実行ボタンの文字（既定は「再送する」）
  const [sendConfirm, setSendConfirm] = useState<{ message: string; resend: () => Promise<void>; actionLabel?: string } | null>(null);
  // 転送中・転送完了など、エラーではない知らせ（null で消す。duration を省くと消えない）
  const [infoToast, setInfoToast] = useState<string | null>(null);
  const infoToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showInfoToast = (message: string | null, durationMs?: number) => {
    if (infoToastTimerRef.current) clearTimeout(infoToastTimerRef.current);
    setInfoToast(message);
    if (message && durationMs) infoToastTimerRef.current = setTimeout(() => setInfoToast(null), durationMs);
  };
  const showErrorToast = (message: string) => {
    // エラーを出すときは、「転送しています…」などの知らせは消す（古い知らせが残らないように）
    setInfoToast(null);
    if (errorToastTimerRef.current) clearTimeout(errorToastTimerRef.current);
    setErrorToast(message);
    errorToastTimerRef.current = setTimeout(() => setErrorToast(null), 4000);
  };
  // 下書き（チャットごとの入力中の内容と、まだ送っていない下書きチャット）は useDrafts.ts
  const { draftChats, draftChatsRef, addDraftChat, removeDraftChat, draftReadyRoom, carryDraftRef } = useDrafts({
    selectedSender, showErrorToast, setReplySubject, insertedSignatureRef, loadCompose, setReplyToMessage, setReplyAttachments, setRecipients, setRecipientsBase, setAttachError, replySubject, composeHtml, composeImages, replyToMessage, replyAttachments, recipients, recipientsBase,
  });

  // 連携アカウントの連携が切れたら、黙らずに知らせる（絶対ルール3）。メールが出ないだけでは気づけないため。
  // 同じアカウントは一度だけ知らせ、再連携して直ったあとにまた切れたら、もう一度知らせる
  const reauthNotifiedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const now = new Set(reauthNeededAccounts);
    for (const a of Array.from(reauthNotifiedRef.current)) if (!now.has(a)) reauthNotifiedRef.current.delete(a);
    const fresh = reauthNeededAccounts.filter(a => !reauthNotifiedRef.current.has(a));
    if (fresh.length === 0) return;
    fresh.forEach(a => reauthNotifiedRef.current.add(a));
    showErrorToast(`${fresh.join("、")} のログインが切れているため、メールを読み込めません。プロフィールのボタンから「再ログイン」してください。`);
  }, [reauthNeededAccounts]);

  // メッセージ折りたたみ・モーダル関連
  // collapseLinesCount: null = 折りたたまない（設定画面から変更予定）
  const [collapseLinesCount] = useState<number | null>(null);
  const [expandedMsgIds, setExpandedMsgIds] = useState<string[]>([]);
  const [emailModal, setEmailModal] = useState<EmailModalState>(null);

  const [attachmentModal, setAttachmentModal] = useState<AttachmentModalState>(null);

  const [boxColors] = useState({
    inbox: "#5865F2", 
    archive: "#95A5A6",
    spam: "#FEE75C",  
    trash: "#DA373C",
    sent: "#1ABC9C"
  });

  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const hasPushedSelectRef = useRef(false);
  const activeLoadRef = useRef<number>(0);
  const signingOutRef = useRef(false);
  const isInitialFilterRun = useRef(true); 
  // この端末で前に別の人がログインしていた（ログアウトせずに切り替わった）場合は、前の人のデータを消す
  useEffect(() => {
    const me = session?.user?.email;
    if (!me) return;
    try {
      const owner = localStorage.getItem(DEVICE_OWNER_KEY);
      if (owner && owner !== me) {
        void clearDeviceData().then(() => { try { localStorage.setItem(DEVICE_OWNER_KEY, me); } catch { /* 保存できなくても動作は続ける */ } });
      } else if (!owner) {
        localStorage.setItem(DEVICE_OWNER_KEY, me);
      }
    } catch { /* 端末の保存領域が使えない環境では何も残っていない */ }
  }, [session?.user?.email]);

  const chatConfigsRef = useRef(chatConfigs);
  useEffect(() => { chatConfigsRef.current = chatConfigs; }, [chatConfigs]);
  const messageConfigsRef = useRef(messageConfigs);
  useEffect(() => { messageConfigsRef.current = messageConfigs; }, [messageConfigs]);

  const emailsRef = useRef(emails);
  useEffect(() => { emailsRef.current = emails; }, [emails]);



  // チャットを閉じたら展開状態をリセット
  useEffect(() => { setExpandedMsgIds([]); }, [selectedSender]);
  useEffect(() => { currentNextPageTokensRef.current = currentNextPageTokens; }, [currentNextPageTokens]);

  // チャット単位の LRU キャッシュ（チャット切り替え時に復元）
  const [chatCacheLimit, _setChatCacheLimit] = useState<number>(() => {
    if (typeof window === "undefined") return 10;
    const s = localStorage.getItem("remail_chat_cache_limit");
    return s ? Math.max(0, parseInt(s, 10)) : 10;
  });
  const chatCacheLimitRef = useRef<number>(chatCacheLimit);
  const setChatCacheLimit = (n: number) => {
    const v = Math.max(0, n);
    chatCacheLimitRef.current = v;
    _setChatCacheLimit(v);
    if (typeof window !== "undefined") localStorage.setItem("remail_chat_cache_limit", String(v));
    const cache = chatCacheRef.current;
    const sorted = [...cache.entries()].sort(([, a], [, b]) => a.lruTime - b.lruTime);
    while (cache.size > v) cache.delete(sorted.shift()![0]);
  };
  const chatCacheRef = useRef<Map<string, { emails: Email[]; chatNextPageToken: string | null; groupMemberTokens?: Record<string, string>; lruTime: number }>>(new Map());
  const chatNextPageTokenRef = useRef<string | null>("FIRST_PAGE");
  useEffect(() => { chatNextPageTokenRef.current = chatNextPageToken; }, [chatNextPageToken]);
  // グループチャットの「追加読み込み」用: メンバーごとに独立したページングトークンを保持する
  // （グループのローカルキー自体は group:xxxx でGmail検索語にならないため、chatNextPageToken
  // という単一の値では対応できず、メンバーのアドレスごとに個別のページングが必要になる）
  const groupMemberTokensRef = useRef<Record<string, string>>({});

  // フィルター単位のキャッシュ（フィルター切り替え時に復元）
  const filterCacheRef = useRef<Map<string, { emails: Email[]; currentNextPageTokens: Record<string, string | null> }>>(new Map());
  const filterKeyRef = useRef<string>("true-true-false-false-false");
  // emails state が実際にどのフィルターの取得結果を反映しているかを示す。
  // フィルターを連続で切り替えると、直前の取得がキャンセルされ emails が更新されないまま
  // filterKeyRef だけ次のキーに進んでしまうことがある。その状態でキャッシュへ書き込むと
  // 「まだ何も取得していない新フィルター」に「古いフィルターの中身」が誤って紐付いてしまい、
  // 次にそのフィルターへ戻ったときに空(または無関係)なキャッシュが復元される不具合になるため、
  // 実際に取得が完了したフィルターキーと filterKeyRef が一致する場合のみキャッシュを書き込む
  const emailsFilterKeyRef = useRef<string>(filterKeyRef.current);

  useEffect(() => {
    const handleStateSave = () => {
      const asideEl = document.querySelector("aside > div.flex-1");
      const mainEl = document.querySelector("main > div.flex-1");
      if (asideEl) localStorage.setItem(`remail_scroll_aside_${activeChatTab}`, asideEl.scrollTop.toString());
      if (mainEl) localStorage.setItem("remail_scroll_main", mainEl.scrollTop.toString());

      // 表示中のモーダル・選択中の内容・作成中の返信もリロード/タブを閉じた後に復元できるよう保存する。
      // emailModal/replyToMessage はデータ再取得後に同じメッセージを探し直すのではなく、
      // 表示に必要な内容そのものを保存しておく（再取得タイミングに依存させないため）
      const uiState = {
        selectionMode,
        selectedIds,
        modal,
        renameInput,
        // 入力中の返信はチャットごとの下書き（app/lib/drafts.ts）に保存するので、ここには入れない
        emailModalEmail: emailModal?.email ?? null,
        attachmentModal: attachmentModal ? {
          filename: attachmentModal.filename,
          mimeType: attachmentModal.mimeType,
          size: attachmentModal.size,
          attachmentId: attachmentModal.attachmentId,
          messageId: attachmentModal.messageId,
          cacheKey: attachmentModal.cacheKey,
        } : null,
      };
      try { localStorage.setItem("remail_ui_state", JSON.stringify(uiState)); } catch {}
    };
    const handleVisibilityHidden = () => {
      if (document.visibilityState === "hidden") handleStateSave();
    };

    // beforeunload はタブを閉じる際やモバイルで発火しないことがあるため、
    // pagehide / visibilitychange も併用して確実に保存する
    window.addEventListener("beforeunload", handleStateSave);
    window.addEventListener("pagehide", handleStateSave);
    document.addEventListener("visibilitychange", handleVisibilityHidden);
    return () => {
      window.removeEventListener("beforeunload", handleStateSave);
      window.removeEventListener("pagehide", handleStateSave);
      document.removeEventListener("visibilitychange", handleVisibilityHidden);
    };
  }, [selectedSender, selectionMode, selectedIds, modal, renameInput, replySubject, composeHtml, replyToMessage, emailModal, attachmentModal, activeChatTab]);

  const allUniqueEmails = useMemo(() => {
    const map = new Map();
    persistedEmails.forEach(e => map.set(e.id, e));
    emails.forEach(e => map.set(e.id, e));
    return Array.from(map.values());
  }, [emails, persistedEmails]);

  // ピン留めの中身を埋める。まず端末キャッシュから出し、無い分だけ Gmail から ID で取る。
  // Gmail で見つからなかったメッセージ単位のピン留めは、黙って消さず「このメールは存在しません」として出す
  const pinnedHydratedRef = useRef(false);
  const hydratePinnedEmails = async (chatCfgs: Record<RoomKeyStr, ChatConfig>, msgCfgs: Record<RoomKeyStr, MessageConfig>, have: Email[]) => {
    const myEmail = session?.user?.email || "";
    const haveIds = new Set(have.map(e => e.id));
    const need = new Map<string, Map<string, { room?: string; isMessagePin: boolean }>>();
    const add = (account: string, id: string, room: string | undefined, isMessagePin: boolean) => {
      if (haveIds.has(id)) return;
      if (!need.has(account)) need.set(account, new Map());
      need.get(account)!.set(id, { room, isMessagePin });
    };
    keysOf(chatCfgs).forEach(k => {
      const c = chatCfgs[k];
      if (!c?.isPinned || !c.forceFetch) return;
      const { accountEmail, localKey } = decodeRoomKey(k);
      (c.persistedIds || []).forEach(id => add(accountEmail, id, localKey, false));
    });
    keysOf(msgCfgs).forEach(k => {
      const c = msgCfgs[k];
      if (!c?.isPinned || !c.forceFetch) return;
      const { accountEmail, localKey } = decodeRoomKey(k);
      add(accountEmail, localKey, c.roomId ? decodeRoomKey(c.roomId).localKey : undefined, true);
    });

    const found: Email[] = [];
    try {
      for (const [account, wanted] of need) {
        const cache = await loadPinnedCache(account);
        const toFetch: string[] = [];
        wanted.forEach((info, id) => {
          const cached = cache[id];
          if (cached) found.push({ ...cached, senderRoom: info.room ?? cached.senderRoom, accountId: account });
          else toFetch.push(id);
        });
        // API 側の上限（1回50件）に合わせて分けて取る
        for (let i = 0; i < toFetch.length; i += 50) {
          const params = new URLSearchParams({ ids: toFetch.slice(i, i + 50).join(",") });
          if (account !== myEmail) params.append("accountEmail", account);
          const res = await fetch(`/api/emails?${params.toString()}`);
          if (!res.ok) { logWarn("pinned.fetch", { status: res.status }); continue; }
          const data = (await res.json()) as { messages?: Email[]; missing?: string[] };
          (data.messages || []).forEach(m => found.push({ ...m, senderRoom: wanted.get(m.id)?.room, accountId: account }));
          (data.missing || []).forEach(id => {
            const info = wanted.get(id);
            if (info?.isMessagePin) found.push(missingPinnedEmail(id, info.room, account));
          });
        }
      }
    } catch (e) {
      // 取れなかった分は表示されないだけで、ピン留め自体は残る（次の読み込みで取り直す）
      logError("pinned.hydrate", {}, e);
    } finally {
      pinnedHydratedRef.current = true;
    }
    setPersistedEmails(prev => {
      const ids = new Set(prev.map(e => e.id));
      return [...prev, ...found.filter(e => !ids.has(e.id))];
    });
  };

  // 同期処理（syncConfigs）が返したピン留めメールで置き換える。ただし、同期の時点で読み込めていなかった
  // だけでまだピン留めされているメール（端末キャッシュや Gmail から埋めたもの）は残す
  const applySyncedPersisted = (nextPMsgs: Email[]) => {
    const myEmail = session?.user?.email || "";
    const isStillPinned = (e: Email): boolean => {
      const account = e.accountId || myEmail;
      const msgCfg = messageConfigsRef.current[encodeRoomKey(account, asLocalKey(e.id))];
      if (msgCfg?.isPinned && msgCfg.forceFetch) return true;
      return keysOf(chatConfigsRef.current).some(k => {
        const c = chatConfigsRef.current[k];
        return !!(c?.isPinned && c.forceFetch && c.persistedIds?.includes(e.id) && decodeRoomKey(k).accountEmail === account);
      });
    };
    setPersistedEmails(prev => {
      const next = new Map(nextPMsgs.map(e => [e.id, e]));
      prev.forEach(e => { if (!next.has(e.id) && isStillPinned(e)) next.set(e.id, e); });
      return Array.from(next.values());
    });
  };

  // ピン留めメールの中身を端末キャッシュに書き戻す（アカウントごと）。D1 に中身を置かない代わりに、
  // 次に開いたときすぐ表示できるようにするため。読み込み前の空の状態でキャッシュを消さないよう、埋め終わってから書く
  useEffect(() => {
    if (!pinnedHydratedRef.current) return;
    const myEmail = session?.user?.email || "";
    const byAccount = new Map<string, Email[]>();
    [myEmail, ...linkedAccounts].forEach(a => { if (a) byAccount.set(a, []); });
    persistedEmails.forEach(e => {
      const account = e.accountId || myEmail;
      if (!account) return;
      if (!byAccount.has(account)) byAccount.set(account, []);
      byAccount.get(account)!.push(e);
    });
    byAccount.forEach((list, account) => { void savePinnedCache(account, list); });
  }, [persistedEmails, linkedAccounts, session?.user?.email]);

  // 設定の読み込み・保存（チャットの設定・共通設定・アカウント設定）は useConfigs.ts
  const {
    loadD1Configs, applySyncedSettings, setSyncedSettingsReady, savedSyncedKeyRef, setAccountSetting, alwaysLoadImagesFor, saveGlobalSettings, updateChatConfig, updateMessageConfig, deleteChatConfig, updateChatConfigByRoomKey, deleteChatConfigByRoomKey, syncConfigs,
  } = useConfigs({
    session, showErrorToast, showInfoToast, selectedSender, setSelectedSender, setChatConfigs, setMessageConfigs, chatConfigsRef, messageConfigsRef, setPersistedEmails, hydratePinnedEmails, accountSettings, setAccountSettings, checkInbox, checkArchive, checkSpam, checkTrash, checkSent, useIconLabels, showSentRecipients, showReceivedRecipients, checkAccounts, setCheckInbox, setCheckArchive, setCheckSpam, setCheckTrash, setCheckSent, setUseIconLabels, setShowSentRecipients, setShowReceivedRecipients, setCheckAccounts,
  });

  useEffect(() => {
    const mediaQuery = window.matchMedia('(pointer: fine)');
    setHasMouse(mediaQuery.matches);
    const handler = (e: MediaQueryListEvent) => setHasMouse(e.matches);
    mediaQuery.addEventListener('change', handler);
    const resizeHandler = () => setIsMobile(window.innerWidth < 768);
    resizeHandler();
    window.addEventListener('resize', resizeHandler);
    return () => { mediaQuery.removeEventListener('change', handler); window.removeEventListener('resize', resizeHandler); };
  }, []);

  // リロード/タブ復元で selectedSender が localStorage から直接セットされた場合や、
  // PC表示（両ペイン表示、履歴を積まない）でチャットを開いた後に画面幅が縮んでスマホ表示に
  // 切り替わった場合、openChat() の pushState を経由していないため history に "#chat" が積まれていない。
  // その状態のままモバイルの戻るボタン(safeBack)を押すと history.state に
  // 何も入っていないため「チャット画面を閉じる」が発火せず、画面が固定されてしまう。
  // isMobile・selectedSender のどちらが変化しても、その都度 history 側をチャットが開いている
  // 状態に揃え直す（safeBack 側のフォールバックと二重の保険にする）
  useEffect(() => {
    if (isMobile && selectedSender && window.location.hash !== '#chat') {
      window.history.pushState({ chat: selectedSender }, '', '#chat');
    }
  }, [isMobile, selectedSender]);

  useEffect(() => {
    const handlePopState = (e: PopStateEvent) => {
      const state = e.state;
      setModal(null);
      setEmailModal(null);
      setAttachmentModal(null);
      if (!state || state.action !== "select") { setSelectionMode("none"); setSelectedIds([]); hasPushedSelectRef.current = false; } else { hasPushedSelectRef.current = true; }
      if (!state || state.action !== "findbar") {
        setFindBarOpen(false); setFindBarKeyword(""); setFindBarMatchIndex(-1); hasPushedFindBarRef.current = false;
      } else { hasPushedFindBarRef.current = true; }
      if (window.innerWidth < 768 && window.location.hash !== '#chat') {
        setSelectedSender(null);
        localStorage.removeItem("remail_selected_sender");
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    if (!selectedSender && isMobile) {
      setTimeout(() => {
        const asideScroll = localStorage.getItem(`remail_scroll_aside_${activeChatTab}`);
        const asideEl = document.querySelector("aside > div.flex-1");
        if (asideScroll && asideEl) {
          asideEl.scrollTop = parseInt(asideScroll, 10);
        }
      }, 50);
    }
  }, [selectedSender, isMobile, activeChatTab]);

  // メールの詳細と添付のプレビューのモーダル・メッセージの折りたたみは useEmailModals.ts
  const { openEmailModal, closeEmailModal, openAttachmentModal, closeAttachmentModal, toggleMsgExpand } = useEmailModals({ session, setEmailModal, setAttachmentModal, setExpandedMsgIds, showErrorToast });

  // 一覧の取得と差分同期は useMailSync.ts
  const { searchServerSide, hasLoadedOnceRef, fetchChatCrossbox, fetchCrossboxForRoom, fetchGroupLoadMore, isRetryingUnloaded, retryUnloaded } = useMailSync({
    session, emailsRef, setEmails, setIsLoading, selectedSender, showErrorToast, signingOutRef, unloadedIds, setUnloadedIds,
    syncConfigs, chatConfigsRef, messageConfigsRef, applySyncedPersisted, loadD1Configs, applySyncedSettings, savedSyncedKeyRef, setSyncedSettingsReady, saveGlobalSettings,
    linkedAccountsRef, setLinkedAccounts, setReauthNeededAccounts, setLinkedAccountProfiles,
    checkInbox, checkArchive, checkSpam, checkTrash, checkSent, filterKeyRef, isInitialFilterRun, emailsFilterKeyRef, filterCacheRef, activeChatTab,
    setCurrentNextPageTokens, currentNextPageTokensRef, groupMemberTokensRef, setChatNextPageToken, chatNextPageTokenRef, setChatStatusMessage,
    setSelectionMode, setSelectedIds, setModal, setRenameInput, openEmailModal, openAttachmentModal, setRevealedCrossPrompts, activeLoadRef, searchTimeoutRef,
  });

  // フィルター変化時（チャットタブの切り替えを含む）に選択をキャンセル
  useEffect(() => {
    if (selectionMode === "none") return;
    setSelectionMode("none");
    setSelectedIds([]);
    if (hasPushedSelectRef.current) {
      hasPushedSelectRef.current = false;
      if (typeof window !== "undefined" && window.history.state?.action === "select") {
        window.history.back();
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkInbox, checkArchive, checkSpam, checkTrash, checkSent, activeChatTab]);

  // チャットを切り替えたら検索バーを閉じる。ただし検索結果からのジャンプ直後は消さない
  // （jumpToSearchResult が selectedSender を変えると同時に検索バーを開くため）
  // ここでは履歴操作はせず状態のリセットのみ行う（履歴側は closeFindBar / 戻る操作で整理される）
  useEffect(() => {
    if (skipFindBarAutoCloseRef.current) { skipFindBarAutoCloseRef.current = false; return; }
    if (findBarOpen) {
      setFindBarOpen(false);
      setFindBarKeyword("");
      setFindBarMatchIndex(-1);
      hasPushedFindBarRef.current = false;
    }
  }, [selectedSender]);

  // ルームの計算（チャットへの分け方・メッセージのルームとアカウント・相手・宛先の候補）は useRooms.ts
  const {
    groupedEmails, groupedEmailsRef, emailRoomMap, resolveMessageAccountEmail, messageConfigKey, getRoomPartner, getRoomRecipient, getRoomAddress, contactDirectory, groupReplyPools,
  } = useRooms({ session, chatConfigs, allUniqueEmails, sendAsByAccount, linkedAccounts, messageConfigsRef });

  // 下書きチャットから離れたとき、何も書いていなければ一覧から消す（useDrafts.ts）
  useDraftChatCleanup({
    selectedSender, selectedSenderRef, draftChatsRef, groupedEmailsRef, carryDraftRef, draftReadyRoom, currentCompose, replySubject, insertedSignatureRef, replyToMessage, replyAttachments, recipients, recipientsBase, removeDraftChat,
  });

  // チャット一覧（並び・非表示／ピン留め／名前を変えたものの一覧・消えたチャットを閉じる）は useChatList.ts
  const { senderList, hiddenChats, hiddenMsgs, pinnedChats, pinnedMsgs, nameChangedChats } = useChatList({
    session, groupedEmails, allUniqueEmails, chatConfigs, messageConfigs, messageConfigKey, isAccountVisible, checkAccounts,
    checkInbox, checkArchive, checkSpam, checkTrash, checkSent, revealedCrossPrompts, draftChats, hasLoadedOnceRef, isLoading, selectedSender, setSelectedSender,
  });

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

  // チャットを開く・作る・戻る・送信元のアカウントの切り替えは useChatNavigation.ts
  const { safeBack, exitAfterAction, openChat, resolveDirectRoom, createOrOpenChat, switchSendAccount, createGroupChat, createFilterGroup } = useChatNavigation({
    session, isMobile, setEmails, emailsRef, selectedSender, setSelectedSender, groupedEmails, chatConfigs, chatConfigsRef, activeChatTab, getRoomAddress, updateChatConfig,
    setModal, setSelectionMode, setSelectedIds, hasPushedSelectRef, chatCacheRef, chatCacheLimitRef, chatNextPageTokenRef, setChatNextPageToken, groupMemberTokensRef,
    setMsgStatusMessage, fetchCrossboxForRoom, fetchChatCrossbox, addDraftChat, carryDraftRef, currentCompose, insertedSignatureRef,
    replyAttachments, replyToMessage, setReplyToMessage, replySubject, setReplySubject, recipients, showInfoToast,
  });

  // 入力欄まわり（添付・送信先・返信元と引用・送信元と署名）は useCompose.ts
  const {
    MAX_TOTAL_ATTACHMENT_BYTES, addReplyAttachments, removeReplyAttachment, getReplyBase, partnerRecipient, partnerAddressOf, effectiveRecipients, recipientsCustomized, partnerLabel,
    askMoveForRecipients, addComposeRecipients, removeComposeRecipient, clearReplyTarget, chooseReplyTarget, getSendFrom, fetchOriginalFull,
  } = useCompose({
    session, selectedSender, selectedSenderRef, chatConfigs, groupedEmails, getRoomPartner, roomAccountEmail, resolveDirectRoom, openChat,
    replyAttachments, setReplyAttachments, setAttachError, replyToMessage, setReplyToMessage, replyToMessageRef, recipients, setRecipients, recipientsBase, setRecipientsBase,
    replySubject, setReplySubject, setComposeDialog, currentCompose, loadCompose, insertedSignatureRef, editorLoad, carryDraftRef, addDraftChat, draftReadyRoom,
    sendAsByAccount, setSendAsByAccount, getSendAs, showInfoToast, showErrorToast,
  });

  // 送る（送信 API・送る前の確認・返信・転送）は useSend.ts
  const { handleSend, forwardMessageTo } = useSend({
    session, selectedSender, selectedSenderRef, chatConfigs, chatConfigsRef, groupedEmails, roomAccountEmail, getRoomRecipient, setEmails,
    currentCompose, loadCompose, insertedSignatureRef, effectiveRecipients, partnerAddressOf, askMoveForRecipients, getReplyBase, fetchOriginalFull, MAX_TOTAL_ATTACHMENT_BYTES,
    replyToMessage, setReplyToMessage, replySubject, setReplySubject, replyAttachments, setReplyAttachments, setAttachError, setRecipients, setRecipientsBase,
    setComposeDialog, setIsSending, setSendConfirm, myAddressesFor, getSendAs, draftChatsRef, removeDraftChat, showInfoToast, setInfoToast, showErrorToast,
  });

  // 選択したチャット・メールへの操作と、継続フィルターの自動適用・開いたら既読にする は useMailboxActions.ts
  const {
    applyHideToIds, applyPinToIds, executeResetSelection, executePin, getActionableEmails, applyReadToIds, applyDeleteToIds, executeConfirmedAction, applyMoveToIds, executeBatchMove,
    enterSelectionMode, handleMenuBarClick, handleBackgroundClick, toggleSelection,
  } = useMailboxActions({
    session, selectedSender, setSelectedSender, groupedEmails, emailRoomMap, allUniqueEmails, emails, setEmails, persistedEmails, setPersistedEmails,
    chatConfigs, chatConfigsRef, messageConfigsRef, updateMessageConfig, updateChatConfig, updateChatConfigByRoomKey, syncConfigs, applySyncedPersisted,
    resolveMessageAccountEmail, modal, exitAfterAction, checkInbox, checkArchive, checkSpam, checkTrash, checkSent, revealedCrossPrompts, setRevealedCrossPrompts,
    showErrorToast, accountSettings, emailModal,
    selectionMode, setSelectionMode, selectedIds, setSelectedIds, setModal, hasPushedSelectRef, emailsRef, fetchChatCrossbox, safeBack,
  });

  // 検索バーと、検索結果・返信元へのジャンプは useFindBar.ts
  const {
    findBarMatches, goToNextFindMatch, goToPrevFindMatch, updateFindBarKeyword, setFindBarSearchSubject, setFindBarSearchBody, setFindBarBox, closeFindBar, openFindBar,
    jumpToSearchResult, jumpToReplyTarget,
  } = useFindBar({
    session, emailsRef, setEmails, selectedSender, groupedEmails, chatConfigs, isMobile, openChat, partnerLabel,
    findBarOpen, setFindBarOpen, findBarKeyword, setFindBarKeyword, findBarMatchIndex, setFindBarMatchIndex, findBarSearchSubject, setFindBarSearchSubjectState,
    findBarSearchBody, setFindBarSearchBodyState, findBarBoxFilter, setFindBarBoxFilter, hasPushedFindBarRef, skipFindBarAutoCloseRef,
    checkInbox, checkArchive, checkSpam, checkTrash, checkSent, setRevealedCrossPrompts, setModal, setSelectionMode, setSelectedIds,
    setReplyNotFoundToast, isJumpingToReplyRef, setComposeDialog,
  });

  // さらに読み込む（チャット一覧・メッセージ。スクロールバーが出るまで自動で続ける）は useLoadMore.ts
  const { handleLoadMoreChats, handleLoadMoreMessage } = useLoadMore({
    session, setEmails, isLoading, selectedSender, groupedEmails, senderList, chatConfigsRef,
    checkInbox, checkArchive, checkSpam, checkTrash, checkSent,
    currentNextPageTokens, setCurrentNextPageTokens, currentNextPageTokensRef, loadingMoreChatsRef, setIsLoadingMoreChats, chatStatusMessage, setChatStatusMessage,
    loadingMoreMsgRef, setIsLoadingMore, chatNextPageToken, msgStatusMessage, setMsgStatusMessage, fetchChatCrossbox, fetchGroupLoadMore,
  });

  const pinnedMsgsInChat = (checkInbox || checkArchive || checkSent) ? (groupedEmails[selectedSender!] || []).filter(e => messageConfigs[messageConfigKey(e.id)]?.isPinned && !e.labelIds?.includes("TRASH") && !e.labelIds?.includes("SPAM") && isAccountVisible(e.accountId)) : [];

  return {
    auth: { session, status },
    state: {
      emails, persistedEmails, isLoading, selectedSender, chatConfigs, messageConfigs,
      isLoadingMore, checkInbox, checkArchive, checkSpam, checkTrash, checkSent, checkAccounts, useIconLabels, accountSettings,
      currentNextPageTokens, chatStatusMessage, msgStatusMessage, isLoadingMoreChats, linkedAccounts, reauthNeededAccounts, linkedAccountProfiles,
      replySubject, composeHtml, composeBodyEmpty, editorLoad, isSending, replyToMessage, replyAttachments, attachError,
      hasMouse, isMobile, selectionMode, selectedIds, modal, renameInput,
      revealedCrossPrompts, boxColors,
      chatCacheLimit,
      collapseLinesCount, expandedMsgIds, emailModal, attachmentModal,
      replyNotFoundToast, errorToast, infoToast, sendConfirm, unloadedCount, isRetryingUnloaded, draftChats, activeChatTab,
      recipients: effectiveRecipients, recipientsCustomized, composeDialog, composeActive, showSentRecipients, showReceivedRecipients, sendAsByAccount,
      isDraftReady: draftReadyRoom === selectedSender,
      findBarOpen, findBarKeyword, findBarMatchIndex, findBarSearchSubject, findBarSearchBody, findBarBoxFilter,
    },
    actions: {
      setCheckInbox, setCheckArchive, setCheckSpam, setCheckTrash, setCheckSent, setCheckAccounts, setUseIconLabels, setAccountSetting, alwaysLoadImagesFor, changeChatTab,
      setReplySubject, onEditorChange, clearReplyTarget, setReplyToMessage, setSelectionMode, setSelectedIds, setModal, setRenameInput,
      setRevealedCrossPrompts, updateChatConfig, setSelectedSender,
      handleMenuBarClick, handleBackgroundClick, toggleSelection,
      jumpToSearchResult, updateFindBarKeyword, goToNextFindMatch, goToPrevFindMatch, closeFindBar, openFindBar,
      setFindBarSearchSubject, setFindBarSearchBody, setFindBarBox,
      handleSend, addReplyAttachments, removeReplyAttachment, searchServerSide, executePin, executeConfirmedAction, executeResetSelection, applyPinToIds, applyDeleteToIds, applyMoveToIds, applyHideToIds,
      openChat, handleLoadMoreChats, handleLoadMoreMessage, safeBack, exitAfterAction, enterSelectionMode, executeBatchMove,
      setChatCacheLimit,
      openEmailModal, closeEmailModal, toggleMsgExpand, applyReadToIds, getActionableEmails,
      openAttachmentModal, closeAttachmentModal,
      jumpToReplyTarget, createOrOpenChat, createGroupChat, createFilterGroup, deleteChatConfig, forwardMessageTo,
      updateChatConfigByRoomKey, deleteChatConfigByRoomKey, messageConfigKey, roomLocalKey, roomAccountEmail, switchSendAccount, logoutAccount,
      unlinkAccount, isAccountVisible, setSendConfirm, retryUnloaded,
      addComposeRecipients, removeComposeRecipient, chooseReplyTarget, setComposeDialog, setComposeActive, myAddressesFor, partnerRecipient, showErrorToast,
      recipientForRoom: (room: RoomKeyStr): ComposeRecipient | null => partnerRecipient(room),
      setShowSentRecipients, setShowReceivedRecipients,
    },
    computed: { sendFrom: getSendFrom(selectedSender), allUniqueEmails, groupedEmails, senderList, hiddenChats, hiddenMsgs, pinnedChats, pinnedMsgs, nameChangedChats, pinnedMsgsInChat, contactDirectory, groupReplyPools, findBarMatches, emailRoomMap },
    refs: { touchTimer, hasPushedSelectRef, activeLoadRef, searchTimeoutRef, editorApiRef }
  };
}

export type MailAppHook = ReturnType<typeof useMailApp>;