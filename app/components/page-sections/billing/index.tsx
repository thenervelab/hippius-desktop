"use client";

import React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";

import CreditsWidget from "./CreditsWidget";
import CreditGraph from "./CreditGraph";
import DashboardTitleWrapper from "@/components/dashboard-title-wrapper";
import BillingnHistoryTable from "./BillingnHistoryTable";
import SubscriptionPlansSection from "./SubscriptionPlansSection";
import TaoDepositWidget from "./TaoDepositWidget";
import PageHeader from "@/components/page-sections/home/PageHeader";
import { Info } from "lucide-react";

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
              <TooltipPrimitive.Provider delayDuration={300}>
                <TooltipPrimitive.Root>
                  <TooltipPrimitive.Trigger asChild>
                    <button
                      type="button"
                      aria-label="Billing information"
                      className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-grey-80 bg-white text-grey-50 transition-colors hover:bg-grey-90 hover:text-primary-50 dark:border-black-300 dark:bg-black-primary-bg dark:text-grey-dark-400"
                    >
                      <Info className="size-3.5" />
                    </button>
                  </TooltipPrimitive.Trigger>
                  <TooltipPrimitive.Portal>
                    <TooltipPrimitive.Content
                      side="bottom"
                      align="center"
                      sideOffset={8}
                      avoidCollisions
                      collisionPadding={8}
                      className="z-[9999] max-w-[260px] rounded-[8px] border border-grey-dark-100 bg-white px-3 py-[10px] text-[12px] font-medium leading-4 tracking-[-0.24px] text-[#52525c] shadow-[0px_4px_24px_0px_rgba(0,0,0,0.08)] dark:border-[#494949] dark:bg-[#2c2c2c] dark:text-[#a3a3a3] dark:shadow-black/25"
                    >
                      Credits are consumed when you upload files, provision VMs, or use other Hippius services.
                      <TooltipPrimitive.Arrow className="fill-white dark:fill-[#2c2c2c]" />
                    </TooltipPrimitive.Content>
                  </TooltipPrimitive.Portal>
                </TooltipPrimitive.Root>
              </TooltipPrimitive.Provider>
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
            <div className="flex flex-col w-full flex-1 rounded-tl-[8px] rounded-tr-[8px] border-t border-grey-dark-100 bg-white dark:bg-black-600 dark:border-black-300 overflow-hidden">
              <BillingnHistoryTable />
            </div>
          </div>
        </div>
      </DashboardTitleWrapper>
    </>
  );
}
