"use client";

import React from "react";

import { useStorageOverview } from "@/app/lib/hooks/api/useStorageOverview";
import { cn } from "@/app/lib/utils";

import PlanChip from "./index";
import PlanActionButton from "./PlanActionButton";
import { getPlanActionView } from "./planActionView";

/**
 * The header's plan card: which plan the account is on, how full it is,
 * and the one thing it might need to do about that.
 *
 * The same two children the home header composes ({@link PlanChip} +
 * {@link PlanActionButton}) in the same bordered box, extracted so a page
 * that wants the card does not restate its chrome. The Drive page had the
 * alternative for a while — a standing "Subscription Plans" button — which
 * sold a plan to accounts that already had one and said nothing about how
 * much room was left.
 *
 * Unlike the stats card in `ui/page-header`, this renders at EVERY width:
 * it is the Drive page's only header card, so an `xl`-only card would
 * leave that page with no plan surface at all on a smaller window.
 */
const PlanSummaryCard: React.FC<{ className?: string }> = ({ className }) => {
  const { data: overview } = useStorageOverview();

  // The action column is dropped entirely when Rust offers nothing, rather
  // than left as an empty padded cell — a healthy plan should read as a
  // finished card, not as one with a button missing.
  const hasAction = getPlanActionView(overview?.planAction) !== null;

  return (
    <div
      className={cn(
        "flex w-fit items-stretch rounded-[8px] border",
        "border-grey-light-500 bg-grey-light-600",
        "dark:border-black-300 dark:bg-black-primary-bg",
        className,
      )}
    >
      <div
        className={cn(
          "flex flex-col justify-center py-[11px] pl-5",
          hasAction ? "pr-4" : "pr-5",
        )}
      >
        <PlanChip />
      </div>
      {hasAction && (
        <div className="flex shrink-0 items-center py-[11px] pr-3.5">
          <PlanActionButton />
        </div>
      )}
    </div>
  );
};

export default PlanSummaryCard;
