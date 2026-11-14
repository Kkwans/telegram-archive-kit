import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  AtSign,
  Bookmark,
  ChartPie,
  CloudDownload,
  Fingerprint,
  LogOut,
  Phone,
  CheckCircle2,
  Clock,
  Database,
  Download,
  FolderOpen,
  HardDrive,
  Image as ImageIcon,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  Eye,
  FolderPlus,
  GitMerge,
  Info,
  Keyboard,
  Minimize2,
  RotateCcw,
  Save,
  Search,
  Send,
  SlidersHorizontal,
  Film,
  FileText,
  Images,
  KeyRound,
  ListTodo,
  Loader2,
  LocateFixed,
  Maximize2,
  MessagesSquare,
  Music,
  Network,
  Server,
  Cloud,
  AlertTriangle,
  Pause,
  Play,
  Sparkles,
  QrCode,
  RefreshCw,
  ShieldCheck,
  Square,
  Trash2,
  UserRound,
  Video,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import Artplayer from "artplayer";
import { call } from "./rpc";
import { Select } from "./Select";
import { ConfirmDialog } from "./ConfirmDialog";
import { RemoteConnections, type SavedRemoteConnection } from "./RemoteConnections";
import { OnlineUpdateDialog, onlineTargetFromChat, type OnlineUpdateTarget } from "./OnlineUpdateDialog";
import type {
  AccountInfo,
  AccountProfile,
  Bootstrap,
  ChatRow,
  DoneState,
  DownloadState,
  LoginState,
  MediaItem,
  MediaPage,
  MediaSummary,
  OperationState,
  RemoteStatus,
  RemoteTools,
  SessionCheck,
  TdlInfo,
  TaskInfo,
  ToastAction,
  ToastKind,
  ViewerPrefs,
} from "./types";
import { bytes, dateTime, duration, rate, rateParts } from "./format";
import { cropViewerImage, loadBackdropImage, viewerBackdrop } from "./viewerBackdrop";

export interface PageCtx {
  boot: Bootstrap | null;
  chats: ChatRow[];
  chatsStatus: "loading" | "ready" | "error";
  selected: string;
  setSelected: (slug: string) => void;
  dl: DownloadState | null;
  op: OperationState | null;
  done: DoneState | null;
  login: LoginState | null;
  running: boolean;
  history: { now: number; avg: number }[];
  refresh: () => void;
  toast: (msg: string, kind?: boolean | ToastKind, action?: ToastAction) => void;
  go: (page: string) => void;
  openOnline: (filter?: string) => void;
  onlineRequest: { filter: string; seq: number } | null;
  pickFiles: (purpose: string) => Promise<string[]>;
  pickFolder: (purpose: string, title: string) => Promise<string>;
  tasks: TaskInfo[];
  openTasks: () => void;
  /** Opens the unified download detail for a concrete task id. */
  openTask: (taskId: string) => void;
  prefs: ViewerPrefs;
  applyPrefs: (p: ViewerPrefs) => void;
  setToastSeconds: (seconds: number) => void;
  applyMediaSummary?: (libraryKey: string, slug: string, summary: MediaSummary) => void;
}

const kindLabel = (kind: string): string =>
  kind === "image" ? "图片" : kind === "video" ? "视频" : kind === "audio" ? "音频" : "文件";

function wrapPath(value: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  value.split(/([\\/])/).forEach((part, i) => {
    nodes.push(part);
    if (part === "\\" || part === "/") nodes.push(<wbr key={i} />);
  });
  return nodes;
}

function polyPoints(values: number[]): string {
  if (values.length === 0) return "";
  const max = Math.max(...values, 1);
  const step = 600 / Math.max(1, values.length - 1);
  return values
    .map((v, i) => `${(i * step).toFixed(1)},${(70 - Math.min(1, v / max) * 62).toFixed(1)}`)
    .join(" ");
}

/* ============================== Home ============================== */
const MEDIA_KINDS = [
  { key: "images", label: "图片", color: "#2f6bff" },
  { key: "videos", label: "视频", color: "#7c5cff" },
  { key: "audio", label: "音频", color: "#12a26a" },
  { key: "files", label: "文件", color: "#c98a00" },
] as const;

export function Home({ ctx }: { ctx: PageCtx }) {
  const { boot, chats, chatsStatus, selected, setSelected, toast, go, tasks, openTasks, openTask, pickFiles } = ctx;
  const [storage, setStorage] = useState<{ key: string; status: "loading" | "ready" | "error"; diskFree: number; diskTotal: number } | null>(null);
  const [syncSlug, setSyncSlug] = useState(selected);
  const [updateTarget, setUpdateTarget] = useState<OnlineUpdateTarget | null>(null);
  useEffect(() => {
    if (!syncSlug && selected) setSyncSlug(selected);
  }, [selected]);

  useEffect(() => {
    const key = boot?.libraryKey;
    if (!key) return;
    const controller = new AbortController();
    setStorage({ key, status: "loading", diskFree: 0, diskTotal: 0 });
    call<{ diskFree: number; diskTotal: number }>("homeStorage", undefined, controller.signal)
      .then((next) => { if (!controller.signal.aborted) setStorage({ key, status: "ready", ...next }); })
      .catch(() => { if (!controller.signal.aborted) setStorage({ key, status: "error", diskFree: 0, diskTotal: 0 }); });
    return () => controller.abort();
  }, [boot?.libraryKey]);

  const totals = useMemo(() => chats.reduce((out, chat) => {
    out.messages += chat.messages;
    out.missing += chat.missing;
    out.pages += chat.pages;
    out.official += chat.official;
    if (!chat.mediaReady) {
      out.pendingMedia++;
      return out;
    }
    out.media += chat.media;
    out.images += chat.images ?? 0;
    out.videos += chat.videos ?? 0;
    out.audio += chat.audio ?? 0;
    out.files += chat.files ?? 0;
    out.mediaBytes += chat.totalBytes ?? 0;
    if (chat.media > 0) out.chatsWithMedia++;
    return out;
  }, { messages: 0, missing: 0, pages: 0, official: 0, media: 0, images: 0, videos: 0, audio: 0, files: 0, mediaBytes: 0, pendingMedia: 0, chatsWithMedia: 0 }), [chats]);
  const stats = chatsStatus === "ready" ? totals : null;
  const totalMedia = stats ? stats.images + stats.videos + stats.audio + stats.files : 0;
  const currentStorage = storage?.key === boot?.libraryKey ? storage : null;
  const diskKnown = currentStorage?.status === "ready" && currentStorage.diskTotal > 0;
  const diskUnavailable = currentStorage?.status === "error" || (currentStorage?.status === "ready" && !diskKnown);
  const diskUsed = diskKnown ? Math.min(100, Math.max(0, Math.round(((currentStorage.diskTotal - currentStorage.diskFree) * 100) / currentStorage.diskTotal))) : 0;
  const recentChats = useMemo(
    () => [...chats].sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "")).slice(0, 5),
    [chats]
  );
  const recentTasks = tasks.slice(0, 5);

  const startSync = () => {
    const slug = syncSlug || selected;
    if (!slug) {
      go("chats");
      return;
    }
    setSelected(slug);
    setUpdateTarget({
      peer: "local:" + slug,
      name: chats.find((c) => c.slug === slug)?.name ?? "聊天",
      slug,
      mode: "sync",
    });
  };
  const syncAllMissing = () => {
    const missing = chats.filter((c) => c.missing > 0);
    if (missing.length === 0) {
      toast("所有聊天都没有缺失媒体");
      return;
    }
    setUpdateTarget({ peer: "bulk:all", name: "全部缺失媒体", mode: "bulk" });
  };
  const importJSON = async () => {
    try {
      const paths = await pickFiles("import-json");
      if (!paths.length) return;
      const { taskId } = await call<{ taskId: string }>("startImportJSON", { paths });
      toast("导入任务已加入任务中心", "success", { label: "查看任务", run: () => openTask(taskId) });
      go("tasks");
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  return (
    <>
      <section className="home-hero">
        <div className="home-hero-main">
          <span className="home-eyebrow">
            <Sparkles size={12} /> TELEGRAM ARCHIVE KIT
          </span>
          <h1>你的离线档案库，一眼掌握</h1>
          <p className="home-lede">把 Telegram 的聊天、图片和视频整理成离线档案；下载、构建与检索都在这里完成。</p>
          <div className="home-cta">
            <button className="btn primary" onClick={importJSON}>
              <Download size={14} /> 导入 result.json
            </button>
            <button className="btn ghost" onClick={() => boot && call("openLibrary", {}).catch((e: Error) => toast(e.message, true))}>
              <FolderOpen size={14} /> 打开归档库
            </button>
            <button className="btn ghost" onClick={() => go("account")}>
              <UserRound size={14} /> 账号与登录
            </button>
          </div>
        </div>
        <section className="sync-card" aria-label="同步聊天">
          <header className="sync-head">
            <span className="sync-icon"><RefreshCw size={16} /></span>
            <div>
              <h2>同步与补齐</h2>
              <p>选择聊天，下载缺失媒体并重建网页</p>
            </div>
          </header>
          <div className="sync-field">
            <label htmlFor="sync-chat">聊天</label>
            <Select
              ariaLabel="选择要同步的聊天"
              value={syncSlug || chats[0]?.slug || ""}
              onChange={setSyncSlug}
              options={chats.map((c) => ({ value: c.slug, label: c.name }))}
            />
          </div>
          <div className="sync-actions">
            <button className="btn primary" onClick={startSync} disabled={chats.length === 0}>
              <Play size={13} /> 同步所选
            </button>
            <button className="btn" onClick={syncAllMissing} disabled={!chats.some((c) => c.missing > 0)}>
              <RefreshCw size={13} /> 同步全部缺失
            </button>
          </div>
        </section>
      </section>

      <section className="stat-grid">
        <div className="stat">
          <span>聊天</span>
          <div>{stats ? <><b>{chats.length}</b><em>个档案</em></> : chatsStatus === "error" ? <b>不可用</b> : <span className="skeleton-line w-60" />}</div>
        </div>
        <div className="stat">
          <span>消息</span>
          <div>{stats ? <><b>{stats.messages.toLocaleString()}</b><em>条</em></> : chatsStatus === "error" ? <b>不可用</b> : <span className="skeleton-line w-80" />}</div>
        </div>
        <div className="stat">
          <span>{stats?.pendingMedia ? "已核对媒体" : "本地媒体"}</span>
          <div>{stats ? <><b>{stats.media.toLocaleString()}</b><em>个{stats.pendingMedia ? ` · ${stats.pendingMedia} 个聊天待核对` : ""}</em></> : chatsStatus === "error" ? <b>不可用</b> : <span className="skeleton-line w-80" />}</div>
        </div>
        <div className="stat">
          <span>缺失媒体</span>
          <div>{stats ? <><b className={stats.missing > 0 ? "warn" : ""}>{stats.missing}</b><em>个</em></> : chatsStatus === "error" ? <b>不可用</b> : <span className="skeleton-line w-60" />}</div>
        </div>
      </section>

      <div className="home-grid home-grid-even">
        <section className="panel">
          <div className="panel-head">
            <h3><ChartPie size={14} /> 媒体构成</h3>
            <span className="meta">{!stats ? chatsStatus === "error" ? "统计暂不可用" : "正在读取…" : stats.pendingMedia ? `已核对 ${totalMedia.toLocaleString()} 个 · ${stats.pendingMedia} 个聊天待核对` : `共 ${totalMedia.toLocaleString()} 个`}</span>
          </div>
          <div className="media-composition">
            <div className="kind-list">
              {MEDIA_KINDS.map((k) => {
                const value = stats?.[k.key] ?? 0;
                const pct = totalMedia > 0 ? Math.round((value * 100) / totalMedia) : 0;
                return (
                  <div className="kind-row" key={k.key}>
                    <i style={{ background: k.color }} />
                    <span>{k.label}</span>
                    <div className="kind-bar"><b style={{ width: `${pct}%`, background: k.color }} /></div>
                    <strong>{stats ? value.toLocaleString() : "—"}</strong>
                    <em>{stats && totalMedia > 0 ? `${pct}%` : "—"}</em>
                  </div>
                );
              })}
            </div>
            <div className="media-facts">
              <span><b>{stats ? stats.chatsWithMedia : "—"}</b> 个已核对聊天有媒体</span>
              <span>已核对聊天平均 <b>{stats && chats.length > (stats.pendingMedia ?? 0) ? Math.round(stats.media / (chats.length - (stats.pendingMedia ?? 0))).toLocaleString() : "—"}</b> 个</span>
              <span>最大类型 <b>{stats && totalMedia ? MEDIA_KINDS.reduce((best, k) => (stats[k.key] > stats[best.key] ? k : best), MEDIA_KINDS[0]).label : "—"}</b></span>
            </div>
          </div>
        </section>

        <section className="panel storage-panel">
          <div className="panel-head">
            <h3><HardDrive size={14} /> 档案库存储</h3>
            <span className="meta" title={boot?.libraryRoot || "未配置"}>{boot?.libraryRoot || "未配置"}</span>
          </div>
          <div className="storage-body">
            <div>
              <div className="storage-bar"><b style={{ width: `${diskUsed}%` }} /></div>
              <div className="storage-labels">
                <span>磁盘已用 {diskKnown ? `${diskUsed}%` : diskUnavailable ? "不可用" : "读取中…"}</span>
                <span>剩余 {diskKnown ? bytes(currentStorage.diskFree) : "—"}</span>
              </div>
            </div>
            <div className="storage-facts">
              <div><span>{stats?.pendingMedia ? "已核对媒体体积" : "媒体体积"}</span><b>{stats ? bytes(stats.mediaBytes) : "—"}</b>{Boolean(stats?.pendingMedia) && <small>{stats?.pendingMedia} 个聊天待核对</small>}</div>
              <div><span>网页</span><b>{stats ? `${stats.pages} 页` : "—"}</b></div>
              <div><span>官方导出</span><b>{stats ? `${stats.official} 个` : "—"}</b></div>
            </div>
            <div className="storage-path">
              <div>
                <span>归档目录</span>
                <code title={boot?.libraryRoot}>{boot?.libraryRoot || "未配置"}</code>
              </div>
              <button className="btn sm ghost" onClick={() => boot && call("openPath", { path: boot.libraryRoot })} disabled={!boot?.libraryRoot}>
                <FolderOpen size={12} /> 打开
              </button>
            </div>
          </div>
        </section>
      </div>

      <div className="home-grid">
        <section className="panel">
          <div className="panel-head">
            <h3><Clock size={14} /> 最近聊天</h3>
            <button className="btn sm ghost" onClick={() => go("chats")}>
              查看全部 <ArrowRight size={11} />
            </button>
          </div>
          {recentChats.length === 0 ? (
            <div className="chart-empty">{chatsStatus === "loading" ? "正在读取聊天…" : chatsStatus === "error" ? "聊天列表暂不可用，请稍后重试。" : "还没有聊天，先到档案库导入 result.json。"}</div>
          ) : (
            <div className="recent-chats">
              {recentChats.map((c) => (
                <button key={c.slug} onClick={() => { setSelected(c.slug); go("chats"); }}>
                  <span className="avatar">{c.name.slice(0, 1)}</span>
                  <span className="rc-main">
                    <b>{c.name}</b>
                    <span>{c.messages.toLocaleString()} 条 · {c.media.toLocaleString()} 媒体{c.missing > 0 ? ` · 缺失 ${c.missing}` : ""}</span>
                  </span>
                  <span className="rc-time">{c.updatedAt?.slice(0, 10) || "--"}</span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3><Database size={14} /> 最近任务</h3>
            <button className="btn sm ghost" onClick={openTasks}>
              任务中心 <ArrowRight size={11} />
            </button>
          </div>
          {recentTasks.length === 0 ? (
            <div className="chart-empty">还没有后台任务。导入、导出、下载与重建会显示在这里。</div>
          ) : (
            <div className="home-tasks">
              {recentTasks.map((t) => (
                <div key={t.id} className={`home-task ${t.state}`}>
                  {t.state === "running" ? <RefreshCw size={13} className="spin" /> : t.state === "done" ? <CheckCircle2 size={13} color="var(--ok)" /> : t.state === "paused" ? <Pause size={13} color="var(--warn)" /> : t.state === "partial" ? <AlertTriangle size={13} color="var(--warn)" /> : t.state === "stopped" ? <Square size={13} color="var(--muted)" /> : <X size={13} color="var(--danger)" />}
                  <span>{(() => { const label = t.kind === "sync" ? "下载聊天" : t.kind === "sync-all" ? "批量下载" : t.kind === "refresh" ? "重建网页" : t.title; return t.chat && !label.includes(t.chat) ? `${label} · ${t.chat}` : label; })()}</span>
                  <em>{t.state === "running" ? `${t.percent}%` : t.state === "done" ? "完成" : t.state === "paused" ? "已暂停" : t.state === "partial" ? "部分完成" : t.state === "stopped" ? "已终止" : "失败"}</em>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {updateTarget && (
        <OnlineUpdateDialog
          target={updateTarget}
          onClose={() => setUpdateTarget(null)}
          onStarted={(taskId) => { setUpdateTarget(null); if (taskId) openTask(taskId); }}
          toast={toast}
        />
      )}
    </>
  );
}

/* ============================== Chats ============================== */
interface Stats {
  messages: number;
  media: number;
  images: number;
  videos: number;
  audio: number;
  files: number;
  missing: number;
  missingImages: number;
  missingVideos: number;
}

const CHAT_MEDIA_TYPES = [
  { key: "image", label: "图片", icon: Images },
  { key: "video", label: "视频", icon: Video },
  { key: "audio", label: "音频", icon: Music },
  { key: "file", label: "文件", icon: FileText },
];

function MediaTypeGrid({ row }: { row: ChatRow }) {
  const values = [
    { count: row.images ?? 0, size: row.imageBytes ?? 0 },
    { count: row.videos ?? 0, size: row.videoBytes ?? 0 },
    { count: row.audio ?? 0, size: row.audioBytes ?? 0 },
    { count: row.files ?? 0, size: row.fileBytes ?? 0 },
  ];
  return (
    <div className="media-type-grid">
      {CHAT_MEDIA_TYPES.map((type, index) => {
        const Icon = type.icon;
        const value = values[index];
        return (
          <div className={`media-type-card ${type.key}`} key={type.key}>
            <span className="media-type-icon"><Icon size={16} /></span>
            <div className="media-type-main">
              <span>{type.label}</span>
              <b>{row.mediaReady ? value.count.toLocaleString() : "—"} <em>个</em></b>
              <small>{row.mediaReady ? bytes(value.size) : "待核对"}</small>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function Chats({ ctx }: { ctx: PageCtx }) {
  const { chats, selected, refresh, toast, go, pickFolder, openTask } = ctx;
  const [stats, setStats] = useState<Stats | null>(null);
  const [busy, setBusy] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [onlineTarget, setOnlineTarget] = useState<OnlineUpdateTarget | null>(null);
  const [onlineLoading, setOnlineLoading] = useState(false);
  const [mediaSummary, setMediaSummary] = useState<{ key: string; slug: string; summary: MediaSummary } | null>(null);

  const selectedChat = chats.find((c) => c.slug === selected) || null;
  const current = selectedChat && !ctx.applyMediaSummary && mediaSummary?.slug === selectedChat.slug && mediaSummary.key === ctx.boot?.libraryKey
    ? rowWithSummary(selectedChat, mediaSummary.summary) : selectedChat;
  useEffect(() => {
    setStats(null);
    setBusy("");
  }, [selected]);

  const verify = async () => {
    if (!current) return;
    setBusy("verify");
    try {
      const s = await call<Stats>("verifyChat", { slug: current.slug });
      setStats(s);
      toast("完整性核对完成");
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy("");
    }
  };

  const remove = async () => {
    if (!current) return;
    setDeleteConfirm(true);
  };

  const removeConfirmed = async () => {
    if (!current) return;
    setDeleteConfirm(false);
    setBusy("delete");
    try {
      await call("deleteChat", { slug: current.slug });
      toast("已删除本地归档", "success");
      refresh();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy("");
    }
  };

  const exportChat = async () => {
    if (!current) return;
    try {
      const dst = await pickFolder("export-target", "选择目标档案库目录（可新建空目录）");
      if (!dst) return;
      const { taskId } = await call<{ taskId: string }>("startExportChat", { slug: current.slug, dst });
      toast("导出任务已加入任务中心", "success", { label: "查看任务", run: () => openTask(taskId) });
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const onlineUpdate = async () => {
    if (!current || onlineLoading) return;
    if (!ctx.boot?.hasSession) {
      toast("请先在账号管理登录 Telegram", true);
      return;
    }
    setOnlineLoading(true);
    try {
      const chat = await call<{ peer: string; name: string; type?: string; id?: number; avatar?: string }>("onlineChatForSlug", { slug: current.slug });
      setOnlineTarget({ ...onlineTargetFromChat(chat), slug: current.slug, mode: "online" });
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setOnlineLoading(false);
    }
  };

  const rebuild = async () => {
    if (!current) return;
    try {
      const { taskId } = await call<{ taskId: string }>("startRefreshWeb", { slug: current.slug });
      toast("已加入任务中心：正在补齐视频封面并重建离线网页", "success", { label: "查看任务", run: () => openTask(taskId) });
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const backfillJSON = () => {
    if (!current) return;
    setOnlineTarget({
      peer: "local:" + current.slug,
      name: current.name,
      slug: current.slug,
      mode: "backfill",
    });
  };

  const copyPath = () => {
    if (!current) return;
    navigator.clipboard?.writeText(current.dir).then(() => toast("目录已复制", "success")).catch(() => toast("复制失败", true));
  };
  const jsonPath = current ? `${current.dir.replace(/[\\/]+$/, "")}\\source\\result.json` : "";
  const copyJSONPath = () => {
    if (!jsonPath) return;
    navigator.clipboard?.writeText(jsonPath).then(() => toast("result.json 路径已复制", "success")).catch(() => toast("复制失败", true));
  };

  if (!current) {
    return (
      <div className="empty-state">
        <MessagesSquare size={30} />
        <h2>还没有可查看的聊天</h2>
        <p>导入 Telegram Desktop 导出的 result.json，或继承已有的 ChatExport，然后就能在这里浏览媒体。</p>
        <button className="btn primary" onClick={() => go("library")}>
          <Download size={13} /> 前往档案库导入
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="page-head">
        <div className="chat-title">
          <h1>{current.name}</h1>
        </div>
        <div className="actions">
          <button className="btn ghost" onClick={() => go("library")}>
            <ChevronLeft size={13} /> 返回档案管理
          </button>
          <button className="btn danger" disabled={busy === "delete"} onClick={remove}>
            <Trash2 size={13} /> 删除本地归档
          </button>
          <button className="btn primary" disabled={onlineLoading || !ctx.boot?.hasSession} onClick={() => void onlineUpdate()} title="从 Telegram 在线会话拉取最新消息，先统计再确认归档">
            {onlineLoading ? <Loader2 size={13} className="spin" /> : <CloudDownload size={13} />} {onlineLoading ? "正在读取会话…" : "拉取最新消息"}
          </button>
        </div>
      </div>

      <section className="stat-grid chat-overview-stats">
        <div className="stat">
          <span>消息</span>
          <div><b>{current.messages.toLocaleString()}</b><em>条</em></div>
        </div>
        <div className="stat">
          <span>媒体</span>
          <div><b>{current.media.toLocaleString()}</b><em>个</em></div>
        </div>
        <div className="stat">
          <span>占用空间</span>
          <div><b>{current.mediaReady ? bytes(current.totalBytes ?? 0) : "待核对"}</b></div>
        </div>
        <div className="stat">
          <span>缺失</span>
          <div><b className={current.missing > 0 ? "warn" : ""}>{current.missing.toLocaleString()}</b><em>个</em></div>
        </div>
        <div className="stat">
          <span>网页</span>
          <div><b>{current.pages}</b><em>页</em></div>
        </div>
      </section>

      <section className="panel chat-media-panel">
        <div className="panel-head">
          <h3><HardDrive size={14} /> 媒体构成</h3>
          <span className="meta">{current.mediaReady ? `共 ${current.media.toLocaleString()} 个 · ${bytes(current.totalBytes ?? 0)}` : "正在核对媒体统计…"}</span>
        </div>
        <MediaTypeGrid row={current} />
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>归档信息</h3>
        </div>
        <div className="chat-facts-grid chat-facts-three">
          <div className="fact"><span>类型</span><b>{current.type || "--"}</b></div>
          <div className="fact"><span>Chat ID</span><b className="mono">{current.id || (current.official > 0 ? "在线更新时识别" : "--")}</b></div>
          <div className="fact"><span>官方导出</span><b>{current.official} 个</b></div>
          <div className="fact"><span>首次消息</span><b>{dateTime(current.firstTs)}</b></div>
          <div className="fact"><span>最后消息</span><b>{dateTime(current.lastTs)}</b></div>
          <div className="fact"><span>最近更新</span><b>{dateTime(current.updatedAt)}</b></div>
          <div className="fact wide">
            <span>归档目录</span>
            <code title={current.dir}>{current.dir}</code>
            <button className="icon-btn" data-tip="复制目录" aria-label="复制目录" onClick={copyPath}>
              <Copy size={13} />
            </button>
          </div>
          {current.hasSource && (
            <div className="fact wide">
              <span>result.json</span>
              <code title={jsonPath}>{jsonPath}</code>
              <button className="icon-btn" data-tip="复制 result.json 路径" aria-label="复制 result.json 路径" onClick={copyJSONPath}>
                <Copy size={13} />
              </button>
            </div>
          )}
        </div>
        <div className="chat-actions">
          <div className="chat-actions-main">
            <button className="btn sm" disabled={busy === "verify"} onClick={verify}>
              <ShieldCheck size={12} /> {busy === "verify" ? "核对中…" : "核对完整性"}
            </button>
            <button className="btn sm ghost" onClick={() => call("revealChat", { slug: current.slug })}>
              <FolderOpen size={12} /> 打开目录
            </button>
            <button className="btn sm ghost" onClick={() => call("openLibrary", { slug: current.slug })}>
              <ArrowUpRight size={12} /> 打开归档库
            </button>
            <button className="btn sm ghost" onClick={exportChat}>
              <ArrowDownToLine size={12} /> 导出到另一库
            </button>
            <button className="btn sm ghost" onClick={rebuild} title="重新生成离线网页，并补齐缺失的图片与视频封面缩略图">
              <RefreshCw size={12} /> 补齐封面与网页
            </button>
            <button className="btn sm ghost" onClick={() => void backfillJSON()} disabled={!current.hasSource} title="先统计 result.json 中缺失的媒体、数量与占用，确认后再补全；不访问 Telegram 在线消息">
              <FileText size={12} /> 按 result.json 补全
            </button>
          </div>
        </div>
        {stats && (
          <div className="chat-verify">
            <ShieldCheck size={15} />
            <div>
              <b>完整性核对</b>
              <p>
                {stats.messages.toLocaleString()} 条消息 · {stats.media.toLocaleString()} 个媒体（图片 {stats.images} · 视频 {stats.videos} · 音频 {stats.audio} · 文件 {stats.files}）
                {stats.missing > 0 ? ` · 缺失 ${stats.missing}` : " · 无缺失"}
                {stats.missingImages + stats.missingVideos > 0 ? ` · 待补封面：图片 ${stats.missingImages} / 视频 ${stats.missingVideos}` : ""}
              </p>
            </div>
          </div>
        )}
      </section>

      {onlineTarget && (
        <OnlineUpdateDialog
          target={onlineTarget}
          onClose={() => setOnlineTarget(null)}
          onStarted={(taskId) => { setOnlineTarget(null); openTask(taskId); }}
          toast={toast}
        />
      )}

      <MediaGallery key={`${ctx.boot?.libraryKey ?? ""}:${current.slug}`} ctx={ctx} chat={current} onSummary={(summary) => {
        if (ctx.boot?.libraryKey) setMediaSummary({ key: ctx.boot.libraryKey, slug: current.slug, summary });
      }} />

      <ConfirmDialog
        open={deleteConfirm}
        title={`删除本地归档「${current.name}」？`}
        message="只删除档案库副本，Telegram 云端不受影响，且无法从 TAK 撤销。"
        confirmLabel="删除归档"
        danger
        onConfirm={() => void removeConfirmed()}
        onCancel={() => setDeleteConfirm(false)}
      />
    </>
  );
}

/* =========================== Media gallery =========================== */
const MEDIA_FILTERS = [
  { key: "all", label: "全部" },
  { key: "image", label: "图片" },
  { key: "video", label: "视频" },
  { key: "audio", label: "音频" },
  { key: "file", label: "文件" },
];

const mediaURL = (slug: string, rel: string, libraryKey: string, version: string, prefetch = false, preview = false) => {
  const params = new URLSearchParams({ slug, f: rel, k: libraryKey, v: version });
  if (prefetch) params.set("prefetch", "1");
  if (preview) params.set("preview", "1");
  return `/api/media?${params}`;
};
const thumbURL = (slug: string, rel: string | undefined, libraryKey: string, version: string) =>
  rel ? mediaURL(slug, rel, libraryKey, version, false, true) : "";

function rowWithSummary(row: ChatRow, summary: MediaSummary): ChatRow {
  return {
    ...row, mediaReady: true, media: summary.total, totalBytes: summary.bytes,
    images: summary.images, videos: summary.videos, audio: summary.audio, files: summary.files,
    imageBytes: summary.imageBytes, videoBytes: summary.videoBytes,
    audioBytes: summary.audioBytes, fileBytes: summary.fileBytes,
  };
}

const coverToneCache = new Map<string, string>();

function coverTone(src: string): Promise<string> {
  const cached = coverToneCache.get(src);
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 24;
        canvas.height = 24;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("no canvas");
        ctx.drawImage(img, 0, 0, 24, 24);
        const data = ctx.getImageData(0, 0, 24, 24).data;
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 128) continue;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          n++;
        }
        if (!n) throw new Error("empty");
        r /= n * 255;
        g /= n * 255;
        b /= n * 255;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        let h = 0;
        const l = (max + min) / 2;
        const d = max - min;
        const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
        if (d !== 0) {
          if (max === r) h = ((g - b) / d) % 6;
          else if (max === g) h = (b - r) / d + 2;
          else h = (r - g) / d + 4;
          h = (h * 60 + 360) % 360;
        }
        const hue = Math.round(h);
        const sat = Math.round(Math.max(18, Math.min(42, s * 100)));
        const lig = Math.round(Math.max(13, Math.min(23, l * 100)));
        const tone = `hsl(${hue} ${sat}% ${lig}%)`;
        if (coverToneCache.size >= 128) coverToneCache.delete(coverToneCache.keys().next().value!);
        coverToneCache.set(src, tone);
        resolve(tone);
      } catch {
        resolve("hsl(221 24% 14%)");
      }
    };
    img.onerror = () => resolve("hsl(221 24% 14%)");
    img.src = src;
  });
}

const fileExt = (name: string) => (name.split(".").pop() ?? "").toLowerCase();

function mediaIcon(kind: string) {
  if (kind === "image") return <ImageIcon size={20} />;
  if (kind === "video") return <Film size={20} />;
  if (kind === "audio") return <Music size={20} />;
  return <FileText size={20} />;
}

type BrowsePolicy = "auto" | "experience" | "performance";

function readBrowsePolicy(key: string): BrowsePolicy {
  if (!key) return "auto";
  try {
    const value = localStorage.getItem("tak-media-policy-v1:" + key);
    return value === "experience" || value === "performance" ? value : "auto";
  } catch {
    return "auto";
  }
}

function useBrowsePolicy(key: string): [BrowsePolicy, (value: BrowsePolicy) => boolean] {
  const [choice, setChoice] = useState(() => ({ key, value: readBrowsePolicy(key) }));
  const value = choice.key === key ? choice.value : readBrowsePolicy(key);
  useEffect(() => {
    const sync = () => {
      const next = readBrowsePolicy(key);
      setChoice((current) => current.key === key && current.value === next ? current : { key, value: next });
    };
    sync();
    window.addEventListener("tak-media-policy-change", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("tak-media-policy-change", sync);
      window.removeEventListener("storage", sync);
    };
  }, [key]);
  const choose = (next: BrowsePolicy) => {
    if (!key) return false;
    try {
      localStorage.setItem("tak-media-policy-v1:" + key, next);
      setChoice({ key, value: next });
      window.dispatchEvent(new Event("tak-media-policy-change"));
      return true;
    } catch {
      return false;
    }
  };
  return [value, choose];
}

function browsePerformanceMode(policy: BrowsePolicy, kind: Bootstrap["libraryKind"]): boolean {
  return policy === "performance" || (policy === "auto" && kind !== "local");
}

const defaultMediaPageSize = 50;
const maxMediaPageSize = 200;
const mediaPageSizeKey = "tak-media-page-size";
const mediaPageSizeChanged = "tak-media-page-size-change";

function validMediaPageSize(size: number) {
  return Number.isInteger(size) && size >= 1 && size <= maxMediaPageSize;
}

function readMediaPageSize() {
  try {
    const size = Number(localStorage.getItem(mediaPageSizeKey));
    return validMediaPageSize(size) ? size : defaultMediaPageSize;
  } catch {
    return defaultMediaPageSize;
  }
}

function subscribeMediaPageSize(sync: () => void) {
  window.addEventListener(mediaPageSizeChanged, sync);
  window.addEventListener("storage", sync);
  return () => {
    window.removeEventListener(mediaPageSizeChanged, sync);
    window.removeEventListener("storage", sync);
  };
}

function mediaPageNumbers(page: number, total: number): number[] {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
  if (page <= 3) return [1, 2, 3, 4, -1, total];
  if (page >= total - 2) return [1, -1, total - 3, total - 2, total - 1, total];
  return [1, -1, page - 1, page, page + 1, -2, total];
}

interface ImageLimiter {
  schedule: (start: (done: () => void) => void) => () => void;
}

function createImageLimiter(limit: number): ImageLimiter {
  const queue: { start: (done: () => void) => void; cancelled: boolean; finish?: () => void }[] = [];
  let running = 0;
  const drain = () => {
    while (running < limit && queue.length) {
      const task = queue.shift()!;
      if (task.cancelled) continue;
      running++;
      let finished = false;
      task.finish = () => {
        if (finished) return;
        finished = true;
        running--;
        drain();
      };
      task.start(task.finish);
    }
  };
  return {
    schedule(start) {
      const task: { start: (done: () => void) => void; cancelled: boolean; finish?: () => void } = { start, cancelled: false };
      queue.push(task);
      drain();
      return () => {
        task.cancelled = true;
        task.finish?.();
      };
    },
  };
}

// Performance mode starts only images which intersect the scroll viewport and
// permits a small number of simultaneous image transfers.
function GalleryImage({ src, kind, performanceMode, limiter, suspended = false }: {
  src: string; kind: MediaItem["kind"]; performanceMode: boolean; limiter: ImageLimiter; suspended?: boolean;
}) {
  const preview = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [activeSrc, setActiveSrc] = useState<string>();
  const [status, setStatus] = useState<"pending" | "ready" | "failed">("pending");
  const settled = useRef(false);
  const finish = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!src || !performanceMode || suspended || !preview.current || status !== "pending") return;
    setVisible(false);
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => setVisible(entries.some((entry) => entry.isIntersecting)));
    observer.observe(preview.current);
    return () => observer.disconnect();
  }, [src, performanceMode, suspended, status]);

  useEffect(() => {
    if (!src || !performanceMode || suspended || !visible || settled.current) return;
    const cancel = limiter.schedule((done) => {
      finish.current = done;
      setActiveSrc(src);
    });
    return () => {
      cancel();
      finish.current = null;
      if (!settled.current) setActiveSrc(undefined);
    };
  }, [src, performanceMode, visible, limiter, suspended]);

  const complete = (ready: boolean) => {
    settled.current = true;
    finish.current?.();
    finish.current = null;
    setStatus(ready ? "ready" : "failed");
  };
  const requestSrc = performanceMode && status === "pending" ? activeSrc : src;
  return (
    <span ref={preview} className={`media-preview ${status}`} aria-hidden="true">
      {status !== "ready" && <span className={`media-ph ${kind}`}>{mediaIcon(kind)}</span>}
      {requestSrc && status !== "failed" && (
        <img src={requestSrc} alt="" loading={performanceMode ? "eager" : "lazy"} decoding="async"
          onLoad={() => complete(true)} onError={() => complete(false)} />
      )}
    </span>
  );
}

function previewURL(item: MediaItem, slug: string, libraryKey: string, version: string) {
  if (item.thumb) return thumbURL(slug, item.thumb, libraryKey, version);
  return item.kind === "image" ? mediaURL(slug, item.rel, libraryKey, version, false, true) : "";
}

export function MediaGallery({ ctx, chat, onSummary }: {
  ctx: PageCtx; chat: ChatRow; onSummary?: (summary: MediaSummary) => void;
}) {
  const { toast } = ctx;
  const libraryKey = ctx.boot?.libraryKey ?? "";
  const libraryKind = ctx.boot?.libraryKind ?? "unknown";
  const [policy] = useBrowsePolicy(libraryKey);
  const performanceMode = browsePerformanceMode(policy, libraryKind);
  const pageSize = useSyncExternalStore(subscribeMediaPageSize, readMediaPageSize);
  const limiter = useMemo(() => createImageLimiter(4), []);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [toolsPosition, setToolsPosition] = useState({ left: 0, top: 0, width: 290 });
  const toolsButton = useRef<HTMLButtonElement>(null);
  const toolsPanel = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState("all");
  const [searchText, setSearchText] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [previousPageSize, setPreviousPageSize] = useState(pageSize);
  const [reload, setReload] = useState(0);
  const [result, setResult] = useState<{ key: string; data: MediaPage } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [cancelledPage, setCancelledPage] = useState<number | null>(null);
  const [notice, setNotice] = useState("");
  const [viewer, setViewer] = useState<{ page: MediaPage; rel: string; pageBackdrop: string } | null>(null);
  const viewerRef = useRef(viewer);
  viewerRef.current = viewer;
  const viewerRequest = useRef<AbortController | null>(null);
  const viewerOpenRequest = useRef<AbortController | null>(null);
  useEffect(() => () => viewerOpenRequest.current?.abort(), []);
  const [viewerBusy, setViewerBusy] = useState(false);
  const [viewerError, setViewerError] = useState("");
  const [audioItem, setAudioItem] = useState<{ item: MediaItem; version: string } | null>(null);
  const refreshNext = useRef(false);
  const requestWasRefresh = useRef(false);
  const retryRefresh = useRef(false);
  const pageRequest = useRef<AbortController | null>(null);
  if (pageSize !== previousPageSize) {
    setPreviousPageSize(pageSize);
    setPage(1);
    setViewer(null);
    setViewerBusy(false);
    setAudioItem(null);
  }
  const [size, setSize] = useState<"sm" | "md" | "lg" | "xl">(() => {
    const saved = localStorage.getItem("tak-media-size");
    return saved === "sm" || saved === "lg" || saved === "xl" ? saved : "md";
  });
  const [sort, setSort] = useState<"newest" | "oldest" | "size-desc" | "size-asc">(() => {
    const saved = localStorage.getItem("tak-media-sort");
    return saved === "oldest" || saved === "size-desc" || saved === "size-asc" ? saved : "newest";
  });
  useEffect(() => { localStorage.setItem("tak-media-size", size); }, [size]);
  useEffect(() => { localStorage.setItem("tak-media-sort", sort); }, [sort]);
  useLayoutEffect(() => {
    if (!toolsOpen) return;
    const place = () => {
      const rect = toolsButton.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(290, window.innerWidth - 16);
      const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
      const height = toolsPanel.current?.getBoundingClientRect().height ?? 120;
      const top = window.innerHeight - rect.bottom < height + 6 && rect.top > height + 6 ? rect.top - height - 6 : rect.bottom + 6;
      setToolsPosition({ left, top: Math.max(8, top), width });
    };
    place();
    searchInput.current?.focus();
    window.addEventListener("resize", place);
    const closeOnScroll = () => setToolsOpen(false);
    window.addEventListener("scroll", closeOnScroll, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", closeOnScroll, true); };
  }, [toolsOpen]);
  useEffect(() => {
    if (!toolsOpen) return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (toolsPanel.current?.contains(target) || toolsButton.current?.contains(target) || target.closest(".ui-select-menu.portal")) return;
      setToolsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setToolsOpen(false);
      toolsButton.current?.focus();
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("mousedown", onMouseDown); document.removeEventListener("keydown", onKeyDown); };
  }, [toolsOpen]);
  useEffect(() => {
    const nextQuery = searchText.trim();
    if (nextQuery === query) return;
    const timer = window.setTimeout(() => {
      setPage(1);
      setQuery(nextQuery);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [searchText, query]);

  const catalogKey = JSON.stringify([libraryKey, chat.slug, filter, sort, query, pageSize]);
  const catalog = useRef<{ key: string; version: string; pages: Map<number, MediaPage> }>({ key: "", version: "", pages: new Map() });
  const onSummaryRef = useRef(onSummary);
  const applySummaryRef = useRef(ctx.applyMediaSummary);
  onSummaryRef.current = onSummary;
  applySummaryRef.current = ctx.applyMediaSummary;

  const remember = (target: MediaPage) => {
    const pages = catalog.current.pages;
    pages.delete(target.page);
    pages.set(target.page, target);
    while (pages.size > 3) pages.delete(pages.keys().next().value!);
  };

  useEffect(() => {
    const controller = new AbortController();
    if (!libraryKey) {
      setLoading(false);
      return () => controller.abort();
    }
    if (catalog.current.key !== catalogKey) {
      catalog.current = { key: catalogKey, version: "", pages: new Map() };
      setNotice("");
    }
    const force = refreshNext.current;
    refreshNext.current = false;
    const candidate = !force ? catalog.current.pages.get(page) : undefined;
    const cached = candidate?.version === catalog.current.version ? candidate : undefined;
    if (cached) {
      setResult({ key: catalogKey, data: cached });
      setError("");
      setLoading(false);
      return () => controller.abort();
    }
    const requestedVersion = force ? "" : catalog.current.version;
    requestWasRefresh.current = force;
    pageRequest.current = controller;
    setCancelledPage(null);
    setError("");
    setLoading(true);
    call<MediaPage>("chatMedia", {
      slug: chat.slug, kind: filter, sort, query, page, pageSize, version: requestedVersion, refresh: force, libraryKey,
    }, controller.signal).then((next) => {
      if (controller.signal.aborted || catalog.current.key !== catalogKey) return;
      if (requestedVersion && next.version !== requestedVersion) {
        catalog.current.version = "";
        catalog.current.pages.clear();
        setNotice("媒体列表已更新，已返回第一页。");
        setPage(1);
        setReload((n) => n + 1);
        return;
      }
      if (force || (catalog.current.version && catalog.current.version !== next.version)) catalog.current.pages.clear();
      catalog.current.version = next.version;
      remember(next);
      setResult({ key: catalogKey, data: next });
      setLoading(false);
      retryRefresh.current = false;
      if (pageRequest.current === controller) pageRequest.current = null;
      onSummaryRef.current?.(next.summary);
      applySummaryRef.current?.(libraryKey, chat.slug, next.summary);
      if (next.page !== page) setPage(next.page);
    }).catch((e: Error) => {
      if (controller.signal.aborted) return;
      setLoading(false);
      retryRefresh.current = force;
      if (pageRequest.current === controller) pageRequest.current = null;
      setError(e.message);
    });
    return () => {
      controller.abort();
      if (pageRequest.current === controller) pageRequest.current = null;
    };
  }, [libraryKey, chat.slug, catalogKey, filter, sort, query, page, pageSize, reload]);

  const displayed = result?.key === catalogKey ? result.data : null;
  const searchPending = searchText.trim() !== query;
  const sourcePage = viewer?.page ?? (displayed?.page === page ? displayed : null);
  useEffect(() => {
    if (performanceMode || loading || searchPending || cancelledPage !== null || !sourcePage || sourcePage.page * sourcePage.pageSize >= sourcePage.total ||
        catalog.current.key !== catalogKey || catalog.current.version !== sourcePage.version || catalog.current.pages.has(sourcePage.page + 1)) return;
    const controller = new AbortController();
    let first = 0, second = 0;
    first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        void call<MediaPage>("chatMedia", {
          slug: chat.slug, kind: filter, sort, query, page: sourcePage.page + 1, pageSize: sourcePage.pageSize, version: sourcePage.version, libraryKey,
        }, controller.signal).then((next) => {
          if (!controller.signal.aborted && catalog.current.key === catalogKey && catalog.current.version === sourcePage.version && next.version === sourcePage.version) remember(next);
        }).catch(() => undefined);
      });
    });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); controller.abort(); };
  }, [performanceMode, loading, searchPending, cancelledPage, sourcePage, catalogKey, chat.slug, filter, sort, query]);

  useEffect(() => () => viewerRequest.current?.abort(), [pageSize]);
  const cancelViewerRequest = () => {
    viewerRequest.current?.abort();
    viewerRequest.current = null;
    setViewerBusy(false);
  };
  const setViewerIndex = (index: number) => {
    cancelViewerRequest();
    setViewerError("");
    setViewer((current) => {
      if (!current) return current;
      const item = current.page.items.filter((entry) => entry.kind === "image" || entry.kind === "video")[index];
      return item ? { ...current, rel: item.rel } : current;
    });
  };
  const stepViewer = async (direction: -1 | 1, auto = false) => {
    const current = viewerRef.current;
    if (!current) return;
    cancelViewerRequest();
    setViewerError("");
    const list = current.page.items.filter((entry) => entry.kind === "image" || entry.kind === "video");
    const index = list.findIndex((entry) => entry.rel === current.rel);
    const local = list[index + direction];
    if (local) {
      if (!auto || local.kind === "video") setViewer({ ...current, rel: local.rel });
      return;
    }
    const controller = new AbortController();
    viewerRequest.current = controller;
    setViewerBusy(true);
    try {
      let nextPage = current.page.page + direction;
      const lastPage = Math.max(1, Math.ceil(current.page.total / current.page.pageSize));
      while (nextPage >= 1 && nextPage <= lastPage) {
        let next = catalog.current.pages.get(nextPage);
        if (!next) {
          next = await call<MediaPage>("chatMedia", {
            slug: chat.slug, kind: filter, sort, query, page: nextPage, pageSize: current.page.pageSize, version: current.page.version, libraryKey,
          }, controller.signal);
        }
        if (controller.signal.aborted || catalog.current.key !== catalogKey || viewerRef.current?.rel !== current.rel) return;
        if (next.version !== current.page.version) {
          setViewerError("媒体列表已更新，请关闭查看器并刷新后继续。");
          return;
        }
        remember(next);
        const visual = next.items.filter((entry) => entry.kind === "image" || entry.kind === "video");
        const target = direction > 0 ? visual[0] : visual[visual.length - 1];
        if (target) {
          if (!auto || target.kind === "video") setViewer({ ...current, page: next, rel: target.rel });
          return;
        }
        nextPage += direction;
      }
      if (!auto) setViewerError(direction > 0 ? "后面没有更多图片或视频。" : "前面没有更多图片或视频。");
    } catch (e) {
      if (!controller.signal.aborted) setViewerError("读取相邻媒体失败：" + (e as Error).message);
    } finally {
      if (viewerRequest.current === controller) {
        viewerRequest.current = null;
        setViewerBusy(false);
      }
    }
  };

  const openItem = async (item: MediaItem) => {
    if (!displayed || displayed.page !== page || loading || searchPending || viewerOpenRequest.current) return;
    if (item.kind === "audio") {
      setAudioItem({ item, version: displayed.version });
    } else if (item.kind === "image" || item.kind === "video") {
      let pageBackdrop = "";
      if (ctx.prefs.backdrop !== "solid") {
        const controller = new AbortController();
        viewerOpenRequest.current = controller;
        try {
          pageBackdrop = await call<string>("captureViewerBackdrop", undefined, AbortSignal.any([controller.signal, AbortSignal.timeout(220)]));
        } catch {
          // The same neutral background is used if window capture is unavailable.
        } finally {
          viewerOpenRequest.current = null;
        }
        if (controller.signal.aborted) return;
      }
      setViewerError("");
      setViewer({ page: displayed, rel: item.rel, pageBackdrop });
    }
  };
  const reveal = (item: MediaItem) =>
    call("revealMedia", { slug: chat.slug, path: item.rel, libraryKey }).catch((e: Error) => toast(e.message, true));
  const openExternal = (item: MediaItem) =>
    call("openMedia", { slug: chat.slug, path: item.rel, libraryKey }).catch((e: Error) => toast(e.message, true));
  const refresh = () => {
    refreshNext.current = true;
    if (displayed && displayed.version === catalog.current.version) remember(displayed);
    setPage(1);
    setNotice("");
    setReload((n) => n + 1);
  };
  const retry = () => {
    const target = cancelledPage ?? page;
    catalog.current.pages.delete(target);
    refreshNext.current = retryRefresh.current;
    setCancelledPage(null);
    setPage(target);
    setReload((n) => n + 1);
  };
  const cancelLoad = () => {
    pageRequest.current?.abort();
    pageRequest.current = null;
    setLoading(false);
    retryRefresh.current = requestWasRefresh.current;
    setCancelledPage(page);
    if (displayed && displayed.page !== page) {
      if (displayed.version === catalog.current.version) remember(displayed);
      setPage(displayed.page);
    }
  };
  const summary = displayed?.summary;
  const media = displayed?.items.filter((item) => item.kind !== "file") ?? [];
  const files = displayed?.items.filter((item) => item.kind === "file") ?? [];
  const totalPages = Math.max(1, Math.ceil((displayed?.total ?? 0) / pageSize));
  const navigatePage = (next: number) => {
    if (!loading && !searchPending && next >= 1 && next <= totalPages) setPage(next);
  };
  const viewerItems = useMemo(() => viewer?.page.items.filter((item) => item.kind === "image" || item.kind === "video") ?? [], [viewer?.page]);
  const viewerIndex = viewerItems.findIndex((item) => item.rel === viewer?.rel);
  const rawViewerIndex = viewer?.page.items.findIndex((item) => item.rel === viewer.rel) ?? -1;

  return (
    <section className="panel media-gallery" data-effective-policy={performanceMode ? "performance" : "experience"} data-browse-policy={policy}>
      <div className="panel-head media-head">
        <div className="media-title">
          <h3><Images size={14} /> 媒体与文件</h3>
          <span className="meta">{summary ? `共 ${(summary.total - summary.files).toLocaleString()} 个媒体 · ${summary.files.toLocaleString()} 个文件` : "正在读取…"}</span>
          <button ref={toolsButton} className={"icon-btn media-options-button" + (searchText.trim() ? " has-query" : "")}
            aria-label="媒体浏览选项" aria-haspopup="dialog" aria-expanded={toolsOpen}
            title={searchText.trim() ? "媒体浏览选项 · 已启用搜索" : "媒体浏览选项"} onClick={() => setToolsOpen((open) => !open)}>
            <SlidersHorizontal size={13} />
          </button>
        </div>
        <div className="media-tools">
          <div className="media-sort">
            <Select ariaLabel="媒体排序" value={sort} onChange={(value) => { setPage(1); setSort(value as typeof sort); }} options={[
              { value: "newest", label: "最新在前" }, { value: "oldest", label: "最早在前" },
              { value: "size-desc", label: "大小从大到小" }, { value: "size-asc", label: "大小从小到大" },
            ]} />
          </div>
          <div className="media-size" role="group" aria-label="预览图大小">
            {[["sm", "小"], ["md", "中"], ["lg", "大"], ["xl", "超大"]].map(([key, label]) => (
              <button key={key} className={size === key ? "on" : ""} onClick={() => setSize(key as typeof size)}>{label}</button>
            ))}
          </div>
          <div className="tabs media-tabs" role="tablist" aria-label="媒体筛选">
            {MEDIA_FILTERS.map((f) => {
              const count = !summary ? null : f.key === "all" ? summary.total : f.key === "image" ? summary.images :
                f.key === "video" ? summary.videos : f.key === "audio" ? summary.audio : summary.files;
              return <button key={f.key} role="tab" aria-selected={filter === f.key} className={filter === f.key ? "on" : ""}
                onClick={() => { setPage(1); setFilter(f.key); }}>
                {f.label}<span className="tab-count">{count === null ? "—" : count.toLocaleString()}</span>
              </button>;
            })}
          </div>
        </div>
      </div>
      {toolsOpen && createPortal(
        <div ref={toolsPanel} className="media-options-popover" role="dialog" aria-label="媒体浏览选项" style={toolsPosition}>
          <label className="media-option-label" htmlFor="media-search-input">搜索文件名</label>
          <div className="media-search">
            <Search size={13} />
            <input id="media-search-input" ref={searchInput} value={searchText} onChange={(e) => setSearchText(e.target.value)} placeholder="搜索媒体和文件" />
            {searchText && <button className="media-search-clear" aria-label="清除搜索" onClick={() => { setSearchText(""); searchInput.current?.focus(); }}><X size={13} /></button>}
          </div>
          <div className="media-option-actions">
            {loading ? <button className="btn sm ghost" onClick={cancelLoad}><X size={12} /> 取消读取</button>
              : <button className="btn sm ghost" onClick={refresh}><RefreshCw size={12} /> 重新核对</button>}
          </div>
        </div>, document.body
      )}
      {(displayed?.stale || notice) && <div className="media-context">
        {displayed?.stale && <span>显示已保存的媒体快照，数据可能已变化。</span>}
        {notice && <span role="status">{notice}</span>}
        {displayed?.stale && <button className="btn sm ghost" onClick={refresh} disabled={loading}>重新核对</button>}
      </div>}

      {error && <div className="media-error" role="alert"><span>读取媒体列表失败：{error}</span><button className="btn sm ghost" onClick={retry}>重试</button></div>}
      {cancelledPage !== null && !loading && <div className="media-error cancelled" role="status"><span>已取消读取媒体列表。</span><button className="btn sm ghost" onClick={retry}>重试</button></div>}
      {!displayed && !error && cancelledPage === null ? (
        <div className="media-grid" aria-label="正在读取媒体列表" aria-busy="true">
          {Array.from({ length: 12 }).map((_, i) => <div key={i} className="media-tile skeleton" />)}
        </div>
      ) : displayed && (
        <div aria-busy={loading || searchPending}>
          {displayed.items.length === 0 ? (
            <div className="state-box"><p>{query ? "没有找到匹配的媒体或文件。" : "当前筛选没有媒体或文件。"}</p></div>
          ) : (
            <>
              {media.length > 0 && <div className={"media-grid size-" + size}>
                {media.map((item) => {
                  const src = previewURL(item, chat.slug, libraryKey, displayed.version);
                  return (
                  <button key={displayed.version + ":" + item.rel} className={"media-tile " + item.kind} title={item.name + (item.id ? " · 消息 #" + item.id : "")}
                    onClick={() => openItem(item)} disabled={loading || searchPending}>
                    <GalleryImage key={src} src={src} kind={item.kind} performanceMode={performanceMode} limiter={limiter} suspended={Boolean(viewer || audioItem)} />
                    {item.kind === "video" && <span className="media-play"><Play size={14} fill="currentColor" /></span>}
                    <span className="media-cap"><b>{item.name}</b><i>{bytes(item.size)}</i></span>
                  </button>
                  );
                })}
              </div>}
              {files.length > 0 && <div className="file-block">
                <div className="file-block-head"><h4>文档与其它文件</h4><span>本页 {files.length} 个</span></div>
                <div className="file-list">
                  {files.map((f) => <div className="file-row" key={f.rel}>
                    <span className={"file-ext ext-" + fileExt(f.name).slice(0, 4)}>{fileExt(f.name).toUpperCase().slice(0, 4) || "FILE"}</span>
                    <div className="file-info"><b title={f.name}>{f.name}</b><span>{f.id ? "消息 #" + f.id + " · " : ""}{bytes(f.size)}</span></div>
                    <div className="file-actions">
                      <button className="btn sm ghost" disabled={loading || searchPending} onClick={() => openExternal(f)}><ExternalLink size={12} /> 打开</button>
                      <button className="btn sm ghost" disabled={loading || searchPending} onClick={() => reveal(f)}><LocateFixed size={12} /> 定位</button>
                    </div>
                  </div>)}
                </div>
              </div>}
            </>
          )}
          <div className="media-pagination">
            <span aria-live="polite">{searchPending ? "正在搜索…" : loading ? "正在读取…" : displayed.total ? "第 " + ((displayed.page - 1) * displayed.pageSize + 1).toLocaleString() + "–" + ((displayed.page - 1) * displayed.pageSize + displayed.items.length).toLocaleString() + " 项，共 " + displayed.total.toLocaleString() + " 项" : "共 0 项"}</span>
            <nav aria-label="媒体分页">
              <button className="btn sm ghost" disabled={loading || searchPending || page <= 1} onClick={() => navigatePage(page - 1)}><ChevronLeft size={13} /> 上一页</button>
              {mediaPageNumbers(displayed.page, totalPages).map((number) => number < 0
                ? <span key={number} className="media-page-gap" aria-hidden="true">…</span>
                : <button key={number} className="btn sm ghost media-page-number" aria-label={`第 ${number} 页`}
                    aria-current={number === displayed.page ? "page" : undefined}
                    aria-disabled={loading || searchPending || undefined}
                    onClick={() => navigatePage(number)}>{number}</button>)}
              <button className="btn sm ghost" disabled={loading || searchPending || page >= totalPages} onClick={() => navigatePage(page + 1)}>下一页 <ChevronRight size={13} /></button>
            </nav>
          </div>
        </div>
      )}

      {viewer && viewerIndex >= 0 && <MediaViewer
        chat={chat} items={viewerItems} index={viewerIndex} onIndex={setViewerIndex}
        onStep={(direction, auto) => void stepViewer(direction, auto)}
        hasPrevious={viewerIndex > 0 || viewer.page.page > 1}
        hasNext={viewerIndex < viewerItems.length - 1 || viewer.page.page * viewer.page.pageSize < viewer.page.total}
        position={(viewer.page.page - 1) * viewer.page.pageSize + rawViewerIndex + 1} total={viewer.page.total}
        positions={viewer.page.items.flatMap((item, i) => item.kind === "image" || item.kind === "video" ? [(viewer.page.page - 1) * viewer.page.pageSize + i + 1] : [])}
        positionLabel={filter === "all" ? "全部文件中的位置" : "筛选结果中的位置"}
        libraryKey={libraryKey} version={viewer.page.version} performanceMode={performanceMode} libraryKind={libraryKind}
        limiter={limiter} loading={viewerBusy} error={viewerError}
        onClose={() => { cancelViewerRequest(); setViewer(null); }}
        onReveal={reveal} onOpen={openExternal} prefs={ctx.prefs} pageBackdrop={viewer.pageBackdrop}
      />}
      {audioItem && <AudioViewer chat={chat} item={audioItem.item} libraryKey={libraryKey} version={audioItem.version}
        onClose={() => setAudioItem(null)} onReveal={reveal} />}
    </section>
  );
}

interface VideoApi {
  toggle(): void;
  seekBy(seconds: number): void;
  getRate(): number;
  setRate(rate: number): void;
  beginBoost(rate: number): void;
  endBoost(): void;
  getVolume(): number;
  setVolume(percent: number): void;
  adjustVolume(delta: number): void;
  toggleMute(): void;
  setZoom(zoom: number, offset: { x: number; y: number }, smooth?: boolean): void;
}

const PLAY_RATES = [0.5, 1, 1.25, 1.5, 2];

const ArtVideo = forwardRef<VideoApi, {
  src: string;
  poster?: string;
  maxVolume: number;
  frameAspect: string;
  knownRatio: number;
  hasNext: boolean;
  autoNext: boolean;
  onNext: () => void;
  onAutoNext: () => void;
  fullscreen: boolean;
  onFullscreen: () => void;
}>(function ArtVideo({ src, poster, maxVolume, frameAspect, knownRatio, hasNext, autoNext, onNext, onAutoNext, fullscreen, onFullscreen }, ref) {
  const wrap = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const fitRef = useRef<() => void>(() => undefined);
  const posterRatio = useRef(0);
  const playerRef = useRef<Artplayer | null>(null);
  const autoNextRef = useRef(autoNext);
  const onNextRef = useRef(onNext);
  const onAutoNextRef = useRef(onAutoNext);
  const fullscreenButtonRef = useRef<HTMLButtonElement | null>(null);
  const onFullscreenRef = useRef(onFullscreen);
  onFullscreenRef.current = onFullscreen;
  autoNextRef.current = autoNext;
  onNextRef.current = onNext;
  onAutoNextRef.current = onAutoNext;
  const [switching, setSwitching] = useState(false);
  const switchTimer = useRef(0);
  const frameAspectRef = useRef(frameAspect);
  const knownRatioRef = useRef(knownRatio);
  const hasNextRef = useRef(hasNext);
  frameAspectRef.current = frameAspect;
  knownRatioRef.current = knownRatio;
  hasNextRef.current = hasNext;
  const switchSourceRef = useRef<((nextSrc: string, nextPoster: string) => void) | null>(null);
  const loadedSrc = useRef(src);
  const nextButtonRef = useRef<HTMLElement | null>(null);
  const rateRef = useRef(1);
  const resumeRate = useRef(1);
  const boostRef = useRef(false);
  const volumeRef = useRef(80);
  const suppressVolume = useRef(false);
  const audioCtx = useRef<AudioContext | null>(null);
  const gainNode = useRef<GainNode | null>(null);
  const [ready, setReady] = useState(false);
  const [framed, setFramed] = useState(knownRatio > 0 || frameAspect === "16:9" || frameAspect === "4:3");
  const [fit, setFit] = useState<"" | "compact" | "tiny">("");
  const [showBusy, setShowBusy] = useState(false);
  const [loadPercent, setLoadPercent] = useState(0);

  useEffect(() => {
    if (ready) {
      setShowBusy(false);
      return;
    }
    setShowBusy(false);
    const timer = window.setTimeout(() => setShowBusy(true), 600);
    return () => window.clearTimeout(timer);
  }, [ready, src]);

  const showNotice = (text: string) => {
    if (playerRef.current) playerRef.current.notice.show = text;
  };

  const updateRateLabel = (value: number) => {
    const label = box.current?.querySelector<HTMLElement>(".tak-rate-label");
    if (label) label.textContent = `${value.toFixed(2)}×`;
  };

  useEffect(() => {
    if (!poster) {
      posterRatio.current = 0;
      return;
    }
    let alive = true;
    const img = new Image();
    const remember = () => {
      if (!alive || !img.naturalWidth || !img.naturalHeight) return;
      posterRatio.current = img.naturalWidth / img.naturalHeight;
      fitRef.current();
    };
    img.onload = remember;
    img.src = poster;
    if (img.complete) remember();
    return () => { alive = false; };
  }, [poster]);

  const ensureAudio = (player: Artplayer) => {
    if (audioCtx.current) {
      if (audioCtx.current.state === "suspended") void audioCtx.current.resume();
      return true;
    }
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      const source = ctx.createMediaElementSource(player.video);
      const gain = ctx.createGain();
      source.connect(gain).connect(ctx.destination);
      audioCtx.current = ctx;
      gainNode.current = gain;
      void ctx.resume();
      return true;
    } catch {
      return false;
    }
  };

  const syncPreciseRange = (player: Artplayer, rate: number) => {
    const item = player.setting.find("tak-precise-speed");
    if (!item) return;
    if (item.$range) item.$range.value = String(rate);
    item.tooltip = `${rate.toFixed(2)}×`;
  };

  useImperativeHandle(ref, () => ({
    toggle() {
      const p = playerRef.current;
      if (p) p.playing ? p.pause() : p.play();
    },
    seekBy(seconds) {
      const p = playerRef.current;
      if (!p) return;
      p.currentTime = Math.max(0, Math.min(p.duration || Infinity, p.currentTime + seconds));
      showNotice(`${seconds > 0 ? "+" : ""}${seconds} 秒`);
    },
    getRate: () => rateRef.current,
    setRate(rate) {
      const p = playerRef.current;
      if (!p) return;
      const next = Math.max(0.1, Math.min(10, Math.round(rate * 100) / 100));
      rateRef.current = next;
      boostRef.current = false;
      p.playbackRate = next;
      syncPreciseRange(p, next);
      updateRateLabel(next);
      p.notice.show = `${next.toFixed(2)}×`;
    },
    beginBoost(rate) {
      const p = playerRef.current;
      if (!p) return;
      resumeRate.current = rateRef.current;
      boostRef.current = true;
      p.playbackRate = Math.max(0.1, Math.min(10, rate));
      updateRateLabel(p.playbackRate);
      showNotice(`${rate.toFixed(1)}× 长按倍速`);
    },
    endBoost() {
      const p = playerRef.current;
      if (!p) return;
      boostRef.current = false;
      p.playbackRate = resumeRate.current;
      syncPreciseRange(p, resumeRate.current);
      updateRateLabel(resumeRate.current);
      showNotice(`${resumeRate.current.toFixed(2)}×`);
    },
    getVolume: () => volumeRef.current,
    setVolume(percent) {
      const p = playerRef.current;
      if (!p) return;
      const next = Math.max(0, Math.min(maxVolume, Math.round(percent)));
      volumeRef.current = next;
      suppressVolume.current = true;
      p.video.volume = Math.min(1, next / 100);
      p.video.muted = next === 0;
      queueMicrotask(() => { suppressVolume.current = false; });
      if (next > 100) {
        if (ensureAudio(p) && gainNode.current) gainNode.current.gain.value = next / 100;
      } else if (gainNode.current) {
        gainNode.current.gain.value = 1;
      }
      showNotice(`音量 ${next}%`);
    },
    adjustVolume(delta) {
      this.setVolume(volumeRef.current + delta);
    },
    toggleMute() {
      const p = playerRef.current;
      if (!p) return;
      p.video.muted = !p.video.muted;
      showNotice(p.video.muted ? "静音" : `音量 ${volumeRef.current}%`);
    },
    setZoom(zoom, offset, smooth = true) {
      const el = wrap.current;
      if (!el) return;
      el.style.transition = smooth ? "transform .08s linear" : "none";
      el.style.transform = zoom > 1 ? `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` : "";
    },
  }), [maxVolume]);

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    if (loadedSrc.current === src) {
      if ((poster || "") !== (player.poster || "")) player.poster = poster || "";
      return;
    }
    loadedSrc.current = src;
    switchSourceRef.current?.(src, poster || "");
  }, [src, poster]);

  useEffect(() => {
    if (nextButtonRef.current) nextButtonRef.current.style.display = hasNext ? "" : "none";
  }, [hasNext]);

  useLayoutEffect(() => {
    if (!box.current) return;
    setReady(false);
    Artplayer.PLAYBACK_RATE = PLAY_RATES;
    const player = new Artplayer({
      container: box.current,
      url: src,
      poster: poster || "",
      volume: 0.8,
      autoplay: true,
      pip: false,
      setting: true,
      playbackRate: false,
      aspectRatio: true,
      screenshot: false,
      fullscreen: false,
      fullscreenWeb: false,
      hotkey: false,
      miniProgressBar: true,
      autoSize: false,
      theme: "#2f6bff",
      lang: "zh-cn",
      moreVideoAttr: { playsInline: true, preload: "auto" } as never,
    });
    playerRef.current = player;
    const playerBox = box.current;
    playerBox.classList.remove("controls-awake");
    wrap.current?.classList.remove("controls-awake");
    let hideTimer = 0;
    let pointerInside = false;
    const hideControls = () => {
      player.controls.show = false;
      wrap.current?.classList.remove("controls-awake");
    };
    const scheduleHide = () => {
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => {
        if (!playerRef.current) return;
        if (player.setting.show) {
          scheduleHide();
          return;
        }
        if (player.video.paused) return;
        if (!pointerInside) hideControls();
      }, 2400);
    };
    const wakeControls = () => {
      player.controls.show = true;
      wrap.current?.classList.add("controls-awake");
      if (player.playing) scheduleHide();
    };
    const onPointerMove = () => {
      pointerInside = true;
      wakeControls();
    };
    const onPointerDown = () => {
      pointerInside = true;
      wakeControls();
    };
    const onPointerEnter = () => { pointerInside = true; };
    const onPointerLeave = () => {
      pointerInside = false;
      window.clearTimeout(hideTimer);
      hideControls();
    };
    playerBox.addEventListener("pointermove", onPointerMove);
    playerBox.addEventListener("pointerdown", onPointerDown);
    playerBox.addEventListener("pointerenter", onPointerEnter);
    playerBox.addEventListener("pointerleave", onPointerLeave);
    player.on("video:play", hideControls);
    player.on("video:ended", () => {
      if (autoNextRef.current) onAutoNextRef.current();
    });
    player.setting.add({
      name: "tak-precise-speed",
      html: "精确倍速",
      icon: player.icons.playbackRate.outerHTML,
      tooltip: "1.00×",
      range: [1, 0.1, 10, 0.01],
      onChange(item) {
        const next = Number((item as unknown as { range: number[] }).range[0]);
        const value = Math.max(0.1, Math.min(10, Math.round(next * 100) / 100));
        rateRef.current = value;
        boostRef.current = false;
        this.playbackRate = value;
        updateRateLabel(value);
        return `${value.toFixed(2)}×`;
      },
    });
    player.setting.add({
      name: "tak-screenshot",
      html: "截图",
      icon: player.icons.screenshot.outerHTML,
      onClick() {
        void this.screenshot();
      },
    });
    player.setting.add({
      name: "tak-pip",
      html: "画中画",
      icon: player.icons.pip.outerHTML,
      onClick() {
        this.pip = !this.pip;
      },
    });
    const fitFrame = () => {
      const el = box.current;
      const stage = wrap.current?.parentElement;
      if (!el || !stage) return;
      const style = getComputedStyle(stage);
      const padX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
      const padY = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
      const availW = Math.max(160, stage.clientWidth - padX);
      const availH = Math.max(120, stage.clientHeight - padY);
      const vw = player.video.videoWidth;
      const vh = player.video.videoHeight;
      const aspect = frameAspectRef.current;
      const ratioKnown = knownRatioRef.current;
      let ratio = aspect === "16:9" ? 16 / 9
        : aspect === "4:3" ? 4 / 3
        : ratioKnown > 0 ? ratioKnown
        : vw > 0 && vh > 0 ? vw / vh
        : posterRatio.current || 16 / 9;
      if (!Number.isFinite(ratio) || ratio <= 0) ratio = 16 / 9;
      let w = availW;
      let h = w / ratio;
      if (h > availH) {
        h = availH;
        w = h * ratio;
      }
      const width = `${Math.max(1, Math.floor(w))}px`;
      const height = `${Math.max(1, Math.floor(h))}px`;
      el.style.width = width;
      el.style.height = height;
      if (wrap.current) {
        wrap.current.style.width = width;
        wrap.current.style.height = height;
      }
      setFit(w < 320 ? "tiny" : w < 430 ? "compact" : "");
    };
    fitRef.current = fitFrame;
    fitFrame();
    const onMeta = () => {
      fitFrame();
      setFramed(true);
    };
    const onData = () => fitFrame();
    let revealed = false;
    let revealFrame = 0;
    let revealFallback = 0;
    const finishReveal = () => {
      if (!revealed) return;
      window.clearTimeout(revealFallback);
      hideControls();
      window.requestAnimationFrame(() => {
        hideControls();
        setReady(true);
      });
      // ArtPlayer fades its center mask over 200ms after playback starts.
      // Keep the switch guard through that fade so the pause glyph can never
      // flash between "loaded" and the first visible frame.
      window.clearTimeout(switchTimer.current);
      switchTimer.current = window.setTimeout(() => setSwitching(false), 260);
    };
    const revealFirstFrame = () => {
      if (revealed) return;
      revealed = true;
      hideControls();
      if (playerRef.current) playerRef.current.mask.show = false;
      const video = player.video as HTMLVideoElement & {
        requestVideoFrameCallback?: (callback: () => void) => number;
        cancelVideoFrameCallback?: (handle: number) => void;
      };
      if (typeof video.requestVideoFrameCallback === "function") {
        revealFrame = video.requestVideoFrameCallback(() => finishReveal());
        revealFallback = window.setTimeout(finishReveal, 1600);
      } else {
        finishReveal();
      }
    };
    player.on("video:playing", revealFirstFrame);
    player.video.addEventListener("loadedmetadata", onMeta);
    player.video.addEventListener("loadeddata", onData);
    player.video.addEventListener("resize", fitFrame);
    if (player.video.readyState >= 1) onMeta();
    if (player.video.readyState >= 2) onData();
    if (!player.video.paused && player.video.readyState >= 2) revealFirstFrame();
    const resetReveal = () => {
      revealed = false;
      window.clearTimeout(revealFallback);
      revealFallback = 0;
      if (revealFrame) {
        const v = player.video as HTMLVideoElement & { cancelVideoFrameCallback?: (handle: number) => void };
        if (typeof v.cancelVideoFrameCallback === "function") v.cancelVideoFrameCallback(revealFrame);
        revealFrame = 0;
      }
    };
    const prepareSource = (nextSrc: string, nextPoster: string) => {
      resetReveal();
      // switchUrl briefly parks the element in a paused state; hide ArtPlayer's
      // center play/pause glyph until the new source actually starts playing.
      // This has to be React state: the wrap's className is rendered by React
      // and an imperatively added class is wiped by the next re-render.
      setSwitching(true);
      window.clearTimeout(switchTimer.current);
      switchTimer.current = window.setTimeout(() => setSwitching(false), 3000);
      setReady(false);
      setShowBusy(false);
      setLoadPercent(0);
      const aspect = frameAspectRef.current;
      setFramed(knownRatioRef.current > 0 || aspect === "16:9" || aspect === "4:3");
      hideControls();
      player.poster = nextPoster;
      fitFrame();
      // Reuse the same Artplayer/DOM/video element: switching a URL is much
      // faster than destroying and rebuilding the player between clips.
      void player.switchUrl(nextSrc).catch(() => undefined);
    };
    switchSourceRef.current = prepareSource;
    const stageEl = wrap.current?.parentElement;
    const observer = typeof ResizeObserver !== "undefined" && stageEl ? new ResizeObserver(fitFrame) : null;
    observer?.observe(stageEl as Element);
    window.addEventListener("resize", fitFrame);
    const icon = document.createElement("div");
    icon.className = "art-icon";
    icon.innerHTML = '<svg viewBox="0 0 22 22" width="22" height="22" fill="currentColor"><path d="M14.98 9.24 7.06 4.25A1.9 1.9 0 0 0 4.2 5.9v10.2a1.9 1.9 0 0 0 2.86 1.65l7.92-4.99a1.9 1.9 0 0 0 0-3.52z"/><rect x="15.6" y="4" width="2" height="14" rx="1"/></svg>';
    const nextButton = player.controls.add({
      name: "next",
      position: "left",
      index: 11,
      html: icon,
      click() {
        if (hasNextRef.current) onNextRef.current();
      },
    });
    nextButtonRef.current = nextButton || null;
    if (nextButton) nextButton.style.display = hasNextRef.current ? "" : "none";
    const rateLabel = document.createElement("span");
    rateLabel.className = "tak-rate-label";
    rateLabel.textContent = "1.00×";
    player.controls.add({
      name: "rate",
      position: "right",
      html: rateLabel,
      selector: PLAY_RATES.map((v) => ({ html: `${v.toFixed(2)}×`, value: String(v), default: v === 1 })),
      onSelect(selector) {
        const value = Number(selector.value);
        rateRef.current = value;
        boostRef.current = false;
        player.playbackRate = value;
        syncPreciseRange(player, value);
        return `<span class="tak-rate-label">${value.toFixed(2)}×</span>`;
      },
    });
    const volumeControl = player.template.$controlsLeft.querySelector(".art-control-volume");
    const settingControl = player.template.$controlsRight.querySelector(".art-control-setting");
    if (volumeControl && volumeControl.parentElement !== player.template.$controlsRight) {
      player.template.$controlsRight.insertBefore(volumeControl, settingControl);
    }
    const fullscreenButton = document.createElement("button");
    fullscreenButton.type = "button";
    fullscreenButton.className = "tak-player-fullscreen";
    fullscreenButton.onclick = (event) => {
      event.stopPropagation();
      onFullscreenRef.current();
    };
    fullscreenButtonRef.current = fullscreenButton;
    player.controls.add({ name: "fullscreen", position: "right", index: 100, html: fullscreenButton });
    const timeAbove = document.createElement("div");
    timeAbove.className = "tak-time-above";
    const clock = (value: number) => {
      const total = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
      const hour = Math.floor(total / 3600);
      const minute = Math.floor((total % 3600) / 60);
      const second = total % 60;
      const tail = `${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
      return hour > 0 ? `${hour}:${tail}` : tail;
    };
    const syncTimeAbove = () => {
      timeAbove.textContent = `${clock(player.video.currentTime)} / ${clock(player.video.duration)}`;
    };
    const progressEl = player.template.$bottom.querySelector(".art-progress");
    progressEl?.appendChild(timeAbove);
    syncTimeAbove();
    player.video.addEventListener("timeupdate", syncTimeAbove);
    player.video.addEventListener("durationchange", syncTimeAbove);
    player.video.addEventListener("seeked", syncTimeAbove);
    const updateLoadPercent = () => {
      const video = player.video;
      if (!video.duration || !Number.isFinite(video.duration) || video.buffered.length === 0) {
        setLoadPercent(0);
        return;
      }
      const end = video.buffered.end(video.buffered.length - 1);
      setLoadPercent(Math.max(0, Math.min(99, Math.round((end / video.duration) * 100))));
    };
    player.video.addEventListener("progress", updateLoadPercent);
    player.video.addEventListener("loadedmetadata", updateLoadPercent);
    player.video.addEventListener("durationchange", updateLoadPercent);
    player.video.addEventListener("canplay", updateLoadPercent);
    updateLoadPercent();
    player.on("video:ratechange", () => {
      if (!boostRef.current) rateRef.current = player.playbackRate;
      syncPreciseRange(player, player.playbackRate);
      updateRateLabel(player.playbackRate);
    });
    player.on("video:volumechange", () => {
      if (suppressVolume.current) return;
      volumeRef.current = player.video.muted ? 0 : Math.round(player.video.volume * 100);
      if (gainNode.current) gainNode.current.gain.value = 1;
    });

    return () => {
      observer?.disconnect();
      fitRef.current = () => undefined;
      player.video.removeEventListener("loadedmetadata", onMeta);
      player.video.removeEventListener("loadeddata", onData);
      player.video.removeEventListener("resize", fitFrame);
      player.video.removeEventListener("timeupdate", syncTimeAbove);
      player.video.removeEventListener("durationchange", syncTimeAbove);
      player.video.removeEventListener("seeked", syncTimeAbove);
      player.video.removeEventListener("progress", updateLoadPercent);
      player.video.removeEventListener("loadedmetadata", updateLoadPercent);
      player.video.removeEventListener("durationchange", updateLoadPercent);
      player.video.removeEventListener("canplay", updateLoadPercent);
      window.clearTimeout(hideTimer);
      window.clearTimeout(revealFallback);
      const frameVideo = player.video as HTMLVideoElement & { cancelVideoFrameCallback?: (handle: number) => void };
      if (revealFrame && typeof frameVideo.cancelVideoFrameCallback === "function") {
        frameVideo.cancelVideoFrameCallback(revealFrame);
      }
      playerBox.removeEventListener("pointermove", onPointerMove);
      playerBox.removeEventListener("pointerdown", onPointerDown);
      playerBox.removeEventListener("pointerenter", onPointerEnter);
      playerBox.removeEventListener("pointerleave", onPointerLeave);
      window.removeEventListener("resize", fitFrame);
      if (audioCtx.current) {
        void audioCtx.current.close();
        audioCtx.current = null;
        gainNode.current = null;
      }
      window.clearTimeout(switchTimer.current);
      player.destroy(false);
      playerRef.current = null;
      fullscreenButtonRef.current = null;
      switchSourceRef.current = null;
      nextButtonRef.current = null;
    };
  }, []);

  useEffect(() => {
    const button = fullscreenButtonRef.current;
    const player = playerRef.current;
    if (!button || !player) return;
    button.title = fullscreen ? "退出全屏" : "全屏";
    button.setAttribute("aria-label", button.title);
    button.replaceChildren((fullscreen ? player.icons.fullscreenOff : player.icons.fullscreenOn).cloneNode(true));
  }, [fullscreen]);

  return (
    <>
      <div ref={wrap} className={`art-video-wrap ${switching ? "is-switching" : ""} ${ready ? "is-ready" : "is-loading"} ${framed ? "" : "is-pre-meta"}`}>
        <div ref={box} className={`art-player ${fit}`} />
        {framed && !ready && (
          <div className={`art-video-loading ${frameAspect === "original" ? "" : "fixed"}`} aria-live="polite">
            {poster ? <img src={poster} alt="" /> : <div className="art-video-loading-shade" />}
            {showBusy && (
              <div className="media-busy" role="status">
                <span className="load-spinner" />
                {loadPercent > 0 && loadPercent < 100 && <span className="load-percent">{loadPercent}%</span>}
              </div>
            )}
          </div>
        )}
      </div>
      {!framed && showBusy && (
        <div className="art-video-pending" role="status">
          <span className="load-spinner" />
          {loadPercent > 0 && loadPercent < 100 && <span className="load-percent">{loadPercent}%</span>}
        </div>
      )}
    </>
  );
});

type ViewerRect = { left: number; top: number; width: number; height: number };
type FsGhost = { src: string; from: ViewerRect; to: ViewerRect; radius: number; handoff?: boolean };
type LoadingSurface = "poster" | "spinner";

function isViewerMediaTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(".art-video-wrap, .art-video-pending, .image-stage img") !== null;
}

function loadingVideoBox(modal: HTMLElement | null): { rect: ViewerRect; surface: LoadingSurface } | undefined {
  const poster = modal?.querySelector(".art-video-loading");
  const el = poster || modal?.querySelector(".art-video-pending");
  const rect = el?.getBoundingClientRect();
  if (!rect || rect.width < 8 || rect.height < 8) return;
  return { rect, surface: poster ? "poster" : "spinner" };
}

function mediaBox(modal: HTMLElement | null, isVideo: boolean): ViewerRect | null {
  const video = isVideo ? modal?.querySelector<HTMLVideoElement>(".art-video-wrap.is-ready video") : null;
  const el = isVideo
    ? video || modal?.querySelector<HTMLElement>(".art-video-wrap")
    : modal?.querySelector<HTMLElement>(".image-stage img");
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 8 || r.height < 8) return null;
  // The player frame can include letterboxing. Match the pixels shown in the
  // video, so the native image doesn't overshoot the web frame during handoff.
  if (video?.videoWidth && video.videoHeight && getComputedStyle(video).objectFit === "contain") {
    const fit = Math.min(r.width / video.videoWidth, r.height / video.videoHeight);
    const width = video.videoWidth * fit;
    const height = video.videoHeight * fit;
    return { left: r.left + (r.width - width) / 2, top: r.top + (r.height - height) / 2, width, height };
  }
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

function viewerFrameSource(modal: HTMLElement | null, isVideo: boolean, src: string, poster: string): string {
  const expected = new URL(src, document.baseURI).href;
  if (isVideo) {
    const video = modal?.querySelector<HTMLVideoElement>(".art-video-wrap.is-ready video");
    if (video && video.currentSrc === expected && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
      try {
        const scale = Math.min(1, 960 / video.videoWidth);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          return canvas.toDataURL("image/jpeg", 0.78);
        }
      } catch {
        /* poster is the fallback */
      }
    }
    return poster;
  }
  const img = modal?.querySelector<HTMLImageElement>(".image-stage img");
  if (!img || img.currentSrc !== expected) return src;
  // Sending the original file as a data URL can mean tens of megabytes over
  // the RPC bridge; a 1920px JPEG is indistinguishable during the scale.
  const nw = img.naturalWidth || img.width;
  const nh = img.naturalHeight || img.height;
  if (!nw || !nh) return img.currentSrc || img.src || "";
  try {
    const scale = Math.min(1, 1920 / Math.max(nw, nh));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(nw * scale));
    canvas.height = Math.max(1, Math.round(nh * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return img.currentSrc || img.src || "";
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.84);
  } catch {
    return img.currentSrc || img.src || "";
  }
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

const fullscreenZoomMs = 180;
const fullscreenFadeMs = 100;

function fitViewerRect(ratio: number): ViewerRect {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const safe = 0.94;
  let width = vw * safe;
  let height = width / (ratio || 16 / 9);
  if (height > vh * safe) {
    height = vh * safe;
    width = height * (ratio || 16 / 9);
  }
  return { left: (vw - width) / 2, top: (vh - height) / 2, width, height };
}

function MediaViewer({
  chat,
  items,
  index,
  onIndex,
  onStep,
  hasPrevious,
  hasNext,
  position,
  positions,
  total,
  positionLabel,
  libraryKey,
  version,
  performanceMode,
  libraryKind,
  limiter,
  loading,
  error,
  onClose,
  onReveal,
  onOpen,
  prefs,
  pageBackdrop,
}: {
  chat: ChatRow;
  items: MediaItem[];
  index: number;
  onIndex: (n: number) => void;
  onStep: (direction: -1 | 1, auto?: boolean) => void;
  hasPrevious: boolean;
  hasNext: boolean;
  position: number;
  positions: number[];
  total: number;
  positionLabel: string;
  libraryKey: string;
  version: string;
  performanceMode: boolean;
  libraryKind: "local" | "remote" | "unknown";
  limiter: ImageLimiter;
  loading: boolean;
  error: string;
  onClose: () => void;
  onReveal: (item: MediaItem) => void;
  onOpen: (item: MediaItem) => void;
  prefs: ViewerPrefs;
  pageBackdrop: string;
}) {
  const item = items[index];
  const isVideo = item.kind === "video";
  const src = mediaURL(chat.slug, item.rel, libraryKey, version);
  const poster = item.thumb ? thumbURL(chat.slug, item.thumb, libraryKey, version) : "";
  const knownRatio = item.width && item.height ? item.width / item.height : 0;
  const ambient = item.thumb ? thumbURL(chat.slug, item.thumb, libraryKey, version) : isVideo ? poster : src;
  const modal = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const active = useRef<HTMLButtonElement>(null);
  const api = useRef<VideoApi | null>(null);
  const hold = useRef<{ key: string; timer: number; long: boolean; direction: number } | null>(null);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const dragMoved = useRef(false);
  const stagePress = useRef<{ onMedia: boolean; dragged: boolean } | null>(null);
  const wheelAccum = useRef(0);
  const imageZoomedAt = useRef(0);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [imageBox, setImageBox] = useState<{ w: number; h: number } | null>(null);
  const [imageReady, setImageReady] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  const [tone, setTone] = useState("hsl(221 24% 14%)");
  const [pageFrame, setPageFrame] = useState<HTMLImageElement>();
  const [mediaFrame, setMediaFrame] = useState<{ src: string; image: HTMLImageElement }>();
  const [transitionBackdrop, setTransitionBackdrop] = useState<string | null>(null);
  const backdrop = useMemo(() => viewerBackdrop(prefs.backdrop, tone, pageFrame, mediaFrame?.src === ambient ? mediaFrame.image : undefined), [prefs.backdrop, tone, pageFrame, mediaFrame, ambient]);
  const backdropImage = transitionBackdrop ?? backdrop;
  const backdropStyle = backdropImage ? { backgroundImage: `url("${backdropImage}")` } : undefined;
  const [immersive, setImmersive] = useState(false);
  const immersiveRef = useRef(false);
  immersiveRef.current = immersive;
  const [windowFs, setWindowFs] = useState(false);
  const windowFsRef = useRef(false);
  const fsBusy = useRef(false);
  const pendingAutoNext = useRef(false);
  const [fsGhost, setFsGhost] = useState<FsGhost | null>(null);
  const [fsShowGhost, setFsShowGhost] = useState(false);
  const [fsGhostLive, setFsGhostLive] = useState(false);
  const [fsFade, setFsFade] = useState(false);
  const fsReturn = useRef<{ windowX: number; windowY: number; screenX: number; screenY: number; rect: ViewerRect | null; rel: string; loadingSurface?: LoadingSurface } | null>(null);

  useEffect(() => {
    setImageReady(false);
    setImageBusy(false);
    if (isVideo) return;
    const timer = window.setTimeout(() => setImageBusy(true), 350);
    return () => window.clearTimeout(timer);
  }, [item.rel, isVideo]);

  useEffect(() => {
    if (isVideo) {
      setImageBox(null);
      return;
    }
    const stageEl = stage.current;
    if (!stageEl) return;
    const fit = () => {
      const imgEl = stageEl.querySelector<HTMLImageElement>("img");
      const nw = imgEl?.naturalWidth || 0;
      const nh = imgEl?.naturalHeight || 0;
      if (!nw || !nh) return;
      const r = stageEl.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return;
      const scale = Math.min((r.width * 0.94) / nw, (r.height * 0.94) / nh);
      setImageBox({ w: Math.max(1, Math.round(nw * scale)), h: Math.max(1, Math.round(nh * scale)) });
    };
    fit();
    const imgEl = stageEl.querySelector<HTMLImageElement>("img");
    imgEl?.addEventListener("load", fit);
    const observer = new ResizeObserver(fit);
    observer.observe(stageEl);
    return () => {
      imgEl?.removeEventListener("load", fit);
      observer.disconnect();
    };
  }, [isVideo, item.rel]);

  useEffect(() => {
    if (imageReady) setImageBusy(false);
  }, [imageReady]);
  const step = (direction: -1 | 1, auto?: boolean) => {
    if (fsBusy.current) {
      if (auto && direction === 1) pendingAutoNext.current = true;
      return;
    }
    onStep(direction, auto);
  };
  const stateRef = useRef({ onStep: step, onClose, prefs, kind: item.kind });
  stateRef.current = { onStep: step, onClose, prefs, kind: item.kind };

  useEffect(() => {
    if (!pageBackdrop) return;
    let alive = true;
    void loadBackdropImage(pageBackdrop).then((image) => { if (alive) setPageFrame(image); }).catch(() => undefined);
    return () => { alive = false; };
  }, [pageBackdrop]);

  useEffect(() => {
    if (prefs.backdrop !== "ambient" || !ambient) return;
    let alive = true;
    void loadBackdropImage(ambient).then((image) => { if (alive) setMediaFrame({ src: ambient, image }); }).catch(() => undefined);
    return () => { alive = false; };
  }, [ambient, prefs.backdrop]);

  useEffect(() => {
    if (prefs.backdrop !== "solid") return;
    let alive = true;
    void coverTone(ambient).then((value) => {
      if (alive) setTone(value);
    });
    return () => { alive = false; };
  }, [ambient, prefs.backdrop]);

  useEffect(() => {
    if (performanceMode) return;
    const controller = new AbortController();
    const next = items[index + 1];
    const prev = items[index - 1];
    const warm = async (target: MediaItem, limit: number, complete: boolean) => {
      // A local partial read skips remuxing and may serve different bytes.
      // Other prefetches use the playback URL so the browser can reuse them.
      const skipRemux = libraryKind === "local" && !complete;
      const res = await fetch(mediaURL(chat.slug, target.rel, libraryKey, version, skipRemux), {
        headers: complete ? undefined : { Range: `bytes=0-${limit - 1}` },
        signal: controller.signal, cache: "force-cache",
      });
      // A remote server may ignore Range; never consume an unbounded response.
      if (!res.ok || (!complete && res.status !== 206)) { await res.body?.cancel(); return; }
      const length = Number(res.headers.get("Content-Length"));
      if (length > limit) { await res.body?.cancel(); return; }
      const reader = res.body?.getReader();
      if (!reader) return;
      let received = 0;
      try {
        while (received < limit) {
          const chunk = await reader.read();
          if (chunk.done) return;
          received += chunk.value.byteLength;
        }
        // Observe the end of a correctly sized response so the browser can cache it.
        if (received === limit && length === limit) await reader.read();
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    };
    if (next?.kind === "video") {
      const complete = libraryKind === "local" && item.kind === "video" && next.size > 0 && next.size <= 64 * 1024 * 1024;
      void warm(next, complete ? next.size : 4 * 1024 * 1024, complete).catch(() => undefined);
    }
    if (prev?.kind === "video") void warm(prev, 2 * 1024 * 1024, false).catch(() => undefined);
    return () => controller.abort();
  }, [chat.slug, libraryKey, version, libraryKind, performanceMode, items, index, item.kind]);

  useEffect(() => {
    const bar = strip.current;
    const button = active.current;
    if (bar && button) {
      bar.scrollTo({ left: button.offsetLeft - (bar.clientWidth - button.offsetWidth) / 2, behavior: "smooth" });
    }
  }, [item.rel]);

  useEffect(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    setDragging(false);
    setShowKeys(false);
    stagePress.current = null;
    wheelAccum.current = 0;
    imageZoomedAt.current = 0;
    if (hold.current) {
      window.clearTimeout(hold.current.timer);
      hold.current = null;
    }
    api.current?.endBoost();
  }, [item.rel]);

  const resetZoom = () => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  };

  const imageTargetRect = (): ViewerRect | null => {
    const stageEl = stage.current;
    const imgEl = modal.current?.querySelector<HTMLImageElement>(".image-stage img");
    const nw = imgEl?.naturalWidth || 0;
    const nh = imgEl?.naturalHeight || 0;
    if (!stageEl || !nw || !nh) return null;
    const r = stageEl.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return null;
    const scale = Math.min((r.width * 0.94) / nw, (r.height * 0.94) / nh);
    const width = nw * scale;
    const height = nh * scale;
    return { left: r.left + (r.width - width) / 2, top: r.top + (r.height - height) / 2, width, height };
  };

  const applyWindowFullscreen = async (on: boolean, cover = "") => {
    try {
      await call("setWindowFullscreen", { fullscreen: on, cover });
    } catch {
      /* layout still settles; the cover is removed by the caller */
    }
  };

  const hideFullscreenCover = async (fade = 0) => {
    try {
      await call("hideFullscreenCover", { fade });
    } catch {
      /* the cover window lives in the same process and disappears with it */
    }
  };

  const stageFullscreenHandoff = (snapshot: string, rect: ViewerRect | null, radius: number) => {
    if (!rect) return false;
    setFsGhost({ src: snapshot, from: rect, to: rect, radius, handoff: true });
    setFsShowGhost(true);
    return true;
  };

  const finishNativeHandoff = async (staged: boolean, nativeFade: number) => {
    if (staged) {
      // Make sure WebView2 has painted the same still before withdrawing the
      // native cover; a ready video can temporarily lose its surface on resize.
      await nextPaint();
      const still = modal.current?.querySelector<HTMLImageElement>(".viewer-fs-cover.handoff .viewer-fs-ghost");
      if (still && !still.complete) {
        await Promise.race([still.decode().catch(() => undefined), new Promise<void>((resolve) => window.setTimeout(resolve, 80))]);
        await nextPaint();
      }
    }
    await hideFullscreenCover(staged ? nativeFade : fullscreenFadeMs);
    if (staged) {
      await nextPaint();
      setFsFade(true);
      await nextPaint();
      await new Promise<void>((resolve) => window.setTimeout(resolve, fullscreenFadeMs));
    }
    setFsGhost(null);
    setFsShowGhost(false);
    setFsGhostLive(false);
    setFsFade(false);
    finishFullscreenTransition();
  };

  const finishFullscreenTransition = () => {
    setTransitionBackdrop(null);
    fsBusy.current = false;
    if (pendingAutoNext.current) {
      pendingAutoNext.current = false;
      stateRef.current.onStep(1, true);
    }
  };

  const resizeWhileVideoLoads = async (enter: boolean, hideChrome: boolean) => {
    if (enter && fsReturn.current) fsReturn.current.rect = null;
    windowFsRef.current = enter;
    await applyWindowFullscreen(enter);
    setWindowFs(enter);
    if (hideChrome) setImmersive(enter);
    await nextPaint();
    if (enter && fsReturn.current) {
      fsReturn.current.screenX = window.screenX;
      fsReturn.current.screenY = window.screenY;
    }
    finishFullscreenTransition();
  };

  const transitionFullscreen = async (enter: boolean, hideChrome = false) => {
    if (fsBusy.current || loading || enter === windowFsRef.current) return;
    fsBusy.current = true;
    setTransitionBackdrop(backdrop);
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    api.current?.setZoom(1, { x: 0, y: 0 }, false);
    const imageEl = modal.current?.querySelector<HTMLImageElement>(".image-stage img");
    if (imageEl) imageEl.style.transform = "";
    const modalEl = modal.current;
    let measured = mediaBox(modalEl, isVideo);
    let snapshot = viewerFrameSource(modalEl, isVideo, src, poster);
    let waitingForVideo = isVideo && !snapshot.startsWith("data:image/");
    let loadingSurface: LoadingSurface | undefined;
    if (waitingForVideo) {
      // Animate only what the player is displaying. The header and playlist
      // must stay out of the native bitmap so they are never resized as pixels.
      await nextPaint();
      const loading = loadingVideoBox(modal.current);
      snapshot = "";
      measured = loading?.rect ?? null;
      loadingSurface = loading?.surface;
      if (loading) {
        const viewport = { width: window.innerWidth, height: window.innerHeight };
        try {
          const windowImage = await call<string>("captureViewerBackdrop", undefined, AbortSignal.timeout(200));
          const firstFrame = viewerFrameSource(modal.current, true, src, poster);
          if (firstFrame.startsWith("data:image/")) {
            snapshot = firstFrame;
            measured = mediaBox(modal.current, true);
            waitingForVideo = false;
            loadingSurface = undefined;
          } else if (windowImage && loadingVideoBox(modal.current)?.surface === loading.surface) {
            snapshot = await cropViewerImage(windowImage, loading.rect, viewport);
          }
        } catch {
          // Switching fullscreen is still possible without an animated still.
        }
      }
    }
    const ratio = measured ? measured.width / measured.height : 16 / 9;
    const radius = loadingSurface === "spinner" ? 6 : isVideo ? 10 : 12;
    const full = { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    const screenRect = (rect: ViewerRect | null | undefined): number[] | null =>
      rect ? [Math.round(window.screenX + rect.left), Math.round(window.screenY + rect.top), Math.round(rect.width), Math.round(rect.height)] : null;
    const targetMediaBox = () => {
      if (loadingSurface) {
        const current = loadingVideoBox(modal.current);
        if (current?.surface === loadingSurface) return current.rect;
        if (loadingSurface === "spinner" && measured) {
          const area = modal.current?.querySelector(".viewer-stage")?.getBoundingClientRect();
          if (!area) return null;
          // Metadata can arrive mid-transition. Keep a spinner-sized still
          // centered in the new stage instead of stretching it into a poster.
          return { ...measured, left: area.left + (area.width - measured.width) / 2, top: area.top + (area.height - measured.height) / 2 };
        }
      }
      return (isVideo ? null : imageTargetRect()) || mediaBox(modal.current, isVideo);
    };

    if (enter) {
      fsReturn.current = {
        windowX: window.screenX,
        windowY: window.screenY,
        screenX: window.screenX,
        screenY: window.screenY,
        rect: measured,
        rel: item.rel,
        loadingSurface,
      };
    }
    if (waitingForVideo && !snapshot) {
      await resizeWhileVideoLoads(enter, hideChrome);
      return;
    }
    if (enter) {
      windowFsRef.current = true;
      const startScreen = screenRect(measured);
      let native = false;
      if (backdrop && snapshot && startScreen) {
        try {
          const res = await call<{ shown: boolean }>("showFullscreenCover", {
            cover: backdrop, sharp: snapshot, from: startScreen, to: startScreen, radius, duration: 0,
          });
          native = Boolean(res?.shown);
        } catch {
          native = false;
        }
      }
      if (native && startScreen) {
        await applyWindowFullscreen(true, "");
        await nextPaint();
        if (fsReturn.current) {
          fsReturn.current.screenX = window.screenX;
          fsReturn.current.screenY = window.screenY;
        }
        setWindowFs(true);
        if (hideChrome) setImmersive(true);
        await nextPaint();
        const target = targetMediaBox() || fitViewerRect(ratio);
        const endScreen = screenRect(target) || startScreen;
        try {
          await call("animateFullscreenCover", { from: startScreen, to: endScreen, radius, duration: fullscreenZoomMs });
        } catch {
          /* the static frame still covers the resize */
        }
        const staged = stageFullscreenHandoff(snapshot, target, radius);
        await new Promise<void>((resolve) => window.setTimeout(resolve, fullscreenZoomMs + 8));
        await finishNativeHandoff(staged, 0);
        return;
      }
      if (waitingForVideo) {
        await resizeWhileVideoLoads(true, hideChrome);
        return;
      }
      // Fallback: the same backdrop under a page-owned scaling image.
      setFsGhost({ src: snapshot, from: measured || full, to: measured || full, radius });
      setFsShowGhost(false);
      setFsGhostLive(false);
      setFsFade(false);
      await nextPaint();
      const nativeCover = backdrop;
      const resizeAt = performance.now();
      await applyWindowFullscreen(true, nativeCover);
      await nextPaint();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
      if (fsReturn.current) {
        fsReturn.current.screenX = window.screenX;
        fsReturn.current.screenY = window.screenY;
      }
      setWindowFs(true);
      if (hideChrome) setImmersive(true);
      await nextPaint();
      const target = mediaBox(modal.current, isVideo) || fitViewerRect(ratio);
      if (measured && snapshot) {
        const start = {
          left: (window.innerWidth - measured.width) / 2,
          top: (window.innerHeight - measured.height) / 2,
          width: measured.width,
          height: measured.height,
        };
        setFsGhost({ src: snapshot, from: start, to: start, radius });
        const hold = 200 - (performance.now() - resizeAt);
        if (nativeCover && hold > 0) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, hold));
        }
        if (nativeCover) await hideFullscreenCover(60);
        setFsShowGhost(true);
        await nextPaint();
        setFsGhost((ghost) => (ghost ? { ...ghost, to: target } : ghost));
        setFsGhostLive(true);
        await new Promise<void>((resolve) => window.setTimeout(resolve, 220));
      } else {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
      }
      setFsFade(true);
      await new Promise<void>((resolve) => window.setTimeout(resolve, 150));
      if (nativeCover) await hideFullscreenCover();
    } else {
      const ret = fsReturn.current;
      const currentScreen = screenRect(measured);
      const savedTarget = ret?.rel === item.rel && ret.loadingSurface === loadingSurface && ret.rect ? [
        Math.round(ret.windowX + ret.rect.left),
        Math.round(ret.windowY + ret.rect.top),
        Math.round(ret.rect.width),
        Math.round(ret.rect.height),
      ] : null;
      let native = false;
      if (backdrop && snapshot && currentScreen) {
        try {
          const res = await call<{ shown: boolean }>("showFullscreenCover", {
            cover: backdrop, sharp: snapshot, from: currentScreen, to: savedTarget || currentScreen, radius,
            duration: savedTarget ? fullscreenZoomMs : 0,
          });
          native = Boolean(res?.shown);
        } catch {
          native = false;
        }
      }
      if (native) {
        let zoomEndsAt = performance.now() + fullscreenZoomMs;
        windowFsRef.current = false;
        await applyWindowFullscreen(false);
        await nextPaint();
        setWindowFs(false);
        if (hideChrome) setImmersive(false);
        await nextPaint();
        const target = targetMediaBox();
        const restored = screenRect(target);
        if (!savedTarget && currentScreen && restored) {
          try {
            await call("animateFullscreenCover", { from: currentScreen, to: restored, radius, duration: fullscreenZoomMs });
          } catch {
            /* the still in the restored viewer can still take over */
          }
          zoomEndsAt = performance.now() + fullscreenZoomMs;
        }
        const staged = stageFullscreenHandoff(snapshot, target, radius);
        const remaining = zoomEndsAt - performance.now();
        if (remaining > 0) await new Promise<void>((resolve) => window.setTimeout(resolve, remaining));
        // Reveal the restored desktop around the window, while the still in
        // WebView2 keeps the media itself in place.
        await finishNativeHandoff(staged, 55);
        return;
      }
      if (waitingForVideo) {
        await resizeWhileVideoLoads(false, hideChrome);
        return;
      }
      // Fallback: animate the page ghost, then restore the window underneath.
      setFsGhost({ src: snapshot, from: measured || full, to: measured || full, radius });
      setFsShowGhost(Boolean(measured && snapshot));
      setFsGhostLive(false);
      setFsFade(false);
      await nextPaint();
      if (measured && snapshot && ret?.rect) {
        const target = {
          left: ret.windowX - ret.screenX + ret.rect.left,
          top: ret.windowY - ret.screenY + ret.rect.top,
          width: ret.rect.width,
          height: ret.rect.height,
        };
        setFsGhost({ src: snapshot, from: measured, to: target, radius });
        setFsGhostLive(true);
        await new Promise<void>((resolve) => window.setTimeout(resolve, 220));
      } else {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
      }
      setFsShowGhost(false);
      windowFsRef.current = false;
      await applyWindowFullscreen(false);
      await nextPaint();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 80));
      setWindowFs(false);
      if (hideChrome) setImmersive(false);
      await nextPaint();
      const settled = mediaBox(modal.current, isVideo) || ret?.rect || null;
      if (snapshot && settled) {
        const settle = {
          left: settled.left,
          top: settled.top,
          width: settled.width,
          height: settled.height,
        };
        setFsGhost({ src: snapshot, from: settle, to: settle, radius });
        setFsShowGhost(true);
        await nextPaint();
      }
      setFsFade(true);
      await new Promise<void>((resolve) => window.setTimeout(resolve, 160));
    }
    setFsGhost(null);
    setFsShowGhost(false);
    setFsGhostLive(false);
    setFsFade(false);
    finishFullscreenTransition();
  };

  const toggleFullscreen = () => {
    void transitionFullscreen(!windowFsRef.current);
  };

  const enterImmersive = () => {
    if (windowFsRef.current) {
      setImmersive(true);
      return;
    }
    void transitionFullscreen(true, true);
  };

  const exitImmersive = () => {
    if (windowFsRef.current) {
      void transitionFullscreen(false, true);
      return;
    }
    setImmersive(false);
  };

  const closeViewer = () => {
    if (fsBusy.current) return;
    if (windowFsRef.current) {
      windowFsRef.current = false;
      setWindowFs(false);
      void hideFullscreenCover(0);
      void applyWindowFullscreen(false);
    }
    onClose();
  };

  useEffect(() => () => {
    if (windowFsRef.current) {
      windowFsRef.current = false;
      void call("hideFullscreenCover", { fade: 0 }).catch(() => undefined);
      void applyWindowFullscreen(false);
    }
  }, []);

  const actionsRef = useRef({ transitionFullscreen, closeViewer });
  actionsRef.current = { transitionFullscreen, closeViewer };

  useEffect(() => {
    const clearHold = () => {
      if (hold.current) {
        window.clearTimeout(hold.current.timer);
        if (hold.current.long) api.current?.endBoost();
        hold.current = null;
      }
    };
    const seekImage = (direction: number) => {
      stateRef.current.onStep(direction < 0 ? -1 : 1);
    };
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const st = stateRef.current;
      if (e.key === "PageUp" || (e.ctrlKey && e.key === "ArrowLeft")) {
        e.preventDefault();
        seekImage(-1);
        return;
      }
      if (e.key === "PageDown" || (e.ctrlKey && e.key === "ArrowRight")) {
        e.preventDefault();
        seekImage(1);
        return;
      }
      if (e.key === "Escape") {
        if (windowFsRef.current) {
          void actionsRef.current.transitionFullscreen(false);
          return;
        }
        if (immersiveRef.current) setImmersive(false);
        else actionsRef.current.closeViewer();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        void actionsRef.current.transitionFullscreen(!windowFsRef.current);
        return;
      }
      if (st.kind === "image") {
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          seekImage(-1);
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          seekImage(1);
        } else if (e.key === "+" || e.key === "=") {
          e.preventDefault();
          setZoom((z) => Math.min(6, Math.round((z + 0.25) * 100) / 100));
        } else if (e.key === "-") {
          e.preventDefault();
          setZoom((z) => {
            const next = Math.max(1, Math.round((z - 0.25) * 100) / 100);
            if (next === 1) setOffset({ x: 0, y: 0 });
            return next;
          });
        } else if (e.key === "0") {
          resetZoom();
        }
        return;
      }
      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        api.current?.toggle();
        return;
      }
      if (e.key === "m" || e.key === "M") {
        api.current?.toggleMute();
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        if (e.repeat) return;
        clearHold();
        const direction = e.key === "ArrowRight" ? 1 : -1;
        const timer = window.setTimeout(() => {
          if (hold.current && hold.current.key === e.key) {
            hold.current.long = true;
            api.current?.beginBoost(st.prefs.longPressRate);
          }
        }, st.prefs.longPressDelayMs);
        hold.current = { key: e.key, timer, long: false, direction };
        return;
      }
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        if (e.repeat) return;
        api.current?.adjustVolume(e.key === "ArrowUp" ? st.prefs.volumeStep : -st.prefs.volumeStep);
        return;
      }
      if (e.key === "[" || e.key === "]") {
        const rate = api.current?.getRate() ?? 1;
        api.current?.setRate(rate + (e.key === "]" ? 0.25 : -0.25));
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const state = hold.current;
      if (!state || state.key !== e.key) return;
      window.clearTimeout(state.timer);
      if (state.long) api.current?.endBoost();
      else api.current?.seekBy(state.direction * stateRef.current.prefs.seekSeconds);
      hold.current = null;
    };
    const onBlur = () => clearHold();
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
      clearHold();
    };
  }, []);

  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    if (!rect) return;
    // One fixed small step per wheel notch; a high-resolution or accelerated
    // first event used to jump several steps at once.
    wheelAccum.current += e.deltaY;
    if (Math.abs(wheelAccum.current) < 80) return;
    const direction = wheelAccum.current < 0 ? 1 : -1;
    wheelAccum.current = 0;
    const cx = e.clientX - rect.left - rect.width / 2;
    const cy = e.clientY - rect.top - rect.height / 2;
    setZoom((prev) => {
      const next = Math.max(1, Math.min(6, Math.round((prev + direction * 0.08) * 100) / 100));
      if (next === 1) {
        setOffset({ x: 0, y: 0 });
      } else if (next !== prev) {
        const ratio = next / prev;
        setOffset((o) => ({ x: cx - ratio * (cx - o.x), y: cy - ratio * (cy - o.y) }));
      }
      return next;
    });
  };

  const onStagePointerDownCapture = (e: React.PointerEvent<HTMLDivElement>) => {
    stagePress.current = { onMedia: isViewerMediaTarget(e.target), dragged: false };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isVideo || zoom <= 1) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.x;
    const dy = e.clientY - drag.current.y;
    if (stagePress.current && !stagePress.current.dragged && Math.hypot(dx, dy) >= 4) {
      stagePress.current.dragged = true;
    }
    setOffset({ x: drag.current.ox + dx, y: drag.current.oy + dy });
  };
  const onPointerUp = () => {
    drag.current = null;
    setDragging(false);
  };

  const onImageClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.tagName !== "IMG" || zoom > 1) return;
    const rect = stage.current?.getBoundingClientRect();
    if (!rect) return;
    const cx = e.clientX - rect.left - rect.width / 2;
    const cy = e.clientY - rect.top - rect.height / 2;
    setZoom(2);
    setOffset({ x: -cx, y: -cy });
    imageZoomedAt.current = performance.now();
  };

  const onBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const press = stagePress.current;
    stagePress.current = null;
    // The click can land on the stage after pointer capture or after a loading
    // indicator unmounts. Remember where the press started in both cases.
    if (press?.dragged || press?.onMedia || isViewerMediaTarget(e.target)) return;
    if (immersiveRef.current) {
      setImmersive(false);
      return;
    }
    closeViewer();
  };

  const onVideoPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isVideo || zoom <= 1) return;
    const target = e.target as HTMLElement;
    if (target.closest(".art-bottom, .art-controls, .art-settings, .art-contextmenus, .art-notice, .vp-keys, .viewer-immersive-exit")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
    dragMoved.current = false;
    if (stagePress.current) stagePress.current.dragged = false;
    setDragging(true);
  };
  const onVideoPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.x;
    const dy = e.clientY - drag.current.y;
    if (!dragMoved.current) {
      if (Math.hypot(dx, dy) < 4) return;
      dragMoved.current = true;
      if (stagePress.current) stagePress.current.dragged = true;
    }
    setOffset({ x: drag.current.ox + dx, y: drag.current.oy + dy });
  };
  const onVideoPointerUp = () => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
  };

  useEffect(() => {
    if (isVideo) api.current?.setZoom(zoom, offset, !dragging);
  }, [isVideo, zoom, offset, dragging]);

  return (
    <div ref={modal} className={`media-modal viewer-modal backdrop-${prefs.backdrop} ${immersive ? "immersive" : ""}`} role="dialog" aria-modal="true" aria-label={`${isVideo ? "视频" : "图片"}：${item.name}`}>
      {fsGhost && (
        <div className={`viewer-fs-cover ${fsGhost.handoff ? "handoff" : ""} ${fsFade ? "settle" : ""}`} style={backdropStyle} aria-hidden="true">
          {fsShowGhost && fsGhost.src && (
            <img
              className={`viewer-fs-ghost ${fsGhostLive ? "live" : ""}`}
              src={fsGhost.src}
              alt=""
              draggable={false}
              style={{
                left: `${(fsGhostLive ? fsGhost.to : fsGhost.from).left}px`,
                top: `${(fsGhostLive ? fsGhost.to : fsGhost.from).top}px`,
                width: `${(fsGhostLive ? fsGhost.to : fsGhost.from).width}px`,
                height: `${(fsGhostLive ? fsGhost.to : fsGhost.from).height}px`,
                borderRadius: `${fsGhost.radius}px`,
              }}
            />
          )}
        </div>
      )}
      <div className="viewer-backdrop" style={backdropStyle} aria-hidden="true" />
      <header className="media-modal-head viewer-head">
        <span className="media-modal-name" title={item.name}>{item.name}</span>
        <span className="media-modal-count" title={positionLabel}>{position.toLocaleString()} / {total.toLocaleString()} · {bytes(item.size)}</span>
        {loading && <span className="viewer-page-status" role="status">正在读取相邻媒体…</span>}
        {error && <span className="viewer-page-status error" role="alert">{error}</span>}
        <span className="spacer" />
        <button className="btn sm ghost" onClick={() => setShowKeys((v) => !v)}>
          <Keyboard size={12} /> 快捷键
        </button>
        <button className="btn sm ghost" onClick={() => onOpen(item)}>
          <ExternalLink size={12} /> {isVideo ? "系统播放器" : "系统图片查看器"}
        </button>
        <button className="btn sm ghost" onClick={() => onReveal(item)}>
          <LocateFixed size={12} /> 定位文件
        </button>
        <button className="btn sm ghost" onClick={enterImmersive}>
          <Eye size={12} /> 沉浸模式
        </button>
        <button className="btn sm ghost" onClick={toggleFullscreen}>
          {windowFs ? <Minimize2 size={12} /> : <Maximize2 size={12} />} {windowFs ? "退出全屏" : "全屏"}
        </button>
        <button className="viewer-close" aria-label="关闭查看器" onClick={closeViewer}>
          <X size={17} />
        </button>
      </header>

      <div
        className={`media-modal-main viewer-stage ${isVideo ? "video" : "image"} ${zoom > 1 ? "zoomed" : ""} ${dragging ? "dragging" : ""}`}
        onWheel={isVideo ? onWheel : undefined}
        onClick={onBackdropClick}
        onPointerDownCapture={onStagePointerDownCapture}
        onPointerDown={isVideo ? onVideoPointerDown : undefined}
        onPointerMove={isVideo ? onVideoPointerMove : undefined}
        onPointerUp={isVideo ? onVideoPointerUp : undefined}
        onPointerCancel={isVideo ? onVideoPointerUp : undefined}
      >
        {isVideo ? (
          <ArtVideo
            ref={api}
            src={src}
            poster={poster || ""}
            maxVolume={prefs.maxVolume}
            frameAspect={prefs.videoFrameAspect}
            knownRatio={knownRatio}
            hasNext={hasNext}
            autoNext={hasNext && (!items[index + 1] || items[index + 1].kind === "video")}
            onNext={() => step(1)}
            onAutoNext={() => step(1, true)}
            fullscreen={windowFs}
            onFullscreen={toggleFullscreen}
          />
        ) : (
          <div
            ref={stage}
            className={`image-stage ${zoom > 1 ? "zoomed" : ""} ${dragging ? "dragging" : ""}`}
            onWheel={onWheel}
            onClick={onImageClick}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onDoubleClick={() => {
              if (zoom > 1 && performance.now() - imageZoomedAt.current > 350) resetZoom();
            }}
          >
            <img
              src={src}
              alt={item.name}
              draggable={false}
              loading="eager"
              onLoad={() => setImageReady(true)}
              onError={() => setImageReady(true)}
              style={{
                width: imageBox ? `${imageBox.w}px` : undefined,
                height: imageBox ? `${imageBox.h}px` : undefined,
                transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
              }}
            />
            {!imageReady && imageBusy && (
              <div className="image-loading-guard" role="status">
                <span className="load-spinner" />
              </div>
            )}
            {zoom > 1 && <span className="image-zoom-badge">{Math.round(zoom * 100)}%</span>}
          </div>
        )}
        {showKeys && (
          <div className="vp-keys" role="dialog" aria-label="查看器快捷键">
            <h4>{isVideo ? "视频快捷键" : "图片快捷键"}</h4>
            <dl>
              {isVideo ? (
                <>
                  <dt>← / →</dt><dd>快退 / 快进 {prefs.seekSeconds} 秒；长按 {prefs.longPressDelayMs}ms 触发 {prefs.longPressRate}× 倍速</dd>
                  <dt>↑ / ↓</dt><dd>音量 ±{prefs.volumeStep}%（最高 {prefs.maxVolume}%）</dd>
                  <dt>M</dt><dd>静音 / 取消静音</dd>
                  <dt>Space</dt><dd>播放 / 暂停</dd>
                  <dt>[ / ]</dt><dd>倍速 −0.25 / +0.25</dd>
                </>
              ) : (
                <>
                  <dt>← / →</dt><dd>上一张 / 下一张</dd>
                  <dt>滚轮</dt><dd>以鼠标位置缩放</dd>
                  <dt>单击 / 双击</dt><dd>放大 / 恢复原始大小</dd>
                  <dt>拖动</dt><dd>放大后按住移动画面</dd>
                  <dt>+ / −</dt><dd>放大 / 缩小</dd>
                  <dt>0</dt><dd>恢复原始大小</dd>
                </>
              )}
              <dt>Enter</dt><dd>进入 / 退出全屏</dd>
              <dt>PageUp / PageDown</dt><dd>上一个 / 下一个</dd>
              <dt>Esc</dt><dd>全屏时退出全屏，否则关闭查看器</dd>
            </dl>
          </div>
        )}
      </div>

      <div className="media-strip viewer-strip" ref={strip}>
        {items.slice(Math.max(0, index - 5), index + 6).map((v, offset) => {
          const i = Math.max(0, index - 5) + offset;
          const src = previewURL(v, chat.slug, libraryKey, version);
          return <button key={v.rel} ref={i === index ? active : undefined} className={i === index ? "on" : ""} title={v.name} onClick={() => { if (!fsBusy.current) onIndex(i); }}>
            <GalleryImage key={src} src={src} kind={v.kind} performanceMode={performanceMode} limiter={limiter} />
            <span className="strip-index">{positions[i]}</span>
            {v.kind === "video" && <span className="strip-kind"><Play size={9} fill="currentColor" /></span>}
          </button>;
        })}
      </div>
      <button className="media-nav prev" disabled={!hasPrevious || loading} aria-label="上一个" onClick={() => step(-1)}>
        <ChevronLeft size={26} />
      </button>
      <button className="media-nav next" disabled={!hasNext || loading} aria-label="下一个" onClick={() => step(1)}>
        <ChevronRight size={26} />
      </button>
      {immersive && (
        <button className="viewer-immersive-exit" onClick={exitImmersive} title="退出沉浸模式（Esc）" aria-label="退出沉浸模式">
          <Minimize2 size={15} />
        </button>
      )}
    </div>
  );
}

function AudioViewer({
  chat,
  item,
  libraryKey,
  version,
  onClose,
  onReveal,
}: {
  chat: ChatRow;
  item: MediaItem;
  libraryKey: string;
  version: string;
  onClose: () => void;
  onReveal: (item: MediaItem) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="media-modal audio" role="dialog" aria-modal="true" aria-label={`音频：${item.name}`}>
      <header className="media-modal-head">
        <span className="media-modal-name">{item.name}</span>
        <span className="spacer" />
        <button className="btn sm ghost" onClick={() => onReveal(item)}>
          <LocateFixed size={12} /> 定位文件
        </button>
        <button className="btn sm close-x" aria-label="关闭音频" onClick={onClose}>
          <X size={14} />
        </button>
      </header>
      <div className="audio-body">
        <div className="audio-art">
          <Music size={44} />
        </div>
        <audio src={mediaURL(chat.slug, item.rel, libraryKey, version)} controls autoPlay className="audio-native" />
      </div>
    </div>
  );
}

/* ============================= Library ============================= */
interface OfficialMeta {
  name: string;
  messageCount: number;
  mediaMessages: number;
  mediaFiles: number;
  images: number;
  videos: number;
  audio: number;
  files: number;
  totalBytes: number;
  root: string;
  matchedSlug?: string;
}
interface OfficialPreview {
  meta: OfficialMeta;
  matchSlug?: string;
  chats: ChatRow[];
}

interface LibrarySwitchOptions {
  newRemoteMount?: boolean;
  afterSwitch?: () => Promise<void>;
  onError?: (message: string) => void;
}

export function Library({ ctx, remoteRequest = 0, onRemoteHandled, onRemoteClosed }: { ctx: PageCtx; remoteRequest?: number; onRemoteHandled?: () => void; onRemoteClosed?: () => void }) {
  const { boot, chats, selected, setSelected, refresh, toast, pickFolder, pickFiles, go, openTask } = ctx;
  const history = boot?.history ?? [];
  const [official, setOfficial] = useState<OfficialPreview | null>(null);
  const [target, setTarget] = useState("");
  const [mode, setMode] = useState("managed");
  const [busy, setBusy] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<ChatRow[]>([]);
  const [pendingPublishSwitch, setPendingPublishSwitch] = useState<{ root: string; options?: LibrarySwitchOptions } | null>(null);
  const [detailChat, setDetailChat] = useState<ChatRow | null>(null);
  const [detailLibraryKey, setDetailLibraryKey] = useState("");
  const [detailMediaLoading, setDetailMediaLoading] = useState(false);
  const [detailMediaError, setDetailMediaError] = useState("");
  const [detailMediaStale, setDetailMediaStale] = useState(false);
  const [detailMediaCancelled, setDetailMediaCancelled] = useState(false);
  const [detailReload, setDetailReload] = useState(0);
  const detailRefreshNext = useRef(false);
  const detailRequest = useRef<AbortController | null>(null);
  const detailApplySummary = useRef(ctx.applyMediaSummary);
  detailApplySummary.current = ctx.applyMediaSummary;
  const [remote, setRemote] = useState<RemoteStatus | null>(null);
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [remoteMode, setRemoteMode] = useState<"saved" | "add">("saved");
  const [remoteSave, setRemoteSave] = useState(false);
  const [remoteLabel, setRemoteLabel] = useState("");
  const [remoteSaveAuto, setRemoteSaveAuto] = useState(false);
  const [remoteError, setRemoteError] = useState("");
  const [connectionBusy, setConnectionBusy] = useState(false);
  const remoteDialog = useRef<HTMLDivElement>(null);
  const remoteWasOpen = useRef(false);
  const [remotePath, setRemotePath] = useState("");
  const [remoteProbe, setRemoteProbe] = useState<RemoteStatus | null>(null);
  const [remoteTesting, setRemoteTesting] = useState(false);
  const [remoteTools, setRemoteTools] = useState<RemoteTools | null>(null);
  const [remoteToolsError, setRemoteToolsError] = useState("");
  const [rcloneOpen, setRcloneOpen] = useState(false);
  const [rcloneRemote, setRcloneRemote] = useState("");
  const [rcloneSub, setRcloneSub] = useState("");
  const [rcloneDrive, setRcloneDrive] = useState("Z");
  const [rcloneBusy, setRcloneBusy] = useState(false);
  const [stagedMountRoot, setStagedMountRoot] = useState("");
  const [sshOpen, setSSHOpen] = useState(false);
  const [sshAlias, setSSHAlias] = useState("");
  const [sshTarget, setSSHTarget] = useState("");
  const [sshUser, setSSHUser] = useState("");
  const [sshPort, setSSHPort] = useState("22");
  const [sshPassword, setSSHPassword] = useState("");
  const [sshHostKey, setSSHHostKey] = useState("");
  const [sshTrust, setSSHTrust] = useState<{ key: string; fingerprint: string; type: string } | null>(null);
  const [sshDirectory, setSSHDirectory] = useState<{ path: string; folders: string[]; library: boolean } | null>(null);
  const [sshSavedPath, setSSHSavedPath] = useState("");
  const [sshAction, setSSHAction] = useState<"install" | "test" | "connect" | "switch">();
  const [sshError, setSSHError] = useState("");
  const sshRequest = useRef<AbortController | null>(null);
  const remoteFormBusy = !!sshAction || rcloneBusy || remoteTesting || busy === "switch" || !!pendingPublishSwitch;
  const sshCanTest = !!sshAlias || !!sshTarget.trim() && !!sshUser.trim() && !!sshPassword && Number(sshPort) > 0 && Number(sshPort) <= 65535;
  const resetSSHTest = () => { setSSHDirectory(null); setSSHTrust(null); setSSHError(""); };
  const clearSSHPassword = () => { setSSHPassword(""); setSSHTrust(null); setSSHHostKey(""); setSSHDirectory(null); setSSHSavedPath(""); };

  const showDetail = (chat: ChatRow) => {
    setDetailLibraryKey(boot?.libraryKey ?? "");
    setDetailMediaError("");
    setDetailMediaStale(false);
    setDetailMediaCancelled(false);
    setDetailChat(chat);
  };

  useEffect(() => {
    if (detailLibraryKey && detailLibraryKey !== boot?.libraryKey) setDetailChat(null);
  }, [boot?.libraryKey, detailLibraryKey]);

  useEffect(() => {
    const slug = detailChat?.slug;
    if (!slug || !detailLibraryKey || detailLibraryKey !== boot?.libraryKey) return;
    const controller = new AbortController();
    detailRequest.current = controller;
    const force = detailRefreshNext.current;
    detailRefreshNext.current = false;
    setDetailMediaLoading(true);
    setDetailMediaError("");
    setDetailMediaCancelled(false);
    call<MediaPage>("chatMedia", { slug, kind: "all", sort: "newest", query: "", page: 1, version: "", refresh: force, libraryKey: detailLibraryKey }, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setDetailChat((current) => current?.slug === slug ? rowWithSummary(current, result.summary) : current);
        setDetailMediaStale(result.stale);
        detailApplySummary.current?.(detailLibraryKey, slug, result.summary);
        setDetailMediaLoading(false);
        if (detailRequest.current === controller) detailRequest.current = null;
      })
      .catch((e: Error) => {
        if (!controller.signal.aborted) {
          setDetailMediaError(e.message);
          setDetailMediaLoading(false);
          if (detailRequest.current === controller) detailRequest.current = null;
        }
      });
    return () => {
      controller.abort();
      if (detailRequest.current === controller) detailRequest.current = null;
    };
  }, [detailChat?.slug, detailLibraryKey, boot?.libraryKey, detailReload]);

  useEffect(() => {
    let cancelled = false;
    const probe = () => call<RemoteStatus>("remoteStatus")
      .then((st) => { if (!cancelled) setRemote(st); })
      .catch(() => undefined);
    void probe();
    const timer = window.setInterval(probe, 30000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [boot?.libraryRoot]);

  const readRemoteTools = () => {
    setRemoteToolsError("");
    void call<RemoteTools>("remoteTools").then((tools) => {
      setRemoteTools(tools);
      if (tools.rcloneRemotes?.length) setRcloneRemote(tools.rcloneRemotes[0]);
      setSSHAlias((current) => tools.sshAliases?.includes(current) ? current : "");
    }).catch((error: Error) => setRemoteToolsError(error.message));
  };
  const openRemote = () => {
    setRemoteOpen(true);
    setRemoteMode("saved");
    setRemoteSave(false);
    setRemoteSaveAuto(false);
    setRemoteLabel("");
    setRemoteError("");
    setStagedMountRoot("");
    setRemotePath(remote?.remote ? remote.root : "");
    setRemoteProbe(null);
    setRemoteTools(null);
    setRcloneOpen(false);
    setRcloneBusy(false);
    setSSHOpen(false);
    setSSHAlias("");
    clearSSHPassword();
    setSSHError("");
    readRemoteTools();
  };
  useEffect(() => {
    if (!remoteRequest) return;
    openRemote();
    onRemoteHandled?.();
  }, [remoteRequest]);

  useEffect(() => {
    if (!remoteOpen) return;
    const previous = document.activeElement;
    remoteDialog.current?.querySelector<HTMLButtonElement>('[aria-label="关闭网络位置"]')?.focus({ preventScroll: true });
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [remoteOpen]);

  useEffect(() => {
    const wasOpen = remoteWasOpen.current;
    remoteWasOpen.current = remoteOpen;
    if (wasOpen && !remoteOpen) onRemoteClosed?.();
  }, [remoteOpen, onRemoteClosed]);

  const showRemoteMode = (mode: typeof remoteMode) => {
    if (mode === "saved") clearSSHPassword();
    setRemoteMode(mode);
    requestAnimationFrame(() => {
      const selector = mode === "add" ? "#remote-title" : ".saved-connections-head > button";
      remoteDialog.current?.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
    });
  };

  const switchRemote = (root: string, newRemoteMount = false, onError = setRemoteError) => switchTo(root, false, {
    newRemoteMount,
    onError,
    afterSwitch: async () => {
      if (!remoteSave) {
        setRemoteOpen(false);
        return;
      }
      try {
        await call<SavedRemoteConnection>("remoteConnectionSave", { root, label: remoteLabel.trim(), autoReconnect: remoteSaveAuto });
        toast("已保存网络连接", "success");
        setRemoteMode("saved");
      } catch (e) {
        const message = `已打开档案库，保存连接失败。${(e as Error).message}`;
        onError(message);
        toast(message, true);
      }
    },
  });
  const installSSHMountTools = async () => {
    setSSHAction("install");
    setSSHError("");
    try {
      await call("sshMountInstall");
      setRemoteTools(await call<RemoteTools>("remoteTools"));
    } catch (error) {
      setSSHError((error as Error).message);
    } finally {
      setSSHAction(undefined);
    }
  };
  const sshParams = (directory: string, key = sshHostKey) => sshAlias ? { alias: sshAlias, path: directory } : {
    host: sshTarget.trim(), user: sshUser.trim(), port: Number(sshPort), password: sshPassword, key, path: directory,
  };
  const browseSSH = async (directory = "", trustedKey = "") => {
    if (sshAction || !sshCanTest) return;
    const controller = new AbortController();
    sshRequest.current = controller;
    setSSHAction("test");
    setSSHError("");
    try {
      const key = trustedKey || sshHostKey;
      if (!sshAlias && !key) {
        const trust = await call<{ key: string; fingerprint: string; type: string }>("sshVerifyHost", { host: sshTarget.trim(), port: Number(sshPort) }, controller.signal);
        setSSHTrust(trust);
        return;
      }
      const next = await call<NonNullable<typeof sshDirectory>>("sshBrowse", sshParams(directory, key), controller.signal);
      setSSHDirectory(next);
      if (trustedKey) setSSHHostKey(trustedKey);
    } catch (error) {
      if (!controller.signal.aborted) {
        const message = (error as Error).message;
        setSSHError(message);
        if (message.includes("主机密钥")) { setSSHHostKey(""); setSSHDirectory(null); }
      }
    } finally {
      if (sshRequest.current === controller) sshRequest.current = null;
      setSSHAction(undefined);
    }
  };
  const mountSSH = async () => {
    if (sshAction || sshError || !sshDirectory?.library) return;
    const controller = new AbortController();
    sshRequest.current = controller;
    setSSHAction("connect");
    setSSHError("");
    try {
      const root = await call<string>("sshConnect", sshParams(sshDirectory.path), controller.signal);
      sshRequest.current = null;
      setSSHAction("switch");
      const result = await switchRemote(root, true, setSSHError);
      if (result === "switched") clearSSHPassword();
      if (result === "failed") {
        setStagedMountRoot(root);
        setRemotePath(root);
        setRemoteProbe(await call<RemoteStatus>("remoteStatus", { root, newRemoteMount: true }));
        clearSSHPassword();
        setSSHOpen(false);
      }
    } catch (error) {
      if (!controller.signal.aborted) setSSHError((error as Error).message);
    } finally {
      sshRequest.current = null;
      setSSHAction(undefined);
    }
  };
  const closeRemote = () => {
    if ((sshAction && !sshRequest.current) || rcloneBusy || remoteTesting || connectionBusy || busy === "switch" || pendingPublishSwitch) return;
    sshRequest.current?.abort();
    clearSSHPassword();
    setRemoteOpen(false);
  };
  const remoteConnected = () => {
    refresh();
    void call<RemoteStatus>("remoteStatus").then(setRemote).catch(() => undefined);
  };
  const mountRclone = async () => {
    if (!rcloneRemote) {
      toast("请选择 rclone remote", true);
      return;
    }
    setRcloneBusy(true);
    setRemoteError("");
    try {
      const mounted = await call<string>("rcloneMount", { name: rcloneRemote, path: rcloneSub, drive: rcloneDrive });
      setRemotePath(mounted);
      setStagedMountRoot(mounted);
      setRcloneOpen(false);
      const st = await call<RemoteStatus>("remoteStatus", { root: mounted, newRemoteMount: true });
      setRemoteProbe(st);
      toast(`rclone 已挂载到 ${mounted}`);
    } catch (e) {
      setRemoteError((e as Error).message);
      toast((e as Error).message, true);
    } finally {
      setRcloneBusy(false);
    }
  };
  const testRemote = async () => {
    const root = remotePath.trim();
    if (!root) {
      toast("请输入网络位置或盘符", true);
      return;
    }
    setRemoteTesting(true);
    setRemoteProbe(null);
    setRemoteError("");
    try {
      const st = await call<RemoteStatus>("remoteStatus", { root, ...(root === stagedMountRoot ? { newRemoteMount: true } : {}) });
      setRemoteProbe(st);
    } catch (e) {
      setRemoteError((e as Error).message);
    } finally {
      setRemoteTesting(false);
    }
  };
  const useRemote = async () => {
    if (!remoteProbe?.reachable || !remoteProbe.writable) return;
    setRemoteError("");
    await switchRemote(remoteProbe.root, !!stagedMountRoot && stagedMountRoot === remotePath.trim());
  };
  const copyRemoteCommand = (cmd: string) => {
    navigator.clipboard?.writeText(cmd).then(() => toast("安装命令已复制")).catch(() => toast("复制失败", true));
  };
  const clearRemoteCache = async () => {
    try {
      const cleared = await call<number>("clearRemoteCache");
      const next = await call<RemoteStatus>("remoteStatus");
      setRemote(next);
      toast(cleared > 0 ? `已清理远程缓存 ${bytes(cleared)}` : "远程缓存原本为空");
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const toggleSel = (slug: string) => setSel((prev) => {
    const next = new Set(prev);
    if (next.has(slug)) next.delete(slug);
    else next.add(slug);
    return next;
  });
  const allSelected = chats.length > 0 && sel.size === chats.length;
  const toggleAll = () => setSel(allSelected ? new Set() : new Set(chats.map((c) => c.slug)));
  const selectedChats = chats.filter((c) => sel.has(c.slug));

  const pathKindLabel = (kind?: string) =>
    kind === "unc" ? "SMB / UNC" : kind === "mapped" ? "映射网络盘" : kind === "local" ? "本地磁盘" : "未知位置";
  const remoteOffline = !!remote?.remote && !remote.reachable;

  const rebuildSelected = async () => {
    if (selectedChats.length === 0) return;
    setBusy("bulk");
    try {
      for (const c of selectedChats) await call("startRefreshWeb", { slug: c.slug });
      toast(`已为 ${selectedChats.length} 个聊天加入重建任务`);
      setSel(new Set());
      refresh();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy("");
    }
  };
  const verifySelected = async () => {
    if (selectedChats.length === 0) return;
    setBusy("bulk");
    let missing = 0;
    let ok = 0;
    try {
      for (const c of selectedChats) {
        try {
          const st = await call<Stats>("verifyChat", { slug: c.slug });
          missing += st.missing;
          ok++;
        } catch {
          /* keep checking the rest */
        }
      }
      toast(`已核对 ${ok}/${selectedChats.length} 个聊天，共 ${missing} 个缺失媒体`);
    } finally {
      setBusy("");
    }
  };
  const exportSelected = async () => {
    if (selectedChats.length === 0) return;
    try {
      const dst = await pickFolder("export-target", "选择目标档案库目录（导出选中的聊天）");
      if (!dst) return;
      setBusy("bulk");
      for (const c of selectedChats) await call("startExportChat", { slug: c.slug, dst });
      toast(`已为 ${selectedChats.length} 个聊天加入导出任务`);
      setSel(new Set());
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy("");
    }
  };
  const deleteSelected = () => {
    if (selectedChats.length === 0) return;
    setPendingDelete(selectedChats);
  };
  const runDelete = async () => {
    const targets = pendingDelete;
    if (targets.length === 0) return;
    setPendingDelete([]);
    setBusy("bulk");
    try {
      for (const c of targets) await call("deleteChat", { slug: c.slug });
      toast(targets.length === 1 ? "已删除本地归档" : `已删除 ${targets.length} 个本地归档`);
      setSel(new Set());
      if (detailChat && targets.some((c) => c.slug === detailChat.slug)) setDetailChat(null);
      refresh();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy("");
    }
  };

  const switchTo = async (root: string, stopPublication = false, options?: LibrarySwitchOptions): Promise<"switched" | "confirmation" | "failed"> => {
    setBusy("switch");
    try {
      if (stopPublication) {
        await call("webPublishStop");
      } else {
        const publication = await call<{ requested: boolean }>("webPublishStatus");
        if (publication.requested) {
          setPendingPublishSwitch({ root, options });
          return "confirmation";
        }
      }
      await call("switchLibrary", { root, ...(options?.newRemoteMount ? { newRemoteMount: true } : {}) });
      toast("已切换档案库");
      refresh();
      await options?.afterSwitch?.();
      return "switched";
    } catch (e) {
      const message = (e as Error).message;
      options?.onError?.(message);
      toast(message, true);
      return "failed";
    } finally {
      setBusy("");
    }
  };

  const pickAndSwitch = async () => {
    try {
      const root = await pickFolder("switch-library", "选择或新建 Telegram Archive Library 目录");
      if (root) await switchTo(root);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const merge = async () => {
    try {
      const root = await pickFolder("merge-library", "选择要合并进来的档案库");
      if (!root) return;
      const { taskId } = await call<{ taskId: string }>("startMergeLibrary", { root });
      toast("合并任务已加入任务中心", "success", { label: "查看任务", run: () => openTask(taskId) });
      refresh();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const importJSON = async () => {
    try {
      const paths = await pickFiles("import-json");
      if (!paths || paths.length === 0) return;
      await call("startImportJSON", { paths });
      toast("导入任务已加入任务中心");
      refresh();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const analyzeOfficial = async () => {
    try {
      const folder = await pickFolder("official-folder", "选择 Telegram Desktop 导出的 ChatExport 文件夹");
      if (!folder) return;
      setBusy("analyze");
      const preview = await call<OfficialPreview>("analyzeOfficial", { folder });
      setOfficial(preview);
      setTarget(preview.matchSlug || "");
      setMode("managed");
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy("");
    }
  };

  const confirmOfficial = async () => {
    if (!official || busy === "official") return;
    setBusy("official");
    try {
      const { taskId } = await call<{ taskId: string }>("startImportOfficial", { folder: official.meta.root, slug: target, mode });
      toast("官方导出任务已加入任务中心", "success", { label: "查看任务", run: () => openTask(taskId) });
      setOfficial(null);
      refresh();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy("");
    }
  };

  const refreshAll = async () => {
    setBusy("refresh-all");
    try {
      const { taskId } = await call<{ taskId: string }>("startRefreshAllWeb");
      toast("重建任务已加入任务中心", "success", { label: "查看任务", run: () => openTask(taskId) });
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy("");
    }
  };

  const openChat = (slug: string) => {
    setSelected(slug);
    go("chats");
  };

  const copyText = (text: string, label: string) => {
    navigator.clipboard?.writeText(text).then(() => toast(`${label}已复制`)).catch(() => toast("复制失败", true));
  };

  const removeChat = (chat: ChatRow) => setPendingDelete([chat]);

  const verifyChat = (chat: ChatRow) => {
    call<Stats>("verifyChat", { slug: chat.slug })
      .then((st) => toast(`「${chat.name}」核对完成：缺失 ${st.missing} 个媒体`))
      .catch((e: Error) => toast(e.message, true));
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>档案管理</h1>
          <p>导入、批量管理、重建与库切换都在这里；删除与合并前都会要求确认</p>
        </div>
        <div className="actions">
          <button className="btn ghost" onClick={openRemote}>
            <Network size={13} /> 网络位置
          </button>
          <button className="btn ghost" onClick={() => boot && call("openPath", { path: boot.libraryRoot })}>
            <FolderOpen size={13} /> 打开目录
          </button>
          <button className="btn ghost" disabled={remoteOffline} onClick={merge}>
            <GitMerge size={13} /> 合并另一个库
          </button>
          <button className="btn ghost" disabled={busy === "switch"} onClick={pickAndSwitch}>
            <FolderPlus size={13} /> 切换 / 新建
          </button>
          <button className="btn primary" disabled={remoteOffline} onClick={importJSON}>
            <Download size={13} /> 导入 result.json
          </button>
        </div>
      </div>

      {remoteOffline && (
        <div className="remote-offline-banner" role="status">
          <WifiOff size={15} />
          <div>
            <b>远程档案库暂不可达</b>
            <span>{remote?.error || "请检查网络、NAS 电源或映射盘状态；本地缓存仍可浏览。"}</span>
          </div>
          <button className="btn sm ghost" onClick={() => call<RemoteStatus>("remoteStatus").then(setRemote).catch(() => undefined)}>
            重新检测
          </button>
        </div>
      )}

      <section className="stat-grid">
        <div className="stat">
          <span>聊天</span>
          <div><b>{chats.length}</b><em>个</em></div>
        </div>
        <div className="stat">
          <span>消息</span>
          <div><b>{chats.reduce((n, c) => n + c.messages, 0).toLocaleString()}</b><em>条</em></div>
        </div>
        <div className="stat">
          <span>媒体</span>
          <div><b>{chats.reduce((n, c) => n + c.media, 0).toLocaleString()}</b><em>个</em></div>
        </div>
        <div className="stat">
          <span>缺失</span>
          <div><b className={chats.some((c) => c.missing > 0) ? "warn" : ""}>{chats.reduce((n, c) => n + c.missing, 0)}</b><em>个</em></div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>导入与更新</h3>
          <span className="meta">result.json 或 Telegram Desktop 的 ChatExport</span>
        </div>
        <div className="action-grid">
          <button className="action-card accent" onClick={importJSON}>
            <span className="action-icon"><Download size={18} /></span>
            <span className="action-text">
              <b>导入 result.json</b>
              <em>从 Telegram Desktop 导出文件创建或更新聊天</em>
            </span>
            <ChevronRight size={16} />
          </button>
          <button className="action-card" disabled={!boot?.hasSession} onClick={() => ctx.openOnline("local")} title={!boot?.hasSession ? "请先在账号页登录 Telegram" : undefined}>
            <span className="action-icon"><MessagesSquare size={18} /></span>
            <span className="action-text">
              <b>从在线聊天更新</b>
              <em>{boot?.hasSession ? "筛选本地已有档案，统计后确认更新" : "登录 Telegram 后可用"}</em>
            </span>
            <ChevronRight size={16} />
          </button>
          <button className="action-card" disabled={busy === "analyze"} onClick={analyzeOfficial}>
            <span className="action-icon"><FolderOpen size={18} /></span>
            <span className="action-text">
              <b>继承官方 ChatExport</b>
              <em>分析目录后引用、复制或纳管官方媒体</em>
            </span>
            <ChevronRight size={16} />
          </button>
          <button className="action-card" disabled={!chats.length || remoteOffline || busy === "refresh-all" || ctx.tasks.some((task) => (task.kind === "refresh-all" || task.kind === "complete-all") && task.state === "running")} onClick={refreshAll}>
            <span className="action-icon"><RefreshCw size={18} /></span>
            <span className="action-text">
              <b>重建全部网页</b>
              <em>补齐缺失封面，更新所有聊天的离线网页</em>
            </span>
            <ChevronRight size={16} />
          </button>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>聊天管理</h3>
          <span className="meta">{chats.length} 个 · 点击行查看聊天详情，勾选后批量操作</span>
        </div>
        <div className="chat-toolbar">
          <span className={`select-summary ${sel.size > 0 ? "on" : ""}`}>
            {sel.size > 0 ? <>已选 <b>{sel.size}</b> 个聊天</> : "勾选聊天后可批量操作"}
          </span>
          <span className="spacer" />
          <button className="btn sm" disabled={busy === "bulk" || sel.size === 0} onClick={rebuildSelected}>
            <RefreshCw size={12} /> 重建网页
          </button>
          <button className="btn sm" disabled={busy === "bulk" || sel.size === 0} onClick={verifySelected}>
            <ShieldCheck size={12} /> 核对完整性
          </button>
          <button className="btn sm" disabled={busy === "bulk" || sel.size === 0} onClick={exportSelected}>
            <ArrowDownToLine size={12} /> 导出
          </button>
          <button className="btn sm danger" disabled={busy === "bulk" || sel.size === 0} onClick={deleteSelected}>
            <Trash2 size={12} /> 删除
          </button>
          <button className="btn sm ghost" disabled={busy === "bulk" || sel.size === 0} onClick={() => setSel(new Set())}>
            <X size={12} /> 取消选择
          </button>
        </div>
        {chats.length === 0 ? (
          <div className="state-box">
            <p>还没有聊天。导入 result.json 后会出现在这里。</p>
          </div>
        ) : (
          <table className="table chats-table">
            <thead>
              <tr>
                <th className="check-col">
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="全选聊天" />
                </th>
                <th>聊天</th>
                <th>消息</th>
                <th>媒体</th>
                <th>缺失</th>
                <th className="hide-sm">页面</th>
                <th>最近更新</th>
                <th className="row-action">操作</th>
              </tr>
            </thead>
            <tbody>
              {chats.map((c) => (
                <tr
                  key={c.slug}
                  tabIndex={0}
                  aria-selected={c.slug === selected}
                  className={c.slug === selected || sel.has(c.slug) ? "selected" : ""}
                  onClick={() => showDetail(c)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      showDetail(c);
                    } else if (e.key === " ") {
                      e.preventDefault();
                      toggleSel(c.slug);
                    }
                  }}
                  title="点击查看聊天详情"
                >
                  <td className="check-col" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={sel.has(c.slug)} onChange={() => toggleSel(c.slug)} aria-label={`选择 ${c.name}`} />
                  </td>
                  <td>
                    <span className="chat-cell">
                      <span className="avatar">{c.name.slice(0, 1)}</span>
                      <span>
                        <b>{c.name}</b>
                        <em>{c.type || "聊天"} · ID {c.id || "--"}</em>
                      </span>
                    </span>
                  </td>
                  <td>{c.messages.toLocaleString()}</td>
                  <td>{c.media.toLocaleString()}</td>
                  <td>{c.missing > 0 ? <span className="missing-pill">{c.missing}</span> : <span className="muted">0</span>}</td>
                  <td className="hide-sm">{c.pages}</td>
                  <td className="muted">{dateTime(c.updatedAt)}</td>
                  <td className="row-action">
                    <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                      <button className="row-btn" aria-label={`打开 ${c.name}`} onClick={() => openChat(c.slug)}>
                        <ArrowUpRight size={13} /> <span>打开</span>
                      </button>
                      <button className="row-btn" aria-label={`重建 ${c.name} 的网页`} onClick={() => call("startRefreshWeb", { slug: c.slug }).then(() => toast("重建任务已加入任务中心")).catch((e: Error) => toast(e.message, true))}>
                        <RefreshCw size={13} /> <span>重建</span>
                      </button>
                      <button className="row-btn" aria-label={`定位 ${c.name} 的目录`} onClick={() => call("revealChat", { slug: c.slug }).catch((e: Error) => toast(e.message, true))}>
                        <FolderOpen size={13} /> <span>定位</span>
                      </button>
                      <button className="row-btn danger" aria-label={`删除 ${c.name}`} onClick={() => removeChat(c)}>
                        <Trash2 size={13} /> <span>删除</span>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <div className="home-grid library-bottom">
        <section className="panel library-location-card">
          <div className="panel-head">
            <h3>当前档案库</h3>
            <span className="meta">{chats.length} 个聊天</span>
          </div>
          <div className="library-location">
            <div className="library-folder"><Database size={22} /></div>
            <div className="library-paths">
              <div className="library-path-row">
                <div>
                  <span>根目录</span>
                  <code title={boot?.libraryRoot}>{boot?.libraryRoot || "未配置"}</code>
                </div>
                <button className="icon-btn" title="复制根目录" aria-label="复制根目录" onClick={() => copyText(boot?.libraryRoot || "", "根目录")}>
                  <Copy size={13} />
                </button>
              </div>
              <div className="library-path-row">
                <div>
                  <span>配置文件</span>
                  <code title={boot?.configPath}>{boot?.configPath || "--"}</code>
                </div>
                <button className="icon-btn" title="复制配置文件路径" aria-label="复制配置文件路径" onClick={() => copyText(boot?.configPath || "", "配置文件路径")}>
                  <Copy size={13} />
                </button>
              </div>
            </div>
          </div>
        </section>

        <section className="panel library-recent-card">
          <div className="panel-head">
            <h3>最近使用</h3>
            <span className="meta">点击切换</span>
          </div>
          {history.length === 0 ? (
            <div className="chart-empty">还没有历史记录。</div>
          ) : (
            <div className="recent-libraries">
              {history.map((root) => (
                <button key={root} onClick={() => switchTo(root)} className={root === boot?.libraryRoot ? "on" : ""}>
                  <span className="folder-badge"><FolderOpen size={14} /></span>
                  <span className="library-path" title={root}>{root}</span>
                  {root === boot?.libraryRoot && <span className="current-badge">当前</span>}
                </button>
              ))}
            </div>
          )}
        </section>
      </div>

      {remoteOpen && createPortal(
        <div className="remote-dialog-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) closeRemote(); }}>
          <div ref={remoteDialog} className="remote-modal remote-workspace" role="dialog" aria-modal="true" aria-labelledby="remote-title" onKeyDown={(event) => {
            if (event.defaultPrevented || !event.currentTarget.contains(event.target as Node)) return;
            if (event.key === "Escape") { event.preventDefault(); closeRemote(); }
            if (event.key !== "Tab") return;
            const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), [href], [tabindex='0']")).filter((item) => item.getClientRects().length > 0);
            const first = items[0];
            const last = items.at(-1);
            if (event.shiftKey && event.target === first && last) { event.preventDefault(); last.focus(); }
            if (!event.shiftKey && event.target === last && first) { event.preventDefault(); first.focus(); }
          }}>
            <div className="remote-head">
              <div className="remote-title">
                {remoteMode === "add" && <button type="button" className="icon-btn remote-header-action" aria-label="返回已保存的连接" title="返回已保存的连接" disabled={remoteFormBusy} onClick={() => showRemoteMode("saved")}><ChevronLeft size={16} /></button>}
                <h2 id="remote-title" tabIndex={-1}>{remoteMode === "saved" ? "网络位置" : "添加网络连接"}</h2>
              </div>
              <button type="button" className="icon-btn remote-header-action" aria-label="关闭网络位置" disabled={sshAction === "install" || sshAction === "switch" || rcloneBusy || remoteTesting || connectionBusy || busy === "switch" || !!pendingPublishSwitch} onClick={closeRemote}>
                <X size={16} />
              </button>
            </div>
            <div className="remote-body" key={remoteMode}>
              {remote && remoteMode === "saved" && (
                <div className={`remote-current ${remote.remote ? "is-remote" : ""} ${remote.reachable ? "" : "is-offline"}`}>
                  <span className="remote-current-icon"><Database size={16} /></span>
                  <div>
                    <b>当前档案库</b>
                    <span title={remote.root}>{remote.root}</span>
                  </div>
                  <em>{pathKindLabel(remote.kind)}</em>
                  {remote.remote && remote.reachable && (
                    <span className="remote-current-meta">{remote.latencyMs} ms · {remote.freeKnown ? `${bytes(remote.freeBytes)} 可用` : "空间未知"}</span>
                  )}
                  {!remote.reachable && <span className="remote-current-meta warn">{remote.error || "不可访问"}</span>}
                  {remote.remote && remote.cacheBytes > 0 && (
                    <button className="btn sm ghost" onClick={() => void clearRemoteCache()}>
                      清理缓存 {bytes(remote.cacheBytes)}
                    </button>
                  )}
                </div>
              )}

              {remoteMode === "saved" ? (
                <RemoteConnections onAdd={() => showRemoteMode("add")} onConnected={remoteConnected} onBusy={setConnectionBusy}
                  onPasswordConnection={(item) => {
                    setSSHAlias(""); setSSHTarget(item.sshHost ?? ""); setSSHUser(item.sshUser ?? ""); setSSHPort(String(item.sshPort ?? 22));
                    setSSHPassword(""); resetSSHTest(); setSSHHostKey(item.sshKey ?? ""); setSSHSavedPath(item.path);
                    setRemoteSave(false); setRemoteSaveAuto(false); setSSHOpen(true); setRcloneOpen(false); showRemoteMode("add");
                  }} toast={toast} />
              ) : <>
              <div className="remote-methods" role="group" aria-label="连接方式">
                <button type="button" className={`remote-method ${!sshOpen && !rcloneOpen ? "selected" : ""}`} aria-pressed={!sshOpen && !rcloneOpen} disabled={remoteFormBusy} onClick={() => { clearSSHPassword(); setSSHOpen(false); setRcloneOpen(false); }}><Network size={15} />SMB / 网络盘</button>
                <button type="button" className={`remote-method ${sshOpen ? "selected" : ""}`} aria-label="SSH 连接" aria-pressed={sshOpen} disabled={remoteFormBusy} onClick={() => { setSSHOpen(true); setRcloneOpen(false); }}><Server size={15} />SSH / SFTP</button>
                <button type="button" className={`remote-method ${rcloneOpen ? "selected" : ""}`} aria-label="rclone 连接" aria-pressed={rcloneOpen} disabled={remoteFormBusy} onClick={() => { clearSSHPassword(); setRcloneOpen(true); setSSHOpen(false); }}><Cloud size={15} />rclone</button>
              </div>

              {!sshOpen && !rcloneOpen && <>
              <div className="remote-form">
                <label htmlFor="remote-path-input">网络位置或盘符</label>
                <div className="remote-path-row">
                  <input
                    id="remote-path-input"
                    value={remotePath}
                    disabled={remoteFormBusy}
                    onChange={(e) => { setRemotePath(e.target.value); setRemoteProbe(null); setRemoteError(""); }}
                    onKeyDown={(e) => { if (e.key === "Enter" && !remoteTesting) void testRemote(); }}
                    placeholder="\\NAS\share\TG Library 或 Z:\TG Library"
                    spellCheck={false}
                  />
                  <button
                    className="btn ghost"
                    disabled={remoteFormBusy}
                    onClick={async () => {
                      try {
                        const picked = await pickFolder("remote-library", "选择网络位置或盘符");
                        if (picked) { setRemotePath(picked); setRemoteProbe(null); setRemoteError(""); }
                      } catch (e) {
                        setRemoteError((e as Error).message);
                      }
                    }}
                  >
                    <FolderOpen size={13} /> 浏览…
                  </button>
                </div>
              </div>

              {remoteProbe && (
                <div className={`remote-probe ${remoteProbe.reachable && remoteProbe.writable ? "ok" : "bad"}`} role="status">
                  <span className="remote-probe-icon">
                    {remoteProbe.reachable && remoteProbe.writable ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
                  </span>
                  <div>
                    <b>{remoteProbe.reachable && remoteProbe.writable ? "连接正常，可以切换" : remoteProbe.reachable ? "位置只读，暂时无法作为档案库" : "无法访问此位置"}</b>
                    <span>{pathKindLabel(remoteProbe.kind)} · {remoteProbe.latencyMs} ms{remoteProbe.freeKnown ? ` · ${bytes(remoteProbe.freeBytes)} 可用` : " · 空间未知"}</span>
                    {remoteProbe.error && <em>{remoteProbe.error}</em>}
                    {remoteProbe.reachable && !remoteProbe.writable && <span>请检查目录写入权限，再重新测试连接。</span>}
                  </div>
                </div>
              )}
              </>}
              {remoteError && <div className="plan-inline-notice" role="alert"><AlertTriangle size={15} /><span>{remoteError}</span></div>}
              {!sshOpen && sshError && <div className="plan-inline-notice" role="alert"><AlertTriangle size={15} /><span>{sshError}</span></div>}

              {(sshOpen || rcloneOpen) && !remoteTools && <div className="plan-inline-notice" role={remoteToolsError ? "alert" : "status"}>{remoteToolsError ? <AlertTriangle size={14} /> : <Loader2 size={14} className="spin" />}<span>{remoteToolsError || "正在检查连接组件…"}</span>{remoteToolsError && <button type="button" className="btn sm ghost" onClick={readRemoteTools}>重新检查</button>}</div>}
              {rcloneOpen && remoteTools && (!remoteTools.rclone || !remoteTools.winFsp || !remoteTools.rcloneRemotes?.length) && <>
                <div className="remote-option">
                  <span className="remote-option-icon"><Cloud size={17} /></span>
                  <div className="remote-option-main">
                    <b>rclone + WinFsp <em>通用</em></b>
                    <span>WebDAV、SFTP、S3、OneDrive、Google Drive 等几十种后端；适合非 SMB 的网盘或对象存储。</span>
                    <div className="remote-tool-state">
                      <em className={remoteTools?.rclone ? "ok" : ""}>rclone {remoteTools?.rclone ? "已安装" : "未检测到"}</em>
                      <em className={remoteTools?.winFsp ? "ok" : ""}>WinFsp {remoteTools?.winFsp ? "已安装" : "未检测到"}</em>
                    </div>
                    {remoteTools?.rclone && !remoteTools.rcloneRemotes?.length && (
                      <span>已安装，但还没有 remote；先运行 <code>rclone config</code> 创建。</span>
                    )}
                  </div>
                  {remoteTools.rclone && remoteTools.winFsp && !remoteTools.rcloneRemotes?.length ? (
                    <button className="btn sm ghost" onClick={() => copyRemoteCommand("rclone config")}>
                      <Copy size={12} /> 配置 remote
                    </button>
                  ) : (!remoteTools.rclone || !remoteTools.winFsp) ? (
                    <button className="btn sm ghost" onClick={() => copyRemoteCommand(remoteTools?.winFsp ? "winget install Rclone.Rclone" : "winget install Rclone.Rclone\nwinget install WinFsp.WinFsp")}>
                      <Copy size={12} /> 复制安装命令
                    </button>
                  ) : null}
                </div>
              </>}
              {sshOpen && remoteTools && (
                <form id="remote-ssh-form" className="rclone-form remote-ssh-form" onSubmit={(event) => {
                  event.preventDefault();
                  if (!remoteFormBusy) void (sshDirectory?.library ? mountSSH() : browseSSH(sshSavedPath));
                }}>
                  {!remoteTools.rclone || !remoteTools.winFsp ? (
                    <div className="ssh-tools-card">
                      <div className="rclone-form-head"><b>安装挂载组件</b><span>需要 {[!remoteTools.rclone && "rclone", !remoteTools.winFsp && "WinFsp"].filter(Boolean).join("、")}</span></div>
                      {remoteTools.winget ? <button type="button" className="btn primary" disabled={Boolean(sshAction)} onClick={() => void installSSHMountTools()}>
                        {sshAction === "install" && <Loader2 size={13} className="spin" />} {sshAction === "install" ? "正在安装…" : "安装组件"}
                      </button> : <p role="status">请先启用 Windows WinGet。</p>}
                    </div>
                  ) : <>
                    {remoteTools.openSSH && !!remoteTools.sshAliases?.length && <div className="ssh-mode" role="group" aria-label="SSH 连接方式">
                      <button type="button" aria-pressed={!sshAlias} disabled={remoteFormBusy} onClick={() => {
                        if (!sshAlias) return;
                        clearSSHPassword(); resetSSHTest(); setSSHAlias(""); setRemoteSaveAuto(false);
                      }}><KeyRound size={16} /> 地址与密码</button>
                      <button type="button" aria-pressed={!!sshAlias} disabled={remoteFormBusy} onClick={() => {
                        if (sshAlias) return;
                        clearSSHPassword(); resetSSHTest(); setSSHAlias(remoteTools.sshAliases![0]);
                      }}><Server size={16} /> 已有 SSH 配置</button>
                    </div>}
                    {sshAlias && <div className="rclone-field ssh-alias-field">
                      <span>SSH 主机</span>
                      <Select ariaLabel="SSH 主机配置" value={sshAlias} disabled={remoteFormBusy} onChange={(value) => {
                        resetSSHTest(); setSSHAlias(value);
                      }} options={(remoteTools.sshAliases ?? []).map((alias) => ({ value: alias, label: alias }))} />
                    </div>}
                    {!sshAlias && <div className="ssh-credentials">
                      <label className="rclone-field"><span>服务器地址</span><input value={sshTarget} onChange={(e) => { setSSHTarget(e.target.value); setSSHHostKey(""); setSSHSavedPath(""); resetSSHTest(); }} disabled={remoteFormBusy} placeholder="IP 地址或主机名" autoComplete="off" spellCheck={false} /></label>
                      <label className="rclone-field"><span>SSH 端口</span><input value={sshPort} onChange={(e) => { setSSHPort(e.target.value); setSSHHostKey(""); setSSHSavedPath(""); resetSSHTest(); }} disabled={remoteFormBusy} type="number" min={1} max={65535} /></label>
                      <label className="rclone-field"><span>用户名</span><input value={sshUser} onChange={(e) => { setSSHUser(e.target.value); resetSSHTest(); }} disabled={remoteFormBusy} placeholder="服务器的 SSH 账号" autoComplete="off" spellCheck={false} /></label>
                      <label className="rclone-field"><span>密码</span><input type="password" value={sshPassword} onChange={(e) => { setSSHPassword(e.target.value); resetSSHTest(); }} disabled={remoteFormBusy} placeholder="SSH 登录密码" autoComplete="off" /></label>
                    </div>}
                    <div className="ssh-test-row">
                      <span>{sshDirectory ? "SFTP 已连通" : "服务器需启用 SSH 和 SFTP"}</span>
                      <button type="button" className={`btn ${sshDirectory ? "ghost" : "primary"}`} disabled={remoteFormBusy || !sshCanTest} onClick={() => void browseSSH(sshDirectory?.path || sshSavedPath)}>
                        {sshAction === "test" ? <Loader2 size={14} className="spin" /> : <Wifi size={14} />} {sshDirectory ? "重新测试" : "测试连接"}
                      </button>
                    </div>
                    {sshTrust && <div className="plan-inline-notice ssh-host-trust" role="status">
                      <AlertTriangle size={16} /><span><b>核对服务器主机指纹后再继续</b><code>{sshTrust.type} {sshTrust.fingerprint}</code></span>
                      <button type="button" className="btn" disabled={remoteFormBusy} onClick={() => { const key = sshTrust.key; setSSHTrust(null); void browseSSH(sshSavedPath, key); }}>信任并测试</button>
                    </div>}
                    {sshDirectory && <section className="ssh-browser" aria-label="远程档案库目录" aria-busy={sshAction === "test"}>
                      <div className="ssh-browser-head"><b>选择档案库目录</b>{sshDirectory.library && <span><CheckCircle2 size={13} /> 已识别档案库</span>}</div>
                      <div className="ssh-path"><button type="button" className="icon-btn" aria-label="上一级目录" title="上一级目录" disabled={remoteFormBusy || sshDirectory.path === "/"} onClick={() => void browseSSH(sshDirectory.path.slice(0, sshDirectory.path.lastIndexOf("/")) || "/")}><ChevronLeft size={16} /></button>
                        <code title={sshDirectory.path}>{sshDirectory.path}</code></div>
                      <div className="ssh-folders">{sshDirectory.folders.length ? sshDirectory.folders.map((name) => <button type="button" key={name} disabled={remoteFormBusy} onClick={() => void browseSSH(`${sshDirectory.path === "/" ? "" : sshDirectory.path}/${name}`)}><FolderOpen size={15} /><span>{name}</span><ChevronRight size={14} /></button>) : <p>没有子目录</p>}</div>
                    </section>}
                  </>}
                  {sshError && <p role="alert">{sshError}</p>}
                </form>
              )}
              {rcloneOpen && remoteTools?.rclone && remoteTools.winFsp && !!remoteTools.rcloneRemotes?.length && (
                <div className="rclone-form">
                  <div className="rclone-fields">
                    <div className="rclone-field grow">
                      <span>Remote</span>
                      <Select
                        ariaLabel="选择 rclone remote"
                        value={rcloneRemote}
                        disabled={remoteFormBusy}
                        onChange={setRcloneRemote}
                        options={(remoteTools?.rcloneRemotes || []).map((r) => ({ value: r, label: r }))}
                      />
                    </div>
                    <div className="rclone-field grow">
                      <span>子路径</span>
                      <input value={rcloneSub} disabled={remoteFormBusy} onChange={(e) => setRcloneSub(e.target.value)} placeholder="TG Library（可留空）" spellCheck={false} aria-label="rclone 子路径" />
                    </div>
                    <div className="rclone-field drive">
                      <span>盘符</span>
                      <input value={rcloneDrive} disabled={remoteFormBusy} onChange={(e) => setRcloneDrive(e.target.value.slice(0, 2).toUpperCase())} placeholder="Z" maxLength={2} spellCheck={false} aria-label="rclone 挂载盘符" />
                    </div>
                  </div>
                </div>
              )}
              {(!sshOpen && !rcloneOpen || sshOpen && !!sshDirectory?.library || rcloneOpen && remoteTools?.rclone && remoteTools.winFsp && !!remoteTools.rcloneRemotes?.length) && <div className="remote-connect-options">
                {remoteSave && <div className="remote-save-fields">
                  <label className="field"><span>连接名称（可选）</span><input type="text" value={remoteLabel} maxLength={100} disabled={remoteFormBusy} onChange={(e) => setRemoteLabel(e.target.value)} placeholder="例如：家里的 NAS" /></label>
                  {sshOpen && !sshAlias ? <p className="muted">保存地址和目录，下次连接时重新输入密码。</p> :
                    <label className="plan-check"><input type="checkbox" checked={remoteSaveAuto} disabled={remoteFormBusy} onChange={(e) => setRemoteSaveAuto(e.target.checked)} /> 此库为当前库时随 TAK 启动自动重连</label>}
                </div>}
                <div className="remote-connect-footer">
                  <button type="button" className="btn remote-save-toggle" aria-pressed={remoteSave} disabled={remoteFormBusy || sshOpen && !!sshError} onClick={() => setRemoteSave((value) => !value)}><Bookmark size={14} /> 保存此连接</button>
                  <div className="remote-form-actions">
                    {!sshOpen && !rcloneOpen && <>
                      <button type="button" className="btn" disabled={remoteFormBusy || !remotePath.trim()} onClick={() => void testRemote()}>
                        {remoteTesting ? <Loader2 size={13} className="spin" /> : <Wifi size={13} />}
                        {remoteTesting ? "正在测试…" : "测试连接"}
                      </button>
                      <button type="button" className="btn primary" disabled={remoteFormBusy || !remoteProbe || !remoteProbe.reachable || !remoteProbe.writable} onClick={() => void useRemote()}>
                        {busy === "switch" ? <Loader2 size={13} className="spin" /> : remoteProbe?.reachable && remoteProbe.writable ? <CheckCircle2 size={13} /> : <WifiOff size={13} />}
                        {busy === "switch" ? "正在切换…" : remoteSave ? "连接并保存" : "切换到此库"}
                      </button>
                    </>}
                    {sshOpen && <button type="submit" form="remote-ssh-form" className="btn primary" disabled={remoteFormBusy || !!sshError || !sshDirectory?.library}>
                      {sshAction && <Loader2 size={13} className="spin" />} {sshAction === "connect" ? "正在连接…" : sshAction === "switch" ? "正在切换…" : remoteSave ? "连接并保存" : "连接并使用"}
                    </button>}
                    {rcloneOpen && <button type="button" className="btn primary" disabled={remoteFormBusy || !rcloneRemote} onClick={() => void mountRclone()}>
                      {rcloneBusy ? <Loader2 size={13} className="spin" /> : <Network size={13} />}
                      {rcloneBusy ? "挂载中…" : "挂载并测试"}
                    </button>}
                  </div>
                </div>
              </div>}
              </>}
            </div>
          </div>
        </div>,
        document.body
      )}

      {detailChat && detailLibraryKey === boot?.libraryKey && createPortal(
        <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setDetailChat(null); }}>
          <div className="modal chat-detail-modal" role="dialog" aria-modal="true" aria-labelledby="chat-detail-title">
            <div className="chat-detail-head">
              <span className="avatar lg">{detailChat.name.slice(0, 1)}</span>
              <div className="chat-detail-id">
                <h2 id="chat-detail-title">{detailChat.name}</h2>
                <p>{detailChat.type || "聊天"} · ID {detailChat.id || "--"}</p>
              </div>
              <button className="icon-btn lg" aria-label="关闭聊天详情" onClick={() => setDetailChat(null)}>
                <X size={15} />
              </button>
            </div>

            <div className="chat-detail-grid">
              <div className="chat-detail-tile"><span>Chat ID</span><b className="mono">{detailChat.id || "--"}</b></div>
              <div className="chat-detail-tile"><span>工作区目录</span><b className="mono" title={detailChat.dir}>{detailChat.slug}</b></div>
              <div className="chat-detail-tile"><span>消息</span><b>{detailChat.messages.toLocaleString()}</b></div>
              <div className="chat-detail-tile">
                <span>媒体文件</span>
                <b>{detailChat.mediaReady ? detailChat.media.toLocaleString() : "待核对"}{detailChat.missing > 0 && <em> · 缺 {detailChat.missing}</em>}</b>
              </div>
              <div className="chat-detail-tile"><span>最早消息</span><b>{dateTime(detailChat.firstTs)}</b></div>
              <div className="chat-detail-tile"><span>最新消息</span><b>{dateTime(detailChat.lastTs)}</b></div>
              <div className="chat-detail-tile"><span>最近更新</span><b>{dateTime(detailChat.updatedAt)}</b></div>
              <div className="chat-detail-tile"><span>网页</span><b>{detailChat.pages} 页</b></div>
              <div className="chat-detail-tile"><span>官方 ChatExport</span><b>{detailChat.official} 份</b></div>
              <div className="chat-detail-tile"><span>生成器</span><b>TelegramArchiveKit {ctx.boot?.version || "3.0"}</b></div>
            </div>

            <div className="chat-detail-media">
              <div className="chat-detail-media-head">
                <span><HardDrive size={13} /> 媒体占用</span>
                <b>{detailChat.mediaReady ? bytes(detailChat.totalBytes ?? 0) : "待核对"}</b>
                <em>{detailChat.mediaReady ? `共 ${detailChat.media.toLocaleString()} 个` : "正在读取统计"}</em>
              </div>
              <MediaTypeGrid row={detailChat} />
              {(detailMediaLoading || detailMediaStale || detailMediaError || detailMediaCancelled) && <div className="chat-detail-media-status" role="status">
                {detailMediaLoading ? "正在读取媒体统计…" : detailMediaCancelled ? "已取消读取媒体统计。" : detailMediaError ? `读取媒体统计失败：${detailMediaError}` : "显示已保存的媒体快照，数据可能已变化。"}
                {detailMediaLoading ? <button className="btn sm ghost" onClick={() => { detailRequest.current?.abort(); detailRequest.current = null; setDetailMediaLoading(false); setDetailMediaCancelled(true); }}>取消读取</button>
                  : <button className="btn sm ghost" onClick={() => { detailRefreshNext.current = detailMediaStale; setDetailReload((n) => n + 1); }}>{detailMediaStale && !detailMediaCancelled ? "重新核对" : "重试"}</button>}
              </div>}
            </div>

            <div className="chat-detail-actions">
              <button className="btn ghost" onClick={() => copyText(detailChat.dir, "归档目录")}>
                <Copy size={12} /> 复制路径
              </button>
              <button className="btn ghost" onClick={() => call("revealChat", { slug: detailChat.slug }).catch((e: Error) => toast(e.message, true))}>
                <FolderOpen size={12} /> 打开目录
              </button>
              <button className="btn ghost" onClick={() => verifyChat(detailChat)}>
                <ShieldCheck size={12} /> 核对完整性
              </button>
              <button className="btn ghost" onClick={() => call("startRefreshWeb", { slug: detailChat.slug }).then(() => toast("重建任务已加入任务中心")).catch((e: Error) => toast(e.message, true))}>
                <RefreshCw size={12} /> 重建网页
              </button>
              <button className="btn danger" onClick={() => removeChat(detailChat)}>
                <Trash2 size={12} /> 删除归档
              </button>
              <span className="spacer" />
              <button className="btn primary" onClick={() => openChat(detailChat.slug)}>
                <ArrowUpRight size={12} /> 打开聊天
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {official && createPortal(
        <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && busy !== "official") setOfficial(null); }}>
          <div className="modal official-import-modal" role="dialog" aria-modal="true" aria-labelledby="official-import-title">
            <div className="task-modal-head">
              <div>
                <h2 id="official-import-title">导入官方 ChatExport</h2>
                <p className="modal-sub">确认目标聊天与导入方式后开始分析并建立索引。</p>
              </div>
              <button className="icon-btn" aria-label="关闭官方导入" disabled={busy === "official"} onClick={() => setOfficial(null)}>
                <X size={15} />
              </button>
            </div>

            <div className="official-import-summary">
              <b>{official.meta.name}</b>
              <span>
                {official.meta.messageCount.toLocaleString()} 条消息 · {official.meta.mediaMessages.toLocaleString()} 条含媒体 · {official.meta.mediaFiles.toLocaleString()} 个文件 · {bytes(official.meta.totalBytes)}
              </span>
              <div className="official-import-stats">
                <span><Images size={12} /> 图片 <b>{official.meta.images.toLocaleString()}</b></span>
                <span><Video size={12} /> 视频 <b>{official.meta.videos.toLocaleString()}</b></span>
                <span><Music size={12} /> 音频 <b>{official.meta.audio.toLocaleString()}</b></span>
                <span><FileText size={12} /> 文件 <b>{official.meta.files.toLocaleString()}</b></span>
              </div>
              <code title={official.meta.root}>{official.meta.root}</code>
            </div>

            <label className="official-import-field">
              <span>导入到</span>
              <Select
                ariaLabel="官方导出导入目标"
                value={target}
                onChange={setTarget}
                options={[{ value: "", label: "创建为新聊天" }, ...official.chats.map((c) => ({ value: c.slug, label: "合并到：" + c.name }))]}
              />
            </label>

            <div className="official-mode-field">
              <div className="official-mode-head">
                <span>导入方式</span>
                <span
                  className="official-help"
                  data-tip="纳管：移动到档案库统一管理，推荐；复制：保留原目录，额外占用空间；引用：不复制也不移动，但原目录之后不能改名或移动。"
                  aria-label="导入方式说明"
                >
                  <Info size={13} />
                </span>
              </div>
              <div className="official-mode-grid">
                {[
                  ["managed", "纳管", "移动到档案库统一管理（推荐）"],
                  ["copy", "复制", "复制到档案库，原目录可保留"],
                  ["reference", "引用原目录", "不复制，原目录不可移动"],
                ].map(([value, label, desc]) => (
                  <button
                    key={value}
                    type="button"
                    className={mode === value ? "on" : ""}
                    onClick={() => setMode(value)}
                  >
                    <b>{label}</b>
                    <small>{desc}</small>
                  </button>
                ))}
              </div>
            </div>

            <div className="modal-actions">
              <button className="btn ghost" disabled={busy === "official"} onClick={() => setOfficial(null)}>取消</button>
              <button className="btn primary" disabled={busy === "official"} onClick={() => void confirmOfficial()}>
                {busy === "official" ? <Loader2 size={12} className="spin" /> : <Download size={12} />}
                {busy === "official" ? "正在加入…" : "开始导入"}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      <ConfirmDialog
        open={Boolean(pendingPublishSwitch)}
        compact
        title="停止网页部署并切换档案库？"
        message="当前网页地址会关闭，正在浏览的设备将断开。"
        confirmLabel="停止并切换"
        onConfirm={() => { const pending = pendingPublishSwitch; setPendingPublishSwitch(null); if (pending) void switchTo(pending.root, true, pending.options); }}
        onCancel={() => setPendingPublishSwitch(null)}
      />
      <ConfirmDialog
        open={pendingDelete.length > 0}
        title={pendingDelete.length === 1 ? `删除本地归档「${pendingDelete[0]?.name}」？` : `删除选中的 ${pendingDelete.length} 个本地归档？`}
        message="只删除档案库副本，Telegram 云端不受影响，且无法从 TAK 撤销。"
        confirmLabel={pendingDelete.length === 1 ? "删除归档" : "全部删除"}
        danger
        onConfirm={() => void runDelete()}
        onCancel={() => setPendingDelete([])}
      />
    </>
  );
}

/* ============================= Settings ============================ */
interface SettingsForm {
  libraryRoot: string;
  concurrent: number;
  threads: number;
  proxy: string;
  networkRetryMinutes: number;
  unknownRetryCount: number;
  generateThumbnails: boolean;
  stallTimeoutSeconds: number;
  stalledFileRetries: number;
  transferAdjustment: string;
  reconnectTimeout: string;
  maxRepairPasses: number;
  openAfterBuild: boolean;
  tdlNamespace: string;
  videoSeekSeconds: number;
  videoLongPressRate: number;
  videoLongPressDelayMs: number;
  videoMaxVolume: number;
  videoVolumeStep: number;
  videoFrameAspect: string;
  speedWindowSeconds: number;
  viewerBackdrop: string;
  toastSeconds: number;
  version: string;
}

function SettingsField({ label, hint, children, wide, liveHint }: { label: string; hint?: string; children: ReactNode; wide?: boolean; liveHint?: boolean }) {
  return (
    <div className={`field ${wide ? "wide" : ""}`}>
      <label>{label}</label>
      <div className="field-control">{children}</div>
      {hint && <span className="hint" aria-live={liveHint ? "polite" : undefined}>{hint}</span>}
    </div>
  );
}

function SettingsToggle({ checked, onChange, title, desc, disabled = false }: { checked: boolean; onChange: (v: boolean) => void; title: string; desc: string; disabled?: boolean }) {
  return (
    <label className="switch-row">
      <span>
        <b>{title}</b>
        <em>{desc}</em>
      </span>
      <span className={`switch ${checked ? "on" : ""}`}>
        <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <i />
      </span>
    </label>
  );
}

function SyncPlanStartupSettings({ toast }: { toast: PageCtx["toast"] }) {
  type Startup = { launchOnLogin: boolean; launchOnLoginError?: string };
  const [data, setData] = useState<Startup | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void call<Startup>("syncPlanList", undefined, controller.signal).then((result) => {
      if (!controller.signal.aborted) setData(result);
    }).catch((e: Error) => {
      if (!controller.signal.aborted) setError(e.message);
    });
    return () => controller.abort();
  }, [retry]);

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    try {
      const result = await call<Startup>("syncPlanSetLaunchOnLogin", { enabled });
      setData(result);
      if (!result.launchOnLoginError) toast(enabled ? "已开启登录 Windows 后启动" : "已关闭登录 Windows 后启动");
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  return <section className="settings-card plan-startup">
    <header><div><h3>启动与后台</h3></div></header>
    <SettingsToggle checked={!!data?.launchOnLogin} disabled={busy || !data || !!data.launchOnLoginError}
      onChange={(enabled) => void toggle(enabled)} title="登录 Windows 后自动启动 TAK"
      desc="让同步计划随客户端启动恢复调度。此设置即时生效。" />
    {(error || data?.launchOnLoginError) && <div className="plan-startup-error plan-inline-notice" role="alert">
      <span>{error || data?.launchOnLoginError}</span>
      <button type="button" className="btn sm ghost" onClick={() => { setError(""); setRetry((value) => value + 1); }}>重新读取</button>
    </div>}
  </section>;
}

export function SettingsPage({ ctx }: { ctx: PageCtx }) {
  const { toast, applyPrefs, setToastSeconds } = ctx;
  const libraryKey = ctx.boot?.libraryKey ?? "";
  const libraryKind = ctx.boot?.libraryKind ?? "unknown";
  const [browsePolicy, setBrowsePolicy] = useBrowsePolicy(libraryKey);
  const [policyDraft, setPolicyDraft] = useState<{ key: string; value: BrowsePolicy } | null>(null);
  const selectedPolicy = policyDraft?.key === libraryKey ? policyDraft.value : browsePolicy;
  const mediaPageSize = useSyncExternalStore(subscribeMediaPageSize, readMediaPageSize);
  const policyEffective = browsePerformanceMode(browsePolicy, libraryKind) ? "性能优先" : "体验优先";
  const libraryKindLabel = libraryKind === "local" ? "本地库" : libraryKind === "remote" ? "网络库" : "库位置类型未知";
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [original, setOriginal] = useState<SettingsForm | null>(null);
  const [saving, setSaving] = useState(false);

  const load = () =>
    call<SettingsForm>("getSettings")
      .then((data) => {
        setForm(data);
        setOriginal(data);
        setPolicyDraft(null);
      })
      .catch((e: Error) => toast(e.message, true));
  useEffect(() => {
    load();
  }, []);

  if (!form) {
    return (
      <section className="settings-card settings-loading">
        <header><div><h3>正在读取设置</h3><p>正在读取本机配置与可用参数…</p></div></header>
        <div className="account-skeleton">
          {Array.from({ length: 6 }).map((_, i) => <div key={i}><span className="skeleton-line w-80" /><span className="skeleton-line w-260" /></div>)}
        </div>
      </section>
    );
  }

  const formDirty = original ? JSON.stringify(form) !== JSON.stringify(original) : false;
  const policyDirty = selectedPolicy !== browsePolicy;
  const dirty = formDirty || policyDirty;
  const set = <K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) => setForm((f) => (f ? { ...f, [key]: value } : f));

  const save = async () => {
    setSaving(true);
    try {
      if (formDirty) {
        const next = await call<SettingsForm>("setSettings", { settings: form });
        setForm(next);
        setOriginal(next);
        applyPrefs({
          seekSeconds: next.videoSeekSeconds,
          longPressRate: next.videoLongPressRate,
          longPressDelayMs: next.videoLongPressDelayMs,
          maxVolume: next.videoMaxVolume,
          volumeStep: next.videoVolumeStep,
          videoFrameAspect: next.videoFrameAspect || "original",
          speedWindowSeconds: next.speedWindowSeconds,
          backdrop: next.viewerBackdrop || "ambient",
        });
        setToastSeconds(next.toastSeconds);
      }
      if (policyDirty && !setBrowsePolicy(selectedPolicy)) {
        toast("无法保存媒体浏览策略，请检查本机存储。", true);
        return;
      }
      setPolicyDraft(null);
      toast("设置已保存", "success");
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>系统设置</h1>
          <p>下载参数会用于下一轮同步；保存后立即写入配置文件</p>
        </div>
        <div className="actions">
          <button className="btn ghost" onClick={load} disabled={saving}>
            <RotateCcw size={13} /> 重新读取
          </button>
          <button className="btn primary" onClick={save} disabled={saving || !dirty}>
            <Save size={13} /> {saving ? "正在保存…" : dirty ? "保存设置" : "已保存"}
          </button>
        </div>
      </div>

      <SyncPlanStartupSettings toast={toast} />

      <section className="settings-card">
        <header>
          <div>
            <h3>下载性能</h3>
            <p>默认 2 × 4 是 Telegram 友好的稳定参数；过高容易触发限流或卡死。</p>
          </div>
          <span className="settings-badge">并发 × 线程</span>
        </header>
        <div className="settings-grid">
          <SettingsField label="并发文件任务" hint="同时下载多少个文件（1–8）">
            <input type="number" min={1} max={8} value={form.concurrent} onChange={(e) => set("concurrent", Number(e.target.value))} />
          </SettingsField>
          <SettingsField label="单文件线程" hint="一个文件内部并行分片数（1–16）">
            <input type="number" min={1} max={16} value={form.threads} onChange={(e) => set("threads", Number(e.target.value))} />
          </SettingsField>
          <SettingsField label="重试传输策略" hint="反复卡住时如何调整并发参数">
            <Select
              ariaLabel="重试传输策略"
              value={form.transferAdjustment}
              onChange={(v) => set("transferAdjustment", v)}
              options={[
                { value: "increase", label: "逐步增加线程（推荐）" },
                { value: "increase-both", label: "线程和并发一起增加（试验）" },
                { value: "decrease", label: "逐步降低线程" },
                { value: "keep", label: "保持原配置" },
              ]}
            />
          </SettingsField>
          <SettingsField label="最大修复轮数" hint="一次同步中最多进行几轮补漏（1–10）">
            <input type="number" min={1} max={10} value={form.maxRepairPasses} onChange={(e) => set("maxRepairPasses", Number(e.target.value))} />
          </SettingsField>
        </div>
      </section>

      <section className="settings-card">
        <header>
          <div>
            <h3>网络与稳定性</h3>
            <p>网络波动时的恢复窗口与看门狗；遇到大面积卡死可先恢复默认再排查代理。</p>
          </div>
        </header>
        <div className="settings-grid">
          <SettingsField label="网络自动恢复窗口（分钟）" hint="网络断开后持续尝试的时间（1–180）">
            <input type="number" min={1} max={180} value={form.networkRetryMinutes} onChange={(e) => set("networkRetryMinutes", Number(e.target.value))} />
          </SettingsField>
          <SettingsField label="未知错误自动重试" hint="非网络类错误的自动重试次数（0–10）">
            <input type="number" min={0} max={10} value={form.unknownRetryCount} onChange={(e) => set("unknownRetryCount", Number(e.target.value))} />
          </SettingsField>
          <SettingsField label="无进展暂缓阈值（秒）" hint="多久没有真实进度就把文件暂缓（30–600）">
            <input type="number" min={30} max={600} value={form.stallTimeoutSeconds} onChange={(e) => set("stallTimeoutSeconds", Number(e.target.value))} />
          </SettingsField>
          <SettingsField label="疑难文件重试次数" hint="对反复卡住的文件最多重试几次（1–10）">
            <input type="number" min={1} max={10} value={form.stalledFileRetries} onChange={(e) => set("stalledFileRetries", Number(e.target.value))} />
          </SettingsField>
          <SettingsField label="代理" hint="留空表示系统 / TUN / 直连；示例 socks5://127.0.0.1:1080">
            <input type="text" value={form.proxy} placeholder="留空表示系统 / TUN / 直连" onChange={(e) => set("proxy", e.target.value)} />
          </SettingsField>
          <SettingsField label="重连超时" hint="tdl 的连接重建等待时间，例如 5m">
            <input type="text" value={form.reconnectTimeout} onChange={(e) => set("reconnectTimeout", e.target.value)} />
          </SettingsField>
        </div>
      </section>

      <section className="settings-card">
        <header>
          <div>
            <h3>媒体播放器</h3>
            <p>这些参数用于内置图片 / 视频查看器；视频快捷键与播放列表会立即生效。</p>
          </div>
          <span className="settings-badge">快捷键</span>
        </header>
        <div className="settings-grid">
          <SettingsField label="左右键快进步长（秒）" hint="短按 ← / → 前进或后退的秒数（1–60）">
            <input type="number" min={1} max={60} value={form.videoSeekSeconds} onChange={(e) => set("videoSeekSeconds", Number(e.target.value))} />
          </SettingsField>
          <SettingsField label="长按左右键倍速" hint="按住 ← / → 后临时倍速，松开恢复（1.1–10.0）">
            <input type="number" min={1.1} max={10} step={0.1} value={form.videoLongPressRate} onChange={(e) => set("videoLongPressRate", Number(e.target.value))} />
          </SettingsField>
          <SettingsField label="长按触发时间（毫秒）" hint="按住左右键多久后进入长按倍速（150–1000）">
            <input type="number" min={150} max={1000} step={50} value={form.videoLongPressDelayMs} onChange={(e) => set("videoLongPressDelayMs", Number(e.target.value))} />
          </SettingsField>
          <SettingsField label="音量上限（%）" hint="↑ / ↓ 可调到的最大音量，超过 100% 使用 Web Audio 增益（100–300）">
            <input type="number" min={100} max={300} step={10} value={form.videoMaxVolume} onChange={(e) => set("videoMaxVolume", Number(e.target.value))} />
          </SettingsField>
          <SettingsField label="音量按键步进（%）" hint="按一次 ↑ / ↓ 调整的音量幅度（1–50）">
            <input type="number" min={1} max={50} step={1} value={form.videoVolumeStep} onChange={(e) => set("videoVolumeStep", Number(e.target.value))} />
          </SettingsField>
          <SettingsField label="速度曲线默认时间窗（秒）" hint="下载中心曲线默认窗口（60–900 秒），也可在页面内临时切换">
            <input type="number" min={60} max={900} step={30} value={form.speedWindowSeconds} onChange={(e) => set("speedWindowSeconds", Number(e.target.value))} />
          </SettingsField>
          <SettingsField wide label="视频容器比例" hint="原始比例会按视频实际宽高自适应；固定比例可能产生黑边">
            <Select
              ariaLabel="视频容器比例"
              value={form.videoFrameAspect}
              onChange={(v) => set("videoFrameAspect", v)}
              options={[
                { value: "original", label: "原始比例（推荐）" },
                { value: "16:9", label: "固定 16 : 9" },
                { value: "4:3", label: "固定 4 : 3" },
              ]}
            />
          </SettingsField>

        </div>
      </section>

      <section className="settings-card">
        <header>
          <div>
            <h3>构建、账号与界面</h3>
            <p>缩略图会占用额外磁盘与 CPU；tdl Namespace 对应一套独立的 Telegram 会话。</p>
          </div>
        </header>
        <div className="settings-grid">
          <SettingsField label="tdl Namespace" hint="不同 namespace 的登录会话互相隔离">
            <input type="text" value={form.tdlNamespace} onChange={(e) => set("tdlNamespace", e.target.value)} />
          </SettingsField>
          <SettingsField label="通知停留时间（秒）" hint="成功、失败、警告与普通通知自动消失的时间（1–10 秒，默认 3 秒）">
            <input type="number" min={1} max={10} step={1} value={form.toastSeconds} onChange={(e) => set("toastSeconds", Number(e.target.value))} />
          </SettingsField>
          <SettingsField label="查看器背景" hint="动态取色（半透明）保留当前画面的色彩与玻璃感；动态取色（不透明）使用封面主色；磨砂模糊直接虚化打开查看器前的页面">
            <Select
              ariaLabel="查看器背景"
              value={form.viewerBackdrop}
              onChange={(v) => set("viewerBackdrop", v)}
              options={[
                { value: "ambient", label: "动态取色（半透明）" },
                { value: "solid", label: "动态取色（不透明）" },
                { value: "frosted", label: "磨砂模糊" },
              ]}
            />
          </SettingsField>
          <SettingsField label="媒体浏览策略" liveHint hint={libraryKey
            ? `${libraryKindLabel} · 当前生效：${policyEffective}。体验优先预取下一页和相邻视频，性能优先只加载需要的页面和可见缩略图。点击保存设置后生效。`
            : "正在识别当前档案库…"}>
            <Select ariaLabel="媒体浏览策略" value={selectedPolicy} disabled={!libraryKey || saving}
              options={[{ value: "auto", label: "自动" }, { value: "experience", label: "体验优先" }, { value: "performance", label: "性能优先" }]}
              onChange={(value) => setPolicyDraft({ key: libraryKey, value: value as BrowsePolicy })} />
          </SettingsField>
          <SettingsField label="媒体每页条数" hint="默认 50 条。输入 1–200 的整数，按回车或离开输入框后生效。">
            <input key={mediaPageSize} type="number" min={1} max={maxMediaPageSize} step={1}
              aria-label="媒体每页条数" defaultValue={mediaPageSize}
              onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
              onBlur={(event) => {
                const input = event.currentTarget;
                const value = input.valueAsNumber;
                if (!validMediaPageSize(value)) {
                  input.value = String(mediaPageSize);
                  toast("媒体每页条数需为 1–200 的整数。", true);
                  return;
                }
                if (value === mediaPageSize) return;
                try {
                  localStorage.setItem(mediaPageSizeKey, String(value));
                  window.dispatchEvent(new Event(mediaPageSizeChanged));
                } catch {
                  input.value = String(mediaPageSize);
                  toast("无法保存媒体每页条数，请检查本机存储。", true);
                }
              }} />
          </SettingsField>
          <div className="switch-grid">
            <SettingsToggle
              checked={form.generateThumbnails}
              onChange={(v) => set("generateThumbnails", v)}
              title="生成图片 / 视频封面"
              desc="构建时生成 720px 缩略图与视频封面，提升媒体网格加载速度"
            />
            <SettingsToggle
              checked={form.openAfterBuild}
              onChange={(v) => set("openAfterBuild", v)}
              title="构建完成后自动打开归档库"
              desc="只影响网页构建，不影响下载任务"
            />
          </div>
        </div>
        <div className="settings-foot">
          <span className={dirty ? "warn" : "muted"}>{dirty ? "有未保存的修改" : "所有修改已保存"}</span>
          <button className="btn ghost" onClick={load} disabled={saving}>
            <RotateCcw size={12} /> 还原
          </button>
          <button className="btn primary" onClick={save} disabled={saving || !dirty}>
            <Save size={12} /> {saving ? "正在保存…" : "保存设置"}
          </button>
        </div>
      </section>
    </>
  );
}

/* =========================== Diagnostics =========================== */
interface DiagRow {
  label: string;
  value: string;
  state: string;
}
interface LogInfo {
  name: string;
  size: number;
  modTime: string;
}

export function Diagnostics({ ctx }: { ctx: PageCtx }) {
  const { toast } = ctx;
  const [rows, setRows] = useState<DiagRow[]>([]);
  const [logs, setLogs] = useState<LogInfo[]>([]);
  const [active, setActive] = useState("");
  const [logResult, setLogResult] = useState<{ name: string; text: string; error?: boolean } | null>(null);
  const [readingLog, setReadingLog] = useState(false);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState("");
  const loadController = useRef<AbortController | null>(null);

  const load = () => {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    setLoading(true);
    setLogsLoading(true);
    setLogsError("");
    const diagnostics = call<DiagRow[] | null>("diagnostics", undefined, controller.signal)
      .then((next) => { if (!controller.signal.aborted) setRows(Array.isArray(next) ? next : []); })
      .catch((e: Error) => { if (!controller.signal.aborted) toast(e.message, true); });
    const logList = call<LogInfo[] | null>("listLogs", undefined, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        const list = Array.isArray(result) ? result : [];
        setLogs(list);
        setActive((current) => list.some((entry) => entry.name === current) ? current : list[0]?.name ?? "");
      })
      .catch((e: Error) => { if (!controller.signal.aborted) setLogsError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setLogsLoading(false); });
    void Promise.allSettled([diagnostics, logList]).then(() => {
      if (!controller.signal.aborted) setLoading(false);
      if (loadController.current === controller) loadController.current = null;
    });
  };
  useEffect(() => {
    load();
    return () => loadController.current?.abort();
  }, []);

  useEffect(() => {
    if (!active) { setLogResult(null); setReadingLog(false); return; }
    const controller = new AbortController();
    setLogResult(null);
    setReadingLog(true);
    call<string>("readLog", { name: active }, controller.signal)
      .then((text) => { if (!controller.signal.aborted) setLogResult({ name: active, text }); })
      .catch((e: Error) => { if (!controller.signal.aborted) setLogResult({ name: active, text: e.message, error: true }); })
      .finally(() => { if (!controller.signal.aborted) setReadingLog(false); });
    return () => controller.abort();
  }, [active]);

  const content = logResult?.name === active && !logResult.error ? logResult.text : "";
  const logError = logResult?.name === active && logResult.error ? logResult.text : "";
  const value = (label: string) => rows.find((r) => r.label === label)?.value ?? "--";
  const appLabels = ["版本", "程序目录", "配置文件", "档案库", "聊天数量", "媒体总数", "缺失媒体"];
  const toolLabels = ["tdl", "tdl 版本", "tdl 会话目录", "会话文件", "Namespace", "FFmpeg", "磁盘剩余", "远程库", "远程缓存"];
  const visibleLogs = logs.filter((l) => l.name.toLowerCase().includes(query.trim().toLowerCase()));
  const activeLog = logs.find((l) => l.name === active);

  const renderRows = (labels: string[]) => (
    <div className="diag-rows">
      {loading && rows.length === 0 && Array.from({ length: labels.length }).map((_, i) => (
        <div key={`sk-${i}`} className="diag-row"><span className="skeleton-line w-60" /><span className="skeleton-line w-160" /></div>
      ))}
      {rows
        .filter((r) => labels.includes(r.label))
        .map((r) => (
          <div key={r.label} className={`diag-row ${r.state}`}>
            <span className="diag-label">{r.label}</span>
            <span className="diag-value" title={r.value}>{wrapPath(r.value)}</span>
          </div>
        ))}
    </div>
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>诊断工具</h1>
          <p>环境、路径与会话状态；日志只读，可复制排查</p>
        </div>
        <div className="actions">
          <button className="btn ghost" onClick={() => call("revealLogs")}>
            <FolderOpen size={13} /> 打开日志目录
          </button>
          <button className="btn primary" onClick={load} disabled={loading}>
            <RefreshCw size={13} /> {loading ? "正在检查…" : "重新检查"}
          </button>
        </div>
      </div>

      <section className="stat-grid">
        <div className="stat">
          <span>版本</span>
          <div><b>{value("版本")}</b></div>
        </div>
        <div className="stat">
          <span>聊天</span>
          <div><b>{value("聊天数量")}</b><em>个</em></div>
        </div>
        <div className="stat">
          <span>日志文件</span>
          <div><b>{logs.length}</b><em>个</em></div>
        </div>
        <div className="stat">
          <span>磁盘剩余</span>
          <div><b>{value("磁盘剩余")}</b></div>
        </div>
      </section>

      <div className="diag-grid">
        <section className="panel">
          <div className="panel-head">
            <h3>应用与档案库</h3>
            <span className="meta">只读环境信息</span>
          </div>
          {renderRows(appLabels)}
        </section>
        <section className="panel">
          <div className="panel-head">
            <h3>工具与会话</h3>
            <span className="meta">tdl / FFmpeg / 磁盘</span>
          </div>
          {renderRows(toolLabels)}
        </section>
      </div>

      <section className="panel log-panel">
        <div className="panel-head">
          <h3><FileText size={14} /> 日志</h3>
          <span className="meta">{visibleLogs.length} / {logs.length} 个文件</span>
          <label className="log-search-wrap">
            <Search size={13} />
            <input
              className="log-search"
              type="search"
              placeholder="筛选日志文件名…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="筛选日志文件名"
            />
          </label>
          <button
            className="btn sm ghost"
            disabled={!content}
            onClick={() => navigator.clipboard?.writeText(content).then(() => toast("日志已复制")).catch(() => toast("复制失败", true))}
          >
            <Copy size={12} /> 复制日志
          </button>
        </div>
        <div className="log-split">
          <div className="log-list">
            {visibleLogs.length === 0 ? (
              <div className="chart-empty">{logsLoading ? "正在读取日志列表…" : logsError ? `日志列表暂不可用：${logsError}` : "没有匹配的日志。"}</div>
            ) : (
              visibleLogs.map((l) => (
                <button key={l.name} className={l.name === active ? "on" : ""} onClick={() => setActive(l.name)}>
                  <FileText size={14} className="log-icon" />
                  <span className="log-info">
                    <span className="nm" title={l.name}>{l.name}</span>
                    <span className="log-meta"><span>{l.modTime}</span><span>{bytes(l.size)}</span></span>
                  </span>
                </button>
              ))
            )}
          </div>
          <div className="log-view">
            <div className="log-view-head">
              <FileText size={13} />
              <b>{active || "选择日志"}</b>
              {activeLog && <span>{activeLog.modTime} · {bytes(activeLog.size)} · 仅显示末尾 256 KB</span>}
            </div>
            <pre className="logview">{readingLog ? "正在读取日志…" : logError ? `读取日志失败：${logError}` : content || "选择左侧日志查看内容。"}</pre>
          </div>
        </div>
      </section>
    </>
  );
}

/* ============================= Account ============================= */
function isQrLine(line: string): boolean {
  const t = line.replace(/\s+$/, "");
  if (t.length < 15) return false;
  let blocks = 0;
  for (const ch of t) {
    if (ch === "█" || ch === "▀" || ch === "▄") blocks++;
    else if (ch !== " ") return false;
  }
  return blocks > 0;
}

// tdl keeps repainting the QR; only the last contiguous block run is current.
function extractQr(screen: string[]): string[] {
  let end = -1;
  for (let i = screen.length - 1; i >= 0; i--) {
    if (isQrLine(screen[i])) {
      end = i;
      break;
    }
  }
  if (end < 0) return [];
  let start = end;
  while (start > 0 && isQrLine(screen[start - 1])) start--;
  return screen.slice(start, end + 1);
}

function allBlocksLine(line: string): boolean {
  return line.length > 0 && /^█+\s*$/.test(line);
}

function lastQrBlock(lines: string[]): string[] {
  let start = 0;
  for (let i = 1; i < lines.length; i++) {
    if (allBlocksLine(lines[i]) && allBlocksLine(lines[i - 1])) start = i - 1;
  }
  return lines.slice(start);
}

function parseQrMatrix(rawLines: string[]): boolean[][] | null {
  const lines = lastQrBlock(rawLines);
  if (lines.length < 8) return null;
  const grid: boolean[][] = [];
  for (const line of lines) {
    const top: boolean[] = [];
    const bottom: boolean[] = [];
    for (const ch of line) {
      const light = ch === "█" || ch === "▀" || ch === "▄";
      top.push(light && ch !== "▄");
      bottom.push(light && ch !== "▀");
    }
    grid.push(top, bottom);
  }
  const width = Math.max(...grid.map((r) => r.length));
  for (const r of grid) while (r.length < width) r.push(false);
  let y0 = 0;
  let y1 = grid.length - 1;
  let x0 = 0;
  let x1 = width - 1;
  const rowEmpty = (y: number) => grid[y].every((v) => !v);
  const colEmpty = (x: number) => grid.every((r) => !r[x]);
  while (y0 < y1 && rowEmpty(y0)) y0++;
  while (y1 > y0 && rowEmpty(y1)) y1--;
  while (x0 < x1 && colEmpty(x0)) x0++;
  while (x1 > x0 && colEmpty(x1)) x1--;
  const h = y1 - y0 + 1;
  const w = x1 - x0 + 1;
  if (h < 10 || w < 10) return null;
  const size = Math.max(h, w);
  const out = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  const oy = Math.floor((size - h) / 2);
  const ox = Math.floor((size - w) / 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      out[oy + y][ox + x] = !grid[y0 + y][x0 + x];
    }
  }
  return out;
}

function QrCodePanel({ lines, fallback }: { lines: string[]; fallback: string[] }) {
  const matrix = useMemo(() => parseQrMatrix(lines), [lines]);
  if (!matrix) {
    return (
      <div className="qr-wrap" aria-label="登录二维码">
        <pre className="qr-text">{fallback.join("\n")}</pre>
      </div>
    );
  }
  const margin = 4;
  const total = matrix.length + margin * 2;
  return (
    <div className="qr-card" aria-label="登录二维码">
      <svg viewBox={`0 0 ${total} ${total}`} width={240} height={240} shapeRendering="crispEdges" role="img" aria-label="Telegram 登录二维码">
        <rect width={total} height={total} fill="#ffffff" />
        {matrix.map((row, y) =>
          row.map((dark, x) =>
            dark ? <rect key={`${x}-${y}`} x={margin + x} y={margin + y} width={1.02} height={1.02} fill="#0b0d12" /> : null
          )
        )}
      </svg>
    </div>
  );
}

const LOGIN_STATE_LABEL: Record<string, string> = {
  starting: "正在启动",
  waiting: "等待确认",
  success: "登录成功",
  failed: "登录失败",
  cancelled: "已取消",
  missing: "会话已结束",
};

const CHECK_LABEL: Record<string, string> = {
  ready: "连接正常",
  unauthorized: "授权已失效",
  network: "网络连接失败",
  timeout: "连接检查超时",
  "check-failed": "资料读取失败",
  "no-tdl": "tdl 未安装",
  busy: "tdl 正在使用会话",
};

function promptLabel(prompt?: string): string {
  const p = (prompt ?? "").toLowerCase();
  if (p.includes("2fa") || p.includes("password") || p.includes("两步")) return "请输入两步验证密码";
  if (p.includes("phone") || p.includes("手机号") || p.includes("number")) return "请输入手机号（含国家码，例如 +8613800000000）";
  if (p.includes("code") || p.includes("验证码")) return "请输入 Telegram 发来的验证码";
  return "按提示输入内容后发送";
}

export function Account({ ctx }: { ctx: PageCtx }) {
  const { login, running, refresh, toast } = ctx;
  const [info, setInfo] = useState<TdlInfo | null>(null);
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [profile, setProfile] = useState<AccountProfile | null>(null);
  const [profileSource, setProfileSource] = useState("cache");
  const [check, setCheck] = useState<SessionCheck | null>(null);
  const [busy, setBusy] = useState("");
  const [entry, setEntry] = useState("");
  const [showRaw, setShowRaw] = useState(false);
  const [ready, setReady] = useState(false);
  const [logoutConfirm, setLogoutConfirm] = useState(false);
  const autoChecked = useRef(false);

  const loadInfo = () => {
    call<TdlInfo>("tdlInfo")
      .then(setInfo)
      .catch((e: Error) => toast(e.message, true));
    return call<AccountInfo>("accountInfo")
      .then(setAccount)
      .catch((e: Error) => toast(e.message, true));
  };
  useEffect(() => {
    Promise.allSettled([
      loadInfo(),
      call<AccountProfile | null>("accountProfile").then((p) => {
        if (p && p.userId) {
          setProfile(p);
          setProfileSource("cache");
        }
      }),
    ]).finally(() => setReady(true));
  }, []);
  useEffect(() => {
    if (login?.state === "success") {
      loadInfo();
      refresh();
      void checkSession();
    }
  }, [login?.state]);

  const active = !!login && (login.state === "starting" || login.state === "waiting");
  const screen = login?.screen ?? [];
  const qr = extractQr(screen);
  const tdlMissing = !info?.exe;

  const checkSession = async (silent = false) => {
    if (busy === "check") return;
    setBusy("check");
    if (!silent) setCheck(null);
    try {
      const st = await call<SessionCheck>("sessionCheck", { timeout: 12 });
      setCheck(st);
      if (st.profile) {
        setProfile(st.profile);
        setProfileSource(st.source || "live");
      }
      loadInfo();
    } catch (e) {
      if (!silent) toast((e as Error).message, true);
    } finally {
      setBusy("");
    }
  };

  useEffect(() => {
    if (autoChecked.current || !account?.hasSessionFile || running) return;
    const age = profile ? Date.now() - profile.checkedAt : Number.POSITIVE_INFINITY;
    if (age < 5 * 60 * 1000) return;
    autoChecked.current = true;
    void checkSession(true);
  }, [account?.hasSessionFile, profile?.checkedAt, running]);

  const startLogin = async (kind: "qr" | "code") => {
    if (running) {
      toast("有下载任务进行中，完成或取消后再登录", true);
      return;
    }
    setBusy("login");
    setEntry("");
    setShowRaw(false);
    try {
      const st = await call<LoginState>("startLogin", { kind });
      if (st.state === "failed") toast(st.message || "登录启动失败", true);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy("");
    }
  };

  const cancelLogin = async () => {
    if (!login) return;
    try {
      await call("loginCancel", { id: login.id });
      toast("已取消登录");
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const sendEntry = async () => {
    if (!login || !entry.trim()) return;
    try {
      await call("loginInput", { id: login.id, text: entry.trim() });
      setEntry("");
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const installTdl = async () => {
    setBusy("install");
    try {
      const next = await call<TdlInfo>("installTdl");
      setInfo(next);
      refresh();
      toast("tdl 已安装");
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy("");
    }
  };

  const killTdl = async () => {
    setBusy("kill");
    try {
      await call("killTdl");
      loadInfo();
      toast("已结束 tdl 进程");
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy("");
    }
  };

  const logout = () => setLogoutConfirm(true);

  const logoutConfirmed = async () => {
    setLogoutConfirm(false);
    setBusy("logout");
    try {
      await call("logoutTdl");
      setCheck(null);
      setProfile(null);
      setProfileSource("cache");
      await loadInfo();
      toast("已退出当前 Telegram 会话");
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy("");
    }
  };

  const lp = (login?.prompt ?? "").toLowerCase();
  const submitted = /输入已提交|等待 telegram|已提交/.test(lp);
  const wantsPassword = /2fa|password|two-step|两步|密码/.test(lp);
  const wantsPhone = !wantsPassword && /phone|手机号|电话号码|number/.test(lp);
  const wantsCode = !wantsPassword && !wantsPhone && /enter code|verification code|login code|验证码/.test(lp);
  const needsInput = active && (wantsPassword || wantsCode || wantsPhone || (login?.kind === "code" && !submitted));
  const showQr = active && login?.kind === "qr" && qr.length > 0 && !wantsPassword && !wantsCode && !wantsPhone && !submitted;
  const checking = busy === "check";
  const checkTone =
    check && (check.state === "ready" ? "ok" : check.state === "unauthorized" ? "danger" : check.state === "busy" ? "" : "warn");
  const inferred = check?.state === "ready" && profileSource === "inferred";
  const fresh = !!profile && Date.now() - profile.checkedAt < 5 * 60 * 1000;
  const statusTone = checking
    ? "unknown"
    : check?.state === "ready"
      ? "ok"
      : check?.state === "unauthorized" || !account?.hasSessionFile
        ? account?.hasSessionFile === false
          ? "none"
          : "bad"
        : fresh
          ? "ok"
          : profile
            ? "unknown"
            : !account?.hasSessionFile
              ? "none"
              : "unknown";
  const accountStatus = checking
    ? "正在检查…"
    : !account?.hasSessionFile
      ? "未登录"
      : check?.state === "ready"
        ? inferred
          ? "授权有效"
          : "授权正常"
        : check?.state === "unauthorized"
          ? "授权已失效"
          : fresh
            ? "最近验证正常"
            : profile
              ? "资料已缓存"
              : "状态未知";
  const exportAccount = account?.exportAccount;
  const displayName = profile?.name || exportAccount?.name || "Telegram 账号";
  const username = profile?.username || exportAccount?.username || "";
  const userId = profile?.userId || exportAccount?.userId;
  const phone = profile?.phone ? (profile.phone.startsWith("+") ? profile.phone : "+" + profile.phone) : "";
  const checkedText = profile?.checkedAt ? dateTime(profile.checkedAt) : "尚未读取";
  const sourceText = profileSource === "live" ? "实时读取" : profileSource === "inferred" ? "下载中推断" : "本机缓存";
  const profileLoading = !ready || (!profile && (checking || (!autoChecked.current && !!account?.hasSessionFile)));
  const sessionUsable = !!account?.hasSessionFile && check?.state !== "unauthorized";
  const showLogin = active || busy === "login" || (ready && !sessionUsable);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>账号管理</h1>
          <p>当前登录的 Telegram 账号、授权状态与本机会话；扫码登录与退出都在这里完成</p>
        </div>
        <div className="actions">
          <button className="btn ghost" onClick={() => call("openTdlDir")}>
            <FolderOpen size={13} /> 打开会话目录
          </button>
          <button className="btn primary" disabled={checking || !account?.hasSessionFile} onClick={() => checkSession()}>
            <RefreshCw size={13} className={checking ? "spin" : ""} /> {checking ? "正在检查…" : "刷新状态"}
          </button>
        </div>
      </div>

      <section className="account-hero">
        <div className={`account-avatar ${!ready ? "skeleton" : ""}`}>
          {!ready ? null : profile?.avatar ? <img src={profile.avatar} alt={displayName} /> : <UserRound size={26} />}
        </div>
        <div className="account-id">
          <h2>{ready ? displayName : <span className="skeleton-line w-140" />}</h2>
          <p className="account-handle">
            {!ready ? <span className="skeleton-line w-220" /> : username ? <><AtSign size={12} /> {username}</> : null}
            {phone && <><i>·</i><Phone size={12} /> {phone}</>}
            {userId && <><i>·</i><Fingerprint size={12} /> ID {userId}</>}
          </p>
          <p className="account-sub">
            {!ready ? <span className="skeleton-line w-260" /> : (
              <>
                <span>{profile ? sourceText : "尚未读取账号资料"}</span>
                <i>·</i>
                <span>{checkedText}</span>
                <i>·</i>
                <span>namespace {account?.namespace || info?.namespace || "-"}</span>
              </>
            )}
          </p>
        </div>
        <span className={`account-status ${statusTone}`}><i /> {accountStatus}</span>
        <div className="account-hero-actions">
          <button className="btn sm" onClick={() => checkSession()} disabled={checking || !account?.hasSessionFile}>
            <Wifi size={12} /> 检查连接
          </button>
          <button className="btn sm primary" disabled={busy === "login" || tdlMissing || running} onClick={() => startLogin("qr")}>
            <QrCode size={12} /> 重新登录
          </button>
          <button className="btn sm danger" disabled={busy === "logout" || !account?.hasSessionFile} onClick={logout}>
            <LogOut size={12} /> 退出登录
          </button>
        </div>
      </section>

      {check && check.state !== "ready" && (
        <div className={`account-check-line ${checkTone}`}>
          {check.state === "unauthorized" ? <WifiOff size={15} /> : <Wifi size={15} />}
          <b>{CHECK_LABEL[check.state] ?? check.state}</b>
          <span>{check.message}</span>
          {check.state === "unauthorized" && <em>本地会话存在但 Telegram 已拒绝；重新扫码登录会覆盖为有效会话。</em>}
          {check.detail && (
            <details>
              <summary>查看输出</summary>
              <pre>{check.detail}</pre>
            </details>
          )}
        </div>
      )}

      <div className="account-grid">
        <section className="panel">
          <div className="panel-head">
            <h3>账号资料</h3>
            <span className="meta">{profile ? sourceText : "等待读取"}</span>
          </div>
          {profileLoading ? (
            <div className="account-skeleton" aria-label="正在读取账号资料">
              {Array.from({ length: 6 }).map((_, i) => <div key={i}><span className="skeleton-line w-60" /><span className="skeleton-line w-160" /></div>)}
            </div>
          ) : profile ? (
            <>
              <div className="account-rows">
                <div><span>名称</span><b>{profile.name || "未命名"}</b></div>
                {profile.username && <div><span>用户名（@）</span><b>@{profile.username}</b></div>}
                <div><span>手机号</span><b className="mono">{phone || "不可见"}</b></div>
                <div><span>用户 ID</span><b className="mono">{profile.userId}</b></div>
                <div><span>最后验证</span><b>{checkedText}</b></div>
              </div>
              <div className="account-profile-actions">
                <button
                  className="btn sm ghost"
                  onClick={() => {
                    const text = `${profile.name}
${profile.username ? "@" + profile.username + "\n" : ""}${phone}
ID ${profile.userId}`;
                    navigator.clipboard?.writeText(text).then(() => toast("账号信息已复制")).catch(() => toast("复制失败", true));
                  }}
                >
                  <Copy size={12} /> 复制账号信息
                </button>
                <button className="btn sm" disabled={checking} onClick={() => checkSession()}>
                  <RefreshCw size={12} /> 刷新资料
                </button>
              </div>
            </>
          ) : (
            <div className="account-empty">
              <UserRound size={22} />
              <div>
                <b>还没有读到当前账号资料</b>
                <p>TAK 会通过本机 tdl 会话直接向 Telegram 查询姓名、手机号与头像；查询结果只保存在本机。</p>
              </div>
              <button className="btn sm primary" disabled={checking || !account?.hasSessionFile} onClick={() => checkSession()}>
                <Wifi size={12} /> {checking ? "正在读取…" : "读取账号资料"}
              </button>
            </div>
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3>本地会话</h3>
            <span className="meta">{info?.running ? "tdl 正在运行" : "tdl 未运行"}</span>
          </div>
          <dl className="kv account-kv">
            <dt>Namespace</dt>
            <dd>{account?.namespace || info?.namespace || "-"}</dd>
            <dt>会话文件</dt>
            <dd className="mono">{wrapPath(account?.sessionFile || "-")}</dd>
            <dt>文件大小</dt>
            <dd>{account?.hasSessionFile ? bytes(account?.sessionSize ?? 0) : "无"}</dd>
            <dt>最后修改</dt>
            <dd>{dateTime(account?.sessionModified)}</dd>
            <dt>tdl</dt>
            <dd className="mono">{wrapPath(info?.exe || "未安装")}</dd>
            <dt>tdl 版本</dt>
            <dd>{info?.version || "未知"}</dd>
          </dl>
          <div className="account-tools">
            <button className="btn sm ghost" onClick={() => call("openTdlDir")}>
              <FolderOpen size={12} /> 会话目录
            </button>
            {tdlMissing && (
              <button className="btn sm primary" disabled={busy === "install"} onClick={installTdl}>
                <Download size={12} /> {busy === "install" ? "安装中…" : "安装 tdl"}
              </button>
            )}
            {info?.running && (
              <button className="btn sm danger" disabled={busy === "kill"} onClick={killTdl}>
                <WifiOff size={12} /> 结束 tdl
              </button>
            )}
          </div>
        </section>
      </div>

      {showLogin && (
      <section className="panel">
        <div className="panel-head">
          <h3>Telegram 登录</h3>
          <span className="meta">
            {active && login
              ? `${loginKindLabel(login.kind)} · ${wantsPassword ? "需要两步验证" : LOGIN_STATE_LABEL[login.state] ?? login.state}`
              : "扫码或验证码"}
          </span>
        </div>

        {!active ? (
          <div className="acct-login">
            <div className="acct-pick">
              <button className="acct-choice" disabled={busy === "login" || tdlMissing || running} onClick={() => startLogin("qr")}>
                <QrCode size={22} />
                <b>二维码登录</b>
                <span>用手机 Telegram 扫描应用内二维码；最快捷，也最不容易被验证码拦截</span>
              </button>
              <button className="acct-choice" disabled={busy === "login" || tdlMissing || running} onClick={() => startLogin("code")}>
                <KeyRound size={22} />
                <b>手机号验证码登录</b>
                <span>扫码不方便时使用；验证码由 Telegram 发送到已登录设备或短信</span>
              </button>
            </div>
            <div className="acct-note">
              <UserRound size={14} />
              <div>
                <p>已有会话无需重复登录；只有首次使用、授权明确失效或切换账号时才需要。</p>
                <p>登录过程完全在本机进行，验证码不会写入配置或日志。</p>
                {running && <p className="warn">当前有下载任务进行中，完成或取消后才能登录。</p>}
                {tdlMissing && <p className="warn">尚未安装 tdl，请先在右侧安装。</p>}
                {login && <p className={login.state === "success" ? "ok" : login.state === "failed" ? "danger" : ""}>上次登录：{LOGIN_STATE_LABEL[login.state] ?? login.state}{login.message ? ` · ${login.message}` : ""}</p>}
              </div>
            </div>
          </div>
        ) : (
          <div className="acct-login live">
            <div className="acct-stage">
              {showQr && <QrCodePanel lines={login.qr ?? []} fallback={qr} />}
              {active && login.kind === "qr" && !showQr && !needsInput && !wantsPassword && !submitted && (
                <p className="acct-prompt warn">正在等待二维码…</p>
              )}
              {needsInput ? (
                <div className="acct-code">
                  <p className="acct-question">
                    {wantsPassword
                      ? "二维码已扫描，请输入 Telegram 两步验证密码"
                      : wantsPhone
                        ? "请输入手机号（含国家码）"
                        : wantsCode
                          ? "请输入 Telegram 发来的验证码"
                          : "输入手机号以接收验证码"}
                  </p>
                  <div className="acct-entry">
                    <input
                      type={wantsPassword ? "password" : wantsPhone ? "tel" : "text"}
                      value={entry}
                      autoFocus
                      autoComplete="off"
                      inputMode={wantsPhone || wantsCode ? "numeric" : "text"}
                      placeholder={wantsPhone ? "+8613800000000" : promptLabel(login.prompt)}
                      onChange={(e) => setEntry(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") sendEntry();
                      }}
                    />
                    <button className="btn primary" disabled={!entry.trim()} onClick={sendEntry}>
                      <Send size={12} /> 发送
                    </button>
                  </div>
                  <p className="acct-hint">
                    输入后会直接发送给 tdl，不会写入配置或日志。
                    {login.kind === "code" && !wantsPassword && (
                      <button className="link" onClick={async () => { await cancelLogin(); await startLogin("qr"); }}>
                        收不到验证码？改用二维码
                      </button>
                    )}
                  </p>
                </div>
              ) : submitted ? (
                <div className="acct-waiting">
                  <RefreshCw size={18} className="spin" />
                  <div>
                    <b>{wantsCode || login.kind === "code" ? "正在请求 / 校验验证码…" : "正在等待 Telegram 响应…"}</b>
                    <p>通常几秒内会收到；如果长时间没有反应，请取消后改用二维码登录。</p>
                  </div>
                </div>
              ) : null}
              {login.prompt && !needsInput && !submitted && <p className="acct-prompt">{login.prompt}</p>}
              <div className="acct-live-actions">
                <button className="btn danger" onClick={cancelLogin}>
                  <Square size={12} /> 取消登录
                </button>
                <button className="btn ghost" onClick={() => setShowRaw((v) => !v)}>
                  <Keyboard size={12} /> {showRaw ? "隐藏原始输出" : "原始输出"}
                </button>
              </div>
              {showRaw && <pre className="logview">{screen.join("\n")}</pre>}
            </div>
          </div>
        )}
      </section>
      )}

      <ConfirmDialog
        open={logoutConfirm}
        title="退出当前 Telegram 会话？"
        message="会话文件会先备份到 ~/.tdl/backups，然后从当前 namespace 移除；重新登录即可恢复。"
        confirmLabel="退出会话"
        danger
        onConfirm={() => void logoutConfirmed()}
        onCancel={() => setLogoutConfirm(false)}
      />
    </>
  );
}

const loginKindLabel = (kind: string) => (kind === "code" ? "手机号验证码" : "二维码");
