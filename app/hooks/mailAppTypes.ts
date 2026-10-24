// useMailApp.ts から分けたフックどうしで使う型（動きは持たない）
import type { Dispatch, SetStateAction } from "react";
import type { Email } from "../types/email";
import type { useConfigs } from "./useConfigs";

export type SetState<T> = Dispatch<SetStateAction<T>>;
// 設定の読み込み・保存（useConfigs.ts）が返す関数
export type ConfigsApi = ReturnType<typeof useConfigs>;
// メールの詳細のモーダル
export type EmailModalState = {
  email: Email;
  htmlBody: string | null;
  isLoading: boolean;
} | null;
// 添付のプレビューのモーダル
export type AttachmentModalState = {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId?: string;
  messageId: string;
  cacheKey?: string;
  base64: string | null;
  isLoading: boolean;
} | null;
