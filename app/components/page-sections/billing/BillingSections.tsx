"use client";

import React, { Suspense } from "react";

import CreditsWidget from "./CreditsWidget";
import TaoDepositWidget from "./TaoDepositWidget";
import DrivePlansSection from "@/components/page-sections/drive-plans/DrivePlansSection";

/**
 * Everything on the Billing page except the page chrome.
 *
 * Billing is reachable from two places — the `/billing` route and
 * Settings → Billing — and they must show the same thing. Extracting the
 * body is what keeps that true: a second copy is how one of them ends up
 * missing a section nobody notices for a release.
 *
 * The page chrome (DashboardTitleWrapper + PageHeader) stays with the
 * route, because inside Settings the surrounding page already supplies a
 * title and would render two.
 *
 * **The plans shown here are the Drive plans, not the credit-reload
 * packages.** This page used to list the S3 credit-reload subscriptions
 * ("3 / 15 / 150 / 450 Credits Reload"), which are a different product
 * and were removed from the console for the same reason: two unrelated
 * things called "Subscription Plans" on one screen, only one of which
 * governs the storage the user is actually looking at. Billing history
 * came out with them. `SubscriptionPlansSection` and
 * `BillingnHistoryTable` are left in the tree unreferenced rather than
 * deleted, matching how other withdrawn surfaces are kept.
 */
export default function BillingSections() {
  return (
    <>
      {/* Credits stay: a credits-funded Drive plan renews out of this
          balance, so topping up is part of managing the plan below. */}
      {/* Two cards, two columns. The third column was left over from when
          a third widget sat here, so each card took a THIRD of the row and
          the rest went to whitespace — which is why the deposit address had
          to be center-truncated on a window with room to spare.

          The deposit column is BOUNDED rather than weighted: its content is
          a fixed 48-character address plus a copy button, so it has a width
          at which it is complete and past which it only adds empty field.
          A fraction of the row could not express that — it truncated on a
          small window and sprawled on a large one. The floor fits the
          address, the ceiling stops the sprawl, and the credits card (a
          number and a full-width button, both of which stretch happily)
          takes the slack. */}
      <div className="mt-4 grid grid-cols-1 gap-4 @md:grid-cols-2 @3xl:grid-cols-[minmax(0,1fr)_minmax(28rem,34rem)]">
        <CreditsWidget />
        <TaoDepositWidget />
      </div>

      {/* Drive plans — the plan detail that Billing now owns. Suspense
          because the section reads search params, same as the standalone
          plans route does. */}
      <div className="mt-4 flex flex-col gap-3">
        <Suspense fallback={null}>
          <DrivePlansSection />
        </Suspense>
      </div>
    </>
  );
}
