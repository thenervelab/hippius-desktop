"use client";

import { FC } from "react";
import { cn } from "@/lib/utils";
import { Icons, RefreshButton } from "@/components/ui";
import { Button } from "@/components/ui/button";
import { useUserCredits } from "@/app/lib/hooks/api/useUserCredits";
import TimeAgo from "react-timeago";
import { openLinkByKey } from "@/app/lib/utils/links";
import Warning from "@/components/ui/icons/Warning";
import { ArrowRight } from "@/components/ui/icons";

interface CreditsWidgetProps {
  className?: string;
}

const CreditsWidget: FC<CreditsWidgetProps> = ({ className }) => {
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
        "flex flex-col items-center w-full rounded-[8px] border overflow-hidden",
        "bg-grey-light-300 border-grey-dark-100",
        "dark:bg-black-primary-bg dark:border-black-300",
        "shadow-[0px_1px_1.1px_rgba(0,0,0,0.04)]",
        className,
      )}
    >
      {/* Header row */}
      <div className="flex h-[46px] w-full items-center pl-[14px] pr-[10px]">
        <div className="flex items-center gap-1">
          <Icons.WalletAdd className="size-[14px] text-primary-40 dark:text-primary-brand-dark" />
          <p className="font-mono font-medium text-[12px] leading-[18px] tracking-[-0.24px] text-primary-40 dark:text-primary-brand-dark uppercase">
            Total Credits
          </p>
        </div>
      </div>

      {/* Inner white panel — rounded top only so bottom aligns flush with outer border */}
      <div
        className={cn(
          "flex flex-col w-full flex-1 justify-between",
          "rounded-tl-[8px] rounded-tr-[8px] border border-grey-dark-100",
          "bg-white dark:bg-black-600 dark:border-black-300",
          "p-3",
        )}
      >
        {/* Top section: stat + refresh row */}
        <div className="flex flex-col gap-2">
          {/* Headline stat */}
          <div className="flex items-end gap-1">
            {isLoading ? (
              <div className="h-[30px] w-[140px] rounded bg-grey-light-700 dark:bg-grey-dark-200 animate-pulse" />
            ) : error ? (
              <span className="font-mono font-medium text-[24px] leading-[30px] tracking-[-0.96px] text-error-80">
                ERROR
              </span>
            ) : (
              <>
                <span className="font-mono font-medium text-[24px] leading-[30px] tracking-[-0.96px] text-grey-10 dark:text-white">
                  {credits?.hip ?? "- - - -"}
                </span>
                <span className="font-mono font-medium text-[12px] leading-[18px] tracking-[-0.48px] text-grey-10/50 dark:text-white/50 pb-[3px]">
                  Credits
                </span>
              </>
            )}
          </div>

          {/* Refresh row */}
          <div className="flex items-center gap-2">
            {isLoading ? (
              <div className="h-4 w-36 rounded bg-grey-light-700 dark:bg-grey-dark-200 animate-pulse" />
            ) : error ? (
              <>
                <Warning className="size-4 text-error-80 shrink-0" />
                <span className="text-[12px] text-error-80">Credits not retrieved.</span>
                <RefreshButton
                  onClick={() => refetch()}
                  ariaLabel="Retry loading credits"
                />
              </>
            ) : (
              <>
                <RefreshButton
                  onClick={() => refetch()}
                  ariaLabel="Refresh credits"
                />
                <span className="font-mono font-medium text-[12px] tracking-[-0.48px] text-grey-10/50 dark:text-white/50">
                  Last updated <TimeAgo date={dataUpdatedAt} />
                </span>
              </>
            )}
          </div>
        </div>

        {/* Add Credits button */}
        <Button
          variant="primary"
          size="auto"
          className="w-full mt-3 h-[36px] rounded-[8px] text-[13px] font-medium tracking-[-0.26px] gap-2"
          onClick={() => openLinkByKey("CREDITS")}
        >
          <ArrowRight className="size-4 shrink-0 rotate-180" />
          Add Credits
        </Button>
      </div>
    </div>
  );
};

export default CreditsWidget;
