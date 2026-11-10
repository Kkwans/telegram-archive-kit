import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

export interface SelectOption {
  value: string;
  label: string;
}

export function Select({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLUListElement>(null);
  const menuId = useId();
  const current = options.find((o) => o.value === value) ?? options[0];
  const selectedIndex = Math.max(0, options.findIndex((o) => o.value === value));
  const expanded = open && !disabled;

  useEffect(() => {
    if (!expanded) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (root.current?.contains(target) || menu.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [expanded]);

  useLayoutEffect(() => {
    if (!expanded || !trigger.current) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const gap = 5;
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const estimated = Math.min(220, options.length * 36 + 10);
      const upward = below < Math.min(estimated, 180) && above > below;
      setPosition({
        left: rect.left,
        top: upward ? Math.max(8, rect.top - Math.min(estimated, above) - gap) : rect.bottom + gap,
        width: rect.width,
        maxHeight: Math.max(120, upward ? above : below),
      });
    };
    place();
    const onClose = (event: Event) => {
      if (event.target !== menu.current) setOpen(false);
    };
    window.addEventListener("resize", place);
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [expanded, options.length]);

  useLayoutEffect(() => {
    if (!expanded || !position || !menu.current) return;
    const list = menu.current;
    const option = list.children[active] as HTMLElement | undefined;
    if (!option) return;
    if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight;
    }
  }, [active, expanded, position]);

  const choose = (index: number) => {
    const opt = options[index];
    if (opt) onChange(opt.value);
    setOpen(false);
  };

  return (
    <div className="ui-select" ref={root}>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        className={`ui-select-btn ${expanded ? "open" : ""}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={expanded}
        aria-controls={expanded && position ? menuId : undefined}
        aria-activedescendant={expanded && position && options[active] ? `${menuId}-${active}` : undefined}
        aria-label={ariaLabel}
        onBlur={() => setOpen(false)}
        onClick={() => {
          setActive(selectedIndex);
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (!expanded) setActive(selectedIndex);
            else setActive((i) => Math.max(0, Math.min(options.length - 1, i + (e.key === "ArrowDown" ? 1 : -1))));
            setOpen(true);
          } else if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (expanded) choose(active);
            else {
              setActive(selectedIndex);
              setOpen(true);
            }
          } else if (expanded && (e.key === "Home" || e.key === "End")) {
            e.preventDefault();
            setActive(e.key === "Home" ? 0 : Math.max(0, options.length - 1));
          } else if (expanded && e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          }
        }}
      >
        <span>{current?.label ?? "请选择"}</span>
        <ChevronDown size={14} />
      </button>
      {expanded && position && createPortal(
        <ul
          ref={menu}
          id={menuId}
          className="ui-select-menu portal"
          role="listbox"
          aria-label={ariaLabel}
          style={{ left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight }}
        >
          {options.map((o, i) => (
            <li
              key={o.value}
              id={`${menuId}-${i}`}
              role="option"
              aria-selected={o.value === value}
              className={i === active ? "on" : ""}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(i);
              }}
            >
              <span>{o.label}</span>
              {o.value === value && <Check size={13} />}
            </li>
          ))}
        </ul>,
        document.body
      )}
    </div>
  );
}
