// メッセージ画面の検索バー（キーワードのハイライト・上下移動・対象の絞り込み）と、検索結果・返信元へのジャンプ。
// useMailApp.ts から分けた（動きは変えない）
import { useMemo, type MutableRefObject } from "react";
import type { Session } from "next-auth";
import type { ChatConfig, SelectionMode, ModalState } from "../types/mail";
import type { Email } from "../types/email";
import { getFindBarBoxKey } from "../lib/filterMatch";
import { type RoomKeyStr, keysOf } from "../lib/roomKey";
import { countOccurrences } from "../lib/mailAppHelpers";
import type { ComposeDialog } from "./useMailApp";
import type { SetState } from "./mailAppTypes";

type BoxKey = "inbox" | "archive" | "sent" | "spam" | "trash";

export function useFindBar({
  session, emailsRef, setEmails, selectedSender, groupedEmails, chatConfigs, isMobile, openChat, partnerLabel,
  findBarOpen, setFindBarOpen, findBarKeyword, setFindBarKeyword, findBarMatchIndex, setFindBarMatchIndex, findBarSearchSubject, setFindBarSearchSubjectState,
  findBarSearchBody, setFindBarSearchBodyState, findBarBoxFilter, setFindBarBoxFilter, hasPushedFindBarRef, skipFindBarAutoCloseRef,
  checkInbox, checkArchive, checkSpam, checkTrash, checkSent, setRevealedCrossPrompts, setModal, setSelectionMode, setSelectedIds,
  setReplyNotFoundToast, isJumpingToReplyRef, setComposeDialog,
}: {
  session: Session | null;
  emailsRef: MutableRefObject<Email[]>;
  setEmails: SetState<Email[]>;
  selectedSender: RoomKeyStr | null;
  groupedEmails: Record<RoomKeyStr, Email[]>;
  chatConfigs: Record<RoomKeyStr, ChatConfig>;
  isMobile: boolean;
  openChat: (sender: RoomKeyStr, opts?: { replaceHistory?: boolean }) => Promise<void>;
  partnerLabel: (room: RoomKeyStr) => string;
  findBarOpen: boolean;
  setFindBarOpen: SetState<boolean>;
  findBarKeyword: string;
  setFindBarKeyword: SetState<string>;
  findBarMatchIndex: number;
  setFindBarMatchIndex: SetState<number>;
  findBarSearchSubject: boolean;
  setFindBarSearchSubjectState: SetState<boolean>;
  findBarSearchBody: boolean;
  setFindBarSearchBodyState: SetState<boolean>;
  findBarBoxFilter: Record<BoxKey, boolean>;
  setFindBarBoxFilter: SetState<Record<BoxKey, boolean>>;
  hasPushedFindBarRef: MutableRefObject<boolean>;
  skipFindBarAutoCloseRef: MutableRefObject<boolean>;
  checkInbox: boolean;
  checkArchive: boolean;
  checkSpam: boolean;
  checkTrash: boolean;
  checkSent: boolean;
  setRevealedCrossPrompts: SetState<string[]>;
  setModal: SetState<ModalState>;
  setSelectionMode: SetState<SelectionMode>;
  setSelectedIds: SetState<string[]>;
  setReplyNotFoundToast: SetState<boolean>;
  isJumpingToReplyRef: MutableRefObject<boolean>;
  setComposeDialog: SetState<ComposeDialog | null>;
}) {
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

  return {
    findBarMatches, goToNextFindMatch, goToPrevFindMatch, updateFindBarKeyword, setFindBarSearchSubject, setFindBarSearchBody, setFindBarBox, closeFindBar, openFindBar,
    jumpToSearchResult, jumpToReplyTarget,
  };
}
