import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ArrowLeft, Check, Copy, Database, ExternalLink, ListChecks, LoaderCircle, Monitor, Play, Plus, QrCode, RefreshCw, Search, Settings2, Shield, Square, Wifi, X } from "lucide-react";
import type { PageCtx } from "./pages";
import { Select } from "./Select";
import { call } from "./rpc";
import "./WebPublication.css";

type Selection = { slug: string; id: string };
type Chat = Selection & { name: string; messages: number; ready: boolean };
type PublishConfig = { scope: { all: boolean; chats: Selection[] | null }; adapter: string; lanIPv6: boolean; tailscale: boolean; port: number; auto: boolean; keepOnExit: boolean; restartOnFailure: boolean; restartLimit: number };
type Endpoint = { kind: "lan" | "tailscale"; url?: string; error?: string; portBlocked?: boolean };
type PortOwner = { pid: number; name: string; path?: string; started?: string; addresses: string[]; canEnd: boolean; reason?: string };
type PortCheck = { port: number; owners?: PortOwner[]; error?: string };
type PublishStatus = {
  config: PublishConfig;
  library: string;
  requested: boolean;
  phase: "stopped" | "starting" | "waiting" | "running";
  message?: string;
  chatError?: string;
  lanError?: string;
  tailError?: string;
  published: number;
  catalogReady: boolean;
  networkReady: boolean;
  portLocked: boolean;
  controlLocked: boolean;
  chats: Chat[];
  adapters: { id: string; name: string; ip?: string; ipv6?: string }[];
  endpoints: Endpoint[];
};

const phaseText = { stopped: "未部署", starting: "正在启动", waiting: "等待连接", running: "部署运行中" };
const networkName = { lan: "局域网", tailscale: "Tailscale" };
const PAGE_SIZE = 60;

function adapterKey(id: string) {
  return id.replace(/^\{|\}$/g, "").toLowerCase();
}

function PortDiagnostics({ check, port, blocked, ending, onCheck, onEnd, onClose }: {
  check?: PortCheck;
  port: number;
  blocked: boolean;
  ending: boolean;
  onCheck?: () => void;
  onEnd: (owner: PortOwner) => void;
  onClose?: () => void;
}) {
  const result = check?.port === port ? check : undefined;
  return <section id="publish-port-result" className={`publish-port-result${blocked ? " is-blocked" : ""}`} aria-label={`端口 ${port} 检查结果`} aria-busy={!result}>
    <div className="publish-port-summary">
      <div>
        <b>{!result ? <LoaderCircle size={15} className="spin" aria-hidden="true" /> : blocked ? <AlertCircle size={15} aria-hidden="true" /> : null}{blocked ? `无法监听端口 ${port}` : `TCP 端口 ${port}`}</b>
        <span role="status">{!result ? "正在读取 Windows 监听列表…" : result.error || (
          result.owners?.length ? `${result.owners.length} 个程序正在监听此端口` : blocked
            ? "未发现监听程序。若仍无法部署，请换一个端口。"
            : "当前没有程序监听此端口。"
        )}</span>
      </div>
      {(onCheck || onClose) && <div className="publish-port-actions">
        {onCheck && <button className="btn sm ghost" disabled={!result || ending} onClick={onCheck}><RefreshCw size={13} /> 重新检查</button>}
        {onClose && <button className="btn sm ghost publish-icon-button" disabled={ending} onClick={onClose} aria-label="关闭端口检查" data-tip="关闭端口检查"><X size={14} /></button>}
      </div>}
    </div>
    {!!result?.owners?.length && <ul className="publish-port-owners">
      {result.owners.map((owner) => <li key={owner.pid}>
        <div className="publish-port-owner">
          <b data-tip={owner.path}>{owner.name} <small>PID {owner.pid}</small></b>
          <small data-tip={owner.addresses.join(" · ")}>{owner.addresses.join(" · ")}</small>
        </div>
        {owner.canEnd ? <button className="btn sm ghost publish-end-process" disabled={ending} onClick={() => onEnd(owner)}>解除占用</button> : <small className="publish-owner-reason">{owner.reason}</small>}
      </li>)}
    </ul>}
  </section>;
}

function PublicationSwitch({ label, hint, checked, disabled, onChange, className = "" }: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
  className?: string;
}) {
  return <label className={`publish-switch ${className}`}>
    <span className="publish-switch-copy"><b>{label}</b>{hint && <small>{hint}</small>}</span>
    <input className="publish-control-input" type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
    <span className="publish-switch-track" aria-hidden="true" />
  </label>;
}

function ChatIdentity({ chat }: { chat: Chat }) {
  return <>
    <span className="publish-chat-avatar" aria-hidden="true">{Array.from(chat.name.trim())[0] || "·"}</span>
    <span className="publish-chat-copy"><b data-tip={chat.name}>{chat.name}</b><small>{chat.ready ? `${chat.messages.toLocaleString()} 条消息` : "需先生成网页"}</small></span>
  </>;
}

export function WebPublication({ ctx }: { ctx: PageCtx }) {
  const [status, setStatus] = useState<PublishStatus>();
  const [draft, setDraft] = useState<PublishConfig>();
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [loadError, setLoadError] = useState("");
  const [qr, setQR] = useState<{ url: string; src: string }>();
  const [view, setView] = useState<"console" | "settings">("console");
  const [manualPort, setManualPort] = useState<number>();
  const [check, setCheck] = useState<PortCheck>();
  const [checkRevision, setCheckRevision] = useState(0);
  const [confirmOwner, setConfirmOwner] = useState<{ port: number; owner: PortOwner }>();
  const [ending, setEnding] = useState(false);
  const confirmDialog = useRef<HTMLDialogElement>(null);
  const portCheckButton = useRef<HTMLButtonElement>(null);
  const qrDialog = useRef<HTMLDialogElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const sequence = useRef(0);
  const blockedPort = status?.endpoints.some((endpoint) => endpoint.portBlocked) ? status.config.port : undefined;
  const diagnosticPort = view === "console" ? blockedPort : (
    manualPort === draft?.port || blockedPort === draft?.port ? draft?.port : undefined
  );

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const request = sequence.current;
      try {
        const next = await call<PublishStatus>("webPublishStatus", undefined, controller.signal);
        if (controller.signal.aborted || request !== sequence.current) return;
        setStatus(next);
        setDraft((previous) => previous ?? next.config);
        setLoadError("");
      } catch (error) {
        if (!controller.signal.aborted) setLoadError((error as Error).message);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, 1500);
      }
    }
    setDraft(undefined);
    setStatus(undefined);
    setQR(undefined);
    setManualPort(undefined);
    setConfirmOwner(undefined);
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [ctx.boot?.libraryKey]);

  useEffect(() => {
    const dialog = qrDialog.current;
    if (qr && dialog && !dialog.open) dialog.showModal();
  }, [qr]);

  useEffect(() => {
    if (confirmOwner && !confirmDialog.current?.open) confirmDialog.current?.showModal();
  }, [confirmOwner]);

  useEffect(() => {
    setCheck(undefined);
    if (diagnosticPort === undefined) return;
    const controller = new AbortController();
    call<PortOwner[]>("webPublishCheckPort", { port: diagnosticPort }, controller.signal).then(
      (owners) => { if (!controller.signal.aborted) setCheck({ port: diagnosticPort, owners }); },
      (error: Error) => { if (!controller.signal.aborted) setCheck({ port: diagnosticPort, error: error.message }); },
    );
    return () => controller.abort();
  }, [diagnosticPort, checkRevision]);

  function requestPortCheck(port: number) {
    if (view === "settings" && port !== blockedPort) setManualPort(port);
    setCheckRevision((revision) => revision + 1);
  }

  async function endOwner(target: NonNullable<typeof confirmOwner>) {
    const { port, owner } = target;
    setConfirmOwner(undefined);
    setEnding(true);
    try {
      await call("webPublishEndPortOwner", { port, pid: owner.pid, started: owner.started });
      ctx.toast(`已结束 ${owner.name}（PID ${owner.pid}）`, "success");
    } catch (error) {
      ctx.toast((error as Error).message, "error");
    } finally {
      setCheckRevision((revision) => revision + 1);
      setEnding(false);
    }
  }

  function navigate(next: typeof view) {
    setManualPort(undefined);
    setView(next);
    requestAnimationFrame(() => {
      title.current?.scrollIntoView({ block: "start" });
      title.current?.focus({ preventScroll: true });
    });
  }

  const selected = useMemo(() => new Map((draft?.scope.chats ?? []).map((chat) => [chat.slug, chat.id])), [draft?.scope.chats]);
  const filtered = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return (status?.chats ?? []).filter((chat) => chat.name.toLocaleLowerCase().includes(term));
  }, [query, status?.chats]);

  function update(patch: Partial<PublishConfig>) {
    setDraft((previous) => previous && { ...previous, ...patch });
  }

  async function save(method: "webPublishSave" | "webPublishStart" | "webPublishStop") {
    sequence.current++;
    setBusy(true);
    try {
      const next = await call<PublishStatus>(method, method === "webPublishStop" ? undefined : draft);
      sequence.current++;
      setStatus(next);
      setDraft(next.config);
      setQR(undefined);
      if (method === "webPublishSave") ctx.toast(next.requested ? "部署设置已应用" : "部署设置已保存", "success");
      if (method === "webPublishStop") ctx.toast("网页部署已停止", "success");
    } catch (error) {
      ctx.toast((error as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function act(endpoint: Endpoint, action: "copy" | "open" | "qr") {
    if (!endpoint.url) return;
    try {
      if (action === "copy") {
        await navigator.clipboard.writeText(endpoint.url);
        ctx.toast("访问地址已复制", "success");
      } else if (action === "open") {
        await call("webPublishOpen", { url: endpoint.url });
      } else {
        const src = await call<string>("webPublishQR", { url: endpoint.url });
        setQR({ url: endpoint.url, src });
      }
    } catch (error) {
      ctx.toast((error as Error).message, "error");
    }
  }

  function toggle(chat: Chat) {
    setDraft((previous) => {
      if (!previous || previous.scope.all || !chat.ready) return previous;
      const current = previous.scope.chats ?? [];
      const chats = current.filter((item) => item.slug !== chat.slug);
      if (!current.some((item) => item.slug === chat.slug && item.id === chat.id)) chats.push({ slug: chat.slug, id: chat.id });
      return { ...previous, scope: { all: false, chats } };
    });
  }

  if (!status || !draft) {
    return <div className="publish-page"><header className="publish-heading"><div><h1>网页部署</h1><p>在局域网或 Tailscale 上浏览档案网页</p></div></header>
      <section className="panel publish-empty" role="status">{loadError || "正在读取档案库和访问网络…"}</section></div>;
  }

  const chosen = status.chats.filter((chat) => chat.ready && (draft.scope.all || selected.get(chat.slug) === chat.id)).length;
  const eligible = status.chats.filter((chat) => chat.ready).length;
  const networkConfigured = Boolean(draft.adapter || draft.tailscale);
  const dirty = JSON.stringify(status.config) !== JSON.stringify(draft);
  const validPort = Number.isInteger(draft.port) && draft.port >= 1 && draft.port <= 65535;
  const validLimit = !draft.restartOnFailure || (Number.isInteger(draft.restartLimit) && draft.restartLimit >= 1 && draft.restartLimit <= 10);
  const canStart = Boolean(status.library && chosen && validPort && validLimit && networkConfigured);
  const settingsLocked = busy || status.controlLocked;
  const restartLocked = settingsLocked || status.requested;
  const matchingAdapters = status.adapters.filter((adapter) => draft.adapter === "auto" || adapterKey(adapter.id) === adapterKey(draft.adapter));
  const endpoints = status.endpoints.filter((endpoint) => !endpoint.portBlocked);
  const adapters = [{ value: "auto", label: "自动选择已连接网卡" }, ...status.adapters.map((adapter) => ({
    value: adapterKey(adapter.id) === adapterKey(draft.adapter) ? draft.adapter : adapter.id,
    label: `${adapter.name} · ${adapter.ip || adapter.ipv6}`,
  })), { value: "", label: "关闭局域网访问" }];
  if (draft.adapter && !adapters.some((adapter) => adapter.value === draft.adapter)) adapters.push({ value: draft.adapter, label: "已选网卡暂不可用" });

  return (
    <div className={view === "settings" ? "publish-page publish-page-settings" : "publish-page"}>
      <header className="publish-heading">
        <div><h1 ref={title} tabIndex={-1}>{view === "console" ? "网页部署" : "部署设置"}</h1><p>{view === "console" ? "在局域网或 Tailscale 上浏览档案网页" : "管理访问网络和后台运行"}</p></div>
        <div className="publish-heading-action">
          {view === "settings" ? <button type="button" className="btn ghost" onClick={() => navigate("console")}><ArrowLeft size={15} /> 返回部署</button> : <>
            <button type="button" className="btn ghost" onClick={() => navigate("settings")}><Settings2 size={15} /> 部署设置</button>
            {status.requested
              ? <button type="button" className="btn ghost" disabled={busy} onClick={() => void save("webPublishStop")}>{busy ? <LoaderCircle size={14} className="spin" /> : <Square size={14} />} 停止部署</button>
              : <button type="button" className="btn primary" disabled={busy || !canStart} onClick={() => void save("webPublishStart")}>{busy ? <LoaderCircle size={14} className="spin" /> : <Play size={14} />} 启动部署</button>}
          </>}
        </div>
      </header>

      {view === "console" ? <>
      <section className="panel publish-status" aria-label="部署状态">
        <div className="publish-status-head">
          <div className="publish-status-title">
            <h2>访问地址</h2>
            <span data-tip={status.library}><Database size={13} />{status.library || "尚未打开档案库"}</span>
          </div>
          <div className="publish-state-group">
            <span className={`publish-state ${status.phase}`} role="status"><span className={`publish-dot ${status.phase}`} />{status.phase === "waiting" && blockedPort !== undefined ? "端口待处理" : phaseText[status.phase]}</span>
            {status.phase === "running" && <span className="publish-note">已发布 {status.published.toLocaleString()} 个聊天</span>}
          </div>
        </div>
        {status.message && <div className="publish-notice" role="status">{status.message}</div>}
        {endpoints.length > 0 ? (
          <div className="publish-endpoints">
            {endpoints.map((endpoint, index) => {
              const label = endpoint.url ? `${networkName[endpoint.kind]} ${endpoint.url.includes("[") ? "IPv6" : "IPv4"}` : networkName[endpoint.kind];
              return (
              <div className="publish-endpoint" key={endpoint.url || `${endpoint.kind}-${index}`}>
                <span className="publish-endpoint-label">{endpoint.kind === "lan" ? <Wifi size={15} /> : <Shield size={15} />}<span>{networkName[endpoint.kind]}</span>{endpoint.url && <small>{endpoint.url.includes("[") ? "IPv6" : "IPv4"}</small>}</span>
                {endpoint.url ? <>
                  <button type="button" className="publish-address" data-tip={`在浏览器打开 ${endpoint.url}`} onClick={() => void act(endpoint, "open")}><code>{endpoint.url}</code></button>
                  <div className="publish-endpoint-actions">
                    <button className="btn sm ghost publish-copy" aria-label={`复制 ${label} 地址`} data-tip="复制地址" onClick={() => void act(endpoint, "copy")}><Copy size={14} /><span>复制</span></button>
                    <button className="btn sm ghost" aria-label={`打开 ${label} 地址`} data-tip="浏览器打开" onClick={() => void act(endpoint, "open")}><ExternalLink size={15} /></button>
                    <button className="btn sm ghost" aria-label={`${label} 二维码`} data-tip="显示二维码" onClick={() => void act(endpoint, "qr")}><QrCode size={15} /></button>
                  </div>
                </> : <span className="publish-endpoint-error">{endpoint.error}</span>}
              </div>
              );
            })}
          </div>
        ) : blockedPort === undefined && (!status.requested || !status.message) && <div className="publish-address-empty">
          <p className="publish-note">{status.requested ? "正在准备访问地址…" : networkConfigured ? "启动部署后，可从其他设备打开地址或扫码。" : "先选择局域网网卡或开启 Tailscale 访问。"}</p>
          {!status.requested && !networkConfigured && <button type="button" className="btn sm ghost" onClick={() => navigate("settings")}>配置访问网络</button>}
        </div>}
        {blockedPort !== undefined && <PortDiagnostics port={blockedPort} check={check} blocked ending={ending} onCheck={() => requestPortCheck(blockedPort)} onEnd={(owner) => setConfirmOwner({ port: blockedPort, owner })} />}
      </section>

        <section className="panel publish-scope">
          <header className="panel-head"><h3><ListChecks size={15} /> 发布范围</h3><span className="publish-selection-count">{status.catalogReady ? `${draft.scope.all ? "可发布" : "已选"} ${chosen.toLocaleString()} 个聊天` : "读取中"}</span></header>
          <div className="publish-body">
            <div className="publish-scope-controls">
              <div className="publish-scope-options" role="radiogroup" aria-label="发布范围">
                <label><input className="publish-control-input" type="radio" name="publish-scope" checked={draft.scope.all} disabled={settingsLocked} onChange={() => update({ scope: { ...draft.scope, all: true } })} /><span>整个档案库</span></label>
                <label><input className="publish-control-input" type="radio" name="publish-scope" checked={!draft.scope.all} disabled={settingsLocked} onChange={() => update({ scope: { all: false, chats: draft.scope.chats ?? [] } })} /><span>指定聊天</span></label>
              </div>
              {!draft.scope.all && status.catalogReady && !status.chatError && status.chats.length > 0 && <label className="publish-search"><Search size={14} /><input aria-label="搜索可发布的聊天" placeholder="搜索聊天" value={query} onChange={(event) => { setQuery(event.target.value); setLimit(PAGE_SIZE); }} /></label>}
            </div>
            {!status.catalogReady ? <p className="publish-note publish-loading" role="status"><LoaderCircle size={14} className="spin" /> 正在读取可发布聊天…</p> : status.chatError ? <p className="publish-note" role="status">{status.chatError}</p> : draft.scope.all ? (
              <p className="publish-note">已生成网页的聊天会纳入部署，新生成的聊天网页也会自动发布。{status.chats.length > eligible && ` 另有 ${status.chats.length - eligible} 个聊天尚未生成网页。`}</p>
            ) : <>
              {filtered.length > 0 && <ul className="publish-chat-list" aria-label="聊天">
                {filtered.slice(0, limit).map((chat) => {
                  const pressed = selected.get(chat.slug) === chat.id;
                  return <li key={chat.slug}>
                    {chat.ready ? <button type="button" className="publish-chat publish-chat-button" aria-label={chat.name} aria-pressed={pressed} disabled={settingsLocked} onClick={() => toggle(chat)}>
                      <ChatIdentity chat={chat} />
                      <span className="publish-chat-indicator" aria-hidden="true">{pressed ? <><Check size={14} />已选</> : <Plus size={16} />}</span>
                    </button> : <div className="publish-chat">
                      <ChatIdentity chat={chat} />
                      <button className="btn sm ghost" onClick={() => { ctx.setSelected(chat.slug); ctx.go("chats"); }}>前往重建</button>
                    </div>}
                  </li>;
                })}
              </ul>}
              {filtered.length === 0 && <p className="publish-note">{query ? "没有匹配的聊天" : "当前档案库还没有聊天"}</p>}
              {filtered.length > limit && <button className="btn sm ghost" onClick={() => setLimit((n) => n + PAGE_SIZE)}>显示更多</button>}
              {status.chats.length > eligible && <p className="publish-note">{eligible} 个聊天已生成网页</p>}
            </>}
          </div>
        </section>
      </> : (
      <div className="publish-settings-panel">
          <section className="panel publish-network" aria-labelledby="publish-network-title">
            <header className="panel-head"><Wifi size={16} aria-hidden="true" /><div><h3 id="publish-network-title">访问网络</h3>
              {status.requested && !networkConfigured && <p>要关闭所有访问入口，请停止部署。</p>}
            </div></header>
            <div className="publish-body">
              <div className="publish-network-fields">
                <div className="field"><span>局域网网卡</span><Select value={draft.adapter} options={adapters} onChange={(adapter) => update({ adapter })} ariaLabel="局域网网卡" disabled={settingsLocked} /></div>
                <div className="field">
                  <label htmlFor="publish-port">网页访问端口</label>
                  <div className="publish-port-control">
                    <input id="publish-port" type="number" min={1} max={65535} value={draft.port || ""} disabled={settingsLocked || status.portLocked} aria-invalid={!validPort} aria-describedby={!validPort || status.portLocked ? "publish-port-hint" : undefined} onChange={(event) => { setManualPort(undefined); update({ port: Number(event.target.value) }); }} />
                    <button type="button" className="btn ghost" ref={portCheckButton} disabled={!validPort || ending} aria-controls={diagnosticPort === undefined ? undefined : "publish-port-result"} onClick={() => requestPortCheck(draft.port)}>检查占用</button>
                  </div>
                  {(!validPort || status.portLocked) && <small id="publish-port-hint">{!validPort ? "端口范围为 1–65535。" : "停止部署后可修改端口。"}</small>}
                </div>
              </div>
              {diagnosticPort !== undefined && <PortDiagnostics port={diagnosticPort} check={check} blocked={diagnosticPort === blockedPort} ending={ending} onEnd={(owner) => setConfirmOwner({ port: diagnosticPort, owner })} onClose={diagnosticPort !== blockedPort ? () => { setManualPort(undefined); portCheckButton.current?.focus(); } : undefined} />}
              <div className="publish-network-switches">
                <PublicationSwitch label="允许局域网 IPv6" hint={!draft.adapter ? "启用局域网后可设置" : status.networkReady && matchingAdapters.length > 0 && !matchingAdapters.some((adapter) => adapter.ipv6) ? "当前网卡暂时没有可用的 IPv6 地址" : undefined} checked={draft.lanIPv6} disabled={settingsLocked || !draft.adapter} onChange={(lanIPv6) => update({ lanIPv6 })} />
                <PublicationSwitch label="允许 Tailscale 访问" hint={draft.tailscale ? status.tailError : undefined} checked={draft.tailscale} disabled={settingsLocked} onChange={(tailscale) => update({ tailscale })} />
              </div>
              {!status.networkReady && <p className="publish-note publish-loading" role="status"><LoaderCircle size={14} className="spin" /> 正在检测访问网络…</p>}
              {draft.adapter && status.networkReady && matchingAdapters.length === 0 && <p className="publish-note" role="status">{draft.adapter === "auto" ? status.lanError || "连接 Wi-Fi 或网线后，部署会自动获取局域网地址。" : "所选网卡当前不可用，可切换到自动选择。"}</p>}
            </div>
          </section>
          <section className="panel publish-background" aria-labelledby="publish-background-title">
            <header className="panel-head"><h3 id="publish-background-title"><Monitor size={15} /> 后台运行</h3></header>
            <div className="publish-body publish-lifecycle">
              <PublicationSwitch label="退出客户端后继续部署" hint="从托盘退出后，网页仍可访问" checked={draft.keepOnExit} disabled={settingsLocked} onChange={(keepOnExit) => update({ keepOnExit })} />
              <PublicationSwitch label="登录 Windows 后自动部署" hint="恢复上次开启的部署" checked={draft.auto} disabled={settingsLocked} onChange={(auto) => update({ auto })} />
              <div className="publish-recovery">
                <PublicationSwitch label="故障时自动重启" hint={status.requested ? "停止部署后可更改重启设置" : "后台进程异常退出时尝试恢复"} checked={draft.restartOnFailure} disabled={restartLocked} onChange={(restartOnFailure) => update({ restartOnFailure })} />
                {draft.restartOnFailure && <label className="publish-limit"><span>重启上限</span><span className="publish-limit-control"><input type="number" aria-label="重启上限" min={1} max={10} value={draft.restartLimit || ""} disabled={restartLocked} onChange={(event) => update({ restartLimit: Number(event.target.value) })} /><span>次 · 间隔 5 秒</span></span></label>}
                {!validLimit && <p className="publish-note" role="status">重启上限须在 1 到 10 次之间</p>}
              </div>
            </div>
          </section>
      </div>
      )}
      {status.controlLocked && view === "settings" && <p className="publish-settings-lock" role="status">{status.message || "后台部署进程正在恢复，连接后即可修改设置。"}</p>}
      {(dirty || busy) && <div className="publish-footer">
        <span aria-live="polite">{busy ? <><LoaderCircle size={13} className="spin" /> 正在应用…</> : "有未应用的设置"}</span>
        <button className="btn ghost" disabled={busy || !dirty} onClick={() => setDraft(status.config)}><RefreshCw size={13} /> 恢复设置</button>
        <button className="btn primary" disabled={settingsLocked || !dirty || !validPort || !validLimit || (status.requested && !networkConfigured)} onClick={() => void save("webPublishSave")}>{status.requested ? "应用设置" : "保存设置"}</button>
      </div>}

      {qr && <dialog className="publish-qr" ref={qrDialog} onClose={() => setQR(undefined)} aria-modal="true" aria-label="扫码打开档案网页">
        <header><h2>扫码打开档案网页</h2><button className="btn sm ghost publish-icon-button" aria-label="关闭二维码" onClick={() => qrDialog.current?.close()}><X size={16} /></button></header>
        <div className="publish-qr-image"><img src={qr.src} alt="档案网页访问地址二维码" width={220} height={220} /></div>
        <code>{qr.url}</code>
      </dialog>}
      {confirmOwner && <dialog className="publish-confirm" role="alertdialog" ref={confirmDialog} onClose={() => setConfirmOwner(undefined)} aria-modal="true" aria-labelledby="publish-confirm-title" aria-describedby="publish-confirm-target publish-confirm-message">
        <header>
          <AlertCircle size={18} aria-hidden="true" />
          <h2 id="publish-confirm-title">结束程序以释放端口？</h2>
        </header>
        <div className="publish-confirm-body">
          <div id="publish-confirm-target" className="publish-confirm-target">
            <strong>{confirmOwner.owner.name}</strong>
            <span>PID {confirmOwner.owner.pid} · TCP 端口 {confirmOwner.port}</span>
          </div>
          <p id="publish-confirm-message">结束程序会中断连接，未保存的工作可能丢失。</p>
        </div>
        <footer className="modal-actions">
          <button className="btn ghost" autoFocus onClick={() => confirmDialog.current?.close()}>取消</button>
          <button className="btn danger" onClick={() => void endOwner(confirmOwner)}>结束程序</button>
        </footer>
      </dialog>}
    </div>
  );
}
