"use client";

import React from "react";

import CreditsWidget from "./CreditsWidget";
import BillingnHistoryTable from "./BillingnHistoryTable";
import SubscriptionPlansSection from "./SubscriptionPlansSection";
import TaoDepositWidget from "./TaoDepositWidget";

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
 */
export default function BillingSections() {
  return (
    <>
      {/* Top grid. Deliberately kept at 3 columns with the third left
          empty: the Drive Credit Usage card was removed by product
          decision, and the remaining two cards keep their width instead
          of stretching to fill the row. */}
      <div className="mt-4 grid grid-cols-1 @md:grid-cols-2 @3xl:grid-cols-3 gap-4">
        <CreditsWidget />
        <TaoDepositWidget />
      </div>

      {/* Subscription Plans — plan detail lives under Billing rather than
          beside the product, so this is the one place it is offered. */}
      <SubscriptionPlansSection />

      {/* Billing History */}
      <div className="mt-6 flex flex-col items-center w-full rounded-[8px] border overflow-hidden bg-grey-light-300 border-grey-dark-100 dark:bg-black-primary-bg dark:border-black-300 shadow-[0px_1px_1.1px_rgba(0,0,0,0.04)]">
        <div className="flex h-[46px] w-full items-center pl-[14px] pr-[10px]">
          <p className="font-mono font-medium text-[12px] leading-[18px] tracking-[-0.24px] text-primary-40 dark:text-primary-brand-dark uppercase">
            Billing History
          </p>
        </div>
        <div className="flex flex-col w-full flex-1 rounded-tl-[8px] rounded-tr-[8px] border-t border-grey-dark-100 bg-white dark:bg-black-600 dark:border-black-300 overflow-hidden">
          <BillingnHistoryTable />
        </div>
      </div>
    </>
  );
}
