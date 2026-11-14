import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const tipSelector = "[data-tip]:not([data-tip=''])";
const tooltipId = "tak-app-tooltip";

function triggerAt(target: EventTarget | null) {
  return target instanceof Element ? target.closest<HTMLElement>(tipSelector) : null;
}

export function AppTooltip() {
  const [trigger, setTrigger] = useState<HTMLElement | null>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const point = useRef<{ x: number; y: number } | null>(null);
  const position = useRef<(() => void) | null>(null);

  useEffect(() => {
    let hovered: HTMLElement | null = null;
    let focused: HTMLElement | null = null;
    const show = () => {
      if (!hovered) point.current = null;
      setTrigger(hovered ?? focused);
      position.current?.();
    };
    const hide = () => { hovered = focused = null; setTrigger(null); };
    const over = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const next = triggerAt(event.target);
      point.current = next ? { x: event.clientX, y: event.clientY } : null;
      if (next !== hovered) { hovered = next; show(); }
    };
    const move = (event: PointerEvent) => {
      if (!hovered || event.pointerType === "touch") return;
      point.current = { x: event.clientX, y: event.clientY };
      position.current?.();
    };
    const out = (event: PointerEvent) => {
      if (!hovered || hovered.contains(event.relatedTarget as Node | null)) return;
      hovered = triggerAt(event.relatedTarget);
      if (hovered) point.current = { x: event.clientX, y: event.clientY };
      show();
    };
    const focus = (event: FocusEvent) => {
      focused = event.target instanceof HTMLElement && event.target.matches(":focus-visible") ? triggerAt(event.target) : null;
      show();
    };
    const blur = () => { focused = null; show(); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") hide(); };
    document.addEventListener("pointerover", over);
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerout", out);
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", blur);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    window.addEventListener("blur", hide);
    window.addEventListener("pointerdown", hide, true);
    window.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerout", out);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", blur);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("blur", hide);
      window.removeEventListener("pointerdown", hide, true);
      window.removeEventListener("keydown", escape, true);
    };
  }, []);

  const [revision, refresh] = useState(0);
  useLayoutEffect(() => {
    if (!trigger || !bubble.current) return;
    const tip = bubble.current;
    tip.showPopover?.();
    const { width, height } = tip.getBoundingClientRect();
    const edge = 8;
    const clamp = (value: number, size: number, limit: number) => Math.max(edge, Math.min(value, limit - edge - size));
    position.current = () => {
      const cursor = point.current;
      const anchor = trigger.getBoundingClientRect();
      let x = anchor.left + (anchor.width - width) / 2;
      if (cursor) {
        x = cursor.x + 14;
        if (x + width > window.innerWidth - edge) x = cursor.x - 14 - width;
      }
      const bottom = cursor ? cursor.y + 18 : anchor.bottom + 8;
      const top = (cursor ? cursor.y - 12 : anchor.top - 8) - height;
      const y = bottom + height <= window.innerHeight - edge || top < edge ? bottom : top;
      tip.style.left = `${clamp(x, width, window.innerWidth)}px`;
      tip.style.top = `${clamp(y, height, window.innerHeight)}px`;
    };
    position.current();
    tip.style.visibility = "visible";

    const originalDescription = trigger.getAttribute("aria-describedby");
    trigger.setAttribute("aria-describedby", [originalDescription, tooltipId].filter(Boolean).join(" "));
    const observer = new MutationObserver((records) => {
      if (!trigger.isConnected || !trigger.matches(tipSelector)) setTrigger(null);
      else if (records.some((record) => record.target === trigger && record.type === "attributes")) refresh((value) => value + 1);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    observer.observe(trigger, { attributes: true, attributeFilter: ["data-tip", "data-tip-heading"] });
    return () => {
      observer.disconnect();
      position.current = null;
      tip.hidePopover?.();
      if (originalDescription) trigger.setAttribute("aria-describedby", originalDescription);
      else trigger.removeAttribute("aria-describedby");
    };
  }, [trigger, revision]);

  if (!trigger) return null;
  const usePopover = typeof HTMLElement.prototype.showPopover === "function";
  const root = document.fullscreenElement ?? trigger.closest("dialog[open]") ?? document.body;
  return createPortal(
    <div ref={bubble} id={tooltipId} className="app-tip" role="tooltip" popover={usePopover ? "manual" : undefined}>
      {trigger.dataset.tipHeading && <strong>{trigger.dataset.tipHeading}</strong>}
      {trigger.dataset.tip}
    </div>, root,
  );
}
