// catch した値（Error とは限らない）から、ログやレスポンスに載せるメッセージ文字列を取り出す
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
