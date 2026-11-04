import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  CheckCircle2,
  Download,
  FolderOpen,
  HardDrive,
  Film,
  FileText,
  KeyRound,
  Maximize2,
  Music,
  Play,
  QrCode,
  RefreshCw,
  ShieldCheck,
  Square,
  Trash2,
  UserRound,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import { call } from "./rpc";
import type {
  Bootstrap,
  ChatRow,
  DoneState,
  DownloadState,
  LoginState,
  MediaItem,
  OperationState,
  SessionCheck,
  TdlInfo,
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
          <h1>{current?.name ?? "概览"}</h1>
          <p>
            {current
              ? `${current.messages.toLocaleString()} 条消息 · ${current.media.toLocaleString()} 个媒体 · ${
                  current.missing > 0 ? `缺失 ${current.missing}` : "完整"
                }`
              : "选择左侧聊天开始"}
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
          <span className="meta">{dl?.active.length ?? 0} 个任务</span>
        </div>
        {dl && dl.active.length > 0 ? (
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
              {dl.active.map((t) => (
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
          <span className="meta">{dl?.completed.length ?? 0} 个</span>
        </div>
        {dl && dl.completed.length > 0 ? (
          dl.completed.map((t) => (
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
interface OfficialMeta {
  name: string;
  root: string;
  mode: string;
  messageCount: number;
  mediaMessages: number;
  mediaFiles: number;
  firstId?: string;
  lastId?: string;
}
interface OfficialPreview {
  meta: OfficialMeta;
  matchSlug?: string;
  chats: ChatRow[];
}
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
  const { chats, selected, setSelected, refresh, toast } = ctx;
  const [official, setOfficial] = useState<OfficialPreview | null>(null);
  const [target, setTarget] = useState("");
  const [mode, setMode] = useState("reference");
  const [stats, setStats] = useState<Stats | null>(null);

  const current = chats.find((c) => c.slug === selected) || null;

  const importJSON = async () => {
    try {
      const paths = await call<string[]>("pickJSON");
      if (!paths || paths.length === 0) return;
      const list = await call<ChatRow[]>("importJSON", { paths });
      toast(`已导入 ${list.length} 个聊天`);
      refresh();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const analyzeOfficial = async () => {
    try {
      const folder = await call<string>("pickFolder", { title: "选择 Telegram Desktop 导出的 ChatExport 文件夹", initial: "" });
      if (!folder) return;
      const preview = await call<OfficialPreview>("analyzeOfficial", { folder });
      setOfficial(preview);
      setTarget(preview.matchSlug || "");
      setMode("reference");
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const confirmOfficial = async () => {
    if (!official) return;
    try {
      await call("importOfficial", { folder: official.meta.root, slug: target, mode });
      toast("官方导出已登记");
      setOfficial(null);
      refresh();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const verify = async () => {
    if (!current) return;
    try {
      const s = await call<Stats>("verifyChat", { slug: current.slug });
      setStats(s);
      toast("完整性核对完成");
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const remove = async () => {
    if (!current) return;
    if (!window.confirm(`删除本地归档「${current.name}」？\n\n只删除档案库副本，Telegram 云端不受影响，且无法从 TAK 撤销。`)) return;
    try {
      await call("deleteChat", { slug: current.slug });
      toast("已删除本地归档");
      refresh();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const exportChat = async () => {
    if (!current) return;
    try {
      const dst = await call<string>("pickFolder", { title: "选择目标档案库目录（可新建空目录）", initial: "" });
      if (!dst) return;
      await call("exportChat", { slug: current.slug, dst });
      toast("已复制到目标档案库");
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const refreshAll = async () => {
    try {
      const res = await call<{ rebuilt: number; skipped: number }>("refreshAllWeb");
      toast(`已重建 ${res.rebuilt} 个聊天网页，跳过 ${res.skipped} 个`);
      refresh();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>聊天资料库</h1>
          <p>{chats.length} 个聊天 · 每个聊天一个独立工作区</p>
        </div>
        <div className="actions">
          <button className="btn ghost" onClick={refreshAll}>
            <RefreshCw size={13} /> 重建全部网页
          </button>
          <button className="btn ghost" onClick={analyzeOfficial}>
            <FolderOpen size={13} /> 继承官方 ChatExport
          </button>
          <button className="btn primary" onClick={importJSON}>
            <Download size={13} /> 导入 result.json
          </button>
        </div>
      </div>

      {official && (
        <div className="banner">
          <h4>官方导出：{official.meta.name}</h4>
          <p>
            {official.meta.messageCount} 条消息 · {official.meta.mediaFiles} 个媒体文件 · 目录 {official.meta.root}
          </p>
          <div className="row">
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">创建为新聊天</option>
              {official.chats.map((c) => (
                <option key={c.slug} value={c.slug}>
                  合并到：{c.name}
                </option>
              ))}
            </select>
            <label className="opt">
              <input type="radio" checked={mode === "reference"} onChange={() => setMode("reference")} /> 引用原目录
            </label>
            <label className="opt">
              <input type="radio" checked={mode === "copy"} onChange={() => setMode("copy")} /> 复制
            </label>
            <label className="opt">
              <input type="radio" checked={mode === "managed"} onChange={() => setMode("managed")} /> 纳管
            </label>
            <button className="btn sm primary" onClick={confirmOfficial}>
              确认导入
            </button>
            <button className="btn sm ghost" onClick={() => setOfficial(null)}>
              取消
            </button>
          </div>
        </div>
      )}

      <section className="panel">
        <div className="panel-head">
          <h3>聊天</h3>
          <span className="meta">{chats.length} 个</span>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>聊天</th>
              <th className="num">消息</th>
              <th className="num">媒体</th>
              <th className="num">缺失</th>
              <th className="num hide-sm">页面</th>
              <th>最近更新</th>
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
                  setStats(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelected(c.slug);
                    setStats(null);
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
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {current && (
        <section className="panel">
          <div className="panel-head">
            <h3>{current.name}</h3>
            <span className="meta">{current.dir}</span>
          </div>
          <div className="kv">
            <dt>类型 / ID</dt>
            <dd>
              {current.type || "未知"} · {current.id || "--"}
            </dd>
            <dt>消息 / 媒体</dt>
            <dd>
              {current.messages.toLocaleString()} 条 · {current.media.toLocaleString()} 个
            </dd>
            <dt>完整性</dt>
            <dd className={current.missing > 0 ? "warn" : ""}>
              {current.missing > 0 ? `缺失 ${current.missing} 个媒体` : "完整"}
            </dd>
            <dt>官方导出</dt>
            <dd>{current.official} 个</dd>
          </div>
          <div className="actions-row" style={{ padding: "0 16px 16px" }}>
            <button className="btn sm primary" onClick={() => call("startOneClick", { slug: current.slug }).then(refresh).catch((e) => toast(e.message, true))}>
              <Play size={12} /> 一键同步
            </button>
            <button className="btn sm" onClick={verify}>
              核对完整性
            </button>
            <button className="btn sm" onClick={() => call("refreshWeb", { slug: current.slug }).then(refresh).catch((e) => toast(e.message, true))}>
              只重建网页
            </button>
            <button className="btn sm ghost" onClick={() => call("openLibrary", { slug: current.slug })}>
              打开归档库
            </button>
            <button className="btn sm ghost" onClick={() => call("revealChat", { slug: current.slug })}>
              打开目录
            </button>
            <button className="btn sm ghost" onClick={exportChat}>
              导出到另一库
            </button>
            <button className="btn sm danger" onClick={remove}>
              <Trash2 size={12} /> 删除本地归档
            </button>
          </div>
          {stats && (
            <div className="banner" style={{ margin: "0 16px 16px" }}>
              <h4>完整性核对</h4>
              <p>
                {stats.messages.toLocaleString()} 条消息 · {stats.media.toLocaleString()} 个媒体（图片 {stats.images} · 视频{" "}
                {stats.videos} · 音频 {stats.audio} · 文件 {stats.files}）
                {stats.missing > 0 ? ` · 缺失 ${stats.missing}` : " · 无缺失"}
                {stats.missingImages + stats.missingVideos > 0
                  ? ` · 待补封面：图片 ${stats.missingImages} / 视频 ${stats.missingVideos}`
                  : ""}
              </p>
            </div>
          )}
        </section>
      )}

      {current && <MediaGallery ctx={ctx} chat={current} />}
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

const mediaURL = (slug: string, name: string) =>
  `/api/media?slug=${encodeURIComponent(slug)}&f=${encodeURIComponent(name)}`;

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
  const [viewer, setViewer] = useState(-1);

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
    setViewer(-1);
  }, [filter, chat.slug]);

  const filtered = useMemo(
    () => (items ?? []).filter((i) => filter === "all" || i.kind === filter),
    [items, filter]
  );

  useEffect(() => {
    if (viewer >= filtered.length) setViewer(-1);
  }, [filtered.length, viewer]);

  return (
    <section className="panel">
      <div className="panel-head">
        <h3>媒体与文件</h3>
        <span className="meta">{items ? `${filtered.length} 个本地文件` : "正在读取…"}</span>
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
      ) : filtered.length === 0 ? (
        <div className="state-box">
          <p>{filter === "all" ? "这个聊天还没有下载到本地媒体。" : "当前筛选没有文件。"}</p>
          <button className="btn ghost" onClick={() => call("revealChat", { slug: chat.slug })}>
            <FolderOpen size={13} /> 打开聊天目录
          </button>
        </div>
      ) : (
        <>
          <div className="media-grid">
            {filtered.slice(0, limit).map((item, idx) => (
              <button key={item.name} className="media-tile" title={item.name} onClick={() => setViewer(idx)}>
                {item.kind === "image" ? (
                  <img src={mediaURL(chat.slug, item.name)} alt={item.name} loading="lazy" />
                ) : (
                  <span className={`media-ph ${item.kind}`}>{mediaIcon(item.kind)}</span>
                )}
                <span className="media-cap">
                  <b>{item.kind === "image" ? "图片" : item.kind === "video" ? "视频" : item.kind === "audio" ? "音频" : "文件"}</b>
                  <i>{bytes(item.size)}</i>
                </span>
              </button>
            ))}
          </div>
          {filtered.length > limit && (
            <div className="media-more">
              <button className="btn ghost" onClick={() => setLimit((n) => n + 240)}>
                加载更多（剩余 {filtered.length - limit} 个）
              </button>
            </div>
          )}
        </>
      )}

      {viewer >= 0 && filtered[viewer] && (
        <MediaViewer
          chat={chat}
          items={filtered}
          index={viewer}
          onIndex={setViewer}
          onClose={() => setViewer(-1)}
          onError={(m) => toast(m, true)}
        />
      )}
    </section>
  );
}

function MediaViewer({
  chat,
  items,
  index,
  onIndex,
  onClose,
  onError,
}: {
  chat: ChatRow;
  items: MediaItem[];
  index: number;
  onIndex: (n: number) => void;
  onClose: () => void;
  onError: (msg: string) => void;
}) {
  const item = items[index];
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const src = mediaURL(chat.slug, item.name);

  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [index]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
      else if (e.key === "ArrowRight" && index < items.length - 1) onIndex(index + 1);
      else if (e.key === "0") {
        setZoom(1);
        setPan({ x: 0, y: 0 });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, items.length, onClose, onIndex]);

  const zoomBy = (next: number) => {
    const clamped = Math.min(6, Math.max(1, next));
    setZoom(clamped);
    if (clamped === 1) setPan({ x: 0, y: 0 });
  };

  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label={`查看 ${item.name}`}>
      <header className="viewer-head">
        <span className="viewer-name" title={item.name}>
          {item.name}
        </span>
        <span className="viewer-count">
          {index + 1} / {items.length}
        </span>
        {item.kind === "image" && (
          <span className="viewer-zoom">
            <button className="btn sm ghost" aria-label="缩小" onClick={() => zoomBy(zoom / 1.4)}>
              −
            </button>
            <b>{Math.round(zoom * 100)}%</b>
            <button className="btn sm ghost" aria-label="放大" onClick={() => zoomBy(zoom * 1.4)}>
              +
            </button>
            <button className="btn sm ghost" aria-label="重置缩放" onClick={() => zoomBy(1)}>
              <Maximize2 size={12} />
            </button>
          </span>
        )}
        <span className="spacer" />
        <button className="btn sm ghost" onClick={() => call("openPath", { path: chat.dir }).catch((e: Error) => onError(e.message))}>
          <FolderOpen size={12} /> 所在目录
        </button>
        <button className="btn sm close-x" aria-label="关闭查看器" autoFocus onClick={onClose}>
          <X size={12} />
          <span>关闭</span>
        </button>
      </header>
      <div
        className={`viewer-stage ${zoom > 1 ? "zoomed" : ""}`}
        onWheel={(e) => {
          if (item.kind !== "image") return;
          e.preventDefault();
          zoomBy(zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
        }}
        onDoubleClick={() => item.kind === "image" && zoomBy(zoom > 1 ? 1 : 2.4)}
        onMouseDown={(e) => {
          if (item.kind !== "image" || zoom <= 1) return;
          drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
        }}
        onMouseMove={(e) => {
          if (!drag.current) return;
          setPan({ x: drag.current.px + e.clientX - drag.current.x, y: drag.current.py + e.clientY - drag.current.y });
        }}
        onMouseUp={() => (drag.current = null)}
        onMouseLeave={() => (drag.current = null)}
      >
        {item.kind === "image" && (
          <img
            src={src}
            alt={item.name}
            draggable={false}
            style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
          />
        )}
        {item.kind === "video" && <video src={src} controls autoPlay playsInline />}
        {item.kind === "audio" && <audio src={src} controls autoPlay />}
        {item.kind === "file" && (
          <div className="viewer-file">
            <FileText size={40} />
            <p>{item.name}</p>
            <a className="btn primary" href={src} download>
              下载文件
            </a>
          </div>
        )}
      </div>
      <button className="viewer-nav prev" disabled={index <= 0} aria-label="上一个" onClick={() => onIndex(index - 1)}>
        ‹
      </button>
      <button className="viewer-nav next" disabled={index >= items.length - 1} aria-label="下一个" onClick={() => onIndex(index + 1)}>
        ›
      </button>
    </div>
  );
}

/* ============================= Library ============================= */
export function Library({ ctx }: { ctx: PageCtx }) {
  const { boot, chats, refresh, toast } = ctx;
  const history = boot?.history ?? [];

  const switchTo = async (root: string) => {
    try {
      await call("switchLibrary", { root });
      toast("已切换档案库");
      refresh();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const pickAndSwitch = async () => {
    try {
      const root = await call<string>("pickFolder", { title: "选择或新建 Telegram Archive Library 目录", initial: boot?.libraryRoot || "" });
      if (root) await switchTo(root);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const merge = async () => {
    try {
      const root = await call<string>("pickFolder", { title: "选择要合并进来的档案库", initial: "" });
      if (!root) return;
      const res = await call<{ merged: number; total: number }>("mergeLibrary", { root });
      toast(`合并完成：${res.merged}/${res.total} 个聊天`);
      refresh();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>档案库</h1>
          <p>数据与程序版本分离；切换、合并都不会删除原目录</p>
        </div>
        <div className="actions">
          <button className="btn ghost" onClick={() => boot && call("openPath", { path: boot.libraryRoot })}>
            <FolderOpen size={13} /> 打开目录
          </button>
          <button className="btn ghost" onClick={merge}>
            合并另一个档案库
          </button>
          <button className="btn primary" onClick={pickAndSwitch}>
            切换 / 新建档案库
          </button>
        </div>
      </div>

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
          <dt>磁盘</dt>
          <dd>
            <HardDrive size={12} style={{ verticalAlign: "-2px", marginRight: 4 }} />
            剩余空间见诊断页
          </dd>
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

      <p className="muted">
        迁移档案库（复制到新位置并保留旧目录）会在桌面壳完善阶段（P4）接入进度条；当前请使用终端版「档案库位置 → 复制当前档案库到新位置并切换」。
      </p>
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
    try {
      const next = await call<SettingsForm>("setSettings", { settings: form });
      setForm(next);
      toast("设置已保存");
    } catch (e) {
      toast((e as Error).message, true);
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
          <button className="btn primary" onClick={save}>
            保存设置
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
            <select value={form.transferAdjustment} onChange={(e) => set("transferAdjustment", e.target.value)}>
              <option value="increase">逐步增加线程（推荐）</option>
              <option value="increase-both">线程和并发一起增加（试验）</option>
              <option value="decrease">逐步降低线程</option>
              <option value="keep">保持原配置</option>
            </select>
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
  if (p.includes("phone")) return "请输入手机号（含国家码，例如 +8613800000000）";
  if (p.includes("code")) return "请输入 Telegram 发来的验证码";
  if (p.includes("password")) return "请输入两步验证密码";
  return "按终端提示输入内容后发送";
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
          <span className="meta">{active && login ? `${loginKindLabel(login.kind)} · ${LOGIN_STATE_LABEL[login.state] ?? login.state}` : "扫码或验证码"}</span>
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
                <span>扫码不方便时，输入手机号和 Telegram 验证码</span>
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
              {login.kind === "qr" && qr.length === 0 && <p className="acct-prompt warn">正在等待二维码…</p>}
              {login.kind === "qr" && qr.length > 0 && (
                <div className="qr-wrap" aria-label="登录二维码">
                  <pre className="qr-text">{qr.join("\n")}</pre>
                </div>
              )}
              {login.kind === "code" && (
                <div className="acct-code">
                  <p>{login.prompt || "按终端提示输入手机号或验证码"}</p>
                  <div className="acct-entry">
                    <input
                      type="text"
                      value={entry}
                      autoFocus
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
                </div>
              )}
              {login.kind === "qr" && login.prompt && <p className="acct-prompt">{login.prompt}</p>}
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
