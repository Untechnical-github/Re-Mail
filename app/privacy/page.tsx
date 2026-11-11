// プライバシーポリシー（ログインしなくても見られる。OAuth 同意画面のブランディングから参照する）
// データは取らず、決まった本文を出すだけ。外部の画像・フォント・スクリプトは使わない
import type { ReactNode } from "react";
import { PRIVACY_CONTACT_EMAIL } from "./contact";

export const metadata = { title: "プライバシーポリシー | Re:Mail" };

function H2({ children }: { children: ReactNode }) {
  return <h2 className="mt-10 mb-4 text-xl font-bold text-[#5865F2]">{children}</h2>;
}
function Sub({ children }: { children: ReactNode }) {
  return <p className="mt-5 mb-2 font-bold text-white">{children}</p>;
}
function List({ children }: { children: ReactNode }) {
  return <ul className="list-disc space-y-1 pl-6">{children}</ul>;
}
function Ext({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} target="_blank" rel="noopener noreferrer" className="text-[#5865F2] underline hover:text-[#7983F5]">{children}</a>;
}

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-[#313338] text-gray-200">
      <div className="mx-auto max-w-3xl px-6 py-10 leading-relaxed break-words">
        <h1 className="mb-4 text-2xl font-extrabold text-[#5865F2] sm:text-3xl">Re:Mail プライバシーポリシー</h1>
        <p className="mb-6 text-sm text-gray-400">制定日：2026年11月11日</p>
        <p>Re:Mail（以下「本サービス」）は、Gmail を相手ごとのチャットの形で読み書きできるようにする Web アプリです。本サービスは Google アカウントとメールという大切な情報を扱うため、<strong className="text-white">メールを預からないこと、外に出さないこと</strong>を前提に作っています。このページでは、本サービスがどんな情報を、どう扱うかを説明します。</p>

        <H2>1. 本サービスが扱う情報</H2>
        <Sub>Google アカウントの基本情報</Sub>
        <List>
          <li>メールアドレス、名前、プロフィール画像</li>
          <li>ログインと、アカウントの見分け・表示に使います。</li>
        </List>
        <Sub>Gmail のデータ</Sub>
        <p className="mb-2">本サービスは、Google に <code className="rounded bg-[#2B2D31] px-1">gmail.modify</code> の権限を求めます。この権限で次のことを行います。</p>
        <List>
          <li>メール（本文・件名・宛先・添付・ラベル）を読み、チャットの形で表示する</li>
          <li>利用者が書いたメールを、利用者のアカウントから送る</li>
          <li>下書きを Gmail に保存し、Gmail の下書きを本サービスに表示する</li>
          <li>既読・ボックスの移動・ゴミ箱への移動・完全な削除など、利用者が本サービスで行った操作を Gmail に反映する</li>
          <li>送信元のアドレス（エイリアス）や署名の設定を読む</li>
        </List>
        <p className="mt-2">これらはすべて、<strong className="text-white">利用者が画面で操作したとき、または表示に必要なときにだけ</strong>行います。</p>
        <Sub>本サービスでの設定</Sub>
        <List>
          <li>チャットのピン留め・非表示・名前の変更・グループ・フィルター、共通の設定、アカウントごとの設定</li>
        </List>

        <H2>2. 情報の保存場所</H2>
        <p><strong className="text-white">メールの中身は、本サービスのサーバーに保存しません。</strong><br />本文・件名・宛先・添付は、Gmail と利用者のブラウザのあいだを中継するだけで、サーバーには残りません。メールの正本は常に Gmail にあります。</p>
        <Sub>サーバー（Cloudflare D1）に保存するもの</Sub>
        <List>
          <li>本サービスでの設定</li>
          <li>複数のアカウントでログインしたときの、各アカウントのアクセス用の情報（OAuth トークン）、表示用の名前・プロフィール画像の URL</li>
        </List>
        <p className="mt-2">どれも保存する前に暗号化します（AES-256-GCM）。メールアドレスや相手の名前など、探すための目印として使う値は、元に戻せない形（HMAC）に変えてから保存します。平文のメールアドレスやトークンは保存しません。</p>
        <Sub>ログイン状態</Sub>
        <p>ログイン中のアカウントのアクセス用の情報は、暗号化した Cookie に入れます。</p>
        <Sub>利用者の端末（ブラウザ）に保存するもの</Sub>
        <List>
          <li>表示を速くするためのキャッシュ（メールの一覧・添付など）と、書きかけの本文</li>
          <li>これらはアカウントごとに分けて保存します。ログアウトすると消えます。アカウントを1つだけログアウトしたときは、そのアカウントの分だけが消えます。</li>
          <li>個人の情報を含まない見た目の設定（アイコンの表示など）だけは、ログアウトしても端末に残ります。</li>
        </List>
        <Sub>ログ</Sub>
        <p>障害を調べるためのログには、処理の名前・成功か失敗か・エラーの種類・件数・かかった時間・Gmail のメッセージ ID（意味を持たない英数字）だけを残します。メールアドレス・名前・件名・本文・トークンはログに残しません。</p>

        <H2>3. 第三者への提供</H2>
        <List>
          <li>本サービスは、利用者の情報を第三者に<strong className="text-white">提供・販売しません</strong>。</li>
          <li>広告・アクセス解析・外部の CDN・外部のフォントは使っていません。</li>
          <li>本サービスは Cloudflare（Workers・D1）の上で動いています。Cloudflare は本サービスの基盤として通信と保存を担いますが、上のとおり保存する情報は暗号化しています。</li>
          <li>法令に基づいて開示を求められた場合は、法令の範囲で対応します。</li>
        </List>

        <H2>4. HTML メールの画像</H2>
        <p>HTML メールに含まれる外部の画像（開封を送り手に知らせる「トラッキングピクセル」を含む）は、利用者が表示を選んだとき、または利用者がそう設定したときにだけ読み込みます。</p>

        <H2>5. Google API から受け取った情報の扱い</H2>
        <p className="mb-2">本サービスが Google API から受け取った情報の使用と、ほかのアプリへの転送は、<Ext href="https://developers.google.com/terms/api-services-user-data-policy">Google API サービスのユーザーデータに関するポリシー</Ext>（限定使用の要件を含む）に従います。具体的には、</p>
        <List>
          <li>Gmail のデータは、利用者が使う本サービスの機能を提供するためだけに使います。</li>
          <li>広告のために使ったり、販売したりしません。</li>
          <li>AI や機械学習のモデルを学習させるためには使いません。</li>
          <li>人がメールの中身を読むことはありません。例外は、利用者が明示的に同意したとき（不具合の調査を頼まれたときなど）、セキュリティ上の理由で必要なとき、法令で求められたときだけです。</li>
        </List>

        <H2>6. 利用をやめるとき・情報を消すとき</H2>
        <List>
          <li><strong className="text-white">端末のデータ</strong>：本サービスでログアウトすると消えます。</li>
          <li><strong className="text-white">本サービスのアクセス権</strong>：Google アカウントの「<Ext href="https://myaccount.google.com/connections">サードパーティ製のアプリとサービス</Ext>」から Re:Mail のアクセスを取り消すと、本サービスは Gmail に一切アクセスできなくなります。サーバーに暗号化したトークンが残っていた場合も、そのトークンは使えなくなります。</li>
          <li><strong className="text-white">サーバーに残る設定・トークン</strong>：ログアウトしても、もう一度ログインしたときに元どおり使えるよう、設定は残ります。設定やトークンをすべて消したい場合は、下のお問い合わせ先にご連絡ください。確認のうえ削除します。</li>
        </List>

        <H2>7. 安全のための取り組み</H2>
        <List>
          <li>通信はすべて HTTPS で暗号化しています。</li>
          <li>サーバーに保存する情報は暗号化し、暗号化の鍵がない状態では何も保存しない作りにしています。</li>
          <li>求める権限は、本サービスの機能に必要なものだけにしています。</li>
        </List>

        <H2>8. このポリシーの変更</H2>
        <p>内容を変えるときは、このページを更新し、制定日の下に改定日を書きます。情報の扱いを大きく変えるとき（新しい機能でデータの使い方が変わるときなど）は、変更の前にこのページでお知らせします。</p>

        <H2>9. お問い合わせ</H2>
        <p>Re:Mail 運営者（個人で開発・運営しています）<br />メール：{PRIVACY_CONTACT_EMAIL}</p>
      </div>
    </main>
  );
}
