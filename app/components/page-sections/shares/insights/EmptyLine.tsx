"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { MUTED } from "./panelStyles";

/**
 * A tab with nothing in it yet: one short line under a small muted icon,
 * centred in the tab ("No views yet", "No comments yet", "No reactions yet").
 */
export function EmptyLine({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <div className={cn("flex flex-col items-center gap-1.5 py-8 text-center", MUTED)}>
      <span aria-hidden className="[&>svg]:size-[22px] [&>svg]:stroke-[1.8]">
        {icon}
      </span>
      <p className="text-[13px]">{text}</p>
    </div>
  );
}
