import type { Email } from "../../types/email";

// 設定・フィルターの画面のタブ。見た目はチャット一覧のタブ（個人チャット／グループチャット／フィルター）と同じ
export function ModalTabs({ tabs, active, onChange }: { tabs: { key: string; label: string; title?: string }[]; active: string; onChange: (key: string) => void }) {
  return (
    <div className="flex gap-1 overflow-x-auto mb-4">
      {tabs.map(t => (
        <button
          key={t.key}
          title={t.title}
          onClick={() => onChange(t.key)}
          className={`flex-1 min-w-[5rem] px-2 py-1.5 rounded text-xs font-bold transition truncate ${active === t.key ? "bg-[#5865F2] text-white" : "bg-[#2B2D31] text-gray-400 hover:bg-[#3f4147]"}`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// タブに出すアカウントの短い名前（名前があれば名前、無ければアドレスの @ より前）
export function accountTabLabel(account: string, name?: string): string {
  return name || account.split("@")[0] || account;
}

export type BoxKey = "inbox" | "archive" | "sent" | "spam" | "trash";

export const SEARCH_BOX_LABELS: Record<BoxKey, string> = {
  inbox: "受信箱", archive: "アーカイブ", sent: "送信済み", spam: "迷惑メール", trash: "ゴミ箱",
};

export function getSearchBoxInfo(e: Email): { key: BoxKey; name: string } {
  const isTrash = e.labelIds?.includes("TRASH");
  const isSpam = e.labelIds?.includes("SPAM");
  const isInbox = e.labelIds?.includes("INBOX");
  const isSent = e.labelIds?.includes("SENT") || e.isMe;
  const key: BoxKey = isSent ? "sent" : isTrash ? "trash" : isSpam ? "spam" : isInbox ? "inbox" : "archive";
  return { key, name: SEARCH_BOX_LABELS[key] };
}
