import { useSession, signOut } from "next-auth/react";
import { useState, useEffect, useMemo, useRef } from "react";
import { ChatConfig, MessageConfig, SelectionMode, ModalState, ModalTargetMode, GroupMode } from "../types/mail";
import { Email } from "../types/email";
import { clearDeviceData, clearAccountDeviceData, DEVICE_OWNER_KEY } from "../lib/deviceData";
import { isComposeBodyEmpty, withQuote } from "../lib/composeHtml";
import type { InlineImage } from "../lib/composeEditor";
import type { ComposeEditorApi } from "../components/ComposeEditor";
import { isMineEmail, getFindBarBoxKey, FilterCriteria, ChatListTab, chatConfigTab } from "../lib/filterMatch";
import { groupEmailsByRoom, mergeAccountGroups, applyFilterGroups, groupMemberAddresses, roomPartner } from "../lib/groupEmails";
import { LocalKey, RoomKeyStr, asLocalKey, encodeRoomKey, decodeRoomKey, keysOf } from "../lib/roomKey";
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
import type { EmailModalState, AttachmentModalState } from "./mailAppTypes";
import { getSavedBoxSettings, getSavedAccountSettings, parseAddressSet, sameAddressSet, countOccurrences } from "../lib/mailAppHelpers";

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

  // 実際のグルーピングロジックは app/lib/groupEmails.ts の純粋関数に切り出してある
  // （副作用のない形でユニットテストできるようにするため）。groupedEmails・chatConfigs・
  // selectedSender は常に encodeRoomKey 済みの複合roomKey（RoomKeyStr）をキーとする。
  // chatConfigsは既に複合キーなので、groupEmailsByRoom（1アカウント分・ローカルキー前提の
  // 純粋関数）に渡す前に対象アカウント分だけローカルキーへ戻し、結果をmergeAccountGroupsで
  // 複合キーへ戻す。allUniqueEmailsも同様に、そのアカウント自身のメール（e.accountId一致）だけに
  // 絞り込んでから渡す（絞り込まないと、他アカウント宛のメールまでこのアカウントの相手名で
  // 誤ってグルーピングされてしまう）。accountId未設定（導入前のデータ・送信直後のローカルfake等）は
  // メインアカウント名義として扱う
  const groupedEmails = useMemo(() => {
    const myEmail = session?.user?.email || "";
    const accounts = [myEmail, ...linkedAccounts];
    const perAccountGroups = accounts.map(accountEmail => {
      const localChatConfigs: Record<LocalKey, ChatConfig> = {} as Record<LocalKey, ChatConfig>;
      keysOf(chatConfigs).forEach(key => {
        try {
          const decoded = decodeRoomKey(key);
          if (decoded.accountEmail === accountEmail) localChatConfigs[decoded.localKey] = chatConfigs[key];
        } catch { /* 複合roomKeyでない古いデータ（移行前の残り等）は無視する */ }
      });
      const accountEmails = allUniqueEmails.filter(e => (e.accountId || myEmail) === accountEmail);
      const aliases = (sendAsByAccount[accountEmail] || []).map(a => a.sendAsEmail);
      return { accountEmail, groups: groupEmailsByRoom(accountEmails, accountEmail, localChatConfigs, aliases) };
    });
    const merged = mergeAccountGroups(perAccountGroups);
    // フィルターグループ（filterCriteria持ち）は受信専用のため、上のアカウント単位の集約を
    // 対象外にしてある（groupEmailsByRoom側）。ここで全アカウント分のメールをまたいで
    // 別途集約する（criteria.accountEmailで対象アカウントを絞り込める）
    return applyFilterGroups(merged, chatConfigs, allUniqueEmails, myEmail);
  }, [allUniqueEmails, session, chatConfigs, linkedAccounts, sendAsByAccount]);

  const groupedEmailsRef = useRef(groupedEmails);
  useEffect(() => { groupedEmailsRef.current = groupedEmails; }, [groupedEmails]);

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

  // メッセージID → 所属ルームキーの逆引き。フィルターツールで複数ルームにまたがる
  // メッセージを一括非表示/ピン留めする際、各メッセージ自身の本来のルームを正しく特定するために使う。
  // 自分が送ったメールは宛先の人のチャットすべてに出る（1通が複数のルームに入る）ので、ここには最後に見つけたルームが入る。
  // どのルームでも同じアカウントなので、アカウントの判定には使える。ルームそのものが要るときは roomOfMessage を使う
  const emailRoomMap = useMemo(() => {
    const map = new Map<string, RoomKeyStr>();
    keysOf(groupedEmails).forEach(room => (groupedEmails[room] || []).forEach((e) => map.set(e.id, room)));
    return map;
  }, [groupedEmails]);

  // メッセージが実際にどのアカウントに属するかを解決する。
  // 1) 既にそのメッセージの設定行が存在すればそのアカウントを最優先で再利用する
  //    （非表示化した後にメールデータがローカルから消えても、unhide時に同じキーへ確実に書き戻すため）
  // 2) groupedEmailsのroomキー（既に正しいアカウントで複合化済み）
  // 3) メール自身のaccountId
  // 4) どれも無ければメインアカウントにフォールバック
  const resolveMessageAccountEmail = (messageId: string): string => {
    const existingKey = keysOf(messageConfigsRef.current).find(k => decodeRoomKey(k).localKey === (messageId as LocalKey));
    if (existingKey) {
      try { return decodeRoomKey(existingKey).accountEmail; } catch { /* 複合キーでない古いデータは無視 */ }
    }
    const room = emailRoomMap.get(messageId);
    if (room) {
      try { return decodeRoomKey(room).accountEmail; } catch { /* 複合キーでない古いデータは無視 */ }
    }
    const found = allUniqueEmails.find((e) => e.id === messageId);
    return found?.accountId || session?.user?.email || "";
  };

  // メッセージ単位の設定（messageConfigs）を引くための複合キーを作る。そのメッセージが
  // 実際に属するアカウントで複合化するため、連携アカウントをまたいでメッセージIDが
  // 衝突しても互いの非表示/ピン留め状態が混ざらない
  const messageConfigKey = (messageId: string): RoomKeyStr => encodeRoomKey(resolveMessageAccountEmail(messageId), messageId as LocalKey);

  // ルーム内の相手メールアドレスを推定する（「作成」機能での重複チャット判定・検索に使用）。
  // 連携アカウントのルームでは「自分」がメインアカウントとは限らないため、そのルーム自身が
  // 属するアカウントで判定する（メインアカウント固定だと、連携アカウント宛にメインアカウントから
  // 送ったメールを「相手からの受信」と誤認識してしまう）
  // 宛先に書く「表示名 <アドレス>」。相手から届いたメールの From に表示名があればそれを使い、無ければアドレスだけ
  // 受け取ったメールに Reply-To（自分以外）があれば、そのアドレスを相手とする（groupEmails.ts の roomPartner）
  const getRoomPartner = (room: RoomKeyStr): { name: string; address: string } => {
    const { accountEmail, localKey } = decodeRoomKey(room);
    const aliases = (sendAsByAccount[accountEmail] || []).map(a => a.sendAsEmail);
    return roomPartner(groupedEmails[room] || [], localKey, accountEmail, aliases);
  };
  const getRoomRecipient = (room: RoomKeyStr): string => {
    const { name, address } = getRoomPartner(room);
    // 表示名にカンマなどが入っていても宛先の区切りにならないよう、引用符で囲む（ヘッダーに書くときは mime.ts が整える）
    const cleanName = name.replace(/["\\<>\r\n]+/g, " ").trim();
    if (cleanName && address) return `"${cleanName}" <${address}>`;
    return address;
  };
  const getRoomAddress = (room: RoomKeyStr): string => getRoomPartner(room).address;

  // 「作成」モーダルの「候補」一覧（下書き中の空チャット・グループ自体は除く）。
  // ボックスのチェックボックス状態には影響されず（groupedEmails自体が非フィルター済みのため）、
  // 現在のフィルターに関わらず常に最新のやり取り順（時系列順）で並べる
  const contactDirectory = useMemo(() => {
    return keysOf(groupedEmails)
      .filter(room => (groupedEmails[room] || []).length > 0 && !chatConfigs[room]?.isGroup)
      .map(room => {
        const decoded = decodeRoomKey(room);
        return {
          room,
          label: chatConfigs[room]?.customName || decoded.localKey,
          // 名前変更後もリネーム前の元の表示名（相手のFromヘッダー由来の名前）で検索できるように、
          // labelとは別に保持しておく（customNameが無ければlabelと同じ値になる）
          originalName: decoded.localKey,
          address: getRoomAddress(room),
          accountEmail: decoded.accountEmail,
          latestDate: groupedEmails[room][0]?.date ? new Date(groupedEmails[room][0].date).getTime() : 0,
        };
      })
      .sort((a, b) => b.latestDate - a.latestDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupedEmails, chatConfigs, session]);

  // グループチャットの「返信先を選択」用プール: 表示モードに関わらず、
  // 自分がグループから送信したメール + メンバー全員からの受信メールを常に候補にする
  // （送信専用モードでもスレッドには出てこない相手の発言を選んで返信できるようにするため）
  const groupReplyPools = useMemo(() => {
    const pools: Record<string, Email[]> = {};
    keysOf(chatConfigs).forEach(room => {
      const cfg = chatConfigs[room];
      if (!cfg?.isGroup) return;
      const { accountEmail } = decodeRoomKey(room);
      // グループは1つのアカウントから送信する前提のため、「自分」はこのグループ自身が属する
      // アカウント（連携アカウントの場合はそちら）で判定する（メインアカウント固定だと、
      // 連携アカウントのグループで送受信の判定が逆転してしまう）
      const memberAddresses = groupMemberAddresses(cfg);
      const sentViaGroup = allUniqueEmails.filter((e) => isMineEmail(e, accountEmail) && sameAddressSet(parseAddressSet(e.to || ""), memberAddresses));
      const received = allUniqueEmails.filter((e) => {
        if (isMineEmail(e, accountEmail)) return false;
        const addrMatch = (e.from || "").match(/<([^>]+)>/);
        const addr = (addrMatch ? addrMatch[1] : e.from || "").trim().toLowerCase();
        return memberAddresses.has(addr);
      });
      pools[room] = [...sentViaGroup, ...received].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    });
    return pools;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allUniqueEmails, chatConfigs, groupedEmails, session]);

  // 下書きチャットから離れたとき、何も書いていなければ一覧から消す（useDrafts.ts）
  useDraftChatCleanup({
    selectedSender, selectedSenderRef, draftChatsRef, groupedEmailsRef, carryDraftRef, draftReadyRoom, currentCompose, replySubject, insertedSignatureRef, replyToMessage, replyAttachments, recipients, recipientsBase, removeDraftChat,
  });

  const senderList = useMemo<RoomKeyStr[]>(() => {

    const getLatestValidDate = (sender: RoomKeyStr): number => {
      const allEmails = groupedEmails[sender] || [];
      const config = chatConfigs[sender];

      const validEmails = allEmails.filter((e) => {
        const isTrash = e.labelIds?.includes("TRASH");
        const isSpam = e.labelIds?.includes("SPAM");
        const isInbox = e.labelIds?.includes("INBOX");
        const isSent = e.labelIds?.includes("SENT") || e.isMe;
        const isArchive = !isTrash && !isSpam && !isInbox && !isSent;

        if ((isInbox || isArchive || isSent) && (config?.isHidden || messageConfigs[messageConfigKey(e.id)]?.isHidden)) return false;
        if (!isAccountVisible(e.accountId)) return false;

        // ★修正: 送信済みの「絶対権限（他のラベルを無視）」を適用
        let isCurrentBox = false;
        if (isSent) {
            isCurrentBox = checkSent;
        } else {
            isCurrentBox = (isTrash && checkTrash) || (isSpam && checkSpam) || (isInbox && checkInbox) || (isArchive && checkArchive);
        }

        return isCurrentBox || revealedCrossPrompts.includes(e.id);
      });

      return validEmails[0] ? new Date(validEmails[0].date).getTime() : 0;
    };

    const allRoomKeys = Array.from(new Set([...keysOf(groupedEmails), ...draftChats])) as RoomKeyStr[];

    return allRoomKeys.filter((sender: RoomKeyStr) => {
      const config = chatConfigs[sender];
      if (config?.isHidden) return false;

      // 「作成」で作った未送信の下書きチャットは、送信するまで無条件で一覧に表示する
      if (draftChats.includes(sender) && (!groupedEmails[sender] || groupedEmails[sender].length === 0)) return true;

      const hasDisplayableEmail = (groupedEmails[sender] || []).some((e) => {
        const isTrash = e.labelIds?.includes("TRASH");
        const isSpam = e.labelIds?.includes("SPAM");
        const isInbox = e.labelIds?.includes("INBOX");
        const isSent = e.labelIds?.includes("SENT") || e.isMe;
        const isArchive = !isTrash && !isSpam && !isInbox && !isSent;

        if ((isInbox || isArchive || isSent) && (config?.isHidden || messageConfigs[messageConfigKey(e.id)]?.isHidden)) return false;
        if (!isAccountVisible(e.accountId)) return false;

        if (revealedCrossPrompts.includes(e.id)) return true;

        // ★修正: 送信済みの判定を最初に持ってくることで絶対的な権限を持たせる
        if (isSent) return checkSent;
        if (isTrash) return checkTrash;
        if (isSpam) return checkSpam;
        if (isArchive) return checkArchive;
        return checkInbox;
      });

      if (!hasDisplayableEmail && !config?.isPinned) return false;
      return true;

    }).sort((a: RoomKeyStr, b: RoomKeyStr): number => {
      // 作成直後の下書きチャットは通常のチャットと同様、一番上（ピン留めより上）に表示する
      const isDraftA = draftChats.includes(a) && (!groupedEmails[a] || groupedEmails[a].length === 0) ? 1 : 0;
      const isDraftB = draftChats.includes(b) && (!groupedEmails[b] || groupedEmails[b].length === 0) ? 1 : 0;
      if (isDraftA !== isDraftB) return isDraftB - isDraftA;

      const pinA = chatConfigs[a]?.isPinned ? 1 : 0;
      const pinB = chatConfigs[b]?.isPinned ? 1 : 0;
      if (pinA !== pinB) return pinB - pinA;

      const timeA = getLatestValidDate(a);
      const timeB = getLatestValidDate(b);
      return (isNaN(timeB) ? 0 : timeB) - (isNaN(timeA) ? 0 : timeA);
    });
  }, [groupedEmails, chatConfigs, messageConfigs, checkSent, checkInbox, checkArchive, checkSpam, checkTrash, checkAccounts, session, revealedCrossPrompts, draftChats]);

  const hiddenChats = keysOf(chatConfigs).filter(k => chatConfigs[k]?.isHidden);
  // messageConfigsは複合キーだが、他所（Modals.tsx等）との互換のため各要素のidは生のメッセージIDのまま返す
  const hiddenMsgs = keysOf(messageConfigs).filter(k => messageConfigs[k]?.isHidden).map(stateKey => {
    const { localKey: id } = decodeRoomKey(stateKey);
    return allUniqueEmails.find(e => e.id === id) || { id, subject: "過去のメッセージ", date: new Date().toISOString() };
  });
  // 非表示解除ボタン統合・ピン留め一覧・リセット画面（すべてのチャット/メッセージから選ぶ）で使う
  const pinnedChats = keysOf(chatConfigs).filter(k => chatConfigs[k]?.isPinned);
  const pinnedMsgs = keysOf(messageConfigs).filter(k => messageConfigs[k]?.isPinned).map(stateKey => {
    const { localKey: id } = decodeRoomKey(stateKey);
    return allUniqueEmails.find(e => e.id === id) || { id, subject: "過去のメッセージ", date: new Date().toISOString() };
  });
  const nameChangedChats = keysOf(chatConfigs).filter(k => !!chatConfigs[k]?.customName);

  // senderList からチャットが消えたら（フィルター変更・非表示化など）メッセージ画面を自動クローズ
  // ただし初回のメール取得が終わるまでは senderList が「まだ空なだけ」なので判定しない。
  // また、「作成」で候補から直接開いたチャットのように、そもそも現在のフィルターで
  // 一覧に表示される対象ではないチャットまで閉じてしまわないよう、
  // 過去に一度でも一覧に表示されていた（＝本当に消えた）場合のみクローズする
  const prevSenderListRef = useRef<string[]>(senderList);
  useEffect(() => {
    if (hasLoadedOnceRef.current && !isLoading && selectedSender) {
      const wasVisible = prevSenderListRef.current.includes(selectedSender);
      const isVisible = senderList.includes(selectedSender);
      if (wasVisible && !isVisible) {
        setSelectedSender(null);
        if (typeof window !== "undefined") {
          localStorage.removeItem("remail_selected_sender");
          localStorage.removeItem("remail_scroll_main");
        }
      }
    }
    prevSenderListRef.current = senderList;
  }, [senderList, isLoading]);

  const safeBack = () => {
    const state = window.history.state;
    if (state && (state.action || state.chat)) {
      window.history.back();
    } else if (isMobile && selectedSender) {
      // スマホ表示でメッセージ画面が開いているのに、履歴側に「チャットを開いた」記録が無いケース
      // （PC表示で開いた後に画面幅が縮んでスマホ表示に切り替わった場合など）へのフォールバック。
      // history.back() 任せだと戻れずメッセージ画面に固定されてしまうため、直接チャット一覧に戻す
      setSelectedSender(null);
      localStorage.removeItem("remail_selected_sender");
      setModal(null); setSelectionMode("none"); setSelectedIds([]);
    } else {
      setModal(null); setSelectionMode("none"); setSelectedIds([]);
    }
  };

  // アクション実行後: モーダルと選択モードを両方終了し履歴も整理する
  const exitAfterAction = () => {
    setModal(null);
    setSelectionMode("none");
    setSelectedIds([]);
    const steps = hasPushedSelectRef.current ? 2 : 1;
    hasPushedSelectRef.current = false;
    window.history.go(-steps);
  };

  const openChat = async (sender: RoomKeyStr, opts?: { replaceHistory?: boolean }) => {
    // 現在のチャットを LRU キャッシュに保存
    const prevSender = selectedSender;
    if (prevSender && prevSender !== sender && chatCacheLimitRef.current > 0) {
      const { localKey: prevLocal } = decodeRoomKey(prevSender);
      const senderEmails = emailsRef.current.filter((e) => {
        if (e.senderRoom === prevLocal) return true;
        const room = e.from?.split("<")[0].replace(/"/g, "").trim() || "Unknown";
        return room === prevLocal || e.from?.includes(prevLocal) || e.to?.includes(prevLocal);
      });
      chatCacheRef.current.set(prevSender, {
        emails: senderEmails,
        chatNextPageToken: chatNextPageTokenRef.current,
        groupMemberTokens: chatConfigsRef.current[prevSender]?.isGroup ? { ...groupMemberTokensRef.current } : undefined,
        // eslint-disable-next-line react-hooks/purity -- チャットを開く処理の中で LRU の時刻を取るだけ（描画中には呼ばない）
        lruTime: Date.now(),
      });
      // LRU 上限を超えた古いエントリを削除
      if (chatCacheRef.current.size > chatCacheLimitRef.current) {
        const sorted = [...chatCacheRef.current.entries()].sort(([, a], [, b]) => a.lruTime - b.lruTime);
        chatCacheRef.current.delete(sorted[0][0]);
      }
    }

    setSelectedSender(sender);
    if (typeof window !== "undefined") {
      localStorage.setItem("remail_selected_sender", sender);
      localStorage.removeItem("remail_scroll_main");
      const asideEl = document.querySelector("aside > div.flex-1");
      if (asideEl) localStorage.setItem(`remail_scroll_aside_${activeChatTab}`, asideEl.scrollTop.toString());
    }
    // 返信元はここでは外さない。チャットを切り替えたら、下書きの読み戻しが移り先の下書きの返信元を入れ直す。
    // ここで外すと、開いているチャットを一覧でもう一度押しただけで返信元が外れ、本文と件名「Re:」だけ残って
    // スレッドの分かれた新しいメールとして送られてしまう（実機で起きた）
    setMsgStatusMessage(null);
    if (isMobile) {
      // 検索結果からのジャンプなど、現在の履歴エントリ(検索モーダル用)を新規に積まず
      // その場でチャット用エントリに置き換えたい場合に replaceHistory を使う
      // （go()/back() は非同期のため、直後に別のpushStateを行うと競合してしまう。
      //   replaceStateは同期的なのでこの問題が起きない）
      if (opts?.replaceHistory) window.history.replaceState({ chat: sender }, '', `#chat`);
      else window.history.pushState({ chat: sender }, '', `#chat`);
    }

    // キャッシュがあれば復元、なければ通常フェッチ
    const cached = chatCacheRef.current.get(sender);
    if (cached) {
      // eslint-disable-next-line react-hooks/purity -- チャットを開く処理の中で LRU の時刻を取るだけ（描画中には呼ばない）
      cached.lruTime = Date.now();
      setEmails(prev => {
        const map = new Map(prev.map((e) => [e.id, e]));
        cached.emails.forEach((e) => map.set(e.id, e));
        return Array.from(map.values());
      });
      groupMemberTokensRef.current = cached.groupMemberTokens ? { ...cached.groupMemberTokens } : {};
      setChatNextPageToken(cached.chatNextPageToken || "FIRST_PAGE");
      chatNextPageTokenRef.current = cached.chatNextPageToken || "FIRST_PAGE";
    } else {
      groupMemberTokensRef.current = {};
      setChatNextPageToken("FIRST_PAGE");
      await fetchCrossboxForRoom(sender);
    }
    // 追加読み込みはuseEffectベースの自動トリガー（chatNextPageToken変化で発火）に委ねる
  };

  // 「作成」モーダルの確定操作: 既にやり取りのある宛先ならそのチャットを開き、
  // 初めての宛先なら未送信の下書きチャットとして新規に開く
  // accountEmail は新規アドレスを複合化する際にだけ使う（「作成」モーダルのアカウント選択UIから渡される。
  // 未指定時はメインアカウント）。既存の宛先（contactDirectory由来の複合キー）を選んだ場合は
  // そのままそのアカウントで開くため、accountEmailは無視される
  // 宛先とアカウントから、開くチャット（既存ならそのチャット、無ければ新しいチャットのキー）を決める
  const resolveDirectRoom = (identifier: string, accountEmail?: string): { room: RoomKeyStr; existing: boolean } | null => {
    const trimmed = identifier.trim();
    if (!trimmed) return null;
    const myEmail = session?.user?.email || "";
    const targetAccountEmail = accountEmail || myEmail;
    // contactDirectory の候補選択は既に複合キー（room）そのものが渡ってくる。
    // 新規入力のメールアドレス/表示名は区切り文字を含まないので、選択されたアカウント名義で複合化する
    let directKey: RoomKeyStr;
    try {
      decodeRoomKey(trimmed);
      directKey = trimmed as RoomKeyStr;
    } catch {
      directKey = encodeRoomKey(targetAccountEmail, asLocalKey(trimmed));
    }

    let existingRoom: RoomKeyStr | null = null;
    if (groupedEmails[directKey] && !chatConfigs[directKey]?.isGroup) {
      existingRoom = directKey;
    } else {
      const idLower = trimmed.toLowerCase();
      // 対象アカウント（targetAccountEmail）が一致するルームだけを既存チャットの候補にする。
      // これを見ないと、別アカウントに同じアドレスの相手がいる場合、そちらのチャットを
      // 誤って開いてしまう（新規に選んだアカウントではなく既存のアカウント側が開かれる）
      existingRoom = keysOf(groupedEmails).find(room =>
        !chatConfigs[room]?.isGroup &&
        decodeRoomKey(room).accountEmail === targetAccountEmail &&
        getRoomAddress(room) === idLower
      ) || null;
    }

    return existingRoom ? { room: existingRoom, existing: true } : { room: directKey, existing: false };
  };

  const createOrOpenChat = async (identifier: string, accountEmail?: string, opts?: { replaceHistory?: boolean }): Promise<RoomKeyStr | null> => {
    const target = resolveDirectRoom(identifier, accountEmail);
    if (!target) return null;
    if (!target.existing) addDraftChat(target.room);
    await openChat(target.room, opts);
    return target.room;
  };

  // 返信欄の「送信元」を別のアカウントに切り替える。切り替え先のアカウントで、同じ相手との既存のチャット
  // （無ければ新しいチャット）を開く。入力中の本文・添付・送信先は切り替え先へ持っていく。
  // 返信元は外す（スレッドはアカウントごとのため、別のアカウントのメールには返信できない）
  const switchSendAccount = async (target: string) => {
    const room = selectedSender;
    setModal(null);
    const cameFromModal = typeof window !== "undefined" && window.history.state?.action === "modal";
    const closeModalEntry = () => { if (cameFromModal) window.history.replaceState(isMobile && room ? { chat: room } : {}, "", window.location.href); };
    if (!room) { closeModalEntry(); return; }
    const { accountEmail: current, localKey } = decodeRoomKey(room);
    if (current.toLowerCase() === target.toLowerCase()) { closeModalEntry(); return; }
    const address = getRoomAddress(room) || localKey;
    const now = currentCompose();
    const hasInput = !!(!isComposeBodyEmpty(now.html) || replyAttachments.length || (!replyToMessage && replySubject) || recipients);
    const dest = resolveDirectRoom(address, target);
    if (!dest) { closeModalEntry(); return; }
    // 開く前に決めておく（開いた直後に下書きの読み戻しが走るため）。
    // 持っていった内容は、切り替え先で読み戻せたら切り替え元の下書きから消す（両方に残って二重に送られないように）
    if (hasInput) {
      carryDraftRef.current = {
        room: dest.room, fromRoom: room, subject: replyToMessage ? "" : replySubject, html: replyToMessage ? withQuote(now.html, null) : now.html, images: now.images,
        insertedSignature: insertedSignatureRef.current, attachments: replyAttachments,
        recipients, recipientsBase: null, replyToMessage: null,
      };
    }
    if (!dest.existing) addDraftChat(dest.room);
    await openChat(dest.room, { replaceHistory: cameFromModal });
    if (!isMobile && cameFromModal) window.history.replaceState({}, "", window.location.href);
    showInfoToast(`送信元を ${target} に切り替えました`, 2500);
  };

  // 「作成」モーダルで複数の宛先を選んだ場合のグループチャット作成。
  // members/hideMemberIndividualChats は contactDirectory 由来の複合キーと、新規入力の生アドレスが混在する。
  // accountEmail はこのグループ自身をどのアカウント名義で作るか（「作成」モーダルのアカウント選択UIから
  // 渡される。未指定時はメインアカウント）
  const createGroupChat = async (name: string, members: string[], memberAddresses: string[], mode: GroupMode, hideMemberIndividualChats: string[], accountEmail?: string) => {
    const myEmail = accountEmail || session?.user?.email || "";
    const groupRoomLocal = asLocalKey(`group:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    const groupRoom = encodeRoomKey(myEmail, groupRoomLocal);

    const toMemberKey = (m: string): RoomKeyStr => {
      try { decodeRoomKey(m); return m as RoomKeyStr; } catch { return encodeRoomKey(myEmail, asLocalKey(m)); }
    };
    const localMembers = members.map(m => decodeRoomKey(toMemberKey(m)).localKey);

    // グループ作成によって新たに非表示にするメンバーだけを記録する（既に非表示だったものは対象外。
    // グループ削除時にこの一覧の分だけ非表示を解除するため）
    const groupHiddenMembers = hideMemberIndividualChats
      .map(toMemberKey)
      .filter(member => groupedEmails[member] && !chatConfigsRef.current[member]?.isHidden)
      .map(member => decodeRoomKey(member).localKey);

    await updateChatConfig(groupRoomLocal, {
      customName: name, isGroup: true, groupMembers: localMembers, groupMemberAddresses: memberAddresses, groupMode: mode,
      groupHiddenMembers,
    }, myEmail);

    groupHiddenMembers.forEach(member => {
      // unhideOnNew は明示的に false にする（新着があっても自動で表示に戻らないようにするため）
      updateChatConfig(member, { isHidden: true, hiddenAtDate: new Date().toISOString(), unhideOnNew: false }, myEmail);
    });

    setSelectedSender(groupRoom);
    if (typeof window !== "undefined") {
      localStorage.setItem("remail_selected_sender", groupRoom);
      localStorage.removeItem("remail_scroll_main");
    }
    setReplyToMessage(null); setReplySubject("");
    if (isMobile) window.history.pushState({ chat: groupRoom }, '', '#chat');

    // 各メンバーの過去のやり取りを読み込んでおく（作成直後からグループの内容が見えるように）
    await Promise.all(localMembers.map(m => fetchChatCrossbox(m, myEmail, false).catch(() => {})));
  };

  // フィルターツールで作成するグループ。宛先の集合ではなく条件（FilterCriteria）でメッセージを
  // 動的に集約する。新着メールも条件に合えば自動的に含まれ続ける。常に受信専用チャットとして扱う
  const createFilterGroup = async (name: string, filterCriteria: FilterCriteria, hideOriginal: boolean, includeExisting: boolean = true) => {
    // フィルターは必ずどれか1つのアカウントのもの。そのアカウントの名義で作る（そのアカウントだけでログインしても使えるように）
    const myEmail = filterCriteria.accountEmail || session?.user?.email || "";
    const groupRoomLocal = asLocalKey(`group:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    const groupRoom = encodeRoomKey(myEmail, groupRoomLocal);
    await updateChatConfig(groupRoomLocal, {
      customName: name, isGroup: true, filterCriteria, filterHideOriginal: hideOriginal, groupMode: "inbound_only",
      filterIncludeExisting: includeExisting, filterCreatedAt: new Date().toISOString(),
    }, myEmail);
    setSelectedSender(groupRoom);
    if (typeof window !== "undefined") {
      localStorage.setItem("remail_selected_sender", groupRoom);
      localStorage.removeItem("remail_scroll_main");
    }
    setReplyToMessage(null); setReplySubject("");
    if (isMobile) window.history.pushState({ chat: groupRoom }, '', '#chat');
  };

  const enterSelectionMode = (type: "chat" | "msg", id: string) => {
    const mode: SelectionMode = type === "chat" ? "chat_select" : "msg_select";
    setSelectionMode(mode);
    setSelectedIds([id]);
    if (type === "chat") {
      const { accountEmail, localKey } = decodeRoomKey(id);
      fetchChatCrossbox(localKey, accountEmail, false, emailsRef.current, true);
    }
    // 重複して積まない（既にselect履歴エントリがある場合はスキップ）
    if (!hasPushedSelectRef.current && window.history.state?.action !== "select") {
      window.history.pushState({ action: "select" }, "", window.location.href);
      hasPushedSelectRef.current = true;
    } else if (window.history.state?.action === "select") {
      hasPushedSelectRef.current = true;
    }
  };

  const handleMenuBarClick = (mode: string) => {
    const targetMode = mode.startsWith("chat") ? "chat" : "msg";
    const act = mode.replace("chat_", "").replace("msg_", "");
    const inSelection = selectionMode === `${targetMode}_select`;
    const hasSelection = inSelection && selectedIds.length > 0;

    // リセットは常にクリック可能（このボタン自体はチャット画面にしか無い）。選択中のチャットが
    // あればその範囲だけ、無ければ全チャット/メッセージから選ぶ画面を開く
    if (act === "reset") {
      const specificTargets = hasSelection ? [...selectedIds] : [];
      setModal({ type: "reset_select", targetMode: "chat", targets: specificTargets, resetScope: hasSelection ? "specific" : "all" });
      setSelectedIds([]);
      setSelectionMode("none");
      window.history.pushState({ action: "modal" }, "", window.location.href);
      return;
    }

    if (!inSelection || selectedIds.length === 0) return;

    if (act === "pin") {
      if (targetMode === "chat") {
        setModal({ type: "confirm_pin", targetMode: "chat", targets: [...selectedIds] });
      } else {
        setModal({ type: "categorized_action_select", targetMode: "msg", targets: [...selectedIds], action: "pin" });
      }
    } else if (act === "unpin") {
      setModal({ type: "confirm_unpin", targetMode: targetMode as ModalTargetMode, targets: [...selectedIds] });
    } else if (act === "hide") {
      if (targetMode === "chat") {
        setModal({ type: "confirm_hide", targetMode: "chat", targets: [...selectedIds] });
      } else {
        setModal({ type: "categorized_action_select", targetMode: "msg", targets: [...selectedIds], action: "hide" });
      }
    } else if (act === "delete") {
      // 選択がすべてグループチャットの場合は、実メールを一切触らない専用の削除フローにする
      if (targetMode === "chat" && selectedIds.every(id => chatConfigsRef.current[id as RoomKeyStr]?.isGroup)) {
        setModal({ type: "confirm_delete_group", targetMode: "chat", targets: [...selectedIds] });
      } else {
        setModal({ type: "categorized_action_select", targetMode: targetMode as ModalTargetMode, targets: [...selectedIds], action: "delete" });
      }
    } else if (act === "move") {
      setModal({ type: "categorized_action_select", targetMode: targetMode as ModalTargetMode, targets: [...selectedIds], action: "move" });
    } else if (act === "read" || act === "unread") {
      // 確認の画面は出さずにすぐ行う（いつでも戻せる操作のため）。チャットなら、そのチャットに表示されているメールすべて
      applyReadToIds(getActionableEmails([...selectedIds], targetMode).map(e => e.id), act === "read");
      // モーダルを開いていないので、選択の履歴を1つだけ戻して選択を終える（exitAfterAction はモーダルの分まで戻り、ページから出てしまう）
      safeBack();
      return;
    }
    window.history.pushState({ action: "modal" }, "", window.location.href);
  };

  const handleBackgroundClick = () => {
    if (selectionMode !== "none") safeBack();
  };

  const toggleSelection = (id: string) => {
    const isAdding = !selectedIds.includes(id);
    const next = isAdding ? [...selectedIds, id] : selectedIds.filter(i => i !== id);
    setSelectedIds(next);
    if (isAdding && selectionMode.startsWith("chat_")) {
      const { accountEmail, localKey } = decodeRoomKey(id);
      fetchChatCrossbox(localKey, accountEmail, false, emailsRef.current, true);
    }
    if (next.length === 0) {
      setSelectionMode("none");
      if (hasPushedSelectRef.current) {
        hasPushedSelectRef.current = false;
        // 選択用の履歴エントリを取り除く
        if (window.history.state?.action === "select") {
          window.history.back();
        }
      }
    }
  };

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
  } = useMailboxActions({
    session, selectedSender, setSelectedSender, groupedEmails, emailRoomMap, allUniqueEmails, emails, setEmails, persistedEmails, setPersistedEmails,
    chatConfigs, chatConfigsRef, messageConfigsRef, updateMessageConfig, updateChatConfig, updateChatConfigByRoomKey, syncConfigs, applySyncedPersisted,
    resolveMessageAccountEmail, modal, exitAfterAction, checkInbox, checkArchive, checkSpam, checkTrash, checkSent, revealedCrossPrompts, setRevealedCrossPrompts,
    showErrorToast, accountSettings, emailModal,
  });


  // field/fieldIndex: 同じメッセージ内に複数のハイライト箇所がある場合、
  // どのフィールド（件名/本文）の何番目（0始まり）にスクロールするか指定する（省略時は最初に見つかったmark）
  const scrollToMsg = (id: string, field?: "subject" | "body", fieldIndex?: number) => {
    // 読み込み直後は要素がまだDOMに反映されていない、あるいはレイアウトが確定していないことがあるため、
    // 2フレーム待ってから実行する（1フレームだけだとスクロール位置がずれてボタンを通り過ぎることがあった）
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const container = document.getElementById(`msg-${id}`);
        let target: Element | null | undefined = container;
        if (field !== undefined && fieldIndex !== undefined) {
          target = container?.querySelector(`mark[data-field="${field}"][data-match-index="${fieldIndex}"]`) || container?.querySelector("mark") || container;
        } else {
          target = container?.querySelector("mark") || container;
        }
        target?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    });
  };

  // 検索バー用: 現在開いているチャット内でキーワードに一致する「箇所」の一覧
  // （画面表示順＝時系列の古い順。groupedEmails自体は新しい順なので反転させる）
  // 同じメッセージ内に複数回キーワードが出現する場合、それぞれを別カウントの一致として扱う。
  // fieldIndex はそのフィールド（件名/本文）内での出現番号（0始まり）で、
  // HighlightText/BodyWithLinksが振るdata-match-indexと対応させる
  // 件名/本文のチェックボックス、および場所フィルター（受信箱/アーカイブ等）で絞り込む
  const findBarMatches = useMemo(() => {
    if (!findBarOpen || !selectedSender) return [];
    const kw = findBarKeyword.trim().toLowerCase();
    if (!kw || (!findBarSearchSubject && !findBarSearchBody)) return [];
    const msgs = groupedEmails[selectedSender] || [];
    const result: { id: string; field: "subject" | "body"; fieldIndex: number }[] = [];
    [...msgs].reverse().forEach((e) => {
      if (!findBarBoxFilter[getFindBarBoxKey(e)]) return;
      if (findBarSearchSubject) {
        const count = countOccurrences(e.subject || "", kw);
        for (let i = 0; i < count; i++) result.push({ id: e.id, field: "subject", fieldIndex: i });
      }
      if (findBarSearchBody) {
        const count = countOccurrences(e.body || "", kw);
        for (let i = 0; i < count; i++) result.push({ id: e.id, field: "body", fieldIndex: i });
      }
    });
    return result;
  }, [findBarOpen, findBarKeyword, selectedSender, groupedEmails, findBarSearchSubject, findBarSearchBody, findBarBoxFilter]);

  const goToFindMatch = (index: number) => {
    if (findBarMatches.length === 0) return;
    const wrapped = ((index % findBarMatches.length) + findBarMatches.length) % findBarMatches.length;
    setFindBarMatchIndex(wrapped);
    const target = findBarMatches[wrapped];
    // 現在のフィルターでは他の場所に隠れている可能性があるため、reveal 済み扱いにする
    setRevealedCrossPrompts(prev => prev.includes(target.id) ? prev : [...prev, target.id]);
    scrollToMsg(target.id, target.field, target.fieldIndex);
  };

  const goToNextFindMatch = () => {
    if (findBarMatchIndex === -1) goToFindMatch(0);
    else goToFindMatch(findBarMatchIndex + 1);
  };

  const goToPrevFindMatch = () => {
    if (findBarMatchIndex === -1) goToFindMatch(findBarMatches.length - 1);
    else goToFindMatch(findBarMatchIndex - 1);
  };

  const updateFindBarKeyword = (val: string) => {
    setFindBarKeyword(val);
    setFindBarMatchIndex(-1);
  };

  const setFindBarSearchSubject = (checked: boolean) => {
    setFindBarSearchSubjectState(checked);
    setFindBarMatchIndex(-1);
  };

  const setFindBarSearchBody = (checked: boolean) => {
    setFindBarSearchBodyState(checked);
    setFindBarMatchIndex(-1);
  };

  const setFindBarBox = (key: "inbox" | "archive" | "sent" | "spam" | "trash", checked: boolean) => {
    setFindBarBoxFilter(prev => ({ ...prev, [key]: checked }));
    setFindBarMatchIndex(-1);
  };

  const closeFindBar = () => {
    setFindBarOpen(false);
    setFindBarKeyword("");
    setFindBarMatchIndex(-1);
    if (hasPushedFindBarRef.current) {
      hasPushedFindBarRef.current = false;
      if (window.history.state?.action === "findbar") {
        window.history.back();
      }
    }
  };

  // メッセージ画面の検索ボタンから、モーダルを介さず直接検索バーを開く
  const openFindBar = () => {
    if (!selectedSender) return;
    setFindBarKeyword("");
    setFindBarMatchIndex(-1);
    setFindBarSearchSubjectState(true);
    setFindBarSearchBodyState(true);
    // 既存のチェックボックスとは非同期（別管理）だが、開いた時点の状態を初期値として引き継ぐ
    setFindBarBoxFilter({ inbox: checkInbox, archive: checkArchive, sent: checkSent, spam: checkSpam, trash: checkTrash });
    setFindBarOpen(true);
    if (typeof window !== "undefined" && window.history.state?.action !== "findbar") {
      window.history.pushState({ action: "findbar" }, "", window.location.href);
      hasPushedFindBarRef.current = true;
    }
  };

  // 検索モーダルの件名/本文タブから結果をクリックしたときのジャンプ処理。
  // 検索結果は既に読み込み済みのデータ（allUniqueEmails）から生成されているため、
  // jumpToReplyTarget と異なりGmailへの再取得は不要で、チャットを開いてメッセージ画面上部に
  // Ctrl+F風の検索バー（ハイライト・次/前の一致への移動）を表示する。
  //
  // 注意: モーダルを閉じる際、exitAfterAction()（内部で window.history.go(-N) を使う）は使わない。
  // go()/back() は非同期に処理されるため、その直後に同期的に pushState を重ねると、
  // go() が実行される頃には履歴の位置がずれてしまい、意図しないエントリ（検索バー用など）を
  // 消費してポップされてしまう（＝開いた直後に検索バーが消える不具合の原因だった）。
  // そのため、検索モーダル用のエントリはここで同期的に replaceState で上書きし、
  // go()/back() を一切使わずに済ませる。
  const jumpToSearchResult = (sender: RoomKeyStr, msgId: string, keyword: string, field: "subject" | "body") => {
    setModal(null);
    setSelectionMode("none");
    setSelectedIds([]);
    // 現在のフィルターでは他の場所（アーカイブ等）に隠れている可能性があるため、reveal 済み扱いにする
    setRevealedCrossPrompts(prev => prev.includes(msgId) ? prev : [...prev, msgId]);
    skipFindBarAutoCloseRef.current = true;
    // 検索モーダルで実際にクリックした結果（件名タブ/本文タブ）を検索バーにもそのまま引き継ぐ
    setFindBarSearchSubjectState(field === "subject");
    setFindBarSearchBodyState(field === "body");
    // 検索バー独自の場所フィルターは、ジャンプ先のメッセージを誤って除外しないよう全てONにリセットする
    // （検索モーダル側の場所フィルターは既に別に適用済みのため、ここでは絞り込みは引き継がない）
    setFindBarBoxFilter({ inbox: true, archive: true, sent: true, spam: true, trash: true });

    const cameFromModal = typeof window !== "undefined" && window.history.state?.action === "modal";
    // モバイルでは openChat 自身が {chat: sender} を積む。検索モーダルのエントリは
    // そのままそのチャット用エントリへ置き換える（新規に積まない）
    openChat(sender, { replaceHistory: cameFromModal });
    // デスクトップは openChat がチャット用の履歴操作をしないため、ここで検索モーダルの
    // エントリをそのまま検索バー用エントリへ置き換える
    if (!isMobile && cameFromModal) {
      window.history.replaceState({ action: "findbar" }, "", window.location.href);
      hasPushedFindBarRef.current = true;
    }
    // 検索モーダルの結果はメッセージ単位（そのメッセージ内の何番目の出現かは指定されない）なので、
    // 該当メッセージの中では先頭（0番目）の出現位置へスクロールする
    scrollToMsg(msgId, field, 0);

    const kw = keyword.trim().toLowerCase();
    const occurrences: { id: string }[] = [];
    [...(groupedEmails[sender] || [])].reverse().forEach((e) => {
      const count = countOccurrences(field === "subject" ? (e.subject || "") : (e.body || ""), kw);
      for (let i = 0; i < count; i++) occurrences.push({ id: e.id });
    });
    const idx = occurrences.findIndex((o) => o.id === msgId);

    setFindBarKeyword(keyword);
    setFindBarOpen(true);
    setFindBarMatchIndex(idx);

    if (isMobile) {
      // モバイルは openChat が積んだ {chat: sender} の上に、検索バー用エントリを新たに積む
      // （戻るボタンを押すと検索バーだけ閉じ、チャットは開いたままになる）
      window.history.pushState({ action: "findbar" }, "", window.location.href);
      hasPushedFindBarRef.current = true;
    } else if (!cameFromModal) {
      window.history.pushState({ action: "findbar" }, "", window.location.href);
      hasPushedFindBarRef.current = true;
    }
  };

  const showReplyNotFoundToast = () => {
    setReplyNotFoundToast(true);
    setTimeout(() => setReplyNotFoundToast(false), 2000);
  };

  // Discord風の返信チップをクリックしたときのジャンプ処理。
  // ①今のフィルターで表示中 → そのままスクロール
  // ②読み込み済みだが他の場所（アーカイブ等）にあり「〜が含まれています」のプロンプトになっている → そのボタンへスクロール
  // ③まだ読み込んでいない過去のメール、またはローカルのラベル情報が古い可能性がある場合 →
  //   Message-IDを指定してGmailに直接問い合わせ（rfc822msgid: 検索）、最新の状態で上書きする
  // ④見つからない（削除済み等） → 「このメールは存在しません」をトースト表示
  const jumpToReplyTarget = async (email: Email) => {
    if (!selectedSender || isJumpingToReplyRef.current) return;
    const targetId = email.replyToId as string | undefined;
    const targetHeader = email.inReplyTo as string | undefined;
    if (!targetId && !targetHeader) return;

    const matches = (m: Email) => (!!targetId && m.id === targetId) || (!!targetHeader && !!m.messageIdHeader && m.messageIdHeader === targetHeader);
    // 返信元は同じスレッド上のメッセージなので、返信メール自身と同じアカウントに属する
    const lookupAccountEmail = email.accountId || session?.user?.email || "";
    const lookupParams = new URLSearchParams({ lookupByMessageId: targetHeader || "" });
    if (lookupAccountEmail !== (session?.user?.email || "")) lookupParams.append("accountEmail", lookupAccountEmail);

    const already = emailsRef.current.find(matches);
    // 返信元がほかのチャットのメール（返信元はほかのチャットからも選べる）なら、確かめてからそのチャットへ移ってスクロールする
    if (already && !(groupedEmails[selectedSender] || []).some(matches)) {
      const otherRoom = keysOf(groupedEmails).find(room => room !== selectedSender && !chatConfigs[room]?.filterCriteria && (groupedEmails[room] || []).some(matches));
      if (otherRoom) {
        setComposeDialog({
          kind: "confirm",
          message: `返信元のメールがある${partnerLabel(otherRoom)}とのチャットに移りますか？`,
          confirmLabel: "移る",
          cancelLabel: "やめる",
          onConfirm: () => {
            setRevealedCrossPrompts(prev => prev.includes(already.id) ? prev : [...prev, already.id]);
            void openChat(otherRoom).then(() => scrollToMsg(already.id));
          },
        });
        return;
      }
    }
    // 移動などの楽観的更新がこのメッセージに正しく反映されていない場合に備え、
    // 見つかった場合もすぐ確定させず、裏で最新状態を取得して上書きする（表示は先にスクロールする）
    if (already) { scrollToMsg(already.id); }

    if (!targetHeader) {
      if (!already) showReplyNotFoundToast();
      return;
    }

    if (already && !isJumpingToReplyRef.current) {
      // 既存表示は崩さず、裏で静かに最新情報へ更新するだけ（見つからなくてもトーストは出さない）
      fetch(`/api/emails?${lookupParams.toString()}`)
        .then(res => (res.ok ? res.json() : null))
        .then(data => {
          if (data?.found && data.email) {
            const taggedEmail = { ...data.email, accountId: lookupAccountEmail };
            setEmails(prev => {
              const idx = prev.findIndex(e => e.id === taggedEmail.id);
              if (idx === -1) return prev;
              const next = [...prev];
              next[idx] = taggedEmail;
              return next;
            });
          }
        })
        .catch(() => {});
      return;
    }

    isJumpingToReplyRef.current = true;
    try {
      const res = await fetch(`/api/emails?${lookupParams.toString()}`);
      const data = res.ok ? await res.json() : { found: false };
      if (data.found && data.email) {
        const taggedEmail = { ...data.email, accountId: lookupAccountEmail };
        setEmails(prev => {
          const idx = prev.findIndex(e => e.id === taggedEmail.id);
          if (idx === -1) return [...prev, taggedEmail];
          const next = [...prev];
          next[idx] = taggedEmail; // ローカルに古い情報が残っていた場合に備え、最新の内容で上書きする
          return next;
        });
        scrollToMsg(taggedEmail.id);
      } else {
        showReplyNotFoundToast();
      }
    } catch {
      showReplyNotFoundToast();
    } finally {
      isJumpingToReplyRef.current = false;
    }
  };

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