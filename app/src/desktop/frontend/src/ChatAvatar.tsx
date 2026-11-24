import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { call } from "./rpc";
import { chatDisplayName } from "./chatDisplay";
import type { ChatRow, OnlineChat, OnlineChats } from "./types";

export type LocalChatAvatar = { peer: string; name: string; avatar?: string; onlineAvatar?: string; color?: string; fontFamily?: string; fontSize?: number; fontColor?: string; fontWeight?: number };

export const AVATAR_COLOR_PRESETS = [
  { name: "海盐蓝", value: "#2F6BFF" },
  { name: "天空蓝", value: "#3B9EFF" },
  { name: "冰川青", value: "#28B8C7" },
  { name: "薄荷绿", value: "#2EAD7A" },
  { name: "森林绿", value: "#247A55" },
  { name: "青柠", value: "#78A83E" },
  { name: "暖阳黄", value: "#E0A52B" },
  { name: "琥珀橙", value: "#D9822B" },
  { name: "珊瑚橘", value: "#ED6A4D" },
  { name: "玫瑰红", value: "#DF4D68" },
  { name: "樱花粉", value: "#E779A5" },
  { name: "莓果紫", value: "#A653C7" },
  { name: "鸢尾紫", value: "#7657D6" },
  { name: "深海蓝", value: "#3454A4" },
  { name: "午夜靛", value: "#414B78" },
  { name: "石墨灰", value: "#657084" },
  { name: "暖沙棕", value: "#A77752" },
  { name: "陶土红", value: "#B85C4A" },
  { name: "橄榄绿", value: "#728044" },
  { name: "孔雀蓝", value: "#167C80" },
  { name: "电光紫", value: "#8B5CF6" },
  { name: "桃粉", value: "#F08C78" },
  { name: "柠檬黄", value: "#C9B52E" },
  { name: "松石绿", value: "#0F9D8A" },
] as const;

function hueFromHex(hex: string) {
  const value = Number.parseInt(hex.slice(1), 16);
  const red = (value >> 16) / 255;
  const green = ((value >> 8) & 255) / 255;
  const blue = (value & 255) / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  if (delta === 0) return 0;
  let hue = max === red ? (green - blue) / delta : max === green ? (blue - red) / delta + 2 : (red - green) / delta + 4;
  hue *= 60;
  return Math.round((hue + 360) % 360);
}

function onlineGradient(hue: number) {
  return `linear-gradient(135deg, hsl(${hue} 54% 52%), hsl(${(hue + 38) % 360} 58% 38%))`;
}

export function avatarBackground(peer: string, color?: string) {
  if (color) return onlineGradient(hueFromHex(color));
  const seed = Array.from(peer).reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) % 360, 7);
  return onlineGradient(seed);
}

export function ChatAvatar({ name, peer, avatar, color, fontFamily, fontSize, fontColor, fontWeight, className = "" }: { name: string; peer: string; avatar?: string; color?: string; fontFamily?: string; fontSize?: number; fontColor?: string; fontWeight?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [avatar]);
  const style = {
    background: avatarBackground(peer, color),
    "--avatar-font-family": fontFamily ? `"${fontFamily}"` : undefined,
    "--avatar-font-scale": fontSize ? fontSize / 24 : undefined,
    "--avatar-font-color": fontColor || undefined,
    "--avatar-font-weight": fontWeight || undefined,
  } as CSSProperties;
  const customized = Boolean(fontFamily || fontSize || fontColor || fontWeight);
  const avatarClassName = `online-avatar ${customized ? "customized" : ""} ${className}`.trim();
  return avatar && !failed
    ? <img className={avatarClassName} src={avatar} alt="" loading="lazy" style={style} onError={() => setFailed(true)} />
    : customized
      ? <span className={avatarClassName} style={style}><span className="avatar-initial">{Array.from(name.trim())[0] || "?"}</span></span>
      : <span className={avatarClassName} style={style}>{Array.from(name.trim())[0] || "?"}</span>;
}

export function useLocalChatAvatars(chats: ChatRow[], libraryKey: string, enabled: boolean) {
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
    void (async () => {
      try {
        const cached = await call<OnlineChats | null>("onlineChatsCached", undefined, controller.signal);
        if (controller.signal.aborted || currentGeneration !== generation.current) return;
        if (cached?.chats?.length) setSnapshot(cached.chats);
      } catch { /* keep cached avatars */ }
    })();
    return () => controller.abort();
  }, [libraryKey, enabled]);

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
    for (const chat of chats) {
      const matched = matches[chat.slug];
      const onlineAvatar = downloaded[matched?.peer || ""] || matched?.avatar;
      const customAvatar = chat.avatarFile
        ? `/api/chat-avatar?k=${encodeURIComponent(libraryKey)}&slug=${encodeURIComponent(chat.slug)}&f=${encodeURIComponent(chat.avatarFile)}`
        : "";
      result[chat.slug] = {
        peer: matched?.peer || `local:${chat.id || chat.slug}`,
        name: matched?.name || chatDisplayName(chat),
        avatar: customAvatar || (chat.avatarColor ? undefined : onlineAvatar),
        onlineAvatar,
        color: chat.avatarColor,
        fontFamily: chat.avatarFont,
        fontSize: chat.avatarSize,
        fontColor: chat.avatarInk,
        fontWeight: chat.avatarWeight,
      };
    }
    return result;
  }, [chats, libraryKey, matches, downloaded]);
  return { avatars, downloaded, applyOnlineSnapshot };
}
