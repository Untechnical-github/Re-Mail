// 自分のアドレス（user_email・account_email）を D1 のキーから外す移行の段階。設定（chat_configs）と
// 連携アカウント（linked_accounts）で同じ値を使う。
//   false（段階1）: アドレスを置き換えた行も読める。保存はアドレスを平文のまま
//   true（段階2）: アドレスを置き換えて保存し、古い形の行は読んだときに置き換える
// 段階1のコードは段階2の行も読めるので、段階2から1つ前に戻しても壊れない
export const WRITE_HASHED_ADDRESS = true;
