"use client";

import { FC } from "react";
import { cn } from "@/lib/utils";
import { Icons } from "@/components/ui";
import { TaoLogo } from "@/components/ui/icons";
import useDepositAddress from "@/app/lib/hooks/useDepositAddress";
import { CopyableCell } from "../../ui/alt-table";

const TaoDepositWidget: FC<{ className?: string }> = ({ className }) => {
  const { data: depositAddress } = useDepositAddress();

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
            Tao Deposit Address
          </p>
        </div>
      </div>

      {/* Inner white panel — rounded top only so bottom aligns flush with outer border */}
      <div
        className={cn(
          "flex flex-col w-full flex-1 justify-between",
          "rounded-tl-[8px] rounded-tr-[8px] border-t border-grey-dark-100",
          "bg-white dark:bg-black-600 dark:border-black-300",
          "p-3",
        )}
      >
        {/* Top: Tao logo + chain label */}
        <div className="flex flex-col gap-2.5">
          <div className="flex bg-primary-50 items-center justify-center size-6 rounded-[4.8px] shrink-0">
            <TaoLogo className="size-4 text-white" />
          </div>
          <p className="font-medium text-[12px] tracking-[-0.48px]">
            <span className="text-grey-10/50 dark:text-white/50">Wallet Address: </span>
            <span className="text-grey-10 dark:text-white">SS58 Bittensor Chain</span>
          </p>
        </div>

        {/* Bottom: copyable address */}
        <div className="flex w-full gap-2 items-center mt-3">
          <div className="flex flex-1 min-w-0 bg-grey-light-300 dark:bg-black-primary-bg rounded-[8px] h-[36px] items-center">
            <CopyableCell
              title="Copy Wallet Address"
              toastMessage="Wallet Address Copied Successfully!"
              copyAbleText={depositAddress ?? "---"}
              textColor="text-grey-50 dark:text-grey-dark-500 font-medium"
              copyIconClassName="size-4 text-grey-50 dark:text-grey-dark-500"
              checkIconClassName="size-4"
              className="px-2 py-0 w-full"
              isTable={true}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default TaoDepositWidget;
