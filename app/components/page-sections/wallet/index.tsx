"use client";

import React from "react";

import { AbstractIconWrapper } from "../../ui";

import { Clock } from "../../ui/icons";
import TransactionHistoryTable from "./transaction-history-table";
import SubscriptionPlansWidget from "./SubscriptionPlansWidget";
import WalletBalanceWidgetWithGraph from "./WalletBalanceWidgetWithGraph";
import DashboardTitleWrapper from "../../dashboard-title-wrapper";

export default function Wallet() {
  return (
    <>
      <DashboardTitleWrapper mainText="Wallet">
        <div className="flex flex-col xl:flex-row gap-4 mt-6">
          <WalletBalanceWidgetWithGraph />
          <SubscriptionPlansWidget />
        </div>

        <div className="mt-6">
          <div className="flex items-center gap-x-2 mb-4">
            <AbstractIconWrapper className="size-8 sm:size-10">
              <Clock className="absolute size-4 sm:size-6 text-primary-50" />
            </AbstractIconWrapper>
            <span className="text-[18px] sm:text-[22px] font-medium text-grey-10">
              Transaction History
            </span>
          </div>
          <TransactionHistoryTable />
        </div>
      </DashboardTitleWrapper>
    </>
  );
}
