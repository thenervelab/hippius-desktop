"use client";

import { AppVersion } from "@/components/ui";
import cn from "@/app/lib/utils/cn";
import ProfileCard from "@/components/dashboard-title-wrapper/ProfileCard";

import SyncStatusHandler from "@/app/(pages)/SyncStatusHandler";

interface SidebarFooterProps {
  collapsed: boolean;
}

const SidebarFooter: React.FC<SidebarFooterProps> = ({ collapsed }) => {
  return (
    <div
      className={cn(
        // shrink-0 so the footer keeps its natural height when the viewport is
        // short (high zoom = small effective height): the nav area above is the
        // flex-1 min-h-0 scroller and absorbs the shrink, so the avatar/version
        // never get compressed/clipped.
        "flex flex-col w-full pt-2 shrink-0 transition-[padding] duration-300 ease-in-out overflow-hidden gap-2",
        // 12px in collapsed view leaves 37px of content width inside the 61px
        // rail — room for the avatar button's 36px circular hover halo without
        // overflow-hidden clipping it (px-3.5 left only 33px and cut its sides;
        // the row's justify-center keeps the avatar centered regardless).
        collapsed ? "px-3" : "px-6",
      )}
    >
      <div
        data-sync-widget-sidebar-host="true"
        className="hidden"
        aria-hidden="true"
      />

      {/* Rendered in BOTH sidebar states. Collapsed → the compact circular ring
          (left-aligned under the avatar) so the widget no longer vanishes;
          expanded → the full card. The widget owns its own -mx-3 bleed (full
          card / dev panel only, never the ring), so the ring stays aligned
          under the avatar and no footer-level margin is needed here.
          LIVE swap:  */}
      <SyncStatusHandler host="sidebar" collapsed={collapsed} />

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
