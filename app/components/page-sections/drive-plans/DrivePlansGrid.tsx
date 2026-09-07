"use client";

import type { FC } from "react";

import type { DrivePlan } from "@/lib/types/drive-plans";
import { cn } from "@/lib/utils";

import DrivePlanCard, { type DrivePlanAction } from "./DrivePlanCard";

/**
 * The row of plan cards, shared by the plans page and the empty Drive so
 * the two surfaces cannot draw the same plans two different ways. Wraps to
 * as many columns as fit at the card's minimum width.
 */
const DrivePlansGrid: FC<{
  plans: DrivePlan[];
  actionFor: (plan: DrivePlan) => DrivePlanAction;
  disabledReasonFor?: (
    plan: DrivePlan,
    action: DrivePlanAction,
  ) => string | undefined;
  busyPlanCode?: string | null;
  disabled?: boolean;
  currentCode: string;
  onAction: (plan: DrivePlan, action: DrivePlanAction) => void;
  className?: string;
}> = ({
  plans,
  actionFor,
  disabledReasonFor,
  busyPlanCode,
  disabled,
  currentCode,
  onAction,
  className,
}) => (
  <div
    className={cn(
      "grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))]",
      className,
    )}
  >
    {plans.map((plan) => {
      const action = actionFor(plan);
      return (
        <DrivePlanCard
          key={plan.code}
          plan={plan}
          action={action}
          isCurrent={plan.code === currentCode}
          isBusy={busyPlanCode === plan.code}
          disabled={disabled && busyPlanCode !== plan.code}
          disabledReason={disabledReasonFor?.(plan, action)}
          onAction={() => onAction(plan, action)}
        />
      );
    })}
  </div>
);

export default DrivePlansGrid;
