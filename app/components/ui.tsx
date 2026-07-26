"use client";

import React, { useState } from "react";
import { chatConfigTab } from "../lib/filterMatch";

// field/matchCountBefore/activeField/activeIndex は、メッセージ画面の検索バーで
// 「今対象として表示されている一致箇所」だけをオレンジにするための仕組み。
// matchCountBefore はこの text より前（同じfield内の前のセグメント）に何件既に一致があったかを表し、
// 各 <mark> のグローバルな出現番号 = matchCountBefore + このtext内でのローカルな出現番号 で判定する
export const HighlightText = ({ text, highlight, field, matchCountBefore = 0, activeField, activeIndex }: {
  text: string;
  highlight: string;
  field?: "subject" | "body";
  matchCountBefore?: number;
  activeField?: "subject" | "body";
  activeIndex?: number;
}) => {
  if (!highlight) return <>{text}</>;
  const parts = text.split(new RegExp(`(${highlight})`, 'gi'));
  let localMatchIdx = 0;
  return (
    <>
      {parts.map((part, i) => {
        if (part.toLowerCase() !== highlight.toLowerCase()) return part;
        const globalIdx = matchCountBefore + localMatchIdx;
        localMatchIdx++;
        const isActive = field !== undefined && activeField === field && activeIndex === globalIdx;
        return (
          <mark
            key={i}
            data-field={field}
            data-match-index={globalIdx}
            className={isActive ? "bg-[#FFA500] text-black font-bold px-0.5 rounded-sm" : "bg-[#FEE75C] text-black font-bold px-0.5 rounded-sm"}
          >
            {part}
          </mark>
        );
      })}
    </>
  );
};

// text内でhighlightが大文字小文字区別なく出現する回数を数える（BodyWithLinksでのセグメントごとの件数集計用）
function countHighlightOccurrences(text: string, highlight: string): number {
  if (!highlight) return 0;
  const lower = text.toLowerCase();
  const kw = highlight.toLowerCase();
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = lower.indexOf(kw, pos);
    if (idx === -1) break;
    count++;
    pos = idx + kw.length;
  }
  return count;
}

export function BodyWithLinks({ text, highlight, htmlLinks, field, activeField, activeIndex }: {
  text: string;
  highlight?: string;
  htmlLinks?: Array<{ text: string; href: string }>;
  field?: "subject" | "body";
  activeField?: "subject" | "body";
  activeIndex?: number;
}) {
  const [preview, setPreview] = useState<{ url: string; x: number; y: number } | null>(null);

  const src = text || "";

  // クリック可能な範囲を収集
  type Range =
    | { kind: "url"; start: number; end: number; rawEnd: number; url: string; trailing: string }
    | { kind: "html"; start: number; end: number; href: string; linkText: string };

  const ranges: Range[] = [];

  // 生URLの範囲を収集
  const urlRe = /https?:\/\/[^\s<>"]+/g;
  let um: RegExpExecArray | null;
  while ((um = urlRe.exec(src)) !== null) {
    const url = um[0].replace(/[.,;:!?)\]>'"。、，；：！？）]+$/, "");
    if (url) {
      ranges.push({ kind: "url", start: um.index, end: um.index + url.length, rawEnd: um.index + um[0].length, url, trailing: um[0].slice(url.length) });
    }
  }

  // HTML リンクの範囲を収集（既存範囲と重複しない最初の出現箇所）
  if (htmlLinks?.length) {
    const isUsed = (s: number, e: number) =>
      ranges.some(r => r.start < e && (r.kind === "url" ? r.rawEnd : r.end) > s);
    for (const { text: lt, href } of htmlLinks) {
      if (!lt) continue;
      let from = 0;
      while (from < src.length) {
        const idx = src.indexOf(lt, from);
        if (idx === -1) break;
        const end = idx + lt.length;
        if (!isUsed(idx, end)) {
          ranges.push({ kind: "html", start: idx, end, href, linkText: lt });
          break;
        }
        from = idx + 1;
      }
    }
  }

  ranges.sort((a, b) => a.start - b.start);

  const parts: React.ReactNode[] = [];
  let lastIdx = 0;
  // 分割された各セグメントより前に既に何件一致したかを追跡する（オレンジ表示位置の判定用）
  let matchesSoFar = 0;

  for (const r of ranges) {
    if (r.start < lastIdx) continue;
    if (r.start > lastIdx) {
      const seg = src.slice(lastIdx, r.start);
      parts.push(highlight ? <HighlightText key={`t-${lastIdx}`} text={seg} highlight={highlight} field={field} matchCountBefore={matchesSoFar} activeField={activeField} activeIndex={activeIndex} /> : seg);
      if (highlight) matchesSoFar += countHighlightOccurrences(seg, highlight);
    }
    if (r.kind === "url") {
      const url = r.url;
      parts.push(
        <a key={`u-${r.start}`} href={url} target="_blank" rel="noopener noreferrer"
          className="text-[#5865F2] underline underline-offset-2 hover:text-[#7289DA] break-all"
          onClick={(e) => e.stopPropagation()}
          onMouseEnter={(e) => {
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const y = (window.innerHeight - rect.bottom) > 130 ? rect.bottom + 8 : rect.top - 128;
            setPreview({ url, x: Math.max(8, Math.min(rect.left, window.innerWidth - 296)), y });
          }}
          onMouseLeave={() => setPreview(null)}
        >
          {highlight ? <HighlightText text={url} highlight={highlight} field={field} matchCountBefore={matchesSoFar} activeField={activeField} activeIndex={activeIndex} /> : url}
        </a>
      );
      if (highlight) matchesSoFar += countHighlightOccurrences(url, highlight);
      if (r.trailing) parts.push(r.trailing);
      lastIdx = r.rawEnd;
    } else {
      // HTMLリンク: 下線+クリック+プレビュー
      const hrefForPreview = r.href;
      parts.push(
        <a key={`h-${r.start}`} href={r.href} target="_blank" rel="noopener noreferrer"
          className="text-[#5865F2] underline underline-offset-2 hover:text-[#7289DA]"
          onClick={(e) => e.stopPropagation()}
          onMouseEnter={(e) => {
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const y = (window.innerHeight - rect.bottom) > 130 ? rect.bottom + 8 : rect.top - 128;
            setPreview({ url: hrefForPreview, x: Math.max(8, Math.min(rect.left, window.innerWidth - 296)), y });
          }}
          onMouseLeave={() => setPreview(null)}
        >
          {highlight ? <HighlightText text={r.linkText} highlight={highlight} field={field} matchCountBefore={matchesSoFar} activeField={activeField} activeIndex={activeIndex} /> : r.linkText}
        </a>
      );
      if (highlight) matchesSoFar += countHighlightOccurrences(r.linkText, highlight);
      lastIdx = r.end;
    }
  }

  if (lastIdx < src.length) {
    const remaining = src.slice(lastIdx);
    parts.push(highlight ? <HighlightText key="t-tail" text={remaining} highlight={highlight} field={field} matchCountBefore={matchesSoFar} activeField={activeField} activeIndex={activeIndex} /> : remaining);
  }

  let domain = "";
  if (preview) { try { domain = new URL(preview.url).hostname; } catch {} }

  return (
    <>
      {parts}
      {preview && (
        <div className="fixed z-[70] pointer-events-none" style={{ top: preview.y, left: preview.x }}>
          <div className="bg-[#1E1F22] border border-[#404249] rounded-lg shadow-2xl p-3 w-72">
            <div className="flex items-center gap-1.5 mb-1">
              <span className="text-[11px]">🔗</span>
              <span className="text-xs font-bold text-gray-200 truncate">{domain}</span>
            </div>
            <div className="text-[11px] text-gray-500 break-all leading-relaxed"
              style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" } as React.CSSProperties}>
              {preview.url}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// 絵文字はOS/フォントによって見た目が大きく異なる（Windows/Mac/Androidで別デザインになる）ため、
// ピン留め・添付ファイル関連のアイコンは既存の設定/フィルターボタンと同じ単色SVGに統一する

export function PinIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z" />
    </svg>
  );
}

export function PaperclipIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.31 2.69 6 6 6s6-2.69 6-6V6h-2.5z" />
    </svg>
  );
}

export function WarningIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" />
    </svg>
  );
}

function ImageFileIcon({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z" />
    </svg>
  );
}

function AudioFileIcon({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
    </svg>
  );
}

function VideoFileIcon({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z" />
    </svg>
  );
}

function GenericFileIcon({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M6 2c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6H6zm7 7V3.5L18.5 9H13z" />
    </svg>
  );
}

export function getFileIcon(mimeType: string, className: string = "w-5 h-5"): React.ReactNode {
  if (mimeType.startsWith('image/')) return <ImageFileIcon className={className} />;
  if (mimeType.startsWith('audio/')) return <AudioFileIcon className={className} />;
  if (mimeType.startsWith('video/')) return <VideoFileIcon className={className} />;
  return <GenericFileIcon className={className} />;
}

// アクションバー・ボックスフィルター・送信ボタン用のアイコン一式（設定でON/OFFできる「文字→アイコン」表示切替用）。
// 既存のPinIcon等と同じく単色fillのSVGで統一する

export function SelectAllIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-9 14l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
    </svg>
  );
}

export function CloseIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
    </svg>
  );
}

export function PlusIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M19 13H13v6h-2v-6H5v-2h6V5h2v6h6v2z" />
    </svg>
  );
}

export function EditIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
    </svg>
  );
}

export function CopyIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" />
    </svg>
  );
}

export function FolderIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
    </svg>
  );
}

export function TrashIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
    </svg>
  );
}

export function RefreshIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
    </svg>
  );
}

// 右向き矢印（転送）。座標は自前で組んだ単純な矢印形状（軸+三角の頭）
export function ForwardArrowIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M4 11h10V7l6 5-6 5v-4H4z" />
    </svg>
  );
}

// 左向き矢印（返信・リプライ）。ForwardArrowIconの左右反転版
export function ReplyArrowIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M20 13H10v4l-6-5 6-5v4h10z" />
    </svg>
  );
}

// 非表示（目に斜線）。この1つだけ線画スタイル（斜線が塗りつぶしを突き抜けて見えるようにするため）
export function HideIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z" />
      <circle cx="12" cy="12" r="2.5" />
      <line x1="3" y1="3" x2="21" y2="21" />
    </svg>
  );
}

export function InboxIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M19 3H4.99c-1.11 0-1.98.9-1.98 2L3 19c0 1.1.89 2 1.99 2H19c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 12h-4c0 1.66-1.35 3-3 3s-3-1.34-3-3H4.99V5H19v10z" />
    </svg>
  );
}

export function ArchiveIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M20.54 5.23l-1.39-1.68C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27zM6.24 5h11.52l.81.97H5.44l.8-.97zM5 19V8h14v11H5zm8.45-9h-2.9v3H8l4 4 4-4h-2.55z" />
    </svg>
  );
}

export function SendIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
    </svg>
  );
}

// 迷惑メール（八角形+「！」）。八角形も「！」の穴も自前の座標で正確に組んだ形状
export function SpamIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className}>
      <path fillRule="evenodd" clipRule="evenodd" fill="currentColor" d="M9 3h6l6 6v6l-6 6H9l-6-6v-6z M11 8h2v6h-2z M11 16h2v2h-2z" />
    </svg>
  );
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export function ActionBar({ app, isChat }: { app: any, isChat: boolean }) {
  const modePrefix = isChat ? "chat" : "msg";
  const { selectionMode, selectedIds } = app.state;
  const { handleMenuBarClick, setModal, setSelectedIds, setRenameInput,
          setReplySubject, setReplyBody, setReplyToMessage, safeBack, enterSelectionMode } = app.actions;

  const [showCopiedToast, setShowCopiedToast] = useState(false);

  const isAnySelection = selectionMode === `${modePrefix}_select`;
  const hasItems = selectedIds.length > 0;

  // チャットのピン留め・非表示は制限なし。メッセージは従来通り
  const isActionRestrictedForAll = (action: string): boolean => {
    if (!hasItems) return false;
    return selectedIds.every((id: string) => {
      if (isChat) {
        if (action === "pin" || action === "hide") return false;
        const chatEmails: any[] = app.computed.groupedEmails[id] || [];
        if (chatEmails.length === 0) return false;
        if (action === "delete")
          return chatEmails.every((e: any) => e.labelIds?.includes("TRASH") || e.labelIds?.includes("SENT") || e.isMe);
        if (action === "move")
          return chatEmails.every((e: any) => e.labelIds?.includes("SENT") || e.isMe);
      } else {
        const msg = app.computed.allUniqueEmails.find((e: any) => e.id === id);
        if (!msg) return true;
        const isTrash = msg.labelIds?.includes("TRASH");
        const isSpam = msg.labelIds?.includes("SPAM");
        const isSent = msg.labelIds?.includes("SENT") || msg.isMe;
        // ピン留め・非表示は送信済みメールも対象にできる（ゴミ箱・迷惑メールのみ対象外）
        if (action === "pin" || action === "hide") return isTrash || isSpam;
        if (action === "delete") return isTrash || isSent;
        if (action === "move") return isSent;
      }
      return false;
    });
  };

  const hasSelectedTarget = selectedIds.some((id: string) => {
    if (isChat) return true; // チャットは常に対象
    const msg = app.computed.allUniqueEmails.find((e: any) => e.id === id);
    return msg && !msg.labelIds?.includes("TRASH") && !msg.labelIds?.includes("SPAM");
  });

  const isDisabled = (action: string): boolean => {
    // リセットは常に有効（このボタン自体はチャット画面にしか描画されない）。無選択時は
    // 全チャット/メッセージから選ぶ画面を開く
    if (action === "reset") return false;
    if (!isAnySelection || !hasItems) return true;
    if ((action === "pin" || action === "hide") && !isChat && !hasSelectedTarget) return true;
    return isActionRestrictedForAll(action);
  };

  const btnBase = isChat
    ? "flex-1 min-w-[54px] py-1.5 text-[10px] font-bold rounded transition"
    : "px-2.5 py-1 text-xs font-bold rounded transition";

  const getBtnClass = (action: string, danger = false) => {
    const disabled = isDisabled(action);
    const hoverClass = danger ? "hover:bg-[#DA373C]" : "hover:bg-[#5865F2]";
    const colorClass = !disabled
      ? `bg-[#2B2D31] text-gray-200 border border-[#4752C4] ${hoverClass} hover:text-white`
      : "bg-[#1E1F22] text-gray-400";
    return `${btnBase} ${colorClass} ${disabled ? "opacity-30 pointer-events-none grayscale" : ""}`;
  };

  const useIconLabels = !!app.state.useIconLabels;
  // withCount=true のボタンは、選択中の件数を末尾に付ける（アイコン表示時は小さな数字バッジとして添える）
  const renderLabel = (text: string, icon: React.ReactNode, withCount = false) => {
    const count = withCount && isAnySelection && hasItems ? `(${selectedIds.length})` : "";
    if (useIconLabels) {
      return (
        <span className="flex items-center justify-center gap-1" title={`${text}${count}`}>
          {icon}
          {count && <span className="text-[10px]">{count}</span>}
        </span>
      );
    }
    return `${text}${count}`;
  };

  const containerClass = isChat
    ? "flex flex-wrap p-2 gap-1 border-b border-[#1E1F22] bg-[#2B2D31] cursor-default"
    : "flex flex-wrap px-3 py-2 gap-1.5 border-b border-[#1E1F22] bg-[#2B2D31] cursor-default";

  const handleSelectAll = () => {
    if (isChat) {
      // 現在表示中のタブ（個人 / グループ / フィルター）に含まれるチャットだけを対象にする
      const allIds = (app.computed.senderList as string[]).filter(
        (id: string) => chatConfigTab(app.state.chatConfigs[id]) === app.state.activeChatTab
      );
      if (!isAnySelection) enterSelectionMode("chat", allIds[0]);
      setSelectedIds(allIds);
    } else {
      const allIds = ((app.computed.groupedEmails[app.state.selectedSender] || []) as any[]).map((e: any) => e.id);
      if (!isAnySelection) enterSelectionMode("msg", allIds[0]);
      setSelectedIds(allIds);
    }
  };

  const selectedMsg = !isChat && selectedIds.length === 1
    ? app.computed.allUniqueEmails.find((e: any) => e.id === selectedIds[0])
    : null;

  const allPinned = isAnySelection && hasItems && selectedIds.every((id: string) =>
    isChat ? app.state.chatConfigs[id]?.isPinned : app.state.messageConfigs[app.actions.messageConfigKey(id)]?.isPinned
  );

  const showBanner = isAnySelection && hasItems;

  // グループは1つのアカウントから送信する前提のため、複数アカウントのチャットを
  // またいで選択している場合は「作成」（選択チャットをメンバーにしたグループ作成）を無効化する
  const selectedSpansMultipleAccounts = isChat && isAnySelection && hasItems &&
    new Set(selectedIds.map((id: string) => app.actions.roomAccountEmail(id))).size > 1;

  // グループチャットの表示モードによるアクションバー制限
  const selectedGroupConfig = !isChat ? app.state.chatConfigs[app.state.selectedSender] : undefined;
  const isInboundOnlyGroupBar = !!(selectedGroupConfig?.isGroup && selectedGroupConfig.groupMode === "inbound_only");
  const isOutboundOnlyGroupBar = !!(selectedGroupConfig?.isGroup && selectedGroupConfig.groupMode === "outbound_only");

  return (
    <>
      {showCopiedToast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[80] bg-[#2B2D31] text-white text-sm font-bold px-4 py-2 rounded-full shadow-lg border border-[#4752C4] animate-fade-in pointer-events-none">
          コピーしました
        </div>
      )}
      <div className={`${containerClass} ${isOutboundOnlyGroupBar ? "opacity-30 pointer-events-none grayscale" : ""}`} onClick={(e) => e.stopPropagation()}>
      {showBanner && (
        <div className="w-full text-center text-[10px] text-[#5865F2] font-bold py-0.5">
          {selectedIds.length}件選択中
        </div>
      )}

      {/* 全選択 */}
      <button onClick={handleSelectAll} className={`${btnBase} bg-[#1E1F22] text-gray-400 hover:bg-[#3f4147] hover:text-gray-200`}>
        {renderLabel("全選択", <SelectAllIcon className="w-4 h-4" />)}
      </button>

      {/* キャンセル */}
      <button
        onClick={() => { if (isAnySelection) safeBack(); }}
        className={`${btnBase} bg-[#1E1F22] text-gray-400 hover:bg-[#3f4147] hover:text-gray-200 ${!isAnySelection ? "opacity-30 pointer-events-none grayscale" : ""}`}
      >
        {renderLabel("キャンセル", <CloseIcon className="w-4 h-4" />)}
      </button>

      {/* チャット: 作成（未選択なら通常通り新規作成、選択中ならそのチャットを選択済みの状態でモーダルを開く） */}
      {isChat && (
        <button
          onClick={() => {
            if (selectedSpansMultipleAccounts) return;
            const preSelected = isAnySelection && hasItems
              ? selectedIds.filter((id: string) => !app.state.chatConfigs[id]?.isGroup)
              : [];
            // 選択モードの履歴(select)の上にモーダルの履歴を重ねて積む。
            // ここで先に selectionMode を終了しようとすると（history.back 等）、
            // それによる popstate が非同期で後から発火し、直後に開いたこのモーダルを
            // 巻き込んで setModal(null) してしまう（一瞬で閉じて見える不具合の原因）ため、
            // 選択の終了はモーダル側の完了処理（exitAfterAction）にまとめて任せる
            setModal({ type: "compose_new_chat", targetMode: "current_chat", targets: preSelected });
            window.history.pushState({ action: "modal" }, "", window.location.href);
          }}
          title={selectedSpansMultipleAccounts ? "複数のアカウントにまたがるチャットからはグループを作成できません" : undefined}
          className={`${btnBase} bg-[#1E1F22] text-gray-400 hover:bg-[#3f4147] hover:text-gray-200 ${selectedSpansMultipleAccounts ? "opacity-30 pointer-events-none grayscale" : ""}`}
        >
          {renderLabel("作成", <PlusIcon className="w-4 h-4" />)}
        </button>
      )}

      {/* チャット: 名前変更（チャット選択モードで1件選択時のみ有効。selectedIds はメッセージ選択と
          共有のstateのため、selectionMode 自体もチェックしないとメッセージを1件選択しただけで
          このボタンが（メッセージIDを対象に）押せてしまっていた */}
      {isChat && (
        <button
          onClick={() => {
            if (!isAnySelection || selectedIds.length !== 1) return;
            const id = selectedIds[0];
            setRenameInput(app.state.chatConfigs[id]?.customName || app.actions.roomLocalKey(id));
            setModal({ type: "rename", targetMode: "chat", targets: [id] });
            window.history.pushState({ action: "modal" }, "", window.location.href);
          }}
          className={`${btnBase} bg-[#1E1F22] text-gray-400 hover:bg-[#3f4147] hover:text-gray-200 ${!isAnySelection || selectedIds.length !== 1 ? "opacity-30 pointer-events-none grayscale" : ""}`}
        >
          {renderLabel("名前変更", <EditIcon className="w-4 h-4" />)}
        </button>
      )}

      {/* メッセージ: 転送・リプライ・コピー（1件選択時のみ有効） */}
      {!isChat && (
        <>
          <button
            onClick={() => {
              if (!selectedMsg) return;
              // 「作成」と同じ宛先選択モーダルを転送モードで開く。選択モードの履歴の上に
              // モーダルの履歴を重ねるだけにし、選択の終了はモーダル側の完了処理に任せる
              // （先にここで選択を終了すると、その非同期popstateがモーダルを巻き込んで閉じてしまうため）
              setModal({ type: "compose_new_chat", targetMode: "current_chat", targets: [], composeMode: "forward", forwardMessage: selectedMsg } as any);
              window.history.pushState({ action: "modal" }, "", window.location.href);
            }}
            className={`${btnBase} bg-[#1E1F22] text-gray-400 hover:bg-[#3f4147] hover:text-gray-200 ${!selectedMsg ? "opacity-30 pointer-events-none grayscale" : ""}`}
          >
            {renderLabel("転送", <ForwardArrowIcon className="w-4 h-4" />)}
          </button>
          <button
            onClick={() => {
              if (!selectedMsg || isInboundOnlyGroupBar) return;
              setReplyToMessage(selectedMsg);
              setReplySubject(selectedMsg.subject?.startsWith("Re:") ? selectedMsg.subject : `Re: ${selectedMsg.subject || ""}`);
              if (isAnySelection) safeBack();
            }}
            className={`${btnBase} bg-[#1E1F22] text-gray-400 hover:bg-[#3f4147] hover:text-gray-200 ${(!selectedMsg || isInboundOnlyGroupBar) ? "opacity-30 pointer-events-none grayscale" : ""}`}
          >
            {renderLabel("リプライ", <ReplyArrowIcon className="w-4 h-4" />)}
          </button>
          <button
            onClick={() => {
              if (!selectedMsg) return;
              navigator.clipboard.writeText(selectedMsg.body || "").then(() => {
                setShowCopiedToast(true);
                setTimeout(() => setShowCopiedToast(false), 1500);
              }).catch(() => {});
              if (isAnySelection) safeBack();
            }}
            className={`${btnBase} bg-[#1E1F22] text-gray-400 hover:bg-[#3f4147] hover:text-gray-200 ${!selectedMsg ? "opacity-30 pointer-events-none grayscale" : ""}`}
          >
            {renderLabel("コピー", <CopyIcon className="w-4 h-4" />)}
          </button>
        </>
      )}

      {/* ピン留め / ピン解除 */}
      <button onClick={() => handleMenuBarClick(`${modePrefix}_${allPinned ? "unpin" : "pin"}`)} className={getBtnClass("pin")}>
        {renderLabel(allPinned ? "ピン解除" : "ピン留め", <PinIcon className="w-4 h-4" />, true)}
      </button>

      {/* 移動 */}
      <button onClick={() => handleMenuBarClick(`${modePrefix}_move`)} className={getBtnClass("move")}>
        {renderLabel("移動", <FolderIcon className="w-4 h-4" />, true)}
      </button>

      {/* 非表示 */}
      <button onClick={() => handleMenuBarClick(`${modePrefix}_hide`)} className={getBtnClass("hide")}>
        {renderLabel("非表示", <HideIcon className="w-4 h-4" />, true)}
      </button>

      {/* 削除 */}
      <button onClick={() => handleMenuBarClick(`${modePrefix}_delete`)} className={getBtnClass("delete", true)}>
        {renderLabel("削除", <TrashIcon className="w-4 h-4" />, true)}
      </button>

      {/* リセット: チャット画面のみ。選択チャットがあればその範囲、無ければ全体から選ぶ画面を開く */}
      {isChat && (
        <button onClick={() => handleMenuBarClick("chat_reset")} className={getBtnClass("reset", true)}>
          {renderLabel("リセット", <RefreshIcon className="w-4 h-4" />, true)}
        </button>
      )}
      </div>
    </>
  );
}
