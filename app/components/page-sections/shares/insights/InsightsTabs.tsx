"use client";

import { useEffect, useRef } from "react";

import { cn } from "@/lib/utils";
import { tabIds } from "@/components/ui/tabs/tabIds";
import { FOCUS, MUTED, STRONG } from "./panelStyles";
import type { InsightsTab } from "./insightsView";

export interface InsightsTabItem {
  key: InsightsTab;
  label: string;
  /** Drawn after the label; `null` while it loads or where there is none. */
  count: number | null;
}

/**
 * The panel's tabs as one underlined row: each tab as wide as its words, its
 * count after the label in a quieter tone, the selected one in full colour
 * over a line. Five tabs with their counts fit the panel's width; if counts
 * grow past that the row scrolls sideways (never clipping a label) and keeps
 * the selected tab in view.
 *
 * The WAI-ARIA tabs pattern with automatic activation: the row is one tab
 * stop, and the arrow keys, Home and End move focus and selection together.
 * Each tab points at the `TabPanel` built from the same `idBase`.
 */
export function InsightsTabs({
  idBase,
  tabs,
  active,
  onChange,
}: {
  idBase: string;
  tabs: ReadonlyArray<InsightsTabItem>;
  active: InsightsTab;
  onChange: (tab: InsightsTab) => void;
}) {
  const refs = useRef(new Map<InsightsTab, HTMLButtonElement>());

  useEffect(() => {
    refs.current.get(active)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [active]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((t) => t.key === active);
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const key = tabs[next].key;
    onChange(key);
    refs.current.get(key)?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label="Insights"
      onKeyDown={onKeyDown}
      className={cn(
        "flex gap-4 overflow-x-auto border-b border-grey-80 [scrollbar-width:none] dark:border-white/10",
        "[&::-webkit-scrollbar]:hidden",
      )}
    >
      {tabs.map((t) => {
        const on = t.key === active;
        const ids = tabIds(idBase, t.key);
        return (
          <button
            key={t.key}
            ref={(el) => {
              if (el) refs.current.set(t.key, el);
              else refs.current.delete(t.key);
            }}
            type="button"
            role="tab"
            id={ids.tab}
            aria-controls={ids.panel}
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(t.key)}
            className={cn(
              "relative flex h-9 shrink-0 items-center gap-1 whitespace-nowrap rounded-t-[6px] text-[13px] font-medium transition-colors",
              FOCUS,
              // The row scrolls, which clips anything drawn outside a tab.
              "focus-visible:ring-inset",
              on ? STRONG : cn(MUTED, "hover:text-grey-10 dark:hover:text-white"),
            )}
          >
            <span>{t.label}</span>
            {t.count !== null && (
              <>
                {" "}
                <span className={cn("tabular-nums", on ? MUTED : "")}>{t.count}</span>
              </>
            )}
            <span
              aria-hidden
              className={cn(
                "absolute inset-x-0 -bottom-px h-[2px] rounded-full",
                on ? "bg-grey-10 dark:bg-white" : "bg-transparent",
              )}
            />
          </button>
        );
      })}
    </div>
  );
}
