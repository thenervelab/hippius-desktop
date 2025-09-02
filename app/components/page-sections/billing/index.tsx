"use client";

import React, { useState } from "react";

import CreditsWidget from "./CreditsWidget";
import CreditGraph from "./CreditGraph";
import DashboardTitleWrapper from "@/components/dashboard-title-wrapper";
import BillingnHistoryTable from "./BillingnHistoryTable";
import TabList, { TabOption } from "@/components/ui/tabs/TabList";
import { Icons } from "@/components/ui";
import SubscriptionPlansWidget from "./SubscriptionPlansWidget";
import TaoDepositWidget from "./TaoDepositWidget";

export default function Billing() {
  const [activeTab, setActiveTab] = useState("Billing History");

  const tabs: TabOption[] = [
    {
      tabName: "Billing History",
      icon: <Icons.BoxTime className="size-4" />
    }
  ];

  return (
    <>
      <DashboardTitleWrapper mainText="Billing">
        <div className="flex flex-col mt-6">

          <div className="w-full grid">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <CreditsWidget />
              <SubscriptionPlansWidget />
              <TaoDepositWidget />
            </div>
          </div>

          <div className="w-full mt-6">
            <CreditGraph />
          </div>

          {/* Billing history table */}
          <div className="mt-6">
            <div className="flex justify-between">
              <TabList
                tabs={tabs}
                activeTab={activeTab}
                onTabChange={setActiveTab}
                className="mb-6"
              />
            </div>

            <div className="flex flex-col animate-in fade-in duration-300 gap-8 w-full shadow-menu rounded-lg bg-white p-4 border border-grey-80">
              {activeTab === "Billing History" && <BillingnHistoryTable />}
            </div>
          </div>
        </div>
      </DashboardTitleWrapper>
    </>
  );
}
