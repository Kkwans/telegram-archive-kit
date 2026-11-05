import { useMemo, useState } from "react";
import { Activity, CheckCircle2, Clock, Loader2, RefreshCw, Trash2, XCircle } from "lucide-react";
import { call } from "./rpc";
import { Select } from "./Select";
import type { TaskInfo } from "./types";

const KIND_LABEL: Record<string, string> = {
  "import-json": "导入 JSON",
  "import-official": "官方导出",
  export: "导出聊天",
  refresh: "重建网页",
  "refresh-all": "重建全部",
  merge: "合并档案库",
  "sync-all": "同步缺失",
};

function fmtTime(ts?: number): string {
  if (!ts) return "--";
  return new Date(ts).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function fmtDuration(t: TaskInfo): string {
  const end = t.finishedAt || (t.state === "running" ? Date.now() : t.startedAt);
  const ms = Math.max(0, end - t.startedAt);
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  return `${m} 分 ${s % 60} 秒`;
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

  const visible = useMemo(
    () =>
      tasks.filter((t) => {
        if (filter === "running" && t.state !== "running") return false;
        if (filter === "done" && t.state !== "done") return false;
        if (filter === "failed" && t.state !== "failed") return false;
        if (kind !== "all" && t.kind !== kind) return false;
        return true;
      }),
    [tasks, filter, kind]
  );
  const running = tasks.filter((t) => t.state === "running").length;
  const failed = tasks.filter((t) => t.state === "failed").length;
  const done = tasks.filter((t) => t.state === "done").length;

  const clear = () => {
    call("clearTasks")
      .then(() => {
        onClear();
        toast("已清除完成的任务");
      })
      .catch((e: Error) => toast(e.message, true));
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>任务中心</h1>
          <p>导入、导出、合并、重建与批量同步都在这里留档；进行中的任务会自动刷新</p>
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
          <b className={running > 0 ? "accent" : ""}>{running}</b>
        </div>
        <div className="stat">
          <span>已完成</span>
          <b>{done}</b>
        </div>
        <div className="stat">
          <span>失败</span>
          <b className={failed > 0 ? "warn" : ""}>{failed}</b>
        </div>
        <div className="stat">
          <span>全部任务</span>
          <b>{tasks.length}</b>
        </div>
      </section>

      <div className="task-toolbar">
        <div className="tabs-pill" role="group" aria-label="任务状态筛选">
          {[
            ["all", "全部"],
            ["running", "进行中"],
            ["done", "已完成"],
            ["failed", "失败"],
          ].map(([key, label]) => (
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
            options={[{ value: "all", label: "全部类型" }, ...Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label }))]}
          />
        </div>
        <span className="spacer" />
        <span className="muted">{visible.length} 条</span>
      </div>

      <section className="panel">
        {visible.length === 0 ? (
          <div className="task-empty large">
            <Activity size={30} />
            <p>没有符合条件的任务</p>
            <span>导入 result.json、导出聊天、重建网页或合并档案库后会出现在这里。</span>
          </div>
        ) : (
          <table className="table task-table">
            <thead>
              <tr>
                <th>状态</th>
                <th>类型</th>
                <th>任务</th>
                <th>详情 / 聊天</th>
                <th>开始时间</th>
                <th className="num">耗时</th>
                <th>进度</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((t) => (
                <tr key={t.id} className={t.state}>
                  <td>
                    <span className={`task-state ${t.state}`}>
                      {t.state === "running" ? <Loader2 size={12} className="spin" /> : t.state === "done" ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                      {t.state === "running" ? "进行中" : t.state === "done" ? "完成" : "失败"}
                    </span>
                  </td>
                  <td>
                    <span className="kind">{KIND_LABEL[t.kind] ?? t.kind}</span>
                  </td>
                  <td className="task-title" title={t.title}>
                    {t.title}
                  </td>
                  <td className="task-detail" title={t.error || t.detail}>
                    {t.error || [t.chat, t.detail].filter(Boolean).join(" · ") || "--"}
                  </td>
                  <td className="muted">{fmtTime(t.startedAt)}</td>
                  <td className="num muted">
                    {t.state === "running" ? <Clock size={12} /> : null} {fmtDuration(t)}
                  </td>
                  <td>
                    <div className="task-progress">
                      <div className="mini">
                        <i style={{ width: `${Math.max(1, Math.min(100, t.percent))}%` }} />
                      </div>
                      <span>{t.percent}%</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
