"use client";

import React from "react";

import { AbstractIconWrapper, ProfileCard } from "../../ui";
import HeaderText from "./HeaderText";
import { Clock } from "../../ui/icons";
import TransactionHistoryTable from "./transaction-history-table";
import SubscriptionPlansWidget from "./SubscriptionPlansWidget";
import WalletBalanceWidgetWithGraph from "./WalletBalanceWidgetWithGraph";

export default function Wallet() {
  return (
    <>
      <div className=" bg-white z-10 justify-between flex ">
        <HeaderText />
        <ProfileCard />
      </div>
      <div className="flex gap-4 mt-6">
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
    </>
  );
}
