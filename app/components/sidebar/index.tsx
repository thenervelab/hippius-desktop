"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AppVersion, Icons, RevealTextLine } from "@/components/ui";
import cn from "@/app/lib/utils/cn";
import NavItem from "./NavItem";
import { navItems, footerNavItems } from "./NavData";
import { useAtom, useSetAtom } from "jotai";
import {
  settingsDialogOpenAtom,
  sidebarCollapsedAtom,
  activeSettingsTabAtom,
} from "@/app/components/sidebar/sideBarAtoms";
import { InView } from "react-intersection-observer";
import FooterNavItem from "./FooterNavItems";
import SettingsWidthDialog from "@/components/page-sections/settings/SettingsDialog";
import SettingsDialogContent from "@/components/page-sections/settings/SettingsDialogContent";
import CheckForUpdateDialog from "../updater/CheckForUpdateDialog";
import { useState, useCallback, useEffect, useRef } from "react";
import { triggerSyncPathRefreshAtom } from "@/app/lib/global-atoms/unpinAtoms";

const AUTO_COLLAPSE_WIDTH = 1000;

const Sidebar: React.FC = () => {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useAtom(sidebarCollapsedAtom);
  // Track whether we auto-collapsed so we can auto-expand when the window widens
  const autoCollapsedRef = useRef(false);
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;

  // Auto-collapse sidebar when window is narrow, auto-expand when it widens
  useEffect(() => {
    let wasNarrow = window.innerWidth < AUTO_COLLAPSE_WIDTH;

    const handleResize = () => {
      const isNarrow = window.innerWidth < AUTO_COLLAPSE_WIDTH;
      if (isNarrow && !wasNarrow && !collapsedRef.current) {
        // Window just became narrow — auto-collapse
        setCollapsed(true);
        autoCollapsedRef.current = true;
      } else if (!isNarrow && wasNarrow && autoCollapsedRef.current) {
        // Window just became wide again — restore if we auto-collapsed
        setCollapsed(false);
        autoCollapsedRef.current = false;
      }
      wasNarrow = isNarrow;
    };

    // Collapse on mount if already narrow
    if (wasNarrow && !collapsedRef.current) {
      setCollapsed(true);
      autoCollapsedRef.current = true;
    }

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [setCollapsed]);
  const [settingsDialogOpen, setSettingsDialogOpen] = useAtom(
    settingsDialogOpenAtom
  );
  const setActiveSettingsTab = useSetAtom(activeSettingsTabAtom);
  const triggerSyncPathRefresh = useSetAtom(triggerSyncPathRefreshAtom);

  const toggleSidebar = () => {
    setCollapsed(!collapsed);
  };

  const openSettingsWithDefaultTab = () => {
    setActiveSettingsTab("Sync & Storage");
    setSettingsDialogOpen(true);
  };

  const handleSettingsOpenChange = useCallback(
    (isOpen: boolean) => {
      setSettingsDialogOpen(isOpen);
      if (!isOpen) {
        // Refresh Files page data when Settings dialog closes
        triggerSyncPathRefresh((prev) => prev + 1);
      }
    },
    [setSettingsDialogOpen, triggerSyncPathRefresh]
  );

  return (
    <>
      <SettingsWidthDialog
        open={settingsDialogOpen}
        onOpenChange={handleSettingsOpenChange}
        heading="Settings"
      >
        <SettingsDialogContent />
      </SettingsWidthDialog>
      <CheckForUpdateDialog
        open={open}
        onOpenChange={setOpen}
        onClose={() => setOpen(false)}
      />

      <InView triggerOnce>
        {({ ref, inView }) => (
          <div
            ref={ref}
            className={cn(
              "fixed top-0 left-0 bottom-0 bg-white flex flex-col ml-4 my-4 border border-grey-80 rounded transition-all duration-300 ease-in-out z-50",
              collapsed ? "w-[3rem]" : "w-[10.625rem]"
            )}
          >
            <div className="flex flex-col items-start w-full">
              <Link
                className=" hover:opacity-70 pt-2 px-2 duration-300 text-white w-full"
                href="/"
              >
                <RevealTextLine
                  reveal={inView}
                  className="flex items-center gap-x-2"
                >
                  <div className="block rounded-lg bg-primary-50 flex-shrink-0">
                    <Icons.HippiusLogo className="size-8" />
                  </div>

                  {!collapsed && (
                    <span className="font-medium text-grey-10 text-base overflow-hidden transition-opacity duration-300">
                      Hippius
                    </span>
                  )}
                </RevealTextLine>
              </Link>
              <RevealTextLine
                reveal={inView}
                onClick={toggleSidebar}
                className="cursor-pointer block p-1.5 border border-gray-80 rounded self-start mx-2 my-4 transition-all duration-300"
              >
                <Icons.SideBarLeft
                  className={cn(
                    "size-4 transition-transform duration-300 text-grey-40",
                    collapsed && "transform rotate-180"
                  )}
                />
              </RevealTextLine>
            </div>

            {/* <div className="px-4 pt-4">
            {!collapsed && (
              <div className="text-xs text-grey-60 font-semibold mb-2">
                Locations
              </div>
            )}
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-grey-10">
                <FaHdd className="text-grey-50" />
                {!collapsed && <span>Hippius</span>}
              </div>
              <div className="flex items-center gap-2 text-grey-10">
                <FaFolder className="text-blue-500" />
                {!collapsed && (
                  <span>{syncPath ? syncPath.split("/").pop() : ""}</span>
                )}
              </div>
            </div>
          </div> */}

            <div className="flex gap-4 flex-col flex-1 pt-4 border-t border-gray-80 w-full">
              {navItems.map((item) => {
                // Check if current path matches or starts with the item path (for child routes)
                const isActive =
                  item.path === "/"
                    ? pathname === item.path
                    : pathname === item.path ||
                      pathname.startsWith(item.path + "/");

                return (
                  <NavItem
                    key={item.path}
                    icon={item.icon}
                    label={item.label}
                    href={item.path}
                    inView={inView}
                    active={isActive}
                    comingSoon={item?.comingSoon}
                    collapsed={collapsed}
                    subMenuItems={item?.subMenuItems}
                    onClick={
                      item.label === "Settings"
                        ? openSettingsWithDefaultTab
                        : undefined
                    }
                  />
                );
              })}
            </div>

            <div className="py-3 border-b border-gray-80 w-full">
              {footerNavItems.map((item) => (
                <FooterNavItem
                  key={item.label}
                  icon={item.icon}
                  label={item.label}
                  inView={inView}
                  collapsed={collapsed}
                />
              ))}
            </div>

            <RevealTextLine
              reveal={inView}
              className={cn(
                "flex w-full text-xs font-digital text-grey-40 transition-all duration-300 border-b border-gray-80",
                collapsed ? "justify-center p-2" : "px-4 py-3"
              )}
            >
              <>
                <span className={cn(collapsed ? "text-[0.625rem]" : "")}>
                  {!collapsed ? "VER" : <AppVersion />}
                </span>
                {!collapsed && (
                  <span className="whitespace-nowrap ml-1.5 overflow-hidden">
                    <AppVersion />
                  </span>
                )}
              </>
            </RevealTextLine>
            <div className="py-3">
              <div
                className={cn(
                  "transition-all duration-300 relative group cursor-pointer py-2",
                  "hover:bg-gray-100 hover:text-primary-40 text-grey-40"
                )}
                onClick={() => setOpen(true)}
              >
                <RevealTextLine
                  reveal={inView}
                  parentClassName="block"
                  className="flex items-center  px-3.5"
                >
                  <span className="size-4 flex-shrink-0">
                    <Icons.TrendUp />
                  </span>
                  {!collapsed && (
                    <span className="text-sm font-medium whitespace-nowrap ml-1.5 overflow-hidden transition-opacity duration-300">
                      Update App
                    </span>
                  )}
                </RevealTextLine>
              </div>
            </div>

            {/* <RevealTextLine
              reveal={inView}
              className={cn(
                "flex w-full text-xs text-grey-70 transition-all duration-300 font-medium hover:text-primary-50 cursor-pointer",
                collapsed ? "justify-center p-2" : "px-4 py-2"
              )}
              onClick={() => submitABug()}
            >
              <>
                <span className={cn(collapsed ? "text-[0.625rem]" : "")}>
                  {!collapsed ? "Submit a Bug" : "Bug"}
                </span>
              </>
            </RevealTextLine> */}
          </div>
        )}
      </InView>
    </>
  );
};

export default Sidebar;
