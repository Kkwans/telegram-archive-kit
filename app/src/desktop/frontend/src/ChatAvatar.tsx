import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { call } from "./rpc";
import type { ChatRow, OnlineChat, OnlineChats } from "./types";

export type LocalChatAvatar = { peer: string; name: string; avatar?: string };

export function ChatAvatar({ name, peer, avatar, className = "" }: { name: string; peer: string; avatar?: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [avatar]);
  const seed = Array.from(peer).reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) % 360, 7);
  const style: CSSProperties = { background: `linear-gradient(135deg, hsl(${seed} 54% 52%), hsl(${(seed + 38) % 360} 58% 38%))` };
  return avatar && !failed
    ? <img className={`online-avatar ${className}`} src={avatar} alt="" loading="lazy" style={style} onError={() => setFailed(true)} />
    : <span className={`online-avatar ${className}`} style={style}>{Array.from(name.trim())[0] || "?"}</span>;
}

export function useLocalChatAvatars(chats: ChatRow[], libraryKey: string, enabled: boolean, live = false) {
  const [snapshot, setSnapshot] = useState<OnlineChat[]>([]);
  const [downloaded, setDownloaded] = useState<Record<string, string>>({});
  const downloadedRef = useRef(downloaded);
  downloadedRef.current = downloaded;
  const attempted = useRef(new Set<string>());
  const generation = useRef(0);
  const loadedKey = useRef("");
  const applyOnlineSnapshot = useCallback((online: OnlineChat[]) => {
    generation.current++;
    attempted.current.clear();
    setSnapshot(online);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const currentGeneration = ++generation.current;
    const identity = `${libraryKey}|${enabled}`;
    if (loadedKey.current !== identity) {
      loadedKey.current = identity;
      attempted.current.clear();
      setSnapshot([]);
      setDownloaded({});
    }
    if (!enabled || !libraryKey) return () => controller.abort();
    if (live) attempted.current.clear();
    void (async () => {
      try {
        const cached = await call<OnlineChats | null>("onlineChatsCached", undefined, controller.signal);
        if (controller.signal.aborted || currentGeneration !== generation.current) return;
        if (cached?.chats?.length) setSnapshot(cached.chats);
        if (!live) return;
        const fresh = await call<OnlineChats>("onlineChats", { timeout: 20 }, controller.signal);
        if (!controller.signal.aborted && currentGeneration === generation.current && fresh.chats?.length) {
          setSnapshot(fresh.chats);
        }
      } catch { /* keep cached avatars */ }
    })();
    return () => controller.abort();
  }, [libraryKey, enabled, live]);

  const matches = useMemo(() => {
    const result: Record<string, OnlineChat> = {};
    const byID = new Map<string, OnlineChat[]>();
    const bySlug = new Map<string, OnlineChat[]>();
    for (const online of snapshot) {
      const id = String(online.id);
      byID.set(id, [...(byID.get(id) ?? []), online]);
      if (online.localSlug) bySlug.set(online.localSlug, [...(bySlug.get(online.localSlug) ?? []), online]);
    }
    for (const chat of chats) {
      const candidates = chat.id ? (byID.get(String(chat.id)) ?? []) : (bySlug.get(chat.slug) ?? []);
      if (candidates.length === 1) result[chat.slug] = candidates[0];
    }
    return result;
  }, [chats, snapshot]);

  useEffect(() => {
    const controller = new AbortController();
    const peers = [...new Set(Object.values(matches).filter((chat) => chat.hasPhoto && !chat.avatar && !downloadedRef.current[chat.peer] && !attempted.current.has(chat.peer)).map((chat) => chat.peer))];
    void (async () => {
      for (let offset = 0; offset < peers.length && !controller.signal.aborted; offset += 16) {
        const batch = peers.slice(offset, offset + 16);
        batch.forEach((peer) => attempted.current.add(peer));
        try {
          const found = await call<Record<string, string>>("onlineAvatars", { peers: batch, timeout: 30 }, controller.signal);
          if (controller.signal.aborted) { batch.forEach((peer) => attempted.current.delete(peer)); break; }
          if (!Object.keys(found).length) break;
          setDownloaded((current) => ({ ...current, ...found }));
        } catch { if (controller.signal.aborted) batch.forEach((peer) => attempted.current.delete(peer)); break; }
      }
    })();
    return () => controller.abort();
  }, [matches]);

  const avatars = useMemo(() => {
    const result: Record<string, LocalChatAvatar> = {};
    for (const [slug, chat] of Object.entries(matches)) result[slug] = { peer: chat.peer, name: chat.name, avatar: downloaded[chat.peer] || chat.avatar };
    return result;
  }, [matches, downloaded]);
  return { avatars, downloaded, applyOnlineSnapshot };
}
