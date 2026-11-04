import { useEffect, useMemo, useRef, useState } from "react";
import {
  Database,
  FileJson,
  FolderInput,
  FolderOpen,
  HardDrive,
  LayoutDashboard,
  MessageSquare,
  MessagesSquare,
  Minus,
  Moon,
  Settings,
  Square,
  Stethoscope,
  Sun,
  UserRound,
  X,
} from "lucide-react";
import { call } from "./rpc";
import type { Bootstrap, ChatRow, DesktopState, DoneState, DownloadState, LoginState, OperationState, PendingInput } from "./types";
import { Account, Chats, Diagnostics, Library, Overview, SettingsPage, type PageCtx } from "./pages";

type Theme = "light" | "dark";
const initialTheme = (): Theme => (localStorage.getItem("tak-theme") === "dark" ? "dark" : "light");

const NAV = [
  { key: "overview", label: "概览", icon: LayoutDashboard },
  { key: "chats", label: "聊天", icon: MessagesSquare },
  { key: "library", label: "档案库", icon: Database },
  { key: "account", label: "账号", icon: UserRound },
  { key: "settings", label: "设置", icon: Settings },
  { key: "diagnostics", label: "诊断", icon: Stethoscope },
];

export default function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [chats, setChats] = useState<ChatRow[]>([]);
  const [selected, setSelected] = useState("");
  const [page, setPage] = useState("overview");
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
  const lastSample = useRef(0);
  const toastTimer = useRef(0);
  const lastNotice = useRef(0);
  const lastPending = useRef(0);

  const toast = (text: string, err = false) => {
    setToastMsg({ text, err });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastMsg(null), 6000);
  };

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("tak-theme", theme);
  }, [theme]);

  const consume = (st: DesktopState) => {
    setChats(st.chats ?? []);
    setSelected((prev) => prev || st.chats?.find((c) => c.current)?.slug || st.chats?.[0]?.slug || "");
    setDl(st.download ?? null);
    setOp(st.operation ?? null);
    setDone(st.done ?? null);
    setLogin(st.login ?? null);
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
  };

  const refresh = () => {
    call<DesktopState>("state")
      .then(consume)
      .catch(() => undefined);
    call<Bootstrap>("bootstrap").then(setBoot).catch(() => undefined);
  };

  useEffect(() => {
    call<Bootstrap>("bootstrap").then(setBoot).catch((e: Error) => toast(e.message, true));
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
      go: setPage,
    }),
    [boot, chats, selected, dl, op, done, login, running, history]
  );

  const current = chats.find((c) => c.slug === selected) || null;

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
        <span className="pill" title={boot?.hasSession ? "仅表示本机存在会话文件；实际连接状态请在「账号」页检查" : "尚未登录 Telegram"}>
          <i className={`dot ${boot?.hasSession ? "" : "off"}`} />
          {boot?.hasSession ? "有会话文件" : "未登录"}
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
          <nav className="nav" aria-label="主导航">
            {NAV.map((n) => {
              const Icon = n.icon;
              return (
                <button key={n.key} className={page === n.key ? "on" : ""} onClick={() => setPage(n.key)}>
                  <Icon size={15} />
                  {n.label}
                </button>
              );
            })}
          </nav>
          <div className="side-head">
            <h2>聊天</h2>
            <span className="side-count">{chats.length} 个</span>
          </div>
          <div className="chat-list">
            {chats.length === 0 && (
              <div className="side-empty">
                还没有聊天。
                <br />
                到「聊天」页导入 result.json。
              </div>
            )}
            {chats.map((c) => (
              <button
                key={c.slug}
                className={`chat-item ${c.slug === selected ? "on" : ""}`}
                onClick={() => {
                  setSelected(c.slug);
                  setPage("overview");
                }}
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
          <div className="scroll">
            {page === "overview" && <Overview ctx={ctx} />}
            {page === "chats" && <Chats ctx={ctx} />}
            {page === "library" && <Library ctx={ctx} />}
            {page === "account" && <Account ctx={ctx} />}
            {page === "settings" && <SettingsPage ctx={ctx} />}
            {page === "diagnostics" && <Diagnostics ctx={ctx} />}
          </div>
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
                  <select value={dropMode} onChange={(e) => setDropMode(e.target.value)}>
                    <option value="copy">复制到档案库（推荐）</option>
                    <option value="reference">仅引用源目录（不复制媒体）</option>
                    <option value="move">移动并整理源目录</option>
                  </select>
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
