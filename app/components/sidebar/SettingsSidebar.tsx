"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useAtom } from "jotai";
import { sidebarCollapsedAtom } from "./sideBarAtoms";
import cn from "@/app/lib/utils/cn";
import { Icons } from "@/components/ui";
import { ChevronLeft } from "lucide-react";
import SidebarFooter from "./SidebarFooter";
import CustomTooltip2 from "@/components/ui/CustomTooltip2";

const ICON_CLASS = "size-[18px]";

const settingsNavItems = [
  {
    label: "Sync & Storage",
    section: "sync",
    icon: <Icons.Folder className={ICON_CLASS} />,
  },
  {
    label: "Security",
    section: "security",
    icon: <Icons.KeySquare className={ICON_CLASS} />,
  },
  {
    label: "Notifications",
    section: "notifications",
    icon: <Icons.Notification className={ICON_CLASS} />,
  },
  {
    label: "API Keys",
    section: "api-keys",
    icon: <Icons.Key className={ICON_CLASS} />,
  },
  {
    label: "VPN Settings",
    section: "vpn",
    icon: <Icons.ShieldSecurity className={ICON_CLASS} />,
  },
  {
    label: "Customize RPC",
    section: "customize-rpc",
    icon: <Icons.Box className={ICON_CLASS} />,
  },
];

const SettingsSidebar: React.FC = () => {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeSection = searchParams.get("section") ?? "sync";
  const [collapsed] = useAtom(sidebarCollapsedAtom);

  return (
    <div
      className={cn(
        "fixed top-[54px] left-0 bottom-0 bg-transparent flex flex-col overflow-hidden transition-all duration-300 ease-in-out z-50",
        collapsed ? "w-[3.8125rem]" : "w-[16.4375rem]",
      )}
    >
      <div className="flex flex-col flex-1 min-h-0 overflow-y-auto px-3 pt-0 pb-2 overflow-x-hidden">
        {/* Go Back */}
        <div className="flex flex-col w-full">
          <CustomTooltip2
            tooltipContent="Go Back"
            side="right"
            disabled={!collapsed}
          >
            <button
              type="button"
              onClick={() => router.back()}
              className={cn(
                "flex items-center gap-2 p-[10px] w-full rounded-[12px]",
                "bg-[#0000000F] dark:bg-white/[0.06]",
                "hover:bg-[#00000014] dark:hover:bg-white/10 transition-colors duration-200",
              )}
            >
              <span className="size-[18px] flex-shrink-0 flex items-center justify-center text-[#606060] dark:text-grey-dark-600">
                <ChevronLeft className="size-[18px]" strokeWidth={2} />
              </span>
              {!collapsed && (
                <span className="text-[14px] font-medium leading-5 tracking-[-0.28px] text-[#606060] dark:text-grey-dark-600 whitespace-nowrap overflow-hidden text-ellipsis">
                  Go Back
                </span>
              )}
            </button>
          </CustomTooltip2>
        </div>

        {/* Settings nav */}
        <div className="flex flex-col gap-y-1.5 w-full pt-[10px]">
          {!collapsed && (
            <div className="flex items-center py-1.5 justify-start px-2.5">
              <span className="text-[10px] font-medium tracking-[-0.2px] text-black/40 dark:text-white/40 uppercase">
                SETTINGS
              </span>
            </div>
          )}

          <div className="flex flex-col w-full gap-y-0.5">
            {settingsNavItems.map((item) => {
              const isActive = activeSection === item.section;
              return (
                <CustomTooltip2
                  key={item.section}
                  tooltipContent={item.label}
                  side="right"
                  disabled={!collapsed}
                >
                  <button
                    type="button"
                    onClick={() =>
                      router.replace(`/settings?section=${item.section}`)
                    }
                    className="transition-all duration-300 relative group w-full text-left"
                  >
                    <div
                      className={cn(
                        "flex items-center gap-2 p-[10px] w-full overflow-hidden transition-colors duration-200",
                        isActive
                          ? "bg-white/60 dark:bg-white/20 rounded-[12px]"
                          : "rounded-[6px] hover:bg-white/30 dark:hover:bg-white/10",
                      )}
                    >
                      <span
                        className={cn(
                          "size-[18px] flex-shrink-0 flex items-center justify-center",
                          isActive
                            ? "text-primary-50 dark:text-primary-brand-dark"
                            : "text-[#606060] dark:text-grey-dark-600",
                        )}
                      >
                        {item.icon}
                      </span>
                      {!collapsed && (
                        <span
                          className={cn(
                            "text-[14px] font-medium leading-5 tracking-[-0.28px] whitespace-nowrap overflow-hidden text-ellipsis",
                            isActive
                              ? "text-[#0a0a0a] dark:text-grey-light-100"
                              : "text-[#606060] dark:text-grey-dark-600",
                          )}
                        >
                          {item.label}
                        </span>
                      )}
                    </div>
                  </button>
                </CustomTooltip2>
              );
            })}
          </div>
        </div>
      </div>

      <SidebarFooter collapsed={collapsed} />
    </div>
  );
};

export default SettingsSidebar;
