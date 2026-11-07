import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  CheckCircle2,
  CloudDownload,
  FileText,
  FolderOpen,
  HardDrive,
  Hash,
  Image as ImageIcon,
  Loader2,
  MessageSquare,
  Music2,
  Pin,
  RefreshCw,
  Search,
  UserRound,
  Video,
} from "lucide-react";
import { call } from "./rpc";
import { bytes, dateTime } from "./format";
import { Select } from "./Select";
import { ConfirmDialog } from "./ConfirmDialog";
import type { PageCtx } from "./pages";
import type { OnlineChat, OnlineChats, OnlineExportPreview, OnlineExportProgress, OnlineExportResult } from "./types";

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
  { key: "local", label: "本地已有" },
] as const;

export function OnlineChatsPage({ ctx }: { ctx: PageCtx }) {
  const [data, setData] = useState<OnlineChats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("all");
  const [folderId, setFolderId] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("recent");
  const [selectedPeer, setSelectedPeer] = useState("");
  const [exporting, setExporting] = useState("");
  const [previewPeer, setPreviewPeer] = useState<OnlineChat | null>(null);
  const [preview, setPreview] = useState<OnlineExportPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [previewProgress, setPreviewProgress] = useState<OnlineExportProgress | null>(null);
  const [closeConfirm, setCloseConfirm] = useState(false);
  const [floodUntil, setFloodUntil] = useState(0);
  const [clock, setClock] = useState(Date.now());
  const request = useRef(0);
  const previewSeq = useRef(0);

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

  useEffect(() => {
    if (!floodUntil) return;
    const tick = () => {
      const now = Date.now();
      setClock(now);
      if (now >= floodUntil) setFloodUntil(0);
    };
    const timer = window.setInterval(tick, 500);
    return () => window.clearInterval(timer);
  }, [floodUntil]);

  const chats = data?.chats ?? [];

  const counts = useMemo(
    () => ({
      all: chats.length,
      private: chats.filter((c) => c.type === "private" || c.type === "bot").length,
      group: chats.filter((c) => c.type === "group").length,
      channel: chats.filter((c) => c.type === "channel").length,
      archived: chats.filter((c) => c.archived).length,
      local: chats.filter((c) => c.archivedLocally).length,
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
    setFilter(ctx.onlineRequest.filter as (typeof FILTERS)[number]["key"]);
  }, [ctx.onlineRequest?.seq]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = chats.filter((c) => {
      if (activeFolder) {
        if (!folderPeers.has(c.peer)) return false;
      } else {
        if (filter === "archived" && !c.archived) return false;
        if (filter === "private" && c.type !== "private" && c.type !== "bot") return false;
        if (filter === "group" && c.type !== "group") return false;
        if (filter === "channel" && c.type !== "channel") return false;
        if (filter === "local" && !c.archivedLocally) return false;
      }
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
  }, [activeFolder, chats, filter, folderPeers, query, sort]);

  useEffect(() => {
    if (visible.length === 0) {
      setSelectedPeer("");
      return;
    }
    if (!visible.some((c) => c.peer === selectedPeer)) setSelectedPeer(visible[0].peer);
  }, [visible, selectedPeer]);

  const selected = visible.find((c) => c.peer === selectedPeer) || chats.find((c) => c.peer === selectedPeer) || null;
  const floodLeft = Math.max(0, Math.ceil((floodUntil - clock) / 1000));

  const noteExportError = (message: string, report?: (text: string) => void) => {
    const match = message.match(/等待\s*(\d+)\s*秒/) || message.match(/FLOOD_WAIT[^0-9]*(\d+)/i);
    if (match) {
      const seconds = Math.max(1, Number(match[1]));
      setFloodUntil(Date.now() + seconds * 1000);
      setClock(Date.now());
      const text = `Telegram 限流，请等待 ${seconds} 秒后再试`;
      report?.(text);
      ctx.toast(text, true);
      return;
    }
    report?.(message);
    ctx.toast(message, true);
  };

  const closePreview = () => {
    if (exporting) return;
    if (previewLoading) void call("onlineExportPreviewCancel").catch(() => undefined);
    previewSeq.current++;
    const token = preview?.token;
    setPreviewPeer(null);
    setPreview(null);
    setPreviewError("");
    setPreviewProgress(null);
    setPreviewLoading(false);
    setCloseConfirm(false);
    if (token) void call("onlineExportDiscard", { token }).catch(() => undefined);
  };

  const requestClosePreview = () => {
    if (exporting) return;
    if (previewLoading) {
      setCloseConfirm(true);
      return;
    }
    closePreview();
  };

  useEffect(() => {
    if (!previewLoading) {
      setPreviewProgress(null);
      return;
    }
    let alive = true;
    const poll = () => {
      call<OnlineExportProgress>("onlineExportPreviewProgress")
        .then((progress) => { if (alive) setPreviewProgress(progress); })
        .catch(() => undefined);
    };
    poll();
    const timer = window.setInterval(poll, 400);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [previewLoading]);

  const beginPreview = async (chat: OnlineChat) => {
    if (previewLoading || exporting || floodLeft > 0) return;
    const seq = ++previewSeq.current;
    setPreviewPeer(chat);
    setPreview(null);
    setPreviewError("");
    setPreviewProgress({ active: true, stage: "准备统计", detail: "正在连接 Telegram", percent: 1, messages: 0, media: 0 });
    setPreviewLoading(true);
    try {
      const res = await call<OnlineExportPreview>("onlineExportPreview", { peer: chat.peer, timeout: 300 });
      if (seq !== previewSeq.current) {
        if (res.token) void call("onlineExportDiscard", { token: res.token }).catch(() => undefined);
        return;
      }
      if (res.upToDate) {
        setPreviewPeer(null);
        ctx.toast("已是最新，没有需要归档的新消息");
        return;
      }
      setPreview(res);
    } catch (e) {
      if (seq !== previewSeq.current) return;
      noteExportError((e as Error).message, setPreviewError);
    } finally {
      if (seq === previewSeq.current) setPreviewLoading(false);
    }
  };

  const runExport = async () => {
    if (!preview || exporting) return;
    setExporting(preview.peer);
    setPreviewError("");
    try {
      const res = await call<OnlineExportResult>("onlineExport", { peer: preview.peer, timeout: 300, token: preview.token || "" });
      if (res.upToDate) {
        closePreview();
        ctx.toast("已是最新，没有需要归档的新消息");
        return;
      }
      closePreview();
      ctx.toast(`已加入任务中心：${res.chat} · ${res.messages.toLocaleString()} 条消息`);
      ctx.go("tasks");
    } catch (e) {
      noteExportError((e as Error).message, setPreviewError);
    } finally {
      setExporting("");
    }
  };

  const canExport = !!data?.chats.length;
  const summary = [
    { label: "全部会话", value: counts.all },
    { label: "私聊", value: counts.private },
    { label: "群组", value: counts.group },
    { label: "频道", value: counts.channel },
  ];
  const previewStats = preview ? [
    { key: "images", label: "图片", value: preview.images, icon: <ImageIcon size={14} /> },
    { key: "videos", label: "视频", value: preview.videos, icon: <Video size={14} /> },
    { key: "audio", label: "音频", value: preview.audio, icon: <Music2 size={14} /> },
    { key: "files", label: "文件", value: preview.files, icon: <FileText size={14} /> },
  ] : [];

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
              {FILTERS.map((f) => (
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

                  <div className="online-detail-actions">
                    <button
                      className="btn primary"
                      disabled={previewLoading || !!exporting || !canExport || floodLeft > 0}
                      onClick={() => void beginPreview(selected)}
                    >
                      {previewLoading || floodLeft > 0 ? <Loader2 size={13} className={previewLoading ? "spin" : ""} /> : <CloudDownload size={13} />}
                      {previewLoading ? "正在统计…" : floodLeft > 0 ? `等待 ${floodLeft} 秒` : selected.archivedLocally ? "更新归档" : "归档到当前库"}
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

      {previewPeer && createPortal(
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(e) => { if (e.target === e.currentTarget) requestClosePreview(); }}
        >
          <div className="modal export-preview-modal" role="dialog" aria-modal="true" aria-labelledby="export-preview-title">
            <div className="export-preview-head">
              {previewPeer.avatar ? (
                <img className="online-avatar" src={previewPeer.avatar} alt="" />
              ) : (
                <span className="online-avatar" style={avatarStyle(previewPeer)}>{initials(previewPeer.name)}</span>
              )}
              <div className="export-preview-head-text">
                <span className="export-preview-kicker">归档预览</span>
                <h2 id="export-preview-title">{previewPeer.name}</h2>
                <p className="modal-sub">{typeMeta(previewPeer.type).label} · ID {previewPeer.id}</p>
              </div>
            </div>

            {previewLoading ? (
              <div className="export-preview-loading export-preview-progress">
                <div className="export-loading-head">
                  <span className="export-loading-spinner"><Loader2 size={18} className="spin" /></span>
                  <div className="export-loading-copy">
                    <b>{previewProgress?.stage || "正在读取消息并统计媒体…"}</b>
                    <span>{previewProgress?.detail || "首次统计会读取完整历史；遇到 Telegram 限流会自动等待后继续。"}</span>
                  </div>
                  <strong className="export-loading-percent">{Math.round(previewProgress?.percent ?? 0)}<em>%</em></strong>
                </div>
                <div className="export-loading-track">
                  <i style={{ width: `${Math.max(2, Math.min(100, previewProgress?.percent ?? 0))}%` }} />
                </div>
                <div className="export-loading-meta">
                  <span>已读取 <b>{(previewProgress?.messages ?? 0).toLocaleString()}</b> 条消息</span>
                  <span>发现 <b>{(previewProgress?.media ?? 0).toLocaleString()}</b> 个媒体</span>
                </div>
              </div>
            ) : preview ? (
              <>
                <div className="export-preview-lead">
                  <div>
                    <span>本次新增</span>
                    <b>{preview.messages.toLocaleString()} <em>条消息</em></b>
                  </div>
                  <div>
                    <span>预计大小</span>
                    <b>{preview.bytes > 0 ? bytes(preview.bytes) : "—"}</b>
                  </div>
                </div>

                <div className="export-preview-media">
                  {previewStats.map((stat) => (
                    <div key={stat.key} className="export-preview-item">
                      <span className="export-preview-item-icon">{stat.icon}</span>
                      <span>{stat.label}</span>
                      <b>{stat.value.toLocaleString()}</b>
                    </div>
                  ))}
                </div>

                {preview.existed && (
                  <div className="export-preview-existing">
                    <RefreshCw size={13} />
                    <span>
                      本地已有 {(preview.localMessages ?? 0).toLocaleString()} 条消息 · {(preview.localMedia ?? 0).toLocaleString()} 个媒体，本次只合并新消息。
                    </span>
                  </div>
                )}

                {preview.other > 0 && (
                  <p className="export-preview-note">另有 {preview.other.toLocaleString()} 个其他媒体（位置、投票、联系人等）。</p>
                )}
                <p className="export-preview-note">
                  <HardDrive size={12} /> 大小按 Telegram 返回的文件尺寸估算，仅统计本次新增消息；实际下载可能因缩略图与格式略有差异。
                  {preview.service > 0 ? ` 包含 ${preview.service.toLocaleString()} 条服务消息。` : ""}
                </p>
              </>
            ) : null}

            {previewError && (
              <div className="online-banner export-preview-error" role="status">
                <AlertCircle size={15} />
                <span>{previewError}</span>
              </div>
            )}

            <div className="modal-actions">
              <button className="btn ghost" disabled={!!exporting} onClick={requestClosePreview}>
                {preview ? "取消" : "关闭"}
              </button>
              {preview ? (
                <button className="btn primary" disabled={!!exporting || floodLeft > 0} onClick={() => void runExport()}>
                  {exporting ? <Loader2 size={13} className="spin" /> : <CloudDownload size={13} />}
                  {exporting ? "正在归档…" : floodLeft > 0 ? `等待 ${floodLeft} 秒` : "开始归档"}
                </button>
              ) : !previewLoading ? (
                <button className="btn primary" disabled={floodLeft > 0} onClick={() => void beginPreview(previewPeer)}>
                  {floodLeft > 0 ? <Loader2 size={13} /> : <RefreshCw size={13} />}
                  {floodLeft > 0 ? `等待 ${floodLeft} 秒` : "重新统计"}
                </button>
              ) : null}
            </div>
          </div>
        </div>,
        document.body
      )}

      <ConfirmDialog
        open={closeConfirm}
        title="停止统计并关闭？"
        message="媒体统计仍在读取完整历史。现在关闭会中断统计，下次需要重新开始并重新等待。"
        confirmLabel="关闭预览"
        cancelLabel="继续等待"
        danger
        onConfirm={() => { setCloseConfirm(false); closePreview(); }}
        onCancel={() => setCloseConfirm(false)}
      />
    </>
  );
}
