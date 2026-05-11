"use client";

import { FC, useState } from "react";
import { cn } from "@/lib/utils";
import { WalletMinimalIcon } from "@/components/ui/icons";
import { TaoLogo, Copy, CircularTickGrid } from "@/components/ui/icons";
import useDepositAddress from "@/app/lib/hooks/useDepositAddress";
import { toast } from "sonner";

const TaoDepositWidget: FC<{ className?: string }> = ({ className }) => {
  const { data: depositAddress } = useDepositAddress();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!depositAddress) return;
    try {
      await navigator.clipboard.writeText(depositAddress);
      toast.success("Wallet Address Copied Successfully!");
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy address");
    }
  };

  const displayAddress = depositAddress ?? "---";

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
          <WalletMinimalIcon className="size-[14px] text-primary-40 dark:text-primary-brand-dark" />
          <p className="font-mono font-medium text-[12px] leading-[18px] tracking-[-0.24px] text-primary-40 dark:text-primary-brand-dark uppercase">
            Tao Deposit Address
          </p>
        </div>
      </div>

      {/* Inner panel */}
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

        {/* Bottom: address text box + separate copy button */}
        <div className="flex w-full gap-2 items-center">
          {/* Address text field */}
          <div
            className={cn(
              "flex flex-1 min-w-0 h-[36px] items-center px-2 overflow-hidden",
              "rounded-[8px] border border-grey-dark-100",
              "bg-grey-light-300 dark:bg-black-primary-bg dark:border-black-300",
            )}
          >
            <span className="text-[12px] font-medium tracking-[-0.24px] text-grey-50 dark:text-white/40 whitespace-nowrap overflow-hidden text-ellipsis w-full">
              {displayAddress}
            </span>
          </div>

          {/* Separate copy button */}
          <button
            type="button"
            onClick={handleCopy}
            aria-label="Copy wallet address"
            className={cn(
              "flex h-[36px] w-[36px] shrink-0 items-center justify-center rounded-[8px] border",
              "bg-grey-light-300 border-grey-dark-100",
              "dark:bg-black-primary-bg dark:border-black-300",
              "transition-colors hover:bg-grey-light-800 dark:hover:bg-black-300/70",
            )}
          >
            {copied ? (
              <CircularTickGrid className="size-4 text-primary-50" />
            ) : (
              <Copy className="size-4 text-grey-50 dark:text-white/50" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default TaoDepositWidget;
