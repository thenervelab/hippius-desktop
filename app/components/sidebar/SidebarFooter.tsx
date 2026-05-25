"use client";

import { AppVersion } from "@/components/ui";
import cn from "@/app/lib/utils/cn";
import ProfileCard from "@/components/dashboard-title-wrapper/ProfileCard";
// import SyncWidgetPlayground from "@/app/(pages)/SyncWidgetPlayground";
import SyncStatusHandler from "@/app/(pages)/SyncStatusHandler";

interface SidebarFooterProps {
  collapsed: boolean;
}

const SidebarFooter: React.FC<SidebarFooterProps> = ({ collapsed }) => {
  return (
    <div
      className={cn(
        "flex flex-col w-full pt-2 transition-[padding] duration-300 ease-in-out overflow-hidden gap-2",
        // 14px in collapsed view positions the 30px avatar visually in the
        // middle of the 61px sidebar without any post-animation layout shift.
        collapsed ? "px-4" : "px-6",
      )}
    >
      <div
        data-sync-widget-sidebar-host="true"
        className="hidden"
        aria-hidden="true"
      />

      {!collapsed && (
        <div className="-mx-3">
          {/* <SyncWidgetPlayground liveHost="sidebar" /> */}
          <SyncStatusHandler host="sidebar" />
        </div>
      )}
      <ProfileCard collapsed={collapsed} />

      <div
        className={cn(
          "flex items-center gap-1 w-full font-medium text-grey-dark-600 py-2.5 whitespace-nowrap overflow-hidden",
          collapsed ? "text-[0.625rem] ml-0.5" : "text-xs",
        )}
      >
        {!collapsed && <span>Version</span>}
        <AppVersion />
      </div>
    </div>
  );
};

export default SidebarFooter;
