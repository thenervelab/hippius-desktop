"use client";

import { useState } from "react";
import { useAtomValue } from "jotai";
import { HippiusBrandMark } from "@/components/ui/HippiusBrandMark";
import { sidebarCollapsedAtom } from "@/components/sidebar/sideBarAtoms";
import { cn } from "@/app/lib/utils";
import { titlebarClearanceClass } from "@/app/lib/utils/platformChrome";

// The Hippius brand mark in the top bar. The account menu (Update App /
// Settings / Sign out) now lives on the bottom-left profile row
// (`ProfileCard`), so this is purely a static, drag-region logo.
const TopBarLogoMenu = () => {
  const [isMac] = useState(() => {
    if (typeof navigator === "undefined") return false;
    const platform = (navigator.platform || "").toLowerCase();
    const ua = (navigator.userAgent || "").toLowerCase();
    return platform.includes("mac") || ua.includes("mac os");
  });
  const collapsed = useAtomValue(sidebarCollapsedAtom);

  return (
    <div
      data-tauri-drag-region
      className={cn(
        "flex items-center select-none h-full shrink-0 transition-[min-width] duration-300 ease-in-out",
        titlebarClearanceClass(isMac),
        collapsed ? "min-w-0" : "min-w-[243px]",
      )}
    >
      <div
        data-tauri-drag-region
        className="flex items-center gap-[8px] px-[4px] py-[5px]"
      >
        <HippiusBrandMark
          logoClassName="shrink-0"
          textClassName={cn(
            "overflow-hidden whitespace-nowrap transition-all duration-300 ease-in-out",
            collapsed
              ? "max-w-0 opacity-0 -ml-[8px]"
              : "max-w-[120px] opacity-100",
          )}
        />
      </div>
    </div>
  );
};

export default TopBarLogoMenu;
