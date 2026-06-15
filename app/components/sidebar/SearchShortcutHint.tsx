"use client";

import { FC, useState } from "react";
import cn from "@/app/lib/utils/cn";
import Command from "../ui/icons/Command";
import { isMacPlatform } from "@/app/lib/utils/isMacPlatform";

/**
 * The "open search" keyboard hint. macOS shows the ⌘ glyph (the only place it
 * reads naturally); Windows/Linux show a "Ctrl" label instead. Both the
 * sidebar trigger and the open palette's input render this, so the hint stays
 * consistent across surfaces.
 *
 * Platform detection runs once, synchronously, via a lazy `useState` so the
 * correct hint paints on first render (no async flash) — matching the
 * title-bar components' approach. It is presentation-only: the ⌘/Ctrl
 * shortcut handlers accept both modifiers regardless of what we show.
 */
const SearchShortcutHint: FC<{ className?: string }> = ({ className }) => {
  const [isMac] = useState(isMacPlatform);

  return (
    <span
      className={cn(
        "flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-[#1111114D] dark:text-white/30",
        className,
      )}
    >
      {isMac ? (
        <Command className="size-3.5" strokeWidth={1.5} />
      ) : (
        <span>Ctrl</span>
      )}
      <span>F</span>
    </span>
  );
};

export default SearchShortcutHint;
