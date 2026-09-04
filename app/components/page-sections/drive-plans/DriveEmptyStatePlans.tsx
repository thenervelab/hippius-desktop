"use client";

import type { FC } from "react";
import { useRouter } from "next/navigation";

import useDrivePlans from "@/lib/hooks/api/useDrivePlans";
import { useDriveSubscription } from "@/lib/hooks/api/useDriveSubscription";
import { currentPlanCode } from "@/lib/types/drive-plans";
import { cn } from "@/lib/utils";

import DrivePlansGrid from "./DrivePlansGrid";

/**
 * The storage plans, offered under an empty Drive.
 *
 * Shown only to someone with neither files nor a plan: with nothing in the
 * drive there is nothing else on the page, and picking a plan is the most
 * useful next step. Each card sends the user to the plans page with the
 * plan preselected, so the confirm and processing flow lives in one place.
 */
const DriveEmptyStatePlans: FC<{ className?: string }> = ({ className }) => {
  const router = useRouter();
  const { data: plans } = useDrivePlans();
  const { data: subscription } = useDriveSubscription();

  // Wait for both reads: a flash of plans at a subscriber is worse than a
  // short delay for a new account.
  if (!plans || plans.length === 0 || subscription === undefined) return null;
  if (subscription.active) return null;

  return (
    <section className={cn("flex flex-col gap-3", className)}>
      <div className="flex flex-col gap-0.5">
        <h2 className="text-[16px] font-medium text-black-700 dark:text-white">
          Pick a storage plan
        </h2>
        <p className="text-[12px] font-medium text-grey-dark-600">
          You are on the Free plan. Pick a larger one for more encrypted
          storage, and change or cancel it at any time.
        </p>
      </div>
      <DrivePlansGrid
        plans={plans}
        currentCode={currentPlanCode(subscription)}
        actionFor={(plan) => (plan.is_free ? "none" : "subscribe")}
        onAction={(plan) => router.push(`/drive-plans?plan=${plan.code}`)}
      />
    </section>
  );
};

export default DriveEmptyStatePlans;
