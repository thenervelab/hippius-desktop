"use client";

import type { FC } from "react";

import { Button } from "@/components/ui/button";
import { ArrowRight, Star } from "@/components/ui/icons";
import {
  formatPlanStorage,
  hasSharedTeamDrive,
  type DrivePlan,
} from "@/lib/types/drive-plans";
import { cn } from "@/lib/utils";

/** What the button on a card does, decided by the section and passed down. */
export type DrivePlanAction =
  "current" | "subscribe" | "upgrade" | "downgrade" | "cancel" | "none";

export interface DrivePlanCardProps {
  plan: DrivePlan;
  action: DrivePlanAction;
  isCurrent: boolean;
  isBusy: boolean;
  disabled?: boolean;
  /** Disables the action and says why, on hover. */
  disabledReason?: string;
  onAction: () => void;
}

const ACTION_LABEL: Record<DrivePlanAction, string> = {
  current: "Current Plan",
  subscribe: "Subscribe",
  upgrade: "Upgrade",
  downgrade: "Downgrade",
  cancel: "Cancel subscription",
  none: "Current Plan",
};

const BUSY_LABEL: Record<DrivePlanAction, string> = {
  current: "Current Plan",
  subscribe: "Subscribing…",
  upgrade: "Upgrading…",
  downgrade: "Downgrading…",
  cancel: "Cancelling…",
  none: "Current Plan",
};

/**
 * One plan as a card: a grey header strip with the name, a white body with
 * the price, what it holds, what it does, and one button.
 */
const DrivePlanCard: FC<DrivePlanCardProps> = ({
  plan,
  action,
  isCurrent,
  isBusy,
  disabled,
  disabledReason,
  onAction,
}) => {
  const isInert = action === "current" || action === "none";
  const isCancel = action === "cancel";
  const storage = formatPlanStorage(plan.storage_bytes);
  const features = [
    "Automatic renewal",
    ...(hasSharedTeamDrive(plan) ? ["Shared team drive"] : []),
    plan.is_free
      ? "Upgrade whenever you need more"
      : "Change or cancel anytime",
  ];

  return (
    <article
      aria-current={isCurrent ? "true" : undefined}
      className={cn(
        "flex min-w-0 flex-col overflow-hidden rounded-[8px] border border-grey-dark-100 bg-grey-light-300",
        "dark:border-black-300 dark:bg-black-primary-bg",
      )}
    >
      <div className="flex items-center gap-2 px-2 py-[8.84px]">
        <Star className="size-[18px] shrink-0 text-primary-50 dark:text-primary-brand-dark" />
        <p className="min-w-0 flex-1 truncate text-[14px] font-medium tracking-[-0.28px] text-black-700 dark:text-white">
          {plan.name}
        </p>
      </div>

      <div className="flex flex-1 flex-col justify-between gap-4 rounded-t-[8px] border border-grey-dark-100 bg-white py-3 dark:border-black-300 dark:bg-black-600">
        <div className="flex flex-col gap-4 px-2">
          <p className="flex items-center gap-1 font-mono text-[24px] font-medium leading-[30px] tracking-[-0.96px] text-[#111] dark:text-white">
            {plan.is_free ? "Free" : `$${plan.price_credits_monthly}`}
            {plan.is_free ? null : (
              <span className="text-[12px] tracking-[-0.48px] opacity-50">
                /Mo
              </span>
            )}
          </p>

          <div className="flex flex-col gap-1">
            <p className="text-[12px] font-medium leading-[17.68px] tracking-[-0.24px] text-grey-dark-600">
              {plan.is_free
                ? "No monthly charge"
                : `A charge of ${plan.price_credits_monthly} credits monthly`}
            </p>
            <p className="text-[12px] leading-[18px] tracking-[-0.36px]">
              <span className="font-bold text-primary-50 dark:text-primary-brand-dark">
                {storage}
              </span>
              <span className="font-medium text-black-900 dark:text-white">
                {" "}
                storage on Hippius
              </span>
            </p>
          </div>

          <div className="flex flex-col gap-1">
            <p className="font-mono text-[12px] font-medium uppercase leading-[19.45px] tracking-[-0.24px] text-grey-dark-800">
              Features
            </p>
            {features.map((line) => (
              <p key={line} className="flex items-center gap-2">
                <ArrowRight className="size-[14px] shrink-0 text-grey-dark-600" />
                <span className="min-w-0 text-[12px] font-medium leading-5 tracking-[-0.24px] text-black-900 dark:text-white">
                  {line}
                </span>
              </p>
            ))}
          </div>
        </div>

        <div className="px-2">
          <Button
            variant={
              action === "subscribe" || action === "upgrade"
                ? "primary"
                : "raised"
            }
            size="auto"
            className={cn(
              "h-[30px] w-full rounded-[6px] px-[10px] text-[14px] font-medium tracking-[-0.28px]",
              isCancel && "text-[#d9564b] dark:text-[#fc7d73]",
            )}
            title={disabledReason}
            onClick={onAction}
            disabled={isInert || isBusy || disabled || !!disabledReason}
          >
            {isBusy ? BUSY_LABEL[action] : ACTION_LABEL[action]}
          </Button>
        </div>
      </div>
    </article>
  );
};

export default DrivePlanCard;
