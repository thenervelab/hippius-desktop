"use client";

import React from "react";

import { useStorageOverview } from "@/app/lib/hooks/api/useStorageOverview";
import { nextSkeletonState } from "@/lib/utils/skeletonGate";
import { cn } from "@/app/lib/utils";
import { CalendarNew } from "@/components/ui/icons";

import { getNextChargeView } from "./nextChargeState";

/**
 * What is leaving the balance, and when.
 *
 * Billing could say what the account HAS (the balance card beside this) and
 * what it could BUY (the plans below), but not what it is already committed
 * to. The amount and the date were on the wire the whole time and only ever
 * surfaced as a warning when the balance would not cover the renewal, so a
 * healthy account was told nothing about a charge it is signed up for.
 *
 * Same fetch as the storage card, so the two cannot quote different plans.
 */
const NextChargeCard: React.FC<{ className?: string }> = ({ className }) => {
  const { data: overview, isLoading, isError } = useStorageOverview();

  // Latch to the first settle, the storage card's rule: never flash "no
  // recurring charge" at an account whose plan is merely still loading.
  const settledRef = React.useRef(false);
  const gate = nextSkeletonState(settledRef.current, isLoading);
  settledRef.current = gate.settled;

  const view = getNextChargeView({
    showSkeleton: gate.showSkeleton,
    source: isError ? undefined : overview?.source,
    plan: overview?.plan,
  });

  return (
    <section
      className={cn(
        "flex w-full flex-col overflow-hidden rounded-[8px] border",
        "bg-grey-light-300 border-grey-dark-100",
        "dark:bg-black-primary-bg dark:border-black-300",
        "shadow-[0px_1px_1.1px_rgba(0,0,0,0.04)]",
        className,
      )}
    >
      <div className="flex h-[46px] w-full items-center gap-1 pl-[14px] pr-[10px]">
        <CalendarNew className="size-[14px] text-primary-40 dark:text-primary-brand-dark" />
        <p className="font-mono text-[12px] font-medium uppercase leading-[18px] tracking-[-0.24px] text-primary-40 dark:text-primary-brand-dark">
          Next charge
        </p>
      </div>

      {/* Inner panel: border-t + top corners only, the CreditsWidget
          pattern. A full border on both draws a doubled line. */}
      <div
        className={cn(
          "flex w-full flex-1 flex-col justify-between gap-4",
          "rounded-tl-[8px] rounded-tr-[8px] border-t border-grey-dark-100",
          "bg-white dark:bg-black-600 dark:border-black-300",
          "px-4 py-4",
        )}
      >
        {view.kind === "skeleton" && (
          <div className="flex flex-col gap-3">
            <div className="h-[30px] w-[140px] animate-pulse rounded bg-grey-light-700 dark:bg-grey-dark-200" />
            <div className="h-4 w-40 animate-pulse rounded bg-grey-light-700 dark:bg-grey-dark-200" />
          </div>
        )}

        {view.kind === "none" && (
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[24px] font-medium leading-[30px] tracking-[-0.96px] text-grey-10 dark:text-white">
              None
            </span>
            {/* The plans are directly below, so this states the fact and
                leaves the selling to them rather than adding a third
                button that goes where the page already goes. */}
            <span className="text-[12px] font-medium leading-[18px] text-grey-50 dark:text-grey-dark-500">
              No plan is charging this account.
            </span>
          </div>
        )}

        {view.kind === "charge" && (
          <>
            <div className="flex items-end justify-start gap-1">
              <span className="font-mono text-[24px] font-medium leading-[30px] tracking-[-0.96px] text-grey-10 dark:text-white">
                {view.amount}
              </span>
              <span className="pb-[3px] font-mono text-[12px] font-medium leading-[18px] tracking-[-0.48px] text-grey-10/50 dark:text-white/50">
                {view.cadence}
              </span>
            </div>

            <dl className="flex flex-col gap-2">
              <Row label="Plan">{view.planName}</Row>
              <Row label={view.whenText ? "Renews" : "Renewal"}>
                {/* A card plan renews itself and reports no countdown, so
                    the card says how it renews rather than inventing a
                    date the rail never gave. */}
                {view.whenText ?? "Automatic"}
              </Row>
              <Row label="Paid with">{view.fundingLabel}</Row>
            </dl>
          </>
        )}
      </div>
    </section>
  );
};

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({
  label,
  children,
}) => (
  <div className="flex items-center justify-between gap-3">
    <dt className="text-[12px] font-medium leading-[18px] text-grey-50 dark:text-grey-dark-500">
      {label}
    </dt>
    <dd className="min-w-0 truncate text-[12px] font-medium leading-[18px] text-grey-10 dark:text-white">
      {children}
    </dd>
  </div>
);

export default NextChargeCard;
