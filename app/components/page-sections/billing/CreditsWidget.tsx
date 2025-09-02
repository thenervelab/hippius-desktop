"use client";

import { FC } from "react";
import { cn } from "@/lib/utils";
import { AddCircle, Refresh, WalletAdd } from "@/components/ui/icons";
import * as Typography from "@/components/ui/typography";
import { AbstractIconWrapper, CardButton } from "@/components/ui";
import { useUserCredits } from "@/app/lib/hooks/api/useUserCredits";
import Warning from "@/components/ui/icons/Warning";
import TimeAgo from "react-timeago";
import { formatCreditBalance } from "@/app/lib/utils/formatters/formatCredits";
import TopUpDialog from "@/app/components/page-sections/billing/TopUpDialog";

interface CreditsWidgetProps {
  className?: string;
}

const CreditsWidget: FC<CreditsWidgetProps> = ({
  className,
}) => {
  const {
    data: credits,
    isLoading,
    error,
    refetch,
    dataUpdatedAt,
  } = useUserCredits();


  return (
    <div
      className={cn(
        "w-full p-4 flex flex-col border border-grey-80 rounded-lg justify-between relative",
        className
      )}
    >
      <div className="flex flex-col w-full items-start">
        <div className="flex gap-4 items-center">
          <AbstractIconWrapper className="size-8 sm:size-10 text-primary-40">
            <WalletAdd className="absolute text-primary-40 size-4 sm:size-5" />
          </AbstractIconWrapper>
          <span className="text-base font-medium text-grey-60">
            Total Credits
          </span>
        </div>
        <div className="flex justify-between items-end mt-4 w-full">
          <div className="flex flex-col">
            <div className="text-2xl font-medium text-grey-10">
              {credits !== undefined
                ? `${formatCreditBalance(credits)}`
                : error
                  ? "ERROR"
                  : "- - - -"}
              <span className="text-xs font-medium -translate-y-1 ml-1">
                Credits
              </span>
            </div>
            <div className="flex items-center gap-x-2 mt-2">
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
      <div className="relative bg-grey-100 w-full border-grey-80 border-t">
        <TopUpDialog
          trigger={
            <CardButton
              className="w-full mt-4 h-[50px]"
            >
              <div className="flex items-center gap-2 text-lg font-medium">
                <AddCircle className="size-4" />
                Add Credits
              </div>
            </CardButton>
          }
        />
      </div>
    </div>
  );
};

export default CreditsWidget;
