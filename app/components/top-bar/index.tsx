"use client";

import TopBarLogoMenu from "./TopBarLogoMenu";
import TopBarTitle from "./TopBarTitle";
import TopBarActions from "./TopBarActions";
import { cn } from "@/app/lib/utils";
import { TITLEBAR_BAND_H_54 } from "@/app/lib/utils/platformChrome";

const TopBar = () => {
  return (
    <header
      data-tauri-drag-region
      className={cn(
        "relative z-40 flex items-center justify-between w-full select-none shrink-0 bg-transparent",
        TITLEBAR_BAND_H_54,
      )}
    >
      <div className="flex items-center" data-tauri-drag-region>
        <TopBarLogoMenu />
        <div className="flex items-center pl-[20px]">
          <TopBarTitle />
        </div>
      </div>
      <div className="flex items-center pr-[16px]">
        <TopBarActions />
      </div>
    </header>
  );
};

export default TopBar;
