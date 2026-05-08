"use client";

import React from "react";

import CreditsWidget from "./CreditsWidget";
import CreditGraph from "./CreditGraph";
import DashboardTitleWrapper from "@/components/dashboard-title-wrapper";
import BillingnHistoryTable from "./BillingnHistoryTable";
import { Icons } from "@/components/ui";
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
          <div className="mt-8">
            <div className="flex items-center gap-2 mb-4">
              <Icons.BoxTime className="size-4 text-primary-40" />
              <span className="font-mono text-[12px] font-medium uppercase tracking-[-0.24px] text-primary-40 dark:text-primary-brand-dark">
                Billing History
              </span>
            </div>
            <div className="flex flex-col w-full shadow-menu rounded-lg bg-white dark:bg-black-primary-bg p-4 border border-grey-80 dark:border-black-300">
              <BillingnHistoryTable />
            </div>
          </div>
        </div>
      </DashboardTitleWrapper>
    </>
  );
}
