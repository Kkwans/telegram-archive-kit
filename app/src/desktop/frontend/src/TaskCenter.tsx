import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  CheckCircle2,
  Clock,
  Download,
  FileJson,
  FolderInput,
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
import type { TaskInfo } from "./types";
import { dateTime } from "./format";

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

function fmtTime(ts?: number): string {
  return dateTime(ts);
}

function fmtDuration(t: TaskInfo, now: number): string {
  const end = t.finishedAt || (t.state === "running" ? now : t.startedAt);
  const ms = Math.max(0, end - t.startedAt);
  if (ms < 1000) return "<1 秒";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分`;
}

function statusLabel(state: string): string {
  return state === "running" ? "进行中" : state === "done" ? "完成" : "失败";
}

const STATUS_FILTERS = [
  ["all", "全部"],
  ["running", "进行中"],
  ["done", "已完成"],
  ["failed", "失败"],
] as const;

export function TasksPage({
  tasks,
  onRefresh,
  onClear,
  onOpenDownload,
  toast,
}: {
  tasks: TaskInfo[];
  onRefresh: () => void;
  onClear: () => void;
  onOpenDownload: (task: TaskInfo) => void;
  toast: (msg: string, err?: boolean) => void;
}) {
  const [filter, setFilter] = useState("all");
  const [kind, setKind] = useState("all");
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(Date.now());
  const [detail, setDetail] = useState<TaskInfo | null>(null);

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

  const openTask = (task: TaskInfo) => {
    if (task.kind === "sync" && task.slug) onOpenDownload(task);
    else setDetail(task);
  };

  const clear = () => {
    call("clearTasks")
      .then(() => {
        onClear();
        toast("已清除完成与失败的任务");
      })
      .catch((e: Error) => toast(e.message, true));
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>任务中心</h1>
          <p>点击任意任务查看详情；下载任务会打开完整的下载记录与速度曲线</p>
        </div>
        <div className="actions">
          <button className="btn toolbar-btn" onClick={onRefresh}>
            <RefreshCw size={13} /> 刷新状态
          </button>
          <button className="btn toolbar-btn" disabled={done + failed === 0} onClick={clear}>
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
                  <tr key={t.id} onClick={() => openTask(t)} title="点击查看任务详情">
                    <td className="task-col-state">
                      <span className={`task-state ${t.state}`}>
                        {t.state === "running" ? <Loader2 size={12} className="spin" /> : t.state === "done" ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                        {statusLabel(t.state)}
                      </span>
                    </td>
                    <td className="task-col-kind">
                      <span className={`kind-chip group-${meta.group}`}><Icon size={11} /> {meta.label}</span>
                    </td>
                    <td className="task-main"><b title={taskTitle(t)}>{taskTitle(t)}</b></td>
                    <td className="task-chat">{t.chat || "—"}</td>
                    <td className="muted">{fmtTime(t.startedAt)}</td>
                    <td className="task-duration">{fmtDuration(t, now)}</td>
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

      {detail && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setDetail(null); }}>
          <div className="modal task-modal" role="dialog" aria-modal="true" aria-labelledby="task-detail-title">
            <h2 id="task-detail-title">{taskTitle(detail)}</h2>
            <p className="modal-sub">{kindMeta(detail.kind).label} · {detail.chat || "无聊天"} · {statusLabel(detail.state)}</p>
            <div className="account-rows task-detail-rows">
              <div><span>开始时间</span><b>{fmtTime(detail.startedAt)}</b></div>
              <div><span>结束时间</span><b>{fmtTime(detail.finishedAt)}</b></div>
              <div><span>耗时</span><b>{fmtDuration(detail, Date.now())}</b></div>
              <div><span>进度</span><b>{detail.state === "done" ? "100%" : `${detail.percent}%`}</b></div>
              <div><span>任务说明</span><b>{detail.detail || "--"}</b></div>
              {detail.error && <div><span>错误</span><b className="danger-text">{detail.error}</b></div>}
            </div>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setDetail(null)}><X size={12} /> 关闭</button>
              {detail.kind === "sync" && detail.slug && (
                <button className="btn primary" onClick={() => { setDetail(null); onOpenDownload(detail); }}>
                  <Clock size={12} /> 打开下载详情
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
