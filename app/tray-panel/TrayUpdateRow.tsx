"use client";

import { ArrowDownCircle } from "lucide-react";

/**
 * "Update available" in the tray popover, when Rust found a newer version this
 * run (`update_available_version`). The update dialog opens in the main window,
 * which a copy left running is usually not looking at, so the popover says it
 * too. Clicking brings the main window forward with the dialog
 * (`open_update_from_tray`).
 */
export default function TrayUpdateRow({
  version,
  onOpen,
}: {
  version: string | null;
  onOpen: () => void;
}) {
  if (!version) return null;
  return (
    <div className="px-5 pt-3">
      <button
        type="button"
        onClick={onOpen}
        data-testid="tray-update-row"
        className="flex w-full min-w-0 items-center gap-2.5 rounded-lg bg-[rgba(49,103,221,0.08)] px-3 py-2 text-left transition-colors hover:bg-[rgba(49,103,221,0.14)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3167DD]/40"
      >
        <ArrowDownCircle className="size-4 shrink-0 text-[#3167DD]" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-geist text-[13px] text-grey-10 dark:text-white">
          Hippius {version} is ready to install
        </span>
        <span className="shrink-0 font-geist text-[12px] font-medium text-[#3167DD]">Update</span>
      </button>
    </div>
  );
}
