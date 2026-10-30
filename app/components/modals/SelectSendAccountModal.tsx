import type { MailAppHook } from "../../hooks/useMailApp";

export function SelectSendAccountModal({ app }: { app: MailAppHook }) {
  const { selectedSender } = app.state;
  const { safeBack } = app.actions;
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
      {/* 差出人のアドレスは選ぶものではなく、チャットの自分のアドレスで決まる（自分のアドレスごとにチャットが分かれている。README §7.7） */}
      {(() => {
        const aliases = ((app.state.sendAsByAccount as Record<string, { sendAsEmail: string }[]>)[current] || []).filter(a => a.sendAsEmail.toLowerCase() !== current.toLowerCase());
        if (aliases.length === 0) return null;
        return (
          <div className="text-[11px] text-gray-500 mb-4">
            {current} のエイリアス：{aliases.map(a => a.sendAsEmail).join("、")}。差出人のアドレスはチャットごとに決まっています（そのアドレスに届いたメールのチャットから送ると、そのアドレスから送ります）。別のアドレスから送るときは、新しいチャットの作成で差出人を選んでください
          </div>
        );
      })()}
      <button onClick={() => safeBack()} className="w-full py-2 hover:underline text-gray-400 text-sm">キャンセル</button>
    </div>
  );
}
