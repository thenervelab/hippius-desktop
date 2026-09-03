"use client";

import type { FC } from "react";

import { Button } from "@/components/ui/button";
import { FramedDialog } from "@/components/ui/FramedDialog";
import { ArrowRight, CoinsIcon } from "@/components/ui/icons";
import {
  chargeAmount,
  formatPlanStorage,
  type DrivePlan,
} from "@/lib/types/drive-plans";

import type { DrivePlanAction } from "./DrivePlanCard";
import PaymentMethodChoice, { type PaymentRail } from "./PaymentMethodChoice";

/**
 * Confirm a subscribe, upgrade or downgrade. Only a subscribe carries the
 * payment chooser; a plan change is a chain write on the existing
 * subscription and stays on the balance.
 */
const DriveSubscribeDialog: FC<{
  open: boolean;
  plan: DrivePlan | null;
  action: DrivePlanAction | null;
  rail: PaymentRail;
  onRailChange: (rail: PaymentRail) => void;
  credits: number | null;
  creditsShort: boolean;
  isWriting: boolean;
  onConfirm: () => void;
  onClose: () => void;
}> = ({
  open,
  plan,
  action,
  rail,
  onRailChange,
  credits,
  creditsShort,
  isWriting,
  onConfirm,
  onClose,
}) => {
  if (!plan || !action) return null;
  const isSubscribe = action === "subscribe";
  const lead =
    action === "downgrade"
      ? "You're about to move down to"
      : action === "upgrade"
        ? "You're about to move up to"
        : "You're about to subscribe to";

  return (
    <FramedDialog
      open={open}
      onClose={() => !isWriting && onClose()}
      preventClose={isWriting}
      title={
        <>
          <span className="block text-black-700/50 dark:text-grey-dark-700">
            {lead}
          </span>
          <span className="block">
            {plan.name} Plan at ${chargeAmount(plan, "monthly")}
            <span className="text-black-700/50 dark:text-grey-dark-700">
              /mo
            </span>
          </span>
        </>
      }
      icon={<CoinsIcon className="size-[18px] text-white" />}
      maxWidth={isSubscribe ? "max-w-[680px]" : "max-w-[560px]"}
      contentClassName={isSubscribe ? "sm:w-[600px]" : undefined}
    >
      <div className="flex flex-col gap-[18px] font-geist">
        {isSubscribe ? (
          <PaymentMethodChoice
            value={rail}
            creditsBalance={credits}
            creditsShort={creditsShort}
            onChange={onRailChange}
          />
        ) : (
          <p className="text-center text-base font-medium leading-[22px] tracking-[-0.32px] text-[#4f4f4f] dark:text-grey-dark-700">
            {chargeAmount(plan, "monthly")} credits for the first month, and the
            plan gives you {formatPlanStorage(plan.storage_bytes)} of storage.
            {action === "downgrade"
              ? " A downgrade is refused if you are already storing more than the smaller plan holds."
              : ""}
          </p>
        )}
        <Button
          variant="primary"
          className="h-[52px] w-full text-[18px] font-normal tracking-[-0.36px]"
          onClick={onConfirm}
          disabled={isWriting}
        >
          {isWriting ? "Working…" : isSubscribe ? "Make Payment" : "Confirm"}
          <ArrowRight className="ml-2.5 size-4" />
        </Button>
        <Button
          variant="raised"
          className="h-[52px] w-full text-[18px] font-normal tracking-[-0.36px]"
          onClick={onClose}
          disabled={isWriting}
        >
          Cancel
        </Button>
      </div>
    </FramedDialog>
  );
};

export default DriveSubscribeDialog;
