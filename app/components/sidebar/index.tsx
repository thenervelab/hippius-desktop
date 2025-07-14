"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icons, RevealTextLine } from "../ui";
import cn from "@/app/lib/utils/cn";
import NavItem from "./nav-item";
import { navItems, footerNavItems } from "./nav-data";
import { useAtom } from "jotai";
import {
  settingsDialogOpenAtom,
  sidebarCollapsedAtom
} from "@/app/components/sidebar/sideBarAtoms";
import { InView } from "react-intersection-observer";
import FooterNavItem from "./footer-nav-items";
import SettingsWidthDialog from "../page-sections/settings/SettingsDialog";
import SettingsDialogContent from "../page-sections/settings/SettingsDialogContent";

const Sidebar: React.FC = () => {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useAtom(sidebarCollapsedAtom);
  const [settingsDialogOpen, setSettingsDialogOpen] = useAtom(
    settingsDialogOpenAtom
  );

  const toggleSidebar = () => {
    setCollapsed(!collapsed);
  };

  return (
    <>
      <SettingsWidthDialog
        open={settingsDialogOpen}
        onOpenChange={setSettingsDialogOpen}
        heading="Settings"
      >
        <SettingsDialogContent />
      </SettingsWidthDialog>

      <InView triggerOnce>
        {({ ref, inView }) => (
          <div
            ref={ref}
            className={cn(
              "fixed top-0 left-0 bottom-0 bg-white flex flex-col ml-4 my-4 border border-grey-80 rounded transition-all duration-300 ease-in-out overflow-hidden",
              collapsed ? "w-[48px]" : "w-[145px]"
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
                    "size-4 transition-transform duration-300",
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
              {navItems.map((item) => (
                <NavItem
                  key={item.path}
                  icon={item.icon}
                  label={item.label}
                  href={item.path}
                  inView={inView}
                  active={pathname === item.path}
                  comingSoon={item?.comingSoon}
                  collapsed={collapsed}
                  onClick={
                    item.label === "Settings"
                      ? () => setSettingsDialogOpen(true)
                      : undefined
                  }
                />
              ))}
            </div>

            <div className="py-2 border-y border-gray-80 mt-2 w-full">
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
                "flex w-full text-xs font-digital text-grey-70 transition-all duration-300",
                collapsed ? "justify-center p-2" : "px-4 py-2"
              )}
            >
              <>
                <span className={cn(collapsed ? "text-[10px]" : "")}>
                  {!collapsed ? "VER" : "0.1.10"}
                </span>
                {!collapsed && (
                  <span className="whitespace-nowrap ml-1.5 overflow-hidden">
                    0.1.10
                  </span>
                )}
              </>
            </RevealTextLine>
          </div>
        )}
      </InView>
    </>
  );
};

export default Sidebar;
