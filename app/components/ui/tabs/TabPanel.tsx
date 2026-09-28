import React from "react";
import { cn } from "@/lib/utils";
import { tabIds } from "./tabIds";

/**
 * One panel under an accessible `TabList` (the one given the same
 * `idBase`). Every panel stays mounted, so what someone typed in one
 * survives a switch to another; only the selected one shows.
 *
 * A hidden panel gets the `hidden` attribute AND the `hidden` class: a
 * panel laid out with `flex` or `grid` would otherwise win over the
 * browser's `[hidden] { display: none }` and leave every panel on screen.
 * `cn` (tailwind-merge) lets the later `hidden` replace the display class.
 */
export const TabPanel = React.forwardRef<
  HTMLDivElement,
  {
    idBase: string;
    tabKey: string;
    activeTab: string;
    className?: string;
    children: React.ReactNode;
  }
>(function TabPanel({ idBase, tabKey, activeTab, className, children }, ref) {
  const ids = tabIds(idBase, tabKey);
  const active = activeTab === tabKey;
  return (
    <div
      ref={ref}
      role="tabpanel"
      id={ids.panel}
      aria-labelledby={ids.tab}
      hidden={!active}
      tabIndex={0}
      className={cn("focus-visible:outline-none", className, !active && "hidden")}
    >
      {children}
    </div>
  );
});

export default TabPanel;
