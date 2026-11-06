import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  Activity,
  ArrowLeft,
  CheckCircle2,
  ChartPie,
  Download,
  FileJson,
  FolderInput,
  FolderOpen,
  GitMerge,
  ListTodo,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import { call } from "./rpc";
import { Select } from "./Select";
import type { TaskDetail, TaskInfo } from "./types";
import { bytes, dateTime, dateTimePrecise, duration, rate } from "./format";

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
  return state === "running" ? "进行中" : state === "done" ? "完成" : "失败";
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
  const span = task.finishedAt ? task.finishedAt - task.startedAt : Date.now() - task.startedAt;
  return Math.max(0, task.elapsedMs || span);
}

function noNewMedia(task: TaskInfo | TaskDetail): boolean {
  return kindMeta(task.kind).group === "download" && task.state !== "failed" && !task.total && !task.bytes;
}

const STATUS_FILTERS = [
  ["all", "全部"],
  ["running", "进行中"],
  ["done", "已完成"],
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

function TaskSpeedChart({ task }: { task: TaskDetail }) {
  const samples = task.series ?? [];
  if (samples.length < 2) {
    return <div className="chart-empty">这个任务没有保留速度采样。</div>;
  }
  const W = 960, H = 190, L = 64, R = 18, T = 14, B = 30;
  const plotW = W - L - R;
  const plotH = H - T - B;
  const max = Math.max(1, ...samples.flatMap((s) => [s.now, s.avg]));
  const points = (key: "now" | "avg") =>
    samples
      .map((s, i) => {
        const x = L + (i / (samples.length - 1)) * plotW;
        const y = T + plotH - Math.min(1, s[key] / max) * plotH;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  const first = samples[0].at || task.startedAt;
  const last = samples[samples.length - 1].at || task.finishedAt || Date.now();
  const span = Math.max(1, last - first);
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({
    x: L + f * plotW,
    label: clockText(first + span * f),
    anchor: (f === 0 ? "start" : f === 1 ? "end" : "middle") as "start" | "middle" | "end",
  }));
  return (
    <div className="chart chart-axes task-chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-label="历史下载速度曲线">
        {[0, 0.25, 0.5, 0.75, 1].map((f) => {
          const y = T + plotH - f * plotH;
          return (
            <g key={f}>
              <line className="grid" x1={L} y1={y} x2={W - R} y2={y} />
              <text className="axis-y" x={L - 9} y={y + 3} textAnchor="end">{rate(max * f)}</text>
            </g>
          );
        })}
        {xTicks.map((tick) => (
          <text key={tick.x} className="axis-x" x={tick.x} y={H - 8} textAnchor={tick.anchor}>{tick.label}</text>
        ))}
        <polyline className="avg" points={points("avg")} />
        <polyline className="now" points={points("now")} />
      </svg>
    </div>
  );
}

export function TaskDetailView({ task, onBack, toast }: { task: TaskDetail; onBack: () => void; toast: (msg: string, err?: boolean) => void }) {
  const meta = kindMeta(task.kind);
  const running = task.state === "running";
  const failed = task.state === "failed";
  const noop = noNewMedia(task);
  const elapsed = taskElapsed(task);
  const percent = task.state === "done" ? 100 : Math.max(0, Math.min(100, task.percent));
  const series = task.series ?? [];
  const active = task.active ?? [];
  const completed = task.completed ?? [];
  const speedNow = series.length > 0 ? series[series.length - 1].now : 0;
  const result = task.error || (noop
    ? "同步完成，本次没有产生媒体下载"
    : task.detail || (task.state === "done" ? "任务完成" : task.state === "running" ? "任务进行中" : "任务失败"));
  const ringStyle = running
    ? { background: `conic-gradient(var(--accent) ${percent}%, var(--surface-3) ${percent}% 100%)` }
    : undefined;

  return (
    <>
      <div className="page-head download-detail-head">
        <button className="btn" onClick={onBack}>
          <ArrowLeft size={14} /> 返回任务中心
        </button>
        <div className="actions">
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

      <section className={`hero ${running ? "" : "idle"} ${failed ? "failed" : ""}`}>
        <div
          className={`ring ${running ? "" : "idle"}`}
          role="progressbar"
          aria-valuenow={Math.round(percent)}
          aria-valuemin={0}
          aria-valuemax={100}
          style={ringStyle}
        >
          {running ? <b>{Math.round(percent)}%</b> : failed ? <X size={22} /> : <CheckCircle2 size={24} />}
        </div>
        <div className="hero-main">
          <div className="hero-title">
            {taskTitle(task)}{task.chat ? ` · ${task.chat}` : ""}
            <span className={`tag ${failed ? "bad" : ""}`}>{statusLabel(task.state)}</span>
          </div>
          <div className="hero-stage" title={result}>{result}</div>
          <div className="hero-meta">
            <span>速度 <b>{rate(speedNow)}</b></span>
            <span>平均 <b>{rate(task.avgSpeed ?? 0)}</b></span>
            <span>已下载 <b>{bytes(task.bytes ?? 0)}</b></span>
            <span>完成媒体 <b>{task.done ?? 0} / {task.total ?? 0}</b></span>
            <span>耗时 <b>{fmtDuration(elapsed)}</b></span>
          </div>
        </div>
      </section>

      <section className="stat-grid">
        <div className="stat"><span>实时速度</span><div><b>{rate(speedNow)}</b></div></div>
        <div className="stat"><span>平均速度</span><div><b>{rate(task.avgSpeed ?? 0)}</b></div></div>
        <div className="stat"><span>预计剩余</span><div><b>{running && (task.etaMs ?? 0) > 0 ? duration(task.etaMs ?? 0) : "--"}</b></div></div>
        <div className="stat"><span>本轮完成</span><div><b>{task.done ?? 0}</b><em>/ {task.total ?? 0}</em></div></div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3><ChartPie size={14} /> 速度曲线</h3>
          <span className="chart-legend"><i className="now" /> 实时 <i className="avg" /> 平均</span>
        </div>
        <TaskSpeedChart task={task} />
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>正在下载</h3>
          <span className="meta">{active.length} 个文件</span>
        </div>
        {active.length > 0 ? (
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
              {active.map((file) => (
                <tr key={file.id}>
                  <td className="name" title={file.name}>{file.name}</td>
                  <td className="hide-sm"><span className={`kind-chip ${file.kind}`}>{fileKindLabel(file.kind)}</span></td>
                  <td>
                    <div className="progress-inline">
                      <div className="mini"><i style={{ width: `${Math.max(0, Math.min(100, file.percent))}%` }} /></div>
                      <span className={file.stalled ? "stalled" : ""}>{file.stalled ? "停滞" : file.percent >= 0 ? `${file.percent.toFixed(0)}%` : "—"}</span>
                    </div>
                  </td>
                  <td>{bytes(file.transferred)}{file.expected > 0 ? ` / ${bytes(file.expected)}` : ""}</td>
                  <td>{rate(file.speed)}</td>
                  <td className="hide-sm">{file.etaMs > 0 ? fmtDuration(file.etaMs) : "--"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="chart-empty">{running ? "当前没有正在下载的文件。" : "任务已结束，没有正在下载的文件。"}</div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>最近完成</h3>
          <span className="meta">{completed.length} 个</span>
        </div>
        {completed.length > 0 ? (
          <div className="done-list">
            {completed.map((file, index) => (
              <div className="done-row" key={`${file.id}-${index}`}>
                <CheckCircle2 size={14} color="var(--ok)" />
                <span className={`kind-chip ${file.kind}`}>{fileKindLabel(file.kind)}</span>
                <span className="nm" title={file.name}>{file.name}</span>
                <span className="tm">{bytes(file.expected || file.transferred)}</span>
                <span className="tm">{fmtDuration(file.elapsedMs)}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="chart-empty">这个任务没有完成记录。</div>
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
    </>
  );
}

export function TasksPage({
  tasks,
  onRefresh,
  onClear,
  toast,
}: {
  tasks: TaskInfo[];
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

  const openTask = async (task: TaskInfo) => {
    const download = kindMeta(task.kind).group === "download";
    try {
      const detail = await call<TaskDetail>("taskDetail", { id: task.id });
      if (download) setActive(detail);
      else setModalTask(detail);
    } catch (e) {
      if (download) setActive({ ...task, series: [] });
      else setModalTask({ ...task, series: [] });
      toast((e as Error).message, true);
    }
  };

  const clear = () => {
    call("clearTasks")
      .then(() => {
        onClear();
        toast("已清除完成与失败的任务");
      })
      .catch((e: Error) => toast(e.message, true));
  };

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
    return <TaskDetailView task={active} onBack={() => setActive(null)} toast={toast} />;
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
                        {t.state === "running" ? <Loader2 size={12} className="spin" /> : t.state === "done" ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
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
