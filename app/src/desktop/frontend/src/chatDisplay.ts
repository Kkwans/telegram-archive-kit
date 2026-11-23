import type { ChatRow } from "./types";

export function chatDisplayName(chat: Pick<ChatRow, "name" | "displayName">): string {
  return chat.displayName?.trim() || chat.name;
}
