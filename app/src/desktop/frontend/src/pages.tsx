import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  AtSign,
  ChartPie,
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
  FolderPlus,
  GitMerge,
  Keyboard,
  RotateCcw,
  Save,
  Search,
  Send,
  Film,
  FileText,
  Images,
  KeyRound,
  ListTodo,
  LocateFixed,
  Maximize2,
  MessagesSquare,
  Music,
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
import Lightbox from "yet-another-react-lightbox";
import Zoom from "yet-another-react-lightbox/plugins/zoom";
import Thumbnails from "yet-another-react-lightbox/plugins/thumbnails";
import "yet-another-react-lightbox/styles.css";
import "yet-another-react-lightbox/plugins/thumbnails.css";
import Artplayer from "artplayer";
import { call } from "./rpc";
import { Select } from "./Select";
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
  SessionCheck,
  TdlInfo,
  TaskDetail,
  TaskInfo,
  ViewerPrefs,
} from "./types";
import { bytes, duration, rate } from "./format";

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
  pickFiles: (purpose: string) => Promise<string[]>;
  pickFolder: (purpose: string, title: string) => Promise<string>;
  tasks: TaskInfo[];
  openTasks: () => void;
  prefs: ViewerPrefs;
  applyPrefs: (p: ViewerPrefs) => void;
  taskFocus: string | null;
}

const kindLabel = (kind: string): string =>
  kind === "image" ? "图片" : kind === "video" ? "视频" : kind === "audio" ? "音频" : "文件";

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
  const { boot, chats, selected, setSelected, refresh, toast, go, tasks, openTasks, pickFiles } = ctx;
  const [stats, setStats] = useState<HomeStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncSlug, setSyncSlug] = useState(selected);
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
      await call("startOneClick", { slug });
      toast("已开始同步：" + (chats.find((c) => c.slug === slug)?.name ?? "聊天"));
      go("overview");
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const syncAllMissing = async () => {
    const missing = chats.filter((c) => c.missing > 0);
    if (missing.length === 0) {
      toast("所有聊天都没有缺失媒体");
      return;
    }
    if (!window.confirm(`将依次同步 ${missing.length} 个存在缺失媒体的聊天，期间会下载并重建网页。继续？`)) return;
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
          <p className="home-lede">把 Telegram 的聊天、图片和视频整理成本地可浏览的档案；下载、构建与检索都在这里完成。</p>
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
          <footer className="sync-foot">
            <span>{chats.length} 个聊天 · {missingTotal > 0 ? `${missingTotal} 个缺失媒体` : "媒体完整"}</span>
            <button className="link-btn" onClick={() => go("library")}>
              管理聊天 <ArrowRight size={12} />
            </button>
          </footer>
        </section>
      </section>

      <section className="stat-grid">
        <div className="stat">
          <span>聊天</span>
          <div><b>{chats.length}</b><em>个档案</em></div>
        </div>
        <div className="stat">
          <span>消息</span>
          <div><b>{(stats?.messages ?? 0).toLocaleString()}</b><em>条</em></div>
        </div>
        <div className="stat">
          <span>本地媒体</span>
          <div><b>{(stats?.media ?? 0).toLocaleString()}</b><em>个</em></div>
        </div>
        <div className="stat">
          <span>缺失媒体</span>
          <div><b className={stats && stats.missing > 0 ? "warn" : ""}>{stats?.missing ?? 0}</b><em>个</em></div>
        </div>
      </section>

      <div className="home-grid home-grid-even">
        <section className="panel">
          <div className="panel-head">
            <h3><ChartPie size={14} /> 媒体构成</h3>
            <span className="meta">{loading ? "正在统计…" : `共 ${totalMedia.toLocaleString()} 个`}</span>
          </div>
          <div className="media-composition">
            <div className="media-stack" aria-hidden="true">
              {totalMedia === 0 ? <i className="empty" /> : MEDIA_KINDS.map((k) => {
                const value = stats?.[k.key] ?? 0;
                if (value === 0) return null;
                return <i key={k.key} style={{ width: `${(value * 100) / totalMedia}%`, background: k.color }} />;
              })}
            </div>
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

        <section className="panel">
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
                  {t.state === "running" ? <RefreshCw size={13} className="spin" /> : t.state === "done" ? <CheckCircle2 size={13} color="var(--ok)" /> : <X size={13} color="var(--danger)" />}
                  <span>{t.title}</span>
                  <em>{t.state === "running" ? `${t.percent}%` : t.state === "done" ? "完成" : "失败"}</em>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  );
}

/* ============================ Overview ============================ */
const SPEED_WINDOWS = [
  { value: "60", label: "最近 1 分钟" },
  { value: "180", label: "最近 3 分钟" },
  { value: "300", label: "最近 5 分钟" },
  { value: "600", label: "最近 10 分钟" },
  { value: "900", label: "最近 15 分钟" },
];

export function Overview({ ctx }: { ctx: PageCtx }) {
  const { chats, selected, dl, op, done, running, history, refresh, toast, prefs, taskFocus, go } = ctx;
  const current = chats.find((c) => c.slug === selected) || null;
  const [historyTask, setHistoryTask] = useState<TaskDetail | null>(null);

  useEffect(() => {
    if (!taskFocus) {
      setHistoryTask(null);
      return;
    }
    call<TaskDetail>("taskDetail", { id: taskFocus })
      .then(setHistoryTask)
      .catch(() => setHistoryTask(null));
  }, [taskFocus]);
  const [windowSec, setWindowSec] = useState(() => {
    const saved = Number(localStorage.getItem("tak-speed-window") || 0);
    return saved >= 60 && saved <= 900 ? saved : prefs.speedWindowSeconds || 180;
  });
  useEffect(() => {
    localStorage.setItem("tak-speed-window", String(windowSec));
  }, [windowSec]);

  const percent = useMemo(() => {
    if (dl) return Math.max(0, Math.min(100, dl.percent));
    if (op && op.total > 0) return Math.max(0, Math.min(100, (op.current * 100) / op.total));
    return 0;
  }, [dl, op]);

  const samples = useMemo(() => {
    const count = Math.max(2, Math.ceil(windowSec / 0.9));
    return history.slice(-count);
  }, [history, windowSec]);
  const chart = useMemo(() => {
    const W = 720;
    const H = 160;
    const left = 58;
    const right = 12;
    const top = 12;
    const bottom = 24;
    const plotW = W - left - right;
    const plotH = H - top - bottom;
    const max = Math.max(1, ...samples.flatMap((s) => [s.now, s.avg]));
    const point = (value: number, i: number, len: number) => {
      const x = left + (len <= 1 ? 0 : (i / (len - 1)) * plotW);
      const y = top + plotH - Math.min(1, value / max) * plotH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    };
    return {
      W, H, left, right, top, bottom, plotW, plotH, max,
      now: samples.map((s, i) => point(s.now, i, samples.length)).join(" "),
      avg: samples.map((s, i) => point(s.avg, i, samples.length)).join(" "),
      ticks: [0, 0.25, 0.5, 0.75, 1].map((f) => ({ y: top + plotH - f * plotH, label: rate(max * f) })),
      times: [1, 0.75, 0.5, 0.25, 0].map((f) => ({ x: left + f * plotW, label: f === 0 ? "现在" : f === 1 ? "最早" : `-${Math.round((windowSec * f) / 60)} 分` })),
    };
  }, [samples, windowSec]);

  const start = async () => {
    if (!selected || running) return;
    try {
      await call("startOneClick", { slug: selected });
      refresh();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const cancel = async () => {
    try {
      await call("cancel");
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  if (historyTask && historyTask.state !== "running") {
    const samples = (historyTask.series ?? []).map((p) => ({ now: p.now, avg: p.avg }));
    const maxSpeed = Math.max(1, ...samples.flatMap((s) => [s.now, s.avg]));
    const W = 720, H = 170, L = 64, R = 16, T = 12, B = 24;
    const plotW = W - L - R;
    const plotH = H - T - B;
    const points = (values: number[]) =>
      values.length === 0
        ? ""
        : values
            .map((v, i) => {
              const x = L + (samples.length <= 1 ? 0 : (i / (samples.length - 1)) * plotW);
              const y = T + plotH - Math.min(1, v / maxSpeed) * plotH;
              return `${x.toFixed(1)},${y.toFixed(1)}`;
            })
            .join(" ");
    const fmtDate = (ts?: number) => (ts ? new Date(ts).toLocaleString("zh-CN", { hour12: false }) : "--");
    const statusLabel = historyTask.state === "done" ? "已完成" : "失败";
    return (
      <>
        <div className="page-head">
          <div>
            <h1>下载详情</h1>
            <p>{historyTask.title} · {historyTask.chat || "未知聊天"} · {statusLabel}</p>
          </div>
          <div className="actions">
            <button className="btn ghost" onClick={() => go("tasks")}>
              <ListTodo size={13} /> 返回任务中心
            </button>
            <button className="btn ghost" onClick={() => historyTask.slug && call("openLibrary", { slug: historyTask.slug })} disabled={!historyTask.slug}>
              <FolderOpen size={13} /> 打开归档库
            </button>
          </div>
        </div>

        <section className={`hero history ${historyTask.state === "failed" ? "failed" : ""}`}>
          <div className="ring" style={{ background: `conic-gradient(${historyTask.state === "failed" ? "var(--danger)" : "var(--ok)"} 100%, var(--surface-3) 100%)` }}>
            {historyTask.state === "done" ? <CheckCircle2 size={22} /> : <X size={22} />}
          </div>
          <div className="hero-main">
            <div className="hero-title">
              {historyTask.title}
              <span className={`tag ${historyTask.state === "failed" ? "bad" : ""}`}>{statusLabel}</span>
            </div>
            <div className="hero-stage">{historyTask.error || historyTask.detail || "任务已结束"}</div>
            <div className="hero-meta">
              <span>开始 <b>{fmtDate(historyTask.startedAt)}</b></span>
              <span>耗时 <b>{duration(historyTask.elapsedMs || ((historyTask.finishedAt || historyTask.startedAt) - historyTask.startedAt))}</b></span>
              <span>平均 <b>{rate(historyTask.avgSpeed ?? 0)}</b></span>
              <span>峰值 <b>{rate(historyTask.peakSpeed ?? 0)}</b></span>
            </div>
          </div>
        </section>

        <section className="stat-grid">
          <div className="stat"><span>平均速度</span><div><b>{rate(historyTask.avgSpeed ?? 0)}</b></div></div>
          <div className="stat"><span>峰值速度</span><div><b>{rate(historyTask.peakSpeed ?? 0)}</b></div></div>
          <div className="stat"><span>下载总量</span><div><b>{bytes(historyTask.bytes ?? 0)}</b></div></div>
          <div className="stat"><span>完成媒体</span><div><b>{historyTask.done ?? 0}</b><em>/ {historyTask.total ?? 0}</em></div></div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3><ChartPie size={14} /> 历史速度曲线</h3>
            <span className="chart-legend"><i className="now" /> 实时 <i className="avg" /> 平均</span>
          </div>
          <div className="chart chart-axes">
            {samples.length >= 2 ? (
              <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-label="历史下载速度曲线">
                {[0, 0.25, 0.5, 0.75, 1].map((f) => {
                  const y = T + plotH - f * plotH;
                  return (
                    <g key={f}>
                      <line className="grid" x1={L} y1={y} x2={W - R} y2={y} />
                      <text className="axis-y" x={L - 8} y={y + 3} textAnchor="end">{rate(maxSpeed * f)}</text>
                    </g>
                  );
                })}
                <text className="axis-x" x={L} y={H - 6}>开始</text>
                <text className="axis-x" x={W - R} y={H - 6} textAnchor="end">结束</text>
                <polyline className="avg" points={points(samples.map((s) => s.avg))} />
                <polyline className="now" points={points(samples.map((s) => s.now))} />
              </svg>
            ) : (
              <div className="chart-empty">这个任务没有保留速度曲线（旧版本任务或未产生下载样本）。</div>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head"><h3>任务信息</h3><span className="meta">任务 {historyTask.id}</span></div>
          <div className="account-rows">
            <div><span>类型</span><b>下载 / 同步</b></div>
            <div><span>聊天</span><b>{historyTask.chat || "--"}</b></div>
            <div><span>开始时间</span><b>{fmtDate(historyTask.startedAt)}</b></div>
            <div><span>结束时间</span><b>{fmtDate(historyTask.finishedAt)}</b></div>
            <div><span>耗时</span><b>{duration(historyTask.elapsedMs || 0)}</b></div>
            <div><span>结果</span><b>{historyTask.error || "同步与网页构建完成"}</b></div>
          </div>
        </section>
      </>
    );
  }

  const idle = !running && !dl && !op;
  const title = running
    ? dl
      ? `正在同步：${current?.name || dl.chat || "聊天"}`
      : `正在同步：${current?.name || "聊天"}`
    : done
      ? done.ok
        ? "上次同步已完成"
        : "上次同步失败"
      : "准备同步";
  const stageText = running
    ? dl
      ? `第 ${dl.pass}/${dl.passMax} 轮 · 已下载 ${dl.done}/${dl.total} 个媒体${dl.detail ? " · " + dl.detail : ""}`
      : op
        ? `${op.stage}${op.detail ? " · " + op.detail : ""}`
        : "正在准备…"
    : done
      ? done.ok
        ? `消息 ${done.messages ?? 0} · 媒体 ${done.media ?? 0}${done.missing ? ` · 缺失 ${done.missing}` : ""}`
        : done.error || done.stage || "请重试"
      : current
        ? "点击「同步当前聊天」检查并补齐缺失媒体"
        : "先在左侧选择聊天";

  return (
    <>
      <div className="page-head">
        <div>
          <h1>下载中心</h1>
          <p>
            {current
              ? `当前聊天：${current.name} · ${current.messages.toLocaleString()} 条消息 · ${current.missing > 0 ? `缺失 ${current.missing} 个媒体` : "媒体完整"}`
              : "先在左侧选择聊天，或到档案库导入 result.json"}
          </p>
        </div>
        <div className="actions">
          <button className="btn ghost" onClick={() => go("tasks")}>
            <ListTodo size={13} /> 任务中心
          </button>
          <button className="btn ghost" onClick={() => current && call("openLibrary", { slug: current.slug })} disabled={!current}>
            <FolderOpen size={13} /> 打开归档库
          </button>
          {running ? (
            <button className="btn danger" onClick={cancel}>
              <Square size={12} /> 取消任务
            </button>
          ) : (
            <button className="btn primary" onClick={start} disabled={!current}>
              <Play size={13} /> 同步当前聊天
            </button>
          )}
        </div>
      </div>

      <section className={`hero ${!running && !dl ? "idle" : ""}`}>
        <div
          className={`ring ${idle ? "idle" : ""}`}
          role="progressbar"
          aria-valuenow={Math.round(percent)}
          aria-valuemin={0}
          aria-valuemax={100}
          style={{ background: idle ? "var(--surface-3)" : `conic-gradient(var(--accent) ${percent}%, var(--surface-3) ${percent}% 100%)` }}
        >
          {idle ? <Play size={20} /> : <b>{Math.round(percent)}%</b>}
        </div>
        <div className="hero-main">
          <div className="hero-title">
            {title}
            {running && <span className="tag">进行中</span>}
            {done && !running && <span className={`tag ${done.ok ? "" : "bad"}`}>{done.ok ? "已完成" : "失败"}</span>}
          </div>
          <div className="hero-stage" title={stageText}>{stageText}</div>
          {dl && (
            <div className="hero-meta">
              <span>速度 <b>{rate(dl.speedNow)}</b></span>
              <span>平均 <b>{rate(dl.speedAvg)}</b></span>
              <span>已下载 <b>{bytes(dl.bytes)}</b>{dl.knownBytes > 0 ? ` / ${bytes(dl.knownBytes)}` : ""}</span>
              <span>剩余 <b>{duration(dl.etaMs)}</b></span>
              <span>并发 <b>{dl.concurrent}</b> × <b>{dl.threads}</b></span>
              <span>第 <b>{dl.pass}</b> 轮</span>
            </div>
          )}
          {op && !dl && (
            <div className="hero-meta">
              <span>{op.stage}</span>
              {op.total > 0 && <span><b>{op.current} / {op.total} {op.unit}</b></span>}
            </div>
          )}
        </div>
      </section>

      <section className="stat-grid">
        <div className="stat">
          <span>实时速度</span>
          <div><b>{rate(dl?.speedNow ?? 0)}</b></div>
        </div>
        <div className="stat">
          <span>平均速度</span>
          <div><b>{rate(dl?.speedAvg ?? 0)}</b></div>
        </div>
        <div className="stat">
          <span>预计剩余</span>
          <div><b>{duration(dl?.etaMs ?? 0)}</b></div>
        </div>
        <div className="stat">
          <span>本轮完成</span>
          <div><b>{dl?.done ?? 0}</b><em>/ {dl?.total ?? 0}</em></div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3><ChartPie size={14} /> 速度曲线</h3>
          <span className="chart-legend"><i className="now" /> 实时 <i className="avg" /> 平均</span>
          <div className="chart-window">
            <Select ariaLabel="速度曲线时间窗" value={String(windowSec)} onChange={(v) => setWindowSec(Number(v))} options={SPEED_WINDOWS} />
          </div>
        </div>
        <div className="chart chart-axes">
          {samples.length >= 2 ? (
            <svg viewBox={`0 0 ${chart.W} ${chart.H}`} preserveAspectRatio="none" aria-label="下载速度曲线">
              {chart.ticks.map((t) => (
                <g key={t.y}>
                  <line className="grid" x1={chart.left} y1={t.y} x2={chart.W - chart.right} y2={t.y} />
                  <text className="axis-y" x={chart.left - 8} y={t.y + 3} textAnchor="end">{t.label}</text>
                </g>
              ))}
              {chart.times.map((t) => (
                <text key={t.x} className="axis-x" x={t.x} y={chart.H - 6} textAnchor={t.x === chart.left ? "start" : t.x === chart.W - chart.right ? "end" : "middle"}>{t.label}</text>
              ))}
              <polyline className="avg" points={chart.avg} />
              <polyline className="now" points={chart.now} />
            </svg>
          ) : (
            <div className="chart-empty">同步开始后显示实时 / 平均速度曲线。</div>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>正在下载</h3>
          <span className="meta">{(dl?.active ?? []).length} 个文件</span>
        </div>
        {dl && (dl.active ?? []).length > 0 ? (
          <table className="table task-table download-table">
            <thead>
              <tr>
                <th>文件</th>
                <th className="hide-sm">类型</th>
                <th>进度</th>
                <th>已传 / 期望</th>
                <th>速度</th>
                <th className="hide-sm">剩余</th>
              </tr>
            </thead>
            <tbody>
              {(dl.active ?? []).map((t) => (
                <tr key={t.id}>
                  <td className="name" title={t.name}>{t.name}</td>
                  <td className="hide-sm"><span className={`kind-chip ${t.kind}`}>{kindLabel(t.kind)}</span></td>
                  <td>
                    <div className="progress-inline">
                      <div className="mini"><i style={{ width: `${Math.max(0, Math.min(100, t.percent))}%` }} /></div>
                      <span className={t.stalled ? "stalled" : ""}>{t.stalled ? "停滞" : t.percent >= 0 ? `${t.percent.toFixed(0)}%` : "—"}</span>
                    </div>
                  </td>
                  <td>{bytes(t.transferred)}{t.expected > 0 ? ` / ${bytes(t.expected)}` : ""}</td>
                  <td>{rate(t.speed)}</td>
                  <td className="hide-sm">{duration(t.etaMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="chart-empty">没有正在下载的文件。</div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>最近完成</h3>
          <span className="meta">{(dl?.completed ?? []).length} 个</span>
        </div>
        {dl && (dl.completed ?? []).length > 0 ? (
          <div className="done-list">
            {(dl.completed ?? []).map((t) => (
              <div className="done-row" key={t.id}>
                <CheckCircle2 size={14} color="var(--ok)" />
                <span className={`kind-chip ${t.kind}`}>{kindLabel(t.kind)}</span>
                <span className="nm" title={t.name}>{t.name}</span>
                <span className="tm">{bytes(t.expected || t.transferred)}</span>
                <span className="tm">{duration(t.elapsedMs)}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="chart-empty">还没有完成记录。</div>
        )}
      </section>
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
  const { chats, selected, refresh, toast, go, pickFolder } = ctx;
  const [stats, setStats] = useState<Stats | null>(null);
  const [busy, setBusy] = useState("");

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
    if (!window.confirm(`删除本地归档「${current.name}」？\n\n只删除档案库副本，Telegram 云端不受影响，且无法从 TAK 撤销。`)) return;
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

  const sync = async () => {
    if (!current) return;
    try {
      await call("startOneClick", { slug: current.slug });
      toast("已开始同步");
      refresh();
      go("overview");
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const rebuild = async () => {
    if (!current) return;
    try {
      await call("startRefreshWeb", { slug: current.slug });
      toast("重建任务已加入任务中心");
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const copyPath = () => {
    if (!current) return;
    navigator.clipboard?.writeText(current.dir).then(() => toast("目录已复制")).catch(() => toast("复制失败", true));
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
          <p title={current.dir}>
            <span>{current.type || "未知类型"}</span>
            <i>·</i>
            <span>ID {current.id || "--"}</span>
            <i>·</i>
            <span className="chat-dir">{current.dir}</span>
          </p>
        </div>
        <div className="actions">
          <button className="btn ghost" onClick={() => go("library")}>
            <ChevronLeft size={13} /> 返回档案管理
          </button>
          <button className="btn ghost" onClick={() => call("openLibrary", { slug: current.slug })}>
            <FolderOpen size={13} /> 打开归档库
          </button>
          <button className="btn ghost" onClick={rebuild}>
            <RefreshCw size={13} /> 重建网页
          </button>
          <button className="btn primary" onClick={sync}>
            <Play size={13} /> 一键同步
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
          <span>网页 / 官方导出</span>
          <div><b>{current.pages}</b><em>页 · 官方 {current.official} 个</em></div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>聊天信息</h3>
          <span className="meta">最近更新 {current.updatedAt || "--"}</span>
        </div>
        <div className="chat-facts-grid">
          <div className="fact"><span>类型</span><b>{current.type || "--"}</b></div>
          <div className="fact"><span>Chat ID</span><b className="mono">{current.id || "--"}</b></div>
          <div className="fact"><span>官方导出</span><b>{current.official} 个</b></div>
          <div className="fact"><span>网页</span><b>{current.pages} 页</b></div>
          <div className="fact wide">
            <span>归档目录</span>
            <code title={current.dir}>{current.dir}</code>
            <button className="icon-btn" title="复制目录" aria-label="复制目录" onClick={copyPath}>
              <Copy size={13} />
            </button>
          </div>
        </div>
        <div className="chat-actions">
          <button className="btn sm" disabled={busy === "verify"} onClick={verify}>
            <ShieldCheck size={12} /> {busy === "verify" ? "核对中…" : "核对完整性"}
          </button>
          <button className="btn sm ghost" onClick={() => call("revealChat", { slug: current.slug })}>
            <FolderOpen size={12} /> 打开目录
          </button>
          <button className="btn sm ghost" onClick={exportChat}>
            <ArrowDownToLine size={12} /> 导出到另一库
          </button>
          <span className="spacer" />
          <button className="btn sm danger" disabled={busy === "delete"} onClick={remove}>
            <Trash2 size={12} /> 删除本地归档
          </button>
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

      <MediaGallery ctx={ctx} chat={current} />
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
  const [imageIndex, setImageIndex] = useState(-1);
  const [videoIndex, setVideoIndex] = useState(-1);
  const [audioItem, setAudioItem] = useState<MediaItem | null>(null);

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
    setImageIndex(-1);
    setVideoIndex(-1);
    setAudioItem(null);
  }, [filter, chat.slug]);

  const mediaItems = useMemo(() => (items ?? []).filter((i) => i.kind !== "file"), [items]);
  const fileItems = useMemo(() => (items ?? []).filter((i) => i.kind === "file"), [items]);
  const images = useMemo(() => mediaItems.filter((i) => i.kind === "image"), [mediaItems]);
  const videos = useMemo(() => mediaItems.filter((i) => i.kind === "video"), [mediaItems]);
  const audios = useMemo(() => mediaItems.filter((i) => i.kind === "audio"), [mediaItems]);

  const shown = useMemo(() => {
    if (filter === "all") return mediaItems;
    return mediaItems.filter((i) => i.kind === filter);
  }, [mediaItems, filter]);
  const showFiles = filter === "all" || filter === "file";

  const openItem = (item: MediaItem) => {
    if (item.kind === "image") setImageIndex(images.findIndex((i) => i.rel === item.rel));
    else if (item.kind === "video") setVideoIndex(videos.findIndex((i) => i.rel === item.rel));
    else if (item.kind === "audio") setAudioItem(item);
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
              <div className="media-grid">
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
                {fileItems.map((f) => (
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

      {imageIndex >= 0 && images[imageIndex] && (
        <ImageViewer
          chat={chat}
          images={images}
          index={imageIndex}
          onIndex={setImageIndex}
          onClose={() => setImageIndex(-1)}
          onReveal={reveal}
        />
      )}
      {videoIndex >= 0 && videos[videoIndex] && (
        <VideoViewer
          chat={chat}
          videos={videos}
          index={videoIndex}
          onIndex={setVideoIndex}
          onClose={() => setVideoIndex(-1)}
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

function ImageViewer({
  chat,
  images,
  index,
  onIndex,
  onClose,
  onReveal,
}: {
  chat: ChatRow;
  images: MediaItem[];
  index: number;
  onIndex: (n: number) => void;
  onClose: () => void;
  onReveal: (item: MediaItem) => void;
}) {
  const current = images[index];
  const slides = images.map((i) => ({
    src: mediaURL(chat.slug, i.rel),
    alt: i.name,
    thumbnail: i.thumb ? thumbURL(chat.slug, i.thumb) : mediaURL(chat.slug, i.rel),
  }));
  return (
    <>
      <Lightbox
        open
        close={onClose}
        index={index}
        slides={slides}
        plugins={[Zoom, Thumbnails]}
        on={{ view: ({ index: n }) => onIndex(n) }}
        animation={{ fade: 200, swipe: 220 }}
        zoom={{ maxZoomPixelRatio: 4, scrollToZoom: true, wheelZoomDistanceFactor: 400, zoomInMultiplier: 1.25 }}
        thumbnails={{ width: 76, height: 50, gap: 6, borderRadius: 8, padding: 0 }}
        carousel={{ finite: false, padding: 0, preload: 6 }}
      />
      <header className="lb-header">
        <div className="lb-title">
          <b title={current.name}>{current.name}</b>
          <span>{index + 1} / {images.length} · {bytes(current.size)}</span>
        </div>
        <button className="btn sm ghost" onClick={() => onReveal(current)}>
          <LocateFixed size={12} /> 定位文件
        </button>
        <button
          className="btn sm ghost"
          aria-label="切换全屏"
          onClick={() => {
            if (document.fullscreenElement) void document.exitFullscreen();
            else void document.documentElement.requestFullscreen();
          }}
        >
          <Maximize2 size={12} /> 全屏
        </button>
        <button className="btn sm close-x" aria-label="关闭图片" onClick={onClose}>
          <X size={14} />
        </button>
      </header>
    </>
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

const PLAY_RATES = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

const ArtVideo = forwardRef<VideoApi, {
  src: string;
  poster?: string;
  maxVolume: number;
}>(function ArtVideo({ src, poster, maxVolume }, ref) {
  const box = useRef<HTMLDivElement>(null);
  const playerRef = useRef<Artplayer | null>(null);
  const rateRef = useRef(1);
  const resumeRate = useRef(1);
  const boostRef = useRef(false);
  const volumeRef = useRef(80);
  const suppressVolume = useRef(false);
  const audioCtx = useRef<AudioContext | null>(null);
  const gainNode = useRef<GainNode | null>(null);

  const showNotice = (text: string) => {
    if (playerRef.current) playerRef.current.notice.show = text;
  };

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
      p.notice.show = `${next.toFixed(2)}×`;
    },
    beginBoost(rate) {
      const p = playerRef.current;
      if (!p) return;
      resumeRate.current = rateRef.current;
      boostRef.current = true;
      p.playbackRate = Math.max(0.1, Math.min(10, rate));
      showNotice(`${rate.toFixed(1)}× 长按倍速`);
    },
    endBoost() {
      const p = playerRef.current;
      if (!p) return;
      boostRef.current = false;
      p.playbackRate = resumeRate.current;
      syncPreciseRange(p, resumeRate.current);
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

  useEffect(() => {
    if (!box.current) return;
    Artplayer.PLAYBACK_RATE = PLAY_RATES;
    const player = new Artplayer({
      container: box.current,
      url: src,
      poster,
      volume: 0.8,
      autoplay: true,
      pip: true,
      setting: true,
      playbackRate: true,
      aspectRatio: true,
      screenshot: true,
      fullscreen: true,
      fullscreenWeb: false,
      hotkey: false,
      miniProgressBar: true,
      autoSize: false,
      theme: "#2f6bff",
      lang: "zh-cn",
      moreVideoAttr: { playsInline: true } as never,
      settings: [
        {
          name: "tak-precise-speed",
          html: "精确倍速",
          tooltip: "1.00×",
          range: [1, 0.1, 10, 0.01],
          onChange(item) {
            const next = Number((item as unknown as { range: number[] }).range[0]);
            const value = Math.max(0.1, Math.min(10, Math.round(next * 100) / 100));
            rateRef.current = value;
            boostRef.current = false;
            player.playbackRate = value;
            return `${value.toFixed(2)}×`;
          },
        },
      ],
    });
    playerRef.current = player;
    player.on("video:ratechange", () => {
      if (!boostRef.current) rateRef.current = player.playbackRate;
      syncPreciseRange(player, player.playbackRate);
    });
    player.on("video:volumechange", () => {
      if (suppressVolume.current) return;
      volumeRef.current = player.video.muted ? 0 : Math.round(player.video.volume * 100);
      if (gainNode.current) gainNode.current.gain.value = 1;
    });

    return () => {
      if (audioCtx.current) {
        void audioCtx.current.close();
        audioCtx.current = null;
        gainNode.current = null;
      }
      player.destroy(false);
      playerRef.current = null;
    };
  }, [src, poster]);

  return <div ref={box} className="art-player" />;
});

function VideoViewer({
  chat,
  videos,
  index,
  onIndex,
  onClose,
  onReveal,
  onOpen,
  prefs,
}: {
  chat: ChatRow;
  videos: MediaItem[];
  index: number;
  onIndex: (n: number) => void;
  onClose: () => void;
  onReveal: (item: MediaItem) => void;
  onOpen: (item: MediaItem) => void;
  prefs: ViewerPrefs;
}) {
  const item = videos[index];
  const src = mediaURL(chat.slug, item.rel);
  const poster = item.thumb ? thumbURL(chat.slug, item.thumb) : "";
  const api = useRef<VideoApi | null>(null);
  const hold = useRef<{ key: string; timer: number; long: boolean; direction: number } | null>(null);
  const strip = useRef<HTMLDivElement>(null);
  const active = useRef<HTMLButtonElement>(null);
  const [showKeys, setShowKeys] = useState(false);

  useEffect(() => {
    active.current?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }, [index]);

  useEffect(() => {
    const clearHold = () => {
      if (hold.current) {
        window.clearTimeout(hold.current.timer);
        if (hold.current.long) api.current?.endBoost();
        hold.current = null;
      }
    };
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (e.key === "PageUp" || (e.ctrlKey && e.key === "ArrowLeft")) {
        e.preventDefault();
        if (index > 0) onIndex(index - 1);
        return;
      }
      if (e.key === "PageDown" || (e.ctrlKey && e.key === "ArrowRight")) {
        e.preventDefault();
        if (index < videos.length - 1) onIndex(index + 1);
        return;
      }
      if (e.key === "Escape") {
        if (api.current?.isFullscreen()) api.current.setFullscreen(false);
        else onClose();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        api.current?.setFullscreen(!api.current.isFullscreen());
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
            api.current?.beginBoost(prefs.longPressRate);
          }
        }, 300);
        hold.current = { key: e.key, timer, long: false, direction };
        return;
      }
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        if (e.repeat) return;
        api.current?.adjustVolume(e.key === "ArrowUp" ? 10 : -10);
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
      else api.current?.seekBy(state.direction * prefs.seekSeconds);
      hold.current = null;
    };
    const onBlur = () => {
      clearHold();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
      clearHold();
    };
  }, [index, videos.length, onClose, onIndex, prefs.longPressRate, prefs.seekSeconds]);

  return (
    <div className="media-modal" role="dialog" aria-modal="true" aria-label={`视频：${item.name}`}>
      {poster && <div className="video-ambient" style={{ backgroundImage: `url(${poster})` }} aria-hidden="true" />}
      <header className="media-modal-head">
        <button className="icon-btn dark" disabled={index <= 0} aria-label="上一个视频" title="上一个视频 (PageUp)" onClick={() => onIndex(index - 1)}>
          <ChevronLeft size={18} />
        </button>
        <button className="icon-btn dark" disabled={index >= videos.length - 1} aria-label="下一个视频" title="下一个视频 (PageDown)" onClick={() => onIndex(index + 1)}>
          <ChevronRight size={18} />
        </button>
        <span className="media-modal-name" title={item.name}>{item.name}</span>
        <span className="media-modal-count">{index + 1} / {videos.length} · {bytes(item.size)}</span>
        <span className="spacer" />
        <button className="btn sm ghost" onClick={() => setShowKeys((v) => !v)}>
          <Keyboard size={12} /> 快捷键
        </button>
        <button className="btn sm ghost" onClick={() => onOpen(item)}>
          <ExternalLink size={12} /> 系统播放器
        </button>
        <button className="btn sm ghost" onClick={() => onReveal(item)}>
          <LocateFixed size={12} /> 定位文件
        </button>
        <button className="btn sm close-x" aria-label="关闭视频" onClick={onClose}>
          <X size={14} />
        </button>
      </header>
      <div className="media-modal-main video">
        <ArtVideo
          ref={api}
          key={item.rel}
          src={src}
          poster={poster || undefined}
          maxVolume={prefs.maxVolume}
        />
        {showKeys && (
          <div className="vp-keys" role="dialog" aria-label="视频快捷键">
            <h4>视频快捷键</h4>
            <dl>
              <dt>← / →</dt><dd>快退 / 快进 {prefs.seekSeconds} 秒（可在设置修改）</dd>
              <dt>长按 ← / →</dt><dd>{prefs.longPressRate}× 临时倍速，松手恢复</dd>
              <dt>↑ / ↓</dt><dd>音量 ±10%（最高 {prefs.maxVolume}%）</dd>
              <dt>M</dt><dd>静音 / 取消静音</dd>
              <dt>Space</dt><dd>播放 / 暂停</dd>
              <dt>Enter</dt><dd>进入 / 退出全屏</dd>
              <dt>Esc</dt><dd>退出全屏；非全屏时关闭查看器</dd>
              <dt>PageUp / PageDown</dt><dd>上一个 / 下一个视频</dd>
              <dt>[ / ]</dt><dd>倍速 −0.25 / +0.25</dd>
            </dl>
          </div>
        )}
      </div>
      <div className="media-strip" ref={strip}>
        {videos.map((v, i) => (
          <button key={v.rel} ref={i === index ? active : undefined} className={i === index ? "on" : ""} title={v.name} onClick={() => onIndex(i)}>
            {v.thumb ? <img src={thumbURL(chat.slug, v.thumb)} alt="" loading="lazy" /> : <Film size={18} />}
            <span className="strip-index">{i + 1}</span>
          </button>
        ))}
      </div>
      <button className="media-nav prev" disabled={index <= 0} aria-label="上一个视频" onClick={() => onIndex(index - 1)}>
        <ChevronLeft size={26} />
      </button>
      <button className="media-nav next" disabled={index >= videos.length - 1} aria-label="下一个视频" onClick={() => onIndex(index + 1)}>
        <ChevronRight size={26} />
      </button>
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
  const [mode, setMode] = useState("reference");
  const [busy, setBusy] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());

  const toggleSel = (slug: string) => setSel((prev) => {
    const next = new Set(prev);
    if (next.has(slug)) next.delete(slug);
    else next.add(slug);
    return next;
  });
  const allSelected = chats.length > 0 && sel.size === chats.length;
  const toggleAll = () => setSel(allSelected ? new Set() : new Set(chats.map((c) => c.slug)));
  const selectedChats = chats.filter((c) => sel.has(c.slug));

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
  const deleteSelected = async () => {
    if (selectedChats.length === 0) return;
    if (!window.confirm(`删除选中的 ${selectedChats.length} 个本地归档？\n\n只删除档案库副本，Telegram 云端不受影响，且无法从 TAK 撤销。`)) return;
    setBusy("bulk");
    try {
      for (const c of selectedChats) await call("deleteChat", { slug: c.slug });
      toast(`已删除 ${selectedChats.length} 个本地归档`);
      setSel(new Set());
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
      setMode("reference");
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy("");
    }
  };

  const confirmOfficial = async () => {
    if (!official) return;
    try {
      await call("startImportOfficial", { folder: official.meta.root, slug: target, mode });
      toast("官方导出任务已加入任务中心");
      setOfficial(null);
      refresh();
    } catch (e) {
      toast((e as Error).message, true);
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

  return (
    <>
      <div className="page-head">
        <div>
          <h1>档案管理</h1>
          <p>导入、批量管理、重建与库切换都在这里；删除与合并前都会要求确认</p>
        </div>
        <div className="actions">
          <button className="btn ghost" onClick={() => boot && call("openPath", { path: boot.libraryRoot })}>
            <FolderOpen size={13} /> 打开目录
          </button>
          <button className="btn ghost" onClick={merge}>
            <GitMerge size={13} /> 合并另一个库
          </button>
          <button className="btn ghost" disabled={busy === "switch"} onClick={pickAndSwitch}>
            <FolderPlus size={13} /> 切换 / 新建
          </button>
          <button className="btn primary" onClick={importJSON}>
            <Download size={13} /> 导入 result.json
          </button>
        </div>
      </div>

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
        {official && (
          <div className="official-editor">
            <div>
              <h4>官方导出：{official.meta.name}</h4>
              <p>{official.meta.messageCount} 条消息 · {official.meta.mediaFiles} 个媒体文件 · {official.meta.root}</p>
            </div>
            <div className="official-fields">
              <Select
                ariaLabel="官方导出导入目标"
                value={target}
                onChange={setTarget}
                options={[{ value: "", label: "创建为新聊天" }, ...official.chats.map((c) => ({ value: c.slug, label: "合并到：" + c.name }))]}
              />
              <label className="opt"><input type="radio" checked={mode === "reference"} onChange={() => setMode("reference")} /> 引用原目录</label>
              <label className="opt"><input type="radio" checked={mode === "copy"} onChange={() => setMode("copy")} /> 复制</label>
              <label className="opt"><input type="radio" checked={mode === "managed"} onChange={() => setMode("managed")} /> 纳管</label>
              <button className="btn sm primary" onClick={confirmOfficial}><Download size={12} /> 确认导入</button>
              <button className="btn sm ghost" onClick={() => setOfficial(null)}><X size={12} /> 取消</button>
            </div>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>聊天管理</h3>
          <span className="meta">{chats.length} 个 · 点击行进入聊天</span>
        </div>
        {sel.size > 0 && (
          <div className="bulk-bar">
            <b>已选 {sel.size} 个聊天</b>
            <button className="btn sm" disabled={busy === "bulk"} onClick={rebuildSelected}>
              <RefreshCw size={12} /> 重建网页
            </button>
            <button className="btn sm" disabled={busy === "bulk"} onClick={verifySelected}>
              <ShieldCheck size={12} /> 核对完整性
            </button>
            <button className="btn sm" disabled={busy === "bulk"} onClick={exportSelected}>
              <ArrowDownToLine size={12} /> 导出
            </button>
            <button className="btn sm danger" disabled={busy === "bulk"} onClick={deleteSelected}>
              <Trash2 size={12} /> 删除
            </button>
            <span className="spacer" />
            <button className="btn sm ghost" onClick={() => setSel(new Set())}>
              <X size={12} /> 取消选择
            </button>
          </div>
        )}
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
                  className={c.slug === selected ? "selected" : ""}
                  onClick={() => openChat(c.slug)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      openChat(c.slug);
                    }
                  }}
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
                  <td className="muted">{c.updatedAt ? c.updatedAt.slice(0, 10) : "--"}</td>
                  <td className="row-action">
                    <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                      <button className="icon-btn" title="打开聊天" aria-label="打开聊天" onClick={() => openChat(c.slug)}>
                        <ChevronRight size={14} />
                      </button>
                      <button className="icon-btn" title="重建网页" aria-label="重建网页" onClick={() => call("startRefreshWeb", { slug: c.slug }).then(() => toast("重建任务已加入任务中心")).catch((e: Error) => toast(e.message, true))}>
                        <RefreshCw size={13} />
                      </button>
                      <button className="icon-btn" title="打开目录" aria-label="打开目录" onClick={() => call("revealChat", { slug: c.slug }).catch((e: Error) => toast(e.message, true))}>
                        <FolderOpen size={13} />
                      </button>
                      <button className="icon-btn danger" title="删除本地归档" aria-label="删除本地归档" onClick={() => {
                        if (!window.confirm(`删除本地归档「${c.name}」？\n\n只删除档案库副本，Telegram 云端不受影响。`)) return;
                        call("deleteChat", { slug: c.slug }).then(() => { toast("已删除本地归档"); refresh(); }).catch((e: Error) => toast(e.message, true));
                      }}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <div className="home-grid">
        <section className="panel">
          <div className="panel-head">
            <h3>当前档案库</h3>
            <span className="meta">{chats.length} 个聊天</span>
          </div>
          <div className="kv">
            <dt>根目录</dt>
            <dd>{boot?.libraryRoot || "未配置"}</dd>
            <dt>配置文件</dt>
            <dd>{boot?.configPath || "--"}</dd>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3>最近使用</h3>
            <span className="meta">点击切换</span>
          </div>
          {history.length === 0 ? (
            <div className="chart-empty">还没有历史记录。</div>
          ) : (
            <div className="logs-list">
              {history.map((root) => (
                <button key={root} onClick={() => switchTo(root)} className={root === boot?.libraryRoot ? "on" : ""}>
                  <span className="nm">{root}</span>
                  {root === boot?.libraryRoot && <span className="tm">当前</span>}
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
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
  videoMaxVolume: number;
  speedWindowSeconds: number;
  version: string;
}

function SettingsField({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
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

  if (!form) return <div className="chart-empty">正在读取设置…</div>;

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
        maxVolume: next.videoMaxVolume,
        speedWindowSeconds: next.speedWindowSeconds,
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
          <h1>设置</h1>
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
          <SettingsField label="长按左右键倍速" hint="按住 ← / → 300ms 后临时倍速，松开恢复（1.1–10.0）">
            <input type="number" min={1.1} max={10} step={0.1} value={form.videoLongPressRate} onChange={(e) => set("videoLongPressRate", Number(e.target.value))} />
          </SettingsField>
          <SettingsField label="音量上限（%）" hint="↑ / ↓ 可调到的最大音量，超过 100% 使用 Web Audio 增益（100–300）">
            <input type="number" min={100} max={300} step={10} value={form.videoMaxVolume} onChange={(e) => set("videoMaxVolume", Number(e.target.value))} />
          </SettingsField>
          <SettingsField label="速度曲线默认时间窗（秒）" hint="下载中心曲线默认窗口（60–900 秒），也可在页面内临时切换">
            <input type="number" min={60} max={900} step={30} value={form.speedWindowSeconds} onChange={(e) => set("speedWindowSeconds", Number(e.target.value))} />
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
          <div className="switch-stack">
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
  const toolLabels = ["tdl", "tdl 版本", "tdl 会话目录", "会话文件", "Namespace", "FFmpeg", "磁盘剩余"];
  const visibleLogs = logs.filter((l) => l.name.toLowerCase().includes(query.trim().toLowerCase()));
  const activeLog = logs.find((l) => l.name === active);

  const renderRows = (labels: string[]) => (
    <div className="diag-rows">
      {rows
        .filter((r) => labels.includes(r.label))
        .map((r) => (
          <div key={r.label} className={`diag-row ${r.state}`}>
            <span className="diag-label">{r.label}</span>
            <span className="diag-value" title={r.value}>{r.value}</span>
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
    loadInfo();
    call<AccountProfile | null>("accountProfile")
      .then((p) => {
        if (p && p.userId) {
          setProfile(p);
          setProfileSource("cache");
        }
      })
      .catch(() => undefined);
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

  const logout = async () => {
    if (!window.confirm("退出当前 Telegram 会话？\n\n会话文件会先备份到 ~/.tdl/backups，然后从当前 namespace 移除；重新登录即可恢复。")) return;
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
  const checkedText = profile?.checkedAt ? new Date(profile.checkedAt).toLocaleString("zh-CN", { hour12: false }) : "尚未读取";
  const sourceText = profileSource === "live" ? "实时读取" : profileSource === "inferred" ? "下载中推断" : "本机缓存";

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
        <div className="account-avatar">
          {profile?.avatar ? <img src={profile.avatar} alt={displayName} /> : <UserRound size={26} />}
        </div>
        <div className="account-id">
          <h2>{displayName}</h2>
          <p className="account-handle">
            {username ? <><AtSign size={12} /> {username}</> : <span className="faint">未设置用户名</span>}
            {phone && <><i>·</i><Phone size={12} /> {phone}</>}
            {userId && <><i>·</i><Fingerprint size={12} /> ID {userId}</>}
          </p>
          <p className="account-sub">
            <span>{profile ? sourceText : "尚未读取账号资料"}</span>
            <i>·</i>
            <span>{checkedText}</span>
            <i>·</i>
            <span>namespace {account?.namespace || info?.namespace || "-"}</span>
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

      {check && (
        <div className={`account-check-line ${checkTone}`}>
          {check.state === "ready" ? <ShieldCheck size={15} /> : check.state === "unauthorized" ? <WifiOff size={15} /> : <Wifi size={15} />}
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
          {profile ? (
            <>
              <div className="account-rows">
                <div><span>名称</span><b>{profile.name || "未命名"}</b></div>
                <div><span>用户名</span><b>{profile.username ? "@" + profile.username : "未设置"}</b></div>
                <div><span>手机号</span><b className="mono">{phone || "不可见"}</b></div>
                <div><span>用户 ID</span><b className="mono">{profile.userId}</b></div>
                <div><span>数据来源</span><b>{sourceText}</b></div>
                <div><span>最后验证</span><b>{checkedText}</b></div>
              </div>
              <div className="account-profile-actions">
                <button
                  className="btn sm ghost"
                  onClick={() => {
                    const text = `${profile.name}
${profile.username ? "@" + profile.username : "未设置用户名"}
${phone}
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
            <dd className="mono">{account?.sessionFile || "-"}</dd>
            <dt>文件大小</dt>
            <dd>{account?.hasSessionFile ? bytes(account?.sessionSize ?? 0) : "无"}</dd>
            <dt>最后修改</dt>
            <dd>{account?.sessionModified ? new Date(account.sessionModified).toLocaleString("zh-CN", { hour12: false }) : "--"}</dd>
            <dt>tdl</dt>
            <dd className="mono">{info?.exe || "未安装"}</dd>
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
    </>
  );
}

const loginKindLabel = (kind: string) => (kind === "code" ? "手机号验证码" : "二维码");
