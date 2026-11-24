"use client";

import { List } from "lucide-react";

import { Icons } from "@/components/ui";
import { cn } from "@/lib/utils";

export type ViewMode = "list" | "card";

const VIEW_TOGGLE_BUTTON_BASE =
  "flex items-center justify-center size-6 rounded-[3px] transition-opacity";

const VIEW_TOGGLE_ACTIVE = cn(
  "bg-grey-light-300 border border-grey-dark-100",
  "shadow-[0px_5px_2.3px_0px_rgba(0,0,0,0.03),0px_1px_1.9px_0px_rgba(0,0,0,0.14),0px_0px_1px_0px_rgba(0,0,0,0.16)]",
  "dark:bg-black-primary-bg dark:border-black-300",
);

const VIEW_TOGGLE_INACTIVE = "opacity-50 hover:opacity-75";

/** List or cards: the Drive's own switch, on every page that shows its rows. */
export default function ViewModeToggle({
  viewMode,
  setViewMode,
}: {
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
}) {
  return (
    <div className="flex items-start gap-1 p-[3px] rounded-[6px] bg-grey-primary-bg dark:bg-black-600">
      <button
        className={cn(VIEW_TOGGLE_BUTTON_BASE, viewMode === "list" ? VIEW_TOGGLE_ACTIVE : VIEW_TOGGLE_INACTIVE)}
        onClick={() => setViewMode("list")}
        aria-label="List View"
      >
        <List className="size-3 text-black-700 dark:text-white" />
      </button>
      <button
        className={cn(VIEW_TOGGLE_BUTTON_BASE, viewMode === "card" ? VIEW_TOGGLE_ACTIVE : VIEW_TOGGLE_INACTIVE)}
        onClick={() => setViewMode("card")}
        aria-label="Card View"
      >
        <Icons.Category className="size-3 text-black-700 dark:text-white" />
      </button>
    </div>
  );
}
