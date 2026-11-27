"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import * as Dialog from "@radix-ui/react-dialog";

import { useBreakpoint } from "@/app/lib/hooks";
import { cn } from "@/app/lib/utils";

/**
 * The right-hand side panel File Details, Insights and Manage access share.
 *
 * From `xl` up it is an inline column beside the page (a sibling of `<main>`
 * in `ResponsiveContent`): it slides its width open, pushes the page over
 * rather than covering it, and stays the window's height while the page
 * scrolls. Below `xl` there is no room for both, so it is a slide-in sheet
 * over a frosted overlay (a Radix dialog: Escape, focus trap, focus back).
 *
 * The inline shape is not modal, so it does the keyboard part itself: focus
 * moves into the panel when it opens, Escape closes it while focus is in it
 * (or nowhere), and closing puts focus back on what opened it.
 *
 * Only one panel is open at a time: their atoms share one slot
 * (`global-atoms/sidePanelAtoms`).
 */
export function SidePanel({
  open,
  onClose,
  width,
  label,
  focusKey,
  sheetClassName,
  resizable,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** Pixel width of the column (and the sheet's maximum width). */
  width: number;
  /** Names the panel for assistive tech. */
  label: string;
  /**
   * What the panel is showing (a link, a file). When it changes while open,
   * focus moves into the new content and its opener is remembered instead.
   */
  focusKey?: string;
  /** Extra classes for the narrow-window sheet only. */
  sheetClassName?: string;
  /**
   * Let the inline column be widened by dragging its left edge (or with the
   * arrow keys on the edge). `width` is then the narrowest it goes, and the
   * width chosen is kept under `storageKey`. The narrow-window sheet is not
   * resizable.
   */
  resizable?: { storageKey: string };
  children: ReactNode;
}) {
  const { isDesktop, isLargeDesktop } = useBreakpoint();
  const inline = isDesktop || isLargeDesktop;
  const sized = usePanelWidth(width, inline ? resizable : undefined);
  // What opened the panel, so closing can put focus back on it.
  const opener = useRef<HTMLElement | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const openedFor = useRef<string | null>(null);
  // Read during render on purpose: by the time an effect runs, the opener
  // (often a menu item) may already be gone.
  const key = open ? (focusKey ?? "") : null;
  if (key !== openedFor.current) {
    openedFor.current = key;
    opener.current = key !== null && typeof document !== "undefined" ? resolveOpener(document.activeElement) : null;
  }

  if (inline) {
    return (
      <AnimatePresence initial={false}>
        {open && (
          <motion.aside
            key="side-panel"
            aria-label={label}
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: sized.width, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            // Follows the pointer while it is dragged, with no easing behind it.
            // `-ml-1` takes back `<main>`'s 4px right margin, so the panel's
            // left edge, and the resize line drawn on it, sit exactly on the
            // edge of the content column rather than 4px past it.
            transition={sized.dragging ? { duration: 0 } : { duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="relative -ml-1 h-full shrink-0 overflow-hidden"
          >
            {resizable && <ResizeHandle sized={sized} label={label} />}
            <InlineFocus key={focusKey ?? ""} onClose={onClose} opener={opener}>
              <div className="flex h-full min-h-0 flex-col overflow-hidden" style={{ width: sized.width }}>
                {children}
              </div>
            </InlineFocus>
          </motion.aside>
        )}
      </AnimatePresence>
    );
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[1002] bg-white/72 backdrop-blur-[5.75px] dark:bg-[rgba(4,4,4,0.4)] dark:backdrop-blur-[11.5px] animate-fade-in-0.2" />
        <Dialog.Content
          ref={sheetRef}
          aria-describedby={undefined}
          style={{ maxWidth: width }}
          onOpenAutoFocus={(e) => {
            // The panel's own start (its heading) over the first button, as inline.
            const start = sheetRef.current?.querySelector<HTMLElement>("[data-panel-autofocus]");
            if (start) {
              e.preventDefault();
              start.focus();
            }
          }}
          onCloseAutoFocus={(e) => {
            const back = opener.current;
            if (back?.isConnected) {
              e.preventDefault();
              back.focus();
            }
          }}
          className={cn(
            "fixed bottom-0 right-0 top-0 z-[1003] flex w-full flex-col overflow-hidden font-geist animate-panel-in",
            sheetClassName,
            "bg-cover bg-fixed bg-center bg-no-repeat bg-[url('/logged-in-app-background.png')] dark:bg-[url('/logged-in-app-background-dark.png')]",
          )}
        >
          {/* Names the sheet only: the panel draws its own heading. */}
          <Dialog.Title asChild>
            <span className="sr-only">{label}</span>
          </Dialog.Title>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The widest a resizable panel goes, as a share of the window. */
export const MAX_PANEL_FRACTION = 0.65;
/** One arrow key press on the edge; with Shift, four of them. */
export const RESIZE_STEP_PX = 16;

function readStoredWidth(key: string): number | null {
  try {
    const raw = window.localStorage.getItem(key);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function storeWidth(key: string, width: number | null) {
  try {
    if (width === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, String(Math.round(width)));
  } catch {
    // Not kept: the panel opens at its narrowest next time.
  }
}

/** The widest the panel may be in a window this wide: never under `min`. */
export function maxPanelWidth(min: number, windowWidth: number): number {
  return Math.max(min, Math.floor(windowWidth * MAX_PANEL_FRACTION));
}

export function clampPanelWidth(want: number, min: number, windowWidth: number): number {
  return Math.round(Math.min(maxPanelWidth(min, windowWidth), Math.max(min, want)));
}

/**
 * The panel's width: `min` unless it is resizable, then the width the user
 * chose (kept in localStorage), held between `min` and a share of the window
 * as the window changes.
 */
function usePanelWidth(min: number, resizable: { storageKey: string } | undefined) {
  const key = resizable?.storageKey ?? null;
  const [chosen, setChosen] = useState<number | null>(() =>
    key !== null && typeof window !== "undefined" ? readStoredWidth(key) : null,
  );
  const [windowWidth, setWindowWidth] = useState(() => (typeof window !== "undefined" ? window.innerWidth : 0));
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (key === null) return;
    const onResize = () => setWindowWidth(window.innerWidth);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [key]);
  const max = maxPanelWidth(min, windowWidth);
  const width = key === null || chosen === null ? min : clampPanelWidth(chosen, min, windowWidth);
  const set = useCallback(
    (next: number, keep: boolean) => {
      if (key === null) return;
      const w = clampPanelWidth(next, min, window.innerWidth);
      setChosen(w);
      if (keep) storeWidth(key, w === min ? null : w);
    },
    [key, min],
  );
  const reset = useCallback(() => {
    if (key === null) return;
    setChosen(null);
    storeWidth(key, null);
  }, [key]);
  return { width, min, max, dragging, setDragging, set, reset };
}

type PanelWidth = ReturnType<typeof usePanelWidth>;

/**
 * The panel's left edge, which widens it to the left: a line shows on hover
 * and focus, the pointer drags it, the arrow keys move it, Home and End go to
 * the narrowest and widest, and a double click puts it back.
 */
function ResizeHandle({ sized, label }: { sized: PanelWidth; label: string }) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    start.current = { x: e.clientX, width: sized.width };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    sized.setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const from = start.current;
    if (!from) return;
    sized.set(from.width + (from.x - e.clientX), false);
  };
  const end = (e: PointerEvent<HTMLDivElement>) => {
    const from = start.current;
    if (!from) return;
    start.current = null;
    sized.setDragging(false);
    sized.set(from.width + (from.x - e.clientX), true);
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? RESIZE_STEP_PX * 4 : RESIZE_STEP_PX;
    let next: number | null = null;
    // The panel sits on the right: Left widens it, Right narrows it.
    if (e.key === "ArrowLeft") next = sized.width + step;
    else if (e.key === "ArrowRight") next = sized.width - step;
    else if (e.key === "Home") next = sized.min;
    else if (e.key === "End") next = sized.max;
    if (next === null) return;
    e.preventDefault();
    sized.set(next, true);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label}`}
      aria-valuemin={sized.min}
      aria-valuemax={sized.max}
      aria-valuenow={sized.width}
      tabIndex={0}
      title="Drag to resize. Double click to reset."
      data-testid="side-panel-resize"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={sized.reset}
      onKeyDown={onKeyDown}
      className="group absolute inset-y-0 left-0 z-40 w-2 cursor-col-resize touch-none outline-none"
    >
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0 left-0 w-[2px] bg-primary-50/70 opacity-0 transition-opacity dark:bg-primary-brand-dark/70",
          "group-hover:opacity-100 group-focus-visible:opacity-100",
          sized.dragging && "opacity-100",
        )}
      />
      <span
        aria-hidden
        className={cn(
          "absolute left-[3px] top-1/2 h-8 w-1 -translate-y-1/2 rounded-full bg-grey-60 opacity-0 transition-opacity dark:bg-grey-dark-600",
          "group-hover:opacity-100 group-focus-visible:opacity-100",
          sized.dragging && "opacity-100",
        )}
      />
    </div>
  );
}

/**
 * The element to give focus back to. A menu item is gone once its menu
 * closes, so an item's menu trigger stands in for it (Radix labels a menu
 * by its trigger).
 */
export function resolveOpener(active: Element | null): HTMLElement | null {
  if (!(active instanceof HTMLElement) || active === document.body) return null;
  const menu = active.closest('[role="menu"]');
  if (menu) {
    const trigger = menu.getAttribute("aria-labelledby");
    const el = trigger ? document.getElementById(trigger) : null;
    return el instanceof HTMLElement ? el : null;
  }
  return active;
}

/** How long a menu that opened the panel may still hand focus to its trigger. */
const SETTLE_MS = 400;

function InlineFocus({
  onClose,
  opener,
  children,
}: {
  onClose: () => void;
  opener: React.MutableRefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const panel = ref.current;
    if (!panel) return;
    const back = opener.current;
    const focusIn = () => {
      const target = panel.querySelector<HTMLElement>("[data-panel-autofocus]") ?? panel;
      target.focus({ preventScroll: true });
    };
    focusIn();

    // A row menu that opened the panel hands focus back to its trigger as it
    // finishes closing. Until the user does something, take it back.
    let settled = false;
    const settle = () => {
      settled = true;
    };
    const onFocusIn = (e: FocusEvent) => {
      if (!settled && e.target instanceof Node && !panel.contains(e.target)) focusIn();
    };
    const timer = window.setTimeout(settle, SETTLE_MS);
    document.addEventListener("pointerdown", settle, true);
    document.addEventListener("keydown", settle, true);
    document.addEventListener("focusin", onFocusIn);

    // Escape closes while focus is in the panel, or nowhere. A menu, select
    // or question inside it handles Escape first and marks it handled.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const focused = document.activeElement;
      if (focused && focused !== document.body && !panel.contains(focused)) return;
      e.preventDefault();
      close.current();
    };
    window.addEventListener("keydown", onKey);

    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", settle, true);
      document.removeEventListener("keydown", settle, true);
      document.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("keydown", onKey);
      // Back to the opener, unless the user already put focus somewhere else.
      const focused = document.activeElement;
      const lost = !focused || focused === document.body || panel.contains(focused);
      if (lost && back?.isConnected) back.focus({ preventScroll: true });
    };
  }, [opener]);

  return (
    <div ref={ref} tabIndex={-1} className="h-full outline-none">
      {children}
    </div>
  );
}
