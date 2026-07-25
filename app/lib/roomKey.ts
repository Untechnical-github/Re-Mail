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

export function encodeRoomKey(accountEmail: string, localKey: LocalKey | string): RoomKeyStr {
  if (localKey.includes(SEP)) throw new Error("localKey must not contain the separator");
  return `${accountEmail}${SEP}${localKey}` as RoomKeyStr;
}

export function decodeRoomKey(roomKey: RoomKeyStr | string): { accountEmail: string; localKey: LocalKey } {
  const idx = roomKey.indexOf(SEP);
  if (idx === -1) throw new Error(`Invalid room key (missing account prefix): ${roomKey}`);
  return { accountEmail: roomKey.slice(0, idx), localKey: roomKey.slice(idx + 1) as LocalKey };
}

// Object.keys() はTypeScript標準ライブラリの制限で常に string[] を返してしまう
// （branded typeのキーを保ったまま返せない）ため、その情報を型として復元するためのヘルパー
export function keysOf<K extends string>(o: Record<K, unknown>): K[] {
  return Object.keys(o) as K[];
}
