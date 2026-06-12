-- schema.sql
DROP TABLE IF EXISTS chat_configs;

CREATE TABLE chat_configs (
  user_email TEXT NOT NULL,      -- 誰の設定か（ログインしている自分のアドレス）
  chat_id TEXT NOT NULL,         -- どのチャットか（相手のアドレスやグループ名）
  custom_name TEXT,              -- 変更したチャット名
  is_pinned INTEGER DEFAULT 0,   -- ピン留め (0: false, 1: true)
  is_hidden INTEGER DEFAULT 0,   -- 非表示 (0: false, 1: true)
  hidden_at_date TEXT,           -- 非表示にした日時（ISO文字列）
  unhide_on_new INTEGER DEFAULT 0, -- 新着時に非表示解除するか (0: false, 1: true)
  PRIMARY KEY (user_email, chat_id)
);