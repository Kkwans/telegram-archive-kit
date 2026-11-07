import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  AtSign,
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
import { OnlineUpdateDialog, onlineTargetFromChat, type OnlineUpdateTarget } from "./OnlineUpdateDialog";
import type {
  AccountInfo,
  AccountProfile,
  Bootstrap,
  ChatRow,
  DoneState,
  DownloadState,
  HomeStats,
  LoginState,
  MediaItem,
  OperationState,
  RemoteStatus,
  RemoteTools,
  SessionCheck,
  TdlInfo,
  TaskInfo,
  ViewerPrefs,
} from "./types";
import { bytes, dateTime, duration, rate, rateParts } from "./format";

export interface PageCtx {
  boot: Bootstrap | null;
  chats: ChatRow[];
  selected: string;
  setSelected: (slug: string) => void;
  dl: DownloadState | null;
  op: OperationState | null;
  done: DoneState | null;
  login: LoginState | null;
  running: boolean;
  history: { now: number; avg: number }[];
  refresh: () => void;
  toast: (msg: string, err?: boolean) => void;
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
  const { boot, chats, selected, setSelected, refresh, toast, go, tasks, openTasks, openTask, pickFiles } = ctx;
  const [stats, setStats] = useState<HomeStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncSlug, setSyncSlug] = useState(selected);
  const [missingConfirm, setMissingConfirm] = useState(false);
  useEffect(() => {
    if (!syncSlug && selected) setSyncSlug(selected);
  }, [selected]);

  const load = () => {
    setLoading(true);
    call<HomeStats>("homeStats")
      .then(setStats)
      .catch((e: Error) => toast(e.message, true))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const totalMedia = stats ? stats.images + stats.videos + stats.audio + stats.files : 0;
  const missingTotal = chats.reduce((n, c) => n + c.missing, 0);
  const recentChats = useMemo(
    () => [...chats].sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "")).slice(0, 5),
    [chats]
  );
  const recentTasks = tasks.slice(0, 5);

  const startSync = async () => {
    const slug = syncSlug || selected;
    if (!slug) {
      go("chats");
      return;
    }
    setSelected(slug);
    try {
      const taskID = await call<string>("startOneClick", { slug });
      toast("已开始同步：" + (chats.find((c) => c.slug === slug)?.name ?? "聊天"));
      openTask(taskID);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const syncAllMissing = () => {
    const missing = chats.filter((c) => c.missing > 0);
    if (missing.length === 0) {
      toast("所有聊天都没有缺失媒体");
      return;
    }
    setMissingConfirm(true);
  };
  const runSyncAllMissing = async () => {
    setMissingConfirm(false);
    try {
      await call("startSyncAllMissing");
      toast("批量同步任务已加入任务中心");
      go("tasks");
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const importJSON = async () => {
    try {
      const paths = await pickFiles("import-json");
      if (!paths.length) return;
      await call("startImportJSON", { paths });
      toast("导入任务已加入任务中心");
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
            <button className="btn primary" onClick={importJSON} disabled={loading}>
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
          <div><b>{chats.length}</b><em>个档案</em></div>
        </div>
        <div className="stat">
          <span>消息</span>
          <div>{stats ? <><b>{stats.messages.toLocaleString()}</b><em>条</em></> : <span className="skeleton-line w-80" />}</div>
        </div>
        <div className="stat">
          <span>本地媒体</span>
          <div>{stats ? <><b>{stats.media.toLocaleString()}</b><em>个</em></> : <span className="skeleton-line w-80" />}</div>
        </div>
        <div className="stat">
          <span>缺失媒体</span>
          <div>{stats ? <><b className={stats.missing > 0 ? "warn" : ""}>{stats.missing}</b><em>个</em></> : <span className="skeleton-line w-60" />}</div>
        </div>
      </section>

      <div className="home-grid home-grid-even">
        <section className="panel">
          <div className="panel-head">
            <h3><ChartPie size={14} /> 媒体构成</h3>
            <span className="meta">{loading ? "正在统计…" : `共 ${totalMedia.toLocaleString()} 个`}</span>
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
                    <strong>{value.toLocaleString()}</strong>
                    <em>{pct}%</em>
                  </div>
                );
              })}
            </div>
            <div className="media-facts">
              <span><b>{chats.filter((c) => c.media > 0).length}</b> 个聊天有媒体</span>
              <span>平均每个聊天 <b>{chats.length ? Math.round((stats?.media ?? 0) / chats.length).toLocaleString() : 0}</b> 个</span>
              <span>最大类型 <b>{MEDIA_KINDS.reduce((best, k) => ((stats?.[k.key] ?? 0) > (stats?.[best.key] ?? 0) ? k : best), MEDIA_KINDS[0]).label}</b></span>
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
              <div className="storage-bar"><b style={{ width: `${stats && stats.diskTotal > 0 ? Math.min(100, Math.max(0, Math.round(((stats.diskTotal - stats.diskFree) * 100) / stats.diskTotal))) : 0}%` }} /></div>
              <div className="storage-labels">
                <span>磁盘已用 {stats && stats.diskTotal > 0 ? Math.round(((stats.diskTotal - stats.diskFree) * 100) / stats.diskTotal) : 0}%</span>
                <span>剩余 {bytes(stats?.diskFree ?? 0)}</span>
              </div>
            </div>
            <div className="storage-facts">
              <div><span>媒体体积</span><b>{bytes(stats?.mediaBytes ?? 0)}</b></div>
              <div><span>网页</span><b>{stats?.pages ?? 0} 页</b></div>
              <div><span>官方导出</span><b>{stats?.official ?? 0} 个</b></div>
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
            <div className="chart-empty">还没有聊天，先到档案库导入 result.json。</div>
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

      <ConfirmDialog
        open={missingConfirm}
        title="同步全部缺失媒体？"
        message={`将依次同步 ${chats.filter((c) => c.missing > 0).length} 个存在缺失媒体的聊天，期间会下载并重建网页。`}
        confirmLabel="开始同步"
        onConfirm={() => void runSyncAllMissing()}
        onCancel={() => setMissingConfirm(false)}
      />
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

export function Chats({ ctx }: { ctx: PageCtx }) {
  const { chats, selected, refresh, toast, go, pickFolder, openTask } = ctx;
  const [stats, setStats] = useState<Stats | null>(null);
  const [busy, setBusy] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [onlineTarget, setOnlineTarget] = useState<OnlineUpdateTarget | null>(null);
  const [onlineLoading, setOnlineLoading] = useState(false);

  const current = chats.find((c) => c.slug === selected) || null;
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
      toast("已删除本地归档");
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
      await call("startExportChat", { slug: current.slug, dst });
      toast("导出任务已加入任务中心");
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
      setOnlineTarget(onlineTargetFromChat(chat));
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setOnlineLoading(false);
    }
  };

  const rebuild = async () => {
    if (!current) return;
    try {
      await call("startRefreshWeb", { slug: current.slug });
      toast("已加入任务中心：正在补齐视频封面并重建离线网页");
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const backfillJSON = async () => {
    if (!current) return;
    try {
      const taskID = await call<string>("startOneClick", { slug: current.slug });
      toast("已按 result.json 开始补全：只处理本地 JSON 中的缺失媒体");
      openTask(taskID);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const copyPath = () => {
    if (!current) return;
    navigator.clipboard?.writeText(current.dir).then(() => toast("目录已复制")).catch(() => toast("复制失败", true));
  };
  const jsonPath = current ? `${current.dir.replace(/[\\/]+$/, "")}\\source\\result.json` : "";
  const copyJSONPath = () => {
    if (!jsonPath) return;
    navigator.clipboard?.writeText(jsonPath).then(() => toast("result.json 路径已复制")).catch(() => toast("复制失败", true));
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
          <button className="btn ghost danger-text" disabled={busy === "delete"} onClick={remove}>
            <Trash2 size={13} /> 删除本地归档
          </button>
          <button className="btn primary" disabled={onlineLoading || !ctx.boot?.hasSession} onClick={() => void onlineUpdate()} title="从 Telegram 在线会话拉取最新消息，先统计再确认归档">
            {onlineLoading ? <Loader2 size={13} className="spin" /> : <CloudDownload size={13} />} {onlineLoading ? "正在读取会话…" : "拉取最新消息"}
          </button>
        </div>
      </div>

      <section className="stat-grid">
        <div className="stat">
          <span>消息</span>
          <div><b>{current.messages.toLocaleString()}</b><em>条</em></div>
        </div>
        <div className="stat">
          <span>媒体</span>
          <div><b>{current.media.toLocaleString()}</b><em>个</em></div>
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

      <section className="panel">
        <div className="panel-head">
          <h3>归档信息</h3>
        </div>
        <div className="chat-facts-grid chat-facts-three">
          <div className="fact"><span>类型</span><b>{current.type || "--"}</b></div>
          <div className="fact"><span>Chat ID</span><b className="mono">{current.id || "--"}</b></div>
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
            <button className="btn sm ghost" onClick={() => void backfillJSON()} disabled={!current.hasSource} title="只按本地 result.json 补齐缺失媒体并重建，不访问 Telegram 在线消息">
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
          onStarted={(taskId) => openTask(taskId)}
          toast={toast}
        />
      )}

      <MediaGallery ctx={ctx} chat={current} />

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

const mediaURL = (slug: string, rel: string) =>
  `/api/media?slug=${encodeURIComponent(slug)}&f=${encodeURIComponent(rel)}`;
const thumbURL = (slug: string, rel?: string) =>
  rel ? mediaURL(slug, rel) : "";

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
  if (kind === "video") return <Film size={20} />;
  if (kind === "audio") return <Music size={20} />;
  return <FileText size={20} />;
}

export function MediaGallery({ ctx, chat }: { ctx: PageCtx; chat: ChatRow }) {
  const { toast } = ctx;
  const [items, setItems] = useState<MediaItem[] | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("all");
  const [limit, setLimit] = useState(120);
  const [viewer, setViewer] = useState<{ items: MediaItem[]; index: number } | null>(null);
  const [audioItem, setAudioItem] = useState<MediaItem | null>(null);
  const [size, setSize] = useState<"sm" | "md" | "lg" | "xl">(() => {
    const saved = localStorage.getItem("tak-media-size");
    return saved === "sm" || saved === "lg" || saved === "xl" ? saved : "md";
  });
  const [sort, setSort] = useState<"newest" | "oldest" | "size-desc" | "size-asc">(() => {
    const saved = localStorage.getItem("tak-media-sort");
    return saved === "oldest" || saved === "size-desc" || saved === "size-asc" ? saved : "newest";
  });
  useEffect(() => {
    localStorage.setItem("tak-media-size", size);
  }, [size]);
  useEffect(() => {
    localStorage.setItem("tak-media-sort", sort);
  }, [sort]);

  const load = () => {
    setItems(null);
    setError("");
    call<MediaItem[]>("chatMedia", { slug: chat.slug })
      .then(setItems)
      .catch((e: Error) => setError(e.message));
  };
  useEffect(load, [chat.slug]);
  useEffect(() => {
    setLimit(120);
    setViewer(null);
    setAudioItem(null);
  }, [filter, chat.slug]);

  const mediaItems = useMemo(() => (items ?? []).filter((i) => i.kind !== "file"), [items]);
  const fileItems = useMemo(() => (items ?? []).filter((i) => i.kind === "file"), [items]);
  const orderItems = (list: MediaItem[]) => {
    const timeKey = (item: MediaItem) => {
      const messageID = Number(item.id);
      return Number.isFinite(messageID) && messageID > 0 ? messageID : item.modTime || 0;
    };
    const ordered = [...list];
    if (sort === "size-desc") return ordered.sort((a, b) => b.size - a.size);
    if (sort === "size-asc") return ordered.sort((a, b) => a.size - b.size);
    return ordered.sort((a, b) => {
      const diff = timeKey(a) - timeKey(b);
      return sort === "newest" ? (diff || a.name.localeCompare(b.name)) * -1 : diff || a.name.localeCompare(b.name);
    });
  };
  const orderedMedia = useMemo(() => orderItems(mediaItems), [mediaItems, sort]);
  const orderedFiles = useMemo(() => orderItems(fileItems), [fileItems, sort]);
  const images = useMemo(() => orderedMedia.filter((i) => i.kind === "image"), [orderedMedia]);
  const videos = useMemo(() => orderedMedia.filter((i) => i.kind === "video"), [orderedMedia]);
  const shown = useMemo(() => {
    if (filter === "all") return orderedMedia;
    return orderedMedia.filter((i) => i.kind === filter);
  }, [orderedMedia, filter]);
  const showFiles = filter === "all" || filter === "file";

  const viewerPool = useMemo(() => {
    if (filter === "image") return images;
    if (filter === "video") return videos;
    if (filter === "all") return orderedMedia.filter((i) => i.kind === "image" || i.kind === "video");
    return orderedMedia.filter((i) => i.kind === "image" || i.kind === "video");
  }, [filter, images, videos, orderedMedia]);

  const openItem = (item: MediaItem) => {
    if (item.kind === "audio") {
      setAudioItem(item);
      return;
    }
    if (item.kind !== "image" && item.kind !== "video") return;
    const index = viewerPool.findIndex((i) => i.rel === item.rel);
    setViewer({ items: viewerPool, index: Math.max(0, index) });
  };

  const reveal = (item: MediaItem) =>
    call("revealMedia", { slug: chat.slug, path: item.rel }).catch((e: Error) => toast(e.message, true));
  const openExternal = (item: MediaItem) =>
    call("openMedia", { slug: chat.slug, path: item.rel }).catch((e: Error) => toast(e.message, true));

  return (
    <section className="panel">
      <div className="panel-head media-head">
        <div className="media-title">
          <h3><Images size={14} /> 媒体与文件</h3>
          <span className="meta">
            {items ? `共 ${mediaItems.length} 个媒体 · ${fileItems.length} 个文件` : "正在读取…"}
          </span>
        </div>
        <div className="media-tools">
          <div className="media-sort">
            <Select
              ariaLabel="媒体排序"
              value={sort}
              onChange={(v) => setSort(v as typeof sort)}
              options={[
                { value: "newest", label: "最新在前" },
                { value: "oldest", label: "最早在前" },
                { value: "size-desc", label: "大小从大到小" },
                { value: "size-asc", label: "大小从小到大" },
              ]}
            />
          </div>
          <div className="media-size" role="group" aria-label="预览图大小">
            {[["sm", "小"], ["md", "中"], ["lg", "大"], ["xl", "超大"]].map(([key, label]) => (
              <button key={key} className={size === key ? "on" : ""} onClick={() => setSize(key as typeof size)}>{label}</button>
            ))}
          </div>
          <div className="tabs media-tabs" role="tablist" aria-label="媒体筛选">
            {MEDIA_FILTERS.map((f) => {
            const count =
              f.key === "all"
                ? mediaItems.length
                : f.key === "file"
                  ? fileItems.length
                  : mediaItems.filter((i) => i.kind === f.key).length;
            return (
              <button key={f.key} role="tab" aria-selected={filter === f.key} className={filter === f.key ? "on" : ""} onClick={() => setFilter(f.key)}>
                {f.label}
                <span className="tab-count">{count}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {error ? (
        <div className="state-box error">
          <p>读取媒体列表失败：{error}</p>
          <button className="btn ghost" onClick={load}>
            <RefreshCw size={13} /> 重试
          </button>
        </div>
      ) : items === null ? (
        <div className="media-grid" aria-hidden="true">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="media-tile skeleton" />
          ))}
        </div>
      ) : (
        <>
          {shown.length === 0 && filter !== "all" && filter !== "file" ? (
            <div className="state-box">
              <p>当前筛选没有文件。</p>
              <button className="btn ghost" onClick={() => call("revealChat", { slug: chat.slug })}>
                <FolderOpen size={13} /> 打开聊天目录
              </button>
            </div>
          ) : (
            shown.length > 0 && (
              <div className={`media-grid size-${size}`}>
                {shown.slice(0, limit).map((item) => (
                  <button
                    key={item.rel}
                    className={`media-tile ${item.kind}`}
                    title={`${item.name}${item.id ? ` · 消息 #${item.id}` : ""}`}
                    onClick={() => openItem(item)}
                  >
                    {item.thumb ? (
                      <img src={thumbURL(chat.slug, item.thumb)} alt={item.name} loading="lazy" />
                    ) : item.kind === "image" ? (
                      <img src={mediaURL(chat.slug, item.rel)} alt={item.name} loading="lazy" />
                    ) : (
                      <span className={`media-ph ${item.kind}`}>{mediaIcon(item.kind)}</span>
                    )}
                    {item.kind === "video" && (
                      <span className="media-play">
                        <Play size={14} fill="currentColor" />
                      </span>
                    )}
                    <span className="media-cap">
                      <b>{item.name}</b>
                      <i>{bytes(item.size)}</i>
                    </span>
                  </button>
                ))}
              </div>
            )
          )}
          {shown.length > limit && (
            <div className="media-more">
              <button className="btn ghost" onClick={() => setLimit((n) => n + 240)}>
                加载更多（剩余 {shown.length - limit} 个）
              </button>
            </div>
          )}

          {showFiles && fileItems.length > 0 && (
            <div className="file-block">
              <div className="file-block-head">
                <h4>文档与其它文件</h4>
                <span>{fileItems.length} 个</span>
              </div>
              <div className="file-list">
                {orderedFiles.map((f) => (
                  <div className="file-row" key={f.rel}>
                    <span className={`file-ext ext-${fileExt(f.name).slice(0, 4)}`}>{fileExt(f.name).toUpperCase().slice(0, 4) || "FILE"}</span>
                    <div className="file-info">
                      <b title={f.name}>{f.name}</b>
                      <span>
                        {f.id ? `消息 #${f.id} · ` : ""}
                        {bytes(f.size)}
                      </span>
                    </div>
                    <div className="file-actions">
                      <button className="btn sm ghost" onClick={() => openExternal(f)}>
                        <ExternalLink size={12} /> 打开
                      </button>
                      <button className="btn sm ghost" onClick={() => reveal(f)}>
                        <LocateFixed size={12} /> 定位
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {viewer && viewer.items[viewer.index] && (
        <MediaViewer
          chat={chat}
          items={viewer.items}
          index={viewer.index}
          onIndex={(index) => setViewer((v) => (v ? { ...v, index } : v))}
          onClose={() => setViewer(null)}
          onReveal={reveal}
          onOpen={openExternal}
          prefs={ctx.prefs}
        />
      )}
      {audioItem && (
        <AudioViewer chat={chat} item={audioItem} onClose={() => setAudioItem(null)} onReveal={reveal} />
      )}
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
  isFullscreen(): boolean;
  setFullscreen(on: boolean): void;
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
}>(function ArtVideo({ src, poster, maxVolume, frameAspect, knownRatio, hasNext, autoNext, onNext }, ref) {
  const wrap = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const fitRef = useRef<() => void>(() => undefined);
  const posterRatio = useRef(0);
  const playerRef = useRef<Artplayer | null>(null);
  const autoNextRef = useRef(autoNext);
  const onNextRef = useRef(onNext);
  autoNextRef.current = autoNext;
  onNextRef.current = onNext;
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
    isFullscreen: () => !!playerRef.current?.fullscreen,
    setFullscreen(on) {
      const p = playerRef.current;
      if (p) p.fullscreen = on;
    },
  }), [maxVolume]);

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
      fullscreen: true,
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
      if (autoNextRef.current) onNextRef.current();
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
      let ratio = frameAspect === "16:9" ? 16 / 9
        : frameAspect === "4:3" ? 4 / 3
        : knownRatio > 0 ? knownRatio
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
    };
    const revealFirstFrame = () => {
      if (revealed) return;
      revealed = true;
      hideControls();
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
    const stageEl = wrap.current?.parentElement;
    const observer = typeof ResizeObserver !== "undefined" && stageEl ? new ResizeObserver(fitFrame) : null;
    observer?.observe(stageEl as Element);
    window.addEventListener("resize", fitFrame);
    if (hasNext) {
      const icon = document.createElement("div");
      icon.className = "art-icon";
      icon.innerHTML = '<svg viewBox="0 0 22 22" width="22" height="22" fill="currentColor"><path d="M14.98 9.24 7.06 4.25A1.9 1.9 0 0 0 4.2 5.9v10.2a1.9 1.9 0 0 0 2.86 1.65l7.92-4.99a1.9 1.9 0 0 0 0-3.52z"/><rect x="15.6" y="4" width="2" height="14" rx="1"/></svg>';
      player.controls.add({
        name: "next",
        position: "left",
        index: 11,
        html: icon,
        click: onNext,
      });
    }
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
      player.destroy(false);
      playerRef.current = null;
    };
  }, [src, poster, frameAspect, knownRatio, hasNext]);

  return (
    <>
      <div ref={wrap} className={`art-video-wrap ${ready ? "is-ready" : "is-loading"} ${framed ? "" : "is-pre-meta"}`}>
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

function MediaViewer({
  chat,
  items,
  index,
  onIndex,
  onClose,
  onReveal,
  onOpen,
  prefs,
}: {
  chat: ChatRow;
  items: MediaItem[];
  index: number;
  onIndex: (n: number) => void;
  onClose: () => void;
  onReveal: (item: MediaItem) => void;
  onOpen: (item: MediaItem) => void;
  prefs: ViewerPrefs;
}) {
  const item = items[index];
  const isVideo = item.kind === "video";
  const src = mediaURL(chat.slug, item.rel);
  const poster = item.thumb ? thumbURL(chat.slug, item.thumb) : "";
  const knownRatio = item.width && item.height ? item.width / item.height : 0;
  const ambient = item.thumb ? thumbURL(chat.slug, item.thumb) : isVideo ? poster : src;
  const modal = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const active = useRef<HTMLButtonElement>(null);
  const api = useRef<VideoApi | null>(null);
  const hold = useRef<{ key: string; timer: number; long: boolean; direction: number } | null>(null);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [imageReady, setImageReady] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  const [tone, setTone] = useState("hsl(221 24% 14%)");
  const [immersive, setImmersive] = useState(false);
  const immersiveRef = useRef(false);
  immersiveRef.current = immersive;
  const [fsSwitching, setFsSwitching] = useState(false);
  const [fsDirection, setFsDirection] = useState<"in" | "out">("in");
  const [fsSettling, setFsSettling] = useState(false);
  const fsMaskTimer = useRef<number | null>(null);
  const fsStartedAt = useRef(0);

  useEffect(() => {
    setImageReady(false);
    setImageBusy(false);
    if (isVideo) return;
    const timer = window.setTimeout(() => setImageBusy(true), 350);
    return () => window.clearTimeout(timer);
  }, [item.rel, isVideo]);

  useEffect(() => {
    if (imageReady) setImageBusy(false);
  }, [imageReady]);
  const stateRef = useRef({ index, items, onIndex, onClose, prefs, kind: item.kind });
  stateRef.current = { index, items, onIndex, onClose, prefs, kind: item.kind };

  useEffect(() => {
    if (prefs.backdrop !== "solid") return;
    let alive = true;
    void coverTone(ambient).then((value) => {
      if (alive) setTone(value);
    });
    return () => { alive = false; };
  }, [ambient, prefs.backdrop]);

  useEffect(() => {
    const controller = new AbortController();
    const next = items[index + 1];
    const prev = items[index - 1];
    const range = (target: MediaItem, bytes: number) =>
      fetch(mediaURL(chat.slug, target.rel), {
        headers: { Range: `bytes=0-${bytes}` },
        signal: controller.signal,
        cache: "force-cache",
      }).catch(() => undefined);
    if (next?.kind === "video") {
      if (item.kind === "video" && next.size > 0 && next.size <= 64 * 1024 * 1024) {
        // Prime the next clip completely so automatic continuation starts at once.
        fetch(mediaURL(chat.slug, next.rel), { signal: controller.signal, cache: "force-cache" })
          .then((res) => res.arrayBuffer())
          .catch(() => undefined);
      } else {
        void range(next, 4 * 1024 * 1024);
      }
    }
    if (prev?.kind === "video") void range(prev, 2 * 1024 * 1024);
    return () => controller.abort();
  }, [chat.slug, items, index, item.kind]);

  useEffect(() => {
    active.current?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }, [index]);

  useEffect(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    setDragging(false);
    setShowKeys(false);
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

  const beginFullscreenSwitch = (direction: "in" | "out") => {
    fsStartedAt.current = performance.now();
    setFsDirection(direction);
    setFsSettling(false);
    setFsSwitching(true);
    if (fsMaskTimer.current) window.clearTimeout(fsMaskTimer.current);
    // Safety net if fullscreenchange never arrives in this WebView.
    fsMaskTimer.current = window.setTimeout(() => setFsSwitching(false), 1800);
  };

  const settleFullscreenSwitch = () => {
    if (fsMaskTimer.current) window.clearTimeout(fsMaskTimer.current);
    const delay = Math.max(0, 320 - (performance.now() - fsStartedAt.current));
    window.setTimeout(() => {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          setFsSettling(true);
          fsMaskTimer.current = window.setTimeout(() => {
            setFsSwitching(false);
            setFsSettling(false);
          }, 300);
        });
      });
    }, delay);
  };

  const toggleFullscreen = () => {
    const entering = !document.fullscreenElement;
    beginFullscreenSwitch(entering ? "in" : "out");
    // Let the blurred breathing cover paint before the viewport changes.
    window.setTimeout(() => {
      if (entering) void modal.current?.requestFullscreen().catch(() => setFsSwitching(false));
      else void document.exitFullscreen();
    }, 60);
  };

  const enterImmersive = () => {
    setImmersive(true);
    if (!document.fullscreenElement) {
      beginFullscreenSwitch("in");
      window.setTimeout(() => {
        void modal.current?.requestFullscreen().catch(() => setFsSwitching(false));
      }, 60);
    }
  };

  const exitImmersive = () => {
    setImmersive(false);
    if (document.fullscreenElement) {
      beginFullscreenSwitch("out");
      window.setTimeout(() => void document.exitFullscreen(), 60);
    }
  };

  useEffect(() => {
    const onFullscreen = () => {
      if (!document.fullscreenElement) {
        setImmersive(false);
        setFsDirection("out");
        // Native Esc can exit fullscreen without going through our button.
        setFsSwitching(true);
      }
      settleFullscreenSwitch();
    };
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreen);
      if (fsMaskTimer.current) window.clearTimeout(fsMaskTimer.current);
    };
  }, []);

  const exitFullscreenWithCover = () => {
    beginFullscreenSwitch("out");
    window.setTimeout(() => void document.exitFullscreen(), 60);
  };

  useEffect(() => {
    const clearHold = () => {
      if (hold.current) {
        window.clearTimeout(hold.current.timer);
        if (hold.current.long) api.current?.endBoost();
        hold.current = null;
      }
    };
    const seekImage = (direction: number) => {
      const st = stateRef.current;
      const next = st.index + direction;
      if (next >= 0 && next < st.items.length) st.onIndex(next);
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
        if (document.fullscreenElement) {
          exitFullscreenWithCover();
        }
        else if (st.kind === "video" && api.current?.isFullscreen()) api.current.setFullscreen(false);
        else if (immersiveRef.current) setImmersive(false);
        else st.onClose();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        toggleFullscreen();
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
    if (isVideo) return;
    e.preventDefault();
    const rect = stage.current?.getBoundingClientRect();
    if (!rect) return;
    const cx = e.clientX - rect.left - rect.width / 2;
    const cy = e.clientY - rect.top - rect.height / 2;
    setZoom((prev) => {
      const next = Math.max(1, Math.min(6, Math.round(prev * (e.deltaY < 0 ? 1.12 : 0.9) * 100) / 100));
      if (next === 1) {
        setOffset({ x: 0, y: 0 });
      } else {
        const ratio = next / prev;
        setOffset((o) => ({ x: cx - ratio * (cx - o.x), y: cy - ratio * (cy - o.y) }));
      }
      return next;
    });
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isVideo || zoom <= 1) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    setOffset({ x: drag.current.ox + e.clientX - drag.current.x, y: drag.current.oy + e.clientY - drag.current.y });
  };
  const onPointerUp = () => {
    drag.current = null;
    setDragging(false);
  };

  return (
    <div ref={modal} className={`media-modal viewer-modal backdrop-${prefs.backdrop} ${immersive ? "immersive" : ""} ${fsSwitching ? "switching-fullscreen" : ""}`} role="dialog" aria-modal="true" aria-label={`${isVideo ? "视频" : "图片"}：${item.name}`}>
      {fsSwitching && (
        <div className={`viewer-fs-cover ${fsDirection} ${fsSettling ? "settle" : ""}`} aria-hidden="true">
          <div className="viewer-fs-zoom"><span className="viewer-fs-orb" /></div>
        </div>
      )}
      <div
        className={`viewer-ambient ${prefs.backdrop === "solid" ? "solid" : "ambient"}`}
        style={prefs.backdrop === "ambient" && ambient
          ? { backgroundImage: `radial-gradient(62% 72% at 16% 6%, rgba(47, 107, 255, .26), transparent 62%), radial-gradient(56% 64% at 86% 86%, rgba(124, 92, 255, .22), transparent 66%), url(${ambient})` }
          : prefs.backdrop === "solid" ? { background: tone }
          : ambient ? { backgroundImage: `radial-gradient(62% 72% at 16% 6%, rgba(47, 107, 255, .2), transparent 62%), radial-gradient(56% 64% at 86% 86%, rgba(124, 92, 255, .16), transparent 66%), url(${ambient})` }
          : undefined}
        aria-hidden="true"
      />
      <header className="media-modal-head viewer-head">
        <span className="media-modal-name" title={item.name}>{item.name}</span>
        <span className="media-modal-count">{index + 1} / {items.length} · {bytes(item.size)}</span>
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
          <Maximize2 size={12} /> 全屏
        </button>
        <button className="viewer-close" aria-label="关闭查看器" onClick={onClose}>
          <X size={17} />
        </button>
      </header>

      <div className={`media-modal-main viewer-stage ${isVideo ? "video" : "image"}`}>
        {isVideo ? (
          <ArtVideo
            ref={api}
            key={item.rel}
            src={src}
            poster={poster || ""}
            maxVolume={prefs.maxVolume}
            frameAspect={prefs.videoFrameAspect}
            knownRatio={knownRatio}
            hasNext={index < items.length - 1}
            autoNext={items[index + 1]?.kind === "video"}
            onNext={() => onIndex(index + 1)}
          />
        ) : (
          <div
            ref={stage}
            className={`image-stage ${zoom > 1 ? "zoomed" : ""} ${dragging ? "dragging" : ""}`}
            onWheel={onWheel}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onDoubleClick={() => {
              if (zoom > 1) resetZoom();
              else setZoom(2);
            }}
          >
            <img
              src={src}
              alt={item.name}
              draggable={false}
              loading="eager"
              onLoad={() => setImageReady(true)}
              onError={() => setImageReady(true)}
              style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` }}
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
                  <dt>双击</dt><dd>1× / 2× 切换</dd>
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
        {items.map((v, i) => (
          <button key={v.rel} ref={i === index ? active : undefined} className={i === index ? "on" : ""} title={v.name} onClick={() => onIndex(i)}>
            {v.thumb ? <img src={thumbURL(chat.slug, v.thumb)} alt="" loading="lazy" /> : v.kind === "image" ? <img src={mediaURL(chat.slug, v.rel)} alt="" loading="lazy" /> : <Film size={18} />}
            <span className="strip-index">{i + 1}</span>
            {v.kind === "video" && <span className="strip-kind"><Play size={9} fill="currentColor" /></span>}
          </button>
        ))}
      </div>
      <button className="media-nav prev" disabled={index <= 0} aria-label="上一个" onClick={() => onIndex(index - 1)}>
        <ChevronLeft size={26} />
      </button>
      <button className="media-nav next" disabled={index >= items.length - 1} aria-label="下一个" onClick={() => onIndex(index + 1)}>
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
  onClose,
  onReveal,
}: {
  chat: ChatRow;
  item: MediaItem;
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
        <audio src={mediaURL(chat.slug, item.rel)} controls autoPlay className="audio-native" />
      </div>
    </div>
  );
}

/* ============================= Library ============================= */
interface OfficialMeta {
  name: string;
  messageCount: number;
  mediaFiles: number;
  root: string;
  matchedSlug?: string;
}
interface OfficialPreview {
  meta: OfficialMeta;
  matchSlug?: string;
  chats: ChatRow[];
}

export function Library({ ctx }: { ctx: PageCtx }) {
  const { boot, chats, selected, setSelected, refresh, toast, pickFolder, pickFiles, go } = ctx;
  const history = boot?.history ?? [];
  const [official, setOfficial] = useState<OfficialPreview | null>(null);
  const [target, setTarget] = useState("");
  const [mode, setMode] = useState("managed");
  const [busy, setBusy] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<ChatRow[]>([]);
  const [detailChat, setDetailChat] = useState<ChatRow | null>(null);
  const [detailStats, setDetailStats] = useState<Stats | null>(null);
  const [remote, setRemote] = useState<RemoteStatus | null>(null);
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [remotePath, setRemotePath] = useState("");
  const [remoteProbe, setRemoteProbe] = useState<RemoteStatus | null>(null);
  const [remoteTesting, setRemoteTesting] = useState(false);
  const [remoteTools, setRemoteTools] = useState<RemoteTools | null>(null);
  const [rcloneOpen, setRcloneOpen] = useState(false);
  const [rcloneRemote, setRcloneRemote] = useState("");
  const [rcloneSub, setRcloneSub] = useState("");
  const [rcloneDrive, setRcloneDrive] = useState("Z");
  const [rcloneBusy, setRcloneBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const probe = () => call<RemoteStatus>("remoteStatus")
      .then((st) => { if (!cancelled) setRemote(st); })
      .catch(() => undefined);
    void probe();
    const timer = window.setInterval(probe, 30000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [boot?.libraryRoot]);

  useEffect(() => {
    let cancelled = false;
    setDetailStats(null);
    if (detailChat) {
      call<Stats>("verifyChat", { slug: detailChat.slug })
        .then((st) => { if (!cancelled) setDetailStats(st); })
        .catch(() => undefined);
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailChat?.slug]);

  const openRemote = () => {
    setRemoteOpen(true);
    setRemotePath(remote?.remote ? remote.root : "");
    setRemoteProbe(null);
    setRemoteTools(null);
    setRcloneOpen(false);
    setRcloneBusy(false);
    call<RemoteTools>("remoteTools").then((tools) => {
      setRemoteTools(tools);
      if (tools.rcloneRemotes?.length) setRcloneRemote(tools.rcloneRemotes[0]);
    }).catch(() => undefined);
  };
  const mountRclone = async () => {
    if (!rcloneRemote) {
      toast("请选择 rclone remote", true);
      return;
    }
    setRcloneBusy(true);
    try {
      const mounted = await call<string>("rcloneMount", { name: rcloneRemote, path: rcloneSub, drive: rcloneDrive });
      setRemotePath(mounted);
      setRcloneOpen(false);
      const st = await call<RemoteStatus>("remoteStatus", { root: mounted });
      setRemoteProbe(st);
      toast(`rclone 已挂载到 ${mounted}`);
    } catch (e) {
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
    try {
      const st = await call<RemoteStatus>("remoteStatus", { root });
      setRemoteProbe(st);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setRemoteTesting(false);
    }
  };
  const useRemote = async () => {
    if (!remoteProbe?.reachable || !remoteProbe.writable) return;
    await switchTo(remoteProbe.root);
    setRemoteOpen(false);
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

  const switchTo = async (root: string) => {
    setBusy("switch");
    try {
      await call("switchLibrary", { root });
      toast("已切换档案库");
      refresh();
    } catch (e) {
      toast((e as Error).message, true);
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
      await call("startMergeLibrary", { root });
      toast("合并任务已加入任务中心");
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
      await call("startImportOfficial", { folder: official.meta.root, slug: target, mode });
      toast("官方导出任务已加入任务中心");
      setOfficial(null);
      refresh();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy("");
    }
  };

  const refreshAll = async () => {
    try {
      await call("startRefreshAllWeb");
      toast("重建任务已加入任务中心");
    } catch (e) {
      toast((e as Error).message, true);
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
          <button className="action-card" onClick={refreshAll}>
            <span className="action-icon"><RefreshCw size={18} /></span>
            <span className="action-text">
              <b>重建全部网页</b>
              <em>重新生成所有聊天的浏览页面与搜索索引</em>
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
                  onClick={() => setDetailChat(c)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      setDetailChat(c);
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
        <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setRemoteOpen(false); }}>
          <div className="modal remote-modal" role="dialog" aria-modal="true" aria-labelledby="remote-title">
            <div className="remote-head">
              <div className="remote-title">
                <span className="remote-title-icon"><Network size={18} /></span>
                <div>
                  <h2 id="remote-title">添加网络档案库</h2>
                  <p>直接使用 SMB / UNC，或先用 rclone / SSHFS 挂载为盘符，再选择该位置。</p>
                </div>
              </div>
              <button className="icon-btn" aria-label="关闭网络档案库设置" onClick={() => setRemoteOpen(false)}>
                <X size={15} />
              </button>
            </div>
            <div className="remote-body">
              {remote && (
                <div className={`remote-current ${remote.remote ? "is-remote" : ""} ${remote.reachable ? "" : "is-offline"}`}>
                  <span className="remote-current-icon"><Database size={16} /></span>
                  <div>
                    <b>{remote.remote ? "当前为远程档案库" : "当前为本地档案库"}</b>
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

              <div className="remote-form">
                <label htmlFor="remote-path-input">网络位置或盘符</label>
                <div className="remote-path-row">
                  <input
                    id="remote-path-input"
                    value={remotePath}
                    onChange={(e) => { setRemotePath(e.target.value); setRemoteProbe(null); }}
                    onKeyDown={(e) => { if (e.key === "Enter") void testRemote(); }}
                    placeholder="\\NAS\share\TG Library 或 Z:\TG Library"
                    spellCheck={false}
                  />
                  <button
                    className="btn ghost"
                    onClick={async () => {
                      const picked = await pickFolder("remote-library", "选择网络位置或盘符");
                      if (picked) { setRemotePath(picked); setRemoteProbe(null); }
                    }}
                  >
                    <FolderOpen size={13} /> 浏览…
                  </button>
                </div>
                <div className="remote-form-actions">
                  <button className="btn" disabled={remoteTesting || !remotePath.trim()} onClick={() => void testRemote()}>
                    {remoteTesting ? <Loader2 size={13} className="spin" /> : <Wifi size={13} />}
                    {remoteTesting ? "正在测试…" : "测试连接"}
                  </button>
                  <button className="btn primary" disabled={!remoteProbe || !remoteProbe.reachable || !remoteProbe.writable} onClick={() => void useRemote()}>
                    {remoteProbe?.reachable && remoteProbe.writable ? <CheckCircle2 size={13} /> : <WifiOff size={13} />}
                    切换到此库
                  </button>
                </div>
              </div>

              {remoteProbe && (
                <div className={`remote-probe ${remoteProbe.reachable && remoteProbe.writable ? "ok" : "bad"}`}>
                  <span className="remote-probe-icon">
                    {remoteProbe.reachable && remoteProbe.writable ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
                  </span>
                  <div>
                    <b>{remoteProbe.reachable && remoteProbe.writable ? "连接正常，可以切换" : "还不可用"}</b>
                    <span>{pathKindLabel(remoteProbe.kind)} · {remoteProbe.latencyMs} ms{remoteProbe.freeKnown ? ` · ${bytes(remoteProbe.freeBytes)} 可用` : " · 空间未知"}</span>
                    {remoteProbe.error && <em>{remoteProbe.error}</em>}
                  </div>
                </div>
              )}

              <div className="remote-options-head">
                <h3>没有挂载网络位置？</h3>
                <p>以下工具会把远程存储挂载成本地盘符；挂载完成后回到上方选择该盘符即可。</p>
              </div>
              <div className="remote-options">
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
                  {remoteTools?.rcloneRemotes?.length ? (
                    <button className="btn sm ghost" onClick={() => setRcloneOpen((v) => !v)}>
                      <Server size={12} /> 挂载 remote
                    </button>
                  ) : remoteTools?.rclone ? (
                    <button className="btn sm ghost" onClick={() => copyRemoteCommand("rclone config")}>
                      <Copy size={12} /> 配置 remote
                    </button>
                  ) : (
                    <button className="btn sm ghost" onClick={() => copyRemoteCommand(remoteTools?.winFsp ? "winget install Rclone.Rclone" : "winget install Rclone.Rclone\nwinget install WinFsp.WinFsp")}>
                      <Copy size={12} /> 复制安装命令
                    </button>
                  )}
                </div>
                <div className="remote-option">
                  <span className="remote-option-icon"><Server size={17} /></span>
                  <div className="remote-option-main">
                    <b>SSHFS-Win <em>SSH / SFTP</em></b>
                    <span>适合 Linux 服务器或 NAS 的 SSH；安装后映射 <code>\\sshfs\user@host</code> 即可。</span>
                    <div className="remote-tool-state">
                      <em className={remoteTools?.sshfs ? "ok" : ""}>SSHFS {remoteTools?.sshfs ? "已安装" : "未检测到"}</em>
                      <em className={remoteTools?.winFsp ? "ok" : ""}>WinFsp {remoteTools?.winFsp ? "已安装" : "未检测到"}</em>
                    </div>
                  </div>
                  {remoteTools?.sshfs ? (
                    <button className="btn sm ghost" onClick={() => copyRemoteCommand("net use X: \\\\sshfs\\user@host")}>
                      <Copy size={12} /> 复制映射命令
                    </button>
                  ) : (
                    <button className="btn sm ghost" onClick={() => copyRemoteCommand("winget install SSHFS-Win.SSHFS-Win")}>
                      <Copy size={12} /> 复制安装命令
                    </button>
                  )}
                </div>
                <div className="remote-option muted">
                  <span className="remote-option-icon"><Network size={17} /></span>
                  <div className="remote-option-main">
                    <b>原生 SFTP / Remote Agent <em>3.1 评估</em></b>
                    <span>不依赖挂载：应用内镜像或 NAS 端 Agent 通过 HTTP 访问；需要额外的同步/冲突协议，放在 3.1 评估。</span>
                  </div>
                  <span className="remote-planned">规划中</span>
                </div>
              </div>
              {rcloneOpen && (
                <div className="rclone-form">
                  <div className="rclone-form-head">
                    <b>挂载 rclone remote</b>
                    <span>选择一个已配置的 remote，挂载为盘符后即可作为档案库。</span>
                  </div>
                  <div className="rclone-fields">
                    <div className="rclone-field grow">
                      <span>Remote</span>
                      <Select
                        ariaLabel="选择 rclone remote"
                        value={rcloneRemote}
                        onChange={setRcloneRemote}
                        options={(remoteTools?.rcloneRemotes || []).map((r) => ({ value: r, label: r }))}
                      />
                    </div>
                    <div className="rclone-field grow">
                      <span>子路径</span>
                      <input value={rcloneSub} onChange={(e) => setRcloneSub(e.target.value)} placeholder="TG Library（可留空）" spellCheck={false} aria-label="rclone 子路径" />
                    </div>
                    <div className="rclone-field drive">
                      <span>盘符</span>
                      <input value={rcloneDrive} onChange={(e) => setRcloneDrive(e.target.value.slice(0, 2).toUpperCase())} placeholder="Z" maxLength={2} spellCheck={false} aria-label="rclone 挂载盘符" />
                    </div>
                    <button className="btn primary rclone-mount-btn" disabled={rcloneBusy || !rcloneRemote} onClick={() => void mountRclone()}>
                      {rcloneBusy ? <Loader2 size={13} className="spin" /> : <Network size={13} />}
                      {rcloneBusy ? "挂载中…" : "挂载并测试"}
                    </button>
                  </div>
                  <p>挂载成功后会自动填入上方路径；TAK 退出时会结束自己启动的 rclone 进程。</p>
                </div>
              )}
              <p className="remote-note">TAK 不保存 SMB 密码；网络共享使用 Windows 凭据管理器，rclone / SSHFS 由对应工具管理凭据。远程库的缩略图与视频播放缓存会在本机单独保存。</p>
            </div>
          </div>
        </div>,
        document.body
      )}

      {detailChat && createPortal(
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
                <b>{detailChat.media.toLocaleString()}{detailChat.missing > 0 && <em> · 缺 {detailChat.missing}</em>}</b>
              </div>
              <div className="chat-detail-tile">
                <span>图片 / 视频</span>
                <b>{detailStats ? `${detailStats.images} / ${detailStats.videos}` : "—"}</b>
              </div>
              <div className="chat-detail-tile">
                <span>音频 / 文件</span>
                <b>{detailStats ? `${detailStats.audio} / ${detailStats.files}` : "—"}</b>
              </div>
              <div className="chat-detail-tile"><span>最早消息</span><b>{dateTime(detailChat.firstTs)}</b></div>
              <div className="chat-detail-tile"><span>最新消息</span><b>{dateTime(detailChat.lastTs)}</b></div>
              <div className="chat-detail-tile"><span>最近更新</span><b>{dateTime(detailChat.updatedAt)}</b></div>
              <div className="chat-detail-tile"><span>网页</span><b>{detailChat.pages} 页</b></div>
              <div className="chat-detail-tile"><span>官方 ChatExport</span><b>{detailChat.official} 份</b></div>
              <div className="chat-detail-tile"><span>生成器</span><b>TelegramArchiveKit {ctx.boot?.version || "3.0"}</b></div>
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
              <span>{official.meta.messageCount.toLocaleString()} 条消息 · {official.meta.mediaFiles.toLocaleString()} 个媒体文件</span>
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
  version: string;
}

function SettingsField({ label, hint, children, wide }: { label: string; hint?: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`field ${wide ? "wide" : ""}`}>
      <label>{label}</label>
      <div className="field-control">{children}</div>
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

function SettingsToggle({ checked, onChange, title, desc }: { checked: boolean; onChange: (v: boolean) => void; title: string; desc: string }) {
  return (
    <label className="switch-row">
      <span>
        <b>{title}</b>
        <em>{desc}</em>
      </span>
      <span className={`switch ${checked ? "on" : ""}`}>
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <i />
      </span>
    </label>
  );
}

export function SettingsPage({ ctx }: { ctx: PageCtx }) {
  const { toast, applyPrefs } = ctx;
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [original, setOriginal] = useState<SettingsForm | null>(null);
  const [saving, setSaving] = useState(false);

  const load = () =>
    call<SettingsForm>("getSettings")
      .then((data) => {
        setForm(data);
        setOriginal(data);
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

  const dirty = original ? JSON.stringify(form) !== JSON.stringify(original) : false;
  const set = <K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) => setForm((f) => (f ? { ...f, [key]: value } : f));

  const save = async () => {
    setSaving(true);
    try {
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
      toast("设置已保存");
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
  const [content, setContent] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const nextRows = await call<DiagRow[]>("diagnostics");
      setRows(nextRows);
      const list = await call<LogInfo[]>("listLogs");
      setLogs(list);
      if (!active && list.length > 0) setActive(list[0].name);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (!active) return;
    call<string>("readLog", { name: active })
      .then(setContent)
      .catch((e: Error) => setContent(e.message));
  }, [active]);

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
              <div className="chart-empty">没有匹配的日志。</div>
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
            <pre className="logview">{content || "选择左侧日志查看内容。"}</pre>
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
