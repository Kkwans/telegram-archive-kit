import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  CheckCircle2,
  FolderOpen,
  HardDrive,
  MessageSquare,
  Minus,
  Moon,
  Play,
  RefreshCw,
  Square,
  Sun,
  X,
} from "lucide-react";
import { call } from "./rpc";
import type { Bootstrap, ChatRow, DesktopState, DoneState, DownloadState, OperationState } from "./types";
import { bytes, clock, duration, rate } from "./format";

type Theme = "light" | "dark";

function initialTheme(): Theme {
  const saved = localStorage.getItem("tak-theme");
  return saved === "dark" ? "dark" : "light";
}

export default function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [chats, setChats] = useState<ChatRow[]>([]);
  const [selected, setSelected] = useState("");
  const [dl, setDl] = useState<DownloadState | null>(null);
  const [op, setOp] = useState<OperationState | null>(null);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState<DoneState | null>(null);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<{ now: number; avg: number }[]>([]);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const lastSample = useRef(0);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("tak-theme", theme);
  }, [theme]);

  useEffect(() => {
    call<Bootstrap>("bootstrap").then(setBoot).catch((e: Error) => setError(e.message));
    let alive = true;
    const tick = async () => {
      try {
        const st = await call<DesktopState>("state");
        if (!alive) return;
        setChats(st.chats ?? []);
        setSelected((prev) => prev || st.chats?.find((c) => c.current)?.slug || st.chats?.[0]?.slug || "");
        setDl(st.download ?? null);
        setOp(st.operation ?? null);
        setDone(st.done ?? null);
        setRunning(st.running);
        if (st.download) {
          const now = Date.now();
          if (now - lastSample.current > 900) {
            lastSample.current = now;
            const d = st.download;
            setHistory((h) => [...h, { now: d.speedNow, avg: d.speedAvg }].slice(-180));
          }
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    tick();
    const id = window.setInterval(tick, 600);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  const current = chats.find((c) => c.slug === selected) || null;
  const percent = useMemo(() => {
    if (dl) return Math.max(0, Math.min(100, dl.percent));
    if (op && op.total > 0) return Math.max(0, Math.min(100, (op.current * 100) / op.total));
    return 0;
  }, [dl, op]);

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

  const start = async () => {
    if (!selected || running) return;
    setError("");
    setDone(null);
    setDl(null);
    setOp(null);
    setHistory([]);
    setRunning(true);
    try {
      await call("startOneClick", { slug: selected });
    } catch (e) {
      setRunning(false);
      setError((e as Error).message);
    }
  };

  const cancel = async () => {
    try {
      await call("cancel");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="app">
      <header className="titlebar">
        <div className="brand">
          <span className="brand-mark">
            <svg viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m21 3-9.4 18-1.7-7.1L3 12.2z" />
            </svg>
          </span>
          <span className="brand-name">Telegram Archive Kit</span>
          <span className="brand-ver">{boot?.version ?? "1.2"}</span>
        </div>
        {boot && (
          <span className="libchip" title={boot.libraryRoot}>
            <FolderOpen size={12} />
            <b>{boot.libraryRoot || "未配置档案库"}</b>
          </span>
        )}
        <span className="spacer" />
        <span className="pill" title={boot?.tdl || "未安装 tdl"}>
          <i className={`dot ${boot?.tdl ? (boot.tdlRunning ? "warn" : "") : "off"}`} />
          {boot?.tdl ? (boot.tdlRunning ? "tdl 运行中" : "tdl 已连接") : "tdl 未安装"}
        </span>
        <span className="pill" title={boot?.hasSession ? "已发现本地 tdl 会话" : "尚未登录 Telegram"}>
          <i className={`dot ${boot?.hasSession ? "" : "off"}`} />
          {boot?.hasSession ? "已登录" : "未登录"}
        </span>
        <div className="seg" role="group" aria-label="外观">
          <button className={theme === "light" ? "on" : ""} onClick={() => setTheme("light")} title="浅色">
            <Sun size={13} />
          </button>
          <button className={theme === "dark" ? "on" : ""} onClick={() => setTheme("dark")} title="深色">
            <Moon size={13} />
          </button>
        </div>
        <button className="wbtn" title="最小化" onClick={() => call("windowMinimize")}>
          <Minus size={11} />
        </button>
        <button className="wbtn" title="最大化" onClick={() => call("windowToggleMaximize")}>
          <Square size={10} />
        </button>
        <button className="wbtn close" title="关闭" onClick={() => call("windowClose")}>
          <X size={11} />
        </button>
      </header>

      <div className="body">
        <aside className="side">
          <div className="side-head">
            <h2>聊天</h2>
            <span className="side-count">{chats.length} 个</span>
          </div>
          <div className="chat-list">
            {chats.length === 0 && (
              <div className="side-empty">
                还没有聊天。
                <br />
                请在「终端版」导入 result.json，或等待下一阶段的内置导入向导。
              </div>
            )}
            {chats.map((c) => (
              <button
                key={c.slug}
                className={`chat-item ${c.slug === selected ? "on" : ""}`}
                onClick={() => setSelected(c.slug)}
                title={`${c.name} · ${c.dir}`}
              >
                <span className="avatar">{c.name.slice(0, 1)}</span>
                <span>
                  <span className="chat-name">{c.name}</span>
                  <span className="chat-meta">
                    <span>{c.messages.toLocaleString()} 条</span>
                    <span>{c.media.toLocaleString()} 媒体</span>
                    {c.missing > 0 && <span className="warn">缺失 {c.missing}</span>}
                  </span>
                </span>
              </button>
            ))}
          </div>
          <div className="side-foot">
            <div className="row">
              <MessageSquare size={12} />
              {current ? `${current.pages} 页 · ${current.official} 个官方导出` : "未选择聊天"}
            </div>
            <div className="row">
              <HardDrive size={12} />
              {boot?.ffmpeg ? "FFmpeg 已就绪" : "FFmpeg 未安装"}
            </div>
          </div>
        </aside>

        <main className="main">
          {chats.length === 0 ? (
            <div className="empty">
              <div className="empty-inner">
                <h2>还没有可管理的聊天</h2>
                <p>
                  先用终端版导入 result.json（双击 <code>TelegramArchiveKit-Console.exe</code>），再回到这里。
                  <br />
                  配置文件：{boot?.configPath ?? "--"}
                </p>
              </div>
            </div>
          ) : (
            <div className="scroll">
              <div className="page-head">
                <div>
                  <h1>{current?.name ?? "概览"}</h1>
                  <p>
                    {current
                      ? `${current.messages.toLocaleString()} 条消息 · ${current.media.toLocaleString()} 个媒体 · ${
                          current.missing > 0 ? `缺失 ${current.missing}` : "完整"
                        }`
                      : ""}
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
                    {running ? (dl?.state ?? "同步中") : "同步与构建"}
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
            </div>
          )}
        </main>
      </div>

      <footer className="footer">
        <span>
          <i className={`dot ${boot?.tdl ? "" : "off"}`} />
          {boot?.tdl ? "tdl 已就绪" : "tdl 未安装"}
        </span>
        <span>{boot?.hasSession ? "会话已保存" : "未登录 Telegram"}</span>
        <span className="spacer" />
        <span>Telegram Archive Kit {boot?.version ?? "1.2"} · 桌面客户端</span>
      </footer>

      {error && (
        <div className="toast err" role="alert" onClick={() => setError("")} title="点击关闭">
          {error}
        </div>
      )}
      {done && !done.ok && !error && (
        <div className="toast err" role="alert" onClick={() => setDone(null)} title="点击关闭">
          同步失败：{done.error || done.stage}
        </div>
      )}
      {done && done.ok && !running && !error && (
        <div className="toast" onClick={() => setDone(null)} title="点击关闭">
          已完成 · {done.messages?.toLocaleString()} 条消息 · {done.media?.toLocaleString()} 个媒体
          {done.missing ? ` · 缺失 ${done.missing}` : ""}
        </div>
      )}
    </div>
  );
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "image":
      return "图片";
    case "video":
      return "视频";
    case "audio":
      return "音频";
    default:
      return "文件";
  }
}

function polyPoints(values: number[]): string {
  if (values.length === 0) return "";
  const max = Math.max(...values, 1);
  const step = 600 / Math.max(1, values.length - 1);
  return values
    .map((v, i) => {
      const x = i * step;
      const y = 70 - Math.min(1, v / max) * 62;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}
