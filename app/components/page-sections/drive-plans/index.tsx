"use client";

import { Suspense } from "react";

import DashboardTitleWrapper from "@/components/dashboard-title-wrapper";
import PageHeader from "@/components/page-sections/home/PageHeader";
import InfoTooltip from "@/components/ui/info-tooltip";

import DrivePlansSection from "./DrivePlansSection";
import DriveSubscriptionHistory from "./DriveSubscriptionHistory";

const PLANS_DOCS_URL = "https://docs.hippius.com/use/desktop/billing";

/** The subscriptions page: plans above, the plan's history below. */
export default function DrivePlans() {
  return (
    <DashboardTitleWrapper mainText="Subscription Plans">
      <div className="flex flex-col px-4 pb-6">
        {/* Same header as home/Billing — title + info, and the identical
            plan-chip + "+ Top up Credits" cell on the right. The page is
            reached from the sidebar, so there is deliberately no back
            button. */}
        <PageHeader
          title="Subscription Plans"
          subtitle="Pick the storage plan that fits, and change it anytime."
          infoButton={
            <InfoTooltip
              ariaLabel="Subscription plans information"
              learnMoreUrl={PLANS_DOCS_URL}
            >
              Your plan sets how much Drive storage you have. Plans renew
              automatically each month from your credits or card.
            </InfoTooltip>
          }
        />

        <div className="mt-4 flex flex-col gap-3">
          <Suspense fallback={null}>
            <DrivePlansSection />
          </Suspense>
          <DriveSubscriptionHistory />
        </div>
      </div>
    </DashboardTitleWrapper>
  );
}
