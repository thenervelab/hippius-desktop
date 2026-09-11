"use client";

import React from "react";

import { useStorageOverview } from "@/app/lib/hooks/api/useStorageOverview";
import { StatusBanner } from "@/app/components/page-sections/drive/service-status/DriveStatusBanner";

import { getRenewalNotice } from "./planActionView";

/**
 * The "your credits will not cover the next renewal" card.
 *
 * Red, and the same frame as the cancelled-plan banner, because it is the
 * same class of thing: the plan is going to stop unless the user does
 * something. It was an amber strip carrying the header's one-liner —
 * "Low credits. Your plan renews in 22 days" — which states a fact and a
 * date without saying what happens, what it costs, or how short the
 * balance is. The reader had to work that out.
 *
 * It also never actually appeared. It was mounted only in
 * `SubscriptionPlansSection`, which the Billing page stopped rendering
 * when the credit-reload products were withdrawn — so the one screen
 * where the user can act on this showed nothing at all.
 *
 * Whether the balance is short is settled in Rust and read off
 * `planAction`; this decides nothing. Renders nothing when there is
 * nothing to say, so a call site can mount it unconditionally.
 */
const PlanRenewalNotice: React.FC<{ className?: string }> = ({ className }) => {
  const { data: overview } = useStorageOverview();
  const notice = getRenewalNotice(overview);

  return (
    <StatusBanner
      banner={
        notice && {
          tone: "danger",
          title: notice.title,
          description: notice.description,
          // No action link: this only renders on Billing, so "See your
          // plan" pointed at the page the reader is already on. The Add
          // Credits button sits directly below it, which is the actual
          // fix.
          //
          // No dismiss key either: putting it away does not buy credits,
          // and the renewal still fails. Same rule as the no-storage-plan
          // notice.
        }
      }
      className={className}
    />
  );
};

export default PlanRenewalNotice;
