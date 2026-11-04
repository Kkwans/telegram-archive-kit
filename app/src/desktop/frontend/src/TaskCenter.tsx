import { Activity, CheckCircle2, Loader2, Trash2, X, XCircle } from "lucide-react";
import type { TaskInfo } from "./types";

function taskTime(ts?: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

export function TaskCenter({
  tasks,
  onClose,
  onClear,
}: {
  tasks: TaskInfo[];
  onClose: () => void;
  onClear: () => void;
}) {
  const running = tasks.filter((t) => t.state === "running");
  const finished = tasks.filter((t) => t.state !== "running");
  return (
    <div className="drawer-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="task-drawer" role="dialog" aria-modal="true" aria-label="任务中心">
        <header className="task-head">
          <Activity size={15} />
          <h2>任务中心</h2>
          {running.length > 0 && <span className="task-running-tag">{running.length} 个进行中</span>}
          <span className="spacer" />
          <button className="wbtn-inline" aria-label="关闭任务中心" onClick={onClose}>
            <X size={14} />
          </button>
        </header>

        <div className="task-body">
          {tasks.length === 0 && (
            <div className="task-empty">
              <Activity size={26} />
              <p>还没有后台任务。</p>
              <span>导入、导出、合并与重建网页会出现在这里。</span>
            </div>
          )}

          {running.length > 0 && (
            <section className="task-group">
              <h3>进行中</h3>
              {running.map((t) => (
                <div key={t.id} className="task-row running">
                  <Loader2 size={15} className="spin" />
                  <div className="task-info">
                    <b>{t.title}</b>
                    <span>{t.detail || "正在处理…"}</span>
                    <div className="task-bar">
                      <i style={{ width: `${Math.max(2, Math.min(100, t.percent))}%` }} />
                    </div>
                  </div>
                  <span className="task-pct">{t.percent}%</span>
                </div>
              ))}
            </section>
          )}

          {finished.length > 0 && (
            <section className="task-group">
              <h3>最近完成</h3>
              {finished.map((t) => (
                <div key={t.id} className={`task-row ${t.state}`}>
                  {t.state === "done" ? <CheckCircle2 size={15} color="var(--ok)" /> : <XCircle size={15} color="var(--danger)" />}
                  <div className="task-info">
                    <b>{t.title}</b>
                    <span title={t.error || t.detail}>
                      {t.state === "failed" ? t.error || "失败" : t.detail || "已完成"}
                    </span>
                  </div>
                  <span className="task-time">{taskTime(t.finishedAt || t.startedAt)}</span>
                </div>
              ))}
            </section>
          )}
        </div>

        <footer className="task-foot">
          <span>最多保留最近 50 条</span>
          <span className="spacer" />
          <button className="btn sm ghost" disabled={finished.length === 0} onClick={onClear}>
            <Trash2 size={12} /> 清除已完成
          </button>
        </footer>
      </aside>
    </div>
  );
}
