import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { AlertCircle, ArrowLeft, ArrowUpRight, CalendarCheck, CalendarClock, Check, CheckCircle2, ChevronLeft, ChevronRight, Clock, Database, Ellipsis, FileText, Image, ListFilter, Loader2, Megaphone, MessageCircle, Music, Pause, Pencil, Play, Plus, RefreshCw, Search, Square, Trash2, UsersRound, Video } from "lucide-react";
import { ConfirmDialog } from "./ConfirmDialog";
import { dateTime, duration } from "./format";
import { matchesOnlineChatFilter, matchesOnlineChatSearch, ONLINE_CHAT_FILTERS, onlineChatTypeMeta, type OnlineChatFilter } from "./onlineChatFilters";
import { call } from "./rpc";
import { Select } from "./Select";
import type { Bootstrap, OnlineChat, OnlineChats } from "./types";
import "./SyncPlans.css";

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const CHAT_PAGE_SIZE = 30;
const FREQUENCY_OPTIONS = [{ value: "daily", label: "每天" }, { value: "weekly", label: "每周" }];
const SCOPE_OPTIONS = [
  { value: "30d", label: "最近 30 天" },
  { value: "now", label: "从现在开始" },
  { value: "all", label: "全部历史" },
];
const ARCHIVE_FILTERS = ONLINE_CHAT_FILTERS.map(({ key, label }) => ({ value: key, label: key === "all" ? "全部聊天" : label }));
const MEDIA = [
  { kind: "image", label: "图片", icon: Image }, { kind: "video", label: "视频", icon: Video },
  { kind: "audio", label: "音频", icon: Music }, { kind: "file", label: "文件", icon: FileText },
] as const;

type MediaKind = typeof MEDIA[number]["kind"];
type FirstScope = "30d" | "now" | "all";
type Schedule = { frequency: "daily" | "weekly"; time: string; weekday?: number; weekdays?: number[] };
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
  if (!plan) return { name: "", schedule: { frequency: "daily", time: "02:00", weekday: 1 }, targets: [], enabled: true, firstScope: "all", mediaKinds: MEDIA.map(({ kind }) => kind), includeHistory: false };
  return { id: plan.id, name: plan.name, schedule: plan.schedule, targets: plan.targets ?? [], enabled: plan.enabled, firstScope: plan.firstScope || "30d", mediaKinds: plan.mediaKinds ?? [], includeHistory: plan.includeHistory };
}

function scheduleText(schedule: Schedule) {
  if (schedule.frequency === "daily") return `每天 ${schedule.time}`;
  const days = schedule.weekdays ?? [schedule.weekday ?? 1];
  const names = WEEKDAY_ORDER.filter((day) => days.includes(day)).map((day) => WEEKDAYS[day]);
  return names.length ? `每周${names.join("、")} ${schedule.time}` : "请选择执行日";
}

function when(value: string | undefined, fallback: string) {
  return value && !value.startsWith("0001-") ? dateTime(value).replace(/:\d{2}$/, "") : fallback;
}

function mediaText(kinds: MediaKind[]) {
  const labels = MEDIA.filter((entry) => kinds.includes(entry.kind)).map((entry) => entry.label);
  return labels.length ? `消息 · ${labels.join("、")}` : "仅消息";
}

function Status({ state, label }: { state: PlanState; label?: string }) {
  const entry = STATES[state] ?? { label: state, tone: "" };
  return <span className={`task-state plan-status ${entry.tone}`}>{state === "running" || state === "stopping" ? <Loader2 size={12} className="spin" /> : <span className="plan-status-dot" />}{label ?? entry.label}</span>;
}

export interface SyncPlanLocation {
  planId: string;
  runId?: string;
  failedOnly?: boolean;
}

type RunAction = "retry" | "stop" | "run";
const RUN_ACTIONS = {
  retry: { label: "重试失败项", icon: RefreshCw },
  stop: { label: "停止本次", icon: Square },
  run: { label: "立即运行", icon: Play },
};

function planRunAction(plan: Plan, latest?: PlanRun): RunAction {
  if (latest && (plan.activeRunId ? latest.state === "blocked" : latest.state === "failed" || latest.state === "stopped")) return "retry";
  return plan.activeRunId ? "stop" : "run";
}

function PlanRunButton({ action, primary, disabled, onAct }: { action: RunAction; primary?: boolean; disabled: boolean; onAct: (action: PlanAction) => void }) {
  const { label, icon: Icon } = RUN_ACTIONS[action];
  return <button type="button" className={`btn ${action === "stop" ? "stop-action" : primary ? "primary" : "sm"}`}
    data-tip={action === "retry" ? "重试最近一轮的失败项" : undefined} disabled={disabled} onClick={() => onAct(action)}>
    <Icon size={14} /> {action === "retry" && !primary ? "重试" : label}
  </button>;
}

function PlanSecondaryActions({ plan, action, busy, onAct, onDelete, inline = false }: {
  plan: Plan;
  action: RunAction;
  busy: boolean;
  onAct: (action: PlanAction) => void;
  onDelete: () => void;
  inline?: boolean;
}) {
  return <>
    {action === "retry" && <button type="button" className={inline ? "btn ghost" : undefined} disabled={busy} onClick={() => onAct(plan.activeRunId ? "stop" : "run")}>
      {plan.activeRunId ? <><Square size={14} /> 停止本次</> : <><Play size={14} /> 立即运行</>}
    </button>}
    <button type="button" className={inline ? "btn ghost" : undefined} disabled={busy} onClick={() => onAct(plan.enabled ? "pause" : "resume")}>
      {plan.enabled ? <><Pause size={14} /> 暂停计划</> : <><CalendarCheck size={14} /> 恢复计划</>}
    </button>
    <button type="button" className={inline ? "btn danger" : "danger"} disabled={busy || !!plan.activeRunId} onClick={onDelete}><Trash2 size={14} /> 删除计划</button>
  </>;
}

function PlanMoreActions({ plan, action, busy, onAct, onEdit, onDelete }: {
  plan: Plan;
  action: RunAction;
  busy: boolean;
  onAct: (action: PlanAction) => void;
  onEdit?: () => void;
  onDelete: () => void;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);
  const run = (callback: () => void) => {
    if (menu.current) menu.current.open = false;
    trigger.current?.focus({ preventScroll: true });
    callback();
  };
  return <details className="plan-more" ref={menu}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false; }}
    onKeyDown={(event) => {
      if (event.key !== "Escape" || !event.currentTarget.open) return;
      event.stopPropagation();
      event.currentTarget.open = false;
      trigger.current?.focus();
    }}>
    <summary className="btn sm ghost" ref={trigger} aria-label={`${plan.name}的更多操作`}><Ellipsis size={15} aria-hidden="true" /> 更多</summary>
    <div className="plan-more-menu">
      {onEdit && <button type="button" disabled={busy || !!plan.activeRunId} onClick={() => run(onEdit)}><Pencil size={14} /> 编辑计划</button>}
      <PlanSecondaryActions plan={plan} action={action} busy={busy} onAct={(value) => run(() => onAct(value))} onDelete={() => run(onDelete)} />
    </div>
  </details>;
}

export function SyncPlans({ boot, location, onNavigate, onAccount, onLibrary, onRemote, onOpenTask, restoreRecoveryFocus, onRecoveryFocusHandled, toast }: {
  boot: Bootstrap | null;
  location: SyncPlanLocation | null;
  onNavigate: (location: SyncPlanLocation | null) => void;
  onAccount: () => void;
  onLibrary: () => void;
  onRemote: () => void;
  onOpenTask: (id: string) => void;
  restoreRecoveryFocus: boolean;
  onRecoveryFocusHandled: () => void;
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
      if (action === "delete" && location?.planId === plan.id) onNavigate(null);
      toast(ACTION_MESSAGES[action]);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const closeEditor = () => {
    setEditor(null);
    requestAnimationFrame(() => {
      const origin = typeof editor === "object" ? editor?.id : undefined;
      const editButton = origin ? document.getElementById(`sync-plan-edit-${origin}`) : createButton.current;
      (editButton instanceof HTMLButtonElement && !editButton.disabled ? editButton : document.getElementById("sync-plan-heading"))?.focus({ preventScroll: true });
    });
  };

  const save = async (draft: Draft, runNow: boolean) => {
    const plan = { ...draft, name: draft.name.trim(), targets: draft.targets.map(({ peer, slug }) => ({ peer, slug })) };
    if (!await mutate("save", "syncPlanSave", { plan, runNow })) return;
    closeEditor();
    toast(runNow ? "已保存计划，同步已加入队列" : "已保存同步计划");
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

  const plans = data?.plans ?? [];
  const selectedPlan = plans.find((plan) => plan.id === location?.planId);
  useEffect(() => {
    if (!restoreRecoveryFocus || !data) return;
    const target = document.getElementById("sync-plan-recovery") ?? document.getElementById("sync-plan-heading");
    target?.focus();
    onRecoveryFocusHandled();
  }, [restoreRecoveryFocus, data, onRecoveryFocusHandled]);

  const openPlan = (plan: Plan) => {
    onNavigate({ planId: plan.id });
    document.querySelector(".scroll")?.scrollTo({ top: 0 });
    requestAnimationFrame(() => document.getElementById("sync-plan-heading")?.focus({ preventScroll: true }));
  };
  const closePlan = () => {
    onNavigate(null);
    requestAnimationFrame(() => (document.getElementById(`sync-plan-open-${location?.planId}`) ?? createButton.current)?.focus());
  };
  const errorNotice = (error || data?.error) && <div className="plan-inline-notice" role="alert"><AlertCircle size={15} /><span>{error || data?.error}</span><button type="button" className="btn sm ghost" onClick={() => void read()}><RefreshCw size={12} /> 重新读取</button></div>;
  const deletion = <ConfirmDialog compact open={!!confirmDelete} title={`删除计划「${confirmDelete?.name ?? ""}」？`} message="将停止定时运行。已归档的消息、媒体和任务记录会保留。" confirmLabel="删除计划" danger onCancel={() => setConfirmDelete(null)} onConfirm={() => { const plan = confirmDelete; setConfirmDelete(null); if (plan) void act(plan, "delete"); }} />;

  if (editor) return <PlanEditor plan={editor === "new" ? undefined : editor} boot={boot} currentLibraryId={data?.currentLibraryId} saving={busy === "save"} onAccount={onAccount} onCancel={closeEditor} onSave={save} />;
  if (location) return <section className="plan-subpage">
    {errorNotice}
    {selectedPlan ? <PlanDetails plan={selectedPlan} runs={runsByPlan.get(selectedPlan.id) ?? []} location={location} busy={!!busy}
      onNavigate={onNavigate} onBack={closePlan} onEdit={() => setEditor(selectedPlan)} onAct={(action) => void act(selectedPlan, action)}
      onDelete={() => setConfirmDelete(selectedPlan)} onAccount={onAccount} onLibrary={onLibrary} onRemote={onRemote} onOpenTask={onOpenTask} /> : <>
      <header className="plan-detail-title-line"><button type="button" className="icon-btn plan-page-back" onClick={closePlan} aria-label="返回同步计划" data-tip="返回同步计划"><ArrowLeft size={17} /></button><h1 id="sync-plan-heading" tabIndex={-1}>同步计划</h1></header>
      {data ? <div className="panel task-empty"><p>该同步计划已不存在。</p></div> :
        !error && <div className="panel plan-loading" role="status" aria-label="正在读取同步计划"><div><span className="skeleton-line w-160" /><span className="skeleton-line w-80" /></div></div>}
    </>}
    {deletion}
  </section>;

  return <>
    <div className="plan-toolbar">
      {data && <p>{plans.length} 个计划 <span aria-hidden="true">·</span> {plans.filter((plan) => plan.enabled).length} 个已启用</p>}
      <button ref={createButton} type="button" className="btn primary" disabled={!boot?.libraryRoot || !!busy} onClick={() => setEditor("new")}><Plus size={15} /> 新建计划</button>
    </div>
    {errorNotice}
    {!data && !error && <div className="panel plan-loading" role="status" aria-label="正在读取同步计划">{[0, 1, 2].map((i) => <div key={i}><span className="skeleton-line w-160" /><span className="skeleton-line w-80" /></div>)}</div>}
    {data && (plans.length ? <section className="panel plan-list" aria-label="同步计划">
      <div className="plan-list-heading" aria-hidden="true"><span>计划 / 同步频率</span><span>状态</span><span>下次运行</span><span>最近运行</span><span>操作</span></div>
      {plans.map((plan) => {
        const latest = runsByPlan.get(plan.id)?.[0];
        const action = planRunAction(plan, latest);
        return <article className="plan-item" key={plan.id}>
          <div className="plan-row">
            <button id={`sync-plan-open-${plan.id}`} type="button" className="plan-row-title" onClick={() => openPlan(plan)}>
              <span className="plan-row-icon"><CalendarClock size={17} /></span>
              <span className="plan-row-name"><b data-tip={plan.name}>{plan.name}</b><span className="plan-row-meta" data-tip={plan.libraryLabel}>{plan.targets?.length ?? 0} 个聊天 · {scheduleText(plan.schedule)}{plan.libraryLabel && ` · ${plan.libraryLabel}`}</span></span>
            </button>
            <Status state={plan.state} />
            <div className="plan-row-time plan-next-run"><span className="plan-time-label">下次运行</span><b>{plan.enabled ? when(plan.nextRunAt, "待排程") : "已暂停"}</b></div>
            <div className="plan-row-time plan-last-run"><span className="plan-time-label">最近运行</span><b>{when(latest?.startedAt || latest?.scheduledAt, latest ? "等待开始" : "尚未运行")}</b>{latest && latest.state !== plan.state && <span className="plan-last-result">{STATES[latest.state]?.label ?? latest.state}</span>}</div>
            <div className="plan-row-actions">
              <PlanRunButton action={action} disabled={!!busy || plan.state === "stopping"} onAct={(value) => void act(plan, value)} />
              <PlanMoreActions plan={plan} action={action} busy={!!busy} onAct={(value) => void act(plan, value)}
                onEdit={() => { onNavigate({ planId: plan.id }); setEditor(plan); }} onDelete={() => setConfirmDelete(plan)} />
            </div>
          </div>
        </article>;
      })}
    </section> : <section className="panel task-empty large">
      <CalendarClock size={28} /><p>还没有同步计划</p><span>选择聊天、同步内容与运行时间，让 TAK 按计划归档。</span>
    </section>)}
    {deletion}
  </>;
}

function runTrigger(run: PlanRun) {
  return run.trigger === "manual" ? "手动运行" : run.trigger === "retry" ? "重试" : "定时运行";
}

function runDate(run: PlanRun) {
  return when(run.startedAt || run.scheduledAt, "等待开始");
}

function runTargets(run: PlanRun, runs: PlanRun[]) {
  const targets = run.targets ?? [];
  const missing = new Set(targets.filter((target) => !target.lastSuccessAt).map((target) => target.peer));
  if (!missing.size) return targets;
  const recovered = new Map<string, string>();
  for (const previous of runs.slice(runs.indexOf(run) + 1)) {
    for (const target of previous.targets ?? []) {
      if (target.lastSuccessAt && missing.delete(target.peer)) recovered.set(target.peer, target.lastSuccessAt);
    }
    if (!missing.size) break;
  }
  return targets.map((target) => recovered.has(target.peer) ? { ...target, lastSuccessAt: recovered.get(target.peer) } : target);
}

function PlanDetails({ plan, runs, location, busy, onNavigate, onBack, onEdit, onAct, onDelete, onAccount, onLibrary, onRemote, onOpenTask }: {
  plan: Plan;
  runs: PlanRun[];
  location: SyncPlanLocation;
  busy: boolean;
  onNavigate: (location: SyncPlanLocation) => void;
  onBack: () => void;
  onEdit: () => void;
  onAct: (action: PlanAction) => void;
  onDelete: () => void;
  onAccount: () => void;
  onLibrary: () => void;
  onRemote: () => void;
  onOpenTask: (id: string) => void;
}) {
  const latest = runs[0];
  const mediaKinds = plan.mediaKinds ?? [];
  const historyMediaStatus = mediaKinds.length === 0 ? "不适用" : plan.includeHistory ? "已开启" : "未开启";
  const failedOnly = !!runs.length && !!location.failedOnly;
  const visible = failedOnly ? runs.filter((run) => run.state === "failed") : runs;
  const run = visible.find((item) => item.id === location.runId) ?? visible[0];
  const action = planRunAction(plan, latest);
  const currentReason = plan.blockedReason !== latest?.blockedReason ? plan.blockedReason : undefined;
  const recoveryFor = (reason?: string) => reason === "remote" ? { label: "重连档案库", open: onRemote } :
    reason === "library" ? { label: "前往档案管理", open: onLibrary } :
    reason === "account" || reason === "session" ? { label: "重新登录", open: onAccount } : null;
  const currentRecovery = recoveryFor(currentReason);
  const recovery = run && run.id === latest?.id && !currentRecovery ? recoveryFor(run.blockedReason) : null;
  const message = run?.message || REASONS[run?.blockedReason || ""];
  const targets = useMemo(() => run ? runTargets(run, runs) : [], [run, runs]);
  const failedCount = targets.filter((target) => target.state === "failed").length;
  const elapsed = run?.startedAt && run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.startedAt) : 0;
  const selectRun = (runId: string) => onNavigate({ ...location, runId });
  const filterRuns = (failedOnly: boolean) => {
    const next = failedOnly && run?.state !== "failed" ? runs.find((item) => item.state === "failed") : run;
    onNavigate({ ...location, failedOnly, runId: next?.id ?? location.runId });
  };

  return <>
    <div className="plan-detail-toolbar" role="group" aria-label="计划操作">
      <button type="button" className="btn ghost plan-detail-back" onClick={onBack}><ArrowLeft size={15} /> 返回同步计划</button>
      <div className="plan-row-actions plan-detail-actions">
        <button id={`sync-plan-edit-${plan.id}`} type="button" className="btn" disabled={busy || !!plan.activeRunId} onClick={onEdit}><Pencil size={14} /> 编辑计划</button>
        <PlanSecondaryActions plan={plan} action={action} busy={busy} onAct={onAct} onDelete={onDelete} inline />
        <PlanRunButton primary action={action} disabled={busy || plan.state === "stopping"} onAct={onAct} />
      </div>
    </div>
    <header className="panel plan-detail-heading">
      <div className="plan-detail-title-line">
        <h1 id="sync-plan-heading" tabIndex={-1}>{plan.name}</h1>
      </div>
      <dl className="plan-detail-meta">
        <div>
          <dt><Database size={15} aria-hidden="true" />目标档案库</dt>
          <dd className="plan-detail-library" data-tip={plan.libraryLabel}>{plan.libraryLabel || "档案库"}</dd>
          <dd>{plan.targets?.length ?? 0} 个聊天</dd>
        </div>
        <div>
          <dt><CalendarClock size={15} aria-hidden="true" />运行时间</dt>
          <dd>{scheduleText(plan.schedule)}</dd>
          <dd>{plan.enabled ? `下次运行 ${when(plan.nextRunAt, "待排程")}` : "定时运行已暂停"}</dd>
        </div>
        <div>
          <dt><MessageCircle size={15} aria-hidden="true" />同步内容</dt>
          <dd>{mediaText(mediaKinds)}</dd>
          <dd>历史媒体补齐 · {historyMediaStatus}</dd>
        </div>
      </dl>
    </header>
    {currentReason && <div className="plan-inline-notice plan-run-notice" role="status">
      <AlertCircle size={16} /><span>{plan.message || REASONS[currentReason]}</span>
      {currentRecovery && <button id="sync-plan-recovery" type="button" className="btn sm ghost" onClick={() => { if (run) selectRun(run.id); currentRecovery.open(); }}>{currentRecovery.label} <ArrowUpRight size={13} /></button>}
    </div>}
    <div className="plan-history-heading"><h2>运行历史</h2>{!!runs.length && <span aria-live="polite">{failedOnly ? `${visible.length} / ` : ""}{runs.length} 轮</span>}</div>
    {runs.length ? <div className="plan-history">
      <aside className="panel plan-run-nav" aria-label="运行记录">
        <h3>运行记录</h3>
        <div className="plan-run-filter" role="group" aria-label="筛选运行记录">
          <button type="button" aria-pressed={!failedOnly} onClick={() => filterRuns(false)}>全部运行</button>
          <button type="button" aria-pressed={failedOnly} onClick={() => filterRuns(true)}>失败运行</button>
        </div>
        <div className="plan-run-options">
          {visible.map((item) => <button key={item.id} type="button" className="plan-run-option" aria-pressed={run?.id === item.id} onClick={() => selectRun(item.id)}>
            <time>{runDate(item)}</time><span><small>{runTrigger(item)}{item === latest && " · 最新"}</small><Status state={item.state} /></span>
          </button>)}
        </div>
        {!!run && <div className="plan-run-compact"><Select ariaLabel="选择运行记录" options={visible.map((item) => ({ value: item.id, label: `${runDate(item)} · ${STATES[item.state]?.label ?? item.state}` }))} value={run.id} onChange={selectRun} /></div>}
      </aside>
      {run ? <section className="panel plan-run-result" aria-label="本轮运行结果">
        <header><div><h3>本轮运行结果</h3><p><time>{runDate(run)}</time> · {runTrigger(run)}{elapsed > 0 && ` · 耗时 ${duration(elapsed).replace(/h/g, " 小时").replace(/m/g, " 分").replace(/s/g, " 秒")}`}</p></div>
          <Status state={run.state} label={run.state === "failed" && failedCount ? `${failedCount} 个聊天失败` : undefined} />
        </header>
        {(message || run.retryAt) && <div className="plan-inline-notice plan-run-notice" role="status">
          <AlertCircle size={16} /><span>{message}{run.retryAt && ` 下次重试 ${when(run.retryAt, "待排程")}。`}</span>
          {recovery && <button id="sync-plan-recovery" type="button" className="btn sm ghost" onClick={() => { selectRun(run.id); recovery.open(); }}>{recovery.label} <ArrowUpRight size={13} /></button>}
        </div>}
        {!!targets.length && <dl className="plan-run-totals" aria-label="本轮汇总">
          {([{ field: "addedMessages", label: "新增消息", unit: "条" }, { field: "addedMedia", label: "新增媒体", unit: "个" }, { field: "missing", label: "剩余缺失", unit: "个" }] as const).map(({ field, label, unit }) => {
            const total = targets.reduce((sum, target) => sum + (target[field] ?? 0), 0);
            return <div key={field}><dt>{label}</dt><dd className={field === "missing" && total > 0 ? "warn" : undefined}>{total.toLocaleString()} <span>{unit}</span></dd></div>;
          })}
        </dl>}
        {targets.length ? <>
          <div className="plan-results-heading"><h4>聊天结果</h4><span>{targets.length.toLocaleString()} 个聊天</span></div>
          <TargetTable targets={targets} onOpenTask={(id) => { selectRun(run.id); onOpenTask(id); }} />
        </> : <p className="plan-run-empty muted">本轮还没有逐聊天结果。</p>}
      </section> : <div className="panel plan-run-empty task-empty"><p>没有失败的运行记录</p><button type="button" className="btn sm" onClick={() => filterRuns(false)}>查看全部结果</button></div>}
    </div> : <>
      <div className="panel task-empty"><p>计划尚未运行</p><span>运行后可在这里查看逐聊天结果与任务详情。</span></div>
      <TargetTable targets={plan.targets ?? []} onOpenTask={onOpenTask} />
    </>}
  </>;
}

function TargetTable({ targets, onOpenTask }: { targets: Target[]; onOpenTask: (id: string) => void }) {
  if (!targets.length) return null;
  return <div className="plan-targets" tabIndex={0} aria-label="逐聊天归档结果"><table className="table">
    <colgroup><col className="plan-target-chat-col" /><col className="plan-target-status-col" /><col className="plan-target-count-col" /><col className="plan-target-count-col" /><col className="plan-target-count-col" /><col className="plan-target-time-col" /><col className="plan-target-task-col" /></colgroup>
    <thead><tr><th scope="col">聊天</th><th scope="col">状态</th><th scope="col" className="num">新增消息</th><th scope="col" className="num">新增媒体</th><th scope="col" className="num">缺失</th><th scope="col">上次成功</th><th scope="col">任务记录</th></tr></thead>
    <tbody>{targets.map((target) => <tr key={target.peer}>
      <td><div className="plan-target-name"><b>{target.name || target.peer}</b></div>{target.message && <small>{target.message}</small>}</td>
      <td>{target.state ? <Status state={target.state} /> : "—"}</td>
      <td className="num">{target.addedMessages?.toLocaleString() ?? "—"}</td>
      <td className="num">{target.addedMedia?.toLocaleString() ?? "—"}</td>
      <td className={`num ${target.missing ? "warn" : ""}`}>{target.missing?.toLocaleString() ?? "—"}</td>
      <td>{when(target.lastSuccessAt, "—")}</td>
      <td>{target.taskId ? <button type="button" className="plan-text-button" onClick={() => onOpenTask(target.taskId!)}>查看任务</button> : "—"}</td>
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
  const [mediaEnabled, setMediaEnabled] = useState(() => !plan || !!plan.mediaKinds?.length);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<OnlineChatFilter>("all");
  const [folderId, setFolderId] = useState<number | null>(null);
  const [onlySelected, setOnlySelected] = useState(false);
  const [chatPage, setChatPage] = useState(1);
  const chatList = useRef<HTMLDivElement>(null);
  const [online, setOnline] = useState<OnlineChats | null>(null);
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
  const { frequency, time, weekday, weekdays } = draft.schedule;
  const validTime = /^\d{2}:\d{2}$/.test(time);
  const selectedDays = useMemo(() => weekdays ?? [weekday ?? 1], [weekdays, weekday]);
  const previewDays = frequency === "weekly" ? selectedDays : undefined;
  const validDays = frequency === "daily" || selectedDays.length > 0;
  const previewKey = `${frequency}/${time}/${previewDays?.join(",") ?? ""}`;
  const preview = schedulePreview?.key === previewKey ? schedulePreview : null;

  useEffect(() => {
    if (!draft.enabled || !validTime || !validDays) return;
    const controller = new AbortController();
    const { signal } = controller;
    const timer = window.setTimeout(() => {
      void call<{ nextRunAt: string }>("syncPlanPreviewSchedule", { schedule: { frequency, time, weekdays: previewDays } }, signal).then((result) => {
        if (!signal.aborted) setSchedulePreview({ key: previewKey, nextRunAt: result.nextRunAt });
      }).catch((e: Error) => {
        if (!signal.aborted) setSchedulePreview({ key: previewKey, error: e.message });
      });
    }, 220);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [draft.enabled, frequency, time, previewDays, validTime, validDays, previewKey]);

  useEffect(() => {
    if (!canFetchChats) { setOnline(null); setLoading(false); setChatError(""); return; }
    const controller = new AbortController();
    const { signal } = controller;
    let live = false;
    setLoading(true);
    setChatError("");
    void call<OnlineChats | null>("onlineChatsCached", undefined, signal).then((cached) => {
      if (!signal.aborted && !live && cached?.chats?.length) setOnline(cached);
    }).catch(() => undefined);
    void Promise.resolve().then(async () => {
      if (signal.aborted) return;
      try {
        const next = await call<OnlineChats>("onlineChats", { timeout: 35 }, signal);
        if (signal.aborted) return;
        live = true;
        if (!next.error || next.chats?.length) setOnline(next);
        if (next.error) setChatError(next.error);
      } catch (e) {
        if (!signal.aborted) setChatError((e as Error).message);
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    });
    return () => controller.abort();
  }, [canFetchChats, refreshSeq]);

  const allChats = useMemo<Array<Omit<OnlineChat, "id" | "hasPhoto"> & { id?: number }>>(() => {
    const chats = online?.chats ?? [];
    const known = new Set(chats.map((chat) => chat.peer));
    return [...chats, ...draft.targets.filter((target) => !known.has(target.peer)).map((target) => ({ peer: target.peer, name: target.name || target.peer, type: "", username: "", localSlug: target.slug }))];
  }, [online?.chats, draft.targets]);
  const activeFolder = online?.folders?.find((folder) => folder.id === folderId);
  const folderPeers = useMemo(() => activeFolder ? new Set(activeFolder.peers) : null, [activeFolder]);
  const filterOptions = useMemo(() => [
    ...ARCHIVE_FILTERS,
    ...(online?.folders ?? []).map((folder) => ({ value: `folder:${folder.id}`, label: `分组 · ${folder.title}` })),
  ], [online?.folders]);
  const visible = useMemo(() => allChats.filter((chat) =>
    (!onlySelected || selected.has(chat.peer)) &&
    (folderPeers ? folderPeers.has(chat.peer) : matchesOnlineChatFilter(chat, filter)) &&
    matchesOnlineChatSearch(chat, queryValue)
  ), [allChats, onlySelected, selected, filter, folderPeers, queryValue]);
  const pages = Math.max(1, Math.ceil(visible.length / CHAT_PAGE_SIZE));
  const page = Math.min(chatPage, pages);
  const firstChat = (page - 1) * CHAT_PAGE_SIZE;
  const pageChats = visible.slice(firstChat, firstChat + CHAT_PAGE_SIZE);
  const filtered = !!query || filter !== "all" || !!activeFolder || onlySelected;
  useLayoutEffect(() => {
    if (chatList.current) chatList.current.scrollTop = 0;
  }, [page, queryValue, filter, activeFolder?.id, onlySelected]);

  const changeFilter = (value: string) => {
    setFolderId(online?.folders?.find((folder) => value === `folder:${folder.id}`)?.id ?? null);
    setFilter(ONLINE_CHAT_FILTERS.find(({ key }) => key === value)?.key ?? "all");
    setChatPage(1);
  };

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((prev) => ({ ...prev, [key]: value }));
  const toggle = (chat: (typeof allChats)[number]) => setDraft((prev) => ({ ...prev, targets: prev.targets.some(({ peer }) => peer === chat.peer) ? prev.targets.filter(({ peer }) => peer !== chat.peer) : [...prev.targets, { peer: chat.peer, slug: chat.localSlug, name: chat.name }] }));
  const canSave = !libraryChanged && !!draft.name.trim() && validTime && validDays && draft.targets.length > 0 && (!mediaEnabled || draft.mediaKinds.length > 0) && (!!plan || hasSession);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSave || saving) return;
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const run = submitter?.getAttribute("value") === "run";
    setError("");
    setSaveAndRun(run);
    try {
      await onSave({ ...draft, schedule: { frequency, time, weekdays: previewDays }, mediaKinds: mediaEnabled ? draft.mediaKinds : [], includeHistory: mediaEnabled && draft.includeHistory }, run);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return <form className="plan-editor plan-subpage" onSubmit={(event) => void submit(event)}>
    <header className="plan-editor-title">
      <button type="button" className="icon-btn plan-editor-back" aria-label={plan ? "返回计划详情" : "返回同步计划"} data-tip={plan ? "返回计划详情" : "返回同步计划"} disabled={saving} onClick={onCancel}><ArrowLeft size={17} /></button>
      <h1>{plan ? "编辑同步计划" : "新建同步计划"}</h1>
    </header>
    <fieldset className="plan-editor-fields" disabled={saving}>
      <div className="panel plan-editor-identity">
        <label className="field plan-name-field"><span>计划名称</span><input type="text" autoFocus={!plan} required value={draft.name} maxLength={80} onChange={(event) => set("name", event.target.value)} placeholder="例如：每日频道归档" /></label>
        <div className="field plan-editor-library"><span>目标档案库</span><div className="plan-library-value"><Database size={14} /><b data-tip={libraryLabel}>{libraryLabel}</b></div></div>
      </div>
      {(!hasSession || libraryChanged || !boundLibraryOpen || chatError) && <div className="plan-editor-notices">
        {!hasSession && <div className="plan-inline-notice" role="status"><AlertCircle size={15} /><span>登录 Telegram 后可读取聊天列表。</span><button type="button" className="btn sm ghost" onClick={onAccount}>前往登录 <ArrowUpRight size={12} /></button></div>}
        {libraryChanged && <div className="plan-inline-notice" role="alert"><AlertCircle size={15} /><span>编辑期间切换了档案库。请返回后为当前档案库新建计划。</span></div>}
        {!boundLibraryOpen && <div className="plan-inline-notice" role="status"><AlertCircle size={15} /><span>打开此计划绑定的档案库后，可添加聊天。</span></div>}
        {chatError && <div className="plan-inline-notice" role="alert"><AlertCircle size={15} /><span>{chatError}</span></div>}
      </div>}
      <div className="plan-editor-grid">
        <section className="panel plan-form-panel plan-chat-panel">
          <div className="plan-form-section">
            <div className="plan-field-heading"><h2>归档对象</h2><span className="plan-selected-count" aria-live="polite">已选 <b>{draft.targets.length}</b> 个</span></div>
            <div className="plan-chat-toolbar">
              <label className="task-search"><Search size={14} /><input type="search" aria-label="搜索聊天" placeholder="搜索名称、用户名或 ID" value={query} onChange={(event) => { setQuery(event.target.value); setChatPage(1); }} /></label>
              <Select value={activeFolder ? `folder:${activeFolder.id}` : filter} options={filterOptions} ariaLabel="筛选归档对象" onChange={changeFilter} disabled={saving} />
              <button type="button" className="btn sm plan-pick" aria-pressed={onlySelected} onClick={() => { setOnlySelected((value) => !value); setChatPage(1); }}><ListFilter size={14} /> 仅看已选</button>
              <button type="button" className="icon-btn" aria-label="刷新聊天" data-tip="刷新聊天" disabled={!canFetchChats || loading} onClick={() => setRefreshSeq((value) => value + 1)}><RefreshCw size={14} className={loading ? "spin" : ""} /></button>
            </div>
            <div className="plan-chat-list" aria-label="可选择的聊天" ref={chatList}>
              {loading && !visible.length ? <div className="plan-loading plan-chat-skeleton" role="status" aria-label="正在读取聊天">{[0, 1, 2, 3, 4].map((i) => <div key={i}><span className="plan-chat-symbol skeleton-block" /><span className="plan-chat-identity"><span className="skeleton-line w-160" /><span className="skeleton-line w-80" /></span></div>)}</div> : pageChats.length ? pageChats.map((chat) => {
                const checked = selected.has(chat.peer);
                const ChatIcon = chat.type === "channel" ? Megaphone : chat.type === "group" ? UsersRound : MessageCircle;
                return <button className="plan-chat-option" type="button" key={chat.peer} aria-pressed={checked} onClick={(event) => {
                  toggle(chat);
                  if (onlySelected && checked) event.currentTarget.closest(".plan-form-section")?.querySelector<HTMLButtonElement>(".plan-pick")?.focus();
                }}>
                  <span className="plan-chat-symbol"><ChatIcon size={15} /></span>
                  <span className="plan-chat-identity"><b data-tip={chat.name}>{chat.name}</b><span className="plan-chat-username">{onlineChatTypeMeta(chat.type).label}{chat.username ? ` · @${chat.username}` : ""}</span></span>
                  {(chat.archivedLocally || chat.localSlug) && <span className="plan-chat-local"><CheckCircle2 size={12} /> 已归档</span>}
                  <span className="plan-chat-selected" aria-hidden="true">{checked && <><Check size={12} />已选</>}</span>
                </button>;
              }) : <p className="plan-chat-empty">{!hasSession ? "登录后选择要同步的聊天。" : onlySelected ? "没有符合条件的已选聊天。" : "没有找到符合条件的聊天。"}</p>}
            </div>
            <div className="plan-chat-list-footer">
              <span aria-live="polite">{loading ? "正在刷新聊天…" : pages > 1 ? `${firstChat + 1}–${firstChat + pageChats.length} / ${visible.length.toLocaleString()} 个聊天` : `${visible.length} 个结果`}</span>
              <div className="plan-chat-list-actions">
                {filtered && <button type="button" className="plan-text-button" onClick={() => { setQuery(""); changeFilter("all"); setOnlySelected(false); }}>清除筛选</button>}
                {pages > 1 && <div className="plan-chat-pagination" aria-label="聊天列表分页">
                  <button type="button" className="icon-btn" aria-label="上一页聊天" data-tip="上一页聊天" disabled={page <= 1} onClick={() => setChatPage(page - 1)}><ChevronLeft size={15} /></button>
                  <span aria-label={`第 ${page} 页，共 ${pages} 页`}>{page} / {pages}</span>
                  <button type="button" className="icon-btn" aria-label="下一页聊天" data-tip="下一页聊天" disabled={page >= pages} onClick={() => setChatPage(page + 1)}><ChevronRight size={15} /></button>
                </div>}
              </div>
            </div>
          </div>
        </section>
        <section className="panel plan-form-panel plan-settings-panel">
          <div className="plan-form-section plan-schedule-section">
            <div className="plan-field-heading"><h2>运行时间</h2></div>
            <div className="plan-schedule-fields">
              <div className="field"><span>重复</span><Select ariaLabel="重复频率" value={frequency} options={FREQUENCY_OPTIONS} disabled={saving} onChange={(value) => set("schedule", { ...draft.schedule, frequency: value as Schedule["frequency"] })} /></div>
              <label className="field"><span>时间</span><input type="time" required value={time} onChange={(event) => set("schedule", { ...draft.schedule, time: event.target.value })} /></label>
            </div>
            <div className="field plan-weekdays">
              <span id="plan-weekday-label">执行日</span>
              {frequency === "daily" ? <div className="plan-daily-days">周一至周日</div> : <div role="group" aria-labelledby="plan-weekday-label">
                {WEEKDAY_ORDER.map((day) => {
                  const checked = selectedDays.includes(day);
                  return <button type="button" className="btn sm plan-pick" key={day} aria-label={`星期${WEEKDAYS[day]}`} aria-pressed={checked}
                    onClick={() => set("schedule", { ...draft.schedule, weekdays: WEEKDAY_ORDER.filter((item) => item === day ? !checked : selectedDays.includes(item)) })}>周{WEEKDAYS[day]}</button>;
                })}
              </div>}
            </div>
            <div className="plan-schedule-preview" aria-live="polite">
              <span><Clock size={14} /> 下次运行</span>
              <b data-tip={preview?.error}>{!validDays ? "至少选择一个执行日" : !draft.enabled ? "计划已暂停" : !validTime ? "请选择时间" : preview?.error ? "暂时无法计算" : preview?.nextRunAt ? when(preview.nextRunAt, "待排程") : "正在计算…"}</b>
              <small>本机时间</small>
            </div>
          </div>
          <div className="plan-form-section plan-content-section">
            <div className="plan-field-heading"><h2 id="plan-content-heading">同步内容</h2></div>
            <div className="plan-content-choice" role="radiogroup" aria-labelledby="plan-content-heading">
              <label className="plan-content-option">
                <input type="radio" name="plan-content" value="messages" checked={!mediaEnabled} onChange={() => setMediaEnabled(false)} />
                <span><b>仅消息</b><small>保存聊天消息</small></span>
              </label>
              <label className="plan-content-option">
                <input type="radio" name="plan-content" value="media" checked={mediaEnabled} onChange={() => setMediaEnabled(true)} />
                <span><b>消息与媒体</b><small>同时下载所选媒体</small></span>
              </label>
            </div>
            {mediaEnabled && <>
              <div className="plan-media-options" role="group" aria-label="媒体类型">{MEDIA.map(({ kind, label, icon: Icon }) => {
                const checked = draft.mediaKinds.includes(kind);
                return <button className="btn sm plan-pick plan-media-option" type="button" aria-pressed={checked} key={kind}
                  onClick={() => set("mediaKinds", checked ? draft.mediaKinds.filter((entry) => entry !== kind) : [...draft.mediaKinds, kind])}>
                  <span><Icon size={14} /> {label}</span>
                </button>;
              })}</div>
              {draft.mediaKinds.length === 0 && <p className="plan-field-hint" role="status">请选择至少一种媒体类型。</p>}
              <label className="plan-history-toggle">
                <span>补齐所选类型的历史缺失媒体</span>
                <span className={`switch ${draft.includeHistory && draft.mediaKinds.length > 0 ? "on" : ""}`}>
                  <input type="checkbox" role="switch" disabled={draft.mediaKinds.length === 0} checked={draft.includeHistory && draft.mediaKinds.length > 0} onChange={(event) => set("includeHistory", event.target.checked)} /><i />
                </span>
              </label>
            </>}
          </div>
        </section>
      </div>
      <section className="panel plan-scope-section" aria-labelledby="plan-scope-heading">
        <div><h2 id="plan-scope-heading">首次归档范围</h2><p>仅用于未归档的聊天。已有归档从上次位置继续。</p></div>
        <Select ariaLabel="首次归档范围" value={draft.firstScope} options={SCOPE_OPTIONS} disabled={saving} onChange={(scope) => set("firstScope", scope as FirstScope)} />
        {draft.firstScope === "all" && <p className="plan-field-hint" role="status"><AlertCircle size={14} /> 将读取所选未归档聊天的全部历史。</p>}
      </section>
    </fieldset>
    <footer className="panel plan-editor-footer">
      {error && <div className="plan-inline-notice" role="alert"><AlertCircle size={15} /><span>{error}</span></div>}
      <div className="plan-editor-summary"><b>已选 {draft.targets.length} 个聊天</b><span>{scheduleText(draft.schedule)} · {mediaText(mediaEnabled ? draft.mediaKinds : [])}</span></div>
      <div className="plan-row-actions">
        <button type="button" className="btn ghost" disabled={saving} onClick={onCancel}>取消</button>
        <button type="submit" className="btn" value="save" disabled={saving || !canSave}>{saving && !saveAndRun && <Loader2 size={13} className="spin" />} 保存计划</button>
        <button type="submit" className="btn primary" value="run" disabled={saving || !canSave || !hasSession}>{saving && saveAndRun ? <Loader2 size={13} className="spin" /> : <Play size={13} />} 保存并运行</button>
      </div>
    </footer>
  </form>;
}
