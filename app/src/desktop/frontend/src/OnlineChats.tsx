import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  AlertCircle,
  ArrowUpRight,
  CheckCircle2,
  CloudDownload,
  FolderOpen,
  Hash,
  Inbox,
  Loader2,
  Megaphone,
  MessageSquare,
  Pin,
  RefreshCw,
  Search,
  UserRound,
  Users,
} from "lucide-react";
import { call } from "./rpc";
import { dateTime } from "./format";
import { Select } from "./Select";
import type { PageCtx } from "./pages";
import type { OnlineChat, OnlineChats, OnlineExportResult } from "./types";

const TYPE_META: Record<string, { label: string; tone: string }> = {
  private: { label: "私聊", tone: "private" },
  bot: { label: "机器人", tone: "bot" },
  group: { label: "群组", tone: "group" },
  channel: { label: "频道", tone: "channel" },
};

function typeMeta(type: string) {
  return TYPE_META[type] ?? { label: type || "会话", tone: "other" };
}

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

function shortWhen(seconds?: number): string {
  if (!seconds) return "";
  const d = new Date(seconds * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
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

const FILTERS = [
  { key: "all", label: "全部" },
  { key: "private", label: "私聊" },
  { key: "group", label: "群组" },
  { key: "channel", label: "频道" },
  { key: "archived", label: "归档夹" },
] as const;

export function OnlineChatsPage({ ctx }: { ctx: PageCtx }) {
  const [data, setData] = useState<OnlineChats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("recent");
  const [selectedPeer, setSelectedPeer] = useState("");
  const [exporting, setExporting] = useState("");
  const request = useRef(0);

  const load = async (announce = false) => {
    const seq = ++request.current;
    setLoading(true);
    setError("");
    try {
      const res = await call<OnlineChats>("onlineChats", { timeout: 35 });
      if (seq !== request.current) return;
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
    const boot = async () => {
      try {
        const cached = await call<OnlineChats | null>("onlineChatsCached");
        if (!cancelled && cached?.chats?.length) {
          setData(cached);
          setLoading(false);
        }
      } catch {
        // A missing cache is normal on the first visit.
      }
      if (!cancelled) void load();
    };
    void boot();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const avatarSeed = data?.fetchedAt;
  useEffect(() => {
    if (!data || !ctx.boot?.hasSession) return;
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
  }, [avatarSeed]);

  const chats = data?.chats ?? [];

  const counts = useMemo(
    () => ({
      all: chats.length,
      private: chats.filter((c) => c.type === "private" || c.type === "bot").length,
      group: chats.filter((c) => c.type === "group").length,
      channel: chats.filter((c) => c.type === "channel").length,
      archived: chats.filter((c) => c.archived).length,
    }),
    [chats]
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = chats.filter((c) => {
      if (filter === "archived" && !c.archived) return false;
      if (filter === "private" && c.type !== "private" && c.type !== "bot") return false;
      if (filter === "group" && c.type !== "group") return false;
      if (filter === "channel" && c.type !== "channel") return false;
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        (c.username || "").toLowerCase().includes(q) ||
        String(c.id).includes(q) ||
        (c.lastMessage || "").toLowerCase().includes(q)
      );
    });
    if (sort === "name") {
      return [...list].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    }
    return list;
  }, [chats, filter, query, sort]);

  useEffect(() => {
    if (visible.length === 0) {
      setSelectedPeer("");
      return;
    }
    if (!visible.some((c) => c.peer === selectedPeer)) setSelectedPeer(visible[0].peer);
  }, [visible, selectedPeer]);

  const selected = visible.find((c) => c.peer === selectedPeer) || chats.find((c) => c.peer === selectedPeer) || null;

  const runExport = async (chat: OnlineChat) => {
    if (exporting) return;
    setExporting(chat.peer);
    ctx.toast(`正在读取「${chat.name}」的消息…`);
    try {
      const res = await call<OnlineExportResult>("onlineExport", { peer: chat.peer, timeout: 300 });
      if (res.upToDate) {
        ctx.toast("已是最新，没有需要归档的新消息");
        return;
      }
      ctx.toast(`已加入任务中心：${res.chat} · ${res.messages.toLocaleString()} 条消息`);
      ctx.go("tasks");
    } catch (e) {
      ctx.toast((e as Error).message, true);
    } finally {
      setExporting("");
    }
  };

  const summary = [
    { label: "全部会话", value: counts.all, icon: Inbox },
    { label: "私聊", value: counts.private, icon: UserRound },
    { label: "群组", value: counts.group, icon: Users },
    { label: "频道", value: counts.channel, icon: Megaphone },
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
        {summary.map((s) => {
          const Icon = s.icon;
          return (
            <div key={s.label} className="online-summary-cell">
              <span className="online-summary-icon"><Icon size={14} /></span>
              <div><b>{loading && !data ? "—" : s.value}</b><span>{s.label}</span></div>
            </div>
          );
        })}
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
              {FILTERS.map((f) => (
                <button key={f.key} className={filter === f.key ? "on" : ""} onClick={() => setFilter(f.key)}>
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
            <span className="online-result-count">{visible.length} 个会话</span>
          </div>

          <div className="online-layout">
            <div className="online-list" role="listbox" aria-label="在线聊天列表">
              {loading && !data ? (
                Array.from({ length: 9 }).map((_, i) => (
                  <div key={i} className="online-row skeleton">
                    <span className="online-avatar skeleton-block" />
                    <span className="online-row-main"><i className="skeleton-line w-160" /><i className="skeleton-line w-220" /></span>
                  </div>
                ))
              ) : visible.length === 0 ? (
                <div className="online-list-empty">
                  <Search size={22} />
                  <b>没有匹配的会话</b>
                  <span>换一个关键词或筛选条件。</span>
                </div>
              ) : (
                visible.map((c) => {
                  const meta = typeMeta(c.type);
                  const on = c.peer === selectedPeer;
                  return (
                    <button
                      key={c.peer}
                      role="option"
                      aria-selected={on}
                      className={`online-row ${on ? "on" : ""}`}
                      onClick={() => setSelectedPeer(c.peer)}
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
                        <span className="online-time">{shortWhen(c.lastDate)}</span>
                        {!!c.unread && <span className="online-unread">{c.unread > 99 ? "99+" : c.unread}</span>}
                        {c.archivedLocally && <CheckCircle2 size={12} className="online-local-check" />}
                      </span>
                    </button>
                  );
                })
              )}
              {loading && data && <div className="online-loading-more"><Loader2 size={14} className="spin" /> 正在刷新…</div>}
            </div>

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
                        <span className={`online-type ${typeMeta(selected.type).tone}`}>{typeMeta(selected.type).label}</span>
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

                  <dl className="online-facts">
                    <div><dt>类型</dt><dd>{typeMeta(selected.type).label}</dd></div>
                    <div><dt>会话 ID</dt><dd className="mono">{selected.id}</dd></div>
                    <div><dt>未读</dt><dd title={selected.unread ? `${selected.unread} 条未读` : "已读"}>{selected.unread ? (selected.unread > 99 ? "99+" : selected.unread) : 0}</dd></div>
                    <div><dt>置顶</dt><dd>{selected.pinned ? "是" : "否"}</dd></div>
                  </dl>

                  <div className="online-detail-actions">
                    <button
                      className="btn primary"
                      disabled={!!exporting}
                      onClick={() => void runExport(selected)}
                    >
                      {exporting === selected.peer ? <Loader2 size={13} className="spin" /> : <CloudDownload size={13} />}
                      {exporting === selected.peer ? "正在读取消息…" : selected.archivedLocally ? "更新归档" : "归档到当前库"}
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
    </>
  );
}
