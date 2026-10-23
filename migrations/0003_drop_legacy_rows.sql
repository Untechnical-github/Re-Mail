-- 0003_drop_legacy_rows.sql
-- 保存の形の移行（アドレスの置き換え・設定の置き場所）を終えるため、古い形式のデータを消す（2026-10-23）。
-- このあとのコードは今の形式だけを読む。1つ前のコード（段階2）も今の形式だけの D1 で動くので、ロールバックしても壊れない。
--
-- chat_configs はすべて消す。暗号化した中身の中に古い形式（ピン留めの本体・平文の roomId・アカウントを決めていない
-- フィルター・共通設定の alwaysLoadImages など）が残っていても SQL では見分けられないため、全部消して残っていないと言い切る。
-- 利用者は開発者本人だけで、設定が消えてよいことは本人が決めた。
DELETE FROM chat_configs;

-- linked_accounts は、今の形式でない行だけを消す（今の形式の行は残すので、再ログインしなくて済む）。
-- 今の形式：user_email・account_email が「a1:」で始まり、account_enc・refresh_token が「encv1:」で始まり、
-- access_token・name・picture は NULL か「encv1:」で始まる。
-- LIKE は大文字小文字を区別しないので、substr で先頭を正確に比べる
DELETE FROM linked_accounts
WHERE substr(user_email, 1, 3) <> 'a1:'
   OR substr(account_email, 1, 3) <> 'a1:'
   OR account_enc IS NULL
   OR substr(account_enc, 1, 6) <> 'encv1:'
   OR substr(refresh_token, 1, 6) <> 'encv1:'
   OR (access_token IS NOT NULL AND substr(access_token, 1, 6) <> 'encv1:')
   OR (name IS NOT NULL AND substr(name, 1, 6) <> 'encv1:')
   OR (picture IS NOT NULL AND substr(picture, 1, 6) <> 'encv1:');
