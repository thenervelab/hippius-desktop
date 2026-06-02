"use client";

import VPNMenu from "@/components/dashboard-title-wrapper/vpn-menu";
import NotificationMenu from "@/components/dashboard-title-wrapper/notifications-menu";
import { VPN_FEATURE_ENABLED } from "@/app/lib/featureFlags";

const TopBarActions = () => {
  return (
    <div className="flex items-center gap-[13px]">
      {/* VPN is hidden behind a feature flag (code kept). See featureFlags.ts. */}
      {VPN_FEATURE_ENABLED && <VPNMenu className="" />}
      <NotificationMenu className="" />
    </div>
  );
};

export default TopBarActions;
