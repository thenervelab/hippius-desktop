"use client";

import { FC, useMemo } from "react";
import { cn } from "@/lib/utils";
import { AddCircle, Refresh, WalletAdd } from "@/components/ui/icons";
import * as Typography from "@/components/ui/typography";
import { AbstractIconWrapper, CardButton, Icons } from "../../ui";
import { useUserCredits } from "@/app/lib/hooks/api/useUserCredits";
import Warning from "../../ui/icons/Warning";
import TimeAgo from "react-timeago";
import { formatCreditBalance } from "@/app/lib/utils/formatters/formatCredits";
import BalanceTrends from "./balance-trends";
import useCredits from "@/app/lib/hooks/api/useCredits";
import useBalance from "@/app/lib/hooks/api/useBalance";
import { Account } from "@/app/lib/types";
import { openLinkByKey } from "@/app/lib/utils/links";

interface WalletBalanceWidgetWithGraphProps {
  className?: string;
}

const WalletBalanceWidgetWithGraph: FC<WalletBalanceWidgetWithGraphProps> = ({
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
  const { data: creditsData, isLoading: isCreditsLoading } = useCredits();

  const { data: balanceData, isLoading: isBalanceLoading } = useBalance();

  // Combine the data into a format that the chart expects
  const chartData = useMemo(() => {
    if (!creditsData?.length && !balanceData) return [];

    // Create arrays of data points for each type
    const creditPoints =
      creditsData?.map((credit) => ({
        timestamp: credit.date,
        date: new Date(credit.date),
        type: "credit",
        value: credit.amount,
      })) || [];

    const balancePoints = balanceData
      ? [
          {
            timestamp: balanceData.timestamp,
            date: new Date(balanceData.timestamp),
            type: "balance",
            value: balanceData.totalBalance,
          },
        ]
      : [];

    // Combine and sort all data points chronologically
    const allPoints = [...creditPoints, ...balancePoints].sort(
      (a, b) => a.date.getTime() - b.date.getTime()
    );

    // Process the data points with carry-forward logic
    const result: Account[] = [];
    let currentBalance = "0";
    let currentCredit = "0";

    allPoints.forEach((point) => {
      // Update the respective current value
      if (point.type === "credit") {
        currentCredit = point.value;
      } else {
        currentBalance = point.value;
      }

      // Add the data point with both current values
      result.push({
        processed_timestamp: point.timestamp,
        credit: currentCredit,
        total_balance: currentBalance,
      });
    });

    return result;
  }, [creditsData, balanceData]);

  const isChartDataLoading = isCreditsLoading || isBalanceLoading;

  const handleOpenConsoleBillingPage = () => openLinkByKey("BILLING");

  console.log("Chart Data:", chartData);
  return (
    <div className="w-full  relative bg-[url('/assets/balance-bg-layer.png')] bg-repeat-round bg-cover">
      <div
        className={cn(
          "border relative border-grey-80 overflow-hidden rounded-xl  h-full ",
          "grid",
          "grid-cols-[auto_minmax(0,1fr)]",
          className
        )}
      >
        <div className="w-full pl-4 py-4 relative min-w-[280px] max-w-[300px]">
          <div className="flex items-start">
            <AbstractIconWrapper className="size-8 sm:size-10 text-primary-40">
              <WalletAdd className="absolute text-primary-40 size-4 sm:size-5" />
            </AbstractIconWrapper>
            <div className="flex flex-col ml-4">
              <span className="text-base font-medium mb-3 text-grey-60">
                Total Balance
              </span>
              <div className="text-2xl mb-1 font-medium text-grey-10">
                {credits !== undefined
                  ? `${formatCreditBalance(credits)}`
                  : error
                    ? "ERROR"
                    : "- - - -"}
                <span className="text-xs font-medium -translate-y-1 ml-1">
                  Credits
                </span>
              </div>
              <div className="flex items-center  gap-x-2">
                {isLoading ? (
                  <Typography.P size="xs">Loading...</Typography.P>
                ) : error ? (
                  <>
                    <Warning className="size-4" />
                    <Typography.P size="xs" className="text-error-80">
                      Account balance not retrieved.
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
          <div className="flex flex-col">
            <CardButton
              className="w-full mt-4 "
              variant="secondary"
              onClick={handleOpenConsoleBillingPage}
            >
              <div className="flex items-center gap-2 text-lg font-medium text-grey-10">
                <AddCircle className="size-4" />
                Add Credits
              </div>
            </CardButton>
            <CardButton
              className="w-full mt-3"
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
        <BalanceTrends
          className="min-w-0"
          chartData={chartData}
          isLoading={isChartDataLoading}
        />
      </div>
    </div>
  );
};

export default WalletBalanceWidgetWithGraph;
