"use client";

import Image from "next/image";
import type { FC, ReactNode } from "react";

import PaymentBrandMarks from "@/components/ui/PaymentBrandMarks";
import { CoinsIcon } from "@/components/ui/icons";
import { openLinkByKey } from "@/app/lib/utils/links";
import { cn } from "@/lib/utils";

export type PaymentRail = "credits" | "card";

/**
 * The square control on each tile.
 *
 * Deliberately the same square the settings checkboxes draw
 * (`NotificationSection`'s `SquareCheck`): 18px, 5px radius, solid brand
 * fill when on and a flat grey when off, no border and no checkmark.
 * Selection controls should read identically everywhere, so this keeps the
 * app's square rather than the console's bordered-and-ticked one. The tile's
 * own border and tint are what make the choice unmistakable here.
 *
 * It is decorative: the real input is a visually hidden radio, so keyboard
 * and screen-reader users get a normal radio group.
 */
const Marker: FC<{ selected: boolean }> = ({ selected }) => (
  <span
    aria-hidden="true"
    className={cn(
      "block size-[18px] shrink-0 rounded-[5px] transition-colors",
      selected ? "bg-[#3167DD]" : "bg-[#F0F0F0] dark:bg-white/10",
    )}
  />
);

const StripeMark: FC = () => (
  // The Stripe mark, not a generic card glyph: this rail hands the user to
  // Stripe, and the logo says where they are about to land.
  <Image
    src="/stripe-mark.png"
    alt=""
    width={18}
    height={18}
    unoptimized
    className="size-[18px] shrink-0 rounded-[4.32px] object-cover"
  />
);

/** The balance, red when it will not cover the plan. */
const BalanceChip: FC<{ balance: number; short: boolean }> = ({
  balance,
  short,
}) => (
  <span
    className={cn(
      "shrink-0 rounded-md border px-1.5 text-xs font-medium leading-[18px] tracking-[-0.36px]",
      short
        ? "border-[#fc7d73]/40 bg-[#fc7d73]/15 text-[#d9564b] dark:text-[#fc7d73]"
        : "border-grey-light-500 bg-grey-light-600 text-grey-50 dark:border-black-300 dark:bg-black-300 dark:text-grey-dark-500",
    )}
  >
    {balance.toFixed(2)} available
  </span>
);

/**
 * Buying credits is not a desktop flow, so this leaves the app for the
 * console's add-credits view rather than pointing at an in-app route that
 * cannot complete the purchase.
 *
 * It renders OUTSIDE the tile's labels. A control nested in a `<label>`
 * takes that label's click too, so pressing it would also pick the credits
 * rail on the way out.
 */
const TopUpLink: FC = () => (
  <button
    type="button"
    onClick={() => void openLinkByKey("CREDITS")}
    className="whitespace-nowrap text-xs font-medium text-primary-50 underline underline-offset-2 dark:text-primary-brand-dark"
  >
    Top up
  </button>
);

/**
 * One rail as a tile. Two of these sit side by side, so the chooser is as
 * wide as the buttons under it and no wider: the earlier design ran each
 * rail as a full-width row, which only looked right when the dialog was
 * stretched to almost twice the width of every other dialog in the app.
 */
const Tile: FC<{
  value: PaymentRail;
  selected: boolean;
  icon: ReactNode;
  label: string;
  /** The second line: what this rail accepts, or what it has to spend. */
  detail: ReactNode;
  /** Interactive content for the second line, kept out of the labels. */
  action?: ReactNode;
  onSelect: (rail: PaymentRail) => void;
}> = ({ value, selected, icon, label, detail, action, onSelect }) => {
  const inputId = `drive-rail-${value}`;

  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-2.5 rounded-[9px] border p-3 transition-colors",
        selected
          ? "border-primary-50 bg-primary-50/[0.06] dark:border-primary-brand-dark dark:bg-primary-brand-dark/[0.08]"
          : "border-grey-dark-100 dark:border-black-300",
      )}
    >
      <input
        id={inputId}
        type="radio"
        name="drive-payment-rail"
        className="sr-only"
        checked={selected}
        onChange={() => onSelect(value)}
      />
      <label
        htmlFor={inputId}
        className="flex cursor-pointer items-center gap-2"
      >
        {icon}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-black-700 dark:text-grey-light-100">
          {label}
        </span>
        <Marker selected={selected} />
      </label>
      {/* Wraps so that on a narrow window the Top up link drops under the
          balance chip whole, instead of breaking mid-phrase beside it. The
          minimum height keeps both tiles level when one has no detail. */}
      <span className="flex min-h-[20px] flex-wrap items-center gap-x-2 gap-y-1">
        <label htmlFor={inputId} className="flex cursor-pointer items-center">
          {detail}
        </label>
        {action}
      </span>
    </div>
  );
};

/**
 * Choose how a subscription is paid for.
 *
 * Card is first and selected by default. It is the rail that works for
 * everyone: paying from credits needs a balance the account may not have,
 * and a new subscriber almost never does.
 *
 * Both rails can always be chosen. When the balance is short, choosing
 * credits shows the red balance and a Top up link, and the dialog's pay
 * button is disabled until the user tops up or switches to card. Refusing
 * the option outright hid the very thing the user needed: how far short
 * they are, and where to fix it.
 */
const PaymentMethodChoice: FC<{
  value: PaymentRail;
  creditsBalance: number | null;
  /** Credits cannot cover this plan. */
  creditsShort: boolean;
  onChange: (rail: PaymentRail) => void;
}> = ({ value, creditsBalance, creditsShort, onChange }) => {
  const shortAndSelected = value === "credits" && creditsShort;

  return (
    <div className="w-full text-left">
      <p className="mb-2.5 text-sm font-medium leading-5 text-[#4f4f4f] dark:text-grey-dark-700">
        Pay with
      </p>
      <div
        role="radiogroup"
        aria-label="Payment method"
        className="grid grid-cols-2 gap-2"
      >
        <Tile
          value="card"
          selected={value === "card"}
          onSelect={onChange}
          icon={<StripeMark />}
          label="Card"
          detail={<PaymentBrandMarks />}
        />
        <Tile
          value="credits"
          selected={value === "credits"}
          onSelect={onChange}
          icon={
            <CoinsIcon className="size-[18px] shrink-0 text-primary-50 dark:text-primary-brand-dark" />
          }
          label="Credits"
          detail={
            creditsBalance === null ? null : (
              <BalanceChip balance={creditsBalance} short={creditsShort} />
            )
          }
          action={
            creditsBalance !== null && creditsShort ? <TopUpLink /> : undefined
          }
        />
      </div>
      {/* One line under the tiles explains whichever rail is selected, so
          the tiles themselves stay two lines each. */}
      <p
        className={cn(
          "mt-2.5 text-xs leading-[18px]",
          shortAndSelected
            ? "text-[#d9564b] dark:text-[#fc7d73]"
            : "text-grey-50 dark:text-grey-dark-700",
        )}
      >
        {value === "credits"
          ? creditsShort
            ? "Not enough credits for this plan. Top up, or pay by card."
            : "Charged from your Hippius balance. 1 credit = $1."
          : "Checkout opens on Stripe and brings you back here. Your card is kept for renewals."}
      </p>
    </div>
  );
};

export default PaymentMethodChoice;
