"use client";

import { useEffect, useRef, type ReactNode } from "react";
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
  children: ReactNode;
}) {
  const { isDesktop, isLargeDesktop } = useBreakpoint();
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

  if (isDesktop || isLargeDesktop) {
    return (
      <AnimatePresence initial={false}>
        {open && (
          <motion.aside
            key="side-panel"
            aria-label={label}
            initial={{ width: 0, opacity: 0 }}
            animate={{ width, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="h-full shrink-0 overflow-hidden"
          >
            <InlineFocus key={focusKey ?? ""} onClose={onClose} opener={opener}>
              <div className="flex h-full min-h-0 flex-col overflow-hidden" style={{ width }}>
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
