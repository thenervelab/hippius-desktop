"use client";

import Image from "next/image";
import type { FC, ReactNode } from "react";

import { CoinsIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

export type PaymentRail = "credits" | "card";

/** Decorative square; the real input is the visually hidden radio. */
const Marker: FC<{ selected: boolean; disabled?: boolean }> = ({
  selected,
  disabled,
}) => (
  <span
    aria-hidden="true"
    className={cn(
      "flex size-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-colors",
      selected
        ? "border-primary-50 bg-primary-50 dark:border-primary-brand-dark dark:bg-primary-brand-dark"
        : "border-grey-dark-100 bg-grey-light-800 dark:border-black-300 dark:bg-black-300",
      disabled && "opacity-50",
    )}
  >
    {selected ? (
      <span className="size-1.5 rounded-[2px] bg-white dark:bg-black-600" />
    ) : null}
  </span>
);

const Row: FC<{
  value: PaymentRail;
  selected: boolean;
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  chip?: ReactNode;
  description: ReactNode;
  onSelect: (rail: PaymentRail) => void;
}> = ({
  value,
  selected,
  disabled,
  icon,
  label,
  chip,
  description,
  onSelect,
}) => (
  <label
    className={cn(
      "flex flex-col gap-1.5 px-2.5 py-3",
      disabled ? "cursor-not-allowed" : "cursor-pointer",
      // The design dims a rail that is not the chosen one.
      !selected && "opacity-60",
    )}
  >
    <span className="flex items-center justify-between gap-2">
      <span className="flex min-w-0 items-center gap-2">
        <input
          type="radio"
          name="drive-payment-rail"
          className="sr-only"
          checked={selected}
          disabled={disabled}
          onChange={() => onSelect(value)}
        />
        {icon}
        <span className="text-sm font-medium text-black-700 dark:text-grey-light-100">
          {label}
        </span>
        {chip}
      </span>
      <Marker selected={selected} disabled={disabled} />
    </span>
    <span className="block pl-[26px] text-sm font-medium text-black-700/40 dark:text-grey-dark-700">
      {description}
    </span>
  </label>
);

/**
 * Choose how a subscription is paid for. Both rails are always listed; when
 * the balance is short, credits is disabled with the reason rather than
 * removed, so nobody is left wondering whether paying from credits exists.
 */
const PaymentMethodChoice: FC<{
  value: PaymentRail;
  creditsBalance: number | null;
  creditsShort: boolean;
  onChange: (rail: PaymentRail) => void;
}> = ({ value, creditsBalance, creditsShort, onChange }) => (
  <div className="w-full text-left">
    <p className="mb-2.5 text-base font-medium leading-[22px] tracking-[-0.32px] text-[#4f4f4f] dark:text-grey-dark-700">
      Select payment method
    </p>
    <div
      role="radiogroup"
      aria-label="Payment method"
      className="flex w-full flex-col rounded-[9px] border border-grey-dark-100 dark:border-black-300"
    >
      <Row
        value="credits"
        selected={value === "credits"}
        disabled={creditsShort}
        onSelect={onChange}
        icon={
          <CoinsIcon className="size-[18px] shrink-0 text-primary-50 dark:text-primary-brand-dark" />
        }
        label="Credits"
        chip={
          creditsBalance === null ? null : (
            <span
              className={cn(
                "shrink-0 rounded-lg border px-1.5 text-xs font-medium leading-[18px] tracking-[-0.36px]",
                creditsShort
                  ? "border-[#fc7d73]/40 bg-[#fc7d73]/15 text-[#d9564b] dark:text-[#fc7d73]"
                  : "border-grey-light-500 bg-grey-light-600 text-black-700/40 dark:border-black-300 dark:bg-black-300 dark:text-grey-dark-700",
              )}
            >
              {creditsBalance.toFixed(2)} credits
            </span>
          )
        }
        description={
          creditsShort
            ? `Not enough credits to cover this plan. You have ${(creditsBalance ?? 0).toFixed(2)}.`
            : "Use credits to pay for subscription. $1 = 1 credit"
        }
      />
      <Row
        value="card"
        selected={value === "card"}
        onSelect={onChange}
        icon={
          <Image
            src="/stripe-mark.png"
            alt=""
            width={18}
            height={18}
            unoptimized
            className="size-[18px] shrink-0 rounded-[4.32px] object-cover"
          />
        }
        label="Stripe"
        description="This link opens a third-party website or app. We don't control its content, availability, or privacy practices, and we're not responsible for any information or services provided there."
      />
    </div>
  </div>
);

export default PaymentMethodChoice;
