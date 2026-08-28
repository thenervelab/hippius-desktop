import React, { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The one row/cell trigger that opens the unified viewer.
 *
 * There used to be three byte-identical `*DialogTrigger` components (image,
 * video, PDF) whose only difference was which dialog the call site then chose
 * to mount. Selection now lives in `UnifiedMediaDialog`, so the trigger is
 * type-agnostic and adding a format needs no change here at all.
 *
 * The hover affordance (eye / play icon) lives inside `NameCell` and reveals
 * via this button's `group` class — an absolute overlay here would fade in on
 * top of the Pending/Failed status pills.
 */
const PreviewTrigger: React.FC<{
  children: ReactNode;
  onClick: () => void;
  className?: string;
}> = ({ children, onClick, className }) => (
  <button
    type="button"
    onClick={onClick}
    className={cn(
      "relative group overflow-hidden flex items-center w-full px-2 py-[5px]",
      className,
    )}
  >
    <span className="flex-1 min-w-0">{children}</span>
  </button>
);

export default PreviewTrigger;
