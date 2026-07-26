-- schema.sql
-- 注意: このファイルは今後、フェーズが進むたびに追記していく前提。
-- 過去に一度適用済みのテーブルを毎回 DROP+CREATE すると、その後に溜まった実データを
-- 再適用のたびに消してしまうため、既存テーブルは CREATE TABLE IF NOT EXISTS で
-- 「無ければ作る」形にし、以後は基本的に非破壊で運用する
-- （chat_configs は複数アカウント対応のため一度だけ意図的にDROP+CREATEで作り直し済み）

CREATE TABLE IF NOT EXISTS chat_configs (
  user_email TEXT NOT NULL,      -- Re:Mailにログインしている本人
  account_email TEXT NOT NULL,   -- どの連携アカウントのチャットか（メインアカウント自身も含む）。
                                  -- __GLOBAL_SETTINGS__ / __KNOWN_BOXES__ のようなユーザー単位の
                                  -- 特殊行は、特定アカウントに紐づかないため空文字 "" を予約する
  chat_id TEXT NOT NULL,         -- アカウント内でのローカルなキー（相手名 or group:xxxx）
  custom_name TEXT,              -- 変更したチャット名
  is_pinned INTEGER DEFAULT 0,   -- ピン留め (0: false, 1: true)
  is_hidden INTEGER DEFAULT 0,   -- 非表示 (0: false, 1: true)
  hidden_at_date TEXT,           -- 非表示にした日時（ISO文字列）
  unhide_on_new INTEGER DEFAULT 0, -- 新着時に非表示解除するか (0: false, 1: true)
  PRIMARY KEY (user_email, account_email, chat_id)
);

-- フェーズ2: 複数アカウント連携。メインアカウント自身はここには含めない
-- （メインアカウントのトークンはNextAuthのJWT/セッション側で管理する）
CREATE TABLE IF NOT EXISTS linked_accounts (
  user_email TEXT NOT NULL,      -- Re:Mailにログインしている本人（＝メインアカウント）
  account_email TEXT NOT NULL,   -- 追加で連携したGoogleアカウントのアドレス
  refresh_token TEXT NOT NULL,
  access_token TEXT,
  expires_at INTEGER,            -- access_token の有効期限（ミリ秒epoch）
  created_at TEXT,
  needs_reauth INTEGER DEFAULT 0, -- リフレッシュトークンが失効し再連携が必要か (0: false, 1: true)
  name TEXT,                     -- 表示用（設定のアイコン表示切替でアバター横に出す名前）。認証には使わない
  picture TEXT,                  -- 表示用のGoogleアカウントのプロフィール画像URL。認証には使わない
  PRIMARY KEY (user_email, account_email)
);

-- 既存DBに対する追記マイグレーション。CREATE TABLE IF NOT EXISTSは既存テーブルに
-- 新しい列を追加してくれないため、既に linked_accounts が存在する環境ではこちらを
-- 1回だけ手動実行する（列が既に存在する場合はエラーになるので、その場合は無視して良い）
-- ALTER TABLE linked_accounts ADD COLUMN needs_reauth INTEGER DEFAULT 0;
-- ALTER TABLE linked_accounts ADD COLUMN name TEXT;
-- ALTER TABLE linked_accounts ADD COLUMN picture TEXT;
