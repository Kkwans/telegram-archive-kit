import type { OnlineChat } from "./types";

export const ONLINE_CHAT_FILTERS = [
  { key: "all", label: "全部" },
  { key: "private", label: "私聊" },
  { key: "group", label: "群组" },
  { key: "channel", label: "频道" },
  { key: "archived", label: "归档夹" },
  { key: "local", label: "本地已有" },
] as const;

export type OnlineChatFilter = (typeof ONLINE_CHAT_FILTERS)[number]["key"];

const TYPE_META: Record<string, { label: string; tone: string }> = {
  private: { label: "私聊", tone: "private" },
  bot: { label: "机器人", tone: "bot" },
  group: { label: "群组", tone: "group" },
  channel: { label: "频道", tone: "channel" },
};

export function onlineChatTypeMeta(type: string) {
  return TYPE_META[type] ?? { label: type || "会话", tone: "other" };
}

export function matchesOnlineChatFilter(chat: Pick<OnlineChat, "type" | "archived" | "archivedLocally">, filter: OnlineChatFilter): boolean {
  switch (filter) {
    case "all": return true;
    case "private": return chat.type === "private" || chat.type === "bot";
    case "archived": return !!chat.archived;
    case "local": return !!chat.archivedLocally;
    default: return chat.type === filter;
  }
}

type SearchableChat = Pick<OnlineChat, "peer" | "name" | "username" | "lastMessage"> & { id?: number };

export function matchesOnlineChatSearch(chat: SearchableChat, query: string): boolean {
  if (!query) return true;
  const usernameQuery = query.startsWith("@") ? query.slice(1) : query;
  return chat.name.toLowerCase().includes(query) ||
    (!!usernameQuery && (chat.username || "").toLowerCase().includes(usernameQuery)) ||
    chat.peer.toLowerCase().includes(query) ||
    (chat.id !== undefined && String(chat.id).includes(query)) ||
    (chat.lastMessage || "").toLowerCase().includes(query);
}
