import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  CheckCircle2,
  ChevronRight,
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
  XCircle,
} from "lucide-react";
import { call } from "./rpc";
import { Select } from "./Select";
import type { TaskInfo } from "./types";

const KIND_META: Record<string, { label: string; group: string; icon: typeof Download }> = {
  sync: { label: "下载 / 同步", group: "download", icon: Download },
  "sync-all": { label: "批量同步", group: "download", icon: Download },
  "import-json": { label: "导入 JSON", group: "import", icon: FileJson },
  "import-official": { label: "官方导出", group: "import", icon: FolderInput },
  export: { label: "导出聊天", group: "export", icon: FolderInput },
  refresh: { label: "重建网页", group: "build", icon: RefreshCw },
  "refresh-all": { label: "重建全部", group: "build", icon: RefreshCw },
  merge: { label: "合并档案库", group: "merge", icon: GitMerge },
};

function kindMeta(kind: string) {
  return KIND_META[kind] ?? { label: kind, group: "other", icon: Activity };
}

function fmtTime(ts?: number): string {
  if (!ts) return "--";
  return new Date(ts).toLocaleString("zh-CN", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDuration(t: TaskInfo, now: number): string {
  const end = t.finishedAt || (t.state === "running" ? now : t.startedAt);
  const ms = Math.max(0, end - t.startedAt);
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分`;
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
        if (q && !`${t.title} ${t.chat ?? ""} ${t.detail ?? ""} ${t.error ?? ""}`.toLowerCase().includes(q)) return false;
        return true;
      }),
    [tasks, filter, kind, query]
  );
  const running = tasks.filter((t) => t.state === "running").length;
  const failed = tasks.filter((t) => t.state === "failed").length;
  const done = tasks.filter((t) => t.state === "done").length;

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
          <p>下载、导入、导出、合并与重建都在这里留档；进行中的任务会实时刷新</p>
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
        <div className="stat">
          <span>进行中</span>
          <div><b className={running > 0 ? "accent" : ""}>{running}</b><em>个</em></div>
        </div>
        <div className="stat">
          <span>已完成</span>
          <div><b>{done}</b><em>个</em></div>
        </div>
        <div className="stat">
          <span>失败</span>
          <div><b className={failed > 0 ? "warn" : ""}>{failed}</b><em>个</em></div>
        </div>
        <div className="stat">
          <span>全部任务</span>
          <div><b>{tasks.length}</b><em>条</em></div>
        </div>
      </section>

      <div className="task-toolbar">
        <div className="tabs-pill" role="group" aria-label="任务状态筛选">
          {STATUS_FILTERS.map(([key, label]) => (
            <button key={key} className={filter === key ? "on" : ""} onClick={() => setFilter(key)}>
              {label}
            </button>
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
          <input
            type="search"
            value={query}
            placeholder="搜索任务或聊天…"
            onChange={(e) => setQuery(e.target.value)}
            aria-label="搜索任务或聊天"
          />
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
                <th>状态</th>
                <th>类型</th>
                <th>任务</th>
                <th className="hide-sm">聊天</th>
                <th className="hide-sm">开始时间</th>
                <th>耗时</th>
                <th>进度</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((t) => {
                const meta = kindMeta(t.kind);
                const Icon = meta.icon;
                const openable = t.kind === "sync" && !!t.slug;
                return (
                  <tr
                    key={t.id}
                    className={`${t.state} ${openable ? "clickable" : ""}`}
                    onClick={() => openable && onOpenDownload(t)}
                    title={openable ? "点击查看下载详情" : undefined}
                  >
                    <td>
                      <span className={`task-state ${t.state}`}>
                        {t.state === "running" ? <Loader2 size={12} className="spin" /> : t.state === "done" ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                        {t.state === "running" ? "进行中" : t.state === "done" ? "完成" : "失败"}
                      </span>
                    </td>
                    <td>
                      <span className={`kind-chip group-${meta.group}`}><Icon size={11} /> {meta.label}</span>
                    </td>
                    <td className="task-main">
                      <span className="task-title-line">
                        <b title={t.title}>{t.title}</b>
                        {openable && <ChevronRight size={13} className="row-chev" />}
                      </span>
                      {(t.error || t.detail) && <span className={t.error ? "err" : ""} title={t.error || t.detail}>{t.error || t.detail}</span>}
                    </td>
                    <td className="hide-sm task-chat">{t.chat || "—"}</td>
                    <td className="hide-sm muted">{fmtTime(t.startedAt)}</td>
                    <td className="task-duration">
                      {t.state === "running" && <Clock size={11} />}
                      <span>{fmtDuration(t, now)}</span>
                    </td>
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
