"use client";

import React from "react";
import { AlertTriangle } from "lucide-react";

import { useStorageOverview } from "@/app/lib/hooks/api/useStorageOverview";
import { cn } from "@/app/lib/utils";

import { getPlanActionNote } from "./planActionView";

/**
 * The "your credits will not cover the renewal" strip.
 *
 * The header says the same thing in one line beside the Top up Credits
 * button; this is the roomier version for a page where the user has come
 * to deal with billing. Both read the sentence from `getPlanActionNote`,
 * so the two cannot describe the same account differently — and neither
 * decides anything: whether the balance is short is settled in Rust.
 *
 * Renders nothing when there is nothing to say, so a call site can mount
 * it unconditionally.
 */
const PlanRenewalNotice: React.FC<{ className?: string }> = ({ className }) => {
  const { data: overview } = useStorageOverview();
  const note = getPlanActionNote(overview?.planAction, overview?.plan?.renewsInDays);

  if (!note) return null;

  return (
    <div
      role="status"
      className={cn(
        "mb-3 flex items-start gap-2 rounded-[8px] border px-3 py-2.5",
        "border-warning-50/40 bg-warning-50/10",
        className,
      )}
    >
      <AlertTriangle
        className="mt-[1px] size-4 shrink-0 text-warning-40 dark:text-warning-50"
        aria-hidden="true"
      />
      <p className="text-[13px] font-medium leading-[18px] tracking-[-0.26px] text-warning-40 dark:text-warning-50">
        {note}.{" "}
        <span className="font-normal text-grey-10 dark:text-white/70">
          Top up your credits to keep it running.
        </span>
      </p>
    </div>
  );
};

export default PlanRenewalNotice;
