"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { HippiusLogo } from "@/components/ui/icons";

import {
  WalletDialogShell,
  WalletDialogFooter,
} from "./shared/WalletDesign";
import TransactionFlowToast, {
  type TransactionFlowState,
} from "./shared/TransactionFlowToast";
import { useStaking } from "@/lib/hooks/useStaking";

/* Withdraw redeemable hALPHA dialog.
 *
 * Phase 3 of the wallet redesign. Single confirmation dialog (no
 * amount input) since withdraw consumes all withdrawable balance —
 * the user just confirms and the Rust IPC sweeps the chunks that
 * have finished their unbonding period.
 *
 * Rust IPC:
 *   - stake_withdraw_unbonded()  → no args, sweeps redeemable. */

interface WithdrawDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

const WithdrawDialog: React.FC<WithdrawDialogProps> = ({
  open,
  onClose,
  onSuccess,
}) => {
  const { stakingInfo, operations, refetch } = useStaking();
  const withdrawableHip = stakingInfo?.withdrawableHip ?? "0";
  const hasWithdrawable =
    !!withdrawableHip && Number.parseFloat(withdrawableHip) > 0;

  const [flowState, setFlowState] = useState<TransactionFlowState>("idle");
  const [isMinimized, setIsMinimized] = useState(false);
  const [submittedAmount, setSubmittedAmount] = useState("");
  const isProcessingRef = useRef(false);

  useEffect(() => {
    if (open) refetch();
  }, [open, refetch]);

  const runWithdrawFlow = useCallback(async () => {
    if (isProcessingRef.current) return;
    isProcessingRef.current = true;
    setFlowState("pending");
    setSubmittedAmount(withdrawableHip);
    try {
      await operations.withdrawUnbonded();
      setFlowState("success");
      await refetch();
      onSuccess?.();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setFlowState("error");
      toast.error("Withdraw failed", { description: msg });
    } finally {
      isProcessingRef.current = false;
    }
  }, [operations, refetch, withdrawableHip, onSuccess]);

  const handleConfirm = async () => {
    if (!hasWithdrawable) return;
    onClose();
    setIsMinimized(true);
    await runWithdrawFlow();
  };

  const handleRetry = async () => {
    await runWithdrawFlow();
  };

  const closeFlowToast = () => {
    setFlowState("idle");
    setIsMinimized(false);
    setSubmittedAmount("");
  };

  const showFlowToast = flowState !== "idle" && isMinimized;
  const showMainDialog = open && flowState === "idle";

  return (
    <>
      <WalletDialogShell
        open={showMainDialog}
        onClose={onClose}
        title="Withdraw hALPHA"
        description="Withdraw your redeemable hAlpha tokens on Hippius."
        icon={<HippiusLogo className="size-4 text-white" />}
        iconTitleGap="mt-4 mb-0"
        titleDescriptionGap="mt-0"
        maxWidth="max-w-[550px]"
        footer={
          <WalletDialogFooter
            primaryLabel="Confirm Withdraw"
            secondaryLabel="Cancel"
            onPrimaryClick={handleConfirm}
            onSecondaryClick={onClose}
            primaryDisabled={!hasWithdrawable}
          />
        }
      >
        <div className="rounded-[14px] bg-[#f4f4f4] px-4 py-4 dark:bg-[#2a2a2a]">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[14px] font-medium leading-[16.8px] text-[#a6a6ab]">
              Withdrawable
            </span>
            <div className="flex items-center gap-[7px]">
              <span className="text-[14px] font-medium leading-[16.8px] text-[#0a0a0a] dark:text-white">
                {withdrawableHip} hALPHA
              </span>
              <span className="flex size-4 items-center justify-center rounded-full border border-[#d0d0d0] bg-white">
                <HippiusLogo className="size-2.5 text-[#3167dd]" />
              </span>
            </div>
          </div>
          <p className="mt-3 text-[12px] font-medium leading-relaxed text-[#a6a6ab]">
            Tokens will be transferred to your wallet immediately after
            confirmation.
          </p>
        </div>
      </WalletDialogShell>

      {showFlowToast && (
        <TransactionFlowToast
          state={flowState as "pending" | "success" | "error"}
          config={{
            pending: {
              title: "Withdrawing hALPHA…",
              description: "Please wait while we process your withdrawal.",
            },
            success: {
              title: "hALPHA Withdrawn successfully",
              description: `${submittedAmount} hALPHA has been moved to your wallet`,
            },
            error: {
              title: "Something went wrong",
              description: "We couldn’t withdraw your tokens.",
              action: { label: "Try Again", onClick: handleRetry },
            },
          }}
          onDismiss={closeFlowToast}
        />
      )}
    </>
  );
};

export default WithdrawDialog;
