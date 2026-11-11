import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, ExternalLink, Globe, ListChecks, LoaderCircle, Monitor, Play, QrCode, RefreshCw, Search, Shield, Square, Wifi, X } from "lucide-react";
import type { PageCtx } from "./pages";
import { Select } from "./Select";
import { call } from "./rpc";

type Selection = { slug: string; id: string };
type Chat = Selection & { name: string; messages: number; ready: boolean };
type PublishConfig = { scope: { all: boolean; chats: Selection[] | null }; adapter: string; tailscale: boolean; port: number; auto: boolean };
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

export function WebPublication({ ctx }: { ctx: PageCtx }) {
  const [status, setStatus] = useState<PublishStatus>();
  const [draft, setDraft] = useState<PublishConfig>();
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [loadError, setLoadError] = useState("");
  const [qr, setQR] = useState<{ url: string; src: string }>();
  const qrDialog = useRef<HTMLDialogElement>(null);
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
    if (!draft) return;
    const current = draft.scope.chats ?? [];
    const chats = current.filter((item) => item.slug !== chat.slug);
    if (selected.get(chat.slug) !== chat.id) chats.push({ slug: chat.slug, id: chat.id });
    update({ scope: { all: false, chats } });
  }

  if (!status || !draft) {
    return <><div className="page-head"><div><h1>网页部署</h1><p>让其他设备浏览你的档案网页</p></div></div>
      <section className="panel publish-empty" role="status">{loadError || "正在读取档案库和访问网络…"}</section></>;
  }

  const chosen = status.chats.filter((chat) => chat.ready && (draft.scope.all || selected.get(chat.slug) === chat.id)).length;
  const eligible = status.chats.filter((chat) => chat.ready).length;
  const dirty = JSON.stringify(status.config) !== JSON.stringify(draft);
  const validPort = Number.isInteger(draft.port) && draft.port >= 1 && draft.port <= 65535;
  const canStart = Boolean(status.library && chosen && validPort && (draft.adapter || draft.tailscale));
  const adapters = [{ value: "", label: "关闭局域网访问" }, ...status.adapters.map((adapter) => ({ value: adapter.id, label: `${adapter.name} · ${adapter.ip}` }))];
  if (draft.adapter && !adapters.some((adapter) => adapter.value === draft.adapter)) adapters.push({ value: draft.adapter, label: "已选网卡暂不可用" });

  return (
    <div className="publish-page">
      <div className="page-head">
        <div><h1>网页部署</h1><p>在局域网或 Tailscale 上浏览已生成的档案网页</p></div>
        <div className="actions">
          {status.requested
            ? <button type="button" className="btn ghost" disabled={busy} onClick={() => void save("webPublishStop")}><Square size={14} /> 停止部署</button>
            : <button type="button" className="btn primary" disabled={busy || !canStart} onClick={() => void save("webPublishStart")}><Play size={14} /> 启动部署</button>}
        </div>
      </div>

      <section className="panel publish-status" aria-label="部署状态">
        <div className="publish-status-head">
          <div className="publish-icon"><Globe size={21} /></div>
          <div className="publish-status-title">
            <strong><span className={`publish-dot ${status.phase}`} />{phaseText[status.phase]}</strong>
            <span title={status.library}>{status.library || "尚未打开档案库"}</span>
          </div>
          <div className="publish-count"><b>{status.requested ? status.published : chosen}</b><span>{status.requested ? "已发布聊天" : "待发布聊天"}</span></div>
        </div>
        {status.message && <div className="publish-notice" role="status">{status.message}</div>}
        {status.endpoints.length > 0 && (
          <div className="publish-endpoints">
            {status.endpoints.map((endpoint, index) => {
              const label = endpoint.kind === "tailscale" && endpoint.url ? `Tailscale ${endpoint.url.includes("[") ? "IPv6" : "IPv4"}` : networkName[endpoint.kind];
              return (
              <div className="publish-endpoint" key={endpoint.url || `${endpoint.kind}-${index}`}>
                <span className="publish-endpoint-label">{endpoint.kind === "lan" ? <Wifi size={15} /> : <Shield size={15} />}{label}</span>
                {endpoint.url ? <>
                  <code>{endpoint.url}</code>
                  <div className="publish-endpoint-actions">
                    <button className="btn sm ghost" aria-label={`复制 ${label} 地址`} onClick={() => void act(endpoint, "copy")}><Copy size={13} /> 复制</button>
                    <button className="btn sm ghost" aria-label={`打开 ${label} 地址`} onClick={() => void act(endpoint, "open")}><ExternalLink size={13} /> 打开</button>
                    <button className="btn sm ghost" aria-label={`${label} 二维码`} onClick={() => void act(endpoint, "qr")}><QrCode size={13} /> 二维码</button>
                  </div>
                </> : <span className="publish-endpoint-error">{endpoint.error}</span>}
              </div>
              );
            })}
          </div>
        )}
      </section>

      <div className="publish-grid">
        <section className="panel publish-scope">
          <header className="panel-head"><h3><ListChecks size={15} /> 发布范围</h3><span className="meta">已选 {chosen.toLocaleString()} 个聊天</span></header>
          <div className="publish-body">
            <div className="publish-scope-options" role="radiogroup" aria-label="发布范围">
              <label><input type="radio" name="publish-scope" checked={!draft.scope.all} onChange={() => update({ scope: { all: false, chats: draft.scope.chats ?? [] } })} /><span><b>指定聊天</b><small>自动更新已选聊天</small></span></label>
              <label><input type="radio" name="publish-scope" checked={draft.scope.all} onChange={() => update({ scope: { ...draft.scope, all: true } })} /><span><b>整个档案库</b><small>新生成的聊天网页也会自动发布</small></span></label>
            </div>
            {!status.catalogReady ? <p className="publish-note" role="status">正在读取可发布聊天…</p> : status.chatError ? <p className="publish-note" role="status">{status.chatError}</p> : <>
              <label className="publish-search"><Search size={14} /><input aria-label="搜索可发布的聊天" placeholder="搜索聊天" value={query} onChange={(event) => { setQuery(event.target.value); setLimit(PAGE_SIZE); }} /></label>
              <ul className="publish-chat-list" aria-label="聊天">
                {filtered.slice(0, limit).map((chat) => <li key={chat.slug}>
                  <label className="publish-chat">
                    <input type="checkbox" checked={chat.ready && (draft.scope.all || selected.get(chat.slug) === chat.id)} disabled={!chat.ready || draft.scope.all} onChange={() => toggle(chat)} />
                    <span><b title={chat.name}>{chat.name}</b><small>{chat.ready ? `${chat.messages.toLocaleString()} 条消息` : "需先生成网页"}</small></span>
                  </label>
                  {!chat.ready && <button className="btn sm ghost" onClick={() => { ctx.setSelected(chat.slug); ctx.go("chats"); }}>前往重建</button>}
                </li>)}
              </ul>
              {filtered.length === 0 && <p className="publish-note">{query ? "没有匹配的聊天" : "当前档案库还没有聊天"}</p>}
              {filtered.length > limit && <button className="btn sm ghost" onClick={() => setLimit((n) => n + PAGE_SIZE)}>显示更多</button>}
              {status.chats.length > eligible && <p className="publish-note">{eligible} 个聊天已生成网页</p>}
            </>}
          </div>
        </section>

        <div className="publish-settings">
          <section className="panel">
            <header className="panel-head"><h3><Wifi size={15} /> 访问网络</h3></header>
            <div className="publish-body">
              <div className="field"><span>局域网网卡</span><Select value={draft.adapter} options={adapters} onChange={(adapter) => update({ adapter })} ariaLabel="局域网网卡" disabled={!status.networkReady} /></div>
              {!status.networkReady && <p className="publish-note" role="status">正在检测访问网络…</p>}
              {status.lanError && <div className="publish-help">
                <p className="publish-note">{status.lanError}。请在 Windows 中检查可信 Wi-Fi 或以太网的网络类型。</p>
                <button className="btn sm ghost" onClick={() => void call("webPublishNetworkSettings").catch((e) => ctx.toast(e.message, "error"))}>打开网络设置</button>
              </div>}
              <label className="publish-check"><input type="checkbox" checked={draft.tailscale} onChange={(event) => update({ tailscale: event.target.checked })} /><span><b>允许 Tailscale 访问</b><small>{status.tailError || "使用本机 Tailscale 地址"}</small></span></label>
              <label className="field"><span>端口</span><input type="number" aria-label="部署端口" min={1} max={65535} value={draft.port || ""} disabled={status.requested} onChange={(event) => update({ port: Number(event.target.value) })} /></label>
              {!validPort && <p className="publish-note" role="status">端口须在 1 到 65535 之间</p>}
              <p className="publish-note">能连接到地址的设备可以直接浏览已发布聊天，无需口令。</p>
              <div className="publish-help">
                <button className="btn sm ghost" onClick={() => void call("webPublishFirewall").catch((e) => ctx.toast(e.message, "error"))}><Shield size={13} /> Windows 防火墙</button>
                {draft.tailscale && <details><summary>连接排查</summary><p>确认访问设备已连接到同一 tailnet，并检查 Tailscale 访问规则是否允许此端口。</p></details>}
              </div>
            </div>
          </section>
          <section className="panel">
            <header className="panel-head"><h3><Monitor size={15} /> 后台运行</h3></header>
            <div className="publish-body">
              <label className="publish-check"><input type="checkbox" checked={draft.auto} onChange={(event) => update({ auto: event.target.checked })} /><span><b>登录 Windows 后自动恢复</b><small>恢复上次开启的部署，关闭窗口后在托盘继续运行</small></span></label>
            </div>
          </section>
        </div>
      </div>
      <div className="publish-footer">
        <span aria-live="polite">{busy ? <><LoaderCircle size={13} className="spin" /> 正在应用…</> : dirty ? "有未应用的设置" : "设置已同步"}</span>
        <button className="btn ghost" disabled={busy || !dirty} onClick={() => setDraft(status.config)}><RefreshCw size={13} /> 恢复设置</button>
        <button className="btn primary" disabled={busy || !dirty || !validPort || (status.requested && !draft.adapter && !draft.tailscale)} onClick={() => void save("webPublishSave")}>{status.requested ? "应用设置" : "保存设置"}</button>
      </div>

      {qr && <dialog className="publish-qr" ref={qrDialog} onClose={() => setQR(undefined)} aria-label="扫码打开档案网页">
        <header><h2>扫码打开档案网页</h2><button className="btn sm ghost" aria-label="关闭二维码" onClick={() => qrDialog.current?.close()}><X size={16} /></button></header>
        <img src={qr.src} alt="档案网页访问地址二维码" width={220} height={220} />
        <code>{qr.url}</code>
      </dialog>}
    </div>
  );
}
