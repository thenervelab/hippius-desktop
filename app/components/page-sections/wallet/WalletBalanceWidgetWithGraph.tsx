"use client";

import { FC } from "react";
import { cn } from "@/lib/utils";
import { AddCircle, Refresh, WalletAdd } from "@/components/ui/icons";

import * as Typography from "@/components/ui/typography";
import { AbstractIconWrapper, CardButton } from "../../ui";
import { useUserCredits } from "@/app/lib/hooks/api/useUserCredits";
import Warning from "../../ui/icons/Warning";
import TimeAgo from "react-timeago";
import { formatCreditBalance } from "@/app/lib/utils/formatters/formatCredits";
import BalanceTrends from "./balance-trends";

interface WalletBalanceWidgetWithGraphProps {
  className?: string;
}
// Dummy chartData for a week - only required fields for the chart
const chartData: any[] = [
  {
    total_balance: "25000000000000000000", // 2500 tokens
    credit: "2000000000000000000", // 2300 tokens
    processed_timestamp: "2025-06-22T09:00:00Z", // Sunday
  },
  {
    total_balance: "27000000000000000000", // 2750 tokens
    credit: "15000000000000000000", // 2550 tokens
    processed_timestamp: "2025-06-23T14:30:00Z", // Monday
  },
  {
    total_balance: "26000000000000000000", // 2600 tokens
    credit: "10000000000000000000", // 2400 tokens
    processed_timestamp: "2025-06-24T11:15:00Z", // Tuesday
  },
  {
    total_balance: "31000000000000000000", // 3100 tokens
    credit: "22000000000000000000", // 2800 tokens
    processed_timestamp: "2025-06-25T16:45:00Z", // Wednesday
  },
  {
    total_balance: "29000000000000000000", // 2900 tokens
    credit: "10000000000000000000", // 2600 tokens
    processed_timestamp: "2025-06-26T08:20:00Z", // Thursday
  },
  {
    total_balance: "32000000000000000000", // 3200 tokens
    credit: "22000000000000000000", // 3000 tokens
    processed_timestamp: "2025-06-27T13:10:00Z", // Friday
  },
  {
    total_balance: "30000000000000000000", // 3050 tokens
    credit: "18000000000000000000", // 2850 tokens
    processed_timestamp: "2025-06-28T10:30:00Z", // Saturday
  },
];

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
  console.log("credits", credits);

  return (
    <div className="w-full  relative bg-[url('/assets/balance-bg-layer.png')] bg-repeat-round bg-cover">
      <div
        className={cn(
          "border relative border-grey-80 overflow-hidden rounded-xl w-full h-full flex",
          className
        )}
      >
        <div className="w-full pl-4 py-4 relative max-w-[280px]">
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
                  ? `$${formatCreditBalance(credits)}`
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
          <CardButton className="w-[160px] mt-4 " variant="secondary">
            <div className="flex items-center gap-2 text-lg font-medium text-grey-10">
              <AddCircle className="size-4" />
              Add Credits
            </div>
          </CardButton>
        </div>
        <BalanceTrends chartData={chartData} isLoading={false} />
      </div>
    </div>
  );
};

export default WalletBalanceWidgetWithGraph;
