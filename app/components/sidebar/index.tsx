"use client";

import { usePathname } from "next/navigation";
import cn from "@/app/lib/utils/cn";
import NavItem from "./NavItem";
import { navSections } from "./NavData";
import { useAtom, useAtomValue } from "jotai";
import { sidebarCollapsedAtom } from "@/app/components/sidebar/sideBarAtoms";
import { shareFeatureEnabledAtom } from "@/app/lib/global-atoms/sharesAtoms";
import { InView } from "react-intersection-observer";
import { useEffect, useMemo, useRef } from "react";
import SidebarSearch from "./SidebarSearch";
import SidebarFooter from "./SidebarFooter";
import { BELOW_TITLEBAR_TOP_54 } from "@/app/lib/utils/platformChrome";

const AUTO_COLLAPSE_WIDTH = 1100;

/**
 * Effective viewport width for the auto-collapse decision.
 *
 * Zoom uses the native webview page zoom, which reflows the layout viewport, so
 * `window.innerWidth` ALREADY reports the zoomed-in (narrower) / zoomed-out
 * (wider) width — no manual division by the zoom factor. Dividing here (the old
 * root-font-size behaviour) double-counted the zoom and collapsed the rail far
 * too early when zoomed in.
 */
function getEffectiveWidth(): number {
  return window.innerWidth;
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

  if (pathname.startsWith("/settings")) return null;

  return (
    <InView triggerOnce>
      {({ ref, inView }) => (
        <div
          ref={ref}
          className={cn(
            "fixed left-0 bottom-0 bg-transparent  flex flex-col overflow-hidden transition-all duration-300 ease-in-out z-50",
            // Tracks the top bar's zoom-compensated band height so the rail
            // never rises into the macOS traffic lights when zoomed out.
            BELOW_TITLEBAR_TOP_54,
            collapsed ? "w-[3.8125rem]" : "w-[16.4375rem]",
          )}
        >
            <div className="flex flex-col flex-1 min-h-0 overflow-y-auto px-3 pt-0.5 pb-2 overflow-x-hidden">
              <SidebarSearch collapsed={collapsed} />

              {visibleSections.map((section) => (
                <div
                  key={section.label}
                  className="flex flex-col gap-y-1.5 w-full pt-[10px]"
                >
                  {!collapsed && (
                    <div className="flex items-center justify-start px-2.5 py-1.5">
                      <span className="text-[10px] font-medium tracking-[-0.2px] text-[rgba(0,0,0,0.4)] dark:text-white/40 uppercase whitespace-nowrap overflow-hidden text-ellipsis">
                        {section.label}
                      </span>
                    </div>
                  )}

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
                          external={item?.external}
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
  );
};

export default Sidebar;
