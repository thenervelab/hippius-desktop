"use client";

import { FC, useMemo } from "react";
import { cn } from "@/lib/utils";
import { AddCircle, Refresh, WalletAdd } from "@/components/ui/icons";
import * as Typography from "@/components/ui/typography";
import { AbstractIconWrapper, CardButton, Icons } from "@/components/ui";
import { useUserCredits } from "@/app/lib/hooks/api/useUserCredits";
import Warning from "@/components/ui/icons/Warning";
import TimeAgo from "react-timeago";
import { formatCreditBalance } from "@/app/lib/utils/formatters/formatCredits";
import CreditsTrends from "./credits-trends";
import useCredits from "@/app/lib/hooks/api/useCredits";
import { openLinkByKey } from "@/app/lib/utils/links";

interface CreditsWidgetWithGraphProps {
  className?: string;
}

const CreditsWidgetWithGraph: FC<CreditsWidgetWithGraphProps> = ({
  className,
}) => {
  const {
    data: credits,
    isLoading,
    error,
    refetch,
    dataUpdatedAt,
  } = useUserCredits();

  // Use the new hooks for credits and balance
  const { data: creditsDaily, isLoading: isCreditsLoading } = useCredits();

  // Combine the data into a format that the chart expects
  const chartData = useMemo(() => {
    const rows = creditsDaily ?? [];
    return rows.map((r) => {
      // toast.success(
      //   `Credits ${r.amount} ${r.date} processed successfully. ${rows.length}`
      // );
      return {
        processed_timestamp: r.date,
        credit: r.amount,
        total_balance: "0",
      };
    });
  }, [creditsDaily]);

  const isChartDataLoading = isCreditsLoading;

  const handleOpenConsoleBillingPage = () => openLinkByKey("BILLING");
  const handleOpenConsoleCreditsPage = () => openLinkByKey("CREDITS");

  return (
    <div className="w-full  relative ">
      <div
        className={cn(
          " relative gap-4 overflow-hidden   h-[310px] grid grid-cols-[auto_minmax(0,1fr)]",
          className
        )}
      >
        <div className="w-full p-4 flex flex-col border border-grey-80 rounded-lg justify-between relative min-w-[298px] max-w-[300px] ">
          <div className="flex flex-col w-full items-start">
            <div className="flex gap-4 items-center">
              <AbstractIconWrapper className="size-8 sm:size-10 text-primary-40">
                <WalletAdd className="absolute text-primary-40 size-4 sm:size-5" />
              </AbstractIconWrapper>
              <span className="text-base font-medium  text-grey-60">
                Total Credits
              </span>
            </div>
            <div className="flex justify-between  items-end mt-4 w-full">
              <div className="flex flex-col  ">
                <div className="text-2xl   font-medium text-grey-10">
                  {credits !== undefined
                    ? `${formatCreditBalance(credits)}`
                    : error
                      ? "ERROR"
                      : "- - - -"}
                  <span className="text-xs font-medium -translate-y-1 ml-1">
                    Credits
                  </span>
                </div>
                <div className="flex items-center  gap-x-2 mt-2">
                  {isLoading ? (
                    <Typography.P size="xs">Loading...</Typography.P>
                  ) : error ? (
                    <>
                      <Warning className="size-4" />
                      <Typography.P size="xs" className="text-error-80">
                        Credits not retrieved.
                      </Typography.P>
                      <button
                        className="size-4"
                        onClick={() => {
                          refetch();
                        }}
                      >
                        <Refresh />
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className="size-4 hover:-rotate-45 duration-300 hover:text-primary-50"
                        onClick={() => {
                          refetch();
                        }}
                      >
                        <Refresh />
                      </button>
                      <Typography.P
                        style={{
                          fontSize: "12px",
                        }}
                        className="text-grey-60"
                      >
                        Last updated <TimeAgo date={dataUpdatedAt} />
                      </Typography.P>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
          <div className="flex flex-col">
            <CardButton
              className="w-full mt-4 h-[50px]"
              variant="secondary"
              onClick={handleOpenConsoleCreditsPage}
            >
              <div className="flex items-center gap-2 text-lg font-medium text-grey-10">
                <AddCircle className="size-4" />
                Add Credits
              </div>
            </CardButton>
            <CardButton
              className="w-full mt-3 h-[50px]"
              onClick={handleOpenConsoleBillingPage}
            >
              <div className="flex items-center gap-2 ">
                <Icons.Tag2 className="size-4" />
                <span className="flex items-center text-lg font-medium">
                  Manage Subscription
                </span>
              </div>
            </CardButton>
          </div>
        </div>
        <CreditsTrends
          className="min-w-0"
          chartData={chartData}
          isLoading={isChartDataLoading}
        />
      </div>
    </div>
  );
};

export default CreditsWidgetWithGraph;
