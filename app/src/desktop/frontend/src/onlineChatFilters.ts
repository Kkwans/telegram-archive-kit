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

export function onlineChatOwnership(chat: Pick<OnlineChat, "type" | "isOwner">): "owned" | "other" | "unknown" {
  if (chat.type !== "group" && chat.type !== "channel") return "other";
  if (chat.isOwner === true) return "owned";
  if (chat.isOwner === false) return "other";
  return "unknown";
}

export function ownershipCountLabel(known: number, unknown: number): string {
  if (unknown === 0) return String(known);
  return known === 0 ? "—" : `≥${known}`;
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

export function chatPlanOwners(plans: Array<{ name: string; targets: Array<{ peer: string }> }>): Record<string, string[]> {
  const owners: Record<string, string[]> = {};
  for (const plan of plans) {
    const name = plan.name.trim();
    if (!name) continue;
    const seen = new Set<string>();
    for (const target of plan.targets) {
      if (!target.peer || seen.has(target.peer)) continue;
      seen.add(target.peer);
      (owners[target.peer] ??= []).push(name);
    }
  }
  for (const [peer, names] of Object.entries(owners)) {
    const seen = new Set<string>();
    owners[peer] = names.filter((name) => {
      if (seen.has(name)) return false;
      seen.add(name);
      return true;
    });
  }
  return owners;
}

export function filterOnlineChats(chats: OnlineChat[], options: {
  filter: OnlineChatFilter;
  folderPeers: ReadonlySet<string> | null;
  onlyOwned: boolean;
  query: string;
}): { chats: OnlineChat[]; unknownOwnership: number } {
  const result: OnlineChat[] = [];
  const query = options.query.trim().toLowerCase();
  let unknownOwnership = 0;
  for (const chat of chats) {
    if (options.folderPeers ? !options.folderPeers.has(chat.peer) : !matchesOnlineChatFilter(chat, options.filter)) continue;
    if (!matchesOnlineChatSearch(chat, query)) continue;
    if (options.onlyOwned) {
      const state = onlineChatOwnership(chat);
      if (state === "unknown") unknownOwnership++;
      if (state !== "owned") continue;
    }
    result.push(chat);
  }
  return { chats: result, unknownOwnership };
}
