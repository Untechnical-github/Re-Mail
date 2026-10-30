// roomKeyの組み立て・分解を一元化する。表示名やメールアドレスに絶対出現しない制御文字を
// 区切り文字に使うことで、「相手の表示名にたまたま区切り文字と同じ並びの文字列が含まれる」
// ような衝突を構造的に防ぐ。
//
// ルール: 以後、roomKey の直接パース（区切り文字での split 等）をこのファイル以外に
// 書かない。必ず encodeRoomKey / decodeRoomKey を経由すること。
//
// 型レベルの安全策: LocalKey（アカウント内だけで通用する生の識別子。相手の表示名・
// group:xxxx・GmailメッセージIDなど）と RoomKeyStr（encodeRoomKey済みの複合文字列）を
// 別のbranded typeにしている。「room名をGmail検索クエリにそのまま埋め込む関数にroomKeyStr
// を渡してしまう」「複合キーであるべき場所に生のlocalKeyを渡してしまう」といった取り違えを、
// 実行時ではなくtscのコンパイル時に検出できるようにするため
declare const localKeyBrand: unique symbol;
declare const roomKeyBrand: unique symbol;
export type LocalKey = string & { readonly [localKeyBrand]: true };
export type RoomKeyStr = string & { readonly [roomKeyBrand]: true };

// 新規にlocalKeyを作る場所（メール差出人名の抽出、group:xxxxの生成など）で使う、
// 「このstringは意図的にLocalKeyとして扱う」という宣言
export function asLocalKey(s: string): LocalKey {
  return s as LocalKey;
}

const SEP = "\u0000";
// ローカルキーの中で「自分のアドレス」と「相手」を分ける区切り。主アドレス（アカウントのアドレス）のチャットには付けない
// （主アドレスのチャットは今までと同じローカルキーのままなので、ピン留めなどの設定がそのまま残る）。
// 主アドレス以外の自分のアドレス（sendAs・受信専用アドレス）のチャットは「自分のアドレス + OWN_SEP + 相手」をローカルキーにする。
// ローカルキーは D1 の chat_id にそのまま入る（HMAC・暗号化されるので区切りの制御文字が入っていてもよい）
const OWN_SEP = "\u0001";

function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

// 相手（partnerKey）と自分のアドレスから、アカウント内のローカルキーを作る。自分のアドレスが空・主アドレスなら相手だけ
export function localKeyFor(partnerKey: string, ownAddress: string | undefined, accountEmail: string): LocalKey {
  if (partnerKey.includes(OWN_SEP)) return partnerKey as LocalKey;
  const own = (ownAddress || "").trim().toLowerCase();
  if (!own || sameAddress(own, accountEmail)) return partnerKey as LocalKey;
  return `${own}${OWN_SEP}${partnerKey}` as LocalKey;
}

// ローカルキーを、自分のアドレス（小文字。主アドレスならアカウントのアドレス）と相手（partnerKey）に分ける
export function splitLocalKey(localKey: string, accountEmail: string): { ownAddress: string; partnerKey: LocalKey } {
  const idx = localKey.indexOf(OWN_SEP);
  if (idx === -1) return { ownAddress: accountEmail.trim().toLowerCase(), partnerKey: localKey as LocalKey };
  return { ownAddress: localKey.slice(0, idx), partnerKey: localKey.slice(idx + 1) as LocalKey };
}

// roomKey は「アカウント + 自分のアドレス + 相手」。ownAddress を渡したときは、ローカルキーに自分のアドレスを入れる
// （localKey に既に自分のアドレスが入っているとき・ownAddress が主アドレスのときはそのまま）
export function encodeRoomKey(accountEmail: string, localKey: LocalKey | string, ownAddress?: string): RoomKeyStr {
  if (localKey.includes(SEP)) throw new Error("localKey must not contain the separator");
  return `${accountEmail}${SEP}${localKeyFor(localKey, ownAddress, accountEmail)}` as RoomKeyStr;
}

// localKey は D1 の chat_id に入るアカウント内のキー（自分のアドレスを含む）。partnerKey は相手（表示名・アドレス・group:xxxx など）。
// 相手の名前で検索する・画面に出すときは partnerKey を使う
export function decodeRoomKey(roomKey: RoomKeyStr | string): { accountEmail: string; localKey: LocalKey; ownAddress: string; partnerKey: LocalKey } {
  const idx = roomKey.indexOf(SEP);
  if (idx === -1) throw new Error(`Invalid room key (missing account prefix): ${roomKey}`);
  const accountEmail = roomKey.slice(0, idx);
  const localKey = roomKey.slice(idx + 1) as LocalKey;
  return { accountEmail, localKey, ...splitLocalKey(localKey, accountEmail) };
}

// Object.keys() はTypeScript標準ライブラリの制限で常に string[] を返してしまう
// （branded typeのキーを保ったまま返せない）ため、その情報を型として復元するためのヘルパー
export function keysOf<K extends string>(o: Record<K, unknown>): K[] {
  return Object.keys(o) as K[];
}
