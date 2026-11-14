import { AppTooltip } from "./AppTooltip";
import { Activity, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Database,
  FileJson,
  FolderInput,
  FolderOpen,
  Globe,
  House,
  Info,
  Settings2,
  ListTodo,
  MessagesSquare,
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
  XCircle,
} from "lucide-react";
import { call } from "./rpc";
import type { Bootstrap, ChatRow, DesktopState, DoneState, DownloadState, LoginState, MediaSummary, OperationState, PendingInput, TaskInfo, ToastAction, ToastKind, ViewerPrefs } from "./types";
import { Account, Chats, Diagnostics, Home, Library, SettingsPage, type PageCtx } from "./pages";
import { TasksPage } from "./TaskCenter";
import type { SyncPlanLocation } from "./SyncPlans";
import { OnlineChatsPage } from "./OnlineChats";
import { Select } from "./Select";
import { OnlineUpdateDialog, type OnlineUpdateTarget } from "./OnlineUpdateDialog";
import { WebPublication } from "./WebPublication";

type Theme = "light" | "dark";
const initialTheme = (): Theme => (localStorage.getItem("tak-theme") === "dark" ? "dark" : "light");

function withMediaSummary(chat: ChatRow, summary: MediaSummary): ChatRow {
  if (chat.mediaReady && chat.media === summary.total && chat.totalBytes === summary.bytes &&
      chat.images === summary.images && chat.videos === summary.videos && chat.audio === summary.audio && chat.files === summary.files &&
      chat.imageBytes === summary.imageBytes && chat.videoBytes === summary.videoBytes && chat.audioBytes === summary.audioBytes && chat.fileBytes === summary.fileBytes) return chat;
  return {
    ...chat, mediaReady: true, media: summary.total, totalBytes: summary.bytes,
    images: summary.images, videos: summary.videos, audio: summary.audio, files: summary.files,
    imageBytes: summary.imageBytes, videoBytes: summary.videoBytes, audioBytes: summary.audioBytes, fileBytes: summary.fileBytes,
  };
}

const NAV = [
  { key: "home", label: "首页", desc: "档案总览与快速同步", icon: House },
  { key: "online", label: "在线聊天", desc: "Telegram 实时会话与归档", icon: MessagesSquare },
  { key: "tasks", label: "任务中心", desc: "下载、导入与重建记录", icon: ListTodo },
  { key: "library", label: "档案管理", desc: "导入、批量管理与库切换", icon: Database },
  { key: "publish", label: "网页部署", desc: "在局域网或 Tailscale 浏览档案", icon: Globe },
  { key: "account", label: "账号管理", desc: "登录、资料与授权状态", icon: UserRound },
  { key: "diagnostics", label: "诊断工具", desc: "环境检查与日志浏览", icon: Stethoscope },
  { key: "settings", label: "系统设置", desc: "下载、网络与播放器参数", icon: Settings },
];

const initialSideWidth = () => {
  const saved = Number(localStorage.getItem("tak-side-width") || 0);
  return saved >= 190 && saved <= 340 ? saved : 236;
};
const initialCollapsed = () => localStorage.getItem("tak-side-collapsed") === "1";

function chatTooltip(chat: ChatRow) {
  return [
    `${chat.type || "聊天"} · ID ${chat.id || "--"}`,
    `${chat.messages.toLocaleString()} 条消息 · ${chat.media.toLocaleString()} 个媒体`,
    `${chat.pages} 页网页 · ${chat.official} 个官方导出`,
    chat.updatedAt ? `最近更新 ${chat.updatedAt.slice(0, 10)}` : "尚无更新时间",
    chat.missing > 0 ? `缺失 ${chat.missing} 个媒体` : "",
  ].filter(Boolean).join("\n");
}

// Frost the captured frame once, before it reaches CSS. Blurring a pseudo
// element directly fades its edges to transparent, which showed up as a
// translucent ring around every dialog.
async function frostSnapshot(src: string): Promise<string> {
  if (!src) return "";
  const image = new Image();
  image.src = src;
  try {
    await image.decode();
  } catch {
    return src;
  }
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (!width || !height) return src;
  const viewport = Math.max(1, window.innerWidth);
  const blur = Math.max(8, Math.round(28 * (width / viewport)));
  const pad = blur * 3 + 8;
  const source = document.createElement("canvas");
  source.width = width + pad * 2;
  source.height = height + pad * 2;
  const sourceCtx = source.getContext("2d");
  if (!sourceCtx) return src;
  sourceCtx.drawImage(image, pad, pad, width, height);
  sourceCtx.drawImage(image, 0, 0, 1, height, 0, pad, pad, height);
  sourceCtx.drawImage(image, width - 1, 0, 1, height, pad + width, pad, pad, height);
  sourceCtx.drawImage(image, 0, 0, width, 1, pad, 0, width, pad);
  sourceCtx.drawImage(image, 0, height - 1, width, 1, pad, pad + height, width, pad);
  sourceCtx.drawImage(image, 0, 0, 1, 1, 0, 0, pad, pad);
  sourceCtx.drawImage(image, width - 1, 0, 1, 1, pad + width, 0, pad, pad);
  sourceCtx.drawImage(image, 0, height - 1, 1, 1, 0, pad + height, pad, pad);
  sourceCtx.drawImage(image, width - 1, height - 1, 1, 1, pad + width, pad + height, pad, pad);
  const blurred = document.createElement("canvas");
  blurred.width = source.width;
  blurred.height = source.height;
  const blurredCtx = blurred.getContext("2d");
  if (!blurredCtx || typeof blurredCtx.filter !== "string") return src;
  blurredCtx.filter = `blur(${blur}px) saturate(1.45) brightness(1.03)`;
  blurredCtx.drawImage(source, 0, 0);
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const outCtx = out.getContext("2d");
  if (!outCtx) return src;
  outCtx.drawImage(blurred, pad, pad, width, height, 0, 0, width, height);
  return out.toDataURL("image/jpeg", 0.86);
}

export default function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [chats, setChats] = useState<ChatRow[]>([]);
  const [chatsStatus, setChatsStatus] = useState<"loading" | "ready" | "error">("loading");
  const [selected, setSelected] = useState("");
  const [page, setPage] = useState("home");
  const [dl, setDl] = useState<DownloadState | null>(null);
  const [op, setOp] = useState<OperationState | null>(null);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState<DoneState | null>(null);
  const [login, setLogin] = useState<LoginState | null>(null);
  const [history, setHistory] = useState<{ now: number; avg: number }[]>([]);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [toasts, setToasts] = useState<Array<{ id: number; text: string; kind: ToastKind; action?: ToastAction }>>([]);
  const [downloadTarget, setDownloadTarget] = useState<OnlineUpdateTarget | null>(null);
  const [pending, setPending] = useState<PendingInput | null>(null);
  const [dropMode, setDropMode] = useState("copy");
  const [dropBusy, setDropBusy] = useState(false);
  const [palette, setPalette] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteActive, setPaletteActive] = useState(0);
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [prefs, setPrefs] = useState<ViewerPrefs>({ seekSeconds: 5, longPressRate: 4, longPressDelayMs: 300, maxVolume: 200, volumeStep: 10, videoFrameAspect: "original", speedWindowSeconds: 180, backdrop: "ambient" });
  const [sideWidth, setSideWidth] = useState(initialSideWidth);
  const [sideCollapsed, setSideCollapsed] = useState(initialCollapsed);
  const lastSample = useRef(0);
  const toastSeq = useRef(0);
  const toastSeconds = useRef(3);
  const toastTimers = useRef(new Map<number, number>());
  const lastNotice = useRef(0);
  const lastPending = useRef(0);
  const lastDialog = useRef(0);
  const desktopContent = useRef("");
  const seenTasks = useRef(new Map<string, string>());
  const tasksReady = useRef(false);
  const libraryLoad = useRef<AbortController | null>(null);
  const activeLibraryKey = useRef("");
  const summariesDuringLoad = useRef(new Map<string, MediaSummary>());
  const galleryReturn = useRef<{
    libraryKey: string; slug: string; top: number; anchor?: HTMLElement; offset: number;
  } | null>(null);
  const scrollArea = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const main = scrollArea.current?.parentElement;
    if (!main) return;
    const update = () => {
      const { left, top } = main.getBoundingClientRect();
      document.documentElement.style.setProperty("--main-inset-left", `${left}px`);
      document.documentElement.style.setProperty("--main-inset-top", `${top}px`);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(main);
    return () => observer.disconnect();
  }, []);
  const pickerWaiters = useRef(new Map<string, { resolve: (paths: string[]) => void; reject: (e: Error) => void }>());

  const dismissToast = useCallback((id: number) => {
    const timer = toastTimers.current.get(id);
    if (timer) {
      window.clearTimeout(timer);
      toastTimers.current.delete(id);
    }
    setToasts((list) => list.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback((text: string, kind: boolean | ToastKind = false, action?: ToastAction) => {
    const type: ToastKind = kind === true ? "error" : kind === false ? "info" : kind;
    const id = ++toastSeq.current;
    setToasts((list) => [...list.slice(-3), { id, text, kind: type, action }]);
    const ms = Math.min(10, Math.max(1, toastSeconds.current)) * 1000;
    toastTimers.current.set(id, window.setTimeout(() => dismissToast(id), ms));
  }, [dismissToast]);

  const setToastSeconds = useCallback((seconds: number) => {
    toastSeconds.current = Math.min(10, Math.max(1, Math.round(seconds) || 3));
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("tak-theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("tak-side-width", String(sideWidth));
  }, [sideWidth]);
  useEffect(() => {
    localStorage.setItem("tak-side-collapsed", sideCollapsed ? "1" : "0");
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

  const consume = useCallback((st: DesktopState) => {
    const content = JSON.stringify([st.download, st.operation, st.done, st.login, st.tasks, st.running]);
    if (desktopContent.current !== content) {
      desktopContent.current = content;
      setDl(st.download ?? null);
      setOp(st.operation ?? null);
      setDone(st.done ?? null);
      setLogin(st.login ?? null);
      setTasks(st.tasks ?? []);
      setRunning(st.running);
    }
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
  }, [toast]);

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

  const refresh = useCallback(() => {
    libraryLoad.current?.abort();
    const controller = new AbortController();
    libraryLoad.current = controller;
    summariesDuringLoad.current.clear();
    setChatsStatus((status) => status === "ready" ? status : "loading");
    const { signal } = controller;
    const bootstrap = call<Bootstrap>("bootstrap", undefined, signal).then((next) => {
      if (signal.aborted) return null;
      const key = next.libraryKey || "";
      const sameLibrary = activeLibraryKey.current === key;
      activeLibraryKey.current = key;
      setBoot(next);
      if (!sameLibrary) {
        setChats([]);
        setSelected("");
        setChatsStatus("loading");
      }
      return { next, key, sameLibrary };
    });
    void Promise.allSettled([
      bootstrap,
      call<{ libraryKey: string; chats: ChatRow[] }>("listChats", undefined, signal),
    ]).then(([bootResult, list]) => {
      if (signal.aborted) return;
      if (bootResult.status !== "fulfilled" || !bootResult.value) {
        setChatsStatus((status) => status === "ready" ? status : "error");
        return;
      }
      const { next, key, sameLibrary } = bootResult.value;
      if (list.status === "fulfilled" && list.value.libraryKey === key) {
        const rows = list.value.chats.map((row) => {
          const summary = sameLibrary ? summariesDuringLoad.current.get(row.slug) : undefined;
          return summary ? withMediaSummary(row, summary) : row;
        });
        setBoot({ ...next, chats: rows.length });
        setChats(rows);
        setChatsStatus("ready");
        setSelected((prev) => (sameLibrary && rows.some((row) => row.slug === prev) ? prev : rows.find((row) => row.current)?.slug || rows[0]?.slug || ""));
      } else {
        setChatsStatus((status) => status === "ready" ? status : "error");
      }
    }).finally(() => {
      if (libraryLoad.current === controller) {
        libraryLoad.current = null;
        summariesDuringLoad.current.clear();
      }
    });
  }, []);

  const applyMediaSummary = useCallback((libraryKey: string, slug: string, summary: MediaSummary) => {
    if (libraryKey !== activeLibraryKey.current) return;
    if (libraryLoad.current) summariesDuringLoad.current.set(slug, summary);
    setChats((rows) => {
      const row = rows.find((item) => item.slug === slug);
      if (!row) return rows;
      const updated = withMediaSummary(row, summary);
      return updated === row ? rows : rows.map((item) => item === row ? updated : item);
    });
  }, []);

  useEffect(() => {
    refresh();
    const remoteChanged = () => refresh();
    window.addEventListener("tak:remote-library-changed", remoteChanged);
    const timer = window.setInterval(() => {
      if (!libraryLoad.current && !document.hidden) refresh();
    }, 60_000);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("tak:remote-library-changed", remoteChanged);
      libraryLoad.current?.abort();
    };
  }, [refresh]);

  useEffect(() => {
    const controller = new AbortController();
    call<{ videoSeekSeconds: number; videoLongPressRate: number; videoLongPressDelayMs: number; videoMaxVolume: number; videoVolumeStep: number; videoFrameAspect: string; speedWindowSeconds: number; viewerBackdrop: string; toastSeconds?: number }>("getSettings", undefined, controller.signal)
      .then((s) => {
        if (controller.signal.aborted) return;
        setToastSeconds(s.toastSeconds || 3);
        setPrefs({
          seekSeconds: s.videoSeekSeconds || 5,
          longPressRate: s.videoLongPressRate || 4,
          longPressDelayMs: s.videoLongPressDelayMs || 300,
          maxVolume: s.videoMaxVolume || 200,
          volumeStep: s.videoVolumeStep || 10,
          videoFrameAspect: s.videoFrameAspect || "original",
          speedWindowSeconds: s.speedWindowSeconds || 180,
          backdrop: s.viewerBackdrop || "ambient",
        });
      })
      .catch(() => undefined);
    let timer = 0;
    const tick = async () => {
      try {
        const st = await call<DesktopState>("state", undefined, controller.signal);
        if (controller.signal.aborted) return;
        consume(st);
        if (st.running && st.download) {
          const now = Date.now();
          if (now - lastSample.current > 900) {
            lastSample.current = now;
            const d = st.download;
            setHistory((h) => [...h, { now: d.speedNow, avg: d.speedAvg }].slice(-180));
          }
        }
      } catch {
        /* transient during shutdown */
      } finally {
        if (!controller.signal.aborted) timer = window.setTimeout(tick, 600);
      }
    };
    void tick();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [consume, setToastSeconds]);

  useEffect(() => {
    let disposed = false;
    let busy = false;
    let open = false;
    const clear = () => {
      document.body.classList.remove("glass-ready", "glass-captured", "glass-capturing");
      document.body.style.removeProperty("--glass-snapshot");
    };
    const capture = async () => {
      if (busy || disposed) return;
      busy = true;
      document.body.classList.add("glass-capturing");
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      let image = "";
      try {
        image = await Promise.race([
          call<string>("captureWindow"),
          new Promise<string>((resolve) => window.setTimeout(() => resolve(""), 3000)),
        ]);
      } catch {
        image = "";
      }
      if (disposed) return;
      if (!document.querySelector(".modal-backdrop")) {
        document.body.classList.remove("glass-capturing");
        busy = false;
        return;
      }
      if (image) {
        try {
          image = await frostSnapshot(image);
        } catch {
          /* keep the sharp capture as a fallback */
        }
        if (disposed) return;
        document.body.style.setProperty("--glass-snapshot", `url("${image}")`);
        document.body.classList.add("glass-captured");
      }
      document.body.classList.add("glass-ready");
      document.body.classList.remove("glass-capturing");
      busy = false;
    };
    const sync = () => {
      const has = !!document.querySelector(".modal-backdrop");
      if (has && !open) {
        open = true;
        void capture();
      } else if (!has && open) {
        open = false;
        clear();
      }
    };
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true });
    sync();
    return () => {
      disposed = true;
      observer.disconnect();
      clear();
    };
  }, []);

  const [onlineRequest, setOnlineRequest] = useState<{ filter: string; seq: number } | null>(null);
  const [remoteRequest, setRemoteRequest] = useState(0);
  const [taskFocus, setTaskFocus] = useState("");
  const [taskTab, setTaskTab] = useState<"records" | "plans">("records");
  const [planLocation, setPlanLocation] = useState<SyncPlanLocation | null>(null);
  const [planRecovery, setPlanRecovery] = useState<"remote" | "returning" | null>(null);
  const go = useCallback((next: string) => {
    if (page === "chats" && next === "settings" && selected) {
      const area = scrollArea.current;
      const viewport = area?.getBoundingClientRect();
      const anchor = area && viewport ? Array.from(area.querySelectorAll<HTMLElement>(".media-tile:not(.skeleton), .file-row")).find((item) => {
        const rect = item.getBoundingClientRect();
        return rect.bottom > viewport.top && rect.top < viewport.bottom;
      }) : undefined;
      galleryReturn.current = {
        libraryKey: activeLibraryKey.current, slug: selected, top: area?.scrollTop ?? 0, anchor,
        offset: anchor && viewport ? anchor.getBoundingClientRect().top - viewport.top : 0,
      };
    } else if (next !== "chats" && next !== "settings") {
      galleryReturn.current = null;
    }
    if (next === "remote") setRemoteRequest((value) => value + 1);
    else setPlanRecovery(null);
    setPage(next === "remote" ? "library" : next);
  }, [page, selected]);
  useEffect(() => {
    const open = () => go("publish");
    window.addEventListener("tak:show-web-publication", open);
    return () => window.removeEventListener("tak:show-web-publication", open);
  }, [go]);
  useLayoutEffect(() => {
    const saved = galleryReturn.current;
    if (!saved || page === "settings") return;
    if (page !== "chats" || saved.libraryKey !== activeLibraryKey.current || saved.slug !== selected) {
      galleryReturn.current = null;
      return;
    }
    const restore = () => {
      const area = scrollArea.current;
      if (galleryReturn.current !== saved || !area) return;
      if (saved.anchor && area.contains(saved.anchor)) {
        area.scrollTop += saved.anchor.getBoundingClientRect().top - area.getBoundingClientRect().top - saved.offset;
      } else {
        area.scrollTop = saved.top;
      }
    };
    restore();
    // Returning can realize tiles that were skipped while the gallery was hidden.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        restore();
        if (galleryReturn.current === saved) galleryReturn.current = null;
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [page, selected]);
  const openOnline = (filter = "all") => {
    setOnlineRequest({ filter, seq: Date.now() });
    go("online");
  };
  const openTask = (taskId: string) => {
    if (!taskId) return;
    setTaskFocus(taskId);
    go("tasks");
  };
  const ctx: PageCtx = useMemo(
    () => ({
      boot,
      chats,
      chatsStatus,
      selected,
      setSelected,
      dl,
      op,
      done,
      login,
      running,
      history,
      refresh,
      applyMediaSummary,
      toast,
      go,
      openOnline,
      onlineRequest,
      pickFiles,
      pickFolder,
      tasks,
      openTasks: () => setPage("tasks"),
      openTask,
      prefs,
      applyPrefs: setPrefs,
      setToastSeconds,
    }),
    [boot, chats, chatsStatus, selected, dl, op, done, login, running, history, tasks, prefs, onlineRequest, go, refresh, applyMediaSummary, toast, setToastSeconds]
  );

  useEffect(() => {
    if (!tasksReady.current) {
      // The first render still has no tasks; seed from the first non-empty
      // snapshot so history restored from disk never replays as new toasts.
      if (tasks.length === 0) return;
      tasks.forEach((t) => seenTasks.current.set(t.id, t.state));
      tasksReady.current = true;
      return;
    }
    let completed = false;
    tasks.forEach((t) => {
      const prev = seenTasks.current.get(t.id);
      seenTasks.current.set(t.id, t.state);
      const justFinished = prev === "running" && t.state !== "running";
      if (justFinished) {
        completed = true;
        const text = t.state === "done"
          ? `任务完成：${t.title}`
          : t.state === "partial"
            ? `任务部分完成：${t.title}${t.error ? " · " + t.error : ""}`
            : t.state === "paused"
              ? `任务已暂停：${t.title}`
              : t.state === "stopped"
                ? `任务已终止：${t.title}`
                : `任务失败：${t.title}${t.error ? " · " + t.error : ""}`;
        toast(text, t.state === "failed");
      }
    });
    if (completed) refresh();
  }, [tasks, refresh, toast]);

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
      { id: "nav-online", label: "前往：在线聊天", hint: "Telegram 实时会话", section: "页面", run: () => go("online") },
      { id: "nav-tasks", label: "前往：任务中心", hint: "下载与任务", section: "页面", run: () => go("tasks") },
      { id: "nav-library", label: "前往：档案管理", hint: "导入与管理", section: "页面", run: () => go("library") },
      { id: "nav-publish", label: "前往：网页部署", hint: "局域网与 Tailscale", section: "页面", run: () => go("publish") },
      { id: "nav-account", label: "前往：账号管理", hint: "登录与授权", section: "页面", run: () => go("account") },
      { id: "nav-settings", label: "前往：系统设置", hint: "参数", section: "页面", run: () => go("settings") },
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
        hint: "先统计缺失媒体与磁盘空间",
        section: "操作",
        run: () => {
          const chat = chats.find((c) => c.slug === selected);
          setDownloadTarget({
            peer: "local:" + selected,
            name: chat?.name ?? "聊天",
            slug: selected,
            mode: "sync",
          });
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
  }, [chats, selected, theme, go, refresh, toast]);

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
    page === key || (key === "library" && page === "chats");

  const beginWindowResize = (edge: string, e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const start = {
      x: e.clientX, y: e.clientY,
      w: window.innerWidth, h: window.innerHeight,
      px: window.screenX, py: window.screenY,
    };
    let raf = 0;
    let pending = { width: start.w, height: start.h, x: start.px, y: start.py };
    const move = (ev: MouseEvent) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      let width = start.w + (edge.includes("e") ? dx : 0) - (edge.includes("w") ? dx : 0);
      let height = start.h + (edge.includes("s") ? dy : 0) - (edge.includes("n") ? dy : 0);
      width = Math.max(1040, width);
      height = Math.max(680, height);
      const x = edge.includes("w") ? start.px + (start.w - width) : start.px;
      const y = edge.includes("n") ? start.py + (start.h - height) : start.py;
      pending = { width: Math.round(width), height: Math.round(height), x, y };
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        call("windowResize", pending).catch(() => undefined);
      });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = getComputedStyle(e.currentTarget).cursor;
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
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
      {(["n", "s", "e", "w", "nw", "ne", "sw", "se"] as const).map((edge) => (
        <div
          key={edge}
          className={`resize-edge ${edge}`}
          onMouseDown={(e) => beginWindowResize(edge, e)}
        />
      ))}
      <header className="titlebar">
        <div className="brand">
          <img className="brand-mark" src="./app-icon.png" alt="Telegram Archive Kit" />
          <span className="brand-name">Telegram Archive Kit</span>
          <span className="brand-ver">{boot?.version ?? "2.0"}</span>
        </div>
        <button
          className="side-toggle"
          onClick={() => setSideCollapsed((v) => !v)}
          aria-label={sideCollapsed ? "展开侧栏" : "折叠侧栏"}
          data-tip={sideCollapsed ? "展开侧栏" : "折叠侧栏"}
        >
          {sideCollapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
        </button>
        {boot && (
          <span className="libchip" data-tip={boot.libraryRoot || "未配置档案库"}>
            <FolderOpen size={12} />
            <span>{boot.libraryRoot || "未配置档案库"}</span>
          </span>
        )}
        <span className="spacer" />
        <button className="cmdk" data-tip="命令面板 (Ctrl+K)" aria-label="打开命令面板" onClick={() => setPalette(true)}>
          <Search size={12} />
          Ctrl K
        </button>
        <button className="taskbtn" data-tip="任务中心" aria-label="打开任务中心" onClick={() => go("tasks")}>
          <ListTodo size={13} />
          任务中心
          {tasks.filter((t) => t.state === "running").length > 0 && <b>{tasks.filter((t) => t.state === "running").length}</b>}
        </button>
        <span className="pill" data-tip={boot?.tdl || "未安装 tdl"}>
          <i className={`dot ${boot?.tdl ? (boot.tdlRunning ? "warn" : "") : "off"}`} />
          {boot?.tdl ? (boot.tdlRunning ? "tdl 运行中" : "tdl 已连接") : "tdl 未安装"}
        </span>
        <span className="pill" data-tip={boot?.hasSession ? "仅表示本机存在会话文件；实际连接状态请在「账号」页检查" : "尚未登录 Telegram"}>
          <i className={`dot ${boot?.hasSession ? "" : "off"}`} />
          {boot?.hasSession ? "有会话文件" : "未登录"}
        </span>
        <div className="seg" role="group" aria-label="外观">
          <button className={theme === "light" ? "on" : ""} onClick={() => setTheme("light")} data-tip="浅色" aria-label="切换浅色外观" aria-pressed={theme === "light"}>
            <Sun size={13} />
          </button>
          <button className={theme === "dark" ? "on" : ""} onClick={() => setTheme("dark")} data-tip="深色" aria-label="切换深色外观" aria-pressed={theme === "dark"}>
            <Moon size={13} />
          </button>
        </div>
        <button className="wbtn" data-tip="最小化" aria-label="最小化窗口" onClick={() => call("windowMinimize")}>
          <Minus size={11} />
        </button>
        <button className="wbtn" data-tip="最大化" aria-label="最大化或还原窗口" onClick={() => call("windowToggleMaximize")}>
          <Square size={10} />
        </button>
        <button className="wbtn close" data-tip="关闭" aria-label="关闭窗口（隐藏到托盘）" onClick={() => call("windowClose")}>
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
                  data-tip={sideCollapsed ? n.desc : undefined}
                  data-tip-heading={n.label}
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
                <span className="side-title">本地聊天</span>
                <span className="side-count">{chats.length}</span>
                <span className="spacer" />
                <button className="side-manage" onClick={() => go("library")} data-tip="打开档案管理" aria-label="打开档案管理">
                  <Settings2 size={12} />
                </button>
              </>
            )}
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
                data-tip={sideCollapsed ? chatTooltip(c) : undefined}
                data-tip-heading={c.name}
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
          <div className="scroll" ref={scrollArea}>
            {page === "home" && <Home ctx={ctx} />}
            {page === "online" && <OnlineChatsPage ctx={ctx} />}
            {(page === "chats" || (page === "settings" && galleryReturn.current !== null && galleryReturn.current.libraryKey === boot?.libraryKey)) && (
              <Activity mode={page === "chats" ? "visible" : "hidden"}><Chats ctx={ctx} /></Activity>
            )}
            {page === "library" && <Library ctx={ctx} remoteRequest={remoteRequest} onRemoteHandled={() => setRemoteRequest(0)} onRemoteClosed={() => {
              if (planRecovery !== "remote") return;
              setPlanRecovery("returning");
              setPage("tasks");
            }} />}
            {page === "publish" && <WebPublication ctx={ctx} />}
            {page === "account" && <Account ctx={ctx} />}
            {page === "tasks" && (
              <TasksPage
                tasks={tasks}
                boot={boot}
                tab={taskTab}
                onTabChange={setTaskTab}
                planLocation={planLocation}
                onPlanNavigate={setPlanLocation}
                onAccount={() => go("account")}
                onLibrary={() => go("library")}
                onRemote={() => { setPlanRecovery("remote"); go("remote"); }}
                restorePlanFocus={planRecovery === "returning"}
                onPlanFocusHandled={() => setPlanRecovery(null)}
                focusTaskId={taskFocus}
                onFocusHandled={() => setTaskFocus("")}
                onRefresh={refresh}
                onClear={() => setTasks((list) => list.filter((t) => t.state === "running"))}
                onDelete={(ids) => setTasks((list) => list.filter((t) => !ids.includes(t.id)))}
                toast={toast}
              />
            )}
            {page === "settings" && <SettingsPage ctx={ctx} />}
            {page === "diagnostics" && <Diagnostics ctx={ctx} />}
          </div>
        </main>
      </div>

      <AppTooltip />

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

      {toasts.length > 0 && (
        <div className="toast-stack" aria-live="polite">
          {toasts.map((item) => {
            const Icon = item.kind === "success" ? CheckCircle2 : item.kind === "error" ? XCircle : item.kind === "warning" ? AlertTriangle : Info;
            return (
              <div key={item.id} className={`toast-item ${item.kind}`} role={item.kind === "error" ? "alert" : "status"}>
                <span className="toast-icon"><Icon size={16} /></span>
                <div className="toast-body">
                  <span className="toast-text">{item.text}</span>
                  {item.action && (
                    <button className="toast-action" onClick={() => { item.action?.run(); dismissToast(item.id); }}>
                      {item.action.label} <ArrowRight size={11} />
                    </button>
                  )}
                </div>
                <button className="toast-close" aria-label="关闭通知" onClick={() => dismissToast(item.id)}>
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {downloadTarget && (
        <OnlineUpdateDialog
          target={downloadTarget}
          onClose={() => setDownloadTarget(null)}
          onStarted={(taskId) => { setDownloadTarget(null); if (taskId) openTask(taskId); }}
          toast={toast}
        />
      )}
    </div>
  );
}
