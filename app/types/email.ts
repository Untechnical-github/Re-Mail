// Gmail APIのメッセージ（生データ）と、送信直後にローカルで作る表示用オブジェクトの両方が
// 流れ込む、アプリ全体で扱う「メール」の形。バックエンドのレスポンス形状にかなり近いため、
// 未使用の付随データ（添付ファイルの詳細など）は any のまま残す
export type Email = {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  body: string;
  snippet: string;
  labelIds: string[];
  // 送信直後にローカルで作った表示用オブジェクトにのみ付与される（生データには無い）。
  // isMineEmail() は From ヘッダーによるフォールバックも併用する
  isMe?: boolean;
  // グループチャット等で、このメッセージがどのルームに属するか明示的に指定する場合に使う
  senderRoom?: string;
  attachments?: any[];
  hasHtml?: boolean;
  // 返信元メッセージのローカルID（表示用のチップ紐付けに使う）
  replyToId?: string;
  // 送信メールに引用として付与する、返信元メッセージの Message-ID ヘッダー値
  inReplyTo?: string;
  // このメッセージ自体の Message-ID ヘッダー値（他メッセージから返信元として参照される）
  messageIdHeader?: string;
  isForward?: boolean;
  // フェーズ3以降、どの連携アカウントで受信/送信したメールかを表す。フェーズ2までは未設定
  accountId?: string;
};
