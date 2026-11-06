import { useEffect, useMemo, useState } from "react";
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
  XCircle,
} from "lucide-react";
import { call } from "./rpc";
import { Select } from "./Select";
import type { TaskDetail, TaskInfo } from "./types";
import { bytes, dateTime, dateTimePrecise, rate } from "./format";

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

function ResultRing({ state }: { state: string }) {
  const r = 27;
  const c = 2 * Math.PI * r;
  return (
    <div className={`result-ring ${state}`}>
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <circle className="result-ring-track" cx="32" cy="32" r={r} />
        <circle
          className="result-ring-fill"
          cx="32"
          cy="32"
          r={r}
          strokeDasharray={c}
          strokeDashoffset={state === "running" ? c * 0.38 : 0}
          transform="rotate(-90 32 32)"
        />
      </svg>
      <span className="result-ring-icon">
        {state === "running" ? <Loader2 size={20} className="spin" /> : state === "done" ? <CheckCircle2 size={20} /> : <XCircle size={20} />}
      </span>
    </div>
  );
}

function TaskSpeedChart({ task }: { task: TaskDetail }) {
  const samples = task.series ?? [];
  if (samples.length < 2) {
    return <div className="task-chart-empty">旧任务未记录速度采样；新任务的下载过程会自动保留曲线。</div>;
  }
  const W = 960, H = 190, L = 64, R = 18, T = 14, B = 26;
  const plotW = W - L - R;
  const plotH = H - T - B;
  const max = Math.max(1, ...samples.flatMap((s) => [s.now, s.avg]));
  const points = (key: "now" | "avg") =>
    samples
      .map((s, i) => {
        const x = L + (samples.length <= 1 ? 0 : (i / (samples.length - 1)) * plotW);
        const y = T + plotH - Math.min(1, s[key] / max) * plotH;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  return (
    <div className="chart chart-axes task-chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-label="历史下载速度曲线">
        {[0, 0.25, 0.5, 0.75, 1].map((f) => {
          const y = T + plotH - f * plotH;
          return (
            <g key={f}>
              <line className="grid" x1={L} y1={y} x2={W - R} y2={y} />
              <text className="axis-y" x={L - 8} y={y + 3} textAnchor="end">{rate(max * f)}</text>
            </g>
          );
        })}
        <text className="axis-x" x={L} y={H - 7}>开始</text>
        <text className="axis-x" x={W - R} y={H - 7} textAnchor="end">结束</text>
        <polyline className="avg" points={points("avg")} />
        <polyline className="now" points={points("now")} />
      </svg>
    </div>
  );
}

function TaskDetailView({ task, onBack, toast }: { task: TaskDetail; onBack: () => void; toast: (msg: string, err?: boolean) => void }) {
  const meta = kindMeta(task.kind);
  const download = meta.group === "download";
  const noop = noNewMedia(task);
  const elapsed = taskElapsed(task);
  const result = task.error || (noop
    ? "同步完成，本次没有产生媒体下载"
    : task.detail || (task.state === "done" ? "任务完成" : task.state === "running" ? "任务进行中" : "任务失败"));

  return (
    <>
      <div className="page-head task-detail-head">
        <div className="task-detail-title">
          <button className="btn" onClick={onBack}>
            <ArrowLeft size={14} /> 返回
          </button>
          <div>
            <h1>任务详情</h1>
            <p>{meta.label}{task.chat ? ` · ${task.chat}` : ""}</p>
          </div>
        </div>
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

      <section className={`task-result-panel ${task.state}`}>
        <ResultRing state={task.state} />
        <div className="task-result-main">
          <div className="task-result-title">
            <h2>{taskTitle(task)}{task.chat ? ` · ${task.chat}` : ""}</h2>
            <span className={`tag ${task.state === "failed" ? "bad" : ""}`}>{statusLabel(task.state)}</span>
          </div>
          <p className="task-result-text">{result}</p>
          <div className="task-result-meta">
            <span>开始 <b>{dateTimePrecise(task.startedAt)}</b></span>
            <span>{task.finishedAt ? "结束" : "已运行"} <b>{task.finishedAt ? dateTimePrecise(task.finishedAt) : fmtDuration(elapsed)}</b></span>
            <span>耗时 <b>{fmtDuration(elapsed)}</b></span>
          </div>
        </div>
      </section>

      {download && !noop && (
        <section className="stat-grid">
          <div className="stat"><span>平均速度</span><div><b>{rate(task.avgSpeed ?? 0)}</b></div></div>
          <div className="stat"><span>峰值速度</span><div><b>{rate(task.peakSpeed ?? 0)}</b></div></div>
          <div className="stat"><span>下载总量</span><div><b>{bytes(task.bytes ?? 0)}</b></div></div>
          <div className="stat"><span>完成媒体</span><div><b>{task.done ?? 0}</b><em>/ {task.total ?? 0}</em></div></div>
        </section>
      )}

      {download && !noop && (
        <section className="panel">
          <div className="panel-head">
            <h3><ChartPie size={14} /> 历史速度曲线</h3>
            <span className="chart-legend"><i className="now" /> 实时 <i className="avg" /> 平均</span>
          </div>
          <TaskSpeedChart task={task} />
        </section>
      )}

      <section className="panel">
        <div className="panel-head">
          <h3>任务信息</h3>
          <span className="meta">任务 {task.id}</span>
        </div>
        <div className="account-rows task-detail-rows">
          <div><span>类型</span><b>{meta.label}</b></div>
          <div><span>聊天</span><b>{task.chat || "--"}</b></div>
          <div><span>开始时间</span><b>{dateTimePrecise(task.startedAt)}</b></div>
          <div><span>结束时间</span><b>{task.finishedAt ? dateTimePrecise(task.finishedAt) : "进行中"}</b></div>
          <div><span>耗时</span><b>{fmtDuration(elapsed)}</b></div>
          <div><span>结果</span><b>{result}</b></div>
          {task.error && <div><span>错误</span><b className="danger-text">{task.error}</b></div>}
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
    try {
      setActive(await call<TaskDetail>("taskDetail", { id: task.id }));
    } catch (e) {
      setActive({ ...task, series: [] });
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

  if (active) {
    return <TaskDetailView task={active} onBack={() => setActive(null)} toast={toast} />;
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>任务中心</h1>
          <p>点击任意任务查看完整记录；下载任务保留速度曲线与逐项统计</p>
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
                  <tr key={t.id} onClick={() => void openTask(t)} title="点击查看任务详情">
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
                        <b title={taskTitle(t)}>{taskTitle(t)}</b>
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
    </>
  );
}
