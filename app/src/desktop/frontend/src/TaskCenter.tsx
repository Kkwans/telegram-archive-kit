import { useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import {
  Activity,
  ArrowLeft,
  Check,
  CheckCircle2,
  ChartPie,
  ChevronLeft,
  ChevronRight,
  Download,
  AlertTriangle,
  Pause,
  FileJson,
  FileText,
  FolderInput,
  FolderOpen,
  GitMerge,
  Image as ImageIcon,
  ListTodo,
  Loader2,
  Music,
  Play,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Trash2,
  Video,
  X,
  XCircle,
} from "lucide-react";
import { call } from "./rpc";
import { Select } from "./Select";
import type { TaskDetail, TaskInfo } from "./types";
import { bytes, dateTime, dateTimePrecise, duration, rate, rateParts } from "./format";

const KIND_META: Record<string, { label: string; group: string; icon: typeof Download }> = {
  sync: { label: "下载", group: "download", icon: Download },
  "sync-all": { label: "批量下载", group: "download", icon: Download },
  "import-json": { label: "导入 JSON", group: "import", icon: FileJson },
  "import-official": { label: "官方导出", group: "import", icon: FolderInput },
  export: { label: "导出", group: "export", icon: FolderInput },
  refresh: { label: "重建", group: "build", icon: RefreshCw },
  "refresh-all": { label: "重建全部", group: "build", icon: RefreshCw },
  merge: { label: "合并档案库", group: "merge", icon: GitMerge },
};

function kindMeta(kind: string) {
  return KIND_META[kind] ?? { label: kind, group: "other", icon: Activity };
}

function taskTitle(task: TaskInfo): string {
  if (task.kind === "sync") return "下载聊天";
  if (task.kind === "sync-all") return "批量下载";
  if (task.kind === "refresh") return "重建网页";
  if (task.kind === "refresh-all") return "重建全部网页";
  if (task.kind === "export") return "导出聊天";
  return task.title;
}

function statusLabel(state: string): string {
  if (state === "running") return "进行中";
  if (state === "done") return "完成";
  if (state === "partial") return "部分完成";
  if (state === "paused") return "已暂停";
  return "失败";
}

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "--";
  if (ms > 0 && ms < 1000) return "<1 秒";
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total} 秒`;
  const m = Math.floor(total / 60);
  if (m < 60) return `${m} 分 ${total % 60} 秒`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分`;
}

function taskElapsed(task: TaskInfo): number {
  const span = Math.max(0, (task.finishedAt || Date.now()) - task.startedAt);
  return span > 0 ? span : Math.max(0, task.elapsedMs || 0);
}

function noNewMedia(task: TaskInfo | TaskDetail): boolean {
  return kindMeta(task.kind).group === "download" && task.state !== "failed" && !task.total && !task.bytes;
}

const STATUS_FILTERS = [
  ["all", "全部"],
  ["running", "进行中"],
  ["done", "已完成"],
  ["partial", "部分完成"],
  ["paused", "已暂停"],
  ["failed", "失败"],
] as const;

function clockText(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fileKindLabel(kind: string): string {
  const labels: Record<string, string> = {
    image: "图片", video: "视频", audio: "音频", file: "文件", voice: "语音", gif: "动图",
  };
  return labels[kind] || kind || "媒体";
}

function mediaGroup(kind: string): "image" | "video" | "audio" | "file" {
  if (kind === "image" || kind === "gif") return "image";
  if (kind === "video") return "video";
  if (kind === "audio" || kind === "voice") return "audio";
  return "file";
}

const MEDIA_GROUPS = [
  { key: "image", label: "图片", icon: ImageIcon },
  { key: "video", label: "视频", icon: Video },
  { key: "audio", label: "音频", icon: Music },
  { key: "file", label: "文件", icon: FileText },
] as const;


function TaskSpeedChart({ task }: { task: TaskDetail }) {
  const samples = task.series ?? [];
  const [hover, setHover] = useState<number | null>(null);
  if (samples.length < 2) {
    return <div className="chart-empty">这个任务没有保留速度采样。</div>;
  }
  const max = Math.max(1, ...samples.flatMap((s) => [s.now, s.avg]));
  const first = samples[0].at || task.startedAt;
  const last = samples[samples.length - 1].at || task.finishedAt || Date.now();
  const span = Math.max(1, last - first);
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const pointAt = (index: number) => {
    const sample = samples[index];
    return {
      x: (index / (samples.length - 1)) * 100,
      nowY: 100 - Math.min(1, sample.now / max) * 100,
      avgY: 100 - Math.min(1, sample.avg / max) * 100,
    };
  };
  const points = (key: "now" | "avg") =>
    samples.map((sample, index) => `${((index / (samples.length - 1)) * 100).toFixed(2)},${(100 - Math.min(1, sample[key] / max) * 100).toFixed(2)}`).join(" ");
  const onMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width) return;
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    setHover(Math.round(ratio * (samples.length - 1)));
  };
  const hovering = hover === null ? null : samples[hover];
  const point = hover === null ? null : pointAt(hover);
  const hoverTime = hovering ? (hovering.at || first + span * (hover! / (samples.length - 1))) : 0;
  const tipPosition = point && point.x > 68 ? "flip" : point && point.x < 32 ? "start" : "";
  return (
    <div className="speed-chart">
      <div className="speed-chart-body">
        <div className="speed-y-axis" aria-hidden="true">
          {ticks.map((f) => (
            <span key={f} style={{ top: `${(1 - f) * 100}%` }}>{rate(max * f)}</span>
          ))}
        </div>
        <div className="speed-plot" onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="历史下载速度曲线">
            {ticks.map((f) => (
              <line key={f} className="grid" x1="0" x2="100" y1={(1 - f) * 100} y2={(1 - f) * 100} vectorEffect="non-scaling-stroke" />
            ))}
            <polyline className="avg" points={points("avg")} vectorEffect="non-scaling-stroke" />
            <polyline className="now" points={points("now")} vectorEffect="non-scaling-stroke" />
          </svg>
          <div className="speed-x-axis" aria-hidden="true">
            {ticks.map((f, index) => (
              <span
                key={f}
                className={index === 0 ? "start" : index === ticks.length - 1 ? "end" : ""}
                style={{ left: `${f * 100}%` }}
              >
                {clockText(first + span * f)}
              </span>
            ))}
          </div>
          {hovering && point && (
            <>
              <div className="speed-crosshair" style={{ left: `${point.x}%` }} />
              <div className="speed-point now" style={{ left: `${point.x}%`, top: `${point.nowY}%` }} />
              <div className="speed-point avg" style={{ left: `${point.x}%`, top: `${point.avgY}%` }} />
              <div className={`speed-tip ${tipPosition}`} style={{ left: `${point.x}%` }}>
                <b>{clockText(hoverTime)}</b>
                <span><i className="now" /> 实时 {rate(hovering.now)}</span>
                <span><i className="avg" /> 平均 {rate(hovering.avg)}</span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function TaskDetailView({ task, onBack, onOpenTask, toast }: { task: TaskDetail; onBack: () => void; onOpenTask: (taskId: string) => void; toast: (msg: string, err?: boolean) => void }) {
  const [showAll, setShowAll] = useState(false);
  const [recordPage, setRecordPage] = useState(1);
  const [busyAction, setBusyAction] = useState<"" | "resume" | "rebuild" | "pause" | "config">("");
  const [configOpen, setConfigOpen] = useState(false);
  const [configDraft, setConfigDraft] = useState({ concurrent: task.concurrent ?? 4, threads: task.threads ?? 4 });
  const [transfer, setTransfer] = useState<{ transferAdjustment?: string; stallTimeoutSeconds?: number } | null>(null);
  const meta = kindMeta(task.kind);
  const running = task.state === "running";
  const failed = task.state === "failed";
  const partial = task.state === "partial";
  const paused = task.state === "paused";
  const warning = partial || paused;
  const noop = noNewMedia(task);
  const elapsed = taskElapsed(task);
  const percent = task.state === "done" ? 100 : Math.max(0, Math.min(100, task.percent));
  const series = task.series ?? [];
  const active = task.active ?? [];
  const completed = task.completed ?? [];
  const speedNow = series.length > 0 ? series[series.length - 1].now : 0;
  const speed = rateParts(speedNow);
  const recorded = [...completed, ...active];
  const mediaTotals = MEDIA_GROUPS.map((group) => {
    let count = 0;
    let size = 0;
    for (const file of recorded) {
      if (mediaGroup(file.kind) !== group.key) continue;
      count++;
      size += file.expected > 0 ? file.expected : file.transferred;
    }
    return { ...group, count, size };
  });
  const recordedCount = mediaTotals.reduce((sum, item) => sum + item.count, 0);
  const showComposition = running || !!task.recordsComplete;
  const recent = completed.slice(0, 5);
  const pageSize = 10;
  const recordPages = Math.max(1, Math.ceil(completed.length / pageSize));
  const safePage = Math.min(recordPage, recordPages);
  const pageRecords = completed.slice((safePage - 1) * pageSize, safePage * pageSize);
  const result = task.error || (noop
    ? "同步完成，本次没有产生媒体下载"
    : task.detail || (task.state === "done" ? "任务完成" : task.state === "running" ? "任务进行中" : partial ? "部分媒体未能下载" : paused ? "任务已暂停" : "任务失败"));
  const displayResult = failed ? `失败原因：${result}` : partial ? `部分完成：${result}` : paused ? "任务已暂停，已完成文件和记录会保留" : result;
  const concurrent = Math.max(1, task.concurrent || 4);
  const threads = Math.max(1, task.threads || 4);
  const sparkValues = series.slice(-28).map((sample) => sample.now);
  const sparkLine = sparkValues.length > 1 ? sparkValues : [0, 0];
  const sparkMax = Math.max(1, ...sparkLine);
  const sparkPoints = sparkLine.map((value, index) =>
    `${(index / Math.max(1, sparkLine.length - 1) * 100).toFixed(2)},${(26 - Math.min(1, value / sparkMax) * 24).toFixed(2)}`
  ).join(" ");
  const retryLabel: Record<string, string> = {
    increase: "逐步增加线程",
    "increase-both": "线程与并发递增",
    decrease: "逐步降低线程",
    keep: "保持当前配置",
  };

  useEffect(() => {
    if (!running) return;
    call<{ transferAdjustment?: string; stallTimeoutSeconds?: number }>("getSettings")
      .then(setTransfer)
      .catch(() => undefined);
  }, [running]);

  useEffect(() => {
    if (!running) return;
    setConfigDraft({ concurrent, threads });
  }, [running, concurrent, threads]);

  const applyConfig = async () => {
    if (busyAction) return;
    setBusyAction("config");
    try {
      const nextTask = await call<string>("setDownloadConfig", configDraft);
      setConfigOpen(false);
      if (nextTask && nextTask !== task.id) {
        toast("下载配置已更新，正在按新配置继续");
        onOpenTask(nextTask);
      } else {
        toast("下载配置已保存");
      }
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusyAction("");
    }
  };

  const pause = async () => {
    if (busyAction) return;
    setBusyAction("pause");
    try {
      await call("pause");
      toast("正在暂停任务，已完成文件会保留");
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusyAction("");
    }
  };

  const resume = async () => {
    if (!task.slug || busyAction) return;
    setBusyAction("resume");
    try {
      const nextTask = await call<string>("startOneClick", { slug: task.slug });
      toast("已继续下载：只补齐缺失媒体，已完成文件会保留");
      onOpenTask(nextTask);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusyAction("");
    }
  };

  const rebuild = async () => {
    if (!task.slug || busyAction) return;
    setBusyAction("rebuild");
    try {
      await call("startRefreshWeb", { slug: task.slug });
      toast("重建任务已加入任务中心，将补齐封面与网页");
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusyAction("");
    }
  };

  return (
    <>
      <div className="page-head download-detail-head">
        <button className="btn" onClick={onBack}>
          <ArrowLeft size={14} /> 返回任务中心
        </button>
        <div className="actions">
          {running && (
            <button className="btn ghost" onClick={() => setConfigOpen(true)}>
              <SlidersHorizontal size={13} /> 下载配置
            </button>
          )}
          {running && (
            <button className="btn ghost" disabled={!!busyAction} onClick={() => void pause()}>
              {busyAction === "pause" ? <Loader2 size={13} className="spin" /> : <Pause size={13} />}
              暂停
            </button>
          )}
          {task.slug && (failed || partial || paused) && (
            <button className="btn primary" disabled={!!busyAction} onClick={() => void resume()}>
              {busyAction === "resume" ? <Loader2 size={13} className="spin" /> : <Play size={13} />}
              继续下载
            </button>
          )}
          {task.slug && (
            <button className="btn ghost" disabled={!!busyAction} onClick={() => void rebuild()} title="重新生成数据、网页与缺失的视频封面">
              {busyAction === "rebuild" ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
              重建网页
            </button>
          )}
          {task.slug && (
            <button
              className="btn ghost"
              onClick={() => call("openLibrary", { slug: task.slug }).catch((e: Error) => toast(e.message, true))}
            >
              <FolderOpen size={13} /> 打开归档库
            </button>
          )}
        </div>
      </div>

      <section className={`download-hero ${running ? "running" : warning ? "warning" : failed ? "failed" : "done"}`}>
        <div
          className="download-hero-icon"
          role="progressbar"
          aria-valuenow={Math.round(percent)}
          aria-valuemin={0}
          aria-valuemax={100}
          style={running ? { background: `conic-gradient(var(--accent) ${percent}%, var(--surface-3) ${percent}% 100%)` } : undefined}
        >
          {running ? <b>{Math.round(percent)}%</b> : partial ? <AlertTriangle size={30} strokeWidth={2.1} /> : paused ? <Pause size={30} strokeWidth={2.2} /> : failed ? <X size={32} strokeWidth={2.2} /> : <Check size={36} strokeWidth={2.6} />}
        </div>
        <div className="download-hero-main">
          <span className="download-hero-kicker">下载聊天</span>
          <div className="download-hero-title">
            <h2>{task.chat || taskTitle(task)}</h2>
          </div>
          {running ? (
            <div className="download-hero-configline">
              <span>并发 <b>{concurrent}</b> 个文件</span>
              <span>每文件 <b>{threads}</b> 线程</span>
            </div>
          ) : (
            <p className={`download-hero-desc ${failed ? "bad" : warning ? "warn" : ""}`} title={result}>{displayResult}</p>
          )}
          <div className="download-hero-info">
            <span>开始 <b>{dateTime(task.startedAt)}</b></span>
            <span>峰值速度 <b>{rate(task.peakSpeed ?? 0)}</b></span>
            {task.finishedAt ? <span>结束 <b>{dateTime(task.finishedAt)}</b></span> : null}
          </div>
        </div>
        {running && (
          <div className="download-hero-meter running">
            <span className="download-meter-label"><i />实时速度</span>
            <div className="download-meter-value"><b>{speed.value}</b><em>{speed.unit}</em></div>
            <svg className="download-meter-spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">
              <polygon points={`0,28 ${sparkPoints} 100,28`} />
              <polyline points={sparkPoints} vectorEffect="non-scaling-stroke" />
            </svg>
          </div>
        )}
        {!running && (
          <span className="download-hero-watermark" aria-hidden="true">
            {partial ? <AlertTriangle size={126} strokeWidth={1.4} /> : paused ? <Pause size={126} strokeWidth={1.4} /> : failed ? <X size={132} strokeWidth={1.4} /> : <Check size={144} strokeWidth={1.4} />}
          </span>
        )}
      </section>

      <section className={`stat-grid download-stats ${running ? "five" : "four"}`}>
        {running && <div className="stat"><span>实时速度</span><div><b>{rate(speedNow)}</b></div></div>}
        <div className="stat"><span>平均速度</span><div><b>{rate(task.avgSpeed ?? 0)}</b></div></div>
        <div className="stat">
          <span>已下载 / {task.totalBytesEstimated ? "预计总大小" : "总大小"}</span>
          <div><b>{bytes(task.bytes ?? 0)}</b><em>/ {task.totalBytes ? bytes(task.totalBytes) : "--"}</em></div>
        </div>
        <div className="stat"><span>完成媒体</span><div><b>{task.done ?? 0}</b><em>/ {task.total ?? 0}</em></div></div>
        <div className="stat">
          <span>{running ? "预计还需" : "任务耗时"}</span>
          <div><b>{running ? ((task.etaMs ?? 0) > 0 ? duration(task.etaMs ?? 0) : "--") : fmtDuration(elapsed)}</b></div>
        </div>
      </section>

      {running ? (
        <section className="panel download-config-panel">
          <div className="panel-head">
            <h3><SlidersHorizontal size={14} /> 下载配置</h3>
            <button className="btn sm ghost" onClick={() => setConfigOpen(true)}>调整配置</button>
          </div>
          <div className="download-config-grid">
            <div><span>并发文件任务</span><b>{concurrent}<em> 个</em></b></div>
            <div><span>单文件线程</span><b>{threads}<em> 条</em></b></div>
            <div><span>卡住判定</span><b>{transfer?.stallTimeoutSeconds ?? 60}<em> 秒</em></b></div>
            <div><span>重试策略</span><b>{retryLabel[transfer?.transferAdjustment ?? "increase"] ?? "逐步增加线程"}</b></div>
          </div>
        </section>
      ) : showComposition && (
        <section className="panel download-media-panel">
          <div className="panel-head">
            <h3><ChartPie size={14} /> 本次媒体构成</h3>
            <span className="meta">{recordedCount} 个已记录</span>
          </div>
          <div className="download-media-grid">
            {mediaTotals.map((item) => {
              const Icon = item.icon;
              return (
                <div className={`download-media-card ${item.key}`} key={item.key}>
                  <span className="download-media-icon"><Icon size={15} /></span>
                  <div>
                    <span>{item.label}</span>
                    <b>{item.count.toLocaleString()} <em>个</em></b>
                    <small>{item.size > 0 ? bytes(item.size) : "—"}</small>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {running && (
        <section className="panel download-active-panel">
          <div className="panel-head">
            <h3>正在下载</h3>
            <span className="meta">{active.length} 个进行中 · {concurrent} 个并发位</span>
          </div>
          <table className="table task-files-table download-table download-slot-table">
            <thead>
              <tr>
                <th className="col-file">文件</th>
                <th className="col-kind center">类型</th>
                <th className="col-progress">进度</th>
                <th className="col-transfer">已传 / 期望</th>
                <th className="col-speed">速度</th>
                <th className="col-eta">剩余</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: Math.max(active.length, concurrent) }, (_, index) => active[index] ?? null).map((file, index) => (
                file ? (
                  <tr key={`${file.id || file.name}-${index}`}>
                    <td className="col-file" title={file.name}>{file.name}</td>
                    <td className="col-kind center"><span className={`kind-chip ${mediaGroup(file.kind)}`}>{fileKindLabel(file.kind)}</span></td>
                    <td className="col-progress">
                      <div className="progress-inline">
                        <div className="mini"><i style={{ width: `${Math.max(0, Math.min(100, file.percent))}%` }} /></div>
                        <span className={file.stalled ? "stalled" : ""}>{file.stalled ? "停滞" : file.percent >= 0 ? `${file.percent.toFixed(0)}%` : "—"}</span>
                      </div>
                    </td>
                    <td className="col-transfer">{bytes(file.transferred)}{file.expected > 0 ? ` / ${bytes(file.expected)}` : ""}</td>
                    <td className="col-speed">{rate(file.speed)}</td>
                    <td className="col-eta">{file.etaMs > 0 ? fmtDuration(file.etaMs) : "--"}</td>
                  </tr>
                ) : (
                  <tr key={`empty-slot-${index}`} className="download-slot-empty">
                    <td className="col-file">空闲下载位</td>
                    <td className="col-kind center">—</td>
                    <td className="col-progress">—</td>
                    <td className="col-transfer">—</td>
                    <td className="col-speed">0 B/s</td>
                    <td className="col-eta">--</td>
                  </tr>
                )
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="panel">
        <div className="panel-head">
          <h3><ChartPie size={14} /> 速度曲线</h3>
          <span className="chart-legend"><i className="now" /> 实时 <i className="avg" /> 平均</span>
        </div>
        <TaskSpeedChart task={task} />
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>最近完成</h3>
          {completed.length > 0 && (
            <button className="task-more-link" onClick={() => { setRecordPage(1); setShowAll(true); }}>
              全部记录 <span>{completed.length}</span> <ChevronRight size={12} />
            </button>
          )}
        </div>
        {recent.length > 0 ? (
          <table className="table task-files-table download-table completed-table recent-completed-table">
            <thead>
              <tr>
                <th className="col-file">文件</th>
                <th className="col-kind center">类型</th>
                <th className="col-size">大小</th>
                <th className="col-elapsed">耗时</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((file, index) => (
                <tr key={`${file.id || file.name}-${index}`}>
                  <td className="col-file" title={file.name}>{file.name}</td>
                  <td className="col-kind center"><span className={`kind-chip ${mediaGroup(file.kind)}`}>{fileKindLabel(file.kind)}</span></td>
                  <td className="col-size">{bytes(file.expected || file.transferred)}</td>
                  <td className="col-elapsed">{file.elapsedMs > 0 ? fmtDuration(file.elapsedMs) : "--"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="download-empty"><CheckCircle2 size={14} /> {running ? "还没有完成的文件。" : "还没有完成记录。"}</div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>任务信息</h3>
          <span className="meta">任务 {task.id}</span>
        </div>
        <div className="download-info-grid">
          <div><span>类型</span><b>{meta.label}</b></div>
          <div><span>聊天</span><b>{task.chat || "--"}</b></div>
          <div><span>状态</span><b>{statusLabel(task.state)}</b></div>
          <div><span>开始时间</span><b>{dateTimePrecise(task.startedAt)}</b></div>
          <div><span>结束时间</span><b>{task.finishedAt ? dateTimePrecise(task.finishedAt) : "进行中"}</b></div>
          <div><span>耗时</span><b>{fmtDuration(elapsed)}</b></div>
          <div><span>完成媒体</span><b>{task.done ?? 0} / {task.total ?? 0}</b></div>
          <div><span>任务 ID</span><b className="mono">{task.id}</b></div>
          <div><span>峰值速度</span><b>{rate(task.peakSpeed ?? 0)}</b></div>
          <div className="wide"><span>结果</span><b className={failed ? "danger-text" : ""}>{result}</b></div>
        </div>
      </section>

      {configOpen && createPortal(
        <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !busyAction) setConfigOpen(false); }}>
          <div className="modal download-config-modal" role="dialog" aria-modal="true" aria-labelledby="download-config-title">
            <div className="task-modal-head">
              <div>
                <h2 id="download-config-title">调整下载配置</h2>
                <p className="modal-sub">保存后当前任务会短暂停下，再从已完成文件继续，配置立即生效。</p>
              </div>
              <button className="icon-btn" aria-label="关闭下载配置" disabled={!!busyAction} onClick={() => setConfigOpen(false)}>
                <X size={15} />
              </button>
            </div>
            <div className="download-config-form">
              <label>
                <span>并发文件任务</span>
                <small>同时下载多少个媒体文件（1–8）</small>
                <input
                  type="number"
                  min={1}
                  max={8}
                  value={configDraft.concurrent}
                  onChange={(e) => setConfigDraft((draft) => ({ ...draft, concurrent: Math.max(1, Math.min(8, Number(e.target.value) || 1)) }))}
                />
              </label>
              <label>
                <span>单文件线程</span>
                <small>一个文件内部的并行分片数（1–16）</small>
                <input
                  type="number"
                  min={1}
                  max={16}
                  value={configDraft.threads}
                  onChange={(e) => setConfigDraft((draft) => ({ ...draft, threads: Math.max(1, Math.min(16, Number(e.target.value) || 1)) }))}
                />
              </label>
            </div>
            <div className="download-config-note">
              <SlidersHorizontal size={14} />
              <span>并发越高不一定越快；Telegram 限流或磁盘较慢时，保持默认更稳。</span>
            </div>
            <div className="modal-actions">
              <button className="btn ghost" disabled={!!busyAction} onClick={() => setConfigOpen(false)}>取消</button>
              <button className="btn primary" disabled={!!busyAction} onClick={() => void applyConfig()}>
                {busyAction === "config" ? <Loader2 size={13} className="spin" /> : <Check size={13} />}
                {busyAction === "config" ? "正在应用…" : "保存并立即生效"}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {showAll && createPortal(
        <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowAll(false); }}>
          <div className="modal task-records-modal" role="dialog" aria-modal="true" aria-labelledby="task-records-title">
            <div className="task-modal-head">
              <div>
                <h2 id="task-records-title">全部下载记录</h2>
                <p className="modal-sub">{taskTitle(task)} · {completed.length} 个媒体</p>
              </div>
              <button className="icon-btn" aria-label="关闭下载记录" onClick={() => setShowAll(false)}>
                <X size={15} />
              </button>
            </div>
            <div className="task-records-scroll">
              {completed.length > 0 ? (
                <table className="table task-files-table download-table">
                  <thead>
                    <tr>
                      <th className="col-file">文件</th>
                      <th className="col-kind center">类型</th>
                      <th className="col-size">大小</th>
                      <th className="col-elapsed">耗时</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageRecords.map((file, index) => (
                      <tr key={`${file.id || file.name}-${index}`}>
                        <td className="col-file" title={file.name}>{file.name}</td>
                        <td className="col-kind center"><span className={`kind-chip ${mediaGroup(file.kind)}`}>{fileKindLabel(file.kind)}</span></td>
                        <td className="col-size">{bytes(file.expected || file.transferred)}</td>
                        <td className="col-elapsed">{file.elapsedMs > 0 ? fmtDuration(file.elapsedMs) : "--"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="download-empty"><CheckCircle2 size={14} /> 没有可显示的文件记录。</div>
              )}
            </div>
            <div className="task-records-footer">
              <span>共 {completed.length} 条 · 第 {safePage}/{recordPages} 页</span>
              <div className="task-records-pager">
                <button className="icon-btn" aria-label="上一页" disabled={safePage <= 1} onClick={() => setRecordPage((page) => Math.max(1, page - 1))}>
                  <ChevronLeft size={14} />
                </button>
                <button className="icon-btn" aria-label="下一页" disabled={safePage >= recordPages} onClick={() => setRecordPage((page) => Math.min(recordPages, page + 1))}>
                  <ChevronRight size={14} />
                </button>
              </div>
              <button className="btn ghost" onClick={() => setShowAll(false)}>关闭</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

export function TasksPage({
  tasks,
  focusTaskId = "",
  onFocusHandled,
  onRefresh,
  onClear,
  toast,
}: {
  tasks: TaskInfo[];
  focusTaskId?: string;
  onFocusHandled?: () => void;
  onRefresh: () => void;
  onClear: () => void;
  toast: (msg: string, err?: boolean) => void;
}) {
  const [filter, setFilter] = useState("all");
  const [kind, setKind] = useState("all");
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(Date.now());
  const [active, setActive] = useState<TaskDetail | null>(null);
  const [modalTask, setModalTask] = useState<TaskDetail | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const visible = useMemo(
    () =>
      tasks.filter((t) => {
        if (filter !== "all" && t.state !== filter) return false;
        if (kind !== "all" && t.kind !== kind) return false;
        const q = query.trim().toLowerCase();
        if (q && !`${taskTitle(t)} ${t.chat ?? ""} ${t.detail ?? ""} ${t.error ?? ""}`.toLowerCase().includes(q)) return false;
        return true;
      }),
    [tasks, filter, kind, query]
  );
  const running = tasks.filter((t) => t.state === "running").length;
  const failed = tasks.filter((t) => t.state === "failed").length;
  const done = tasks.filter((t) => t.state === "done").length;

  const loadTask = async (taskID: string) => {
    const known = tasks.find((task) => task.id === taskID);
    const download = known ? kindMeta(known.kind).group === "download" : true;
    try {
      const detail = await call<TaskDetail>("taskDetail", { id: taskID });
      if (kindMeta(detail.kind).group === "download") setActive(detail);
      else setModalTask(detail);
    } catch (e) {
      if (known && download) setActive({ ...known, series: [] });
      else if (known) setModalTask({ ...known, series: [] });
      toast((e as Error).message, true);
    }
  };

  const openTask = (task: TaskInfo) => void loadTask(task.id);

  useEffect(() => {
    if (!focusTaskId) return;
    void loadTask(focusTaskId);
    onFocusHandled?.();
    // The focus id is a one-shot navigation intent from another page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTaskId]);

  const clear = () => {
    call("clearTasks")
      .then(() => {
        onClear();
        toast("已清除完成与失败的任务");
      })
      .catch((e: Error) => toast(e.message, true));
  };

  useEffect(() => {
    document.querySelector<HTMLElement>(".scroll")?.scrollTo({ top: 0 });
  }, [active?.id]);

  useEffect(() => {
    if (!active || active.state !== "running") return;
    let cancelled = false;
    const id = window.setInterval(() => {
      call<TaskDetail>("taskDetail", { id: active.id })
        .then((detail) => {
          if (!cancelled) setActive((current) => current && current.id === detail.id ? detail : current);
        })
        .catch(() => undefined);
    }, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [active?.id, active?.state]);

  if (active) {
    return <TaskDetailView task={active} onBack={() => setActive(null)} onOpenTask={(taskID) => void loadTask(taskID)} toast={toast} />;
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>任务中心</h1>
          <p>下载任务打开独立下载详情页；其他任务弹窗查看详情</p>
        </div>
        <div className="actions">
          <button className="btn ghost" onClick={onRefresh}>
            <RefreshCw size={13} /> 刷新状态
          </button>
          <button className="btn ghost" disabled={done + failed === 0} onClick={clear}>
            <Trash2 size={13} /> 清除已完成
          </button>
        </div>
      </div>

      <section className="stat-grid">
        <div className="stat"><span>进行中</span><div><b className={running > 0 ? "accent" : ""}>{running}</b><em>个</em></div></div>
        <div className="stat"><span>已完成</span><div><b>{done}</b><em>个</em></div></div>
        <div className="stat"><span>失败</span><div><b className={failed > 0 ? "warn" : ""}>{failed}</b><em>个</em></div></div>
        <div className="stat"><span>全部任务</span><div><b>{tasks.length}</b><em>条</em></div></div>
      </section>

      <div className="task-toolbar">
        <div className="tabs-pill" role="group" aria-label="任务状态筛选">
          {STATUS_FILTERS.map(([key, label]) => (
            <button key={key} className={filter === key ? "on" : ""} onClick={() => setFilter(key)}>{label}</button>
          ))}
        </div>
        <div className="task-kind-select">
          <Select
            ariaLabel="任务类型筛选"
            value={kind}
            onChange={setKind}
            options={[{ value: "all", label: "全部类型" }, ...Object.entries(KIND_META).map(([value, meta]) => ({ value, label: meta.label }))]}
          />
        </div>
        <label className="task-search">
          <Search size={13} />
          <input type="search" value={query} placeholder="搜索任务或聊天…" onChange={(e) => setQuery(e.target.value)} aria-label="搜索任务或聊天" />
        </label>
        <span className="spacer" />
        <span className="muted">{visible.length} 条</span>
      </div>

      <section className="panel">
        {visible.length === 0 ? (
          <div className="task-empty large">
            <ListTodo size={30} />
            <p>没有符合条件的任务</p>
            <span>下载、导入 result.json、导出聊天、重建网页或合并档案库后会出现在这里。</span>
          </div>
        ) : (
          <table className="table task-table">
            <thead>
              <tr>
                <th className="task-col-state">状态</th>
                <th className="task-col-kind">类型</th>
                <th>任务</th>
                <th>聊天</th>
                <th>开始时间</th>
                <th>耗时</th>
                <th>进度</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((t) => {
                const meta = kindMeta(t.kind);
                const Icon = meta.icon;
                return (
                  <tr
                    key={t.id}
                    tabIndex={0}
                    onClick={() => void openTask(t)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        void openTask(t);
                      }
                    }}
                    title="点击查看任务详情"
                  >
                    <td className="task-col-state">
                      <span className={`task-state ${t.state}`}>
                        {t.state === "running" ? <Loader2 size={12} className="spin" /> : t.state === "done" ? <CheckCircle2 size={12} /> : t.state === "partial" ? <AlertTriangle size={12} /> : t.state === "paused" ? <Pause size={12} /> : <XCircle size={12} />}
                        {statusLabel(t.state)}
                      </span>
                    </td>
                    <td className="task-col-kind">
                      <span className={`kind-chip group-${meta.group}`}><Icon size={11} /> {meta.label}</span>
                    </td>
                    <td className="task-main">
                      <div className="task-title-line">
                        <b title={taskTitle(t)}>
                          <button className="task-title-btn" onClick={(e) => { e.stopPropagation(); void openTask(t); }}>
                            {taskTitle(t)}
                          </button>
                        </b>
                        {t.state === "done" && noNewMedia(t) && <span className="task-note">无新增</span>}
                      </div>
                    </td>
                    <td className="task-chat">{t.chat || "—"}</td>
                    <td className="muted">{dateTime(t.startedAt)}</td>
                    <td className="task-duration">{fmtDuration(taskElapsed(t.state === "running" ? { ...t, finishedAt: now } : t))}</td>
                    <td>
                      <div className="task-progress">
                        <div className="mini"><i className={t.state} style={{ width: `${Math.max(t.state === "running" ? 1 : 0, Math.min(100, t.percent))}%` }} /></div>
                        <span>{t.state === "done" ? "100%" : `${t.percent}%`}</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {modalTask && createPortal(
        <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setModalTask(null); }}>
          <div className="modal task-modal" role="dialog" aria-modal="true" aria-labelledby="task-modal-title">
            <div className="task-modal-head">
              <div>
                <h2 id="task-modal-title">{taskTitle(modalTask)}</h2>
                <p className="modal-sub">{kindMeta(modalTask.kind).label} · {modalTask.chat || "无聊天"} · {statusLabel(modalTask.state)}</p>
              </div>
              <button className="icon-btn" aria-label="关闭任务详情" onClick={() => setModalTask(null)}>
                <X size={15} />
              </button>
            </div>
            <div className="account-rows task-detail-rows">
              <div><span>开始时间</span><b>{dateTime(modalTask.startedAt)}</b></div>
              <div><span>结束时间</span><b>{modalTask.finishedAt ? dateTime(modalTask.finishedAt) : "进行中"}</b></div>
              <div><span>耗时</span><b>{fmtDuration(taskElapsed(modalTask.state === "running" ? { ...modalTask, finishedAt: now } : modalTask))}</b></div>
              <div><span>进度</span><b>{modalTask.state === "done" ? "100%" : `${modalTask.percent}%`}</b></div>
              <div><span>任务说明</span><b>{modalTask.detail || "--"}</b></div>
              {modalTask.error && <div><span>错误</span><b className="danger-text">{modalTask.error}</b></div>}
            </div>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setModalTask(null)}><X size={12} /> 关闭</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
