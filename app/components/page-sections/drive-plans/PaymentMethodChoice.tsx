"use client";

import Image from "next/image";
import type { FC, ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { CoinsIcon } from "@/components/ui/icons";
import PaymentBrandMarks from "@/components/ui/PaymentBrandMarks";
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
  /** Brand marks shown just after the chip, e.g. the card networks. */
  marks?: ReactNode;
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
  marks,
  description,
  action,
  onSelect,
}) => {
  // Two labels drive one input (`htmlFor`), so the text AND the square both
  // select the rail while the action button between them stays independent.
  const inputId = `drive-rail-${value}`;
  // Only a rail that cannot be chosen is dimmed. Fading whatever is merely
  // unselected made the credits balance the faded number on the card, since
  // card is the default rail and credits is the row carrying the figure the
  // reader came to check. The tint on the selected row says which is which.
  const dim = disabled && "opacity-60";
  const cursor = disabled ? "cursor-not-allowed" : "cursor-pointer";

  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 px-2.5 py-3 transition-colors",
        // The row carries the selection, not only the marker. At 18px the
        // marker alone was the single thing on the card saying which rail
        // was about to be charged.
        selected && !disabled && "bg-primary-50/[0.06] dark:bg-primary-65/[0.08]",
      )}
    >
      <input
        id={inputId}
        type="radio"
        name="drive-payment-rail"
        className="sr-only"
        checked={selected}
        disabled={disabled}
        onChange={() => onSelect(value)}
      />
      {/* Wraps rather than squeezing the label: at 320px the credits row
          also carries a Top up button, which broke "Pay with credits"
          across three lines. */}
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
        <label
          htmlFor={inputId}
          className={cn("flex min-w-0 items-center gap-2", cursor, dim)}
        >
          {icon}
          <span className="whitespace-nowrap text-sm font-medium text-black-700 dark:text-grey-light-100">
            {label}
          </span>
          {chip}
          {/* Straight after the chip, which names the processor: the marks
              say what that processor accepts, so they belong beside it
              rather than across the row. Only where there is room, though;
              below `sm` they drop under the description instead. */}
          {marks ? (
            <span className="hidden shrink-0 items-center sm:flex">
              {marks}
            </span>
          ) : null}
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
          "block pl-[26px] text-sm font-medium text-grey-50 dark:text-grey-dark-700",
          cursor,
          dim,
        )}
      >
        {description}
      </label>
      {marks ? (
        <span className="flex pl-[26px] sm:hidden">{marks}</span>
      ) : null}
    </div>
  );
};

/**
 * Choose how a subscription is paid for.
 *
 * Card is listed first and selected by default. It is the rail that works
 * for everyone: paying from credits needs a balance the account may not
 * have, and a new subscriber almost never does, so leading with credits
 * opened the dialog on the option most people cannot use.
 *
 * Both rails are always listed; when the balance is short, credits is
 * disabled with the reason rather than removed, so nobody is left wondering
 * whether paying from credits exists.
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
      className="flex w-full flex-col divide-y divide-grey-dark-100 overflow-hidden rounded-[9px] border border-grey-dark-100 dark:divide-black-300 dark:border-black-300"
    >
      <Row
        value="card"
        selected={value === "card"}
        onSelect={onChange}
        icon={
          // The Stripe mark, not a generic card glyph: this row hands the
          // user to Stripe, and the logo is what tells them where they are
          // about to land.
          <Image
            src="/stripe-mark.png"
            alt=""
            width={18}
            height={18}
            unoptimized
            className="size-[18px] shrink-0 rounded-[4.32px] object-cover"
          />
        }
        label="Pay by card"
        chip={
          // Not the 40% black the credits chip used: at this size it faded
          // into the row in light mode, and this one names the processor.
          <span className="shrink-0 rounded-lg border border-grey-light-500 bg-grey-light-600 px-1.5 text-xs font-medium leading-[18px] tracking-[-0.36px] text-grey-50 dark:border-black-300 dark:bg-black-300 dark:text-grey-dark-500">
            Stripe
          </span>
        }
        marks={<PaymentBrandMarks />}
        description="Checkout opens on Stripe, then you come back here. Your card is kept on file for renewals."
      />
      <Row
        value="credits"
        selected={value === "credits"}
        disabled={creditsShort}
        onSelect={onChange}
        icon={
          <CoinsIcon className="size-[18px] shrink-0 text-primary-50 dark:text-primary-brand-dark" />
        }
        label="Pay with credits"
        chip={
          creditsBalance === null ? null : (
            <span
              className={cn(
                "shrink-0 rounded-lg border px-1.5 text-xs font-medium leading-[18px] tracking-[-0.36px]",
                creditsShort
                  ? "border-[#fc7d73]/40 bg-[#fc7d73]/15 text-[#d9564b] dark:text-[#fc7d73]"
                  : "border-grey-light-500 bg-grey-light-600 text-grey-50 dark:border-black-300 dark:bg-black-300 dark:text-grey-dark-500",
              )}
            >
              {/* "available" rather than "credits": the question at this
                  moment is whether the balance covers the plan. */}
              {creditsBalance.toFixed(2)} available
            </span>
          )
        }
        description={
          creditsShort
            ? "Not enough credits for this plan. Top up, or pay by card above."
            : "Charged from your Hippius balance. 1 credit = $1."
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
    </div>
  </div>
);

export default PaymentMethodChoice;
