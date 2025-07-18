"use client";

import { FC, useState } from "react";
import { cn } from "@/lib/utils";
import { Refresh, WalletAdd } from "@/components/ui/icons";
import * as Typography from "@/components/ui/typography";
import { AbstractIconWrapper, CardButton, Icons } from "../../ui";
import { useHippiusBalance } from "@/app/lib/hooks/api/useHippiusBalance";
import Warning from "../../ui/icons/Warning";
import { formatCreditBalance } from "@/app/lib/utils/formatters/formatCredits";

import SendBalanceDialog, { TRANSACTION_FEE } from "./SendBalanceDialog";
import ReceiveBalanceDialog from "./ReceiveBalanceDialog";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { toast } from "sonner";

interface WalletBalanceWidgetWithGraphProps {
  className?: string;
}

const HippiusBalance: FC<WalletBalanceWidgetWithGraphProps> = ({
  className
}) => {
  const { data: balanceInfo, isLoading, error, refetch } = useHippiusBalance();
  const [sendDialogOpen, setSendDialogOpen] = useState(false);
  const [receiveDialogOpen, setReceiveDialogOpen] = useState(false);
  const { mnemonic, polkadotAddress } = useWalletAuth();

  const handleSendBalance = () => {
    // Check if balance is available
    if (!balanceInfo?.data?.free) {
      toast.error("Balance information not available. Please try again later.");
      return;
    }

    const currentBalance = +formatCreditBalance(balanceInfo.data.free);

    // Check if balance is zero
    if (currentBalance <= 0) {
      toast.error(
        "Your balance is zero. Please add funds to your account first."
      );
      return;
    }

    // Check if balance is too low to cover transaction fee
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
    <div className="w-full  ">
      <div
        className={cn(
          "border relative border-grey-80 overflow-hidden rounded-lg w-full p-4  h-full ",
          className
        )}
      >
        <div className="w-full border border-grey-80 p-6 drop-shadow rounded-lg  flex justify-between relative bg-[url('/assets/bg-layer.png')] bg-repeat-round bg-cover bg-white">
          <div className="flex flex-col w-full items-start ">
            <div className="flex gap-4 items-center">
              <AbstractIconWrapper className="size-8 sm:size-10 text-primary-40">
                <WalletAdd className="absolute text-primary-40 size-4 sm:size-5" />
              </AbstractIconWrapper>
              <span className="text-base font-medium  text-grey-60">
                Native Balance
              </span>
            </div>
            <div className="flex justify-between  items-end mt-[13px] w-full">
              <div className="flex flex-col  ">
                <div className="text-2xl   font-medium text-grey-10">
                  {balanceInfo !== undefined
                    ? `${formatCreditBalance(balanceInfo.data.free)}`
                    : error
                      ? "ERROR"
                      : "- - - -"}
                  <span className="text-xs font-medium -translate-y-1 ml-1">
                    hALPHA
                  </span>
                </div>
                {(isLoading || error) && (
                  <div className="flex items-center  gap-x-2 mt-2">
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
                )}
              </div>
              <div className="flex gap-4 self-end h-[50px]">
                <CardButton
                  className="w-[255px] "
                  variant="secondary"
                  onClick={handleSendBalance}
                >
                  <div className="flex items-center gap-2 text-lg font-medium text-grey-10">
                    <Icons.ArrowRight className="size-4 -rotate-90" />
                    Send Balance
                  </div>
                </CardButton>
                <CardButton
                  className="w-[255px] "
                  onClick={handleReceiveBalance}
                >
                  <div className="flex items-center gap-2 ">
                    <Icons.ArrowRight className="size-4 rotate-90" />

                    <span className="flex items-center text-lg font-medium">
                      Receive Balance
                    </span>
                  </div>
                </CardButton>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Send Balance Dialog */}
      <SendBalanceDialog
        open={sendDialogOpen}
        onClose={() => setSendDialogOpen(false)}
        availableBalance={+formatCreditBalance(balanceInfo?.data?.free ?? null)}
        mnemonic={mnemonic || ""}
        refetchBalance={refetch}
        polkadotAddress={polkadotAddress || ""}
      />

      {/* Receive Balance Dialog */}
      <ReceiveBalanceDialog
        open={receiveDialogOpen}
        onClose={() => setReceiveDialogOpen(false)}
        polkadotAddress={polkadotAddress || ""}
      />
    </div>
  );
};

export default HippiusBalance;
