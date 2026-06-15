import Link from "next/link";
import { openUrl } from "@tauri-apps/plugin-opener";
import cn from "@/app/lib/utils/cn";
import { RevealTextLine } from "@/components/ui";
import { ChevronDown } from "lucide-react";
import { SubMenuItemData } from "./NavData";
import { activeSubMenuItemAtom, sidebarCollapsedAtom } from "./sideBarAtoms";
import { usePathname } from "next/navigation";

import { useState, useEffect, useMemo, useRef } from "react";
import { useSetAtom } from "jotai";

interface NavItemProps {
  icon: React.ReactNode;
  label: string;
  href: string;
  active?: boolean;
  collapsed?: boolean;
  className?: string;
  inView: boolean;
  comingSoon?: boolean;
  onClick?: () => void;
  subMenuItems?: SubMenuItemData[];
  // When true, `href` is a full external URL opened in the system browser.
  external?: boolean;
}

const NavItem: React.FC<NavItemProps> = ({
  icon,
  label,
  href,
  active,
  collapsed,
  className,
  inView,
  comingSoon,
  onClick,
  subMenuItems = [],
  external,
}) => {
  const hasSubMenu = subMenuItems.length > 0;
  const setActiveSubMenuItem = useSetAtom(activeSubMenuItemAtom);
  const setSidebarCollapsed = useSetAtom(sidebarCollapsedAtom);
  const pathname = usePathname();
  const pendingClearRef = useRef<string | null>(null);

  // A child being active should auto-expand the submenu, but must NOT cause
  // the parent row itself to render as active.
  const hasActiveChild = useMemo(
    () =>
      subMenuItems.some(
        (sub) => pathname === sub.path || pathname.startsWith(sub.path + "/"),
      ),
    [pathname, subMenuItems],
  );

  const [submenuOpen, setSubmenuOpen] = useState(
    (active ?? false) || hasActiveChild,
  );

  useEffect(() => {
    if (active || hasActiveChild) setSubmenuOpen(true);
  }, [active, hasActiveChild]);

  useEffect(() => {
    if (collapsed) setSubmenuOpen(false);
  }, [collapsed]);

  useEffect(() => {
    if (pendingClearRef.current && pathname === pendingClearRef.current) {
      setActiveSubMenuItem("");
      pendingClearRef.current = null;
    }
  }, [pathname, setActiveSubMenuItem]);

  const itemContent = (
    <RevealTextLine
      reveal={inView}
      parentClassName="block"
      className={cn(
        "flex items-center gap-2 p-[10px] w-full overflow-hidden transition-colors duration-200",
        active
          ? "bg-white/60 dark:bg-white/20 rounded-[12px]"
          : "rounded-[6px] hover:bg-white/30 dark:hover:bg-white/10",
      )}
    >
      <span
        className={cn(
          "size-[18px] flex-shrink-0 flex items-center justify-center",
          active
            ? "text-primary-50 dark:text-primary-brand-dark"
            : "text-[#606060] dark:text-grey-dark-600",
          comingSoon && "opacity-40",
        )}
      >
        {icon}
      </span>
      {!collapsed && (
        <div className="flex items-center w-full min-w-0">
          <span
            className={cn(
              "text-[14px] font-medium leading-5 tracking-[-0.28px] whitespace-nowrap overflow-hidden text-ellipsis transition-opacity duration-300",
              active
                ? "text-[#0a0a0a] dark:text-grey-light-100"
                : "text-[#606060] dark:text-grey-dark-600",
              comingSoon && "text-gray-400",
            )}
          >
            {label}
          </span>

          {comingSoon && (
            <span className="text-[0.5625rem] text-amber-700 px-1.5 py-0.5 rounded-sm whitespace-nowrap absolute right-0 -top-1">
              Coming Soon
            </span>
          )}

          {hasSubMenu && (
            <span className="ml-auto size-5 flex-shrink-0 flex items-center justify-center rounded-md bg-[#0000000A] dark:bg-white/10">
              <ChevronDown
                className={cn(
                  "size-3 text-black transition-transform duration-200 dark:text-grey-dark-600",
                  !submenuOpen && "-rotate-90",
                )}
                strokeWidth={2}
              />
            </span>
          )}
        </div>
      )}
    </RevealTextLine>
  );

  if (comingSoon) {
    return (
      <div
        className={cn(
          "transition-all duration-300 relative group cursor-not-allowed opacity-70",
          className,
        )}
      >
        {itemContent}
      </div>
    );
  }

  if (hasSubMenu) {
    return (
      <div className={cn("flex flex-col w-full", className)}>
        <button
          type="button"
          aria-expanded={collapsed ? undefined : submenuOpen}
          onClick={() => {
            if (collapsed) {
              setSidebarCollapsed(false);
              setSubmenuOpen(true);
              return;
            }
            setSubmenuOpen((prev) => !prev);
          }}
          className="transition-all duration-300 relative group w-full text-left"
        >
          {itemContent}
        </button>

        <div
          aria-hidden={collapsed || !submenuOpen}
          className={cn(
            "grid overflow-hidden transition-[grid-template-rows] duration-200 ease-out",
            !collapsed && submenuOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
          )}
        >
          <div className="overflow-hidden">
            <div className="flex flex-col pl-4 pt-1 gap-y-0.5">
              {subMenuItems.map((sub) => {
                const subActive =
                  pathname === sub.path || pathname.startsWith(sub.path + "/");

                // Gated sub-item: not a link. Greyed text + orange
                // "Coming Soon" tag, mirroring the web console's sidebar
                // treatment of unreleased features.
                if (sub.comingSoon) {
                  return (
                    <span
                      key={sub.path + sub.label}
                      className="relative flex items-center gap-2 p-[10px] pt-4 rounded-[6px] cursor-default text-[#b0b0b0] dark:text-[#6e6e6e]"
                    >
                      {sub.icon && (
                        <span className="size-[18px] flex-shrink-0 flex items-center justify-center text-current">
                          {sub.icon}
                        </span>
                      )}
                      <span className="text-[14px] font-medium leading-5 tracking-[-0.28px] truncate">
                        {sub.label}
                      </span>
                      <span className="absolute right-2 top-1 whitespace-nowrap text-[10px] font-medium text-amber-600 dark:text-amber-500">
                        Coming Soon
                      </span>
                    </span>
                  );
                }

                return (
                  <Link
                    key={sub.path + sub.label}
                    href={sub.path}
                    className={cn(
                      "flex items-center gap-2 p-[10px] transition-colors duration-200",
                      subActive
                        ? "bg-white/60 dark:bg-white/20 text-[#0a0a0a] dark:text-grey-light-100 rounded-[12px]"
                        : "rounded-[6px] text-[#606060] dark:text-grey-dark-600 hover:bg-white/30 dark:hover:bg-white/10",
                    )}
                  >
                    {sub.icon && (
                      <span
                        className={cn(
                          "size-[18px] flex-shrink-0 flex items-center justify-center",
                          subActive
                            ? "text-primary-50 dark:text-primary-brand-dark"
                            : "text-[#606060] dark:text-grey-dark-600",
                        )}
                      >
                        {sub.icon}
                      </span>
                    )}
                    <span className="text-[14px] font-medium leading-5 tracking-[-0.28px] truncate">
                      {sub.label}
                    </span>
                  </Link>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (external) {
    return (
      <button
        type="button"
        onClick={() => void openUrl(href)}
        className={cn(
          "transition-all duration-300 relative group w-full text-left",
          className,
        )}
      >
        {itemContent}
      </button>
    );
  }

  if (onClick) {
    return (
      <button
        onClick={onClick}
        className={cn(
          "transition-all duration-300 relative group w-full text-left",
          className,
        )}
      >
        {itemContent}
      </button>
    );
  }

  return (
    <Link
      href={href}
      className={cn("transition-all duration-300 relative group", className)}
      onClick={() => {
        if (pathname !== href) {
          pendingClearRef.current = href;
        }
      }}
    >
      {itemContent}
    </Link>
  );
};

export default NavItem;
