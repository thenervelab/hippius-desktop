"use client";

import { FC } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useUserCredits } from "@/app/lib/hooks/api/useUserCredits";
import TimeAgo from "react-timeago";
import { openLinkByKey } from "@/app/lib/utils/links";
import Warning from "@/components/ui/icons/Warning";
import { CoinsIcon, AddCreditsArrow } from "@/components/ui/icons";
import { RefreshCcwDot } from "lucide-react";

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
          <CoinsIcon className="size-[14px] text-primary-40 dark:text-primary-brand-dark" />
          <p className="font-mono font-medium text-[12px] leading-[18px] tracking-[-0.24px] text-primary-40 dark:text-primary-brand-dark uppercase">
            Total Credits
          </p>
        </div>
      </div>

      {/* Inner panel — 3 direct children with justify-between matching Figma layout */}
      <div
        className={cn(
          "flex flex-col w-full flex-1 justify-between",
          "rounded-tl-[8px] rounded-tr-[8px] border-t border-grey-dark-100",
          "bg-white dark:bg-black-600 dark:border-black-300",
          "p-3",
        )}
      >
        {/* 1. Headline stat — left-aligned, label bottom-anchored */}
        <div className="flex items-end justify-start gap-1">
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

        {/* 2. Refresh row */}
        <div className="flex items-center gap-2">
          {isLoading ? (
            <div className="h-4 w-36 rounded bg-grey-light-700 dark:bg-grey-dark-200 animate-pulse" />
          ) : error ? (
            <>
              <Warning className="size-4 text-error-80 shrink-0" />
              <span className="text-[12px] text-error-80">
                Credits not retrieved.
              </span>
              <button
                type="button"
                onClick={() => refetch()}
                aria-label="Retry loading credits"
                className={cn(
                  "flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[6px] border",
                  "bg-grey-light-700 border-grey-dark-100",
                  "dark:bg-black-primary-bg dark:border-black-300",
                  "transition-colors hover:bg-grey-light-800 dark:hover:bg-black-300/70",
                )}
              >
                <RefreshCcwDot className="size-3 text-black-700 dark:text-white opacity-40" />
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => refetch()}
                aria-label="Refresh credits"
                className={cn(
                  "flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[6px] border",
                  "bg-grey-light-700 border-grey-dark-100",
                  "dark:bg-black-primary-bg dark:border-black-300",
                  "transition-colors hover:bg-grey-light-800 dark:hover:bg-black-300/70",
                )}
              >
                <RefreshCcwDot className="size-3 text-black-700 dark:text-white opacity-40" />
              </button>
              <span className="font-mono font-medium text-[12px] tracking-[-0.48px] text-grey-10/50 dark:text-white/50 whitespace-nowrap">
                Last updated <TimeAgo date={dataUpdatedAt} />
              </span>
            </>
          )}
        </div>

        {/* 3. Add Credits button */}
        <Button
          variant="primary"
          size="auto"
          className="w-full h-[36px] rounded-[8px] text-[13px] font-medium tracking-[-0.26px] gap-[7px]"
          onClick={() => openLinkByKey("CREDITS")}
        >
          <AddCreditsArrow className="size-[7px] shrink-0" />
          Add Credits
        </Button>
      </div>
    </div>
  );
};

export default CreditsWidget;
