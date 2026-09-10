"use client";

import React from "react";

import { Button } from "@/components/ui";
import { PricingCard } from "@/components/ui/icons";
import { useStorageOverview } from "@/app/lib/hooks/api/useStorageOverview";
import { cn } from "@/app/lib/utils";

import { getPlanActionView } from "./planActionView";

/**
 * The header's plan call to action, beside {@link PlanChip}.
 *
 * Replaces the two hardcoded buttons that used to sit here — an
 * unconditional "+ Top up Credits" on the home header and an
 * unconditional "Subscription Plans" on the Files header. Both were wrong
 * for half the accounts that saw them: credits buy no Drive storage, so
 * offering a top-up to someone on the free tier pointed at a flow that
 * cannot give them more room, and a subscribed account was still being
 * sold a plan it already had.
 *
 * What to offer is decided once in Rust (`planAction`), so this and the
 * storage card cannot disagree about whether an account needs anything.
 */
const PlanActionButton: React.FC<{
  variant?: "raised" | "subtle";
  className?: string;
}> = ({ variant = "subtle", className }) => {
  const { data: overview } = useStorageOverview();
  const view = getPlanActionView(overview?.planAction);

  if (!view) return null;

  // Filled brand, on BOTH shapes. This button is the page's answer to a
  // problem the page has just stated — no plan, or a balance that will
  // not cover the next renewal — and it was previously drawn as a white
  // or grey pill, the same weight as "Shared Links" and "View All Files"
  // sitting a row below it. A call to action that looks like navigation
  // gets read as navigation. `variant` now chooses only the SHAPE: the
  // roomier header slot, or the tighter chip-height one.
  return (
    <Button
      asLink
      href={view.href}
      variant="primary"
      size="auto"
      className={cn(
        variant === "raised"
          ? "flex items-center gap-2 px-4 py-2 text-[14px] font-medium leading-[1.109] tracking-[-0.28px]"
          : "h-[33px] rounded-[7px] px-[14px] text-[14px] font-medium tracking-[-0.28px]",
        className,
      )}
    >
      {view.withPlanIcon && variant === "raised" && <PricingCard className="size-4" />}
      {view.label}
    </Button>
  );
};

export default PlanActionButton;
