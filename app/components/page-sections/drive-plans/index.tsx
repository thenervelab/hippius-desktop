"use client";

import { Suspense } from "react";
import { useRouter } from "next/navigation";

import DashboardTitleWrapper from "@/components/dashboard-title-wrapper";
import { Button } from "@/components/ui/button";
import { ArrowLeft, CoinsIcon } from "@/components/ui/icons";
import { useUserCredits } from "@/lib/hooks/api/useUserCredits";

import DrivePlansSection from "./DrivePlansSection";
import DriveSubscriptionHistory from "./DriveSubscriptionHistory";

/** The subscriptions page: plans above, the plan's history below. */
export default function DrivePlans() {
  const router = useRouter();
  const { data: credits, isLoading } = useUserCredits();

  return (
    <DashboardTitleWrapper mainText="Subscriptions">
      <div className="flex flex-col gap-3 px-4 pb-6 pt-3">
        <div className="flex items-center justify-between gap-3 px-1">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              aria-label="Back"
              onClick={() => router.back()}
              className="inline-flex size-[19px] shrink-0 items-center justify-center text-black-700 opacity-50 transition-opacity hover:opacity-100 dark:text-white"
            >
              <ArrowLeft className="size-[19px]" />
            </button>
            <h1 className="truncate text-[24px] font-medium leading-8 text-black-700 dark:text-white">
              Subscriptions
            </h1>
          </div>
          <div className="flex shrink-0 items-center gap-[14px] rounded-[8px] border border-grey-light-500 bg-grey-light-600 px-[14px] dark:border-black-300 dark:bg-black-primary-bg">
            <div className="flex h-[38px] flex-col justify-center gap-[3px] py-[11px]">
              <span className="flex items-center gap-1">
                <CoinsIcon className="size-[18px] text-primary-50 dark:text-primary-brand-dark" />
                <span className="font-mono text-[12px] font-medium uppercase leading-[18px] tracking-[-0.24px] text-[#1f51be] dark:text-primary-brand-dark">
                  Credits
                </span>
              </span>
              {isLoading || !credits ? (
                <span className="h-[18px] w-20 animate-pulse rounded bg-grey-dark-100 dark:bg-black-300" />
              ) : (
                <span className="text-[12px] leading-[18px] tracking-[-0.36px]">
                  <span className="font-bold text-primary-50 dark:text-primary-brand-dark">
                    {credits.hip}
                  </span>
                  <span className="font-medium text-black-900 dark:text-white">
                    {" "}
                    credits
                  </span>
                </span>
              )}
            </div>
            <Button
              asLink
              href="/billing"
              variant="raised"
              size="auto"
              className="h-8 rounded-[8px] px-[14px] text-[14px] font-medium tracking-[-0.28px]"
            >
              + Top up Credits
            </Button>
          </div>
        </div>

        <Suspense fallback={null}>
          <DrivePlansSection />
        </Suspense>
        <DriveSubscriptionHistory />
      </div>
    </DashboardTitleWrapper>
  );
}
