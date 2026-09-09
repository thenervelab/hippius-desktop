"use client";

import React from "react";

import DashboardTitleWrapper from "@/components/dashboard-title-wrapper";
import BillingSections from "./BillingSections";
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

          <BillingSections />
        </div>
      </DashboardTitleWrapper>
    </>
  );
}
