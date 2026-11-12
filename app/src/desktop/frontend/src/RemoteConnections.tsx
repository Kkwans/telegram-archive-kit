import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Cloud, Loader2, Network, Pencil, Plus, RefreshCw, Server, Trash2, WifiOff, X } from "lucide-react";
import { ConfirmDialog } from "./ConfirmDialog";
import { dateTime } from "./format";
import { call } from "./rpc";

type RemoteConnectionKind = "unc" | "ssh" | "rclone";
type RemoteConnectionStatus = "offline" | "checking" | "connecting" | "connected" | "missing_tools" | "authentication_required" | "identity_mismatch" | "busy" | "error";

export interface SavedRemoteConnection {
  id: string;
  kind: RemoteConnectionKind;
  name: string;
  label: string;
  path: string;
  drive?: string;
  root: string;
  autoReconnect: boolean;
  active: boolean;
  status: RemoteConnectionStatus;
  message?: string;
  nextRetryAt?: number;
}

const KINDS = {
  unc: { label: "SMB", icon: Network },
  ssh: { label: "SSH / SFTP", icon: Server },
  rclone: { label: "rclone", icon: Cloud },
};

const CONNECTION_STATES: Record<RemoteConnectionStatus, { label: string; tone: string; hint?: string }> = {
  offline: { label: "未连接", tone: "", hint: "请检查网络或 NAS 状态后重连。" },
  checking: { label: "检测中", tone: "running" },
  connecting: { label: "连接中", tone: "running" },
  connected: { label: "已连接", tone: "done" },
  missing_tools: { label: "缺少组件", tone: "partial", hint: "请在「添加连接」中安装所需组件，然后重连。" },
  authentication_required: { label: "需验证", tone: "partial", hint: "请检查 Windows 凭据、SSH 密钥或 rclone 授权，然后重连。" },
  identity_mismatch: { label: "档案库不匹配", tone: "failed", hint: "请确认网络路径仍指向原来的档案库。" },
  busy: { label: "暂时无法连接", tone: "partial", hint: "请完成当前任务或停止网页部署后重连。" },
  error: { label: "连接失败", tone: "failed", hint: "请检查连接配置后重试。" },
};

function address(connection: SavedRemoteConnection) {
  if (connection.kind === "unc") return connection.path || connection.root;
  return `${connection.name}${connection.path ? `:${connection.path}` : ""}`;
}

function connecting(status: RemoteConnectionStatus) {
  return status === "connecting" || status === "checking";
}

export function RemoteConnections({ onAdd, onConnected, onBusy, toast }: {
  onAdd: () => void;
  onConnected: () => void;
  onBusy: (busy: boolean) => void;
  toast: (message: string, error?: boolean) => void;
}) {
  const [items, setItems] = useState<SavedRemoteConnection[] | null>(null);
  const [readError, setReadError] = useState("");
  const [actionError, setActionError] = useState<{ id: string; message: string } | null>(null);
  const [pending, setPending] = useState("");
  const [rename, setRename] = useState<{ id: string; label: string } | null>(null);
  const [forget, setForget] = useState<SavedRemoteConnection | null>(null);
  const [waiting, setWaiting] = useState("");
  const waitRef = useRef("");
  const writeRef = useRef(false);
  const version = useRef(0);
  const connectedRef = useRef(onConnected);
  connectedRef.current = onConnected;

  const finishConnection = useCallback((next: SavedRemoteConnection[]) => {
    const id = waitRef.current;
    const item = next.find((entry) => entry.id === id);
    if (!id || !item || connecting(item.status)) return;
    waitRef.current = "";
    setWaiting("");
    if (item.active && item.status === "connected") {
      connectedRef.current();
      toast(`已连接「${item.label || address(item)}」`);
    }
  }, [toast]);

  const read = useCallback(async (signal?: AbortSignal) => {
    if (writeRef.current) return;
    const seq = ++version.current;
    try {
      const result = await call<{ connections: SavedRemoteConnection[] | null }>("remoteConnectionList", undefined, signal);
      if (seq !== version.current || signal?.aborted) return;
      const next = result.connections ?? [];
      setItems(next);
      setReadError("");
      finishConnection(next);
    } catch (e) {
      if (seq === version.current && !signal?.aborted) setReadError((e as Error).message);
    }
  }, [finishConnection]);

  useEffect(() => {
    const controller = new AbortController();
    let timer = 0;
    const poll = async () => {
      if (!document.hidden) await read(controller.signal);
      if (!controller.signal.aborted) timer = window.setTimeout(poll, waitRef.current ? 1100 : 4500);
    };
    void poll();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [read]);

  const perform = async (id: string, method: string, params: unknown, onSuccess: (next: SavedRemoteConnection | null) => void) => {
    if (writeRef.current) return;
    writeRef.current = true;
    version.current++;
    setPending(id);
    onBusy(true);
    setActionError(null);
    try {
      const next = await call<SavedRemoteConnection | null>(method, params);
      setItems((current) => current?.flatMap((entry) => entry.id !== id ? [entry] : next ? [next] : []) ?? current);
      onSuccess(next);
    } catch (e) {
      setActionError({ id, message: (e as Error).message });
    } finally {
      writeRef.current = false;
      setPending("");
      onBusy(false);
      void read();
    }
  };

  const reconnect = (id: string) => void perform(id, "remoteConnectionReconnect", { id }, (entry) => {
    if (!entry) return;
    waitRef.current = id;
    setWaiting(id);
    finishConnection([entry]);
  });

  return <section className="saved-connections" aria-label="已保存的网络连接">
    <div className="saved-connections-head"><div><h3>已保存的连接</h3><p>重新打开常用网络档案库，或让当前连接随 TAK 启动恢复。</p></div><button type="button" className="btn sm primary" disabled={!!pending} onClick={onAdd}><Plus size={13} /> 添加连接</button></div>
    {readError && <div className="plan-inline-notice" role="alert"><AlertCircle size={14} /><span>{readError}</span><button type="button" className="btn sm ghost" onClick={() => void read()}>重新读取</button></div>}
    {!items && !readError && <div className="panel plan-loading" role="status" aria-label="正在读取已保存的连接">{[0, 1].map((i) => <div key={i}><span className="skeleton-line w-160" /><span className="skeleton-line w-80" /></div>)}</div>}
    {items && !items.length && <div className="saved-connections-empty"><Network size={24} /><b>还没有保存的连接</b><span>连接档案库时勾选「保存此连接」，即可在这里快速打开。</span></div>}
    {!!items?.length && <div className="panel saved-connection-list">
      {items.map((item) => {
        const entry = CONNECTION_STATES[item.status] ?? CONNECTION_STATES.error;
        const { label: kind, icon: Icon } = KINDS[item.kind] ?? KINDS.unc;
        const location = address(item);
        const busy = !!pending || !!waiting;
        const inProgress = waiting === item.id || connecting(item.status);
        const ready = item.active && item.status === "connected";
        const message = actionError?.id === item.id ? actionError.message : item.message || ((item.active || item.status !== "offline") ? entry.hint : "");
        return <article className="saved-connection" key={item.id}>
          <div className="saved-connection-row">
            <span className="saved-connection-icon"><Icon size={16} /></span>
            <div className="saved-connection-name"><b title={item.label || location}>{item.label || location}</b><span title={location}>{kind} · {location}</span></div>
            <div className="saved-connection-status"><span className={`task-state plan-status ${entry.tone}`}>{inProgress ? <Loader2 size={12} className="spin" /> : <span className="plan-status-dot" />}{entry.label}</span>{item.active && <span className="saved-active">当前库</span>}</div>
            <label className="saved-auto"><span>自动重连</span><span className={`switch ${item.autoReconnect ? "on" : ""}`}><input type="checkbox" role="switch" aria-label={`${item.label || location} 自动重连`} checked={item.autoReconnect} disabled={busy} onChange={(event) => void perform(item.id, "remoteConnectionSetAuto", { id: item.id, autoReconnect: event.target.checked }, () => undefined)} /><i /></span></label>
            <div className="saved-connection-actions">
              {!ready && <button type="button" className="btn sm ghost" disabled={busy || inProgress} onClick={() => reconnect(item.id)}>{inProgress ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}{inProgress ? "连接中…" : item.active ? "重新连接" : "打开档案库"}</button>}
              <button type="button" className="icon-btn" title="重命名" aria-label={`重命名 ${item.label || location}`} disabled={busy} onClick={() => setRename({ id: item.id, label: item.label || location })}><Pencil size={13} /></button>
              <button type="button" className="icon-btn danger" title="移除连接" aria-label={`移除连接 ${item.label || location}`} disabled={busy} onClick={() => setForget(item)}><Trash2 size={13} /></button>
            </div>
          </div>
          {rename?.id === item.id && <form className="saved-connection-edit" onSubmit={(event) => { event.preventDefault(); if (rename.label.trim()) void perform(item.id, "remoteConnectionRename", { id: item.id, label: rename.label.trim() }, () => setRename(null)); }}>
            <label className="field"><span>连接名称</span><input type="text" autoFocus value={rename.label} maxLength={100} disabled={busy} onChange={(event) => setRename({ id: item.id, label: event.target.value })} /></label>
            <button type="submit" className="btn sm primary" disabled={busy || !rename.label.trim()}>保存名称</button><button type="button" className="icon-btn" title="取消重命名" aria-label="取消重命名" onClick={() => setRename(null)} disabled={busy}><X size={13} /></button>
          </form>}
          {(message || item.nextRetryAt) && <div className="saved-connection-message" role={actionError?.id === item.id ? "alert" : "status"}><WifiOff size={13} /><span>{message}{item.nextRetryAt ? ` 下次重试 ${dateTime(item.nextRetryAt).replace(/:\d{2}$/, "")}。` : ""}</span>{item.status === "missing_tools" && <button type="button" className="plan-text-button" onClick={onAdd}>查看组件</button>}</div>}
        </article>;
      })}
    </div>}
    <ConfirmDialog open={!!forget} title={`移除连接「${forget?.label || (forget ? address(forget) : "")}」？`} message="TAK 会移除此连接及其自动重连设置。档案库文件会保留。" confirmLabel="移除连接" danger onCancel={() => setForget(null)} onConfirm={() => { const id = forget?.id; setForget(null); if (id) void perform(id, "remoteConnectionForget", { id }, () => toast("已移除保存的连接")); }} />
  </section>;
}
