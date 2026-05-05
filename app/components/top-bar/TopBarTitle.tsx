"use client";

import { useAtom, useAtomValue } from "jotai";
import { sidebarCollapsedAtom } from "@/components/sidebar/sideBarAtoms";
import { dashboardPageHeaderAtom } from "@/components/dashboard-title-wrapper/dashboardAtoms";
import { cn } from "@/app/lib/utils";

const SidebarToggleMark = ({ collapsed }: { collapsed: boolean }) => (
  <span
    aria-hidden="true"
    className="flex w-[22px] shrink-0 overflow-hidden rounded-[4px] border-[1.2px] border-[#797979] p-[2px]"
  >
    <span
      className={cn(
        "h-3 w-[8px] rounded-[2px] bg-[#797979] transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
        collapsed ? "translate-x-[8px]" : "translate-x-0",
      )}
    />
  </span>
);

const TopBarTitle = () => {
  const [collapsed, setCollapsed] = useAtom(sidebarCollapsedAtom);
  const header = useAtomValue(dashboardPageHeaderAtom);

  const toggle = () => setCollapsed((prev) => !prev);

  return (
    <button
      type="button"
      onClick={toggle}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggle();
        }
      }}
      aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      className={cn(
        "animate-fade-in-from-b-0.3 group flex items-center gap-2 rounded-[10px] py-1 pl-1.5 pr-2 opacity-0 transition-colors hover:bg-[#00000014] dark:hover:bg-[rgba(54,54,54,0.72)]",
      )}
    >
      <SidebarToggleMark collapsed={collapsed} />
      <span
        className={cn(
          "text-[18px] font-medium leading-normal",
          "text-black-900 dark:text-white truncate",
        )}
      >
        {header.mainText}
      </span>
    </button>
  );
};

export default TopBarTitle;
