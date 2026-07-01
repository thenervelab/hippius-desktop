"use client";

import { FC, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  BarChart,
  InGoing,
  OutGoing,
} from "@/components/ui/icons";
import Warning from "@/components/ui/icons/Warning";
import { RefreshCcwDot } from "lucide-react";
import TimeAgo from "react-timeago";
import { useHippiusBalance } from "@/app/lib/hooks/api/useHippiusBalance";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { useLocalWallet } from "@/app/contexts/LocalWalletContext";
import SendBalanceDialog from "./SendBalanceDialog";
import ReceiveBalanceDialog from "./ReceiveBalanceDialog";
import { formatPlanckToHip } from "@/lib/utils/formatPlanckToHip";
import { toast } from "sonner";

interface WalletBalanceCardProps {
  className?: string;
  refetchTransactions?: () => void;
  refetchSystemBalance?: () => void;
}

// Fee constant mirrors Rust's ESTIMATED_TRANSFER_FEE_PLANCK; the check
// keeps users from trying to send when balance can't cover the fee.
const ESTIMATED_TRANSFER_FEE_PLANCK = BigInt("270233151");


const WalletBalanceCard: FC<WalletBalanceCardProps> = ({
  className,
  refetchTransactions,
  refetchSystemBalance,
}) => {
  const {
    data: balanceInfo,
    isFetching,
    error,
    refetch,
    dataUpdatedAt,
  } = useHippiusBalance();
  const { polkadotAddress } = useWalletAuth();
  const { activeWallet } = useLocalWallet();
  // Send/Receive must operate on the wallet the user has selected in
  // the header, not the auth-session identity — otherwise the receive
  // QR shows the wrong address and Send signs with the wrong key.
  // Fall back to the auth address only while the local-wallet context
  // is still hydrating.
  const walletAddress = activeWallet?.address ?? polkadotAddress ?? "";
  const [sendDialogOpen, setSendDialogOpen] = useState(false);
  const [receiveDialogOpen, setReceiveDialogOpen] = useState(false);

  // Transferable = free − frozen. On Substrate, `free` covers the
  // tokens a user "owns" but `frozen` covers whatever staking has
  // locked (bonded + unbonding + withdrawable). The amount that can
  // actually be sent is the difference between them. Without this
  // subtraction the Send dialog's "Available" reads the full balance
  // and MAX produces an amount the chain will reject. Mirrors
  // hippius-web's `getTransferable`.
  const transferablePlanck = useMemo(() => {
    if (!balanceInfo?.data) return BigInt(0);
    const t = balanceInfo.data.free - balanceInfo.data.frozen;
    return t > BigInt(0) ? t : BigInt(0);
  }, [balanceInfo]);

  const transferableHip = useMemo(
    () => formatPlanckToHip(transferablePlanck),
    [transferablePlanck],
  );

  const handleSend = () => {
    if (!balanceInfo?.data) {
      toast.error("Balance information not available. Please try again later.");
      return;
    }
    if (transferablePlanck <= BigInt(0)) {
      toast.error(
        "Your transferable balance is zero. Unstake or withdraw locked funds to free balance for sending.",
      );
      return;
    }
    if (transferablePlanck <= ESTIMATED_TRANSFER_FEE_PLANCK) {
      toast.error(
        `Your transferable balance (${transferableHip} hALPHA) is too low to cover the transaction fee. Please add funds to your account first.`,
      );
      return;
    }
    setSendDialogOpen(true);
  };

  return (
    <>
      <div
        className={cn(
          "flex flex-col items-center w-full h-[205px] rounded-[8px] border overflow-hidden",
          "bg-grey-light-300 border-grey-dark-100",
          "dark:bg-black-primary-bg dark:border-black-300",
          "shadow-[0px_1px_1.1px_rgba(0,0,0,0.04)]",
          className,
        )}
      >
        {/* Header */}
        <div className="flex h-[38px] w-full items-center pl-[14px] pr-[10px]">
          <div className="flex items-center gap-1">
            <BarChart className="size-[14px] text-primary-40 dark:text-primary-brand-dark" />
            <p className="font-mono font-medium text-[12px] leading-[18px] tracking-[-0.24px] text-primary-40 dark:text-primary-brand-dark uppercase">
              My Balance
            </p>
          </div>
        </div>

        {/* Inner panel — content stacks tightly at the top with a small
            gap between the headline and the "Last updated" row; the
            buttons get `mt-auto` to anchor at the bottom. (`justify-between`
            here would push the headline and status row apart with a
            huge mid-card gap that read as unintentional whitespace.) */}
        <div
          className={cn(
            "flex flex-col w-full flex-1 gap-1.5",
            "rounded-tl-[8px] rounded-tr-[8px] border-t border-grey-dark-100",
            "bg-white dark:bg-black-600 dark:border-black-300",
            "p-3",
          )}
        >
          {/* Headline stat. Fresh / unfunded accounts read as 0 hALPHA
              even when the underlying RPC call errored — the chain has
              no row for the account so there's nothing to surface beyond
              "no funds yet". A transient connectivity failure is
              communicated through the status row below (small warning +
              retry) instead of a blocky red ERROR. */}
          <div className="flex items-end justify-start gap-1">
            {isFetching ? (
              <div className="h-[30px] w-[140px] rounded bg-grey-light-700 dark:bg-grey-dark-200 animate-pulse" />
            ) : (
              <>
                <span className="font-mono font-medium text-[24px] leading-[30px] tracking-[-0.96px] text-grey-10 dark:text-white">
                  {balanceInfo?.data?.freeHip ?? "0"}
                </span>
                <span className="font-mono font-medium text-[12px] leading-[18px] tracking-[-0.48px] text-grey-10/50 dark:text-white/50 pb-[3px]">
                  hALPHA
                </span>
              </>
            )}
          </div>

          {/* Refresh / status row */}
          <div className="flex items-center gap-2">
            {isFetching ? (
              <div className="h-4 w-36 rounded bg-grey-light-700 dark:bg-grey-dark-200 animate-pulse" />
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => refetch()}
                  aria-label={
                    error ? "Retry loading balance" : "Refresh balance"
                  }
                  className={cn(
                    "flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[6px] border",
                    "bg-grey-light-700 border-grey-dark-100",
                    "dark:bg-black-primary-bg dark:border-black-300",
                    "transition-colors hover:bg-grey-light-800 dark:hover:bg-black-300/70",
                  )}
                >
                  <RefreshCcwDot className="size-3 text-black-700 dark:text-white opacity-40" />
                </button>
                {error ? (
                  <>
                    <Warning className="size-4 text-warning-70 shrink-0" />
                    <span className="text-[12px] text-warning-70 whitespace-nowrap">
                      Couldn&apos;t refresh balance
                    </span>
                  </>
                ) : (
                  <span className="font-mono font-medium text-[12px] tracking-[-0.48px] text-grey-10/50 dark:text-white/50 whitespace-nowrap">
                    Last updated <TimeAgo date={dataUpdatedAt} />
                  </span>
                )}
              </>
            )}
          </div>

          {/* Send/Receive actions — `mt-auto` snaps to bottom. */}
          <div className="grid grid-cols-2 gap-2 mt-auto">
            <Button
              variant="primary"
              size="auto"
              className="h-[36px] rounded-[8px] text-[13px] font-medium tracking-[-0.26px] gap-[7px]"
              onClick={() => setReceiveDialogOpen(true)}
              disabled={!walletAddress}
            >
              <InGoing className="size-2 shrink-0" />
              Receive
            </Button>
            <Button
              variant="defaultStable"
              size="auto"
              className="h-[36px] rounded-[8px] text-[13px] font-medium tracking-[-0.26px] gap-[7px]"
              onClick={handleSend}
              disabled={!walletAddress || isFetching || !!error}
            >
              <OutGoing className="size-2 shrink-0" />
              Send
            </Button>
          </div>
        </div>
      </div>

      <SendBalanceDialog
        open={sendDialogOpen}
        onClose={() => setSendDialogOpen(false)}
        availableBalancePlanck={transferablePlanck.toString()}
        availableBalanceHip={transferableHip}
        refetchBalance={() => {
          refetch();
          refetchSystemBalance?.();
          refetchTransactions?.();
        }}
        polkadotAddress={walletAddress}
      />

      <ReceiveBalanceDialog
        open={receiveDialogOpen}
        onClose={() => setReceiveDialogOpen(false)}
        polkadotAddress={walletAddress}
      />
    </>
  );
};

export default WalletBalanceCard;
