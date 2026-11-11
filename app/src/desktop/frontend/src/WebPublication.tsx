import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Copy, Database, ExternalLink, ListChecks, LoaderCircle, Monitor, Play, Plus, QrCode, RefreshCw, Search, Settings2, Shield, Square, Wifi, X } from "lucide-react";
import type { PageCtx } from "./pages";
import { Select } from "./Select";
import { call } from "./rpc";

type Selection = { slug: string; id: string };
type Chat = Selection & { name: string; messages: number; ready: boolean };
type PublishConfig = { scope: { all: boolean; chats: Selection[] | null }; adapter: string; tailscale: boolean; port: number; auto: boolean; keepOnExit: boolean; restartOnFailure: boolean; restartLimit: number };
type Endpoint = { kind: "lan" | "tailscale"; url?: string; error?: string };
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
  chats: Chat[];
  adapters: { id: string; name: string; ip: string }[];
  endpoints: Endpoint[];
};

const phaseText = { stopped: "未部署", starting: "正在启动", waiting: "等待连接", running: "部署运行中" };
const networkName = { lan: "局域网", tailscale: "Tailscale" };
const PAGE_SIZE = 60;

function PublicationSwitch({ label, hint, checked, disabled, onChange, className = "" }: {
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
  className?: string;
}) {
  return <label className={`publish-switch ${className}`}>
    <span className="publish-switch-copy"><b>{label}</b><small>{hint}</small></span>
    <input className="publish-control-input" type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
    <span className="publish-switch-track" aria-hidden="true" />
  </label>;
}

function ChatIdentity({ chat }: { chat: Chat }) {
  return <>
    <span className="publish-chat-avatar" aria-hidden="true">{Array.from(chat.name.trim())[0] || "·"}</span>
    <span className="publish-chat-copy"><b title={chat.name}>{chat.name}</b><small>{chat.ready ? `${chat.messages.toLocaleString()} 条消息` : "需先生成网页"}</small></span>
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
  const qrDialog = useRef<HTMLDialogElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const sequence = useRef(0);

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

  function navigate(next: typeof view) {
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
  const adapters = [{ value: "", label: "关闭局域网访问" }, ...status.adapters.map((adapter) => ({ value: adapter.id, label: `${adapter.name} · ${adapter.ip}` }))];
  if (draft.adapter && !adapters.some((adapter) => adapter.value === draft.adapter)) adapters.push({ value: draft.adapter, label: "已选网卡暂不可用" });

  return (
    <div className="publish-page">
      <header className="publish-heading">
        <div><h1 ref={title} tabIndex={-1}>{view === "console" ? "网页部署" : "部署设置"}</h1><p>{view === "console" ? "在局域网或 Tailscale 上浏览档案网页" : "管理访问网络和后台运行"}</p></div>
        <div className="publish-heading-action">
          {view === "settings" ? <button type="button" className="btn ghost" onClick={() => navigate("console")}><ArrowLeft size={15} /> 返回部署</button> : <>
            <button type="button" className="btn ghost" onClick={() => navigate("settings")}><Settings2 size={15} /> 部署设置</button>
            {status.requested
              ? <button type="button" className="btn ghost" disabled={busy} onClick={() => void save("webPublishStop")}><Square size={14} /> 停止部署</button>
              : <button type="button" className="btn primary" disabled={busy || !canStart} onClick={() => void save("webPublishStart")}><Play size={14} /> 启动部署</button>}
          </>}
        </div>
      </header>

      {view === "console" ? <>
      <section className="panel publish-status" aria-label="部署状态">
        <div className="publish-status-head">
          <div className="publish-status-title">
            <h2>访问地址</h2>
            <span title={status.library}><Database size={13} />{status.library || "尚未打开档案库"}</span>
          </div>
          <div className="publish-state-group">
            <span className={`publish-state ${status.phase}`} role="status"><span className={`publish-dot ${status.phase}`} />{phaseText[status.phase]}</span>
            {status.phase === "running" && <span className="publish-note">已发布 {status.published.toLocaleString()} 个聊天</span>}
          </div>
        </div>
        {status.message && <div className="publish-notice" role="status">{status.message}</div>}
        {status.endpoints.length > 0 ? (
          <div className="publish-endpoints">
            {status.endpoints.map((endpoint, index) => {
              const label = endpoint.kind === "tailscale" && endpoint.url ? `Tailscale ${endpoint.url.includes("[") ? "IPv6" : "IPv4"}` : networkName[endpoint.kind];
              return (
              <div className="publish-endpoint" key={endpoint.url || `${endpoint.kind}-${index}`}>
                <span className="publish-endpoint-label">{endpoint.kind === "lan" ? <Wifi size={15} /> : <Shield size={15} />}{label}</span>
                {endpoint.url ? <>
                  <button type="button" className="publish-address" title={`在浏览器打开 ${endpoint.url}`} onClick={() => void act(endpoint, "open")}><code>{endpoint.url}</code></button>
                  <div className="publish-endpoint-actions">
                    <button className="btn sm ghost publish-copy" aria-label={`复制 ${label} 地址`} title="复制地址" onClick={() => void act(endpoint, "copy")}><Copy size={14} /><span>复制</span></button>
                    <button className="btn sm ghost" aria-label={`打开 ${label} 地址`} title="浏览器打开" onClick={() => void act(endpoint, "open")}><ExternalLink size={15} /></button>
                    <button className="btn sm ghost" aria-label={`${label} 二维码`} title="显示二维码" onClick={() => void act(endpoint, "qr")}><QrCode size={15} /></button>
                  </div>
                </> : <span className="publish-endpoint-error">{endpoint.error}</span>}
              </div>
              );
            })}
          </div>
        ) : (!status.requested || !status.message) && <div className="publish-address-empty">
          <p className="publish-note">{status.requested ? "正在准备访问地址…" : networkConfigured ? "启动部署后，可从其他设备打开地址或扫码。" : "先选择局域网网卡或开启 Tailscale 访问。"}</p>
          {!status.requested && !networkConfigured && <button type="button" className="btn sm ghost" onClick={() => navigate("settings")}>配置访问网络</button>}
        </div>}
      </section>

        <section className="panel publish-scope">
          <header className="panel-head"><h3><ListChecks size={15} /> 发布范围</h3><span className="publish-selection-count">{status.catalogReady ? `${draft.scope.all ? "可发布" : "已选"} ${chosen.toLocaleString()} 个聊天` : "读取中"}</span></header>
          <div className="publish-body">
            <div className="publish-scope-controls">
              <div className="publish-scope-options" role="radiogroup" aria-label="发布范围">
                <label><input className="publish-control-input" type="radio" name="publish-scope" checked={draft.scope.all} onChange={() => update({ scope: { ...draft.scope, all: true } })} /><span>整个档案库</span></label>
                <label><input className="publish-control-input" type="radio" name="publish-scope" checked={!draft.scope.all} onChange={() => update({ scope: { all: false, chats: draft.scope.chats ?? [] } })} /><span>指定聊天</span></label>
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
                    {chat.ready ? <button type="button" className="publish-chat publish-chat-button" aria-label={chat.name} aria-pressed={pressed} onClick={() => toggle(chat)}>
                      <ChatIdentity chat={chat} />
                      <span className="publish-chat-indicator" aria-hidden="true">{pressed ? "已选" : <Plus size={16} />}</span>
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
      <div className="panel publish-settings-panel">
          <section className="publish-network">
            <header className="panel-head"><h3><Wifi size={15} /> 访问网络</h3></header>
            <div className="publish-body">
              <div className="publish-network-fields">
                <div className="field"><span>局域网网卡</span><Select value={draft.adapter} options={adapters} onChange={(adapter) => update({ adapter })} ariaLabel="局域网网卡" disabled={!status.networkReady} /></div>
                <label className="field"><span>端口</span><input type="number" aria-label="部署端口" min={1} max={65535} value={draft.port || ""} disabled={status.requested} onChange={(event) => update({ port: Number(event.target.value) })} /></label>
              </div>
              <PublicationSwitch className="publish-tail" label="允许 Tailscale 访问" hint={status.tailError || "使用本机 Tailscale 地址"} checked={draft.tailscale} onChange={(tailscale) => update({ tailscale })} />
              {!status.networkReady && <p className="publish-note publish-loading" role="status"><LoaderCircle size={14} className="spin" /> 正在检测访问网络…</p>}
              {status.lanError && <div className="publish-help">
                <span className="publish-note">{status.lanError}</span>
                <button className="btn sm ghost" onClick={() => void call("webPublishNetworkSettings").catch((e) => ctx.toast(e.message, "error"))}>打开网络设置</button>
              </div>}
              {!validPort && <p className="publish-note" role="status">端口须在 1 到 65535 之间</p>}
              <div className="publish-network-foot">
                <small>可信网络内免口令访问</small>
                <details className="publish-network-help"><summary>连接排查</summary>
                  {draft.tailscale && <p className="publish-note">确认访问设备已连接到同一 tailnet，并检查 Tailscale 访问规则是否允许此端口。</p>}
                  <button className="btn sm ghost" onClick={() => void call("webPublishFirewall").catch((e) => ctx.toast(e.message, "error"))}><Shield size={13} /> Windows 防火墙</button>
                </details>
              </div>
            </div>
          </section>
          <section className="publish-background">
            <header className="panel-head"><h3><Monitor size={15} /> 后台运行</h3></header>
            <div className="publish-body publish-lifecycle">
              <PublicationSwitch label="退出客户端后继续部署" hint="从托盘退出后，网页仍可访问" checked={draft.keepOnExit} onChange={(keepOnExit) => update({ keepOnExit })} />
              <PublicationSwitch label="登录 Windows 后自动部署" hint="恢复上次开启的部署" checked={draft.auto} onChange={(auto) => update({ auto })} />
              <div className="publish-recovery">
                <PublicationSwitch label="故障时自动重启" hint={status.requested ? "停止部署后可更改重启设置" : "后台进程异常退出时尝试恢复"} checked={draft.restartOnFailure} disabled={status.requested} onChange={(restartOnFailure) => update({ restartOnFailure })} />
                {draft.restartOnFailure && <label className="publish-limit"><span>上限</span><input type="number" aria-label="重启上限" min={1} max={10} value={draft.restartLimit || ""} disabled={status.requested} onChange={(event) => update({ restartLimit: Number(event.target.value) })} /><span>次 · 间隔 5 秒</span></label>}
                {!validLimit && <p className="publish-note" role="status">重启上限须在 1 到 10 次之间</p>}
              </div>
            </div>
          </section>
      </div>
      )}
      {(dirty || busy) && <div className="publish-footer">
        <span aria-live="polite">{busy ? <><LoaderCircle size={13} className="spin" /> 正在应用…</> : "有未应用的设置"}</span>
        <button className="btn ghost" disabled={busy || !dirty} onClick={() => setDraft(status.config)}><RefreshCw size={13} /> 恢复设置</button>
        <button className="btn primary" disabled={busy || !dirty || !validPort || !validLimit || (status.requested && !draft.adapter && !draft.tailscale)} onClick={() => void save("webPublishSave")}>{status.requested ? "应用设置" : "保存设置"}</button>
      </div>}

      {qr && <dialog className="publish-qr" ref={qrDialog} onClose={() => setQR(undefined)} aria-label="扫码打开档案网页">
        <header><h2>扫码打开档案网页</h2><button className="btn sm ghost" aria-label="关闭二维码" onClick={() => qrDialog.current?.close()}><X size={16} /></button></header>
        <img src={qr.src} alt="档案网页访问地址二维码" width={220} height={220} />
        <code>{qr.url}</code>
      </dialog>}
    </div>
  );
}
