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

  useEffect(() => {
    let hovered: HTMLElement | null = null;
    let focused: HTMLElement | null = null;
    const show = () => setTrigger(hovered ?? focused);
    const hide = () => { hovered = focused = null; setTrigger(null); };
    const over = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const next = triggerAt(event.target);
      if (next !== hovered) { hovered = next; show(); }
    };
    const out = (event: PointerEvent) => {
      if (!hovered || hovered.contains(event.relatedTarget as Node | null)) return;
      hovered = triggerAt(event.relatedTarget);
      show();
    };
    const focus = (event: FocusEvent) => {
      focused = event.target instanceof HTMLElement && event.target.matches(":focus-visible") ? triggerAt(event.target) : null;
      show();
    };
    const blur = () => { focused = null; show(); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") hide(); };
    document.addEventListener("pointerover", over);
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
    const anchor = trigger.getBoundingClientRect();
    const { width, height } = tip.getBoundingClientRect();
    const edge = 8;
    const gap = 8;
    const clamp = (value: number, size: number, limit: number) => Math.max(edge, Math.min(value, limit - edge - size));
    const beside = trigger.dataset.tipSide === "right" && anchor.right + gap + width <= window.innerWidth - edge;
    const preferredY = anchor.bottom + gap + height <= window.innerHeight - edge || anchor.top - gap - height < edge
      ? anchor.bottom + gap : anchor.top - gap - height;
    const x = clamp(beside ? anchor.right + gap : anchor.left + (anchor.width - width) / 2, width, window.innerWidth);
    const y = clamp(beside ? anchor.top + (anchor.height - height) / 2 : preferredY, height, window.innerHeight);
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
    tip.style.visibility = "visible";

    const originalDescription = trigger.getAttribute("aria-describedby");
    trigger.setAttribute("aria-describedby", [originalDescription, tooltipId].filter(Boolean).join(" "));
    const observer = new MutationObserver((records) => {
      if (!trigger.isConnected || !trigger.matches(tipSelector)) setTrigger(null);
      else if (records.some((record) => record.target === trigger && record.type === "attributes")) refresh((value) => value + 1);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    observer.observe(trigger, { attributes: true, attributeFilter: ["data-tip", "data-tip-heading", "data-tip-side"] });
    return () => {
      observer.disconnect();
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
