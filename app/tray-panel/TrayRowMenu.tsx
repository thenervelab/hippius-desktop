"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Download,
  Eye,
  FolderOpen,
  HardDrive,
  Link2,
  Pencil,
  PenLine,
  Share2,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import type {
  TrayRowAction,
  TrayRowActionId,
} from "@/app/lib/tray/trayRowActions";

export const TRAY_ACTION_ICONS: Record<TrayRowActionId, LucideIcon> = {
  preview: Eye,
  edit: PenLine,
  download: Download,
  "copy-link": Link2,
  share: Share2,
  "show-in-drive": HardDrive,
  reveal: FolderOpen,
  rename: Pencil,
  delete: Trash2,
};

/** Where to open: a point (right click) or under a trigger's box. */
export type TrayMenuAnchor = { x: number; y: number };

/** Gap kept between the menu and the window edge. */
const EDGE = 8;

/**
 * The row menu. A small hand-rolled menu rather than a Radix dropdown: the
 * popover is a provider-free webview that keeps its bundle small, and this is
 * the only menu it needs.
 *
 * Opens at `anchor`, then moves itself fully on screen once it knows its own
 * size (the popover is narrow and short; a menu from the last row opens
 * upward). Keyboard: focus starts on the first item, arrows/Home/End move,
 * Enter/Space run, Escape and Tab close. A click outside, or the popover
 * losing focus, closes it.
 */
export default function TrayRowMenu({
  actions,
  anchor,
  label,
  onSelect,
  onClose,
}: {
  actions: TrayRowAction[];
  anchor: TrayMenuAnchor;
  /** Accessible name, e.g. "Actions for report.pdf". */
  label: string;
  onSelect: (id: TrayRowActionId) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(anchor);

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const maxX = Math.max(EDGE, window.innerWidth - width - EDGE);
    const maxY = Math.max(EDGE, window.innerHeight - height - EDGE);
    // Not enough room below: open upward from the anchor instead.
    const y = anchor.y > maxY ? Math.max(EDGE, anchor.y - height) : anchor.y;
    setPosition({ x: Math.min(Math.max(EDGE, anchor.x), maxX), y: Math.min(y, maxY) });
  }, [anchor]);

  useEffect(() => {
    menuRef.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
      ?.focus();
  }, []);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const onBlur = () => onClose();
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("blur", onBlur);
    };
  }, [onClose]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]',
      ) ?? [],
    );
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const focusAt = (i: number) =>
      items[(i + items.length) % items.length]?.focus();
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusAt(index + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusAt(index - 1);
        break;
      case "Home":
        event.preventDefault();
        focusAt(0);
        break;
      case "End":
        event.preventDefault();
        focusAt(items.length - 1);
        break;
      case "Escape":
      case "Tab":
        event.preventDefault();
        event.stopPropagation();
        onClose();
        break;
    }
  };

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
      style={{ left: position.x, top: position.y }}
      className="fixed z-50 min-w-[200px] rounded-xl border border-[rgba(0,0,0,0.08)] bg-white p-1 shadow-[0_8px_24px_rgba(0,0,0,0.16)] dark:border-white/10 dark:bg-[#2a2a2a]"
    >
      {actions.map((action) => {
        const Icon = TRAY_ACTION_ICONS[action.id];
        const tone = action.destructive
          ? "text-[#E5484D] dark:text-[#FF6D61]"
          : "text-grey-10 dark:text-white";
        return (
          <button
            key={action.id}
            type="button"
            role="menuitem"
            aria-disabled={action.disabled || undefined}
            title={action.tooltip}
            onClick={() => {
              if (action.disabled) return;
              onSelect(action.id);
            }}
            className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left font-geist text-[13px] font-medium leading-5 outline-none transition-colors hover:bg-[rgba(0,0,0,0.05)] focus-visible:bg-[rgba(0,0,0,0.06)] dark:hover:bg-white/10 dark:focus-visible:bg-white/10 aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-transparent ${tone}`}
          >
            <Icon className="size-4 shrink-0 opacity-70" aria-hidden />
            {action.label}
          </button>
        );
      })}
    </div>
  );
}
