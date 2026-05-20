"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { HippiusLogo } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

import {
  WalletDialogShell,
  WalletDialogFooter,
} from "./shared/WalletDesign";
import TransactionFlowToast, {
  type TransactionFlowState,
} from "./shared/TransactionFlowToast";
import { useStaking } from "@/lib/hooks/useStaking";
import { useHippiusBalance } from "@/lib/hooks/api/useHippiusBalance";

/* Stake hALPHA dialog.
 *
 * Phase 3 of the wallet redesign — ported from hippius-web's
 * StakeDialog onto WalletDialogShell, replacing the dual signer paths
 * with desktop's single local-wallet path through Rust IPCs.
 *
 * Three-step flow:
 *   1. Input dialog (amount + MAX/50%/25% chips + "You have" label).
 *   2. Confirmation dialog (action badge + amount).
 *   3. Minimized TransactionFlowToast (pending → success | error).
 *
 * Rust IPCs:
 *   - to_plancks(amount)            → HIP string → planck integer.
 *   - stake_bond(amount)            → submits bond_extra or bond
 *                                     (Rust auto-detects which). */

interface StakeDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

const StakeDialog: React.FC<StakeDialogProps> = ({
  open,
  onClose,
  onSuccess,
}) => {
  const { stakingInfo, operations, refetch } = useStaking();
  const { data: balanceInfo, refetch: refetchBalance } = useHippiusBalance();

  const [amount, setAmount] = useState("");
  const [activeButton, setActiveButton] = useState<
    "max" | "50" | "25" | null
  >(null);
  const [amountError, setAmountError] = useState<string | undefined>();
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [flowState, setFlowState] = useState<TransactionFlowState>("idle");
  const [isMinimized, setIsMinimized] = useState(false);
  const [submittedAmount, setSubmittedAmount] = useState("");
  const isProcessingRef = useRef(false);

  // Refetch fresh balance + staking data when the dialog opens so the
  // MAX button can't outrun an in-flight chain update.
  useEffect(() => {
    if (open) {
      refetch();
      refetchBalance();
    }
  }, [open, refetch, refetchBalance]);

  // Available HIP to bond = free balance from useHippiusBalance.
  // The Rust transfer_balance estimator reserves the gas buffer, but
  // stake_bond doesn't expose the same helper — fall back to the
  // already-formatted freeHip string for display + parse it for the
  // % shortcuts. That matches what the user sees in the balance card.
  const availableHip = useMemo(() => {
    const s = balanceInfo?.data?.freeHip ?? "0";
    const n = Number.parseFloat(s);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }, [balanceInfo]);

  const formattedAvailable = useMemo(() => {
    if (availableHip === 0) return "0";
    return availableHip.toFixed(6).replace(/\.?0+$/, "");
  }, [availableHip]);

  const handleAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    if (value === "" || /^\d*\.?\d*$/.test(value)) {
      setAmount(value);
      setActiveButton(null);
      if (amountError) setAmountError(undefined);
    }
  };

  const handlePercentClick = (pct: 100 | 50 | 25) => {
    const next = (availableHip * pct) / 100;
    // Floor to 6 decimals so we never exceed the displayed available.
    const truncated = Math.floor(next * 1e6) / 1e6;
    setAmount(truncated > 0 ? truncated.toFixed(6).replace(/\.?0+$/, "") : "");
    setActiveButton(pct === 100 ? "max" : pct === 50 ? "50" : "25");
    setAmountError(undefined);
  };

  const isAmountValid = useMemo(() => {
    const n = Number.parseFloat(amount);
    return (
      Number.isFinite(n) && n > 0 && Math.round(n * 1e6) <= Math.round(availableHip * 1e6)
    );
  }, [amount, availableHip]);

  const runStakeFlow = useCallback(
    async (hipAmount: string) => {
      if (isProcessingRef.current) return;
      isProcessingRef.current = true;
      setFlowState("pending");
      setSubmittedAmount(hipAmount);
      try {
        const planck = await invoke<string>("to_plancks", {
          amount: hipAmount,
        });
        await operations.bond(planck);
        setFlowState("success");
        await refetch();
        await refetchBalance();
        onSuccess?.();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        setFlowState("error");
        toast.error("Stake failed", { description: msg });
      } finally {
        isProcessingRef.current = false;
      }
    },
    [operations, refetch, refetchBalance, onSuccess],
  );

  const handleOpenConfirm = () => {
    if (!isAmountValid) {
      setAmountError("Enter an amount up to your available balance.");
      return;
    }
    setShowConfirmation(true);
  };

  const handleConfirmStake = async () => {
    if (!isAmountValid) {
      setShowConfirmation(false);
      return;
    }
    const submitted = amount;
    setAmount("");
    setActiveButton(null);
    setShowConfirmation(false);
    onClose();
    setIsMinimized(true);
    await runStakeFlow(submitted);
  };

  const handleRetryStake = async () => {
    if (!submittedAmount) {
      setFlowState("idle");
      setIsMinimized(false);
      return;
    }
    await runStakeFlow(submittedAmount);
  };

  const closeFlowToast = () => {
    setFlowState("idle");
    setIsMinimized(false);
    setSubmittedAmount("");
  };

  const showFlowToast = flowState !== "idle" && isMinimized;
  const showMainDialog = open && !showConfirmation && flowState === "idle";

  return (
    <>
      <WalletDialogShell
        open={showMainDialog}
        onClose={onClose}
        title="Stake"
        description="Stake your hAlpha tokens on Hippius"
        icon={<HippiusLogo className="size-4 text-white" />}
        iconTitleGap="mt-4 mb-0"
        titleDescriptionGap="mt-0"
        maxWidth="max-w-[550px]"
        contentClassName="px-4 pb-4 pt-5 sm:w-[420px] sm:px-5 sm:pb-5"
        footer={
          <Button
            type="button"
            variant="primary"
            className="h-[40px] w-full rounded-[6px] px-4 text-[14px] font-medium tracking-[-0.28px]"
            onClick={handleOpenConfirm}
            disabled={!isAmountValid || stakingInfo.isLoading}
          >
            Stake
          </Button>
        }
      >
        <div className="rounded-[14px] bg-[#f4f4f4] px-4 py-4 dark:bg-[#2a2a2a]">
          <div className="flex items-center justify-between gap-3">
            <input
              type="text"
              inputMode="decimal"
              value={amount}
              onChange={handleAmountChange}
              placeholder="0"
              className="w-full bg-transparent text-[32px] font-medium leading-none tracking-[-0.96px] text-[#171717] outline-none placeholder:text-[#171717]/40 dark:text-white dark:placeholder:text-white/40"
            />
            <div className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[#d5d5d5] bg-[#ececec] px-2.5 py-1 dark:border-[#494949] dark:bg-[#363636]">
              <span className="flex size-5 items-center justify-center rounded-full border border-[#d0d0d0] bg-white">
                <HippiusLogo className="size-3 text-[#3167dd]" />
              </span>
              <span className="text-[14px] font-semibold leading-[16.8px] text-[#171717] dark:text-white">
                hALPHA
              </span>
            </div>
          </div>

          <div className="mt-3 flex items-center justify-end">
            <span className="text-[14px] font-medium leading-[16.8px] text-[#171717] dark:text-white">
              You have:{" "}
              <span className="text-[#a0a0a0]">
                {formattedAvailable} hALPHA
              </span>
            </span>
          </div>

          <div className="mt-3 flex items-center justify-end gap-1.5">
            {(
              [
                { label: "MAX", key: "max" as const, pct: 100 as const },
                { label: "50%", key: "50" as const, pct: 50 as const },
                { label: "25%", key: "25" as const, pct: 25 as const },
              ]
            ).map(({ label, key, pct }) => (
              <button
                key={key}
                type="button"
                onClick={() => handlePercentClick(pct)}
                disabled={stakingInfo.isLoading || availableHip === 0}
                className={cn(
                  "rounded-full border px-2.5 py-0.5 text-[13px] font-semibold leading-5 tracking-[-0.26px] transition-colors disabled:opacity-60",
                  activeButton === key
                    ? "border-transparent bg-[#b7cbff] text-[#3167dd] dark:border-transparent dark:bg-[#1e3a7a] dark:text-[#6b9aff]"
                    : "border-[#dfdfdf] bg-[#e9e9e9] text-[#9a9a9a] hover:border-transparent hover:bg-[#b7cbff] hover:text-[#3167dd] dark:border-[#494949] dark:bg-[#363636] dark:text-[#808080] dark:hover:border-transparent dark:hover:bg-[#1e3a7a] dark:hover:text-[#6b9aff]",
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {amountError ? (
            <p className="mt-2 text-xs font-medium text-error-70">
              {amountError}
            </p>
          ) : null}
        </div>
      </WalletDialogShell>

      <WalletDialogShell
        open={showConfirmation && flowState === "idle"}
        onClose={() => setShowConfirmation(false)}
        title="Confirm Staking"
        description="Stake your hAlpha tokens on Hippius"
        icon={<HippiusLogo className="size-4 text-white" />}
        iconTitleGap="mt-4 mb-0"
        titleDescriptionGap="mt-0"
        maxWidth="max-w-[550px]"
        footer={
          <WalletDialogFooter
            primaryLabel="Confirm Stake"
            secondaryLabel="Cancel"
            onPrimaryClick={handleConfirmStake}
            onSecondaryClick={() => setShowConfirmation(false)}
          />
        }
      >
        <div className="rounded-[14px] bg-[#f4f4f4] px-4 py-4 dark:bg-[#2a2a2a]">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[14px] font-medium leading-[16.8px] text-[#a6a6ab]">
              Action
            </span>
            <span className="rounded-[6px] bg-[#dce7ff] px-2 py-0.5 text-[13px] font-medium leading-5 tracking-[-0.26px] text-[#3167dd] dark:bg-[#1e3a7a] dark:text-[#6b9aff]">
              Stake Tokens
            </span>
          </div>
          <div className="mt-2.5 flex items-center justify-between gap-3">
            <span className="text-[14px] font-medium leading-[16.8px] text-[#a6a6ab]">
              Amount
            </span>
            <div className="flex items-center gap-[7px]">
              <span className="text-[14px] font-medium leading-[16.8px] text-[#0a0a0a] dark:text-white">
                {amount} hALPHA
              </span>
              <span className="flex size-4 items-center justify-center rounded-full border border-[#d0d0d0] bg-white">
                <HippiusLogo className="size-2.5 text-[#3167dd]" />
              </span>
            </div>
          </div>
        </div>
      </WalletDialogShell>

      {showFlowToast && (
        <TransactionFlowToast
          state={flowState as "pending" | "success" | "error"}
          config={{
            pending: {
              title: "Staking hALPHA…",
              description: "Please wait while we process your staking transaction.",
            },
            success: {
              title: "hALPHA Staked successfully",
              description: `${submittedAmount} hALPHA has been staked to your account`,
            },
            error: {
              title: "Something went wrong",
              description: "We couldn’t stake your hALPHA.",
              action: { label: "Try Again", onClick: handleRetryStake },
            },
          }}
          onDismiss={closeFlowToast}
        />
      )}
    </>
  );
};

export default StakeDialog;
