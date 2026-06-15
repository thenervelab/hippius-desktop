"use client";

import { useEffect, useState } from "react";
import { HippiusBrandMark } from "@/components/ui/HippiusBrandMark";
import { cn } from "@/app/lib/utils";
import {
  TITLEBAR_BAND_H_44,
  titlebarClearanceClass,
} from "@/app/lib/utils/platformChrome";

const AuthTitleBar = () => {
  const [isMac, setIsMac] = useState(false);

  useEffect(() => {
    if (typeof navigator === "undefined") return;
    const platform = (navigator.platform || "").toLowerCase();
    const ua = (navigator.userAgent || "").toLowerCase();
    setIsMac(platform.includes("mac") || ua.includes("mac os"));
  }, []);

  return (
    <div
      data-tauri-drag-region
      className={cn(
        "relative z-10 flex items-center w-full select-none shrink-0",
        TITLEBAR_BAND_H_44,
        titlebarClearanceClass(isMac),
      )}
    >
      <div className="flex items-center gap-[8px] px-[4px] py-[5px] rounded-[9px] pointer-events-none">
        <HippiusBrandMark />
      </div>
    </div>
  );
};

export default AuthTitleBar;
