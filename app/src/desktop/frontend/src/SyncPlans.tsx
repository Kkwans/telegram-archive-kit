import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { AlertCircle, ArrowLeft, ArrowUpRight, CalendarClock, Check, CheckCircle2, ChevronDown, Clock, Database, FileText, Image, Loader2, Music, Pause, Pencil, Play, Plus, RefreshCw, Search, Square, Trash2, Video } from "lucide-react";
import { ConfirmDialog } from "./ConfirmDialog";
import { dateTime } from "./format";
import { call } from "./rpc";
import { Select } from "./Select";
import type { Bootstrap, OnlineChat, OnlineChats } from "./types";
import "./SyncPlans.css";

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
const WEEKDAY_OPTIONS = [1, 2, 3, 4, 5, 6, 0].map((day) => ({ value: String(day), label: `星期${WEEKDAYS[day]}` }));
const FREQUENCY_OPTIONS = [{ value: "daily", label: "每天" }, { value: "weekly", label: "每周" }];
const SCOPE_OPTIONS = [
  { value: "30d", label: "最近 30 天" },
  { value: "now", label: "从现在开始" },
  { value: "all", label: "全部历史" },
];
const CHAT_TYPES = [
  { value: "all", label: "全部类型" }, { value: "private", label: "私聊" },
  { value: "group", label: "群组" }, { value: "channel", label: "频道" }, { value: "bot", label: "机器人" },
];
const CHAT_LABELS = new Map(CHAT_TYPES.map((type) => [type.value, type.label]));
const MEDIA = [
  { kind: "image", label: "图片", icon: Image }, { kind: "video", label: "视频", icon: Video },
  { kind: "audio", label: "音频", icon: Music }, { kind: "file", label: "文件", icon: FileText },
] as const;

type MediaKind = typeof MEDIA[number]["kind"];
type FirstScope = "30d" | "now" | "all";
type Schedule = { frequency: "daily" | "weekly"; time: string; weekday?: number };
type PlanState = "idle" | "paused" | "queued" | "running" | "retrying" | "blocked" | "failed" | "stopping" | "stopped" | "succeeded";

interface Target {
  peer: string;
  slug?: string;
  name?: string;
  state?: PlanState;
  cursor?: number;
  lastSuccessAt?: string;
  addedMessages?: number;
  addedMedia?: number;
  missing?: number;
  taskId?: string;
  message?: string;
}

interface Draft {
  id?: string;
  name: string;
  schedule: Schedule;
  targets: Target[];
  enabled: boolean;
  firstScope: FirstScope;
  mediaKinds: MediaKind[];
  includeHistory: boolean;
}

interface Plan extends Draft {
  id: string;
  libraryId: string;
  libraryLabel: string;
  namespace: string;
  nextRunAt?: string;
  activeRunId?: string;
  state: PlanState;
  blockedReason?: string;
  message?: string;
}

interface PlanRun {
  id: string;
  planId: string;
  planName: string;
  trigger: string;
  state: PlanState;
  scheduledAt?: string;
  startedAt?: string;
  finishedAt?: string;
  retryAt?: string;
  message?: string;
  blockedReason?: string;
  targets?: Target[];
}

interface PlanList {
  plans?: Plan[];
  runs?: PlanRun[];
  currentLibraryId?: string;
  launchOnLogin: boolean;
  launchOnLoginError?: string;
  error?: string;
}

const STATES: Record<PlanState, { label: string; tone: string }> = {
  idle: { label: "待运行", tone: "" }, paused: { label: "已暂停", tone: "paused" },
  queued: { label: "排队中", tone: "running" }, running: { label: "运行中", tone: "running" },
  retrying: { label: "等待重试", tone: "partial" }, blocked: { label: "需要处理", tone: "partial" },
  failed: { label: "失败", tone: "failed" }, stopping: { label: "正在停止", tone: "running" }, stopped: { label: "已停止", tone: "stopped" },
  succeeded: { label: "完成", tone: "done" },
};

const REASONS: Record<string, string> = {
  library: "请打开此计划绑定的档案库后重试。",
  account: "请登录此计划绑定的 Telegram 账号后重试。",
  session: "Telegram 会话不可用。请重新登录后重试。",
  remote: "远程档案库暂不可用。请重新连接后重试。",
  readOnly: "档案库不可写。请检查目录权限后重试。",
  target: "有聊天不可用。请检查 Telegram 中的访问权限或编辑计划。",
  busy: "其他任务正在使用档案库。",
  space: "档案库可用空间不足。请释放空间后重试。",
  network: "Telegram 网络连接异常。",
  floodWait: "Telegram 限流。计划会在等待结束后继续。",
};

const PLAN_METHOD = {
  run: "syncPlanRunNow", pause: "syncPlanPause", resume: "syncPlanResume", stop: "syncPlanStop",
  retry: "syncPlanRetry", delete: "syncPlanDelete",
} as const;
type PlanAction = keyof typeof PLAN_METHOD;
const ACTION_MESSAGES: Record<PlanAction, string> = {
  run: "同步已加入队列", pause: "已暂停定时运行", resume: "已恢复定时运行", stop: "已请求停止本次运行",
  retry: "重试已加入队列", delete: "已删除同步计划",
};

function draftFromPlan(plan?: Plan): Draft {
  if (!plan) return { name: "", schedule: { frequency: "daily", time: "02:00", weekday: 1 }, targets: [], enabled: true, firstScope: "30d", mediaKinds: [], includeHistory: false };
  return { id: plan.id, name: plan.name, schedule: plan.schedule, targets: plan.targets ?? [], enabled: plan.enabled, firstScope: plan.firstScope || "30d", mediaKinds: plan.mediaKinds ?? [], includeHistory: plan.includeHistory };
}

function scheduleText(schedule: Schedule) {
  return `${schedule.frequency === "weekly" ? `每周${WEEKDAYS[schedule.weekday ?? 1]}` : "每天"} ${schedule.time}`;
}

function when(value: string | undefined, fallback: string) {
  return value && !value.startsWith("0001-") ? dateTime(value).replace(/:\d{2}$/, "") : fallback;
}

function mediaText(kinds: MediaKind[]) {
  const labels = MEDIA.filter((entry) => kinds.includes(entry.kind)).map((entry) => entry.label);
  return labels.length ? `消息 · ${labels.join("、")}` : "仅消息";
}

function Status({ state }: { state: PlanState }) {
  const entry = STATES[state] ?? { label: state, tone: "" };
  return <span className={`task-state plan-status ${entry.tone}`}>{state === "running" || state === "stopping" ? <Loader2 size={12} className="spin" /> : <span className="plan-status-dot" />}{entry.label}</span>;
}

export function SyncPlans({ boot, expandedPlan, onExpandPlan, onAccount, onLibrary, onRemote, onOpenTask, toast }: {
  boot: Bootstrap | null;
  expandedPlan: string;
  onExpandPlan: (id: string) => void;
  onAccount: () => void;
  onLibrary: () => void;
  onRemote: () => void;
  onOpenTask: (id: string) => void;
  toast: (message: string, error?: boolean) => void;
}) {
  const [data, setData] = useState<PlanList | null>(null);
  const [error, setError] = useState("");
  const [editor, setEditor] = useState<Plan | "new" | null>(null);
  const [busy, setBusy] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<Plan | null>(null);
  const request = useRef(0);
  const mutation = useRef(false);
  const createButton = useRef<HTMLButtonElement>(null);
  const editorOrigin = useRef<{ planId?: string }>({});

  const read = useCallback(async (signal?: AbortSignal) => {
    if (mutation.current) return;
    const seq = ++request.current;
    try {
      const result = await call<PlanList>("syncPlanList", undefined, signal);
      if (seq !== request.current || signal?.aborted) return;
      setData(result);
      setError("");
    } catch (e) {
      if (seq === request.current && !signal?.aborted) setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let timer = 0;
    const poll = async () => {
      if (!document.hidden) await read(controller.signal);
      if (!controller.signal.aborted) timer = window.setTimeout(poll, 4000);
    };
    void poll();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [read]);

  const mutate = async (key: string, method: string, params: unknown) => {
    if (mutation.current) return false;
    mutation.current = true;
    request.current++;
    setBusy(key);
    try {
      setData(await call<PlanList>(method, params));
      setError("");
      return true;
    } finally {
      mutation.current = false;
      setBusy("");
    }
  };

  const act = async (plan: Plan, action: PlanAction) => {
    try {
      if (!await mutate(`${plan.id}:${action}`, PLAN_METHOD[action], { id: plan.id })) return;
      if (action === "delete" && expandedPlan === plan.id) onExpandPlan("");
      toast(ACTION_MESSAGES[action]);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const closeEditor = () => {
    setEditor(null);
    requestAnimationFrame(() => {
      const origin = editorOrigin.current.planId;
      const editButton = origin ? document.getElementById(`sync-plan-edit-${origin}`) : null;
      const returnTarget = editButton instanceof HTMLButtonElement && editButton.disabled
        ? editButton.closest(".plan-item")?.querySelector<HTMLButtonElement>(".plan-row-title")
        : editButton;
      (returnTarget ?? createButton.current)?.focus({ preventScroll: true });
    });
  };

  const save = async (draft: Draft, runNow: boolean) => {
    const plan = { ...draft, name: draft.name.trim(), targets: draft.targets.map(({ peer, slug }) => ({ peer, slug })) };
    if (!await mutate("save", "syncPlanSave", { plan, runNow })) return;
    closeEditor();
    toast(runNow ? "已保存计划，同步已加入队列" : "已保存同步计划");
  };

  const toggleStartup = async (enabled: boolean) => {
    try {
      if (await mutate("startup", "syncPlanSetLaunchOnLogin", { enabled })) toast(enabled ? "已开启登录 Windows 后启动" : "已关闭登录 Windows 后启动");
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const runsByPlan = useMemo(() => {
    const map = new Map<string, PlanRun[]>();
    for (const run of data?.runs ?? []) {
      const list = map.get(run.planId);
      if (list) list.push(run);
      else map.set(run.planId, [run]);
    }
    return map;
  }, [data?.runs]);

  if (editor) return <PlanEditor plan={editor === "new" ? undefined : editor} boot={boot} currentLibraryId={data?.currentLibraryId} saving={busy === "save"} onAccount={onAccount} onCancel={closeEditor} onSave={save} />;

  const plans = data?.plans ?? [];
  return (
    <>
      <div className="plan-toolbar">
        <p>Telegram 新消息按计划归档到指定档案库。定时运行需要 Telegram 会话有效，且 TAK 正在运行。</p>
        <button ref={createButton} type="button" className="btn primary" disabled={!boot?.libraryRoot || !!busy} onClick={() => { editorOrigin.current = {}; setEditor("new"); }}><Plus size={15} /> 新建计划</button>
      </div>
      {(error || data?.error) && <div className="plan-inline-notice" role="alert"><AlertCircle size={15} /><span>{error || data?.error}</span><button type="button" className="btn sm ghost" onClick={() => void read()}><RefreshCw size={12} /> 重新读取</button></div>}
      {!data && !error && <div className="panel plan-loading" role="status" aria-label="正在读取同步计划">{[0, 1, 2].map((i) => <div key={i}><span className="skeleton-line w-160" /><span className="skeleton-line w-80" /></div>)}</div>}
      {data && (plans.length ? <section className="panel plan-list" aria-label="同步计划">
        <div className="plan-list-heading" aria-hidden="true"><span>计划 / 同步频率</span><span>状态</span><span>下次运行</span><span>最近运行</span><span>操作</span></div>
        {plans.map((plan) => {
          const runs = runsByPlan.get(plan.id) ?? [];
          const latest = runs[0];
          const active = !!plan.activeRunId;
          const expanded = expandedPlan === plan.id;
          const reason = plan.blockedReason || latest?.blockedReason;
          const canRetry = latest && (active ? latest.state === "blocked" : ["failed", "stopped"].includes(latest.state));
          const key = `sync-plan-${plan.id}`;
          return <article className="plan-item" key={plan.id}>
            <div className="plan-row">
              <button type="button" className="plan-row-title" aria-expanded={expanded} aria-controls={expanded ? key : undefined} onClick={() => onExpandPlan(expanded ? "" : plan.id)}>
                <span className="plan-row-icon"><CalendarClock size={17} /></span>
                <span className="plan-row-name"><b title={plan.name}>{plan.name}</b><span title={plan.libraryLabel}>{plan.targets?.length ?? 0} 个聊天 · {scheduleText(plan.schedule)}{plan.libraryLabel && ` · ${plan.libraryLabel}`}</span></span>
                <ChevronDown size={14} className="plan-row-chevron" />
              </button>
              <Status state={plan.state} />
              <div className="plan-row-time plan-next-run"><span className="plan-time-label">下次运行</span><b>{plan.enabled ? when(plan.nextRunAt, "待排程") : "已暂停"}</b></div>
              <div className="plan-row-time plan-last-run"><span className="plan-time-label">最近运行</span><b>{when(latest?.startedAt || latest?.scheduledAt, latest ? "等待开始" : "尚未运行")}</b>{latest && latest.state !== plan.state && <span className="plan-last-result">{STATES[latest.state]?.label ?? latest.state}</span>}</div>
              <div className="plan-row-actions">
                {canRetry ? <button type="button" className="btn sm ghost" disabled={!!busy} onClick={() => void act(plan, "retry")}><RefreshCw size={12} /> 重试</button> : active ? <button type="button" className="btn sm stop-action" disabled={!!busy || plan.state === "stopping"} onClick={() => void act(plan, "stop")}><Square size={12} /> 停止本次</button> : <button type="button" className="btn sm ghost" disabled={!!busy} onClick={() => void act(plan, "run")}><Play size={12} /> 立即运行</button>}
                <button type="button" className="icon-btn" disabled={!!busy} aria-label={plan.enabled ? "暂停定时运行" : "恢复定时运行"} title={plan.enabled ? "暂停定时运行" : "恢复定时运行"} onClick={() => void act(plan, plan.enabled ? "pause" : "resume")}>{plan.enabled ? <Pause size={14} /> : <Play size={14} />}</button>
              </div>
            </div>
            {expanded && <div id={key} className="plan-details">
              <div className="plan-detail-summary">
                <div><Database size={13} /><span>{plan.libraryLabel || "档案库"}</span><span>{mediaText(plan.mediaKinds ?? [])}{plan.includeHistory ? " · 补齐历史缺失媒体" : ""}</span></div>
                <div className="plan-row-actions">
                  {canRetry && (active ? <button type="button" className="btn sm stop-action" disabled={!!busy} onClick={() => void act(plan, "stop")}><Square size={12} /> 停止本次</button> : <button type="button" className="btn sm ghost" disabled={!!busy} onClick={() => void act(plan, "run")}><Play size={12} /> 立即运行</button>)}
                  <button id={`sync-plan-edit-${plan.id}`} type="button" className="btn sm ghost" disabled={!!busy || active} onClick={() => { editorOrigin.current = { planId: plan.id }; setEditor(plan); }}><Pencil size={12} /> 编辑</button>
                  <button type="button" className="icon-btn danger" disabled={!!busy || active} title="删除计划" aria-label={`删除计划 ${plan.name}`} onClick={() => setConfirmDelete(plan)}><Trash2 size={14} /></button>
                </div>
              </div>
              {(reason || plan.state === "failed") && <div className="plan-inline-notice" role="status">
                <AlertCircle size={15} /><span>{plan.message || latest?.message || REASONS[reason || ""] || "同步失败，请查看运行历史。"}</span>
                {(reason === "account" || reason === "session") && <button type="button" className="btn sm ghost" onClick={onAccount}>重新登录 <ArrowUpRight size={12} /></button>}
                {reason === "remote" && <button type="button" className="btn sm ghost" onClick={onRemote}>重新连接 <ArrowUpRight size={12} /></button>}
                {reason === "library" && <button type="button" className="btn sm ghost" onClick={onLibrary}>前往档案管理 <ArrowUpRight size={12} /></button>}
              </div>}
              <TargetTable targets={plan.targets ?? []} onOpenTask={onOpenTask} />
              <div className="plan-history">
                <div className="plan-field-heading"><h3>运行历史</h3><span>{runs.length} 次记录</span></div>
                {runs.length ? runs.map((run) => <RunRow key={run.id} run={run} onOpenTask={onOpenTask} />) : <p className="muted">计划运行后会在这里留下记录。</p>}
              </div>
            </div>}
          </article>;
        })}
      </section> : <section className="panel task-empty large">
        <CalendarClock size={28} /><p>还没有同步计划</p><span>选择聊天、同步内容与运行时间，让 TAK 按计划归档。</span>
      </section>)}
      {data && <section className="panel plan-startup">
        <label className="switch-row">
          <span><b>登录 Windows 后自动启动 TAK</b><em>让计划随 TAK 运行。关闭 TAK 后，计划暂停等待下次启动。</em></span>
          <span className={`switch ${data.launchOnLogin ? "on" : ""}`}><input type="checkbox" role="switch" checked={data.launchOnLogin} disabled={!!busy} onChange={(event) => void toggleStartup(event.target.checked)} /><i /></span>
        </label>
        {data.launchOnLoginError && <p className="plan-startup-error" role="alert">{data.launchOnLoginError}</p>}
      </section>}
      <ConfirmDialog compact open={!!confirmDelete} title={`删除计划「${confirmDelete?.name ?? ""}」？`} message="将停止定时运行。已归档的消息、媒体和任务记录会保留。" confirmLabel="删除计划" danger onCancel={() => setConfirmDelete(null)} onConfirm={() => { const plan = confirmDelete; setConfirmDelete(null); if (plan) void act(plan, "delete"); }} />
    </>
  );
}

function RunRow({ run, onOpenTask }: { run: PlanRun; onOpenTask: (id: string) => void }) {
  return <details className="plan-run">
    <summary>
      <ChevronDown size={13} className="plan-run-chevron" />
      <time>{when(run.startedAt || run.scheduledAt, "等待开始")}</time>
      <span>{run.trigger === "manual" ? "手动运行" : run.trigger === "retry" ? "重试" : "定时运行"}</span>
      <Status state={run.state} />
    </summary>
    {(run.message || run.blockedReason || run.retryAt) && <p className="plan-run-message">{run.message || REASONS[run.blockedReason || ""]}{run.retryAt && ` 下次重试 ${when(run.retryAt, "—")}。`}</p>}
    {!!run.targets?.length && <TargetTable targets={run.targets} onOpenTask={onOpenTask} />}
  </details>;
}

function TargetTable({ targets, onOpenTask }: { targets: Target[]; onOpenTask: (id: string) => void }) {
  if (!targets.length) return null;
  return <div className="plan-targets"><table className="table">
    <colgroup><col className="plan-target-chat-col" /><col className="plan-target-time-col" /><col className="plan-target-count-col" /><col className="plan-target-count-col" /><col className="plan-target-count-col" /><col className="plan-target-task-col" /></colgroup>
    <thead><tr><th>聊天</th><th>最近成功</th><th className="num">新增消息</th><th className="num">新增媒体</th><th className="num">仍缺失</th><th>任务</th></tr></thead>
    <tbody>{targets.map((target) => <tr key={target.peer}>
      <td><div className="plan-target-name"><b>{target.name || target.peer}</b>{target.state && <Status state={target.state} />}</div>{target.message && <small>{target.message}</small>}</td>
      <td>{when(target.lastSuccessAt, "—")}</td>
      <td className="num">{target.addedMessages?.toLocaleString() ?? "—"}</td>
      <td className="num">{target.addedMedia?.toLocaleString() ?? "—"}</td>
      <td className={`num ${target.missing ? "warn" : ""}`}>{target.missing?.toLocaleString() ?? "—"}</td>
      <td>{target.taskId ? <button type="button" className="plan-text-button" onClick={() => onOpenTask(target.taskId!)}>任务详情 <ArrowUpRight size={12} /></button> : "—"}</td>
    </tr>)}</tbody>
  </table></div>;
}

function PlanEditor({ plan, boot, currentLibraryId, saving, onAccount, onCancel, onSave }: {
  plan?: Plan;
  boot: Bootstrap | null;
  currentLibraryId?: string;
  saving: boolean;
  onAccount: () => void;
  onCancel: () => void;
  onSave: (draft: Draft, run: boolean) => Promise<void>;
}) {
  const [draft, setDraft] = useState(() => draftFromPlan(plan));
  const [mediaEnabled, setMediaEnabled] = useState(() => !!plan?.mediaKinds?.length);
  const [query, setQuery] = useState("");
  const [type, setType] = useState("all");
  const [onlySelected, setOnlySelected] = useState(false);
  const [chats, setChats] = useState<OnlineChat[]>([]);
  const [loading, setLoading] = useState(false);
  const [chatError, setChatError] = useState("");
  const [error, setError] = useState("");
  const [refreshSeq, setRefreshSeq] = useState(0);
  const [saveAndRun, setSaveAndRun] = useState(false);
  const [schedulePreview, setSchedulePreview] = useState<{ key: string; nextRunAt?: string; error?: string } | null>(null);
  const [initialLibrary] = useState(() => ({ key: boot?.libraryKey, root: boot?.libraryRoot }));
  const queryValue = useDeferredValue(query.trim().toLowerCase());
  const hasSession = !!boot?.hasSession;
  const libraryChanged = !plan && (boot?.libraryKey !== initialLibrary.key || boot?.libraryRoot !== initialLibrary.root);
  const boundLibraryOpen = !plan || plan.libraryId === currentLibraryId;
  const canFetchChats = hasSession && boundLibraryOpen && !libraryChanged;
  const libraryLabel = plan?.libraryLabel || initialLibrary.root || "尚未打开档案库";
  const selected = useMemo(() => new Set(draft.targets.map(({ peer }) => peer)), [draft.targets]);
  const { frequency, time, weekday } = draft.schedule;
  const validTime = /^\d{2}:\d{2}$/.test(time);
  const previewWeekday = frequency === "weekly" ? weekday ?? 1 : undefined;
  const previewKey = `${frequency}/${time}/${previewWeekday ?? ""}`;
  const preview = schedulePreview?.key === previewKey ? schedulePreview : null;

  useEffect(() => {
    if (!draft.enabled || !validTime) return;
    const controller = new AbortController();
    const { signal } = controller;
    const timer = window.setTimeout(() => {
      void call<{ nextRunAt: string }>("syncPlanPreviewSchedule", { schedule: { frequency, time, weekday: previewWeekday } }, signal).then((result) => {
        if (!signal.aborted) setSchedulePreview({ key: previewKey, nextRunAt: result.nextRunAt });
      }).catch((e: Error) => {
        if (!signal.aborted) setSchedulePreview({ key: previewKey, error: e.message });
      });
    }, 220);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [draft.enabled, frequency, time, previewWeekday, validTime, previewKey]);

  useEffect(() => {
    if (!canFetchChats) { setChats([]); setLoading(false); setChatError(""); return; }
    const controller = new AbortController();
    const { signal } = controller;
    let live = false;
    setLoading(true);
    setChatError("");
    void call<OnlineChats | null>("onlineChatsCached", undefined, signal).then((cached) => {
      if (!signal.aborted && !live && cached?.chats?.length) setChats(cached.chats);
    }).catch(() => undefined);
    void Promise.resolve().then(async () => {
      if (signal.aborted) return;
      try {
        const next = await call<OnlineChats>("onlineChats", { timeout: 35 }, signal);
        if (signal.aborted) return;
        live = true;
        if (!next.error || next.chats?.length) setChats(next.chats ?? []);
        if (next.error) setChatError(next.error);
      } catch (e) {
        if (!signal.aborted) setChatError((e as Error).message);
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    });
    return () => controller.abort();
  }, [canFetchChats, refreshSeq]);

  const allChats = useMemo(() => {
    const known = new Set(chats.map((chat) => chat.peer));
    return [...chats, ...draft.targets.filter((target) => !known.has(target.peer)).map((target) => ({ peer: target.peer, name: target.name || target.peer, type: "", username: "", localSlug: target.slug }))];
  }, [chats, draft.targets]);
  const visible = useMemo(() => allChats.filter((chat) =>
    (!onlySelected || selected.has(chat.peer)) && (type === "all" || chat.type === type) && (!queryValue || `${chat.name} ${chat.username ?? ""} ${chat.peer}`.toLowerCase().includes(queryValue))
  ), [allChats, onlySelected, selected, type, queryValue]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((prev) => ({ ...prev, [key]: value }));
  const toggle = (chat: (typeof allChats)[number]) => setDraft((prev) => ({ ...prev, targets: prev.targets.some(({ peer }) => peer === chat.peer) ? prev.targets.filter(({ peer }) => peer !== chat.peer) : [...prev.targets, { peer: chat.peer, slug: chat.localSlug, name: chat.name }] }));
  const canSave = !libraryChanged && !!draft.name.trim() && validTime && draft.targets.length > 0 && (!mediaEnabled || draft.mediaKinds.length > 0) && (!!plan || hasSession);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSave || saving) return;
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const run = submitter?.getAttribute("value") === "run";
    setError("");
    setSaveAndRun(run);
    try {
      await onSave({ ...draft, schedule: { frequency, time, weekday: previewWeekday }, mediaKinds: mediaEnabled ? draft.mediaKinds : [], includeHistory: mediaEnabled && draft.includeHistory }, run);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return <form className="plan-editor" onSubmit={(event) => void submit(event)}>
    <div className="plan-editor-title"><button type="button" className="btn ghost" disabled={saving} onClick={onCancel}><ArrowLeft size={14} /> 返回计划</button><h2>{plan ? "编辑同步计划" : "新建同步计划"}</h2></div>
    <fieldset className="plan-editor-fields" disabled={saving}>
      <div className="plan-editor-identity"><label className="field plan-name-field"><span>计划名称</span><input type="text" autoFocus required value={draft.name} maxLength={80} onChange={(event) => set("name", event.target.value)} placeholder="例如：每日频道归档" /></label><div className="plan-editor-library"><Database size={14} /><span>归档到 <b title={libraryLabel}>{libraryLabel}</b></span></div></div>
      <section className="panel plan-form-panel plan-chat-panel">
        <div className="plan-form-section">
          <div className="plan-field-heading"><h3>选择聊天</h3><span aria-live="polite">已选 <b>{draft.targets.length}</b> 个</span></div>
          <div className="plan-chat-toolbar">
            <label className="task-search"><Search size={14} /><input type="search" aria-label="搜索聊天" placeholder="搜索名称、用户名或聊天 ID" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
            <Select value={type} options={CHAT_TYPES} ariaLabel="按聊天类型筛选" onChange={setType} disabled={saving} />
            <label className="plan-check plan-show-selected"><input type="checkbox" checked={onlySelected} onChange={(event) => setOnlySelected(event.target.checked)} /> 仅看已选</label>
            <button type="button" className="icon-btn" aria-label="刷新聊天" title="刷新聊天" disabled={!canFetchChats || loading} onClick={() => setRefreshSeq((value) => value + 1)}><RefreshCw size={14} className={loading ? "spin" : ""} /></button>
          </div>
          {!hasSession && <div className="plan-inline-notice" role="status"><AlertCircle size={15} /><span>登录 Telegram 后可读取聊天列表。</span><button type="button" className="btn sm ghost" onClick={onAccount}>前往登录 <ArrowUpRight size={12} /></button></div>}
          {libraryChanged && <div className="plan-inline-notice" role="alert"><AlertCircle size={15} /><span>编辑期间切换了档案库。请返回后为当前档案库新建计划。</span></div>}
          {!boundLibraryOpen && <div className="plan-inline-notice" role="status"><AlertCircle size={15} /><span>打开此计划绑定的档案库后，可添加聊天。</span></div>}
          {chatError && <div className="plan-inline-notice" role="alert"><AlertCircle size={15} /><span>{chatError}</span></div>}
          <div className="plan-chat-list" aria-label="可选择的聊天">
            {loading && !visible.length ? <div className="plan-loading" role="status" aria-label="正在读取聊天">{[0, 1, 2].map((i) => <div key={i}><span className="skeleton-line w-160" /><span className="skeleton-line w-80" /></div>)}</div> : visible.length ? visible.map((chat) => {
              const checked = selected.has(chat.peer);
              return <button className="plan-chat-option" type="button" key={chat.peer} aria-pressed={checked} onClick={() => toggle(chat)}>
                <span className="plan-chat-identity"><b title={chat.name}>{chat.name}</b>{chat.username && <span className="plan-chat-username">@{chat.username}</span>}</span><span className="plan-chat-type">{CHAT_LABELS.get(chat.type) || chat.type || "聊天"}</span>{chat.localSlug && <span className="plan-chat-local"><CheckCircle2 size={12} /> 已归档</span>}<span className="plan-chat-selected" aria-hidden="true">{checked && <><Check size={12} />已选</>}</span>
              </button>;
            }) : <p className="plan-chat-empty">{!hasSession ? "登录后选择要同步的聊天。" : onlySelected ? "没有符合条件的已选聊天。" : "没有找到符合条件的聊天。"}</p>}
          </div>
          <div className="plan-chat-list-footer"><span>{loading ? "正在刷新聊天…" : `${visible.length} 个聊天`}</span>{(query || type !== "all" || onlySelected) && <button type="button" className="plan-text-button" onClick={() => { setQuery(""); setType("all"); setOnlySelected(false); }}>清除筛选</button>}</div>
        </div>
      </section>
      <section className="panel plan-form-panel plan-settings-panel">
        <div className="plan-form-section"><div className="plan-field-heading"><h3>运行时间</h3><span><Clock size={13} /> 本机时间</span></div>
          <div className="plan-schedule-fields">
            <div className="field"><span>重复</span><Select ariaLabel="重复频率" value={draft.schedule.frequency} options={FREQUENCY_OPTIONS} disabled={saving} onChange={(frequency) => set("schedule", { ...draft.schedule, frequency: frequency as Schedule["frequency"] })} /></div>
            {draft.schedule.frequency === "weekly" && <div className="field"><span>星期</span><Select ariaLabel="运行星期" value={String(draft.schedule.weekday ?? 1)} options={WEEKDAY_OPTIONS} disabled={saving} onChange={(weekday) => set("schedule", { ...draft.schedule, weekday: Number(weekday) })} /></div>}
            <label className="field"><span>时间</span><input type="time" required value={draft.schedule.time} onChange={(event) => set("schedule", { ...draft.schedule, time: event.target.value })} /></label>
          </div>
          <div className="plan-schedule-preview" aria-live="polite">
            <span>下次定时运行</span>
            <b title={preview?.error}>{!draft.enabled ? "计划已暂停" : !validTime ? "请选择时间" : preview?.error ? "暂时无法计算" : preview?.nextRunAt ? when(preview.nextRunAt, "待排程") : "正在计算…"}</b>
          </div>
        </div>
        <div className="plan-form-section"><div className="plan-field-heading"><h3>同步内容</h3></div>
          <div className="plan-content-choice" role="group" aria-label="同步内容">
            <label className="plan-check"><input type="radio" name="sync-plan-content" checked={!mediaEnabled} onChange={() => setMediaEnabled(false)} /> 仅消息</label>
            <label className="plan-check"><input type="radio" name="sync-plan-content" checked={mediaEnabled} onChange={() => setMediaEnabled(true)} /> 消息及所选媒体</label>
          </div>
          {mediaEnabled && <><div className="plan-media-options" role="group" aria-label="媒体类型">{MEDIA.map(({ kind, label, icon: Icon }) => <label className="plan-check" key={kind}><input type="checkbox" checked={draft.mediaKinds.includes(kind)} onChange={() => set("mediaKinds", draft.mediaKinds.includes(kind) ? draft.mediaKinds.filter((entry) => entry !== kind) : [...draft.mediaKinds, kind])} /><Icon size={14} /> {label}</label>)}</div>{draft.mediaKinds.length === 0 && <p className="plan-field-hint" role="status">请选择至少一种媒体类型。</p>}</>}
          <label className="plan-check plan-history-check"><input type="checkbox" disabled={!mediaEnabled || draft.mediaKinds.length === 0} checked={mediaEnabled && draft.mediaKinds.length > 0 && draft.includeHistory} onChange={(event) => set("includeHistory", event.target.checked)} /> 同时补齐已归档消息中缺失的所选媒体</label>
        </div>
        <div className="plan-form-section"><div className="plan-field-heading"><h3>首次范围</h3></div><Select ariaLabel="首次归档范围" value={draft.firstScope} options={SCOPE_OPTIONS} disabled={saving} onChange={(scope) => set("firstScope", scope as FirstScope)} /><p className="muted">用于未归档的聊天。已归档的聊天从已有记录继续同步。</p></div>
      </section>
    </fieldset>
    <section className="panel plan-editor-footer">
      <div className="plan-editor-summary"><Database size={15} /><div><b title={libraryLabel}>{libraryLabel}</b><span>{draft.targets.length} 个聊天 · {scheduleText(draft.schedule)} · {mediaText(mediaEnabled ? draft.mediaKinds : [])} · 首次范围 {SCOPE_OPTIONS.find((scope) => scope.value === draft.firstScope)?.label}{mediaEnabled && draft.mediaKinds.length > 0 && draft.includeHistory && " · 补齐历史缺失媒体"}</span></div></div>
      {error && <div className="plan-inline-notice" role="alert"><AlertCircle size={15} /><span>{error}</span></div>}
      <div className="plan-row-actions">
        <button type="button" className="btn ghost" disabled={saving} onClick={onCancel}>取消</button>
        <button type="submit" className="btn ghost" value="save" disabled={saving || !canSave}>{saving && !saveAndRun && <Loader2 size={13} className="spin" />} 保存</button>
        <button type="submit" className="btn primary" value="run" disabled={saving || !canSave || !hasSession}>{saving && saveAndRun ? <Loader2 size={13} className="spin" /> : <Play size={13} />} 保存并立即运行</button>
      </div>
    </section>
  </form>;
}
