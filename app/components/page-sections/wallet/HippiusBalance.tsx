"use client";

import { FC } from "react";
import { cn } from "@/lib/utils";
import { Refresh, WalletAdd } from "@/components/ui/icons";
import * as Typography from "@/components/ui/typography";
import { AbstractIconWrapper, CardButton, Icons } from "../../ui";
import { useHippiusBalance } from "@/app/lib/hooks/api/useHippiusBalance";
import Warning from "../../ui/icons/Warning";
import { formatCreditBalance } from "@/app/lib/utils/formatters/formatCredits";
import { openLinkByKey } from "@/app/lib/utils/links";

interface WalletBalanceWidgetWithGraphProps {
  className?: string;
}

const HippiusBalance: FC<WalletBalanceWidgetWithGraphProps> = ({
  className,
}) => {
  const { data: balanceInfo, isLoading, error, refetch } = useHippiusBalance();

  const handleOpenConsoleBillingPage = () => openLinkByKey("BILLING");

  return (
    <div className="w-full  ">
      <div
        className={cn(
          "border relative border-grey-80 overflow-hidden rounded-lg w-full p-4  h-full ",
          className
        )}
      >
        <div className="w-full border border-grey-80 p-6 drop-shadow rounded-lg  flex justify-between relative bg-[url('/assets/bg-layer.png')] bg-repeat-round bg-cover bg-white">
          <div className="flex flex-col items-start">
            <AbstractIconWrapper className="size-8 sm:size-10 text-primary-40">
              <WalletAdd className="absolute text-primary-40 size-4 sm:size-5" />
            </AbstractIconWrapper>
            <div className="flex flex-col mt-4">
              <span className="text-base font-medium  text-grey-60">
                Total Balance
              </span>
              <div className="text-[32px] leading-[40px]  font-medium text-grey-10">
                {balanceInfo !== undefined
                  ? `${formatCreditBalance(balanceInfo.data.free)}`
                  : error
                    ? "ERROR"
                    : "- - - -"}
                <span className="text-xs font-medium -translate-y-1 ml-1">
                  hALPHA
                </span>
              </div>
              <div className="flex items-center  gap-x-2">
                {isLoading ? (
                  <Typography.P size="xs">Loading...</Typography.P>
                ) : (
                  error && (
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
                  )
                )}
              </div>
            </div>
          </div>
          <div className="flex gap-4 self-end h-[50px]">
            <CardButton
              className="w-full  "
              variant="secondary"
              onClick={handleOpenConsoleBillingPage}
            >
              <div className="flex items-center gap-2 text-lg font-medium text-grey-10">
                <Icons.ArrowRight className="size-4 -rotate-90" />
                Send Balance
              </div>
            </CardButton>
            <CardButton
              className="w-full "
              onClick={handleOpenConsoleBillingPage}
            >
              <div className="flex items-center gap-2 ">
                <Icons.ArrowRight className="size-4 rotate-90" />

                <span className="flex items-center text-lg font-medium">
                  Recieve Balance
                </span>
              </div>
            </CardButton>
          </div>
        </div>
      </div>
    </div>
  );
};

export default HippiusBalance;
