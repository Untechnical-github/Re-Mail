import { useState } from "react";
import type { MailAppHook } from "../../hooks/useMailApp";
import { ROLE_HINTS } from "../../lib/composeRecipients";
import { checkReceiveOnlyAddress, MAX_RECEIVE_ONLY_ADDRESSES } from "../../lib/ownAddresses";
import { ModalTabs, accountTabLabel } from "./shared";

// 自分のアドレス（README §7.7）：Gmail の sendAs（自動で読み込む）と、手で登録する受信専用アドレス（sendAs に無い、転送されてくるアドレス）。
// 受信専用アドレスはアカウント設定に保存する。sendAs の一覧はメモリにだけ持ち、どこにも保存しない
function OwnAddressesSetting({ app, account }: { app: MailAppHook; account: string }) {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const book = app.actions.ownBookFor(account);
  const saved = app.state.accountSettings[account]?.receiveOnlyAddresses || [];
  const add = () => {
    const r = checkReceiveOnlyAddress(input, book);
    if (!r.ok) { setError(r.reason); return; }
    setError(null);
    setInput("");
    app.actions.setAccountSetting(account, { receiveOnlyAddresses: [...saved, r.address] });
  };
  const remove = (addr: string) => app.actions.setAccountSetting(account, { receiveOnlyAddresses: saved.filter(a => a !== addr) });
  const others = book.sendAs;
  return (
    <div className="bg-[#2B2D31] rounded p-3 mt-3">
      <div className="text-sm font-bold text-gray-200 mb-1">自分のアドレス</div>
      <div className="text-xs text-gray-500 mb-2">
        自分のアドレスごとにチャットが分かれます。Gmail の「他のアドレスからメールを送信」に登録したアドレス（エイリアス・プラスアドレスを含む）は自動で入ります。
        転送されてくるだけのアドレス（Email Routing など）は、下で受信専用アドレスとして登録してください。受信専用アドレスのチャットからは {account} から送信します
      </div>
      <div className="text-[11px] text-gray-400 mb-2 break-all">
        {account}（主アドレス）{others.map(a => `・${a}${book.sendable.includes(a) ? "" : "（確認待ち・受信のみ）"}`).join("")}
      </div>
      <div className="text-xs font-bold text-gray-300 mb-1">受信専用アドレス（{saved.length}/{MAX_RECEIVE_ONLY_ADDRESSES}）</div>
      {saved.length > 0 && (
        <div className="flex flex-col gap-1 mb-2">
          {saved.map(addr => (
            <div key={addr} className="flex items-center gap-2 bg-[#1E1F22] rounded px-2 py-1 text-xs text-gray-300">
              <span className="truncate flex-1" title={addr}>{addr}</span>
              {/* sendAs にも入ったアドレスは、受信専用としては使わない（sendAs として扱う） */}
              {others.includes(addr) && <span className="text-[10px] text-gray-500 flex-shrink-0">Gmail の送信元にあるため不要</span>}
              <button onClick={() => remove(addr)} className="text-gray-400 hover:text-white flex-shrink-0">削除</button>
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <input
          type="email"
          value={input}
          maxLength={254}
          onChange={(e) => { setInput(e.target.value); setError(null); }}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) add(); }}
          placeholder="user@example.com"
          className="flex-1 min-w-0 bg-[#1E1F22] text-sm text-white px-3 py-2 rounded focus:outline-none focus:ring-1 focus:ring-[#5865F2]"
        />
        <button onClick={add} disabled={!input.trim()} className="px-3 py-2 rounded text-sm font-bold bg-[#5865F2] text-white disabled:opacity-40">追加</button>
      </div>
      {error && <div className="text-[11px] text-red-400 mt-1">{error}</div>}
    </div>
  );
}

// 設定: 共通の設定とアカウントごとの設定をタブで切り替える
export function SettingsModal({ app, settingsTab, setSettingsTab }: { app: MailAppHook; settingsTab: string; setSettingsTab: (key: string) => void }) {
  const { safeBack } = app.actions;
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
          <OwnAddressesSetting key={a} app={app} account={a} />
          {/* Gmail の下書きとの同期。既定はオン（保存していない＝オン）。オフにしても、どちらの下書きも消さない */}
          {(() => {
            const on = app.state.accountSettings[a]?.gmailDraftSync !== false;
            return (
              <div className="bg-[#2B2D31] rounded p-3 mt-3">
                <div className="text-sm font-bold text-gray-200 mb-1">Gmail の下書きと同期する</div>
                <div className="text-xs text-gray-500 mb-3">Re:Mail の書きかけを Gmail の下書きに保存し、Gmail の下書きをチャットの入力欄に出します。オフにすると同期をやめるだけで、どちらの下書きも消しません</div>
                <div className="flex gap-2">
                  <button onClick={() => app.actions.setAccountSetting(a, { gmailDraftSync: false })} className={toggleClass(!on)}>オフ</button>
                  <button onClick={() => app.actions.setAccountSetting(a, { gmailDraftSync: true })} className={toggleClass(on)}>オン</button>
                </div>
              </div>
            );
          })()}
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
          {/* 宛先の表示（既定はオフ）。メールの詳細には、設定に関係なく To / Cc（送ったメールなら Bcc も）を出す */}
          {([
            ["showSentRecipients", "送ったメールに宛先の人数を表示する", "このアカウントで送ったメールの時間の横に「To 1・Cc 2・Bcc 1」のように出します"],
            ["showReceivedRecipients", "受け取ったメールに、自分がどの欄で受け取ったかを表示する", "このアカウントで受け取ったメールの時間の横に「To」か「Cc」を出します。どちらにも自分がいないときは「宛先に自分なし」と出します（Bcc・メーリングリスト・自動転送のどれかは分かりません）"],
          ] as const).map(([key, title, desc]) => {
            const on = !!app.state.accountSettings[a]?.[key];
            return (
              <div key={key} className="bg-[#2B2D31] rounded p-3 mt-3">
                <div className="text-sm font-bold text-gray-200 mb-1">{title}</div>
                <div className="text-xs text-gray-500 mb-1">{desc}</div>
                <div className="text-[11px] text-gray-500 mb-3">To：宛先 ／ Cc：ほかの人にも見せる（{ROLE_HINTS.cc}）／ Bcc：こっそり送る（{ROLE_HINTS.bcc}）</div>
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
}
