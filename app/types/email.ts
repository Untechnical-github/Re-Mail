// 添付ファイルのメタデータ。送信直後にローカルで作ったメールには attachmentId が無い
// （中身はアタッチメントキャッシュに先回りで書き込んである）
export type EmailAttachment = {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId?: string;
};

// Gmail APIのメッセージ（生データ）と、送信直後にローカルで作る表示用オブジェクトの両方が
// 流れ込む、アプリ全体で扱う「メール」の形（/api/emails の parseMessageDetail の戻り値に合わせる）
export type Email = {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  // 返信の宛先（全員に返信・Reply-To）を純正 Gmail と同じに決めるために持つ。送信直後の仮オブジェクトには無いことがある
  cc?: string;
  // 自分が送ったメールにだけ入る（Gmail は受信者側のメールから Bcc を取り除く）
  bcc?: string;
  replyTo?: string;
  date: string;
  // Gmail が受け取った時刻（ミリ秒）。引用・転送の見出しの時刻にだけ使う。
  // 並び順・差分同期・一覧の時刻には使わない。端末のキャッシュにある古いメールには無い
  internalDate?: number;
  // 一番上の Received ヘッダーの日付（ミリ秒）。引用・転送の見出しの時刻にだけ使う（純正 Gmail と同じ）。同じく古いキャッシュには無い
  receivedAt?: number;
  body: string;
  snippet: string;
  labelIds: string[];
  // 送信直後にローカルで作った表示用オブジェクトにのみ付与される（生データには無い）。
  // isMineEmail() は From ヘッダーによるフォールバックも併用する
  isMe?: boolean;
  // グループチャット等で、このメッセージがどのルームに属するか明示的に指定する場合に使う
  senderRoom?: string;
  attachments?: EmailAttachment[];
  // HTML本文から抜き出したリンク（テキスト版本文ではリンク先が失われるため）
  htmlLinks?: { text: string; href: string }[];
  hasHtml?: boolean;
  // 返信元メッセージのローカルID（表示用のチップ紐付けに使う）
  replyToId?: string;
  // 送信メールに引用として付与する、返信元メッセージの Message-ID ヘッダー値
  inReplyTo?: string;
  // このメッセージ自体の Message-ID ヘッダー値（他メッセージから返信元として参照される）
  messageIdHeader?: string;
  // このメッセージの References ヘッダー値（返信するときに、純正 Gmail と同じくこれを引き継ぐ）
  references?: string;
  isForward?: boolean;
  // フェーズ3以降、どの連携アカウントで受信/送信したメールかを表す。フェーズ2までは未設定
  accountId?: string;
  // ピン留めしていたメールが Gmail 側で削除されて取得できなかったときの表示用（app/lib/pinnedIds.ts）
  isMissing?: boolean;
};
