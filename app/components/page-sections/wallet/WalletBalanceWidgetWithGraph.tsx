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
  console.log("credits", credits);

  return (
    <div className="w-full  relative bg-[url('/assets/balance-bg-layer.png')] bg-repeat-round bg-cover">
      <div
        className={cn(
          "border relative border-grey-80 overflow-hidden rounded-xl w-full h-full",
          className
        )}
      >
        <div className="w-full px-4 py-4 relative">
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
      </div>
    </div>
  );
};

export default WalletBalanceWidgetWithGraph;
