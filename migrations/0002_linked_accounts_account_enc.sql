-- 0002_linked_accounts_account_enc.sql
-- 連携アカウントのアドレス（account_email）を D1 のキーから外すための列。
-- キーには「a1:」＋HMAC を入れ、画面に出すための元のアドレスは暗号化してこの列に持つ（app/lib/linkedAccountsStore.ts）。
-- 列を足すだけなので、この列を知らない古いコードもそのまま動く
ALTER TABLE linked_accounts ADD COLUMN account_enc TEXT;
