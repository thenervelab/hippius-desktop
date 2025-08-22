"use client";

import React, { useState } from "react";

import CreditsWidgetWithGraph from "./CreditsWidgetWithGraph";
import DashboardTitleWrapper from "@/components/dashboard-title-wrapper";
import BillingnHistoryTable from "./BillingnHistoryTable";
import TabList, { TabOption } from "@/components/ui/tabs/TabList";
import { Icons } from "@/components/ui";

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
        <div className="w-full mt-6">
          <CreditsWidgetWithGraph />
        </div>

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
      </DashboardTitleWrapper>

    </>
  );
}
