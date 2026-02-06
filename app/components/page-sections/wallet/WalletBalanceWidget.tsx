"use client";

import { FC, useState } from "react";
import { cn } from "@/lib/utils";
import { Refresh, WalletAdd } from "@/components/ui/icons";
import * as Typography from "@/components/ui/typography";
import { AbstractIconWrapper, CardButton, Icons } from "@/components/ui";
import Warning from "@/components/ui/icons/Warning";
import { formatCreditBalance } from "@/app/lib/utils/formatters/formatCredits";
import { useActiveWalletAddress } from "@/app/lib/hooks/useActiveWalletAddress";
import { toast } from "sonner";
import { useHippiusBalance } from "@/app/lib/hooks/api/useHippiusBalance";
import SendBalanceDialog, { TRANSACTION_FEE } from "./SendBalanceDialog";
import ReceiveBalanceDialog from "./ReceiveBalanceDialog";

interface WalletBalanceWidgetProps {
  className?: string;
  refetchTransactions?: () => void;
  refetchSystemBalance?: () => void;
}

const WalletBalanceWidget: FC<WalletBalanceWidgetProps> = ({
  className,
  refetchTransactions,
  refetchSystemBalance,
}) => {
  const { data: balanceInfo, isLoading, error, refetch } = useHippiusBalance();
  const [sendDialogOpen, setSendDialogOpen] = useState(false);
  const [receiveDialogOpen, setReceiveDialogOpen] = useState(false);
  const polkadotAddress = useActiveWalletAddress();

  const handleSendBalance = () => {
    if (!balanceInfo?.data?.free) {
      toast.error("Balance information not available. Please try again later.");
      return;
    }

    const currentBalance = +formatCreditBalance(balanceInfo.data.free);

    if (currentBalance <= 0) {
      toast.error(
        "Your balance is zero. Please add funds to your account first."
      );
      return;
    }

    if (currentBalance <= parseFloat(TRANSACTION_FEE)) {
      toast.error(
        `Your balance (${currentBalance} hALPHA) is too low to cover the transaction fee (${TRANSACTION_FEE} hALPHA). Please add funds to your account first.`
      );
      return;
    }

    setSendDialogOpen(true);
  };

  const handleReceiveBalance = () => {
    setReceiveDialogOpen(true);
  };

  return (
    <>
      <div className={cn("w-full", className)}>
        {/* <div className="w-full p-4 flex flex-col border border-grey-80 rounded-lg justify-between h-[310px]"> */}
        <div className="w-full p-4 flex flex-col border border-grey-80 rounded-lg justify-between h-[310px] min-w-[400px]">
          <div className="flex flex-col w-full items-start">
            <div className="flex gap-4 items-center">
              <AbstractIconWrapper className="size-8 sm:size-10 text-primary-40">
                <WalletAdd className="absolute text-primary-40 size-4 sm:size-5" />
              </AbstractIconWrapper>
              <span className="text-base font-medium text-grey-60">
                Native Balance
              </span>
            </div>
            <div className="flex justify-between items-end mt-4 w-full">
              <div className="flex flex-col">
                <div className="text-2xl font-medium text-grey-10">
                  {balanceInfo !== undefined
                    ? `${formatCreditBalance(balanceInfo.data.free)}`
                    : error
                      ? "ERROR"
                      : "- - - -"}
                  <span className="text-xs font-medium -translate-y-1 ml-1">
                    hALPHA
                  </span>
                </div>
                <div className="flex items-center gap-x-2 mt-2">
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
          </div>
          <div className="flex flex-col">
            <CardButton
              className="w-full mt-4 h-[50px]"
              variant="secondary"
              onClick={handleSendBalance}
            >
              <div className="flex items-center gap-2 text-lg font-medium text-grey-10">
                <Icons.ArrowRight className="size-4 -rotate-90" />
                Send Balance
              </div>
            </CardButton>
            <CardButton
              className="w-full mt-3 h-[50px]"
              onClick={handleReceiveBalance}
            >
              <div className="flex items-center gap-2">
                <Icons.ArrowRight className="size-4 rotate-90" />
                <span className="flex items-center text-lg font-medium">
                  Receive Balance
                </span>
              </div>
            </CardButton>
          </div>
        </div>
      </div>

      <SendBalanceDialog
        open={sendDialogOpen}
        onClose={() => setSendDialogOpen(false)}
        availableBalance={
          +formatCreditBalance(balanceInfo?.data?.free ?? null)
        }
        refetchBalance={() => {
          refetch();
          refetchSystemBalance?.();
          refetchTransactions?.();
        }}
        polkadotAddress={polkadotAddress || ""}
      />

      <ReceiveBalanceDialog
        open={receiveDialogOpen}
        onClose={() => setReceiveDialogOpen(false)}
        polkadotAddress={polkadotAddress || ""}
      />
    </>
  );
};

export default WalletBalanceWidget;
