"use client";

import React from "react";

import CreditsWidget from "./CreditsWidget";
import CreditGraph from "./CreditGraph";
import DashboardTitleWrapper from "@/components/dashboard-title-wrapper";
import BillingnHistoryTable from "./BillingnHistoryTable";
import SubscriptionPlansSection from "./SubscriptionPlansSection";
import TaoDepositWidget from "./TaoDepositWidget";
import PageHeader from "@/components/page-sections/home/PageHeader";
import { HelpCircle } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";

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
              <button
                onClick={() => openUrl(BILLING_DOCS_URL)}
                aria-label="Billing documentation"
                className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-grey-80 bg-white text-grey-50 transition-colors hover:bg-grey-90 hover:text-primary-50 dark:border-black-300 dark:bg-black-primary-bg dark:text-grey-dark-400"
              >
                <HelpCircle className="size-3.5" />
              </button>
            }
          />

          {/* Top 3-column grid: Credits, TAO Deposit, Credit Overview */}
          <div className="mt-4 grid grid-cols-1 @md:grid-cols-2 @3xl:grid-cols-3 gap-4">
            <CreditsWidget />
            <TaoDepositWidget />
            <CreditGraph />
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
            <div className="flex flex-col w-full flex-1 rounded-tl-[8px] rounded-tr-[8px] border-t border-grey-dark-100 bg-white dark:bg-black-600 dark:border-black-300 p-3">
              <BillingnHistoryTable />
            </div>
          </div>
        </div>
      </DashboardTitleWrapper>
    </>
  );
}
