"use client";

import { FC } from "react";
import { cn } from "@/lib/utils";
import { Tag2, TagRight, Wallet } from "@/components/ui/icons";

import * as Typography from "@/components/ui/typography";
import { Loader2 } from "lucide-react";
import { AbstractIconWrapper, CardButton } from "../../ui";
import useSubscriptionData from "@/app/lib/hooks/api/useSubscriptionData";

interface SubscriptionPlansWidgetProps {
  className?: string;
}

const SubscriptionPlansWidget: FC<SubscriptionPlansWidgetProps> = ({
  className,
}) => {
  const { activeSubscription, isLoadingActive } = useSubscriptionData();
  const getDaysUntilExpiration = (endDateStr: string) => {
    // Parse both dates
    const endDate = new Date(endDateStr);
    const today = new Date();

    // Reset the time portion to get full days
    const endDateOnly = new Date(
      endDate.getFullYear(),
      endDate.getMonth(),
      endDate.getDate()
    );

    const todayOnly = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate()
    );

    // Calculate the time difference in milliseconds
    const timeDiff = endDateOnly.getTime() - todayOnly.getTime();

    // Convert to days and ensure non-negative value
    return Math.max(0, Math.ceil(timeDiff / (1000 * 60 * 60 * 24)));
  };

  const hasActiveSubscription = activeSubscription?.has_subscription;

  return (
    <div className="w-full sm:max-w-[345px]  relative bg-[url('/assets/subscription-bg-layer.png')] bg-repeat bg-cover">
      <div
        className={cn(
          "border relative border-grey-80 overflow-hidden rounded-xl w-full h-full",
          className
        )}
      >
        <div className="w-full px-4 py-4 relative">
          <div className="flex items-start">
            <AbstractIconWrapper className="size-8 sm:size-10 text-primary-40">
              <Wallet className="absolute text-primary-40 size-4 sm:size-5" />
            </AbstractIconWrapper>
            <div className="flex flex-col ml-4">
              <span className="text-base font-medium mb-3 text-grey-60">
                Your subscription
              </span>
              {isLoadingActive ? (
                <div className="flex flex-col items-center justify-center pt-4 pb-5 ">
                  <div className="flex flex-col items-center">
                    <Loader2 className="size-8 text-primary-50 animate-spin mb-2" />
                    <Typography.P size="xs" className="text-grey-50">
                      Loading subscription...
                    </Typography.P>
                  </div>
                </div>
              ) : hasActiveSubscription ? (
                <div className="">
                  <div className="text-2xl mb-1 font-medium text-grey-10">
                    {activeSubscription.subscription.plan_name}
                  </div>

                  <div className="flex items-center text-sm text-grey-60">
                    <div className="flex items-center  gap-x-2">
                      <div>
                        ${activeSubscription.subscription.amount}
                        <span>/{activeSubscription.subscription.interval}</span>
                      </div>
                    </div>

                    <span className="h-3 border border-grey-70 mx-1"></span>

                    {activeSubscription.subscription.current_period_end && (
                      <div className="flex items-center ">
                        <span className="mr-1">Expires in</span>
                        <span>
                          {getDaysUntilExpiration(
                            activeSubscription.subscription.current_period_end
                          )}{" "}
                          Days
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center pt-7">
                  <AbstractIconWrapper className="size-8 sm:size-10">
                    <TagRight className="absolute size-4 sm:size-6 text-primary-50" />
                  </AbstractIconWrapper>
                  <Typography.P
                    size={"xxs"}
                    className="text-center text-grey-10 pb-2 mt-1"
                  >
                    No Active Plan
                  </Typography.P>
                </div>
              )}
            </div>
          </div>
        </div>
        <div className=" relative mx-11 pb-4 mt-16 bg-grey-100 w-auto ">
          <CardButton
            className="w-full"
            asLink
            href="/dashboard/billing/plans"
            disabled={isLoadingActive}
          >
            <div className="flex items-center gap-2">
              <Tag2 className="size-4" />
              <span className="flex items-center">
                {hasActiveSubscription ? "Upgrade Plan" : "Subscribe to a Plan"}
              </span>
            </div>
          </CardButton>
        </div>
      </div>
    </div>
  );
};

export default SubscriptionPlansWidget;
