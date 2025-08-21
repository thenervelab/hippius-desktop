"use client";

import { FC, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { Refresh, WalletAdd } from "@/components/ui/icons";
import * as Typography from "@/components/ui/typography";
import { AbstractIconWrapper, CardButton, Icons } from "@/components/ui";
import Warning from "@/components/ui/icons/Warning";
import { formatCreditBalance } from "@/app/lib/utils/formatters/formatCredits";
import BalanceTrends from "./balance-trends";
import useBalance from "@/app/lib/hooks/api/useBalance";
import { Account } from "@/app/lib/types";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { toast } from "sonner";
import { useHippiusBalance } from "@/app/lib/hooks/api/useHippiusBalance";
import SendBalanceDialog, { TRANSACTION_FEE } from "./SendBalanceDialog";
import ReceiveBalanceDialog from "./ReceiveBalanceDialog";


interface WalletBalanceWidgetWithGraphProps {
  className?: string;
}

const WalletBalanceWidgetWithGraph: FC<WalletBalanceWidgetWithGraphProps> = ({
  className,
}) => {
  const { data: balanceInfo, isLoading, error, refetch } = useHippiusBalance();
  const [sendDialogOpen, setSendDialogOpen] = useState(false);
  const [receiveDialogOpen, setReceiveDialogOpen] = useState(false);
  const { mnemonic, polkadotAddress } = useWalletAuth();

  // Use the balance data for chart
  const { data: balanceData, isLoading: isBalanceLoading } = useBalance();

  // Prepare data for the chart - only using balance data
  const chartData = useMemo(() => {
    if (!balanceData) return [];

    // Create balance data points
    const balancePoints = balanceData
      ? [
        {
          timestamp: balanceData.timestamp,
          date: new Date(balanceData.timestamp),
          type: "balance",
          value: balanceData.totalBalance,
        },
      ]
      : [];

    // Process the data points
    const result: Account[] = [];

    balancePoints.forEach((point) => {
      // Add the data point with current balance value
      result.push({
        processed_timestamp: point.timestamp,
        credit: "0", // We're not using credit data
        total_balance: point.value,
      });
    });

    return result;
  }, [balanceData]);

  const isChartDataLoading = isBalanceLoading;

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
    <div className="w-full relative">
      <div
        className={cn(
          "relative gap-4 overflow-hidden h-[310px] grid grid-cols-[auto_minmax(0,1fr)]",
          className
        )}
      >
        <div className="w-full p-4 flex flex-col border border-grey-80 rounded-lg justify-between relative min-w-[298px] max-w-[300px]">
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
                  ) : error && (
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
        <BalanceTrends
          className="min-w-0"
          chartData={chartData}
          isLoading={isChartDataLoading}
        />
      </div>
    </div>
  );
};

export default WalletBalanceWidgetWithGraph;
