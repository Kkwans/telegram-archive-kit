import { useId, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle } from "lucide-react";
import "./ConfirmDialog.css";

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "确定",
  cancelLabel = "取消",
  danger = false,
  compact = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  compact?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  if (compact) {
    return <CompactConfirmation {...{ title, message, confirmLabel, cancelLabel, danger, onConfirm, onCancel }} />;
  }
  return createPortal(
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        className="modal confirm-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-message"
      >
        <div className="confirm-head">
          <span className={`confirm-icon ${danger ? "danger" : ""}`}>
            <AlertTriangle size={18} />
          </span>
          <div>
            <h2 id="confirm-title">{title}</h2>
            <p id="confirm-message" className="confirm-message">{message}</p>
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={onCancel}>{cancelLabel}</button>
          <button className={`btn ${danger ? "danger" : "primary"}`} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>,
    document.body
  );
}

function CompactConfirmation({ title, message, confirmLabel, cancelLabel, danger, onConfirm, onCancel }: {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  danger: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const messageId = useId();

  useLayoutEffect(() => {
    const current = dialog.current;
    const opener = document.activeElement;
    current?.showModal();
    cancel.current?.focus({ preventScroll: true });
    return () => {
      current?.close();
      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus({ preventScroll: true });
      }
    };
  }, []);

  return createPortal(
    <dialog
      ref={dialog}
      className="confirm-modal confirm-compact"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={messageId}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const edge = event.shiftKey ? cancel.current : confirm.current;
        if (document.activeElement === edge) {
          event.preventDefault();
          (event.shiftKey ? confirm.current : cancel.current)?.focus();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right ||
            event.clientY < rect.top || event.clientY > rect.bottom) {
          onCancel();
        }
      }}
    >
      <div className="confirm-compact-copy">
        <AlertTriangle className={danger ? "is-danger" : ""} size={18} aria-hidden="true" />
        <h2 id={titleId}>{title}</h2>
        <p id={messageId}>{message}</p>
      </div>
      <footer className="confirm-compact-actions">
        <button type="button" className="btn ghost" ref={cancel} onClick={onCancel}>{cancelLabel}</button>
        <button type="button" className={`btn ${danger ? "danger" : "primary"}`} ref={confirm} onClick={onConfirm}>{confirmLabel}</button>
      </footer>
    </dialog>,
    document.body,
  );
}
