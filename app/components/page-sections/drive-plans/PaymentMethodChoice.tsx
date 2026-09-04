"use client";

import Image from "next/image";
import type { FC, ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { CoinsIcon } from "@/components/ui/icons";
import { openLinkByKey } from "@/app/lib/utils/links";
import { cn } from "@/lib/utils";

export type PaymentRail = "credits" | "card";

/**
 * Decorative square; the real input is the visually hidden radio.
 *
 * Deliberately the same square the settings checkboxes draw
 * (`NotificationSection`'s `SquareCheck`): 18px, 5px radius, solid brand
 * fill when on and a flat grey when off — no border, no checkmark, no
 * inner dot. Selection controls should read identically everywhere.
 */
const Marker: FC<{ selected: boolean; disabled?: boolean }> = ({
  selected,
  disabled,
}) => (
  <span
    aria-hidden="true"
    className={cn(
      "block size-[18px] shrink-0 rounded-[5px] transition-colors",
      selected ? "bg-[#3167DD]" : "bg-[#F0F0F0] dark:bg-white/10",
      disabled && "opacity-50",
    )}
  />
);

const Row: FC<{
  value: PaymentRail;
  selected: boolean;
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  chip?: ReactNode;
  description: ReactNode;
  /**
   * Sits in the header row, left of the square, and is NOT inside a label —
   * a button nested in one would pick the rail on its way out.
   */
  action?: ReactNode;
  onSelect: (rail: PaymentRail) => void;
}> = ({
  value,
  selected,
  disabled,
  icon,
  label,
  chip,
  description,
  action,
  onSelect,
}) => {
  // Two labels drive one input (`htmlFor`), so the text AND the square both
  // select the rail while the action button between them stays independent.
  const inputId = `drive-rail-${value}`;
  const dim = !selected && "opacity-60";
  const cursor = disabled ? "cursor-not-allowed" : "cursor-pointer";

  return (
    <div className="flex flex-col gap-1.5 px-2.5 py-3">
      <input
        id={inputId}
        type="radio"
        name="drive-payment-rail"
        className="sr-only"
        checked={selected}
        disabled={disabled}
        onChange={() => onSelect(value)}
      />
      <div className="flex items-center justify-between gap-2">
        <label
          htmlFor={inputId}
          className={cn("flex min-w-0 items-center gap-2", cursor, dim)}
        >
          {icon}
          <span className="text-sm font-medium text-black-700 dark:text-grey-light-100">
            {label}
          </span>
          {chip}
        </label>
        <div className="flex shrink-0 items-center gap-2">
          {action}
          <label htmlFor={inputId} className={cn("flex", cursor)}>
            <Marker selected={selected} disabled={disabled} />
          </label>
        </div>
      </div>
      <label
        htmlFor={inputId}
        className={cn(
          "block pl-[26px] text-sm font-medium text-black-700/40 dark:text-grey-dark-700",
          cursor,
          dim,
        )}
      >
        {description}
      </label>
    </div>
  );
};

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
        action={
          // Buying credits is not a desktop flow, so this deliberately
          // leaves the app for the console's billing page (its add-credits
          // view) rather than pointing at an in-app route that cannot
          // complete the purchase.
          <Button
            variant="defaultStable"
            size="auto"
            onClick={() => void openLinkByKey("CREDITS")}
            className="h-[30px] shrink-0 whitespace-nowrap rounded-[6px] px-3 text-sm font-medium tracking-[-0.28px]"
          >
            + Top up Credits
          </Button>
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
