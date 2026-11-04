import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  ChartPie,
  CheckCircle2,
  Clock,
  Database,
  Download,
  FolderOpen,
  HardDrive,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Film,
  FileText,
  Images,
  KeyRound,
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
import Counter from "yet-another-react-lightbox/plugins/counter";
import Fullscreen from "yet-another-react-lightbox/plugins/fullscreen";
import "yet-another-react-lightbox/styles.css";
import "yet-another-react-lightbox/plugins/thumbnails.css";
import "yet-another-react-lightbox/plugins/counter.css";
import Artplayer from "artplayer";
import { call } from "./rpc";
import { Select } from "./Select";
import type {
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
  TaskInfo,
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
  const { boot, chats, selected, setSelected, refresh, toast, go, tasks, openTasks } = ctx;
  const [stats, setStats] = useState<HomeStats | null>(null);
  const [loading, setLoading] = useState(false);

  const load = () => {
    setLoading(true);
    call<HomeStats>("homeStats")
      .then(setStats)
      .catch((e: Error) => toast(e.message, true))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const totalMedia = stats ? stats.images + stats.videos + stats.audio + stats.files : 0;
  let acc = 0;
  const stops = MEDIA_KINDS.map((k) => {
    const value = stats ? stats[k.key] : 0;
    const start = totalMedia > 0 ? (acc / totalMedia) * 360 : 0;
    acc += value;
    const end = totalMedia > 0 ? (acc / totalMedia) * 360 : 0;
    return `${k.color} ${start}deg ${end}deg`;
  }).join(", ");
  const usedPercent =
    stats && stats.diskTotal > 0
      ? Math.min(100, Math.max(0, Math.round(((stats.diskTotal - stats.diskFree) * 100) / stats.diskTotal)))
      : 0;
  const topChats = useMemo(() => [...chats].sort((a, b) => b.media - a.media).slice(0, 5), [chats]);
  const maxMedia = Math.max(1, ...topChats.map((c) => c.media));
  const recentChats = useMemo(
    () => [...chats].sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "")).slice(0, 5),
    [chats]
  );
  const recentTasks = tasks.slice(0, 5);
  const current = chats.find((c) => c.slug === selected) || null;

  const startSync = async () => {
    if (!selected) {
      go("chats");
      return;
    }
    try {
      await call("startOneClick", { slug: selected });
      toast("已开始同步当前聊天");
      go("overview");
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
          <p>
            {chats.length} 个聊天 · {(stats?.messages ?? 0).toLocaleString()} 条消息 · {bytes(stats?.mediaBytes ?? 0)} 媒体已归档
            {stats && stats.missing > 0 ? ` · ${stats.missing} 个缺失` : ""}
          </p>
          <div className="home-cta">
            <button className="btn primary" onClick={startSync}>
              <Play size={13} /> {current ? `同步「${current.name}」` : "开始同步"}
            </button>
            <button className="btn" onClick={() => go("library")}>
              <Download size={13} /> 导入 result.json
            </button>
            <button className="btn ghost" onClick={() => boot && call("openLibrary", {}).catch((e: Error) => toast(e.message, true))}>
              <FolderOpen size={13} /> 打开归档库
            </button>
            <button className="btn ghost" onClick={() => go("account")}>
              <UserRound size={13} /> 账号与登录
            </button>
          </div>
        </div>
        <div className="home-hero-side">
          <div
            className="donut"
            style={{ background: totalMedia > 0 ? `conic-gradient(${stops})` : "var(--surface-3)" }}
            role="img"
            aria-label="媒体构成"
          >
            <div className="donut-hole">
              <b>{stats?.media ?? 0}</b>
              <span>本地媒体</span>
            </div>
          </div>
          <div className="donut-legend">
            {MEDIA_KINDS.map((k) => (
              <div key={k.key}>
                <i style={{ background: k.color }} />
                <span>{k.label}</span>
                <b>{(stats?.[k.key] ?? 0).toLocaleString()}</b>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="kpis home-kpis">
        <div className="kpi">
          <span>聊天</span>
          <b>{chats.length}</b>
          <small>个档案</small>
        </div>
        <div className="kpi">
          <span>消息</span>
          <b>{(stats?.messages ?? 0).toLocaleString()}</b>
        </div>
        <div className="kpi">
          <span>本地媒体</span>
          <b>{(stats?.media ?? 0).toLocaleString()}</b>
        </div>
        <div className="kpi">
          <span>缺失媒体</span>
          <b className={stats && stats.missing > 0 ? "warn" : ""}>{stats?.missing ?? 0}</b>
        </div>
      </section>

      <div className="home-grid">
        <section className="panel">
          <div className="panel-head">
            <h3>
              <ChartPie size={14} /> 媒体构成
            </h3>
            <span className="meta">{loading ? "正在统计…" : `共 ${totalMedia.toLocaleString()} 个`}</span>
          </div>
          <div className="kind-list">
            {MEDIA_KINDS.map((k) => {
              const value = stats?.[k.key] ?? 0;
              const pct = totalMedia > 0 ? Math.round((value * 100) / totalMedia) : 0;
              return (
                <div className="kind-row" key={k.key}>
                  <i style={{ background: k.color }} />
                  <span>{k.label}</span>
                  <div className="kind-bar">
                    <b style={{ width: `${pct}%`, background: k.color }} />
                  </div>
                  <strong>{value.toLocaleString()}</strong>
                  <em>{pct}%</em>
                </div>
              );
            })}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3>
              <HardDrive size={14} /> 档案库存储
            </h3>
            <span className="meta">{boot?.libraryRoot || "未配置"}</span>
          </div>
          <div className="storage-body">
            <div className="storage-bar">
              <b style={{ width: `${usedPercent}%` }} />
            </div>
            <div className="storage-labels">
              <span>磁盘已用 {usedPercent}%</span>
              <span>剩余 {bytes(stats?.diskFree ?? 0)}</span>
            </div>
            <div className="storage-facts">
              <div>
                <span>媒体体积</span>
                <b>{bytes(stats?.mediaBytes ?? 0)}</b>
              </div>
              <div>
                <span>网页</span>
                <b>{stats?.pages ?? 0} 页</b>
              </div>
              <div>
                <span>官方导出</span>
                <b>{stats?.official ?? 0} 个</b>
              </div>
            </div>
            <div className="chat-rank">
              <h4>媒体最多的聊天</h4>
              {topChats.map((c) => (
                <button
                  key={c.slug}
                  className="rank-row"
                  onClick={() => {
                    setSelected(c.slug);
                    go("chats");
                  }}
                >
                  <span>{c.name}</span>
                  <i>
                    <b style={{ width: `${Math.round((c.media / maxMedia) * 100)}%` }} />
                  </i>
                  <strong>{c.media.toLocaleString()}</strong>
                </button>
              ))}
              {topChats.length === 0 && <p className="muted">还没有聊天。</p>}
            </div>
          </div>
        </section>
      </div>

      <div className="home-grid">
        <section className="panel">
          <div className="panel-head">
            <h3>
              <Clock size={14} /> 最近聊天
            </h3>
            <button className="btn sm ghost" onClick={() => go("chats")}>
              查看全部 <ArrowRight size={11} />
            </button>
          </div>
          {recentChats.length === 0 ? (
            <div className="chart-empty">还没有聊天，先到档案库导入 result.json。</div>
          ) : (
            <div className="recent-chats">
              {recentChats.map((c) => (
                <button
                  key={c.slug}
                  onClick={() => {
                    setSelected(c.slug);
                    go("chats");
                  }}
                >
                  <span className="avatar">{c.name.slice(0, 1)}</span>
                  <span className="rc-main">
                    <b>{c.name}</b>
                    <span>
                      {c.messages.toLocaleString()} 条 · {c.media.toLocaleString()} 媒体
                      {c.missing > 0 ? ` · 缺失 ${c.missing}` : ""}
                    </span>
                  </span>
                  <span className="rc-time">{c.updatedAt?.slice(0, 10) || "--"}</span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3>
              <Database size={14} /> 最近任务
            </h3>
            <button className="btn sm ghost" onClick={openTasks}>
              任务中心 <ArrowRight size={11} />
            </button>
          </div>
          {recentTasks.length === 0 ? (
            <div className="chart-empty">还没有后台任务。导入、导出、合并与重建会显示在这里。</div>
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
export function Overview({ ctx }: { ctx: PageCtx }) {
  const { chats, selected, setSelected, dl, op, done, running, history, refresh, toast } = ctx;
  const current = chats.find((c) => c.slug === selected) || null;
  const percent = useMemo(() => {
    if (dl) return Math.max(0, Math.min(100, dl.percent));
    if (op && op.total > 0) return Math.max(0, Math.min(100, (op.current * 100) / op.total));
    return 0;
  }, [dl, op]);

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

  const stageText = running
    ? dl
      ? `${dl.state}${dl.detail ? " · " + dl.detail : ""}`
      : op
      ? `${op.stage}${op.detail ? " · " + op.detail : ""}`
      : "正在准备…"
    : done
    ? done.ok
      ? "上次任务已完成"
      : "上次任务失败"
    : "空闲";

  return (
    <>
      <div className="page-head">
        <div>
          <h1>下载中心</h1>
          <p>
            {current
              ? `当前聊天：${current.name} · ${current.messages.toLocaleString()} 条消息 · ${current.missing > 0 ? `缺失 ${current.missing}` : "媒体完整"}`
              : "先在左侧选择聊天，或到档案库导入 result.json"}
          </p>
        </div>
        <div className="actions">
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
          className="ring"
          role="progressbar"
          aria-valuenow={Math.round(percent)}
          aria-valuemin={0}
          aria-valuemax={100}
          style={{ background: `conic-gradient(var(--accent) ${percent}%, var(--surface-3) ${percent}% 100%)` }}
        >
          <b>{Math.round(percent)}%</b>
        </div>
        <div className="hero-main">
          <div className="hero-title">
            {running ? dl?.state ?? "同步中" : "同步与构建"}
            {running && <span className="tag">进行中</span>}
            {done && !running && <span className="tag">{done.ok ? "已完成" : "失败"}</span>}
          </div>
          <div className="hero-stage" title={stageText}>
            {stageText}
          </div>
          {dl && (
            <div className="hero-meta">
              <span>
                {dl.done} / {dl.total} 个媒体
              </span>
              <span>
                速度 <b>{rate(dl.speedNow)}</b>
              </span>
              <span>
                平均 <b>{rate(dl.speedAvg)}</b>
              </span>
              <span>
                已下载 <b>{bytes(dl.bytes)}</b>
                {dl.knownBytes > 0 ? ` / ${bytes(dl.knownBytes)}` : ""}
              </span>
              <span>
                剩余 <b>{duration(dl.etaMs)}</b>
              </span>
              <span>
                并发 <b>{dl.concurrent}</b> × <b>{dl.threads}</b>
              </span>
              <span>
                第 <b>{dl.pass}</b> 轮
              </span>
            </div>
          )}
          {op && !dl && (
            <div className="hero-meta">
              <span>{op.stage}</span>
              {op.total > 0 && (
                <span>
                  <b>
                    {op.current} / {op.total} {op.unit}
                  </b>
                </span>
              )}
            </div>
          )}
        </div>
        <div className="hero-actions">
          {running ? (
            <button className="btn danger" onClick={cancel}>
              <Square size={12} /> 取消
            </button>
          ) : (
            <button className="btn primary" onClick={start} disabled={!current}>
              <ArrowDownToLine size={13} /> 开始同步
            </button>
          )}
          <button className="btn ghost" onClick={() => current && call("revealChat", { slug: current.slug })} disabled={!current}>
            打开目录
          </button>
        </div>
      </section>

      <section className="kpis">
        <div className="kpi">
          <span>实时速度</span>
          <b>{rate(dl?.speedNow ?? 0)}</b>
        </div>
        <div className="kpi">
          <span>平均速度</span>
          <b>{rate(dl?.speedAvg ?? 0)}</b>
        </div>
        <div className="kpi">
          <span>预计剩余</span>
          <b>{duration(dl?.etaMs ?? 0)}</b>
        </div>
        <div className="kpi">
          <span>本轮完成</span>
          <b>
            {dl?.done ?? 0}
            <small>/ {dl?.total ?? 0}</small>
          </b>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>速度曲线</h3>
          <span className="meta">实线 实时 · 虚线 平均 · 最近 3 分钟</span>
        </div>
        <div className="chart">
          {history.length >= 2 ? (
            <svg viewBox="0 0 600 74" preserveAspectRatio="none" aria-label="下载速度曲线">
              <line className="grid" x1="0" y1="18" x2="600" y2="18" />
              <line className="grid" x1="0" y1="37" x2="600" y2="37" />
              <line className="grid" x1="0" y1="56" x2="600" y2="56" />
              <polyline className="now" points={polyPoints(history.map((h) => h.now))} />
              <polyline className="avg" points={polyPoints(history.map((h) => h.avg))} />
            </svg>
          ) : (
            <div className="chart-empty">同步开始后显示实时 / 平均速度曲线。</div>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>正在下载</h3>
          <span className="meta">{(dl?.active ?? []).length} 个任务</span>
        </div>
        {dl && (dl.active ?? []).length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th>文件</th>
                <th className="hide-sm">类型</th>
                <th>进度</th>
                <th className="num">已传 / 期望</th>
                <th className="num">速度</th>
                <th className="num hide-sm">剩余</th>
              </tr>
            </thead>
            <tbody>
              {(dl.active ?? []).map((t) => (
                <tr key={t.id}>
                  <td className="name" title={t.name}>
                    {t.name}
                  </td>
                  <td className="hide-sm">
                    <span className="kind">{kindLabel(t.kind)}</span>
                  </td>
                  <td>
                    <div className="bar">
                      <div className="mini">
                        <i style={{ width: `${Math.max(0, Math.min(100, t.percent))}%` }} />
                      </div>
                    </div>
                    <span className={t.stalled ? "stalled" : ""}>
                      {t.stalled ? "停滞" : t.percent >= 0 ? `${t.percent.toFixed(0)}%` : "—"}
                    </span>
                  </td>
                  <td className="num">
                    {bytes(t.transferred)}
                    {t.expected > 0 ? ` / ${bytes(t.expected)}` : ""}
                  </td>
                  <td className="num">{rate(t.speed)}</td>
                  <td className="num hide-sm">{duration(t.etaMs)}</td>
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
          (dl.completed ?? []).map((t) => (
            <div className="done-row" key={t.id}>
              <CheckCircle2 size={14} color="var(--ok)" />
              <span className="nm" title={t.name}>
                {t.name}
              </span>
              <span className="tm">{duration(t.elapsedMs)}</span>
            </div>
          ))
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
  useEffect(() => setStats(null), [selected]);

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

  if (!current) {
    return (
      <div className="empty-state">
        <MessagesSquare size={30} />
        <h2>还没有可查看的聊天</h2>
        <p>导入 Telegram Desktop 导出的 result.json，或继承已有的 ChatExport，然后就能在这里浏览媒体。</p>
        <button className="btn primary" onClick={() => go("library")}>
          前往档案库导入
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{current.name}</h1>
          <p title={current.dir}>
            {current.type || "未知类型"} · ID {current.id || "--"} · {current.dir}
          </p>
        </div>
        <div className="actions">
          <button className="btn ghost" onClick={() => call("openLibrary", { slug: current.slug })}>
            <FolderOpen size={13} /> 打开归档库
          </button>
          <button className="btn ghost" disabled={busy === "rebuild"} onClick={rebuild}>
            <RefreshCw size={13} /> {busy === "rebuild" ? "重建中…" : "重建网页"}
          </button>
          <button className="btn primary" onClick={sync}>
            <Play size={13} /> 一键同步
          </button>
        </div>
      </div>

      <section className="kpis">
        <div className="kpi">
          <span>消息</span>
          <b>{current.messages.toLocaleString()}</b>
        </div>
        <div className="kpi">
          <span>媒体</span>
          <b>{current.media.toLocaleString()}</b>
        </div>
        <div className="kpi">
          <span>缺失</span>
          <b className={current.missing > 0 ? "warn" : ""}>{current.missing.toLocaleString()}</b>
        </div>
        <div className="kpi">
          <span>网页 / 官方导出</span>
          <b>
            {current.pages}
            <small>/ {current.official}</small>
          </b>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>聊天操作</h3>
          <span className="meta">最近更新 {current.updatedAt || "--"}</span>
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
          <div className="banner" style={{ margin: "0 16px 16px" }}>
            <h4>完整性核对</h4>
            <p>
              {stats.messages.toLocaleString()} 条消息 · {stats.media.toLocaleString()} 个媒体（图片 {stats.images} · 视频 {stats.videos} · 音频{" "}
              {stats.audio} · 文件 {stats.files}）
              {stats.missing > 0 ? ` · 缺失 ${stats.missing}` : " · 无缺失"}
              {stats.missingImages + stats.missingVideos > 0
                ? ` · 待补封面：图片 ${stats.missingImages} / 视频 ${stats.missingVideos}`
                : ""}
            </p>
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
      <div className="panel-head">
        <h3>媒体与文件</h3>
        <span className="meta">
          {items ? `${shown.length} 个图片 / 视频${showFiles ? ` · ${fileItems.length} 个文件` : ""}` : "正在读取…"}
        </span>
        <div className="tabs media-tabs" role="tablist" aria-label="媒体筛选">
          {MEDIA_FILTERS.map((f) => (
            <button key={f.key} role="tab" aria-selected={filter === f.key} className={filter === f.key ? "on" : ""} onClick={() => setFilter(f.key)}>
              {f.label}
            </button>
          ))}
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
  }));
  return (
    <>
      <Lightbox
        open
        close={onClose}
        index={index}
        slides={slides}
        plugins={[Zoom, Thumbnails, Counter, Fullscreen]}
        on={{ view: ({ index: n }) => onIndex(n) }}
        animation={{ fade: 200, swipe: 220 }}
        zoom={{ maxZoomPixelRatio: 4, scrollToZoom: true, wheelZoomDistanceFactor: 400, zoomInMultiplier: 1.25 }}
        thumbnails={{ width: 84, height: 60, gap: 6, borderRadius: 6 }}
        carousel={{ finite: false }}
      />
      <div className="lb-actions">
        <span className="lb-name" title={current.name}>
          {current.name}
        </span>
        <button className="btn sm ghost" onClick={() => onReveal(current)}>
          <LocateFixed size={12} /> 定位文件
        </button>
      </div>
    </>
  );
}

function ArtVideo({ src, poster, title }: { src: string; poster?: string; title: string }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!box.current) return;
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
      fullscreen: true,
      fullscreenWeb: false,
      miniProgressBar: true,
      autoSize: false,
      theme: "#2f6bff",
      lang: "zh-cn",
      moreVideoAttr: { playsInline: true } as never,
    });
    return () => player.destroy(false);
  }, [src, poster, title]);
  return <div ref={box} className="art-player" />;
}

function VideoViewer({
  chat,
  videos,
  index,
  onIndex,
  onClose,
  onReveal,
  onOpen,
}: {
  chat: ChatRow;
  videos: MediaItem[];
  index: number;
  onIndex: (n: number) => void;
  onClose: () => void;
  onReveal: (item: MediaItem) => void;
  onOpen: (item: MediaItem) => void;
}) {
  const item = videos[index];
  const src = mediaURL(chat.slug, item.rel);
  const poster = item.thumb ? thumbURL(chat.slug, item.thumb) : "";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
      else if (e.key === "ArrowRight" && index < videos.length - 1) onIndex(index + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, videos.length, onClose, onIndex]);

  return (
    <div className="media-modal" role="dialog" aria-modal="true" aria-label={`视频：${item.name}`}>
      {poster && <div className="video-ambient" style={{ backgroundImage: `url(${poster})` }} aria-hidden="true" />}
      <header className="media-modal-head">
        <span className="media-modal-name" title={item.name}>
          {item.name}
        </span>
        <span className="media-modal-count">
          {index + 1} / {videos.length} · {bytes(item.size)}
        </span>
        <span className="spacer" />
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
        <ArtVideo key={item.rel} src={src} poster={poster || undefined} title={item.name} />
      </div>
      <div className="media-strip">
        {videos.map((v, i) => (
          <button key={v.rel} className={i === index ? "on" : ""} title={v.name} onClick={() => onIndex(i)}>
            {v.thumb ? <img src={thumbURL(chat.slug, v.thumb)} alt="" loading="lazy" /> : <Film size={18} />}
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

  return (
    <>
      <div className="page-head">
        <div>
          <h1>档案库</h1>
          <p>导入、更新与库管理都在这里；切换或合并都不会删除原目录</p>
        </div>
        <div className="actions">
          <button className="btn ghost" onClick={() => boot && call("openPath", { path: boot.libraryRoot })}>
            <FolderOpen size={13} /> 打开目录
          </button>
          <button className="btn ghost" onClick={merge}>
            合并另一个档案库
          </button>
          <button className="btn ghost" disabled={busy === "switch"} onClick={pickAndSwitch}>
            切换 / 新建档案库
          </button>
          <button className="btn primary" disabled={busy === "import"} onClick={importJSON}>
            <Download size={13} /> {busy === "import" ? "导入中…" : "导入 result.json"}
          </button>
        </div>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h3>导入与更新</h3>
          <span className="meta">result.json 或 Telegram Desktop 的 ChatExport</span>
        </div>
        <div className="chat-actions">
          <button className="btn sm" disabled={busy === "analyze"} onClick={analyzeOfficial}>
            <FolderOpen size={12} /> 继承官方 ChatExport
          </button>
          <button className="btn sm ghost" disabled={busy === "refresh"} onClick={refreshAll}>
            <RefreshCw size={12} /> 重建全部网页
          </button>
        </div>
        {official && (
          <div className="banner" style={{ margin: "0 16px 16px" }}>
            <h4>官方导出：{official.meta.name}</h4>
            <p>
              {official.meta.messageCount} 条消息 · {official.meta.mediaFiles} 个媒体文件 · 目录 {official.meta.root}
            </p>
            <div className="row">
              <Select
                ariaLabel="官方导出导入目标"
                value={target}
                onChange={setTarget}
                options={[{ value: "", label: "创建为新聊天" }, ...official.chats.map((c) => ({ value: c.slug, label: "合并到：" + c.name }))]}
              />
              <label className="opt">
                <input type="radio" checked={mode === "reference"} onChange={() => setMode("reference")} /> 引用原目录
              </label>
              <label className="opt">
                <input type="radio" checked={mode === "copy"} onChange={() => setMode("copy")} /> 复制
              </label>
              <label className="opt">
                <input type="radio" checked={mode === "managed"} onChange={() => setMode("managed")} /> 纳管
              </label>
              <button className="btn sm primary" disabled={busy === "official"} onClick={confirmOfficial}>
                确认导入
              </button>
              <button className="btn sm ghost" onClick={() => setOfficial(null)}>
                取消
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>聊天管理</h3>
          <span className="meta">{chats.length} 个 · 点击行进入聊天</span>
        </div>
        {chats.length === 0 ? (
          <div className="state-box">
            <p>还没有聊天。导入 result.json 后会出现在这里。</p>
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>聊天</th>
                <th className="num">消息</th>
                <th className="num">媒体</th>
                <th className="num">缺失</th>
                <th className="num hide-sm">页面</th>
                <th>最近更新</th>
                <th> </th>
              </tr>
            </thead>
            <tbody>
              {chats.map((c) => (
                <tr
                  key={c.slug}
                  tabIndex={0}
                  aria-selected={c.slug === selected}
                  onClick={() => {
                    setSelected(c.slug);
                    go("chats");
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelected(c.slug);
                      go("chats");
                    }
                  }}
                  style={{ cursor: "pointer", background: c.slug === selected ? "var(--accent-soft)" : undefined }}
                >
                  <td>{c.name}</td>
                  <td className="num">{c.messages.toLocaleString()}</td>
                  <td className="num">{c.media.toLocaleString()}</td>
                  <td className="num">{c.missing > 0 ? <span className="stalled">{c.missing}</span> : "0"}</td>
                  <td className="num hide-sm">{c.pages}</td>
                  <td className="muted">{c.updatedAt ? c.updatedAt.slice(0, 10) : "--"}</td>
                  <td className="muted">打开 ›</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

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
  version: string;
}

export function SettingsPage({ ctx }: { ctx: PageCtx }) {
  const { toast } = ctx;
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [saving, setSaving] = useState(false);

  const load = () =>
    call<SettingsForm>("getSettings")
      .then(setForm)
      .catch((e: Error) => toast(e.message, true));
  useEffect(() => {
    load();
  }, []);

  if (!form) return <div className="chart-empty">正在读取设置…</div>;

  const set = <K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) =>
    setForm((f) => (f ? { ...f, [key]: value } : f));

  const save = async () => {
    setSaving(true);
    try {
      const next = await call<SettingsForm>("setSettings", { settings: form });
      setForm(next);
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
          <p>修改后立即写入配置文件；进行中的下载会按新参数在下一轮生效</p>
        </div>
        <div className="actions">
          <button className="btn ghost" onClick={load}>
            重新读取
          </button>
          <button className="btn primary" onClick={save} disabled={saving}>
            {saving ? "正在保存…" : "保存设置"}
          </button>
        </div>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h3>下载</h3>
          <span className="meta">默认 2 × 4 是 Telegram 友好的稳定参数</span>
        </div>
        <div className="form">
          <div className="field">
            <label>并发文件任务（1–8）</label>
            <input type="number" min={1} max={8} value={form.concurrent} onChange={(e) => set("concurrent", Number(e.target.value))} />
            <span className="hint">同时下载多少个文件</span>
          </div>
          <div className="field">
            <label>单文件线程（1–16）</label>
            <input type="number" min={1} max={16} value={form.threads} onChange={(e) => set("threads", Number(e.target.value))} />
            <span className="hint">一个文件内部并行分片数</span>
          </div>
          <div className="field">
            <label>网络自动恢复窗口（分钟）</label>
            <input type="number" min={1} max={180} value={form.networkRetryMinutes} onChange={(e) => set("networkRetryMinutes", Number(e.target.value))} />
          </div>
          <div className="field">
            <label>未知错误自动重试（0–10）</label>
            <input type="number" min={0} max={10} value={form.unknownRetryCount} onChange={(e) => set("unknownRetryCount", Number(e.target.value))} />
          </div>
          <div className="field">
            <label>无进展暂缓阈值（30–600 秒）</label>
            <input type="number" min={30} max={600} value={form.stallTimeoutSeconds} onChange={(e) => set("stallTimeoutSeconds", Number(e.target.value))} />
          </div>
          <div className="field">
            <label>疑难文件重试次数（1–10）</label>
            <input type="number" min={1} max={10} value={form.stalledFileRetries} onChange={(e) => set("stalledFileRetries", Number(e.target.value))} />
          </div>
          <div className="field">
            <label>重试传输策略</label>
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
          </div>
          <div className="field">
            <label>代理</label>
            <input type="text" value={form.proxy} placeholder="留空表示系统 / TUN / 直连" onChange={(e) => set("proxy", e.target.value)} />
          </div>
          <div className="field">
            <label>重连超时</label>
            <input type="text" value={form.reconnectTimeout} onChange={(e) => set("reconnectTimeout", e.target.value)} />
          </div>
          <div className="field">
            <label>最大修复轮数</label>
            <input type="number" min={1} max={10} value={form.maxRepairPasses} onChange={(e) => set("maxRepairPasses", Number(e.target.value))} />
          </div>
          <div className="field">
            <label>tdl Namespace</label>
            <input type="text" value={form.tdlNamespace} onChange={(e) => set("tdlNamespace", e.target.value)} />
          </div>
          <div className="check">
            <input type="checkbox" checked={form.generateThumbnails} onChange={(e) => set("generateThumbnails", e.target.checked)} />
            构建时生成图片 / 视频封面
          </div>
          <div className="check">
            <input type="checkbox" checked={form.openAfterBuild} onChange={(e) => set("openAfterBuild", e.target.checked)} />
            构建完成后自动打开归档库
          </div>
          <div className="form-foot">
            <button className="btn ghost" onClick={load}>
              还原
            </button>
            <button className="btn primary" onClick={save}>
              保存设置
            </button>
          </div>
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

  const load = async () => {
    try {
      setRows(await call<DiagRow[]>("diagnostics"));
      const list = await call<LogInfo[]>("listLogs");
      setLogs(list);
      if (!active && list.length > 0) setActive(list[0].name);
    } catch (e) {
      toast((e as Error).message, true);
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

  return (
    <>
      <div className="page-head">
        <div>
          <h1>诊断</h1>
          <p>环境、路径与会话状态；日志只读</p>
        </div>
        <div className="actions">
          <button className="btn ghost" onClick={() => call("revealLogs")}>
            <FolderOpen size={13} /> 打开日志目录
          </button>
          <button className="btn primary" onClick={load}>
            <RefreshCw size={13} /> 重新检查
          </button>
        </div>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h3>环境</h3>
        </div>
        <dl className="kv">
          {rows.map((r) => (
            <div key={r.label} style={{ display: "contents" }}>
              <dt>{r.label}</dt>
              <dd className={r.state === "warn" ? "warn" : ""}>{r.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>日志</h3>
          <span className="meta">{logs.length} 个文件</span>
        </div>
        {logs.length === 0 ? (
          <div className="chart-empty">还没有日志。</div>
        ) : (
          <div className="logs-list">
            {logs.map((l) => (
              <button key={l.name} className={l.name === active ? "on" : ""} onClick={() => setActive(l.name)}>
                <span className="nm">{l.name}</span>
                <span className="tm">{l.modTime}</span>
                <span className="tm">{bytes(l.size)}</span>
              </button>
            ))}
          </div>
        )}
        {active && <pre className="logview">{content}</pre>}
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
      <svg viewBox={`0 0 ${total} ${total}`} width={280} height={280} shapeRendering="crispEdges" role="img" aria-label="Telegram 登录二维码">
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
  unauthorized: "授权不可用",
  network: "网络检查失败",
  timeout: "连接检查超时",
  "check-failed": "chat ls 检查失败",
  "no-tdl": "tdl 未安装",
  busy: "暂时无法检查",
};

function promptLabel(prompt?: string): string {
  const p = (prompt ?? "").toLowerCase();
  if (p.includes("2fa") || p.includes("password") || p.includes("两步")) return "请输入两步验证密码";
  if (p.includes("phone") || p.includes("手机号") || p.includes("number")) return "请输入手机号（含国家码，例如 +8613800000000）";
  if (p.includes("code") || p.includes("验证码")) return "请输入 Telegram 发来的验证码";
  return "按提示输入内容后发送";
}

export function Account({ ctx }: { ctx: PageCtx }) {
  const { boot, login, running, refresh, toast } = ctx;
  const [info, setInfo] = useState<TdlInfo | null>(null);
  const [check, setCheck] = useState<SessionCheck | null>(null);
  const [busy, setBusy] = useState("");
  const [entry, setEntry] = useState("");
  const [showRaw, setShowRaw] = useState(false);

  const loadInfo = () =>
    call<TdlInfo>("tdlInfo")
      .then(setInfo)
      .catch((e: Error) => toast(e.message, true));
  useEffect(() => {
    loadInfo();
  }, []);
  useEffect(() => {
    if (login?.state === "success") {
      loadInfo();
      refresh();
    }
  }, [login?.state]);

  const active = !!login && (login.state === "starting" || login.state === "waiting");
  const screen = login?.screen ?? [];
  const qr = extractQr(screen);
  const tdlMissing = !info?.exe;

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

  const checkSession = async () => {
    setBusy("check");
    setCheck(null);
    try {
      const st = await call<SessionCheck>("sessionCheck", { timeout: 45 });
      setCheck(st);
      loadInfo();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy("");
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

  const lp = (login?.prompt ?? "").toLowerCase();
  const wantsPassword = /2fa|password|two-step|两步|密码/.test(lp);
  const wantsPhone = !wantsPassword && /phone|手机号/.test(lp);
  const wantsCode = !wantsPassword && !wantsPhone && /enter code|verification code|login code|验证码/.test(lp);
  const needsInput = active && (login?.kind === "code" || wantsPassword || wantsCode || wantsPhone);
  const showQr = active && login?.kind === "qr" && qr.length > 0 && !wantsPassword && !wantsCode && !wantsPhone && !/submitted|已提交/.test(lp);
  const sessionState = info?.hasSession ? "已发现本地会话" : "未发现本地会话";
  const checkTone =
    check && (check.state === "ready" ? "ok" : check.state === "unauthorized" ? "danger" : check.state === "busy" ? "" : "warn");

  return (
    <>
      <div className="page-head">
        <div>
          <h1>账号</h1>
          <p>在本机完成 Telegram 登录；会话文件只保存在 tdl 全局目录</p>
        </div>
        <div className="actions">
          <button className="btn ghost" onClick={() => call("openTdlDir")}>
            <FolderOpen size={13} /> 打开会话目录
          </button>
          <button className="btn primary" onClick={loadInfo}>
            <RefreshCw size={13} /> 刷新状态
          </button>
        </div>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h3>tdl 与本地会话</h3>
          <span className="meta">
            <span className={`dot ${info?.hasSession ? "" : "off"}`} /> {sessionState}
          </span>
        </div>
        <dl className="kv">
          <dt>tdl 程序</dt>
          <dd>{info?.exe || "未安装"}</dd>
          <dt>版本</dt>
          <dd>{info?.version || "未知"}</dd>
          <dt>Namespace</dt>
          <dd>{info?.namespace || "-"}</dd>
          <dt>会话目录</dt>
          <dd>{info?.sessionDir || "-"}</dd>
          <dt>本地登录</dt>
          <dd className={info?.hasSession ? "" : "warn"}>{sessionState}</dd>
          <dt>进程状态</dt>
          <dd className={info?.running ? "warn" : ""}>{info?.running ? "tdl.exe 正在运行" : "未运行"}</dd>
        </dl>
        <div className="acct-actions">
          {tdlMissing && (
            <button className="btn primary" disabled={busy === "install"} onClick={installTdl}>
              {busy === "install" ? "正在从 GitHub 安装 tdl…" : "安装 tdl"}
            </button>
          )}
          <button className="btn" disabled={busy === "check"} onClick={checkSession}>
            <Wifi size={13} /> {busy === "check" ? "正在检查连接（最长 45 秒）…" : "检查连接 / 授权"}
          </button>
          {info?.running && (
            <button className="btn danger" disabled={busy === "kill"} onClick={killTdl}>
              <WifiOff size={13} /> 结束 tdl 进程
            </button>
          )}
        </div>
        {check && (
          <div className={`check-result ${checkTone}`}>
            <b>
              {checkTone === "ok" ? <ShieldCheck size={14} /> : checkTone === "danger" ? <WifiOff size={14} /> : <Wifi size={14} />}
              {CHECK_LABEL[check.state] ?? check.state}
            </b>
            <span>{check.message}</span>
            {check.state === "unauthorized" && (
              <span className="warn">
                本地存在会话文件，但 Telegram 已拒绝该会话（可能在其他设备退出登录、切换了账号，或 namespace 不匹配）。重新扫码登录会覆盖为有效会话。
              </span>
            )}
            {check.detail && (
              <details>
                <summary>查看输出</summary>
                <pre>{check.detail}</pre>
              </details>
            )}
          </div>
        )}
      </section>

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
                <span>用手机 Telegram 扫描应用内二维码；最快捷</span>
              </button>
              <button className="acct-choice" disabled={busy === "login" || tdlMissing || running} onClick={() => startLogin("code")}>
                <KeyRound size={22} />
                <b>手机号验证码登录</b>
                <span>扫码不方便时使用；验证码由 Telegram 发送</span>
              </button>
            </div>
            <div className="acct-note">
              <UserRound size={14} />
              <div>
                <p>已有会话无需重复登录；只有首次使用、授权明确失效或切换账号时才需要。</p>
                <p>登录过程完全在本机进行，验证码不会写入配置或日志。</p>
                {running && <p className="warn">当前有下载任务进行中，完成或取消后才能登录。</p>}
                {tdlMissing && <p className="warn">尚未安装 tdl，请先在上方安装。</p>}
                {login && <p className={login.state === "success" ? "ok" : login.state === "failed" ? "danger" : ""}>上次登录：{LOGIN_STATE_LABEL[login.state] ?? login.state}{login.message ? ` · ${login.message}` : ""}</p>}
              </div>
            </div>
          </div>
        ) : (
          <div className="acct-login live">
            <div className="acct-stage">
              {showQr && <QrCodePanel lines={login.qr ?? []} fallback={qr} />}
              {active && login.kind === "qr" && !showQr && !needsInput && !wantsPassword && (
                <p className="acct-prompt warn">正在等待二维码…</p>
              )}
              {needsInput && (
                <div className="acct-code">
                  <p className="acct-question">
                    {wantsPassword
                      ? "二维码已扫描，请输入 Telegram 两步验证密码"
                      : wantsPhone
                        ? "请输入手机号（含国家码）"
                        : wantsCode
                          ? "请输入 Telegram 发来的验证码"
                          : "按提示输入手机号或验证码"}
                  </p>
                  <div className="acct-entry">
                    <input
                      type={wantsPassword ? "password" : "text"}
                      value={entry}
                      autoFocus
                      autoComplete="off"
                      placeholder={promptLabel(login.prompt)}
                      onChange={(e) => setEntry(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") sendEntry();
                      }}
                    />
                    <button className="btn primary" disabled={!entry.trim()} onClick={sendEntry}>
                      发送
                    </button>
                  </div>
                  {!wantsPassword && login.kind === "code" && (
                    <p className="acct-hint">
                      验证码发到已登录的 Telegram App 或短信；两者都收不到时，建议改用二维码登录。
                      <button className="link" onClick={async () => { await cancelLogin(); await startLogin("qr"); }}>
                        改用二维码
                      </button>
                    </p>
                  )}
                </div>
              )}
              {login.prompt && !needsInput && !/已提交/.test(login.prompt) && (
                <p className="acct-prompt">{login.prompt}</p>
              )}
              <div className="acct-live-actions">
                <button className="btn danger" onClick={cancelLogin}>
                  <Square size={12} /> 取消登录
                </button>
                <button className="btn ghost" onClick={() => setShowRaw((v) => !v)}>
                  {showRaw ? "隐藏原始输出" : "原始输出"}
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
