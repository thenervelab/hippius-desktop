"use client";

import VPNMenu from "@/components/dashboard-title-wrapper/vpn-menu";
import NotificationMenu from "@/components/dashboard-title-wrapper/notifications-menu";

const TopBarActions = () => {
  return (
    <div className="flex items-center gap-[13px]">
      <VPNMenu className="" />
      <NotificationMenu className="" />
    </div>
  );
};

export default TopBarActions;
