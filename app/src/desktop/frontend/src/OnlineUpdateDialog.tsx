import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  CloudDownload,
  FileText,
  HardDrive,
  Image as ImageIcon,
  Loader2,
  Music2,
  RefreshCw,
  Video,
} from "lucide-react";
import { call } from "./rpc";
import { bytes } from "./format";
import { ConfirmDialog } from "./ConfirmDialog";
import type { OnlineExportPreview, OnlineExportProgress, OnlineExportResult } from "./types";

export interface OnlineUpdateTarget {
  peer: string;
  name: string;
  type?: string;
  id?: number | string;
  avatar?: string;
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
  const [closeConfirm, setCloseConfirm] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [floodUntil, setFloodUntil] = useState(0);
  const [clock, setClock] = useState(Date.now());
  const seq = useRef(0);
  const token = useRef("");
  const loadingRef = useRef(false);

  useEffect(() => {
    loadingRef.current = previewLoading;
  }, [previewLoading]);

  useEffect(() => {
    if (!floodUntil) return;
    const tick = () => {
      const now = Date.now();
      setClock(now);
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
    if (loadingRef.current) void call("onlineExportPreviewCancel").catch(() => undefined);
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
    setPreviewProgress({ active: true, stage: "准备统计", detail: "正在连接 Telegram", percent: 1, messages: 0, media: 0 });
    setPreviewLoading(true);
    loadingRef.current = true;
    try {
      const res = await call<OnlineExportPreview>("onlineExportPreview", { peer: target.peer, timeout: 300 });
      if (id !== seq.current) {
        if (res.token) void call("onlineExportDiscard", { token: res.token }).catch(() => undefined);
        return;
      }
      if (res.upToDate) {
        close();
        toast("已是最新，没有需要归档的新消息");
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
      if (loadingRef.current) void call("onlineExportPreviewCancel").catch(() => undefined);
      discardPrepared();
    };
    // Start exactly once for the selected target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.peer]);

  useEffect(() => {
    if (!previewLoading) {
      setPreviewProgress(null);
      return;
    }
    let alive = true;
    const poll = () => {
      call<OnlineExportProgress>("onlineExportPreviewProgress")
        .then((progress) => { if (alive) setPreviewProgress(progress); })
        .catch(() => undefined);
    };
    poll();
    const timer = window.setInterval(poll, 400);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [previewLoading]);

  const runExport = async () => {
    if (!preview || exporting) return;
    setExporting(true);
    setPreviewError("");
    try {
      const res = await call<OnlineExportResult>("onlineExport", { peer: preview.peer, timeout: 300, token: preview.token || "" });
      if (res.upToDate) {
        close();
        toast("已是最新，没有需要归档的新消息");
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

  return (
    <>
      {createPortal(
        <div className="modal-backdrop" role="presentation">
          <div className="modal export-preview-modal" role="dialog" aria-modal="true" aria-labelledby="online-update-title">
            <div className="export-preview-head">
              {target.avatar ? (
                <img className="online-avatar" src={target.avatar} alt="" />
              ) : (
                <span className="online-avatar" style={avatarStyle(target.peer)}>{initials(target.name)}</span>
              )}
              <div className="export-preview-head-text">
                <span className="export-preview-kicker">在线更新预览</span>
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
            ) : preview ? (
              <>
                <div className="export-preview-lead">
                  <div>
                    <span>本次新增</span>
                    <b>{preview.messages.toLocaleString()} <em>条消息</em></b>
                  </div>
                  <div>
                    <span>预计大小</span>
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

                {preview.existed && (
                  <div className="export-preview-existing">
                    <RefreshCw size={13} />
                    <span>
                      本地已有 {(preview.localMessages ?? 0).toLocaleString()} 条消息 · {(preview.localMedia ?? 0).toLocaleString()} 个媒体，本次只合并新消息。
                    </span>
                  </div>
                )}

                {preview.other > 0 && (
                  <p className="export-preview-note">另有 {preview.other.toLocaleString()} 个其他媒体（位置、投票、联系人等）。</p>
                )}
                <p className="export-preview-note">
                  <HardDrive size={12} /> 大小按 Telegram 返回的文件尺寸估算，仅统计本次新增消息；实际下载可能因缩略图与格式略有差异。
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

            <div className="modal-actions">
              <button className="btn ghost" disabled={exporting} onClick={requestClose}>
                {preview ? "取消" : "关闭"}
              </button>
              {preview ? (
                <button className="btn primary" disabled={exporting || floodLeft > 0} onClick={() => void runExport()}>
                  {exporting ? <Loader2 size={13} className="spin" /> : <CloudDownload size={13} />}
                  {exporting ? "正在归档…" : floodLeft > 0 ? `等待 ${floodLeft} 秒` : "开始归档"}
                </button>
              ) : !previewLoading ? (
                <button className="btn primary" disabled={floodLeft > 0} onClick={() => void beginPreview()}>
                  {floodLeft > 0 ? <Loader2 size={13} /> : <RefreshCw size={13} />}
                  {floodLeft > 0 ? `等待 ${floodLeft} 秒` : "重新统计"}
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
