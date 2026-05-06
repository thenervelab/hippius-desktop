import Link from "next/link";
import cn from "@/app/lib/utils/cn";
import { RevealTextLine } from "@/components/ui";
import { ChevronDown } from "lucide-react";
import { SubMenuItemData } from "./NavData";
import { activeSubMenuItemAtom } from "./sideBarAtoms";
import { usePathname } from "next/navigation";

import { useState, useEffect, useRef } from "react";
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
}) => {
  const hasSubMenu = subMenuItems.length > 0;
  const setActiveSubMenuItem = useSetAtom(activeSubMenuItemAtom);
  const pathname = usePathname();
  const pendingClearRef = useRef<string | null>(null);

  const [submenuOpen, setSubmenuOpen] = useState(active ?? false);

  useEffect(() => {
    if (active) setSubmenuOpen(true);
  }, [active]);

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
        "flex items-center gap-2 p-2.5 rounded-[12px] w-full overflow-hidden",
        active && "bg-white/60",
        !active && !comingSoon && "hover:bg-white/30",
        collapsed && "justify-center",
      )}
    >
      <span
        className={cn(
          "size-[18px] flex-shrink-0 flex items-center justify-center",
          active ? "text-[#0a0a0a]" : "text-grey-40",
          comingSoon && "opacity-40",
        )}
      >
        {icon}
      </span>
      {!collapsed && (
        <div className="flex items-center w-full min-w-0">
          <span
            className={cn(
              "text-sm font-medium leading-5 tracking-[-0.28px] whitespace-nowrap overflow-hidden text-ellipsis transition-opacity duration-300",
              active ? "text-[#0a0a0a]" : "text-grey-40",
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
            <div className="ml-auto h-5 w-5 rounded-md flex items-center justify-center bg-black/5 flex-shrink-0">
              <ChevronDown
                className={cn(
                  "size-3 text-grey-40 transition-transform duration-200",
                  !submenuOpen && "-rotate-90",
                )}
              />
            </div>
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
              // When collapsed, navigate to the parent path or first child
              const target = href || subMenuItems[0]?.path;
              if (target) window.location.href = target;
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
                  pathname === sub.path ||
                  pathname.startsWith(sub.path + "/");
                return (
                  <Link
                    key={sub.path + sub.label}
                    href={sub.path}
                    className={cn(
                      "flex items-center gap-2 p-2 rounded-[10px] transition-colors duration-200",
                      subActive
                        ? "bg-white/60 text-[#0a0a0a]"
                        : "text-grey-40 hover:bg-white/30",
                    )}
                  >
                    {sub.icon && (
                      <span className="size-[18px] flex-shrink-0 flex items-center justify-center">
                        {sub.icon}
                      </span>
                    )}
                    <span className="text-sm font-medium leading-5 tracking-[-0.28px] truncate">
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
