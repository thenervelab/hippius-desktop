import Link from "next/link";
import cn from "@/app/lib/utils/cn";
import { Graphsheet, RevealTextLine } from "../ui";
import { ChevronDown } from "lucide-react";
import * as NavigationMenu from "@radix-ui/react-navigation-menu";
import { SubMenuItemData } from "./nav-data";
import SubMenuList from "./sub-menu-list";
import { activeSubMenuItemAtom } from "./sideBarAtoms";
import { usePathname } from "next/navigation";

import { useState, useEffect, useRef } from "react";
import { useAtom } from "jotai";

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
  const [openValue, setOpenValue] = useState<string | undefined>(undefined);

  const hasSubMenu = subMenuItems.length > 0;
  const [activeSubMenuItem, setActiveSubMenuItem] = useAtom(
    activeSubMenuItemAtom
  );

  const pathname = usePathname();
  const pendingClearRef = useRef<string | null>(null);

  useEffect(() => {
    if (pendingClearRef.current && pathname === pendingClearRef.current) {
      setActiveSubMenuItem("");
      pendingClearRef.current = null;
    }
  }, [pathname, setActiveSubMenuItem]);

  const navContent = (
    <RevealTextLine
      reveal={inView}
      parentClassName="block"
      className="flex items-center py-1.5 px-3.5 h-8 overflow-hidden"
    >
      {active && (
        <Graphsheet
          majorCell={{
            lineColor: [31, 80, 189, 1.0],
            lineWidth: 2,
            cellDim: 40,
          }}
          minorCell={{
            lineColor: [49, 103, 211, 1.0],
            lineWidth: 1,
            cellDim: 5,
          }}
          className={"absolute w-full h-full top-0 bottom-0 left-0 opacity-20"}
        />
      )}

      <div
        className={cn(
          "absolute left-[3px] bg-primary-50 w-0.5 h-[22px] rounded-3xl",
          !active && "opacity-0  transition-opacity duration-300",
          !active &&
            label !== "Logout" &&
            !comingSoon &&
            "group-hover:opacity-100 group-[[data-state=open]]:opacity-100"
        )}
      />

      <span
        className={cn("size-4 flex-shrink-0", {
          "opacity-40": comingSoon,
        })}
      >
        {icon}
      </span>
      {!collapsed && (
        <div className="ml-1.5 flex items-center w-full">
          <span
            className={cn(
              "text-sm font-medium whitespace-nowrap overflow-hidden transition-opacity duration-300",
              comingSoon && "text-gray-400"
            )}
          >
            {label}
          </span>

          {activeSubMenuItem &&
            label === "Files" &&
            (activeSubMenuItem === "Public" ||
              activeSubMenuItem === "Private") &&
            !collapsed && (
              <span
                className="ml-1 transform translate-x-[0.5px] shrink-0 rounded-full border border-primary-70
                 bg-primary-90/20 px-2 py-[1px] text-[10px] leading-none
                 font-medium text-primary-40"
              >
                {activeSubMenuItem}
              </span>
            )}
          {comingSoon && !collapsed && (
            <span className=" text-[9px]  text-amber-700 px-1.5 py-0.5 rounded-sm whitespace-nowrap absolute right-0 -top-1">
              Coming Soon
            </span>
          )}

          {hasSubMenu && !collapsed && (
            <div className="z-20 h-4 w-4 border border-primary-80 bg-primary-100 rounded-[4px] flex items-center justify-center ml-auto">
              <ChevronDown className="transition-transform duration-200 w-[12px] h-[12px] text-primary-50 group-[[data-state=open]]:-rotate-90" />
            </div>
          )}
        </div>
      )}
    </RevealTextLine>
  );

  // If comingSoon is true, render a div instead of a Link
  if (comingSoon) {
    return (
      <div
        className={cn(
          "transition-all duration-300 relative group cursor-not-allowed opacity-70",
          className
        )}
      >
        {navContent}
      </div>
    );
  }

  if (hasSubMenu) {
    const ITEM_VALUE = label;

    const closeMenu = () => setOpenValue?.(undefined);
    // const handleClick = (e: React.MouseEvent) => {
    //   if (comingSoon) return;
    //   setActiveSubMenuItem("Private");
    //   closeMenu();
    // };
    return (
      <NavigationMenu.Root
        value={openValue}
        onValueChange={setOpenValue}
        className="z-[999]"
      >
        <NavigationMenu.List className="list-none m-0 p-0 z-[999]">
          <NavigationMenu.Item value={ITEM_VALUE} className="relative h-8">
            <NavigationMenu.Trigger
              className={cn(
                "transition-all duration-300 relative group w-full text-left",
                {
                  "bg-blue-50 text-primary-40": active,
                  "hover:bg-gray-100 hover:text-primary-40 text-grey-40 [&[data-state=open]]:bg-gray-100 [&[data-state=open]]:text-primary-40":
                    !active,
                },
                className
              )}
            >
              {/* <Link href={href} onClick={handleClick}> */}
              {navContent}
              {/* </Link> */}
            </NavigationMenu.Trigger>

            <NavigationMenu.Content className="absolute left-full top-0 z-[999] bg-white rounded shadow-tooltip border border-grey-80">
              <SubMenuList
                items={subMenuItems}
                inView={inView}
                onItemClick={closeMenu}
              />
            </NavigationMenu.Content>
          </NavigationMenu.Item>
          <NavigationMenu.Indicator />
        </NavigationMenu.List>
      </NavigationMenu.Root>
    );
  }

  // If onClick is provided, render a button instead of a Link
  if (onClick) {
    return (
      <button
        onClick={onClick}
        className={cn(
          "transition-all duration-300 relative group w-full text-left",
          {
            "bg-blue-50 text-primary-40": active,
            "hover:bg-gray-100 hover:text-primary-40 text-grey-40":
              !active && label !== "Logout",
            "hover:bg-gray-100 hover:text-red-600 text-error-50":
              label === "Logout",
          },
          className
        )}
      >
        {navContent}
      </button>
    );
  }

  // Otherwise, render a regular Link
  return (
    <Link
      href={href}
      className={cn(
        "transition-all duration-300 relative group",
        {
          "bg-blue-50 text-primary-40": active,
          "hover:bg-gray-100 hover:text-primary-40 text-grey-40":
            !active && label !== "Logout",
          "hover:bg-gray-100 hover:text-red-600 text-error-50":
            label === "Logout",
        },
        className
      )}
      onClick={() => {
        // Only schedule clearing if navigating to a different route
        if (pathname !== href) {
          pendingClearRef.current = href;
        }
      }}
    >
      {navContent}
    </Link>
  );
};

export default NavItem;
