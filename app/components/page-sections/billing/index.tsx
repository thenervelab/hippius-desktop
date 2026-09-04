"use client";

import React from "react";

import CreditsWidget from "./CreditsWidget";
import DashboardTitleWrapper from "@/components/dashboard-title-wrapper";
import BillingnHistoryTable from "./BillingnHistoryTable";
import SubscriptionPlansSection from "./SubscriptionPlansSection";
import TaoDepositWidget from "./TaoDepositWidget";
import PageHeader from "@/components/page-sections/home/PageHeader";
import InfoTooltip from "@/components/ui/info-tooltip";

const BILLING_DOCS_URL = "https://docs.hippius.com/use/desktop/billing";

export default function Billing() {
  return (
    <>
      <DashboardTitleWrapper mainText="Billing">
        <div className="flex flex-col px-4 pb-6">
          {/* Page heading: title + WALLET/ACTIVE PLAN chips */}
          <PageHeader
            title="Billing"
            subtitle="All uploaded files are private and securely encrypted."
            showTopUpCredits={false}
            infoButton={
              <InfoTooltip
                ariaLabel="Billing information"
                learnMoreUrl={BILLING_DOCS_URL}
              >
                Credits are consumed when you upload files, provision VMs, or
                use other Hippius services.
              </InfoTooltip>
            }
          />

          {/* Top grid. Deliberately kept at 3 columns with the third left
              empty: the Drive Credit Usage card was removed by product
              decision, and the remaining two cards keep their width instead
              of stretching to fill the row. */}
          <div className="mt-4 grid grid-cols-1 @md:grid-cols-2 @3xl:grid-cols-3 gap-4">
            <CreditsWidget />
            <TaoDepositWidget />
          </div>

          {/* Subscription Plans - embedded inline */}
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
        </div>
      </DashboardTitleWrapper>
    </>
  );
}
