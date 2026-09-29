import React, { useRef } from "react";
import { cn } from "@/lib/utils";
import TabItem from "./TabItem";
import { tabIds } from "./tabIds";

export interface TabOption {
  tabName: string;
  /** Stable identifier used for matching; falls back to `tabName`. */
  tabKey?: string;
  /** Display label shown in the tab; falls back to `tabName`. */
  displayName?: string;
  icon?: React.ReactNode;
}

interface TabListProps {
  tabs: TabOption[];
  activeTab: string;
  onTabChange: (value: string) => void;
  width?: string;
  height?: string;
  /** Horizontal padding Tailwind class for each tab item. Defaults to `px-3`. */
  tabItemPaddingX?: string;
  /** Vertical padding Tailwind class for each tab item (e.g. `py-[3px]`). When set, overrides `height`. */
  tabItemPaddingY?: string;
  /** Gap between tab items (Tailwind class). Defaults to `gap-1`. */
  gap?: string;
  className?: string;
  tabItemClassName?: string;
  /** Tailwind classes used for the tab label's typography. Defaults to the standard 13px Geist Medium style. */
  textClassName?: string;
  isJustifyStart?: boolean;
  showTooltip?: boolean;
  iconOnly?: boolean;
  /**
   * Makes the list real tabs over panels (the WAI-ARIA tabs pattern): a
   * `tablist` named by `ariaLabel`, each tab a `tab` pointing at its
   * `TabPanel` through ids built from this base (`tabIds`). The list is one
   * tab stop, the selected tab, and ArrowLeft/ArrowRight/Home/End move focus
   * and selection together. Without it the list is the plain switcher it
   * has always been.
   */
  idBase?: string;
  /** The tab list's accessible name. Used with `idBase`. */
  ariaLabel?: string;
}

/** The tab a key moves to from `index`, or null for any other key. */
export function tabIndexForKey(key: string, index: number, count: number): number | null {
  switch (key) {
    case "ArrowRight":
      return (index + 1) % count;
    case "ArrowLeft":
      return (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

const FOCUS_RING = "outline-none focus-visible:ring-2 focus-visible:ring-primary-50/40";

const TabList: React.FC<TabListProps> = ({
  tabs,
  activeTab,
  onTabChange,
  width = "min-w-[148px]",
  height = "h-[36px]",
  tabItemPaddingX,
  tabItemPaddingY,
  gap = "gap-1",
  className,
  tabItemClassName,
  textClassName,
  isJustifyStart = false,
  showTooltip = true,
  iconOnly = false,
  idBase,
  ariaLabel,
}) => {
  const refs = useRef(new Map<string, HTMLDivElement>());
  const accessible = idBase !== undefined;
  const keys = tabs.map((tab) => tab.tabKey ?? tab.tabName);

  return (
    <div
      role={accessible ? "tablist" : undefined}
      aria-label={accessible ? ariaLabel : undefined}
      className={cn(
        "inline-flex rounded-[6px] bg-[#ebebeb] p-1 dark:bg-black-900",
        gap,
        className,
      )}
    >
      {tabs.map((tab, index) => {
        const tabIdentifier = keys[index];
        const selected = activeTab === tabIdentifier;
        const ids = accessible ? tabIds(idBase, tabIdentifier) : null;
        return (
          <TabItem
            key={tabIdentifier}
            ref={(el) => {
              if (el) refs.current.set(tabIdentifier, el);
              else refs.current.delete(tabIdentifier);
            }}
            label={tab.displayName ?? tab.tabName}
            dataLabel={tabIdentifier}
            icon={tab.icon}
            isActive={selected}
            onClick={() => onTabChange(tabIdentifier)}
            width={width}
            height={height}
            paddingX={tabItemPaddingX}
            paddingY={tabItemPaddingY}
            textClassName={textClassName}
            isJustifyStart={isJustifyStart}
            showTooltip={showTooltip}
            iconOnly={iconOnly}
            tabItemClassName={cn(accessible && FOCUS_RING, tabItemClassName)}
            tabAttributes={
              ids
                ? {
                    id: ids.tab,
                    role: "tab",
                    "aria-selected": selected,
                    "aria-controls": ids.panel,
                    tabIndex: selected ? 0 : -1,
                    onKeyDown: (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onTabChange(tabIdentifier);
                        return;
                      }
                      const next = tabIndexForKey(e.key, index, keys.length);
                      if (next === null) return;
                      e.preventDefault();
                      refs.current.get(keys[next])?.focus();
                      onTabChange(keys[next]);
                    },
                  }
                : undefined
            }
          />
        );
      })}
    </div>
  );
};

export default TabList;
