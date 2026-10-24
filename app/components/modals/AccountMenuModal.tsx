import { signOut } from "next-auth/react";
import { WarningIcon } from "../ui";
import type { MailAppHook } from "../../hooks/useMailApp";
import { clearDeviceData } from "../../lib/deviceData";

// アカウントメニュー: ログインしているアカウントの一覧・アカウントごとのログアウト・別のアカウントでのログイン
export function AccountMenuModal({ app, logoutConfirm, setLogoutConfirm }: { app: MailAppHook; logoutConfirm: string | null; setLogoutConfirm: (account: string | null) => void }) {
  const { safeBack } = app.actions;
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
}
