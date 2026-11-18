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
  Video,
  X,
} from "lucide-react";
import { call } from "./rpc";
import { bytes } from "./format";
import { ConfirmDialog } from "./ConfirmDialog";
import type { BackfillPreview, BulkPreview, ChatRow, OnlineChat, OnlineChats, OnlineExportPreview, OnlineExportProgress, OnlineExportResult, TaskDetail } from "./types";

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
  const seq = useRef(0);
  const token = useRef("");
  const loadingRef = useRef(false);
  const isOnlinePreview = target.mode !== "bulk" && target.mode !== "backfill" && target.mode !== "sync";

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
      const res = await call<OnlineExportPreview>("onlineExportPreview", { peer: target.peer, timeout: 300, slug: target.slug || "" });
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
    // Start exactly once for the selected target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.peer, target.mode, target.slug]);

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
  }, [previewLoading, isOnlinePreview, target.peer, target.slug]);

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
              ) : target.avatar ? (
                <img className="online-avatar" src={target.avatar} alt="" />
              ) : (
                <span className="online-avatar" style={avatarStyle(target.peer)}>{initials(target.name)}</span>
              )}
              <div className="export-preview-head-text">
                <span className="export-preview-kicker">{isBulk ? "批量下载预览" : target.mode === "sync" ? "下载前统计" : isBackfill ? "本地补全预览" : "在线更新预览"}</span>
                <h2 id="online-update-title">{target.name}</h2>
                <p className="modal-sub">
                  {TYPE_LABEL[target.type || ""] || target.type || "会话"}
                  {target.id != null ? ` · ID ${target.id}` : ""}
                </p>
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
    </>
  );
}
type AllUpdateStatus = "pending" | "checking" | "ready" | "up-to-date" | "missing" | "updating" | "done" | "failed";

interface AllUpdateRow {
  chat: ChatRow;
  peer?: string;
  status: AllUpdateStatus;
  preview?: OnlineExportPreview;
  error?: string;
}

const allUpdateStatusLabel: Record<AllUpdateStatus, string> = {
  pending: "等待统计", checking: "统计中", ready: "待更新", "up-to-date": "已是最新",
  missing: "未找到在线会话", updating: "更新中", done: "完成", failed: "失败",
};

function allUpdateFindPeer(online: OnlineChat[], chat: ChatRow): OnlineChat | undefined {
  const slug = online.find((item) => item.localSlug === chat.slug);
  if (slug) return slug;
  const name = chat.name.trim().toLocaleLowerCase();
  const exact = online.filter((item) => item.name.trim().toLocaleLowerCase() === name);
  return exact.length === 1 ? exact[0] : undefined;
}

export function AllOnlineUpdateDialog({ chats, onClose, toast }: {
  chats: ChatRow[];
  onClose: () => void;
  toast: (message: string, error?: boolean) => void;
}) {
  const [rows, setRows] = useState<AllUpdateRow[]>(() => chats.map((chat) => ({ chat, status: "pending" })));
  const [scanIndex, setScanIndex] = useState(0);
  const [scanning, setScanning] = useState(true);
  const [running, setRunning] = useState(false);
  const alive = useRef(true);

  useEffect(() => () => { alive.current = false; }, []);
  const updateRow = (slug: string, patch: Partial<AllUpdateRow>) => setRows((current) => current.map((row) => row.chat.slug === slug ? { ...row, ...patch } : row));
  const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

  useEffect(() => {
    const prepare = async () => {
      try {
        const online = await call<OnlineChats>("onlineChats", { timeout: 60 });
        for (let index = 0; index < rows.length; index++) {
          if (!alive.current) return;
          const row = rows[index];
          const peer = allUpdateFindPeer(online.chats, row.chat);
          if (!peer) {
            updateRow(row.chat.slug, { status: "missing" });
            setScanIndex(index + 1);
            continue;
          }
          updateRow(row.chat.slug, { peer: peer.peer, status: "checking" });
          try {
            const preview = await call<OnlineExportPreview>("onlineExportPreview", { peer: peer.peer, timeout: 300, slug: row.chat.slug });
            if (!alive.current) return;
            updateRow(row.chat.slug, { preview, status: preview.upToDate ? "up-to-date" : "ready" });
          } catch (error) {
            if (!alive.current) return;
            updateRow(row.chat.slug, { status: "failed", error: (error as Error).message });
          }
          setScanIndex(index + 1);
        }
      } catch (error) {
        if (alive.current) {
          toast(`读取在线聊天失败：${(error as Error).message}`, true);
          setRows((current) => current.map((row) => ({ ...row, status: "failed", error: (error as Error).message })));
        }
      } finally {
        if (alive.current) setScanning(false);
      }
    };
    void prepare();
    // Run once when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = async () => {
    if (scanning || running) return;
    setRunning(true);
    let done = 0;
    let failed = 0;
    for (const row of rows) {
      if (!alive.current) break;
      const preview = row.preview;
      if (!preview || row.status === "missing" || preview.upToDate) continue;
      if (preview.spaceShort) {
        updateRow(row.chat.slug, { status: "failed", error: "档案库空间不足" });
        failed++;
        continue;
      }
      if ((preview.messages ?? 0) === 0 && (preview.media ?? 0) === 0) {
        updateRow(row.chat.slug, { status: "done" });
        done++;
        continue;
      }
      updateRow(row.chat.slug, { status: "updating", error: undefined });
      try {
        const result = await call<OnlineExportResult>("onlineExport", {
          peer: preview.peer, timeout: 300, token: preview.token || "", slug: row.chat.slug,
        });
        if (!alive.current) return;
        if (result.upToDate || !result.taskId) {
          updateRow(row.chat.slug, { status: "done" });
          done++;
          continue;
        }
        for (;;) {
          await wait(900);
          if (!alive.current) return;
          const detail = await call<TaskDetail>("taskDetail", { id: result.taskId });
          if (detail.state === "running") continue;
          if (detail.state === "done") {
            updateRow(row.chat.slug, { status: "done" });
            done++;
          } else {
            updateRow(row.chat.slug, { status: "failed", error: detail.error || "更新未完成" });
            failed++;
          }
          break;
        }
      } catch (error) {
        if (!alive.current) return;
        updateRow(row.chat.slug, { status: "failed", error: (error as Error).message });
        failed++;
      }
    }
    if (!alive.current) return;
    setRunning(false);
    toast(failed ? `全部更新结束：完成 ${done} 个，失败 ${failed} 个` : `已更新 ${done} 个聊天`, failed > 0);
  };

  const total = rows.length;
  const ready = rows.filter((row) => row.status === "ready").length;
  const finished = rows.filter((row) => row.status === "done" || row.status === "failed" || row.status === "up-to-date").length;
  const progress = scanning ? (total ? Math.round(scanIndex * 100 / total) : 0) : running ? Math.round(finished * 100 / Math.max(1, total)) : 100;

  return createPortal(
    <div className="modal-backdrop" role="presentation">
      <div className="modal export-preview-modal all-update-modal" role="dialog" aria-modal="true" aria-labelledby="all-update-title">
        <div className="export-preview-head">
          <span className="online-avatar" style={{ background: "linear-gradient(135deg, #5a7bff, #7c5cff)" }}><RefreshCw size={18} /></span>
          <div className="export-preview-head-text">
            <span className="export-preview-kicker">批量在线更新</span>
            <h2 id="all-update-title">更新全部聊天</h2>
            <p>逐个统计本地聊天在 Telegram 上的新增消息，然后依次更新到最新。</p>
          </div>
          <button className="icon-btn" aria-label="关闭全部更新" disabled={running} onClick={onClose}><X size={15} /></button>
        </div>
        <div className="all-update-progress" role="status">
          <div><i style={{ width: `${progress}%` }} /></div>
          <span>{scanning ? `统计中 ${scanIndex} / ${total}` : running ? `更新中 ${progress}%` : `统计完成 · ${ready} 个待更新`}</span>
        </div>
        <div className="all-update-list">
          {rows.map((row) => <div className="all-update-row" key={row.chat.slug}>
            <span className="online-avatar" style={{ background: "linear-gradient(135deg, hsl(220 54% 52%), hsl(258 58% 38%))" }}>{initials(row.chat.name)}</span>
            <span className="all-update-name"><b>{row.chat.name}</b><small>{row.error || allUpdateStatusLabel[row.status]}</small></span>
            {row.preview && <span className="all-update-stats">
              <b>{row.preview.upToDate ? "已是最新" : `${row.preview.messages.toLocaleString()} 条 · ${row.preview.media.toLocaleString()} 媒体`}</b>
              <small>{row.preview.bytes ? bytes(row.preview.bytes) : ""}</small>
            </span>}
            {row.status === "checking" || row.status === "updating" ? <Loader2 size={13} className="spin" /> : row.status === "done" || row.status === "up-to-date" ? <CheckCircle2 size={13} className="ok" /> : row.status === "failed" || row.status === "missing" ? <AlertCircle size={13} className="warn" /> : null}
          </div>)}
        </div>
        <div className="modal-actions">
          <button className="btn ghost" disabled={running} onClick={onClose}>取消</button>
          <button className="btn primary" disabled={scanning || running || ready === 0} onClick={() => void start()}>
            {scanning || running ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
            {scanning ? "正在统计…" : running ? "正在更新…" : `开始更新 ${ready} 个聊天`}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}