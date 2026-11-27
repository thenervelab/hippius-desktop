"use client";

// Link settings as a view of the Insights side panel, for file and folder
// links alike. The gear slides it in from the right over the panel's
// Insights, at the panel's own (dragged) width, under a header with a back
// arrow. Insights stays mounted underneath, hidden and inert, so Back finds
// it on the same tab and scrolled where it was. A long rule (Allow list,
// NDA) opens one level further in, under "‹ Link settings"; short rules
// keep their control in their row (`RuleCards`' `inline`).
//
// Which view is open is kept per link (`useLinkSettingsView`), so the panel
// opened again for the same link comes back to it. Escape goes back one
// level, never closing the panel. Leaving a rule whose editor holds
// changes that are not saved always asks first.

import { useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ArrowLeft, ChevronLeft } from "lucide-react";

import { cn } from "@/lib/utils";
import { RowConfirm } from "@/components/page-sections/drive/share-dialog/RowConfirm";
import { RuleStackContext, type RuleStack } from "@/components/page-sections/shares/rules/ruleStack";
import { RULE_LABELS } from "@/components/page-sections/shares/rules/ruleSummaries";
import type { LinkSettingsViewHandle } from "./linkSettingsViewState";
import { ICON_BUTTON, STRONG, TEXT_LINK } from "./panelStyles";

export const LINK_SETTINGS = "Link settings";
export const BACK_TO_INSIGHTS = "Back to Insights";
export const BACK_TO_LINK_SETTINGS = "Back to Link settings";
/** Asked when leaving a rule's editor with changes that are not saved. */
export const DISCARD_QUESTION = "Discard your changes?";
export const DISCARD_DETAIL = "They haven't been saved.";
export const DISCARD = "Discard";

/** Marks the gear that opens Link settings: focus goes back to it. */
export const SETTINGS_TRIGGER_ATTR = "data-link-settings-trigger";

const SLIDE = { duration: 0.22, ease: [0.22, 1, 0.36, 1] } as const;

/**
 * The panel's Insights (`base`) and, while `open`, Link settings over it.
 * Insights is never unmounted for it: its tab, scroll and any open row stay
 * as they were. Going back gives focus to what opened the view, else the
 * gear.
 */
export function PanelViews({
  open,
  opener,
  base,
  settings,
}: {
  open: boolean;
  /** What opened Link settings (the gear or a Turn on), for focus on return. */
  opener: MutableRefObject<HTMLElement | null>;
  base: ReactNode;
  settings: ReactNode;
}) {
  const reduce = useReducedMotion();
  const transition = reduce ? { duration: 0 } : SLIDE;
  const baseRef = useRef<HTMLDivElement>(null);
  // Hidden once it has slid away; shown again at once on the way back, so
  // focus can land in it.
  const [settled, setSettled] = useState(open);
  if (!open && settled) setSettled(false);

  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current && !open) {
      const from = opener.current;
      const back =
        from?.isConnected && baseRef.current?.contains(from)
          ? from
          : baseRef.current?.querySelector<HTMLElement>(`[${SETTINGS_TRIGGER_ATTR}]`);
      back?.focus({ preventScroll: true });
      opener.current = null;
    }
    wasOpen.current = open;
  }, [open, opener]);

  return (
    <>
      <motion.div
        ref={baseRef}
        className={cn("flex min-h-0 flex-1 flex-col", open && settled && "invisible")}
        inert={open}
        aria-hidden={open || undefined}
        initial={false}
        animate={open ? { x: -32, opacity: 0 } : { x: 0, opacity: 1 }}
        transition={transition}
        onAnimationComplete={() => {
          if (open) setSettled(true);
        }}
        data-testid="insights-view"
      >
        {base}
      </motion.div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="link-settings"
            className="absolute inset-0 flex min-h-0 flex-col"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={transition}
          >
            {settings}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

/**
 * Link settings' own frame: the header (back arrow and "Link settings", or
 * "‹ Link settings" and the rule's name a level in), the question before
 * unsaved changes are dropped, and one scrolling body for `children`.
 */
export function LinkSettingsView({ view, children }: { view: LinkSettingsViewHandle; children: ReactNode }) {
  const { rule, hide, setRule } = view;
  const rootRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // The rule whose editor is drawn now: the cards say so once it is there.
  const [shown, setShown] = useState<string | null>(null);
  const dirty = useRef<Record<string, boolean>>({});
  const [asking, setAsking] = useState(false);
  // Where Link settings was scrolled when a rule opened, for the way back.
  const listScroll = useRef(0);

  const stack = useMemo<RuleStack>(
    () => ({
      rule,
      push: (id) => {
        listScroll.current = bodyRef.current?.scrollTop ?? 0;
        setRule(id);
      },
      shown: setShown,
      dirty: (id, d) => {
        dirty.current[id] = d;
      },
    }),
    [rule, setRule],
  );

  const leaveRule = () => {
    setAsking(false);
    setRule(null);
  };
  const back = () => {
    if (shown === null) {
      hide();
      return;
    }
    if (dirty.current[shown]) {
      setAsking(true);
      return;
    }
    leaveRule();
  };
  const keepEditing = () => {
    setAsking(false);
    titleRef.current?.focus({ preventScroll: true });
  };

  // Escape goes back a level. Caught on the window in the capture phase,
  // ahead of the narrow-window sheet's own Escape, so it never closes the
  // panel. A list drawn elsewhere (an open Select) handles its own Escape.
  const latest = useRef({ back, asking, keepEditing });
  latest.current = { back, asking, keepEditing };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const focused = document.activeElement;
      const inside = !focused || focused === document.body || (rootRef.current?.contains(focused) ?? false);
      if (!inside) return;
      e.preventDefault();
      e.stopPropagation();
      if (latest.current.asking) latest.current.keepEditing();
      else latest.current.back();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Focus moves to the title when the view opens and when a rule opens. On
  // the way back from a rule the cards give focus to its row; the title
  // takes it only if nothing did.
  const lastShown = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const before = lastShown.current;
    lastShown.current = shown;
    if (before === undefined || shown !== null) {
      titleRef.current?.focus({ preventScroll: true });
      if (shown !== null) bodyRef.current?.scrollTo?.({ top: 0 });
      return;
    }
    if (before === shown) return;
    if (bodyRef.current) bodyRef.current.scrollTop = listScroll.current;
    const focused = document.activeElement;
    if (!focused || focused === document.body || !rootRef.current?.contains(focused)) {
      titleRef.current?.focus({ preventScroll: true });
    }
  }, [shown]);

  const ruleLabel = shown === null ? null : (RULE_LABELS as Record<string, string>)[shown] ?? shown;

  return (
    <section
      ref={rootRef}
      aria-label={LINK_SETTINGS}
      data-testid="link-settings"
      // Focusable itself: WebKit (the macOS webview) gives a click's focus
      // to the nearest focusable ancestor, which must be inside the view
      // for Escape to go back rather than close the panel.
      tabIndex={-1}
      className="flex h-full min-h-0 flex-col font-geist outline-none"
    >
      <header className="shrink-0 px-6 pt-5">
        {ruleLabel === null ? (
          <div className="flex items-center gap-1">
            <button type="button" aria-label={BACK_TO_INSIGHTS} onClick={back} className={cn(ICON_BUTTON, "-ml-2")}>
              <ArrowLeft className="size-4" aria-hidden />
            </button>
            <h2
              ref={titleRef}
              tabIndex={-1}
              data-panel-autofocus
              className={cn("text-[16px] font-semibold leading-[22px] tracking-[-0.2px] outline-none", STRONG)}
            >
              {LINK_SETTINGS}
            </h2>
          </div>
        ) : (
          <div className="flex flex-col items-start gap-1">
            <button
              type="button"
              aria-label={BACK_TO_LINK_SETTINGS}
              onClick={back}
              className={cn(TEXT_LINK, "-ml-1 gap-0.5")}
            >
              <ChevronLeft className="size-4" aria-hidden />
              {LINK_SETTINGS}
            </button>
            <h2
              ref={titleRef}
              tabIndex={-1}
              data-panel-autofocus
              className={cn("text-[16px] font-semibold leading-[22px] tracking-[-0.2px] outline-none", STRONG)}
            >
              {ruleLabel}
            </h2>
          </div>
        )}
        {asking && (
          <RowConfirm
            className="mt-2"
            question={DISCARD_QUESTION}
            detail={DISCARD_DETAIL}
            confirmLabel={DISCARD}
            onConfirm={() => {
              if (shown !== null) dirty.current[shown] = false;
              leaveRule();
            }}
            onCancel={keepEditing}
          />
        )}
      </header>
      <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-4" data-testid="link-settings-body">
        <RuleStackContext.Provider value={stack}>{children}</RuleStackContext.Provider>
      </div>
    </section>
  );
}
