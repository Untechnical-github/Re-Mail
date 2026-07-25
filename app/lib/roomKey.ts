// roomKeyの組み立て・分解を一元化する。表示名やメールアドレスに絶対出現しない制御文字を
// 区切り文字に使うことで、「相手の表示名にたまたま区切り文字と同じ並びの文字列が含まれる」
// ような衝突を構造的に防ぐ。
//
// ルール: 以後、roomKey の直接パース（区切り文字での split 等）をこのファイル以外に
// 書かない。必ず encodeRoomKey / decodeRoomKey を経由すること。
const SEP = "\u0000";

export type RoomKey = { accountEmail: string; localKey: string };

export function encodeRoomKey(accountEmail: string, localKey: string): string {
  if (localKey.includes(SEP)) throw new Error("localKey must not contain the separator");
  return `${accountEmail}${SEP}${localKey}`;
}

export function decodeRoomKey(roomKey: string): RoomKey {
  const idx = roomKey.indexOf(SEP);
  if (idx === -1) throw new Error(`Invalid room key (missing account prefix): ${roomKey}`);
  return { accountEmail: roomKey.slice(0, idx), localKey: roomKey.slice(idx + 1) };
}
