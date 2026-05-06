"use client";

import { usePathname } from "next/navigation";
import cn from "@/app/lib/utils/cn";
import NavItem from "./NavItem";
import { navSections } from "./NavData";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  settingsDialogOpenAtom,
  sidebarCollapsedAtom,
} from "@/app/components/sidebar/sideBarAtoms";
import { shareFeatureEnabledAtom } from "@/app/lib/global-atoms/sharesAtoms";
import { InView } from "react-intersection-observer";
import SettingsWidthDialog from "@/components/page-sections/settings/SettingsDialog";
import SettingsDialogContent from "@/components/page-sections/settings/SettingsDialogContent";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { triggerSyncPathRefreshAtom } from "@/app/lib/global-atoms/unpinAtoms";
import SidebarSearch from "./SidebarSearch";
import SidebarFooter from "./SidebarFooter";

const AUTO_COLLAPSE_WIDTH = 1100;

/** Effective viewport width accounting for zoom */
function getEffectiveWidth(): number {
  const stored = localStorage.getItem("hippius-zoom-level");
  const zoom = stored ? parseInt(stored, 10) : 100;
  return window.innerWidth / (zoom / 100);
}

const Sidebar: React.FC = () => {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useAtom(sidebarCollapsedAtom);
  const autoCollapsedRef = useRef(false);
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;

  useEffect(() => {
    let wasNarrow = getEffectiveWidth() < AUTO_COLLAPSE_WIDTH;

    const handleChange = () => {
      const isNarrow = getEffectiveWidth() < AUTO_COLLAPSE_WIDTH;
      if (isNarrow && !wasNarrow && !collapsedRef.current) {
        setCollapsed(true);
        autoCollapsedRef.current = true;
      } else if (!isNarrow && wasNarrow && autoCollapsedRef.current) {
        setCollapsed(false);
        autoCollapsedRef.current = false;
      }
      wasNarrow = isNarrow;
    };

    if (wasNarrow && !collapsedRef.current) {
      setCollapsed(true);
      autoCollapsedRef.current = true;
    }

    window.addEventListener("resize", handleChange);
    window.addEventListener("zoom-changed", handleChange);
    return () => {
      window.removeEventListener("resize", handleChange);
      window.removeEventListener("zoom-changed", handleChange);
    };
  }, [setCollapsed]);

  const [settingsDialogOpen, setSettingsDialogOpen] = useAtom(
    settingsDialogOpenAtom,
  );
  const triggerSyncPathRefresh = useSetAtom(triggerSyncPathRefreshAtom);
  const shareEnabled = useAtomValue(shareFeatureEnabledAtom);

  const visibleSections = useMemo(
    () =>
      navSections
        .map((section) => ({
          ...section,
          items: section.items.filter((item) => {
            if (item.featureFlag === "shares") return shareEnabled;
            return true;
          }),
        }))
        .filter((section) => section.items.length > 0),
    [shareEnabled],
  );

  const handleSettingsOpenChange = useCallback(
    (isOpen: boolean) => {
      setSettingsDialogOpen(isOpen);
      if (!isOpen) {
        triggerSyncPathRefresh((prev) => prev + 1);
      }
    },
    [setSettingsDialogOpen, triggerSyncPathRefresh],
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

      <InView triggerOnce>
        {({ ref, inView }) => (
          <div
            ref={ref}
            className={cn(
              "fixed top-[54px] left-0 bottom-0 bg-transparent flex flex-col overflow-hidden transition-all duration-300 ease-in-out z-50",
              collapsed ? "w-[3.8125rem]" : "w-[16.4375rem]",
            )}
          >
            <div className="flex flex-col flex-1 min-h-0 overflow-y-auto px-3 pt-3 pb-2 overflow-x-hidden">
              <SidebarSearch collapsed={collapsed} />

              {visibleSections.map((section) => (
                <div
                  key={section.label}
                  className="flex flex-col gap-y-1.5 w-full pt-[10px]"
                >
                  <div
                    className={cn(
                      "flex items-center py-1.5",
                      collapsed
                        ? "px-0 justify-stretch"
                        : "justify-start px-2.5",
                    )}
                  >
                    <span
                      className={cn(
                        "text-[10px] font-medium tracking-[-0.2px] text-black/40 uppercase whitespace-nowrap overflow-hidden text-ellipsis",
                        collapsed && "flex-1 min-w-0",
                      )}
                    >
                      {section.label}
                    </span>
                  </div>

                  <div className="flex flex-col w-full gap-y-0.5">
                    {section.items.map((item) => {
                      // Only the most-specific entry should look active. If
                      // any sub-item matches the current route, suppress the
                      // parent's active visual — child-active still drives
                      // submenu auto-expand inside NavItem.
                      const hasActiveChild =
                        item.subMenuItems?.some(
                          (sub) =>
                            pathname === sub.path ||
                            pathname.startsWith(sub.path + "/"),
                        ) ?? false;

                      const isActive =
                        !hasActiveChild &&
                        (item.path === "/"
                          ? pathname === item.path
                          : pathname === item.path ||
                            pathname.startsWith(item.path + "/"));

                      return (
                        <NavItem
                          key={`${section.label}-${item.path}-${item.label}`}
                          icon={item.icon}
                          label={item.label}
                          href={item.path}
                          inView={inView}
                          active={isActive}
                          comingSoon={item?.comingSoon}
                          collapsed={collapsed}
                          subMenuItems={item?.subMenuItems}
                        />
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            <SidebarFooter collapsed={collapsed} />
          </div>
        )}
      </InView>
    </>
  );
};

export default Sidebar;
