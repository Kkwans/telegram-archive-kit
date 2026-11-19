import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  CheckCircle2,
  CloudDownload,
  FileText,
  HardDrive,
  Image as ImageIcon,
  Loader2,
  Music2,
  RefreshCw,
  Search,
  Video,
  X,
} from "lucide-react";
import { call } from "./rpc";
import { bytes } from "./format";
import { ConfirmDialog } from "./ConfirmDialog";
import type { BackfillPreview, BulkPreview, ChatRow, OnlineChat, OnlineChats, OnlineExportPreview, OnlineExportProgress, OnlineExportResult } from "./types";

export interface OnlineUpdateTarget {
  peer: string;
  name: string;
  type?: string;
  id?: number | string;
  avatar?: string;
  /** Existing local workspace to merge into (official ChatExport imports). */
  slug?: string;
  /** online pulls history; backfill/sync only complete missing files; bulk covers every chat. */
  mode?: "online" | "backfill" | "sync" | "bulk";
}

const TYPE_LABEL: Record<string, string> = {
  private: "私聊",
  bot: "机器人",
  group: "群组",
  channel: "频道",
};

export function onlineTargetFromChat(chat: {
  peer: string;
  name: string;
  type?: string;
  id?: number | string;
  avatar?: string;
}): OnlineUpdateTarget {
  return { peer: chat.peer, name: chat.name, type: chat.type, id: chat.id, avatar: chat.avatar };
}

function initials(name: string): string {
  return Array.from(name.trim())[0] || "?";
}

function avatarStyle(peer: string): CSSProperties {
  const seed = Array.from(peer).reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) % 360, 7);
  return {
    background: `linear-gradient(135deg, hsl(${seed} 54% 52%), hsl(${(seed + 38) % 360} 58% 38%))`,
  };
}

export function OnlineChatPickerDialog({
  open,
  title,
  chats,
  loading,
  error,
  currentPeer,
  onClose,
  onSelect,
}: {
  open: boolean;
  title: string;
  chats: OnlineChat[];
  loading?: boolean;
  error?: string;
  currentPeer?: string;
  onClose: () => void;
  onSelect: (chat: OnlineChat) => void;
}) {
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);
  if (!open) return null;
  const q = query.trim().toLocaleLowerCase();
  const results = q
    ? chats.filter((chat) => `${chat.name} ${chat.username || ""} ${chat.peer}`.toLocaleLowerCase().includes(q)).slice(0, 40)
    : [];
  return createPortal(
    <div className="modal-backdrop" role="presentation">
      <div className="modal online-picker-modal" role="dialog" aria-modal="true" aria-labelledby="online-picker-title">
        <div className="task-modal-head">
          <div>
            <span className="export-preview-kicker">手动匹配</span>
            <h2 id="online-picker-title">{title}</h2>
            <p className="modal-sub">按名称或用户名搜索在线聊天，选定后会重新统计该聊天的更新内容。</p>
          </div>
          <button className="icon-btn" aria-label="关闭在线聊天选择" onClick={onClose}><X size={15} /></button>
        </div>
        <label className="online-picker-search">
          <Search size={14} />
          <input
            autoFocus
            type="search"
            value={query}
            placeholder="搜索在线聊天名称或 @用户名"
            onChange={(event) => setQuery(event.target.value)}
            aria-label="搜索在线聊天"
          />
        </label>
        <div className="online-picker-list">
          {loading ? (
            <div className="online-picker-empty"><Loader2 size={18} className="spin" /><span>正在读取在线聊天…</span></div>
          ) : error ? (
            <div className="online-picker-empty"><AlertCircle size={18} /><span>{error}</span></div>
          ) : !q ? (
            <div className="online-picker-empty"><Search size={18} /><b>输入关键词开始搜索</b><span>不会一次列出全部聊天，避免同名或相似名称选错。</span></div>
          ) : results.length === 0 ? (
            <div className="online-picker-empty"><AlertCircle size={18} /><span>没有匹配「{query.trim()}」的在线聊天</span></div>
          ) : results.map((chat) => (
            <button
              type="button"
              key={chat.peer}
              className={`online-picker-row ${chat.peer === currentPeer ? "current" : ""}`}
              onClick={() => onSelect(chat)}
            >
              {chat.avatar ? <img className="online-avatar" src={chat.avatar} alt="" /> : <span className="online-avatar" style={avatarStyle(chat.peer)}>{initials(chat.name)}</span>}
              <span className="online-picker-name">
                <b>{chat.name}</b>
                <small>{TYPE_LABEL[chat.type] || chat.type || "会话"}{chat.username ? ` · @${chat.username}` : ""} · ID {chat.id}</small>
              </span>
              {chat.localSlug && <span className="online-picker-local">本地已有</span>}
              {chat.peer === currentPeer && <CheckCircle2 size={14} className="ok" />}
            </button>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function samePreviewProgress(a: OnlineExportProgress | null, b: OnlineExportProgress): boolean {
  return a !== null && a.active === b.active && a.stage === b.stage && a.detail === b.detail &&
    a.percent === b.percent && a.messages === b.messages && a.media === b.media;
}

export function OnlineUpdateDialog({
  target,
  onClose,
  onStarted,
  toast,
}: {
  target: OnlineUpdateTarget;
  onClose: () => void;
  onStarted: (taskId: string) => void;
  toast: (msg: string, err?: boolean) => void;
}) {
  const [preview, setPreview] = useState<OnlineExportPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [previewProgress, setPreviewProgress] = useState<OnlineExportProgress | null>(null);
  const [upToDate, setUpToDate] = useState(false);
  const [closeConfirm, setCloseConfirm] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [floodUntil, setFloodUntil] = useState(0);
  const [clock, setClock] = useState(Date.now());
  const [peerOverride, setPeerOverride] = useState<OnlineChat | null>(null);
  const [matchOpen, setMatchOpen] = useState(false);
  const [matchChats, setMatchChats] = useState<OnlineChat[]>([]);
  const [matchLoading, setMatchLoading] = useState(false);
  const [matchError, setMatchError] = useState("");
  const seq = useRef(0);
  const token = useRef("");
  const loadingRef = useRef(false);
  const isOnlinePreview = target.mode !== "bulk" && target.mode !== "backfill" && target.mode !== "sync";
  const canRematch = target.mode === "online" && Boolean(target.slug);
  const activePeer = peerOverride?.peer || target.peer;
  const activeName = peerOverride?.name || target.name;
  const activeType = peerOverride ? peerOverride.type : target.type;
  const activeID = peerOverride ? peerOverride.id : target.id;
  const activeAvatar = peerOverride ? peerOverride.avatar : target.avatar;

  useEffect(() => {
    loadingRef.current = previewLoading;
  }, [previewLoading]);

  useEffect(() => {
    if (!floodUntil) return;
    const tick = () => {
      const now = Date.now();
      setClock((previous) => {
        const currentSeconds = Math.max(0, Math.ceil((floodUntil - previous) / 1000));
        const nextSeconds = Math.max(0, Math.ceil((floodUntil - now) / 1000));
        return currentSeconds === nextSeconds ? previous : now;
      });
      if (now >= floodUntil) setFloodUntil(0);
    };
    const timer = window.setInterval(tick, 500);
    return () => window.clearInterval(timer);
  }, [floodUntil]);

  const floodLeft = Math.max(0, Math.ceil((floodUntil - clock) / 1000));

  const noteError = (message: string, report?: (text: string) => void) => {
    const match = message.match(/等待\s*(\d+)\s*秒/) || message.match(/FLOOD_WAIT[^0-9]*(\d+)/i);
    if (match) {
      const seconds = Math.max(1, Number(match[1]));
      setFloodUntil(Date.now() + seconds * 1000);
      setClock(Date.now());
      const text = `Telegram 限流，请等待 ${seconds} 秒后再试`;
      report?.(text);
      toast(text, true);
      return;
    }
    report?.(message);
    toast(message, true);
  };

  const discardPrepared = () => {
    if (token.current) {
      void call("onlineExportDiscard", { token: token.current }).catch(() => undefined);
      token.current = "";
    }
  };

  const close = () => {
    if (loadingRef.current && isOnlinePreview) void call("onlineExportPreviewCancel").catch(() => undefined);
    seq.current++;
    discardPrepared();
    onClose();
  };

  const requestClose = () => {
    if (exporting) return;
    if (previewLoading) {
      setCloseConfirm(true);
      return;
    }
    close();
  };

  const beginPreview = async () => {
    if (previewLoading || exporting) return;
    const id = ++seq.current;
    setPreview(null);
    setPreviewError("");
    setUpToDate(false);
    setPreviewProgress({ active: true, stage: "准备统计", detail: isOnlinePreview ? "正在连接 Telegram" : "正在核对本地媒体", percent: 1, messages: 0, media: 0 });
    setPreviewLoading(true);
    loadingRef.current = true;
    try {
      if (target.mode === "bulk") {
        const res = await call<BulkPreview>("previewSyncAll", {});
        if (id !== seq.current) return;
        const base: OnlineExportPreview = {
          peer: target.peer,
          chat: "全部缺失媒体",
          existed: false,
          backfillOnly: true,
          chats: res.chats,
          messages: 0,
          service: 0,
          images: res.images,
          videos: res.videos,
          audio: res.audio,
          files: res.files,
          other: res.other,
          media: res.missing,
          bytes: res.knownBytes,
          localMissing: res.missing,
          missingBytes: res.knownBytes,
          freeBytes: res.freeBytes,
          spaceNeedBytes: res.knownBytes,
          spaceShort: res.spaceShort,
        };
        setPreview(base);
        if (res.missing === 0) setUpToDate(true);
        return;
      }
      if (target.mode === "backfill" || target.mode === "sync") {
        const res = await call<BackfillPreview>("previewBackfill", { slug: target.slug || "" });
        if (id !== seq.current) return;
        const base: OnlineExportPreview = {
          peer: target.peer,
          chat: res.chat,
          existed: true,
          backfillOnly: true,
          messages: 0,
          service: 0,
          images: res.images,
          videos: res.videos,
          audio: res.audio,
          files: res.files,
          other: res.other,
          media: res.missing,
          bytes: res.knownBytes,
          localMessages: res.messages,
          localMedia: res.media,
          localMissing: res.missing,
          missingBytes: res.knownBytes,
          freeBytes: res.freeBytes,
          spaceNeedBytes: res.knownBytes,
          spaceShort: res.spaceShort,
        };
        setPreview(base);
        if (res.missing === 0) setUpToDate(true);
        return;
      }
      const res = await call<OnlineExportPreview>("onlineExportPreview", { peer: activePeer, timeout: 300, slug: target.slug || "" });
      if (id !== seq.current) {
        if (res.token) void call("onlineExportDiscard", { token: res.token }).catch(() => undefined);
        return;
      }
      if (res.upToDate) {
        // Keep the dialog open: a silently disappearing window looks like a crash.
        setPreview(res);
        setUpToDate(true);
        return;
      }
      token.current = res.token || "";
      setPreview(res);
    } catch (e) {
      if (id !== seq.current) return;
      noteError((e as Error).message, setPreviewError);
    } finally {
      if (id === seq.current) {
        setPreviewLoading(false);
        loadingRef.current = false;
      }
    }
  };

  useEffect(() => {
    void beginPreview();
    return () => {
      seq.current++;
      if (loadingRef.current && isOnlinePreview) void call("onlineExportPreviewCancel").catch(() => undefined);
      discardPrepared();
    };
    // Start exactly once for the selected target, and again after a manual rematch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePeer, target.mode, target.slug]);

  useEffect(() => {
    if (!previewLoading) {
      setPreviewProgress(null);
      return;
    }
    // Local backfill and bulk previews do not publish online progress.
    if (!isOnlinePreview) return;
    let alive = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const progress = await call<OnlineExportProgress>("onlineExportPreviewProgress");
        if (alive && progress.active) {
          setPreviewProgress((current) => samePreviewProgress(current, progress) ? current : progress);
        }
      } catch { /* Keep the last progress until the next poll. */ }
      if (alive) timer = window.setTimeout(poll, 400);
    };
    void poll();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [previewLoading, isOnlinePreview, activePeer, target.slug]);

  const runExport = async () => {
    if (!preview || exporting) return;
    if (preview.spaceShort) {
      setPreviewError(`磁盘空间不足：本次需要约 ${bytes(preview.spaceNeedBytes || preview.bytes)}，当前可用 ${bytes(preview.freeBytes || 0)}。请清理空间或更换档案库位置后再试。`);
      return;
    }
    setExporting(true);
    setPreviewError("");
    try {
      if (target.mode === "bulk") {
        await call("startSyncAllMissing");
        onClose();
        toast("批量同步任务已加入任务中心");
        return;
      }
      if (target.mode === "backfill" || target.mode === "sync" || preview.backfillOnly) {
        const taskId = await call<string>("startOneClick", { slug: target.slug || "" });
        onClose();
        toast("已开始补全缺失媒体");
        if (taskId) onStarted(taskId);
        return;
      }
      const res = await call<OnlineExportResult>("onlineExport", { peer: preview.peer, timeout: 300, token: preview.token || "", slug: target.slug || "" });
      if (res.upToDate) {
        setUpToDate(true);
        setPreview((current) => current ? { ...current, messages: 0, media: 0, bytes: 0 } : current);
        return;
      }
      token.current = "";
      onClose();
      toast(`已开始归档：${res.chat} · ${res.messages.toLocaleString()} 条消息`);
      if (res.taskId) onStarted(res.taskId);
    } catch (e) {
      noteError((e as Error).message, setPreviewError);
    } finally {
      setExporting(false);
    }
  };

  const openMatch = async () => {
    if (previewLoading || exporting) return;
    setMatchOpen(true);
    setMatchError("");
    if (matchChats.length > 0) return;
    setMatchLoading(true);
    try {
      const res = await call<OnlineChats>("onlineChats", { timeout: 60 });
      setMatchChats(res.chats);
    } catch (e) {
      setMatchError((e as Error).message);
    } finally {
      setMatchLoading(false);
    }
  };

  const previewStats = preview ? [
    { key: "images", label: "图片", value: preview.images, icon: <ImageIcon size={14} /> },
    { key: "videos", label: "视频", value: preview.videos, icon: <Video size={14} /> },
    { key: "audio", label: "音频", value: preview.audio, icon: <Music2 size={14} /> },
    { key: "files", label: "文件", value: preview.files, icon: <FileText size={14} /> },
  ] : [];
  const isBackfill = target.mode === "backfill" || target.mode === "sync" || target.mode === "bulk" || Boolean(preview?.backfillOnly);
  const isBulk = target.mode === "bulk";
  const primaryLabel = isBulk || target.mode === "sync" ? "开始同步" : isBackfill ? "开始补全" : "开始归档";

  return (
    <>
      {createPortal(
        <div className="modal-backdrop" role="presentation">
          <div className="modal export-preview-modal" role="dialog" aria-modal="true" aria-labelledby="online-update-title">
            <div className="export-preview-head">
              {target.mode !== "online" ? (
                <span className="online-avatar" style={avatarStyle(target.peer)}><HardDrive size={18} /></span>
              ) : activeAvatar ? (
                <img className="online-avatar" src={activeAvatar} alt="" />
              ) : (
                <span className="online-avatar" style={avatarStyle(activePeer)}>{initials(activeName)}</span>
              )}
              <div className="export-preview-head-text">
                <span className="export-preview-kicker">{isBulk ? "批量下载预览" : target.mode === "sync" ? "下载前统计" : isBackfill ? "本地补全预览" : "在线更新预览"}</span>
                <h2 id="online-update-title">{activeName}</h2>
                <p className="modal-sub">
                  {TYPE_LABEL[activeType || ""] || activeType || "会话"}
                  {activeID != null ? ` · ID ${activeID}` : ""}
                </p>
                {canRematch && (
                  <button type="button" className="online-match-link" disabled={previewLoading || exporting} onClick={() => void openMatch()}>
                    <Search size={11} /> {peerOverride ? "已更换在线会话" : "名称匹配不对？手动选择"}
                  </button>
                )}
              </div>
            </div>

            {previewLoading ? (
              <div className="export-preview-loading export-preview-progress">
                <div className="export-loading-head">
                  <span className="export-loading-spinner"><Loader2 size={18} className="spin" /></span>
                  <div className="export-loading-copy">
                    <b>{previewProgress?.stage || "正在读取消息并统计媒体…"}</b>
                    <span>{previewProgress?.detail || "首次统计会读取完整历史；遇到 Telegram 限流会自动等待后继续。"}</span>
                  </div>
                  <strong className="export-loading-percent">{Math.round(previewProgress?.percent ?? 0)}<em>%</em></strong>
                </div>
                <div className="export-loading-track">
                  <i style={{ width: `${Math.max(2, Math.min(100, previewProgress?.percent ?? 0))}%` }} />
                </div>
                <div className="export-loading-meta">
                  <span>已读取 <b>{(previewProgress?.messages ?? 0).toLocaleString()}</b> 条消息</span>
                  <span>发现 <b>{(previewProgress?.media ?? 0).toLocaleString()}</b> 个媒体</span>
                </div>
              </div>
            ) : upToDate ? (
              <div className="online-banner ok" role="status">
                <div className="online-banner-title">
                  <CheckCircle2 size={15} />
                  <b>{isBackfill ? "媒体已完整" : "已是最新"}</b>
                </div>
                <span>
                  {isBulk
                    ? "所选聊天没有需要下载的媒体。"
                    : isBackfill
                      ? `没有需要补全的媒体。本地已有 ${(preview?.localMessages ?? 0).toLocaleString()} 条消息、${(preview?.localMedia ?? 0).toLocaleString()} 个媒体。`
                      : `没有需要归档的新消息。本地已有 ${(preview?.localMessages ?? 0).toLocaleString()} 条消息、${(preview?.localMedia ?? 0).toLocaleString()} 个媒体。`}
                </span>
              </div>
            ) : preview ? (
              <>
                <div className={`export-preview-lead ${isBulk ? "three" : ""}`}>
                  {isBulk && (
                    <div>
                      <span>待同步聊天</span>
                      <b>{(preview.chats ?? 0).toLocaleString()} <em>个</em></b>
                    </div>
                  )}
                  <div>
                    <span>{isBackfill ? "待补全媒体" : "本次新增"}</span>
                    <b>{isBackfill ? preview.media.toLocaleString() : preview.messages.toLocaleString()} <em>{isBackfill ? "个媒体" : "条消息"}</em></b>
                  </div>
                  <div>
                    <span>预计下载</span>
                    <b>{preview.bytes > 0 ? bytes(preview.bytes) : "—"}</b>
                  </div>
                </div>

                <div className="export-preview-media">
                  {previewStats.map((stat) => (
                    <div key={stat.key} className="export-preview-item">
                      <span className="export-preview-item-icon">{stat.icon}</span>
                      <span>{stat.label}</span>
                      <b>{stat.value.toLocaleString()}</b>
                    </div>
                  ))}
                </div>

                {preview.existed && !isBulk && (
                  <div className="export-preview-existing">
                    <RefreshCw size={13} />
                    <span>
                      {isBackfill
                        ? `本地已有 ${(preview.localMessages ?? 0).toLocaleString()} 条消息 · ${(preview.localMedia ?? 0).toLocaleString()} 个媒体；本次只补下缺失文件，不重新读取 Telegram 历史。`
                        : `本地已有 ${(preview.localMessages ?? 0).toLocaleString()} 条消息 · ${(preview.localMedia ?? 0).toLocaleString()} 个媒体，本次只合并新消息。${preview.localMissing ? ` 另有 ${preview.localMissing.toLocaleString()} 个缺失媒体会一并补全。` : ""}`}
                    </span>
                  </div>
                )}

                {preview.other > 0 && (
                  <p className="export-preview-note">含 {preview.other.toLocaleString()} 个其他媒体（位置、投票、联系人等），已计入文件。</p>
                )}
                <p className="export-preview-note">
                  <HardDrive size={12} /> {isBackfill
                    ? "大小按 result.json 返回的文件尺寸估算，仅统计实际缺失的媒体，与任务详情的总量一致；实际下载可能略有差异。"
                    : "大小按 Telegram 返回的文件尺寸估算，包含本次新增消息与此前缺失的媒体，与任务详情的总量一致；实际下载可能略有差异。"}
                  {preview.service > 0 ? ` 包含 ${preview.service.toLocaleString()} 条服务消息。` : ""}
                </p>
              </>
            ) : null}

            {previewError && (
              <div className="online-banner export-preview-error" role="status">
                <AlertCircle size={15} />
                <span>{previewError}</span>
              </div>
            )}

            {preview && !upToDate && preview.spaceShort && (
              <div className="online-banner export-preview-error" role="status">
                <AlertCircle size={15} />
                <span>
                  磁盘空间不足：本次需要约 {bytes(preview.spaceNeedBytes || preview.bytes)}，当前可用 {bytes(preview.freeBytes || 0)}。
                  请清理空间或更换档案库位置后再试。
                </span>
              </div>
            )}

            <div className="modal-actions">
              <button className="btn ghost" disabled={exporting} onClick={requestClose}>
                {preview && !upToDate ? "取消" : "关闭"}
              </button>
              {preview && !upToDate ? (
                <button className="btn primary" disabled={exporting || floodLeft > 0 || Boolean(preview.spaceShort)} onClick={() => void runExport()}>
                  {exporting ? <Loader2 size={13} className="spin" /> : <CloudDownload size={13} />}
                  {exporting
                    ? (isBackfill ? "正在创建任务…" : "正在归档…")
                    : floodLeft > 0
                      ? `等待 ${floodLeft} 秒`
                      : primaryLabel}
                </button>
              ) : !previewLoading ? (
                <button className="btn primary" disabled={floodLeft > 0} onClick={() => void beginPreview()}>
                  {floodLeft > 0 ? <Loader2 size={13} /> : <RefreshCw size={13} />}
                  {floodLeft > 0 ? `等待 ${floodLeft} 秒` : isBackfill ? "重新检查" : "重新统计"}
                </button>
              ) : null}
            </div>
          </div>
        </div>,
        document.body
      )}

      <ConfirmDialog
        open={closeConfirm}
        title="停止统计并关闭？"
        message="媒体统计仍在读取完整历史。现在关闭会中断统计，下次需要重新开始并重新等待。"
        confirmLabel="关闭预览"
        cancelLabel="继续等待"
        danger
        onConfirm={() => { setCloseConfirm(false); close(); }}
        onCancel={() => setCloseConfirm(false)}
      />

      <OnlineChatPickerDialog
        open={matchOpen}
        title={`为「${target.name}」选择在线会话`}
        chats={matchChats}
        loading={matchLoading}
        error={matchError}
        currentPeer={activePeer}
        onClose={() => setMatchOpen(false)}
        onSelect={(chat) => {
          setMatchOpen(false);
          setPeerOverride(chat);
        }}
      />
    </>
  );
}
type AllUpdateStatus = "pending" | "checking" | "ready" | "up-to-date" | "missing" | "failed";

interface AllUpdateRow {
  chat: ChatRow;
  online?: OnlineChat;
  status: AllUpdateStatus;
  preview?: OnlineExportPreview;
  error?: string;
}

const allUpdateStatusLabel: Record<AllUpdateStatus, string> = {
  pending: "等待统计", checking: "统计中", ready: "待更新", "up-to-date": "已是最新",
  missing: "未自动匹配", failed: "统计失败",
};

function normalizeMatchName(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function findOnlinePeer(online: OnlineChat[], chats: ChatRow[], chat: ChatRow): OnlineChat | undefined {
  const slug = online.find((item) => item.localSlug === chat.slug);
  if (slug) return slug;
  const name = normalizeMatchName(chat.name);
  if (!name) return undefined;
  // Two local chats with the same title must be matched by hand.
  if (chats.filter((item) => normalizeMatchName(item.name) === name).length !== 1) return undefined;
  const matches = online.filter((item) => normalizeMatchName(item.name) === name);
  return matches.length === 1 ? matches[0] : undefined;
}

export function AllOnlineUpdateDialog({ chats, onClose, onStarted, toast }: {
  chats: ChatRow[];
  onClose: () => void;
  onStarted: (taskId: string) => void;
  toast: (message: string, error?: boolean) => void;
}) {
  const [rows, setRows] = useState<AllUpdateRow[]>(() => chats.map((chat) => ({ chat, status: "pending" })));
  const [onlineChats, setOnlineChats] = useState<OnlineChat[]>([]);
  const [onlineError, setOnlineError] = useState("");
  const [scanIndex, setScanIndex] = useState(0);
  const [scanning, setScanning] = useState(true);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState("");
  const [matchingSlug, setMatchingSlug] = useState("");
  const [picker, setPicker] = useState<{ slug: string; name: string; currentPeer?: string } | null>(null);
  const alive = useRef(true);
  const started = useRef(false);
  const tokenMap = useRef(new Map<string, string>());
  const rowsRef = useRef(rows);

  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  const discardTokens = () => {
    for (const token of tokenMap.current.values()) {
      void call("onlineExportDiscard", { token }).catch(() => undefined);
    }
    tokenMap.current.clear();
  };

  useEffect(() => () => {
    alive.current = false;
    if (!started.current) discardTokens();
  }, []);

  const updateRow = (slug: string, patch: Partial<AllUpdateRow>) => {
    setRows((current) => current.map((row) => row.chat.slug === slug ? { ...row, ...patch } : row));
  };

  const close = () => {
    if (starting) return;
    alive.current = false;
    if (scanning || matchingSlug) void call("onlineExportPreviewCancel").catch(() => undefined);
    if (!started.current) discardTokens();
    onClose();
  };

  useEffect(() => {
    const prepare = async () => {
      try {
        const res = await call<OnlineChats>("onlineChats", { timeout: 60 });
        if (!alive.current) return;
        setOnlineChats(res.chats);
        for (let index = 0; index < chats.length; index++) {
          if (!alive.current) return;
          const chat = chats[index];
          const peer = findOnlinePeer(res.chats, chats, chat);
          if (!peer) {
            updateRow(chat.slug, { status: "missing", online: undefined, preview: undefined, error: undefined });
            setScanIndex(index + 1);
            continue;
          }
          updateRow(chat.slug, { status: "checking", online: peer, preview: undefined, error: undefined });
          try {
            const preview = await call<OnlineExportPreview>("onlineExportPreview", { peer: peer.peer, timeout: 300, slug: chat.slug });
            if (!alive.current) {
              if (preview.token) void call("onlineExportDiscard", { token: preview.token }).catch(() => undefined);
              return;
            }
            if (preview.token) tokenMap.current.set(chat.slug, preview.token);
            updateRow(chat.slug, { preview, online: peer, status: preview.upToDate ? "up-to-date" : "ready" });
          } catch (error) {
            if (!alive.current) return;
            updateRow(chat.slug, { status: "failed", error: (error as Error).message });
          }
          setScanIndex(index + 1);
        }
      } catch (error) {
        if (!alive.current) return;
        const message = (error as Error).message;
        setOnlineError(message);
        setRows((current) => current.map((row) => ({ ...row, status: "failed", error: message })));
      } finally {
        if (alive.current) setScanning(false);
      }
    };
    void prepare();
    // Scan once when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rematch = async (row: AllUpdateRow, peer: OnlineChat) => {
    if (scanning || starting || matchingSlug) return;
    setPicker(null);
    const old = tokenMap.current.get(row.chat.slug);
    if (old) {
      void call("onlineExportDiscard", { token: old }).catch(() => undefined);
      tokenMap.current.delete(row.chat.slug);
    }
    setMatchingSlug(row.chat.slug);
    updateRow(row.chat.slug, { online: peer, status: "checking", preview: undefined, error: undefined });
    try {
      const preview = await call<OnlineExportPreview>("onlineExportPreview", { peer: peer.peer, timeout: 300, slug: row.chat.slug });
      if (!alive.current) {
        if (preview.token) void call("onlineExportDiscard", { token: preview.token }).catch(() => undefined);
        return;
      }
      if (preview.token) tokenMap.current.set(row.chat.slug, preview.token);
      updateRow(row.chat.slug, { preview, online: peer, status: preview.upToDate ? "up-to-date" : "ready" });
    } catch (error) {
      if (alive.current) updateRow(row.chat.slug, { status: "failed", error: (error as Error).message });
    } finally {
      if (alive.current) setMatchingSlug("");
    }
  };

  const ready = rows.filter((row) => row.status === "ready" && row.preview && !row.preview.upToDate);
  const totals = ready.reduce((out, row) => {
    const preview = row.preview!;
    out.messages += preview.messages;
    out.media += preview.media;
    out.images += preview.images;
    out.videos += preview.videos;
    out.audio += preview.audio;
    out.files += preview.files;
    out.bytes += preview.bytes;
    return out;
  }, { messages: 0, media: 0, images: 0, videos: 0, audio: 0, files: 0, bytes: 0 });
  const upToDateCount = rows.filter((row) => row.status === "up-to-date").length;
  const missingCount = rows.filter((row) => row.status === "missing").length;
  const failedCount = rows.filter((row) => row.status === "failed").length;
  const busy = scanning || starting || Boolean(matchingSlug);

  const start = async () => {
    if (busy || ready.length === 0) return;
    setStarting(true);
    setStartError("");
    try {
      const items = ready.map((row) => {
        const preview = row.preview!;
        return {
          slug: row.chat.slug,
          name: row.chat.name,
          peer: preview.peer,
          onlineName: row.online?.name || preview.chat,
          token: preview.token || "",
          messages: preview.messages,
          media: preview.media,
          images: preview.images,
          videos: preview.videos,
          audio: preview.audio,
          files: preview.files,
          bytes: preview.bytes,
        };
      });
      const res = await call<{ taskId: string }>("startOnlineUpdateBatch", { batch: items });
      started.current = true;
      tokenMap.current.clear();
      setStarting(false);
      onStarted(res.taskId);
    } catch (error) {
      setStarting(false);
      setStartError((error as Error).message);
      toast((error as Error).message, true);
    }
  };

  const scanPercent = rows.length ? Math.round(scanIndex * 100 / rows.length) : 0;

  return createPortal(
    <>
      <div className="modal-backdrop" role="presentation">
        <div className="modal export-preview-modal all-update-modal" role="dialog" aria-modal="true" aria-labelledby="all-update-title">
          <div className="export-preview-head">
            <span className="online-avatar" style={{ background: "linear-gradient(135deg, #5a7bff, #7c5cff)" }}><RefreshCw size={18} /></span>
            <div className="export-preview-head-text">
              <span className="export-preview-kicker">批量在线更新</span>
              <h2 id="all-update-title">更新全部聊天</h2>
              <p>默认按 Chat ID 或唯一名称自动匹配，名称不一致或同名时可在列表里手动选择。确认后创建后台任务，可随时关闭界面。</p>
            </div>
            <button className="icon-btn" aria-label="关闭全部更新" disabled={starting} onClick={close}><X size={15} /></button>
          </div>

          <div className="all-update-progress" role="status">
            <div><i style={{ width: `${scanning ? Math.max(2, scanPercent) : 100}%` }} /></div>
            <span>{scanning ? `统计中 ${scanIndex} / ${rows.length}` : `统计完成 · ${ready.length} 个可更新`}</span>
          </div>

          <div className="all-update-summary">
            <div className="all-update-summary-main">
              <span>待更新聊天</span>
              <b>{ready.length}<em> / {rows.length}</em></b>
              <small>{scanning ? `已统计 ${scanIndex} 个` : `${upToDateCount} 个已最新 · ${missingCount} 个未匹配${failedCount ? ` · ${failedCount} 个失败` : ""}`}</small>
            </div>
            <div><span>新增消息</span><b>{totals.messages.toLocaleString()}</b></div>
            <div><span>媒体合计</span><b>{totals.media.toLocaleString()}</b></div>
            <div><span>预计下载</span><b>{totals.bytes > 0 ? bytes(totals.bytes) : "—"}</b></div>
          </div>

          <div className="all-update-types">
            <span><ImageIcon size={13} /> 图片 <b>{totals.images.toLocaleString()}</b></span>
            <span><Video size={13} /> 视频 <b>{totals.videos.toLocaleString()}</b></span>
            <span><Music2 size={13} /> 音频 <b>{totals.audio.toLocaleString()}</b></span>
            <span><FileText size={13} /> 文件 <b>{totals.files.toLocaleString()}</b></span>
          </div>

          <div className="all-update-list">
            {rows.map((row) => {
              const rowPreview = row.preview && !row.preview.upToDate ? row.preview : null;
              const checking = row.status === "checking" || matchingSlug === row.chat.slug;
              return (
                <div className={`all-update-row status-${row.status}`} key={row.chat.slug}>
                  {row.online?.avatar
                    ? <img className="online-avatar" src={row.online.avatar} alt="" />
                    : <span className="online-avatar" style={avatarStyle(row.online?.peer || row.chat.slug)}>{initials(row.chat.name)}</span>}
                  <span className="all-update-name">
                    <b>{row.chat.name}</b>
                    <small data-tip={row.error || undefined}>
                      {row.error || (checking
                        ? "正在统计在线消息…"
                        : row.online
                          ? `在线：${row.online.name}${row.online.username ? ` · @${row.online.username}` : ""}`
                          : allUpdateStatusLabel[row.status])}
                    </small>
                  </span>
                  {rowPreview ? (
                    <>
                      <span className="all-update-metrics">
                        <span data-tip="图片"><ImageIcon size={12} /><em>图片</em>{rowPreview.images.toLocaleString()}</span>
                        <span data-tip="视频"><Video size={12} /><em>视频</em>{rowPreview.videos.toLocaleString()}</span>
                        <span data-tip="音频"><Music2 size={12} /><em>音频</em>{rowPreview.audio.toLocaleString()}</span>
                        <span data-tip="文件"><FileText size={12} /><em>文件</em>{rowPreview.files.toLocaleString()}</span>
                      </span>
                      <span className="all-update-size">
                        <b>{rowPreview.bytes > 0 ? bytes(rowPreview.bytes) : "—"}</b>
                        <small>{rowPreview.messages.toLocaleString()} 条新增 · {rowPreview.media.toLocaleString()} 个媒体</small>
                      </span>
                    </>
                  ) : (
                    <span className="all-update-size all-update-empty">
                      <b>{checking ? "统计中" : row.status === "up-to-date" ? "已是最新" : row.status === "missing" ? "未匹配在线会话" : row.status === "failed" ? "统计失败" : "等待统计"}</b>
                      <small>{row.status === "up-to-date" ? "没有需要更新的内容" : row.status === "missing" ? "请手动选择对应的在线聊天" : ""}</small>
                    </span>
                  )}
                  <button
                    type="button"
                    className="btn sm ghost all-update-match"
                    disabled={busy}
                    onClick={() => setPicker({ slug: row.chat.slug, name: row.chat.name, currentPeer: row.online?.peer })}
                    data-tip={row.online ? `当前匹配：${row.online.name}` : "搜索并选择在线聊天"}
                  >
                    {checking ? <Loader2 size={12} className="spin" /> : <Search size={12} />}
                    {row.online ? "更换" : "选择聊天"}
                  </button>
                  <span className="all-update-mark">
                    {checking ? <Loader2 size={14} className="spin" /> : row.status === "up-to-date" ? <CheckCircle2 size={14} className="ok" /> : row.status === "failed" || row.status === "missing" ? <AlertCircle size={14} className="warn" /> : null}
                  </span>
                </div>
              );
            })}
          </div>

          {(startError || onlineError) && (
            <div className="online-banner export-preview-error" role="status">
              <AlertCircle size={15} />
              <span>{startError || onlineError}</span>
            </div>
          )}

          <div className="modal-actions">
            <button className="btn ghost" disabled={starting} onClick={close}>取消</button>
            <button className="btn primary" disabled={busy || ready.length === 0} onClick={() => void start()}>
              {scanning || starting || matchingSlug ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
              {scanning ? "正在统计…" : starting ? "正在创建任务…" : matchingSlug ? "正在重新统计…" : ready.length ? `开始更新 ${ready.length} 个聊天` : "没有可更新的聊天"}
            </button>
          </div>
        </div>
      </div>

      <OnlineChatPickerDialog
        open={Boolean(picker)}
        title={`为「${picker?.name || ""}」选择在线会话`}
        chats={onlineChats}
        error={onlineError}
        currentPeer={picker?.currentPeer}
        onClose={() => setPicker(null)}
        onSelect={(chat) => {
          const row = rowsRef.current.find((item) => item.chat.slug === picker?.slug);
          if (row) void rematch(row, chat);
        }}
      />
    </>,
    document.body,
  );
}
