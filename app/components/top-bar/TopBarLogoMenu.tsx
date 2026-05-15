"use client";

import { useState } from "react";
import { useAtomValue } from "jotai";
import { useRouter } from "next/navigation";
import {
  HippiusLogo,
  ChevronDown,
  Setting,
  Logout,
  TrendUp,
} from "@/components/ui/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { sidebarCollapsedAtom } from "@/components/sidebar/sideBarAtoms";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { cn } from "@/app/lib/utils";
import {
  updateDialogOpenAtom,
  updateStore,
} from "@/app/components/updater/updateStore";

const TopBarLogoMenu = () => {
  const [isMac] = useState(() => {
    if (typeof navigator === "undefined") return false;
    const platform = (navigator.platform || "").toLowerCase();
    const ua = (navigator.userAgent || "").toLowerCase();
    return platform.includes("mac") || ua.includes("mac os");
  });
  const collapsed = useAtomValue(sidebarCollapsedAtom);
  const router = useRouter();
  const { logout } = useWalletAuth();

  const handleOpenSettings = () => {
    router.push("/settings?section=sync");
  };

  // Manual "Check for Updates" — route through the same store atom the
  // auto-trigger uses. UpdateDialogWrapper (mounted in UpdateChecker)
  // observes the atom and renders the unified dialog. The dialog runs
  // tauri's check() itself on open and handles all six states.
  const handleOpenUpdate = () => {
    updateStore.set(updateDialogOpenAtom, true);
  };

  const handleSignOut = () => {
    void logout();
  };

  return (
    <div
      data-tauri-drag-region
      className={cn(
        "flex items-center select-none h-full shrink-0 transition-[min-width] duration-300 ease-in-out",
        isMac ? "pl-[80px]" : "pl-[12px]",
        collapsed ? "min-w-0" : "min-w-[243px]",
      )}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Open Hippius menu"
            title="Hippius"
            className={cn(
              "flex items-center gap-[8px] px-[4px] py-[5px] rounded-[9px]",
              "transition-colors duration-150",
              "hover:bg-white/30 data-[state=open]:bg-white/30",
              "dark:hover:bg-white/10 dark:data-[state=open]:bg-white/10",
            )}
          >
            <HippiusLogo className="size-[28px] shrink-0 text-primary-50" />
            <span
              className={cn(
                "font-[557] text-[18px] leading-[18px] text-primary-50 tracking-[0px]",
                "overflow-hidden whitespace-nowrap transition-all duration-300 ease-in-out",
                collapsed
                  ? "max-w-0 opacity-0 -ml-[8px]"
                  : "max-w-[120px] opacity-100",
              )}
            >
              Hippius
            </span>
            <span className="flex items-center justify-center w-[25px] h-[24px] shrink-0">
              <ChevronDown className="size-[12px] text-black-700/60 dark:text-grey-light-300/60" />
            </span>
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuContent
          align="start"
          side="bottom"
          sideOffset={8}
          className={cn(
            "w-[222px] rounded-[8px] border border-grey-dark-100 bg-white p-1 z-[1100]",
            "shadow-[0_4px_24px_0_rgba(0,0,0,0.08)]",
            "dark:border-[#313131] dark:bg-[#161616]",
          )}
        >
          <DropdownMenuItem
            onSelect={handleOpenUpdate}
            className={cn(
              "h-8 rounded-[8px] px-3 py-1.5 gap-2",
              "text-[14px] font-medium leading-4 tracking-[-0.4px]",
              "text-[#52525c] hover:!text-grey-10 hover:!bg-grey-light-700",
              "dark:text-[#a3a3a3] dark:hover:!text-white dark:hover:!bg-[#2c2c2c]",
            )}
          >
            <TrendUp className="size-4 shrink-0" />
            <span>Update App</span>
          </DropdownMenuItem>

          <DropdownMenuItem
            onSelect={handleOpenSettings}
            className={cn(
              "h-8 rounded-[8px] px-3 py-1.5 gap-2",
              "text-[14px] font-medium leading-4 tracking-[-0.4px]",
              "text-[#52525c] hover:!text-grey-10 hover:!bg-grey-light-700",
              "dark:text-[#a3a3a3] dark:hover:!text-white dark:hover:!bg-[#2c2c2c]",
            )}
          >
            <Setting className="size-4 shrink-0" />
            <span>Settings</span>
          </DropdownMenuItem>

          <DropdownMenuItem
            onSelect={handleSignOut}
            className={cn(
              "h-8 rounded-[8px] px-3 py-1.5 gap-2",
              "text-[14px] font-medium leading-4 tracking-[-0.4px]",
              "!text-[#fc7d73] hover:!text-[#fc7d73] hover:!bg-grey-light-700",
              "dark:hover:!bg-[#2c2c2c]",
            )}
          >
            <Logout className="size-4 shrink-0" />
            <span>Sign out</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};

export default TopBarLogoMenu;
