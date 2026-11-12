import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  AlertCircle,
  CheckCircle2,
  CloudDownload,
  FolderOpen,
  Hash,
  Loader2,
  MessageSquare,
  Pin,
  RefreshCw,
  Search,
  UserRound,
} from "lucide-react";
import { call } from "./rpc";
import { bytes, dateTime } from "./format";
import { Select } from "./Select";
import { OnlineUpdateDialog, onlineTargetFromChat, type OnlineUpdateTarget } from "./OnlineUpdateDialog";
import type { PageCtx } from "./pages";
import type { OnlineChat, OnlineChats } from "./types";
import { matchesOnlineChatFilter, matchesOnlineChatSearch, ONLINE_CHAT_FILTERS, onlineChatTypeMeta, type OnlineChatFilter } from "./onlineChatFilters";

function initials(name: string): string {
  const chars = Array.from(name.trim());
  return chars[0] || "?";
}

function avatarStyle(chat: OnlineChat): CSSProperties {
  const seed = Array.from(chat.peer).reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) % 360, 7);
  return {
    background: `linear-gradient(135deg, hsl(${seed} 54% 52%), hsl(${(seed + 38) % 360} 58% 38%))`,
  };
}

function shortWhen(seconds: number | undefined, today: string): string {
  if (!seconds) return "";
  const d = new Date(seconds * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === today;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (sameDay) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "昨天";
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function fullWhen(seconds?: number): string {
  if (!seconds) return "--";
  const d = new Date(seconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const OnlineChatRow = memo(function OnlineChatRow({
  chat: c,
  selected,
  today,
  onSelect,
}: {
  chat: OnlineChat;
  selected: boolean;
  today: string;
  onSelect: (peer: string) => void;
}) {
  const meta = onlineChatTypeMeta(c.type);
  return (
    <button
      role="option"
      aria-selected={selected}
      className={`online-row ${selected ? "on" : ""}`}
      onClick={() => onSelect(c.peer)}
    >
      {c.avatar ? (
        <img className="online-avatar" src={c.avatar} alt="" loading="lazy" />
      ) : (
        <span className="online-avatar" style={avatarStyle(c)}>{initials(c.name)}</span>
      )}
      <span className="online-row-main">
        <span className="online-row-top">
          <b>{c.name}</b>
          {c.pinned && <Pin size={11} className="online-pin" />}
          <span className={`online-type ${meta.tone}`}>{meta.label}</span>
          {c.archived && <span className="online-type archived">归档夹</span>}
        </span>
        <span className="online-row-sub">
          {c.username && <span className="online-username">@{c.username}</span>}
          <span className="online-preview-text">{c.lastMessage || "暂无消息"}</span>
        </span>
      </span>
      <span className="online-row-side">
        <span className="online-time">{shortWhen(c.lastDate, today)}</span>
        {!!c.unread && <span className="online-unread">{c.unread > 99 ? "99+" : c.unread}</span>}
        {c.archivedLocally && <CheckCircle2 size={12} className="online-local-check" />}
      </span>
    </button>
  );
});

const OnlineChatList = memo(function OnlineChatList({
  chats,
  selectedPeer,
  loading,
  hasData,
  today,
  onSelect,
}: {
  chats: OnlineChat[];
  selectedPeer: string;
  loading: boolean;
  hasData: boolean;
  today: string;
  onSelect: (peer: string) => void;
}) {
  return (
    <div className="online-list" role="listbox" aria-label="在线聊天列表">
      {loading && !hasData ? (
        Array.from({ length: 9 }).map((_, i) => (
          <div key={i} className="online-row skeleton">
            <span className="online-avatar skeleton-block" />
            <span className="online-row-main"><i className="skeleton-line w-160" /><i className="skeleton-line w-220" /></span>
          </div>
        ))
      ) : chats.length === 0 ? (
        <div className="online-list-empty">
          <Search size={22} />
          <b>没有匹配的会话</b>
          <span>换一个关键词或筛选条件。</span>
        </div>
      ) : (
        chats.map((chat) => (
          <OnlineChatRow
            key={chat.peer}
            chat={chat}
            selected={chat.peer === selectedPeer}
            today={today}
            onSelect={onSelect}
          />
        ))
      )}
      {loading && hasData && <div className="online-loading-more"><Loader2 size={14} className="spin" /> 正在刷新…</div>}
    </div>
  );
});

export function OnlineChatsPage({ ctx }: { ctx: PageCtx }) {
  const [data, setData] = useState<OnlineChats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<OnlineChatFilter>("all");
  const [folderId, setFolderId] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("recent");
  const [selectedPeer, setSelectedPeer] = useState("");
  const [previewTarget, setPreviewTarget] = useState<OnlineUpdateTarget | null>(null);
  const request = useRef(0);

  const load = async (announce = false, useCache = false) => {
    const seq = ++request.current;
    let liveApplied = false;
    setLoading(true);
    setError("");
    if (useCache) {
      // Show the snapshot as soon as it arrives, without delaying the live request.
      void call<OnlineChats | null>("onlineChatsCached")
        .then((cached) => {
          if (seq !== request.current || liveApplied || !cached?.chats?.length) return;
          setData(cached);
        })
        .catch(() => undefined);
    }
    try {
      const res = await call<OnlineChats>("onlineChats", { timeout: 35 });
      if (seq !== request.current) return;
      liveApplied = true;
      setData(res);
      if (res.error) setError(res.error);
      if (announce) ctx.toast(`已刷新 ${res.chats.length} 个在线会话`);
    } catch (e) {
      if (seq !== request.current) return;
      setError((e as Error).message);
    } finally {
      if (seq === request.current) setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    // Deferring one microtask also avoids duplicating the request in StrictMode's
    // development-only mount/cleanup cycle.
    void Promise.resolve().then(() => { if (!cancelled) void load(false, true); });
    return () => {
      cancelled = true;
      request.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const avatarSeed = data?.fetchedAt;
  useEffect(() => {
    // Avatar downloads and live dialog retrieval share a backend lock. Waiting
    // until the refresh settles prevents cached avatars from delaying it.
    if (!data || loading || !ctx.boot?.hasSession) return;
    const peers = data.chats.slice(0, 16).filter((c) => c.hasPhoto && !c.avatar).map((c) => c.peer);
    if (peers.length === 0) return;
    let cancelled = false;
    void call<Record<string, string>>("onlineAvatars", { peers, timeout: 30 })
      .then((avatars) => {
        if (cancelled || Object.keys(avatars).length === 0) return;
        setData((prev) => prev ? {
          ...prev,
          chats: prev.chats.map((c) => avatars[c.peer] ? { ...c, avatar: avatars[c.peer] } : c),
        } : prev);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avatarSeed, loading, ctx.boot?.hasSession]);

  const chats = data?.chats ?? [];

  const counts = useMemo(
    () => ({
      all: chats.length,
      private: chats.filter((c) => matchesOnlineChatFilter(c, "private")).length,
      group: chats.filter((c) => matchesOnlineChatFilter(c, "group")).length,
      channel: chats.filter((c) => matchesOnlineChatFilter(c, "channel")).length,
      archived: chats.filter((c) => matchesOnlineChatFilter(c, "archived")).length,
      local: chats.filter((c) => matchesOnlineChatFilter(c, "local")).length,
    }),
    [chats]
  );

  const folders = data?.folders ?? [];
  const activeFolder = folderId == null ? null : folders.find((f) => f.id === folderId) ?? null;
  const folderPeers = useMemo(() => new Set(activeFolder?.peers ?? []), [activeFolder]);

  useEffect(() => {
    if (folderId != null && data && !folders.some((f) => f.id === folderId)) setFolderId(null);
  }, [data, folders, folderId]);

  useEffect(() => {
    if (!ctx.onlineRequest) return;
    setFolderId(null);
    setFilter(ONLINE_CHAT_FILTERS.find(({ key }) => key === ctx.onlineRequest?.filter)?.key ?? "all");
  }, [ctx.onlineRequest?.seq]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = chats.filter((c) =>
      (activeFolder ? folderPeers.has(c.peer) : matchesOnlineChatFilter(c, filter)) && matchesOnlineChatSearch(c, q)
    );
    if (sort === "name") {
      return [...list].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    }
    return list;
  }, [activeFolder, chats, filter, folderPeers, query, sort]);

  useEffect(() => {
    if (visible.length === 0) {
      setSelectedPeer("");
      return;
    }
    if (!visible.some((c) => c.peer === selectedPeer)) setSelectedPeer(visible[0].peer);
  }, [visible, selectedPeer]);

  const selected = visible.find((c) => c.peer === selectedPeer) || chats.find((c) => c.peer === selectedPeer) || null;
  const canExport = !!data?.chats.length;
  const today = new Date().toDateString();
  const summary = [
    { label: "全部会话", value: counts.all },
    { label: "私聊", value: counts.private },
    { label: "群组", value: counts.group },
    { label: "频道", value: counts.channel },
  ];

  return (
    <>
      <div className="page-head online-head">
        <div>
          <h1>在线聊天</h1>
          <p>直接读取 Telegram 会话；归档后即可离线浏览、搜索与查看媒体</p>
        </div>
        <div className="actions">
          <span className={`online-conn ${ctx.boot?.hasSession ? "ok" : "warn"}`}>
            <i />
            {ctx.boot?.hasSession ? "Telegram 会话可用" : "尚未登录"}
          </span>
          <button className="btn ghost" disabled={loading} onClick={() => void load(true)}>
            <RefreshCw size={13} className={loading ? "spin" : ""} /> {loading ? "读取中…" : "刷新列表"}
          </button>
        </div>
      </div>

      <section className="online-summary" aria-label="在线会话概况">
        {summary.map((s) => (
          <div key={s.label} className="online-summary-cell">
            <span>{s.label}</span>
            <b>{loading && !data ? "—" : s.value}</b>
          </div>
        ))}
        <div className="online-summary-foot">
          {data?.fetchedAt ? (
            <><span>更新于 {fullWhen(Math.floor(data.fetchedAt / 1000))}</span>{data.source === "cache" && <em>缓存快照</em>}</>
          ) : <span>首次读取会获取完整会话列表</span>}
        </div>
      </section>

      {error && (
        <div className="online-banner" role="status">
          <AlertCircle size={15} />
          <span>{error}</span>
          <button className="btn sm ghost" onClick={() => void load()}>重试</button>
        </div>
      )}

      {!ctx.boot?.hasSession ? (
        <section className="panel online-empty">
          <UserRound size={30} />
          <h2>还没有可用的 Telegram 会话</h2>
          <p>在线聊天会复用账号页的本机会话，只读读取对话列表；不会修改 tdl 的登录状态。</p>
          <button className="btn primary" onClick={() => ctx.go("account")}>前往账号管理</button>
        </section>
      ) : (
        <section className="panel online-shell">
          <div className="online-toolbar">
            <label className="online-search">
              <Search size={14} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索名称、@username 或 ID…"
                aria-label="搜索在线聊天"
              />
              {query && <button className="online-search-clear" onClick={() => setQuery("")} aria-label="清除搜索">×</button>}
            </label>
            <div className="tabs-pill online-tabs" role="group" aria-label="在线聊天筛选">
              {ONLINE_CHAT_FILTERS.map((f) => (
                <button
                  key={f.key}
                  className={!activeFolder && filter === f.key ? "on" : ""}
                  onClick={() => {
                    setFolderId(null);
                    setFilter(f.key);
                  }}
                >
                  {f.label}
                  <span className="online-tab-count">{counts[f.key]}</span>
                </button>
              ))}
            </div>
            <div className="online-sort">
              <Select
                ariaLabel="在线聊天排序"
                value={sort}
                onChange={setSort}
                options={[
                  { value: "recent", label: "最近活动" },
                  { value: "name", label: "按名称" },
                ]}
              />
            </div>
            <span className="online-result-count">
              {activeFolder ? `${activeFolder.title} · ${visible.length} 个会话` : `${visible.length} 个会话`}
            </span>

            {folders.length > 0 && (
              <div className="online-folders" role="group" aria-label="我的 Telegram 分组">
                <span className="online-folders-label">我的分组</span>
                <div className="online-folders-scroll">
                  {folders.map((folder) => (
                    <button
                      key={folder.id}
                      className={`online-folder ${activeFolder?.id === folder.id ? "on" : ""}`}
                      onClick={() => {
                        setFilter("all");
                        setFolderId(activeFolder?.id === folder.id ? null : folder.id);
                      }}
                    >
                      {folder.emoticon && <span className="online-folder-emoji">{folder.emoticon}</span>}
                      <span>{folder.title}</span>
                      <span className="online-tab-count">{folder.peers.length}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="online-layout">
            <OnlineChatList
              chats={visible}
              selectedPeer={selectedPeer}
              loading={loading}
              hasData={!!data}
              today={today}
              onSelect={setSelectedPeer}
            />

            <aside className="online-detail" aria-label="在线聊天详情">
              {!selected ? (
                <div className="online-detail-empty">
                  <MessageSquare size={28} />
                  <b>选择一个会话</b>
                  <span>右侧会显示身份、最后消息与本地归档状态。</span>
                </div>
              ) : (
                <>
                  <div className="online-detail-head">
                    {selected.avatar ? (
                      <img className="online-avatar xl" src={selected.avatar} alt="" />
                    ) : (
                      <span className="online-avatar xl" style={avatarStyle(selected)}>{initials(selected.name)}</span>
                    )}
                    <div>
                      <h2>{selected.name}</h2>
                      <p>
                        <span className={`online-type ${onlineChatTypeMeta(selected.type).tone}`}>{onlineChatTypeMeta(selected.type).label}</span>
                        <span className="online-detail-id">ID {selected.id}</span>
                      </p>
                      {selected.username && <p className="online-detail-username">@{selected.username}</p>}
                    </div>
                  </div>

                  <div className={`online-archive-state ${selected.archivedLocally ? "ok" : ""}`}>
                    {selected.archivedLocally ? (
                      <>
                        <span className="online-archive-icon"><CheckCircle2 size={16} /></span>
                        <div>
                          <b>已归档到本地</b>
                          <span>{selected.localMessages?.toLocaleString()} 条消息 · {selected.localMedia?.toLocaleString()} 个媒体</span>
                        </div>
                        <em>{selected.localUpdatedAt ? dateTime(selected.localUpdatedAt) : "可增量更新"}</em>
                      </>
                    ) : (
                      <>
                        <span className="online-archive-icon muted"><CloudDownload size={16} /></span>
                        <div>
                          <b>尚未归档</b>
                          <span>归档后可离线浏览消息与媒体</span>
                        </div>
                      </>
                    )}
                  </div>

                  <div className="online-last-card">
                    <div className="online-last-head">
                      <span>最后消息</span>
                      <em>{fullWhen(selected.lastDate)}</em>
                    </div>
                    <p>{selected.lastMessage || "这个会话还没有可显示的消息。"}</p>
                  </div>

                  <div className="online-detail-actions">
                    <button
                      className="btn primary"
                      disabled={!canExport}
                      onClick={() => {
                        if (!selected) return;
                        setPreviewTarget(onlineTargetFromChat(selected));
                      }}
                    >
                      <CloudDownload size={13} />
                      {selected.archivedLocally ? "更新归档" : "归档到当前库"}
                    </button>
                    {selected.archivedLocally ? (
                      <button
                        className="btn ghost"
                        onClick={() => {
                          if (selected.localSlug) {
                            ctx.setSelected(selected.localSlug);
                            ctx.go("chats");
                          }
                        }}
                      >
                        <FolderOpen size={13} /> 打开本地归档
                      </button>
                    ) : selected.username ? (
                      <button
                        className="btn ghost"
                        onClick={() => navigator.clipboard?.writeText(`@${selected.username}`).then(() => ctx.toast("用户名已复制")).catch(() => ctx.toast("复制失败", true))}
                      >
                        <Hash size={13} /> 复制用户名
                      </button>
                    ) : null}
                  </div>
                  <p className="online-detail-note">
                    首次归档会读取完整历史并复用下载内核补齐媒体；再次归档按消息 ID 合并。在线列表不会标记已读或改动账号。
                  </p>
                </>
              )}
            </aside>
          </div>
        </section>
      )}

      {previewTarget && (
        <OnlineUpdateDialog
          target={previewTarget}
          onClose={() => setPreviewTarget(null)}
          onStarted={(taskId) => ctx.openTask(taskId)}
          toast={ctx.toast}
        />
      )}
    </>
  );
}
