import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Activity,
  ArrowLeft,
  CalendarClock,
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
  Square,
  Trash2,
  Video,
  X,
  XCircle,
} from "lucide-react";
import { call } from "./rpc";
import { Select } from "./Select";
import { ConfirmDialog } from "./ConfirmDialog";
import { OnlineUpdateDialog, type OnlineUpdateTarget } from "./OnlineUpdateDialog";
import { SyncPlans } from "./SyncPlans";
import type { Bootstrap, TaskDetail, TaskInfo } from "./types";
import { bytes, dateTime, dateTimePrecise, duration, rate, rateParts } from "./format";

const KIND_META: Record<string, { label: string; group: string; icon: typeof Download }> = {
  sync: { label: "下载", group: "download", icon: Download },
  "sync-all": { label: "批量下载", group: "download", icon: Download },
  "sync-plan": { label: "计划同步", group: "download", icon: CalendarClock },
  "import-json": { label: "导入 JSON", group: "import", icon: FileJson },
  "import-official": { label: "官方导出", group: "import", icon: FolderInput },
  export: { label: "导出", group: "export", icon: FolderInput },
  refresh: { label: "重建", group: "build", icon: RefreshCw },
  "refresh-all": { label: "重建全部", group: "build", icon: RefreshCw },
  "complete-all": { label: "全库补齐", group: "build", icon: RefreshCw },
  merge: { label: "合并档案库", group: "merge", icon: GitMerge },
};

function kindMeta(kind: string) {
  return KIND_META[kind] ?? { label: kind, group: "other", icon: Activity };
}

function taskTitle(task: TaskInfo): string {
  if (task.kind === "sync") return "下载聊天";
  if (task.kind === "sync-all") return "批量下载";
  if (task.kind === "sync-plan") return task.title || "计划同步";
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
  if (state === "stopped") return "已终止";
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

function taskElapsed(task: Pick<TaskInfo, "elapsedMs" | "finishedAt" | "startedAt">, now?: number): number {
  const measured = Math.max(0, task.elapsedMs || 0);
  if (measured > 0) return measured;
  return Math.max(0, (now ?? (task.finishedAt || task.startedAt)) - task.startedAt);
}

// A fallback wall clock is needed only until a running task reports measured
// elapsed time. Keep that timer in the cell, not in the whole task center.
const TaskElapsed = memo(function TaskElapsed({
  state, elapsedMs, startedAt, finishedAt,
}: Pick<TaskInfo, "state" | "elapsedMs" | "startedAt" | "finishedAt">) {
  const [now, setNow] = useState(Date.now);
  const needsClock = state === "running" && !(elapsedMs && elapsedMs > 0);
  useEffect(() => {
    if (!needsClock) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [needsClock, startedAt]);
  return <>{fmtDuration(taskElapsed({ elapsedMs, startedAt, finishedAt }, needsClock ? now : undefined))}</>;
});

function noNewMedia(task: TaskInfo | TaskDetail): boolean {
  return kindMeta(task.kind).group === "download" && task.state !== "failed" && task.state !== "stopped" && !task.total && !task.bytes && !(task.kind === "sync-plan" && task.messages);
}

function modeLabel(mode?: string): string {
  if (mode === "managed" || mode === "move") return "纳管（移动原目录）";
  if (mode === "copy") return "复制（保留原目录）";
  if (mode === "reference") return "引用（不复制文件）";
  return mode || "--";
}

function wrapPath(value: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  value.split(/([\\/])/).forEach((part, i) => {
    nodes.push(part);
    if (part === "\\" || part === "/") nodes.push(<wbr key={i} />);
  });
  return nodes;
}

interface TaskInfoCard {
  label: string;
  value: string;
  mono?: boolean;
  wide?: boolean;
}

function taskInfoCards(task: TaskDetail): TaskInfoCard[] {
  const cards: TaskInfoCard[] = [];
  const add = (label: string, value: string, opts: { mono?: boolean; wide?: boolean } = {}) => {
    if (value && value !== "--") cards.push({ label, value, ...opts });
  };
  const content = [task.messages ? `${task.messages.toLocaleString()} 条消息` : "", task.media ? `${task.media.toLocaleString()} 个媒体` : ""].filter(Boolean).join(" · ");
  if (task.kind === "import-official") {
    add("导入方式", modeLabel(task.mode));
    if (task.totalBytes) add("数据大小", bytes(task.totalBytes));
    add("内容", content);
    if (task.filesTotal) add("复制文件", `${(task.filesDone ?? 0).toLocaleString()} / ${task.filesTotal.toLocaleString()} 个`);
    add("源目录", task.source || "", { mono: true, wide: true });
  } else if (task.kind === "export") {
    if (task.totalBytes) add("数据大小", bytes(task.totalBytes));
    add("内容", content);
    add("源档案库", task.source || "", { mono: true, wide: true });
    add("目标档案库", task.target || "", { mono: true, wide: true });
  } else if (task.kind === "refresh") {
    add("内容", content);
    add("归档目录", task.source || "", { mono: true, wide: true });
  } else if (task.kind === "refresh-all" || task.kind === "complete-all") {
    if (task.filesTotal) add("聊天", `${task.filesDone ?? 0} / ${task.filesTotal} 个`);
    add("档案库", task.target || "", { mono: true, wide: true });
  } else if (task.kind === "merge") {
    if (task.filesTotal) add("聊天", `${task.filesDone ?? 0} / ${task.filesTotal} 个`);
    add("源档案库", task.source || "", { mono: true, wide: true });
    add("目标档案库", task.target || "", { mono: true, wide: true });
  } else if (task.kind === "import-json") {
    if (task.filesTotal) add("文件", `${task.filesDone ?? 0} / ${task.filesTotal} 个`);
    add("源目录", task.source || "", { mono: true, wide: true });
  } else if (task.detail) {
    add("任务说明", task.detail, { wide: true });
  }
  return cards;
}

function taskMediaParts(task: TaskDetail): Array<{ label: string; value: number }> {
  return [
    { label: "图片", value: task.images ?? 0 },
    { label: "视频", value: task.videos ?? 0 },
    { label: "音频", value: task.audio ?? 0 },
    { label: "文件", value: task.files ?? 0 },
  ];
}

function taskChatIdLabel(task: TaskDetail): string {
  if (task.chatId) return `Chat ID ${task.chatId}`;
  if (task.kind === "import-official" || task.kind === "export" || task.kind === "refresh") {
    return "Chat ID 未记录（在线更新后补全）";
  }
  return "";
}

const STATUS_FILTERS = [
  ["all", "全部"],
  ["running", "进行中"],
  ["done", "已完成"],
  ["partial", "部分完成"],
  ["paused", "已暂停"],
  ["stopped", "已终止"],
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

function allocateBytes(total: number, weights: number[]): number[] {
  const target = Math.max(0, Math.round(total));
  const sum = weights.reduce((value, weight) => value + Math.max(0, weight), 0);
  if (!sum || !target) return weights.map(() => 0);
  const exact = weights.map((weight) => target * Math.max(0, weight) / sum);
  const result = exact.map(Math.floor);
  let remaining = target - result.reduce((value, part) => value + part, 0);
  const order = exact.map((value, index) => ({ index, remainder: value - result[index] }))
    .sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; i < order.length && remaining > 0; i++, remaining--) result[order[i].index]++;
  return result;
}


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

interface DownloadConfigDraft {
  concurrent: number;
  threads: number;
  stallTimeoutSeconds: number;
  stalledFileRetries: number;
  networkRetryMinutes: number;
  unknownRetryCount: number;
  maxRepairPasses: number;
  transferAdjustment: string;
  reconnectTimeout: string;
}

export function TaskDetailView({ task, onBack, onOpenTask, onOpenPlans, toast }: { task: TaskDetail; onBack: () => void; onOpenTask: (taskId: string) => void; onOpenPlans: (planId?: string) => void; toast: (msg: string, err?: boolean) => void }) {
  const [showAll, setShowAll] = useState(false);
  const [recordPage, setRecordPage] = useState(1);
  const [busyAction, setBusyAction] = useState<"" | "resume" | "rebuild" | "pause" | "stop" | "config">("");
  const [updateTarget, setUpdateTarget] = useState<OnlineUpdateTarget | null>(null);
  const [pauseRequested, setPauseRequested] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [configDraft, setConfigDraft] = useState<DownloadConfigDraft>({
    concurrent: task.concurrent ?? 4, threads: task.threads ?? 4,
    stallTimeoutSeconds: 60, stalledFileRetries: 3, networkRetryMinutes: 30,
    unknownRetryCount: 2, maxRepairPasses: 3, transferAdjustment: "increase", reconnectTimeout: "60s",
  });
  const [transfer, setTransfer] = useState<DownloadConfigDraft | null>(null);
  const meta = kindMeta(task.kind);
  const planned = task.kind === "sync-plan";
  const running = task.state === "running";
  const failed = task.state === "failed";
  const partial = task.state === "partial";
  const paused = task.state === "paused";
  const stopped = task.state === "stopped";
  const pausing = pauseRequested && running;
  const warning = partial || paused;
  const noop = noNewMedia(task);
  const elapsed = taskElapsed(task);
  const percent = task.state === "done" ? 100 : Math.max(0, Math.min(100, task.percent));
  const series = task.series ?? [];
  const active = task.active ?? [];
  const completed = task.completed ?? [];
  const speedNow = series.length > 0 ? series[series.length - 1].now : 0;
  const speed = rateParts(speedNow);
  const plannedCounts = [task.images ?? 0, task.videos ?? 0, task.audio ?? 0, task.files ?? 0];
  const doneCounts = [task.doneImages ?? 0, task.doneVideos ?? 0, task.doneAudio ?? 0, task.doneFiles ?? 0];
  const hasPlan = plannedCounts.some((n) => n > 0);
  const useDoneStats = Boolean(task.doneStats);
  const mediaTotals = MEDIA_GROUPS.map((group, index) => {
    let recordDone = 0;
    let size = 0;
    for (const file of completed) {
      if (mediaGroup(file.kind) !== group.key) continue;
      recordDone++;
      size += file.expected > 0 ? file.expected : file.transferred;
    }
    const count = hasPlan ? plannedCounts[index] : recordDone;
    const done = useDoneStats ? Math.min(doneCounts[index], count) : recordDone;
    return { ...group, count, done, size };
  });
  const recordedCount = mediaTotals.reduce((sum, item) => sum + item.done, 0);
  const totalCount = mediaTotals.reduce((sum, item) => sum + item.count, 0);
  // Per-type downloaded size follows the live transfer counters of active and
  // completed files, then is scaled to the task total so the cards always sum
  // to "已下载 / 总大小" while a large file is still in flight.
  const liveSize = mediaTotals.map((item) => {
    let size = 0;
    for (const file of active) {
      if (mediaGroup(file.kind) === item.key) size += Math.max(0, file.transferred ?? 0);
    }
    for (const file of completed) {
      if (mediaGroup(file.kind) === item.key) size += Math.max(0, file.expected > 0 ? file.expected : file.transferred ?? 0);
    }
    return size;
  });
  const liveSizeTotal = liveSize.reduce((sum, size) => sum + size, 0);
  const totalSizes = allocateBytes(task.totalBytes ?? 0, mediaTotals.map((item) => item.count));
  const doneSizes = allocateBytes(task.bytes ?? 0, liveSizeTotal > 0 ? liveSize : (recordedCount > 0 ? mediaTotals.map((item) => item.done) : plannedCounts));
  const sizedTotals = mediaTotals.map((item, index) => ({
    ...item,
    totalSize: totalSizes[index],
    doneSize: doneSizes[index],
  }));
  const recent = completed.slice(0, 5);
  const showTransfer = !planned || totalCount > 0 || active.length > 0 || series.length > 0;
  const pageSize = 10;
  const recordPages = Math.max(1, Math.ceil(completed.length / pageSize));
  const safePage = Math.min(recordPage, recordPages);
  const pageRecords = completed.slice((safePage - 1) * pageSize, safePage * pageSize);
  const result = task.error || (noop
    ? "同步完成，本次没有产生媒体下载"
    : task.detail || (task.state === "done" ? "任务完成" : task.state === "running" ? "任务进行中" : partial ? "部分媒体未能下载" : paused ? "任务已暂停" : stopped ? "任务已终止" : "任务失败"));
  const displayResult = pausing
    ? "正在安全暂停，当前文件结束后会保留进度…"
    : failed ? `失败原因：${result}` : partial ? `部分完成：${result}` : paused ? "任务已暂停，已完成文件和记录会保留" : stopped ? "任务已终止，已完成文件和记录会保留" : result;
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
    if (!running || !showTransfer) return;
    call<Partial<DownloadConfigDraft>>("getSettings")
      .then((settings) => {
        setTransfer({
          concurrent: task.concurrent ?? settings.concurrent ?? 4,
          threads: task.threads ?? settings.threads ?? 4,
          stallTimeoutSeconds: settings.stallTimeoutSeconds ?? 60,
          stalledFileRetries: settings.stalledFileRetries ?? 3,
          networkRetryMinutes: settings.networkRetryMinutes ?? 30,
          unknownRetryCount: settings.unknownRetryCount ?? 2,
          maxRepairPasses: settings.maxRepairPasses ?? 3,
          transferAdjustment: settings.transferAdjustment ?? "increase",
          reconnectTimeout: settings.reconnectTimeout ?? "60s",
        });
      })
      .catch(() => undefined);
  }, [running, showTransfer, task.id, task.concurrent, task.threads]);

  const openConfig = () => {
    const base = transfer ?? configDraft;
    setConfigDraft({ ...base, concurrent, threads });
    setConfigOpen(true);
  };

  const setConfigField = <K extends keyof DownloadConfigDraft>(key: K, value: DownloadConfigDraft[K]) => {
    setConfigDraft((draft) => ({ ...draft, [key]: value }));
  };

  const applyConfig = async () => {
    if (busyAction) return;
    setBusyAction("config");
    try {
      const nextTask = await call<string>("setDownloadConfig", configDraft);
      setTransfer(configDraft);
      setConfigOpen(false);
      if (nextTask) {
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

  useEffect(() => {
    if (pauseRequested && task.state !== "running") setPauseRequested(false);
  }, [pauseRequested, task.state]);

  useEffect(() => {
    if (!pauseRequested) return;
    const timer = window.setTimeout(() => setPauseRequested(false), 10000);
    return () => window.clearTimeout(timer);
  }, [pauseRequested]);

  const pause = async () => {
    if (busyAction || pausing) return;
    setBusyAction("pause");
    setPauseRequested(true);
    toast("正在安全暂停，已完成文件会保留");
    try {
      await call("pause");
    } catch (e) {
      setPauseRequested(false);
      toast((e as Error).message, true);
    } finally {
      setBusyAction("");
    }
  };

  const resume = () => {
    if (!task.slug || busyAction) return;
    setUpdateTarget({
      peer: "local:" + task.slug,
      name: task.chat || task.title,
      slug: task.slug,
      mode: "sync",
    });
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

  const stop = async () => {
    if (busyAction) return;
    setBusyAction("stop");
    try {
      await call("stopTask", { id: task.id });
      toast("任务已终止，已完成文件和记录会保留");
      onOpenTask(task.id);
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
          {planned && <button className="btn ghost" onClick={() => onOpenPlans(task.planId)}><CalendarClock size={13} /> 查看同步计划</button>}
          {!planned && running && !pausing && (
            <button className="btn ghost" onClick={openConfig}>
              <SlidersHorizontal size={13} /> 下载配置
            </button>
          )}
          {!planned && task.slug && (
            <button className="btn ghost" disabled={!!busyAction} onClick={() => void rebuild()} title="重新生成数据、网页与缺失的视频封面">
              {busyAction === "rebuild" ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
              重建网页
            </button>
          )}
          {!planned && task.slug && (
            <button
              className="btn ghost"
              onClick={() => call("openLibrary", { slug: task.slug }).catch((e: Error) => toast(e.message, true))}
            >
              <FolderOpen size={13} /> 打开归档库
            </button>
          )}
          {!planned && (running || paused || partial) && (
            <button className="btn stop-action" disabled={!!busyAction} onClick={() => void stop()}>
              {busyAction === "stop" ? <Loader2 size={13} className="spin" /> : <Square size={13} />}
              结束任务
            </button>
          )}
          {!planned && task.slug && (failed || partial || paused) && (
            <button className="btn primary" disabled={!!busyAction} onClick={() => void resume()}>
              {busyAction === "resume" ? <Loader2 size={13} className="spin" /> : <Play size={13} />}
              继续下载
            </button>
          )}
          {!planned && running && (pausing ? (
            <button className="btn warn" disabled>
              <Loader2 size={13} className="spin" /> 正在暂停…
            </button>
          ) : (
            <button className="btn warn" disabled={!!busyAction} onClick={() => void pause()}>
              {busyAction === "pause" ? <Loader2 size={13} className="spin" /> : <Pause size={13} />}
              暂停
            </button>
          ))}
        </div>
      </div>

      <section className={`download-hero ${running ? "running" : stopped ? "stopped" : warning ? "warning" : failed ? "failed" : "done"}`}>
        <div
          className="download-hero-icon"
          role="progressbar"
          aria-valuenow={Math.round(percent)}
          aria-valuemin={0}
          aria-valuemax={100}
          style={running ? { background: `conic-gradient(var(--accent) ${percent}%, var(--surface-3) ${percent}% 100%)` } : undefined}
        >
          {running ? <b>{Math.round(percent)}%</b> : stopped ? <Square size={28} strokeWidth={2.2} /> : partial ? <AlertTriangle size={30} strokeWidth={2.1} /> : paused ? <Pause size={30} strokeWidth={2.2} /> : failed ? <X size={32} strokeWidth={2.2} /> : <Check size={36} strokeWidth={2.6} />}
        </div>
        <div className="download-hero-main">
          <span className="download-hero-kicker">{planned ? "计划同步" : "下载聊天"}</span>
          <div className="download-hero-title">
            <h2>{task.chat || taskTitle(task)}</h2>
          </div>
          {running && showTransfer ? (
            <div className="download-hero-configline">
              <span className="download-config-chip">并发 <b>{concurrent}</b> 个文件</span>
              <span className="download-config-chip">每文件 <b>{threads}</b> 线程</span>
            </div>
          ) : (
            <p className={`download-hero-desc ${failed ? "bad" : warning ? "warn" : ""}`} title={result}>{displayResult}</p>
          )}
          <div className="download-hero-info">
            <span>开始 <b>{dateTime(task.startedAt)}</b></span>
            {showTransfer && <span>峰值速度 <b>{rate(task.peakSpeed ?? 0)}</b></span>}
            {task.finishedAt ? <span>结束 <b>{dateTime(task.finishedAt)}</b></span> : null}
          </div>
        </div>
        {running && showTransfer && (
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
            {stopped ? <Square size={126} strokeWidth={1.4} /> : partial ? <AlertTriangle size={126} strokeWidth={1.4} /> : paused ? <Pause size={126} strokeWidth={1.4} /> : failed ? <X size={132} strokeWidth={1.4} /> : <Check size={144} strokeWidth={1.4} />}
          </span>
        )}
      </section>

      <section className={`stat-grid download-stats ${showTransfer ? running ? "five" : "four" : "plan-summary-stats"}`}>
        {!showTransfer && <div className="stat"><span>新增消息</span><div><b>{(task.messages ?? 0).toLocaleString()}</b><em>条</em></div></div>}
        {running && showTransfer && <div className="stat"><span>实时速度</span><div><b>{rate(speedNow)}</b></div></div>}
        {showTransfer && <>
        <div className="stat"><span>平均速度</span><div><b>{rate(task.avgSpeed ?? 0)}</b></div></div>
        <div className="stat">
          <span>已下载 / {task.totalBytesEstimated ? "预计总大小" : "总大小"}</span>
          <div><b>{bytes(task.bytes ?? 0)}</b><em>/ {task.totalBytes ? bytes(task.totalBytes) : "--"}</em></div>
        </div>
        <div className="stat"><span>已下载 / 总媒体</span><div><b>{task.done ?? 0}</b><em>/ {task.total ?? 0}</em></div></div>
        </>}
        <div className="stat">
          <span>{running ? "预计还需" : "任务耗时"}</span>
          <div><b>{running ? ((task.etaMs ?? 0) > 0 ? duration(task.etaMs ?? 0) : "--") : fmtDuration(elapsed)}</b></div>
        </div>
      </section>

      {showTransfer && <section className="panel download-media-panel">
        <div className="panel-head">
          <h3><ChartPie size={14} /> 本次媒体构成</h3>
          <span className="meta">已下载 {recordedCount.toLocaleString()} / {totalCount.toLocaleString()} 个</span>
        </div>
        <div className="download-media-grid">
          {sizedTotals.map((item) => {
            const Icon = item.icon;
            return (
              <div className={`download-media-card ${item.key}`} key={item.key}>
                <span className="download-media-icon"><Icon size={15} /></span>
                <div>
                  <span>{item.label}</span>
                  <b>{item.done.toLocaleString()} <em>个</em></b>
                  <small>共 {item.count.toLocaleString()} 个 · {item.totalSize > 0 ? bytes(item.totalSize) : "—"}</small>
                  <small className="done-size">已下载 {item.doneSize > 0 ? bytes(item.doneSize) : "—"}</small>
                </div>
              </div>
            );
          })}
        </div>
      </section>}

      {running && showTransfer && (
        <section className="panel download-config-panel">
          <div className="panel-head">
            <h3><SlidersHorizontal size={14} /> 下载配置</h3>
          </div>
          <div className="download-config-grid">
            <div><span>并发文件任务</span><b>{transfer?.concurrent ?? concurrent}<em> 个</em></b></div>
            <div><span>单文件线程</span><b>{transfer?.threads ?? threads}<em> 条</em></b></div>
            <div><span>卡住判定</span><b>{transfer?.stallTimeoutSeconds ?? 60}<em> 秒</em></b></div>
            <div><span>重试策略</span><b>{retryLabel[transfer?.transferAdjustment ?? "increase"] ?? "逐步增加线程"}</b></div>
          </div>
        </section>
      )}

      {running && showTransfer && (
        <section className="panel download-active-panel">
          <div className="panel-head">
            <h3><Download size={14} /> 正在下载</h3>
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

      {showTransfer && <section className="panel">
        <div className="panel-head">
          <h3><Activity size={14} /> 速度曲线</h3>
          <span className="chart-legend"><i className="now" /> 实时 <i className="avg" /> 平均</span>
        </div>
        <TaskSpeedChart task={task} />
      </section>}

      {showTransfer && <section className="panel">
        <div className="panel-head">
          <h3><CheckCircle2 size={14} /> 最近完成</h3>
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
      </section>}

      <section className="panel">
        <div className="panel-head">
          <h3><ListTodo size={14} /> 任务信息</h3>
          <span className="meta">任务 {task.id}</span>
        </div>
        <div className="download-info-grid">
          <div><span>类型</span><b>{meta.label}</b></div>
          <div><span>聊天</span><b>{task.chat || "--"}</b></div>
          <div><span>状态</span><b>{statusLabel(task.state)}</b></div>
          <div><span>开始时间</span><b>{dateTimePrecise(task.startedAt)}</b></div>
          <div><span>结束时间</span><b>{task.finishedAt ? dateTimePrecise(task.finishedAt) : "进行中"}</b></div>
          <div><span>耗时</span><b>{fmtDuration(elapsed)}</b></div>
          {planned && showTransfer && <div><span>新增消息</span><b>{(task.messages ?? 0).toLocaleString()} 条</b></div>}
          {showTransfer && <div><span>已下载 / 总媒体</span><b>{task.done ?? 0} / {task.total ?? 0}</b></div>}
          <div><span>任务 ID</span><b className="mono">{task.id}</b></div>
          {showTransfer && <div><span>峰值速度</span><b>{rate(task.peakSpeed ?? 0)}</b></div>}
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
                <input type="number" min={1} max={8} value={configDraft.concurrent}
                  onChange={(e) => setConfigField("concurrent", Math.max(1, Math.min(8, Number(e.target.value) || 1)))} />
              </label>
              <label>
                <span>单文件线程</span>
                <small>一个文件内部的并行分片数（1–16）</small>
                <input type="number" min={1} max={16} value={configDraft.threads}
                  onChange={(e) => setConfigField("threads", Math.max(1, Math.min(16, Number(e.target.value) || 1)))} />
              </label>
              <label>
                <span>卡住判定（秒）</span>
                <small>多久没有真实进度就暂缓文件（30–600）</small>
                <input type="number" min={30} max={600} value={configDraft.stallTimeoutSeconds}
                  onChange={(e) => setConfigField("stallTimeoutSeconds", Math.max(30, Math.min(600, Number(e.target.value) || 30)))} />
              </label>
              <label>
                <span>疑难文件重试</span>
                <small>反复卡住的文件最多重试几次（1–10）</small>
                <input type="number" min={1} max={10} value={configDraft.stalledFileRetries}
                  onChange={(e) => setConfigField("stalledFileRetries", Math.max(1, Math.min(10, Number(e.target.value) || 1)))} />
              </label>
              <label>
                <span>网络恢复窗口（分钟）</span>
                <small>断网后持续尝试多长时间（1–180）</small>
                <input type="number" min={1} max={180} value={configDraft.networkRetryMinutes}
                  onChange={(e) => setConfigField("networkRetryMinutes", Math.max(1, Math.min(180, Number(e.target.value) || 1)))} />
              </label>
              <label>
                <span>未知错误重试</span>
                <small>非网络错误的自动重试次数（0–10）</small>
                <input type="number" min={0} max={10} value={configDraft.unknownRetryCount}
                  onChange={(e) => setConfigField("unknownRetryCount", Math.max(0, Math.min(10, Number(e.target.value) || 0)))} />
              </label>
              <label>
                <span>最大修复轮数</span>
                <small>一次同步中最多补漏几轮（1–10）</small>
                <input type="number" min={1} max={10} value={configDraft.maxRepairPasses}
                  onChange={(e) => setConfigField("maxRepairPasses", Math.max(1, Math.min(10, Number(e.target.value) || 1)))} />
              </label>
              <label>
                <span>重连超时</span>
                <small>tdl 连接重建等待，例如 5m</small>
                <input type="text" value={configDraft.reconnectTimeout}
                  onChange={(e) => setConfigField("reconnectTimeout", e.target.value)} />
              </label>
              <div className="download-strategy-field wide">
                <span>重试传输策略</span>
                <small>反复卡住时如何调整并发参数</small>
                <div className="download-strategy-options">
                  {[
                    ["increase", "逐步增加线程（推荐）"],
                    ["increase-both", "线程和并发一起增加（试验）"],
                    ["decrease", "逐步降低线程"],
                    ["keep", "保持原配置"],
                  ].map(([value, label]) => (
                    <button
                      type="button"
                      key={value}
                      className={configDraft.transferAdjustment === value ? "on" : ""}
                      onClick={() => setConfigField("transferAdjustment", value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="download-config-note">
              <SlidersHorizontal size={14} />
              <span>保存后会短暂停下并按新配置从已完成文件继续；暂停时间不计入任务耗时。</span>
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
      {updateTarget && (
        <OnlineUpdateDialog
          target={updateTarget}
          onClose={() => setUpdateTarget(null)}
          onStarted={(taskId) => { setUpdateTarget(null); if (taskId) onOpenTask(taskId); }}
          toast={toast}
        />
      )}
    </>
  );
}

export function TasksPage({
  tasks,
  boot,
  tab,
  onTabChange,
  expandedPlan,
  onExpandPlan,
  onAccount,
  onLibrary,
  onRemote,
  focusTaskId = "",
  onFocusHandled,
  onRefresh,
  onClear,
  onDelete,
  toast,
}: {
  tasks: TaskInfo[];
  boot: Bootstrap | null;
  tab: "records" | "plans";
  onTabChange: (tab: "records" | "plans") => void;
  expandedPlan: string;
  onExpandPlan: (id: string) => void;
  onAccount: () => void;
  onLibrary: () => void;
  onRemote: () => void;
  focusTaskId?: string;
  onFocusHandled?: () => void;
  onRefresh: () => void;
  onClear: () => void;
  onDelete: (ids: string[]) => void;
  toast: (msg: string, err?: boolean) => void;
}) {
  const [filter, setFilter] = useState("all");
  const [kind, setKind] = useState("all");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<TaskDetail | null>(null);
  const [modalTask, setModalTask] = useState<TaskDetail | null>(null);
  const [selectionVersion, setSelectionVersion] = useState(0);
  const selection = useRef(0);
  const [clearConfirm, setClearConfirm] = useState(false);
  const modalRef = useRef<HTMLDialogElement>(null);

  useLayoutEffect(() => {
    if (!modalTask) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = modalRef.current;
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]') ?? []).filter((element) => element.getClientRects().length > 0);
    dialog?.showModal();
    focusable()[0]?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        selection.current++;
        setModalTask(null);
      } else if (event.key === "Tab") {
        const items = focusable();
        const first = items[0];
        const last = items[items.length - 1];
        if (!first) { event.preventDefault(); dialog?.focus(); }
        else if (event.shiftKey && (document.activeElement === first || !dialog?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !dialog?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      dialog?.close();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [modalTask?.id]);

  useEffect(() => () => { selection.current++; }, []);

  const visible = useMemo(
    () =>
      tasks.filter((t) => {
        if (filter !== "all" && t.state !== filter) return false;
        if (kind !== "all" && t.kind !== kind) return false;
        const q = query.trim().toLowerCase();
        if (q && !`${taskTitle(t)} ${t.chat ?? ""} ${t.chatId ?? ""} ${t.detail ?? ""} ${t.error ?? ""}`.toLowerCase().includes(q)) return false;
        return true;
      }),
    [tasks, filter, kind, query]
  );
  const running = tasks.filter((t) => t.state === "running").length;
  const failed = tasks.filter((t) => t.state === "failed").length;
  const done = tasks.filter((t) => t.state === "done").length;

  const loadTask = async (taskID: string) => {
    const version = ++selection.current;
    const known = tasks.find((task) => task.id === taskID);
    const show = (detail: TaskDetail) => {
      setSelectionVersion(version);
      if (kindMeta(detail.kind).group === "download") {
        setModalTask(null);
        setActive(detail);
      } else {
        setActive(null);
        setModalTask(detail);
      }
    };
    try {
      const detail = await call<TaskDetail>("taskDetail", { id: taskID });
      if (version === selection.current) show(detail);
    } catch (e) {
      if (version !== selection.current) return;
      if (known) show({ ...known, series: [] });
      toast((e as Error).message, true);
    }
  };

  const openTask = (task: TaskInfo) => void loadTask(task.id);

  useEffect(() => {
    if (!focusTaskId) return;
    onTabChange("records");
    void loadTask(focusTaskId);
    onFocusHandled?.();
    // The focus id is a one-shot navigation intent from another page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTaskId]);

  const clearAll = () => {
    call("clearAllTasks")
      .then(() => {
        onClear();
        setClearConfirm(false);
        toast("已删除全部任务记录，下载文件未受影响");
      })
      .catch((e: Error) => toast(e.message, true));
  };

  const removeRecord = (task: TaskInfo) => {
    if (task.state === "running") {
      toast("进行中的任务不能删除记录，请先暂停或结束任务", true);
      return;
    }
    call("deleteTask", { id: task.id })
      .then(() => {
        onDelete([task.id]);
        toast("已删除任务记录，下载文件未受影响");
      })
      .catch((e: Error) => toast(e.message, true));
  };

  useEffect(() => {
    document.querySelector<HTMLElement>(".scroll")?.scrollTo({ top: 0 });
  }, [active?.id]);

  useEffect(() => {
    if (!active || active.state !== "running") return;
    let cancelled = false;
    let timer: number;
    const poll = async () => {
      try {
        const detail = await call<TaskDetail>("taskDetail", { id: active.id });
        if (!cancelled && selection.current === selectionVersion) setActive((current) => current && current.id === detail.id ? detail : current);
      } catch { /* Keep the current snapshot until the next poll. */ }
      if (!cancelled && selection.current === selectionVersion) timer = window.setTimeout(poll, 1000);
    };
    timer = window.setTimeout(poll, 1000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [active?.id, active?.state, selectionVersion]);

  useEffect(() => {
    if (!modalTask || modalTask.state !== "running") return;
    let cancelled = false;
    let timer: number;
    const poll = async () => {
      try {
        const detail = await call<TaskDetail>("taskDetail", { id: modalTask.id });
        if (!cancelled && selection.current === selectionVersion) setModalTask((current) => current && current.id === detail.id ? detail : current);
      } catch { /* Keep the current snapshot until the next poll. */ }
      if (!cancelled && selection.current === selectionVersion) timer = window.setTimeout(poll, 800);
    };
    timer = window.setTimeout(poll, 800);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [modalTask?.id, modalTask?.state, selectionVersion]);

  if (active) {
    return <TaskDetailView key={active.id} task={active} onBack={() => { selection.current++; setActive(null); }} onOpenTask={(taskID) => void loadTask(taskID)} onOpenPlans={(planId) => { selection.current++; setActive(null); onTabChange("plans"); if (planId) onExpandPlan(planId); }} toast={toast} />;
  }

  const modalMeta = modalTask ? kindMeta(modalTask.kind) : null;
  const ModalIcon = modalMeta?.icon;
  const modalPercent = modalTask ? (modalTask.state === "done" ? 100 : Math.max(0, Math.min(100, modalTask.percent))) : 0;
  const modalChat = modalTask?.chat?.trim() || "";
  const modalHeading = modalTask ? (modalChat || taskTitle(modalTask)) : "";
  const modalCards = modalTask ? taskInfoCards(modalTask) : [];
  const modalMedia = modalTask ? taskMediaParts(modalTask) : [];
  const modalShowMedia = Boolean(modalTask && ((modalTask.media ?? 0) > 0 || modalMedia.some((part) => part.value > 0)));
  const modalChatLabel = modalTask ? taskChatIdLabel(modalTask) : "";
  const modalShowError = Boolean(modalTask?.error) && (modalTask?.state === "failed" || modalTask?.state === "partial");

  return (
    <>
      <div className="page-head">
        <div>
          <h1>任务中心</h1>
        </div>
      </div>

      <div className="task-center-nav">
        <div className="tabs task-center-tabs" role="tablist" aria-label="任务中心" onKeyDown={(e) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
          e.preventDefault();
          const next = e.key === "Home" ? "records" : e.key === "End" ? "plans" : tab === "records" ? "plans" : "records";
          onTabChange(next);
          e.currentTarget.querySelector<HTMLButtonElement>(`#task-tab-${next}`)?.focus();
        }}>
          <button id="task-tab-records" role="tab" type="button" aria-controls="task-records" aria-selected={tab === "records"} tabIndex={tab === "records" ? 0 : -1} className={tab === "records" ? "on" : ""} onClick={() => onTabChange("records")}><ListTodo size={15} /> 任务记录</button>
          <button id="task-tab-plans" role="tab" type="button" aria-controls="task-plans" aria-selected={tab === "plans"} tabIndex={tab === "plans" ? 0 : -1} className={tab === "plans" ? "on" : ""} onClick={() => onTabChange("plans")}><CalendarClock size={15} /> 同步计划</button>
        </div>
        {tab === "records" && <div className="actions">
          <button className="btn ghost" onClick={onRefresh}><RefreshCw size={13} /> 刷新状态</button>
          <button className="btn danger" disabled={tasks.every((t) => t.state === "running")} onClick={() => setClearConfirm(true)}><Trash2 size={13} /> 全部删除</button>
        </div>}
      </div>

      {tab === "plans" ? (
        <div id="task-plans" role="tabpanel" aria-labelledby="task-tab-plans" className="task-center-content">
          <SyncPlans boot={boot} expandedPlan={expandedPlan} onExpandPlan={onExpandPlan} onAccount={onAccount} onLibrary={onLibrary} onRemote={onRemote} onOpenTask={(id) => void loadTask(id)} toast={toast} />
        </div>
      ) : <div id="task-records" role="tabpanel" aria-labelledby="task-tab-records" className="task-center-content">

      <section className="stat-grid task-record-stats" aria-label="任务概况">
        <div className="stat"><span>进行中</span><div><b className={running > 0 ? "accent" : ""}>{running}</b><em>个</em></div></div>
        <div className="stat"><span>已完成</span><div><b>{done}</b><em>个</em></div></div>
        <div className="stat"><span>失败</span><div><b className={failed > 0 ? "warn" : ""}>{failed}</b><em>个</em></div></div>
        <div className="stat"><span>全部任务</span><div><b>{tasks.length}</b><em>条</em></div></div>
      </section>

      <section className="panel task-records-panel">
      <div className="task-toolbar">
        <div className="tabs-pill" role="group" aria-label="任务状态筛选">
          {STATUS_FILTERS.map(([key, label]) => (
            <button key={key} aria-pressed={filter === key} className={filter === key ? "on" : ""} onClick={() => setFilter(key)}>{label}</button>
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
        <span className="muted task-record-count" aria-live="polite">{visible.length} 条</span>
      </div>

      <div className="task-table-scroll">
        {visible.length === 0 ? (
          <div className="task-empty large">
            <ListTodo size={30} />
            <p>{tasks.length ? "没有符合条件的任务" : "还没有任务记录"}</p>
            <span>{tasks.length ? "试试其他状态、任务类型或关键词。" : "下载、导入、导出、同步计划等任务会在这里留下记录。"}</span>
            {tasks.length > 0 && <button className="btn ghost" onClick={() => { setFilter("all"); setKind("all"); setQuery(""); }}>清除筛选</button>}
          </div>
        ) : (
          <table className="table task-table">
            <colgroup><col className="task-state-track" /><col className="task-kind-track" /><col className="task-title-track" /><col className="task-chat-track" /><col className="task-time-track" /><col className="task-duration-track" /><col className="task-progress-track" /><col className="task-actions-track" /></colgroup>
            <thead>
              <tr>
                <th className="task-col-state">状态</th>
                <th className="task-col-kind">类型</th>
                <th>任务</th>
                <th>聊天</th>
                <th>开始时间</th>
                <th>耗时</th>
                <th>进度</th>
                <th className="task-col-actions">操作</th>
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
                      if (e.target !== e.currentTarget) return;
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        void openTask(t);
                      }
                    }}
                    title="点击查看任务详情"
                  >
                    <td className="task-col-state">
                      <span className={`task-state ${t.state}`}>
                        {t.state === "running" ? <Loader2 size={12} className="spin" /> : t.state === "done" ? <CheckCircle2 size={12} /> : t.state === "partial" ? <AlertTriangle size={12} /> : t.state === "paused" ? <Pause size={12} /> : t.state === "stopped" ? <Square size={12} /> : <XCircle size={12} />}
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
                      {(t.error || t.detail) && <span className={t.error && (t.state === "failed" || t.state === "partial") ? "err" : ""} title={t.error || t.detail}>{t.error || t.detail}</span>}
                    </td>
                    <td className="task-chat" title={t.chat || undefined}>{t.chat || "—"}</td>
                    <td className="muted task-started"><time>{dateTime(t.startedAt)}</time></td>
                    <td className="task-duration"><TaskElapsed state={t.state} elapsedMs={t.elapsedMs} startedAt={t.startedAt} finishedAt={t.finishedAt} /></td>
                    <td>
                      <div className="task-progress">
                        <div className="mini"><i className={t.state} style={{ width: `${t.state === "done" ? 100 : Math.max(t.state === "running" ? 1 : 0, Math.min(100, t.percent))}%` }} /></div>
                        <span>{t.state === "done" ? "100%" : `${t.percent}%`}</span>
                      </div>
                    </td>
                    <td className="task-col-actions">
                      <button
                        className="icon-btn danger"
                        title={t.state === "running" ? "进行中的任务不能删除记录" : "删除任务记录（不删除下载文件）"}
                        aria-label={`删除任务记录 ${t.title}`}
                        disabled={t.state === "running"}
                        onClick={(e) => { e.stopPropagation(); removeRecord(t); }}
                      >
                        <Trash2 size={13} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      </section>

      </div>}

      {modalTask && createPortal(
          <dialog
            ref={modalRef}
            className="task-modal task-info-modal"
            aria-modal="true"
            aria-labelledby="task-modal-title"
            onCancel={(event) => {
              event.preventDefault();
              selection.current++;
              setModalTask(null);
            }}
            onMouseDown={(event) => {
              if (event.target !== event.currentTarget) return;
              const rect = event.currentTarget.getBoundingClientRect();
              if (event.clientX < rect.left || event.clientX > rect.right ||
                  event.clientY < rect.top || event.clientY > rect.bottom) {
                selection.current++;
                setModalTask(null);
              }
            }}
          >
            <div className="task-modal-head task-info-head">
              <div className="task-info-heading">
                <div className="task-info-title-row">
                  <h2 id="task-modal-title">{modalHeading}</h2>
                  {modalMeta && (
                    <span className={`kind-chip group-${modalMeta.group}`}>
                      {ModalIcon && <ModalIcon size={11} />} {modalMeta.label}
                    </span>
                  )}
                </div>
                <div className="task-info-sub">
                  <span className={`task-state ${modalTask.state}`}>
                    {modalTask.state === "running" ? <Loader2 size={12} className="spin" /> : modalTask.state === "done" ? <CheckCircle2 size={12} /> : modalTask.state === "partial" ? <AlertTriangle size={12} /> : modalTask.state === "paused" ? <Pause size={12} /> : modalTask.state === "stopped" ? <Square size={12} /> : <XCircle size={12} />}
                    {statusLabel(modalTask.state)}
                  </span>
                  {modalChatLabel && <span className="mono">{modalChatLabel}</span>}
                  {modalTask.mode && <span className="task-info-mode">{modeLabel(modalTask.mode)}</span>}
                  {modalChat && modalChat !== modalHeading && <b>{modalChat}</b>}
                </div>
              </div>
              <button className="icon-btn" aria-label="关闭任务详情" onClick={() => { selection.current++; setModalTask(null); }}>
                <X size={15} />
              </button>
            </div>

            <div className={`task-info-progress-card ${modalTask.state}`}>
              <div className="task-info-percent">
                <b>{modalPercent}</b><em>%</em>
              </div>
              <div className="task-info-progress-main">
                <div className="task-info-detail">{modalTask.detail || statusLabel(modalTask.state)}</div>
                <div className="task-info-bar">
                  <i className={modalTask.state} style={{ width: `${modalTask.state === "running" ? Math.max(1, modalPercent) : modalPercent}%` }} />
                </div>
                <div className="task-info-times">
                  <span>开始 <b>{dateTime(modalTask.startedAt)}</b></span>
                  <span>结束 <b>{modalTask.finishedAt ? dateTime(modalTask.finishedAt) : modalTask.state === "running" ? "进行中" : "—"}</b></span>
                  <span>耗时 <b><TaskElapsed state={modalTask.state} elapsedMs={modalTask.elapsedMs} startedAt={modalTask.startedAt} finishedAt={modalTask.finishedAt} /></b></span>
                </div>
              </div>
            </div>

            {(modalCards.length > 0 || modalShowMedia) && (
              <div className="task-info-grid">
                {modalCards.map((card) => (
                  <div key={card.label} className={`task-info-card ${card.wide ? "wide" : ""}`}>
                    <span>{card.label}</span>
                    <b className={card.mono ? "mono" : ""}>{card.mono ? wrapPath(card.value) : card.value}</b>
                  </div>
                ))}
                {modalShowMedia && (
                  <div className="task-info-card wide task-media-card">
                    <span>媒体构成</span>
                    <div className="task-media-grid">
                      {modalMedia.map((part) => (
                        <div key={part.label}>
                          <em>{part.label}</em>
                          <b>{part.value.toLocaleString()}</b>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {modalShowError && (
              <div className="task-info-error" role="alert">
                <AlertTriangle size={14} />
                <span>{modalTask.error}</span>
              </div>
            )}

            <div className="modal-actions">
              <button className="btn ghost" onClick={() => { selection.current++; setModalTask(null); }}><X size={12} /> 关闭</button>
            </div>
          </dialog>,
        document.body
      )}

      <ConfirmDialog
        open={clearConfirm}
        title="删除全部任务记录？"
        message="将删除全部已完成、失败、暂停和已终止的任务记录，进行中的任务会保留。只删除记录，不会删除任何已下载文件或档案库内容。"
        confirmLabel="全部删除"
        danger
        onConfirm={clearAll}
        onCancel={() => setClearConfirm(false)}
      />
    </>
  );
}
