"use client";

import React, { useRef, type KeyboardEvent, type ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface UnderlineTab<K extends string = string> {
  key: K;
  label: string;
  /**
   * A shorter name for a narrow content column, e.g. "With you" for "Shared
   * with you". The accessible name keeps the full label at every width, so a
   * screen reader hears the same tab whatever the window size.
   */
  shortLabel?: string;
  /** Drawn as a small pill after the label. */
  count?: number;
}

interface UnderlineTabsProps<K extends string> {
  tabs: ReadonlyArray<UnderlineTab<K>>;
  value: K;
  onChange: (_key: K) => void;
  /** Names the group for assistive tech ("Filter shared drives"). */
  ariaLabel: string;
  /**
   * The id a tab and its panel share, when there is a panel to point at:
   * the tab gets `${idBase}-tab-${key}`, `aria-controls` points at
   * `${idBase}-panel-${key}`. A tab row that only filters a list it sits
   * above has no panel and leaves this out.
   */
  idBase?: string;
  /** Rendered on the right of the row, outside the scrolling tabs. */
  trailing?: ReactNode;
  className?: string;
}

/** The pill a count sits in. Tinted with the brand colour on the active tab. */
const COUNT_CLASS =
  "inline-flex h-[18px] min-w-[20px] items-center justify-center rounded-full px-1.5 text-[11px] font-medium leading-none tabular-nums transition-colors";

/**
 * Quiet underline tabs, the web console's `UnderlineTabs`: labels on a 1px
 * rule, the active one in the brand colour with a 2px underline sitting on
 * that rule, each with an optional count pill. For switching what a list
 * shows, where the filled `TabList` tray would be louder than the thing it
 * filters.
 *
 * Keyboard is the WAI-ARIA tabs pattern with automatic activation: the row is
 * one tab stop (the selected tab), ArrowLeft/ArrowRight/Home/End move focus
 * and selection together, and Enter/Space select the focused tab.
 *
 * The rule belongs to the row, not to the scrolling list, so it spans the
 * full width, `trailing` included, and the tabs can scroll sideways in a
 * narrow column without dragging the rule with them or clipping the
 * underline.
 *
 * Short labels follow the app's content column, not the window: below
 * `@2xl` of the scroll area's `@container` (the 900px minimum window with
 * the sidebar open) they shorten. The console does the same at `sm`, but a
 * desktop window never gets that narrow while the sidebar can still squeeze
 * the column.
 */
function UnderlineTabs<K extends string>({
  tabs,
  value,
  onChange,
  ariaLabel,
  idBase,
  trailing,
  className,
}: UnderlineTabsProps<K>) {
  const refs = useRef(new Map<K, HTMLButtonElement>());

  const select = (key: K, focus: boolean) => {
    onChange(key);
    if (focus) refs.current.get(key)?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((t) => t.key === value);
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    select(tabs[next]!.key, true);
  };

  return (
    <div
      className={cn(
        "relative flex min-w-0 items-center gap-4",
        // The rule the active underline sits on.
        "before:pointer-events-none before:absolute before:inset-x-0 before:bottom-0 before:h-px before:bg-grey-dark-100 dark:before:bg-black-300",
        className,
      )}
    >
      <div
        role="tablist"
        aria-label={ariaLabel}
        onKeyDown={onKeyDown}
        className="no-scrollbar flex min-w-0 flex-1 items-stretch gap-4 overflow-x-auto"
      >
        {tabs.map((tab) => {
          const on = tab.key === value;
          const name = tab.count === undefined ? tab.label : `${tab.label} (${tab.count})`;
          return (
            <button
              key={tab.key}
              ref={(el) => {
                if (el) refs.current.set(tab.key, el);
                else refs.current.delete(tab.key);
              }}
              type="button"
              role="tab"
              id={idBase ? `${idBase}-tab-${tab.key}` : undefined}
              aria-controls={idBase ? `${idBase}-panel-${tab.key}` : undefined}
              aria-selected={on}
              aria-label={name}
              tabIndex={on ? 0 : -1}
              onClick={() => select(tab.key, false)}
              className={cn(
                "group relative flex h-10 shrink-0 items-center gap-1.5 rounded-[4px] px-1 font-geist text-[13px] outline-none transition-colors",
                "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-50/60 dark:focus-visible:ring-primary-brand-dark/60",
                // The underline, drawn over the row's rule.
                "after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full",
                on
                  ? "font-medium text-primary-50 after:bg-primary-50 dark:text-primary-brand-dark dark:after:bg-primary-brand-dark"
                  : "text-grey-60 after:bg-transparent hover:text-grey-10 dark:text-grey-dark-800 dark:hover:text-grey-light-100",
              )}
            >
              {/* Both weights share one grid cell, so the tab is as wide as
                  its medium-weight label whether or not it is selected, and
                  picking one does not nudge the tabs after it. */}
              <span className="inline-grid">
                <Label tab={tab} className="col-start-1 row-start-1" />
                <Label tab={tab} className="invisible col-start-1 row-start-1 font-medium" />
              </span>
              {tab.count !== undefined ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    COUNT_CLASS,
                    on
                      ? "bg-primary-100 text-primary-50 dark:bg-primary-50/[0.17] dark:text-primary-brand-dark"
                      : "bg-grey-90 text-grey-50 dark:bg-black-300 dark:text-grey-dark-800",
                  )}
                >
                  {tab.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      {trailing ? <div className="shrink-0">{trailing}</div> : null}
    </div>
  );
}

function Label({ tab, className }: { tab: UnderlineTab; className?: string }) {
  if (!tab.shortLabel) {
    return <span className={cn("whitespace-nowrap", className)}>{tab.label}</span>;
  }
  return (
    <span className={cn("whitespace-nowrap", className)}>
      <span className="@2xl:hidden">{tab.shortLabel}</span>
      <span className="hidden @2xl:inline">{tab.label}</span>
    </span>
  );
}

export default UnderlineTabs;
