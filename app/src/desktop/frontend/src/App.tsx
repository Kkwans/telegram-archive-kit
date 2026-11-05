import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  Database,
  FileJson,
  FolderInput,
  FolderOpen,
  House,
  Settings2,
  ListTodo,
  Minus,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  Square,
  Stethoscope,
  Sun,
  UserRound,
  X,
} from "lucide-react";
import { call } from "./rpc";
import type { Bootstrap, ChatRow, DesktopState, DoneState, DownloadState, LoginState, OperationState, PendingInput, TaskInfo, ViewerPrefs } from "./types";
import { Account, Chats, Diagnostics, Home, Library, Overview, SettingsPage, type PageCtx } from "./pages";
import { TasksPage } from "./TaskCenter";
import { Select } from "./Select";

type Theme = "light" | "dark";
const initialTheme = (): Theme => (localStorage.getItem("tak-theme") === "dark" ? "dark" : "light");

const NAV = [
  { key: "home", label: "首页", desc: "档案总览与快速同步", icon: House },
  { key: "tasks", label: "任务中心", desc: "下载、导入与重建记录", icon: ListTodo },
  { key: "library", label: "档案管理", desc: "导入、批量管理与库切换", icon: Database },
  { key: "account", label: "账号管理", desc: "登录、资料与授权状态", icon: UserRound },
  { key: "diagnostics", label: "诊断工具", desc: "环境检查与日志浏览", icon: Stethoscope },
  { key: "settings", label: "设置", desc: "下载、网络与播放器参数", icon: Settings },
];

const initialSideWidth = () => {
  const saved = Number(localStorage.getItem("tak-side-width") || 0);
  return saved >= 190 && saved <= 340 ? saved : 236;
};
const initialCollapsed = () => localStorage.getItem("tak-side-collapsed") === "1";

interface SideTip {
  top: number;
  title: string;
  desc?: string;
  lines?: string[];
  warn?: string;
}

export default function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [chats, setChats] = useState<ChatRow[]>([]);
  const [selected, setSelected] = useState("");
  const [page, setPage] = useState("home");
  const [dl, setDl] = useState<DownloadState | null>(null);
  const [op, setOp] = useState<OperationState | null>(null);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState<DoneState | null>(null);
  const [login, setLogin] = useState<LoginState | null>(null);
  const [history, setHistory] = useState<{ now: number; avg: number }[]>([]);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [toastMsg, setToastMsg] = useState<{ text: string; err: boolean } | null>(null);
  const [pending, setPending] = useState<PendingInput | null>(null);
  const [dropMode, setDropMode] = useState("copy");
  const [dropBusy, setDropBusy] = useState(false);
  const [palette, setPalette] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteActive, setPaletteActive] = useState(0);
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [prefs, setPrefs] = useState<ViewerPrefs>({ seekSeconds: 5, longPressRate: 4, maxVolume: 200, speedWindowSeconds: 180 });
  const [taskFocus, setTaskFocus] = useState<string | null>(null);
  const [sideWidth, setSideWidth] = useState(initialSideWidth);
  const [sideCollapsed, setSideCollapsed] = useState(initialCollapsed);
  const [sideTip, setSideTip] = useState<SideTip | null>(null);
  const lastSample = useRef(0);
  const toastTimer = useRef(0);
  const lastNotice = useRef(0);
  const lastPending = useRef(0);
  const lastDialog = useRef(0);
  const seenTasks = useRef(new Map<string, string>());
  const tasksReady = useRef(false);
  const pickerWaiters = useRef(new Map<string, { resolve: (paths: string[]) => void; reject: (e: Error) => void }>());

  const toast = (text: string, err = false) => {
    setToastMsg({ text, err });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastMsg(null), 3000);
  };

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("tak-theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("tak-side-width", String(sideWidth));
  }, [sideWidth]);
  useEffect(() => {
    if (palette || pending) setSideTip(null);
  }, [palette, pending]);
  useEffect(() => {
    localStorage.setItem("tak-side-collapsed", sideCollapsed ? "1" : "0");
    setSideTip(null);
  }, [sideCollapsed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((v) => !v);
        setPaletteQuery("");
        setPaletteActive(0);
      } else if (e.key === "Escape" && palette) {
        setPalette(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [palette]);

  const consume = (st: DesktopState) => {
    setChats(st.chats ?? []);
    setSelected((prev) => prev || st.chats?.find((c) => c.current)?.slug || st.chats?.[0]?.slug || "");
    setDl(st.download ?? null);
    setOp(st.operation ?? null);
    setDone(st.done ?? null);
    setLogin(st.login ?? null);
    setTasks(st.tasks ?? []);
    setRunning(st.running);
    if (st.notice && st.notice.seq !== lastNotice.current) {
      lastNotice.current = st.notice.seq;
      if (st.notice.text) toast(st.notice.text, true);
      call("ackNotice", { seq: st.notice.seq }).catch(() => undefined);
    }
    if (st.pending && st.pending.seq !== lastPending.current) {
      lastPending.current = st.pending.seq;
      setPending(st.pending);
    }
    if (st.dialog && st.dialog.seq !== lastDialog.current) {
      lastDialog.current = st.dialog.seq;
      const waiter = pickerWaiters.current.get(st.dialog.purpose);
      if (waiter) {
        pickerWaiters.current.delete(st.dialog.purpose);
        if (st.dialog.error) waiter.reject(new Error(st.dialog.error));
        else waiter.resolve(st.dialog.paths ?? []);
      }
      call("ackDialog", { seq: st.dialog.seq }).catch(() => undefined);
    }
  };

  const requestPick = (method: string, purpose: string, title: string) =>
    new Promise<string[]>((resolve, reject) => {
      pickerWaiters.current.set(purpose, { resolve, reject });
      call(method, { purpose, title }).catch((e: Error) => {
        pickerWaiters.current.delete(purpose);
        reject(e);
      });
    });
  const pickFiles = (purpose: string) => requestPick("pickJSON", purpose, "");
  const pickFolder = (purpose: string, title: string) =>
    requestPick("pickFolder", purpose, title).then((paths) => paths[0] ?? "");

  const refresh = () => {
    call<DesktopState>("state")
      .then(consume)
      .catch(() => undefined);
    call<Bootstrap>("bootstrap").then(setBoot).catch(() => undefined);
  };

  useEffect(() => {
    call<Bootstrap>("bootstrap").then(setBoot).catch((e: Error) => toast(e.message, true));
    call<{ videoSeekSeconds: number; videoLongPressRate: number; videoMaxVolume: number; speedWindowSeconds: number }>("getSettings")
      .then((s) =>
        setPrefs({
          seekSeconds: s.videoSeekSeconds || 5,
          longPressRate: s.videoLongPressRate || 4,
          maxVolume: s.videoMaxVolume || 200,
          speedWindowSeconds: s.speedWindowSeconds || 180,
        })
      )
      .catch(() => undefined);
    let alive = true;
    const tick = async () => {
      try {
        const st = await call<DesktopState>("state");
        if (!alive) return;
        consume(st);
        if (st.download) {
          const now = Date.now();
          if (now - lastSample.current > 900) {
            lastSample.current = now;
            const d = st.download;
            setHistory((h) => [...h, { now: d.speedNow, avg: d.speedAvg }].slice(-180));
          }
        }
      } catch {
        /* transient during shutdown */
      }
    };
    tick();
    const id = window.setInterval(tick, 600);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  const go = (next: string) => {
    setSideTip(null);
    setPage(next);
    if (next !== "overview") setTaskFocus(null);
  };
  const openDownloadTask = (task: TaskInfo) => {
    if (task.slug) setSelected(task.slug);
    setTaskFocus(task.id);
    setPage("overview");
  };
  const ctx: PageCtx = useMemo(
    () => ({
      boot,
      chats,
      selected,
      setSelected,
      dl,
      op,
      done,
      login,
      running,
      history,
      refresh,
      toast,
      go,
      pickFiles,
      pickFolder,
      tasks,
      openTasks: () => setPage("tasks"),
      prefs,
      applyPrefs: setPrefs,
      taskFocus,
    }),
    [boot, chats, selected, dl, op, done, login, running, history, tasks, prefs, taskFocus]
  );

  useEffect(() => {
    if (!tasksReady.current) {
      tasks.forEach((t) => seenTasks.current.set(t.id, t.state));
      tasksReady.current = true;
      return;
    }
    let completed = false;
    tasks.forEach((t) => {
      const prev = seenTasks.current.get(t.id);
      seenTasks.current.set(t.id, t.state);
      const justFinished = prev === "running" && t.state !== "running";
      const finishedBeforeFirstPoll = prev === undefined && t.state !== "running";
      if (justFinished || finishedBeforeFirstPoll) {
        completed = true;
        toast(t.state === "done" ? `任务完成：${t.title}` : `任务失败：${t.title}${t.error ? " · " + t.error : ""}`, t.state !== "done");
      }
    });
    if (completed) refresh();
  }, [tasks]);

  interface Command {
    id: string;
    label: string;
    hint?: string;
    section: string;
    run: () => void;
  }
  const commands = useMemo<Command[]>(() => {
    const nav: Command[] = [
      { id: "nav-home", label: "前往：首页", hint: "总览", section: "页面", run: () => go("home") },
      { id: "nav-tasks", label: "前往：任务中心", hint: "下载与任务", section: "页面", run: () => go("tasks") },
      { id: "nav-library", label: "前往：档案管理", hint: "导入与管理", section: "页面", run: () => go("library") },
      { id: "nav-account", label: "前往：账号管理", hint: "登录与授权", section: "页面", run: () => go("account") },
      { id: "nav-settings", label: "前往：设置", hint: "参数", section: "页面", run: () => go("settings") },
      { id: "nav-diagnostics", label: "前往：诊断工具", hint: "环境与日志", section: "页面", run: () => go("diagnostics") },
    ];
    const chatsCmds: Command[] = chats.map((c) => ({
      id: `chat-${c.slug}`,
      label: `打开聊天：${c.name}`,
      hint: `${c.messages.toLocaleString()} 条消息`,
      section: "聊天",
      run: () => {
        setSelected(c.slug);
        go("chats");
      },
    }));
    const actions: Command[] = [];
    if (selected) {
      actions.push({
        id: "act-sync",
        label: "一键同步当前聊天",
        hint: "下载缺失媒体并重建网页",
        section: "操作",
        run: () => {
          call("startOneClick", { slug: selected }).catch((e: Error) => toast(e.message, true));
          setTaskFocus(null);
          setPage("overview");
        },
      });
      actions.push({
        id: "act-open",
        label: "打开当前聊天的归档库网页",
        hint: "浏览器",
        section: "操作",
        run: () => call("openLibrary", { slug: selected }).catch((e: Error) => toast(e.message, true)),
      });
      actions.push({
        id: "act-dir",
        label: "打开当前聊天目录",
        hint: "资源管理器",
        section: "操作",
        run: () => call("revealChat", { slug: selected }).catch((e: Error) => toast(e.message, true)),
      });
    }
    actions.push(
      { id: "act-theme", label: theme === "light" ? "切换到深色外观" : "切换到浅色外观", hint: "外观", section: "操作", run: () => setTheme(theme === "light" ? "dark" : "light") },
      { id: "act-refresh", label: "重新读取状态", hint: "刷新", section: "操作", run: refresh },
      { id: "act-logs", label: "打开日志目录", hint: "诊断", section: "操作", run: () => call("revealLogs").catch((e: Error) => toast(e.message, true)) }
    );
    return [...nav, ...actions, ...chatsCmds];
  }, [chats, selected, theme]);

  const filteredCommands = useMemo(() => {
    const q = paletteQuery.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => `${c.label} ${c.hint ?? ""}`.toLowerCase().includes(q));
  }, [commands, paletteQuery]);

  useEffect(() => {
    setPaletteActive(0);
  }, [paletteQuery]);

  const runCommand = (cmd: Command | undefined) => {
    if (!cmd) return;
    setPalette(false);
    setPaletteQuery("");
    cmd.run();
  };

  const closePending = () => {
    if (pending) call("ackPending", { seq: pending.seq }).catch(() => undefined);
    setPending(null);
  };

  const importDroppedJSON = async () => {
    if (!pending?.paths?.length) return;
    setDropBusy(true);
    try {
      await call("importJSON", { paths: pending.paths });
      await call<Bootstrap>("bootstrap").then(setBoot).catch(() => undefined);
      refresh();
      toast(`已导入 ${pending.paths.length} 个 result.json`);
      closePending();
      setPage("chats");
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setDropBusy(false);
    }
  };

  const importDroppedOfficial = async () => {
    if (!pending?.folders?.length) return;
    setDropBusy(true);
    let ok = 0;
    try {
      for (const folder of pending.folders) {
        try {
          await call("importOfficial", { folder, mode: dropMode });
          ok++;
        } catch (e) {
          toast((e as Error).message, true);
        }
      }
      await call<Bootstrap>("bootstrap").then(setBoot).catch(() => undefined);
      refresh();
      if (ok > 0) toast(`已导入 ${ok} 个官方导出`);
      closePending();
      setPage("chats");
    } finally {
      setDropBusy(false);
    }
  };

  const navActive = (key: string) =>
    page === key || (key === "library" && page === "chats") || (key === "tasks" && page === "overview");

  const showNavTip = (e: React.MouseEvent<HTMLElement>, label: string, desc: string) => {
    if (!sideCollapsed) return;
    const r = e.currentTarget.getBoundingClientRect();
    setSideTip({ top: Math.max(8, Math.min(r.top - 4, window.innerHeight - 150)), title: label, desc });
  };
  const showChatTip = (e: React.MouseEvent<HTMLElement>, c: ChatRow) => {
    if (!sideCollapsed) return;
    const r = e.currentTarget.getBoundingClientRect();
    setSideTip({
      top: Math.max(8, Math.min(r.top - 8, window.innerHeight - 190)),
      title: c.name,
      desc: `${c.type || "聊天"} · ID ${c.id || "--"}`,
      lines: [
        `${c.messages.toLocaleString()} 条消息 · ${c.media.toLocaleString()} 个媒体`,
        `${c.pages} 页网页 · ${c.official} 个官方导出`,
        c.updatedAt ? `最近更新 ${c.updatedAt.slice(0, 10)}` : "尚无更新时间",
      ],
      warn: c.missing > 0 ? `缺失 ${c.missing} 个媒体` : undefined,
    });
  };
  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (sideCollapsed) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sideWidth;
    const move = (ev: PointerEvent) => {
      setSideWidth(Math.max(190, Math.min(340, startWidth + ev.clientX - startX)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="app">
      <header className="titlebar">
        <div className="brand">
          <img className="brand-mark" src="./app-icon.png" alt="Telegram Archive Kit" />
          <span className="brand-name">Telegram Archive Kit</span>
          <span className="brand-ver">{boot?.version ?? "2.0"}</span>
        </div>
        {boot && (
          <span className="libchip" title={boot.libraryRoot || "未配置档案库"}>
            <FolderOpen size={12} />
            <span>{boot.libraryRoot || "未配置档案库"}</span>
          </span>
        )}
        <span className="spacer" />
        <button className="cmdk" title="命令面板 (Ctrl+K)" aria-label="打开命令面板" onClick={() => setPalette(true)}>
          <Search size={12} />
          Ctrl K
        </button>
        <button className="taskbtn" title="任务中心" aria-label="打开任务中心" onClick={() => go("tasks")}>
          <ListTodo size={13} />
          任务中心
          {tasks.filter((t) => t.state === "running").length > 0 && <b>{tasks.filter((t) => t.state === "running").length}</b>}
        </button>
        <span className="pill" title={boot?.tdl || "未安装 tdl"}>
          <i className={`dot ${boot?.tdl ? (boot.tdlRunning ? "warn" : "") : "off"}`} />
          {boot?.tdl ? (boot.tdlRunning ? "tdl 运行中" : "tdl 已连接") : "tdl 未安装"}
        </span>
        <span className="pill" title={boot?.hasSession ? "仅表示本机存在会话文件；实际连接状态请在「账号」页检查" : "尚未登录 Telegram"}>
          <i className={`dot ${boot?.hasSession ? "" : "off"}`} />
          {boot?.hasSession ? "有会话文件" : "未登录"}
        </span>
        <div className="seg" role="group" aria-label="外观">
          <button className={theme === "light" ? "on" : ""} onClick={() => setTheme("light")} title="浅色" aria-label="切换浅色外观" aria-pressed={theme === "light"}>
            <Sun size={13} />
          </button>
          <button className={theme === "dark" ? "on" : ""} onClick={() => setTheme("dark")} title="深色" aria-label="切换深色外观" aria-pressed={theme === "dark"}>
            <Moon size={13} />
          </button>
        </div>
        <button className="wbtn" title="最小化" aria-label="最小化窗口" onClick={() => call("windowMinimize")}>
          <Minus size={11} />
        </button>
        <button className="wbtn" title="最大化" aria-label="最大化或还原窗口" onClick={() => call("windowToggleMaximize")}>
          <Square size={10} />
        </button>
        <button className="wbtn close" title="关闭" aria-label="关闭窗口（隐藏到托盘）" onClick={() => call("windowClose")}>
          <X size={11} />
        </button>
      </header>

      <div className={`body ${sideCollapsed ? "side-collapsed" : ""}`} style={{ gridTemplateColumns: `${sideCollapsed ? 64 : sideWidth}px minmax(0, 1fr)` }}>
        <aside className={`side ${sideCollapsed ? "collapsed" : ""}`}>
          <nav className="nav" aria-label="主导航">
            {NAV.map((n) => {
              const Icon = n.icon;
              return (
                <button
                  key={n.key}
                  className={navActive(n.key) ? "on" : ""}
                  onClick={() => go(n.key)}
                  onMouseEnter={(e) => showNavTip(e, n.label, n.desc)}
                  onMouseLeave={() => setSideTip(null)}
                  aria-label={n.label}
                >
                  <Icon size={16} />
                  <span>{n.label}</span>
                </button>
              );
            })}
          </nav>
          <div className="side-head">
            {!sideCollapsed && (
              <>
                <span className="side-title">聊天</span>
                <span className="side-count">{chats.length}</span>
                <span className="spacer" />
                <button className="side-manage" onClick={() => go("library")} title="打开档案管理" aria-label="打开档案管理">
                  <Settings2 size={12} />
                </button>
              </>
            )}
            <button
              className="side-collapse"
              onClick={() => { setSideTip(null); setSideCollapsed((v) => !v); }}
              title={sideCollapsed ? "展开侧栏" : "折叠侧栏"}
              aria-label={sideCollapsed ? "展开侧栏" : "折叠侧栏"}
              onMouseEnter={(e) => showNavTip(e, sideCollapsed ? "展开侧栏" : "折叠侧栏", "只显示图标，悬停查看详情")}
              onMouseLeave={() => setSideTip(null)}
            >
              {sideCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
            </button>
          </div>
          <div className="chat-list">
            {chats.length === 0 && (
              <div className="side-empty">
                还没有聊天。
                <br />
                到「档案管理」导入 result.json。
              </div>
            )}
            {chats.map((c) => (
              <button
                key={c.slug}
                className={`chat-item ${c.slug === selected ? "on" : ""}`}
                onClick={() => {
                  setSelected(c.slug);
                  go("chats");
                }}
                onMouseEnter={(e) => showChatTip(e, c)}
                onMouseLeave={() => setSideTip(null)}
                aria-label={`${c.name}，${c.messages} 条消息，${c.media} 个媒体`}
              >
                <span className="avatar">{c.name.slice(0, 1)}</span>
                <span className="chat-text">
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
          {!sideCollapsed && <div className="side-resizer" onPointerDown={startResize} aria-hidden="true" />}
        </aside>

        <main className="main">
          <div className="scroll">
            {page === "home" && <Home ctx={ctx} />}
            {page === "overview" && <Overview ctx={ctx} />}
            {page === "chats" && <Chats ctx={ctx} />}
            {page === "library" && <Library ctx={ctx} />}
            {page === "account" && <Account ctx={ctx} />}
            {page === "tasks" && (
              <TasksPage
                tasks={tasks}
                onRefresh={refresh}
                onClear={() => setTasks((list) => list.filter((t) => t.state === "running"))}
                onOpenDownload={openDownloadTask}
                toast={toast}
              />
            )}
            {page === "settings" && <SettingsPage ctx={ctx} />}
            {page === "diagnostics" && <Diagnostics ctx={ctx} />}
          </div>
        </main>
      </div>

      {sideCollapsed && sideTip && (
        <div className="side-tip" role="tooltip" style={{ top: sideTip.top }}>
          <b>{sideTip.title}</b>
          {sideTip.desc && <span>{sideTip.desc}</span>}
          {sideTip.lines?.map((line) => <span key={line}>{line}</span>)}
          {sideTip.warn && <em>{sideTip.warn}</em>}
        </div>
      )}

      {palette && (
        <div
          className="modal-backdrop palette-backdrop"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setPalette(false);
          }}
        >
          <div className="palette" role="dialog" aria-modal="true" aria-label="命令面板">
            <div className="palette-search">
              <Search size={16} />
              <input
                autoFocus
                value={paletteQuery}
                placeholder="搜索命令、聊天或页面…"
                aria-label="搜索命令"
                onChange={(e) => setPaletteQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setPaletteActive((n) => Math.min(filteredCommands.length - 1, n + 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setPaletteActive((n) => Math.max(0, n - 1));
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    runCommand(filteredCommands[paletteActive]);
                  }
                }}
              />
              <kbd>Esc</kbd>
            </div>
            <div className="palette-list" role="listbox" aria-label="命令">
              {filteredCommands.length === 0 && <div className="palette-empty">没有匹配的命令</div>}
              {filteredCommands.map((c, i) => (
                <div key={c.id} className="palette-item-wrap">
                  {(i === 0 || filteredCommands[i - 1].section !== c.section) && <h4 className="palette-section">{c.section}</h4>}
                  <button
                    role="option"
                    aria-selected={i === paletteActive}
                    className={i === paletteActive ? "on" : ""}
                    onMouseEnter={() => setPaletteActive(i)}
                    onClick={() => runCommand(c)}
                  >
                    <span>{c.label}</span>
                    {c.hint && <span className="hint">{c.hint}</span>}
                  </button>
                </div>
              ))}
            </div>
            <div className="palette-foot">
              <span>↑↓ 选择 · Enter 执行</span>
              <span><kbd>Ctrl</kbd> <kbd>K</kbd> 打开 · <kbd>Esc</kbd> 关闭</span>
            </div>
          </div>
        </div>
      )}

      {pending && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="drop-title">
            <h2 id="drop-title">收到待导入内容</h2>
            <p className="modal-sub">来自{pending.source || "拖放"}，确认后才会写入档案库。</p>
            <div className="drop-list">
              {(pending.paths ?? []).map((p) => (
                <span key={p} className="drop-item">
                  <FileJson size={13} /> {p}
                </span>
              ))}
              {(pending.folders ?? []).map((p) => (
                <span key={p} className="drop-item">
                  <FolderInput size={13} /> {p}
                </span>
              ))}
            </div>
            {(pending.paths?.length ?? 0) > 0 && (
              <button className="btn primary" disabled={dropBusy} onClick={importDroppedJSON}>
                导入 {pending.paths?.length} 个 result.json
              </button>
            )}
            {(pending.folders?.length ?? 0) > 0 && (
              <>
                <div className="field">
                  <label>官方导出导入方式</label>
                  <Select
                    ariaLabel="官方导出导入方式"
                    value={dropMode}
                    onChange={setDropMode}
                    options={[
                      { value: "copy", label: "复制到档案库（推荐）" },
                      { value: "reference", label: "仅引用源目录（不复制媒体）" },
                      { value: "move", label: "移动并整理源目录" },
                    ]}
                  />
                </div>
                <button className="btn primary" disabled={dropBusy} onClick={importDroppedOfficial}>
                  导入 {pending.folders?.length} 个官方导出
                </button>
              </>
            )}
            <div className="modal-actions">
              <button className="btn ghost" onClick={closePending}>
                忽略
              </button>
            </div>
          </div>
        </div>
      )}

      {toastMsg && (
        <div className={`toast ${toastMsg.err ? "err" : ""}`} role="alert" onClick={() => setToastMsg(null)} title="点击关闭">
          {toastMsg.text}
        </div>
      )}
    </div>
  );
}
