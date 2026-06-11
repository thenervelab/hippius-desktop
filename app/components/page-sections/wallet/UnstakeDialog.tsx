"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { HAlphaCoinLogo, HippiusLogo } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { formatUnitsTruncated, parseUnitsToBase } from "@/lib/utils/planckUnits";
import { TxSubmittedUnconfirmedError } from "@/lib/utils/txOutcome";

import {
  WalletDialogShell,
  WalletDialogFooter,
} from "./shared/WalletDesign";
import TransactionFlowToast, {
  type TransactionFlowState,
} from "./shared/TransactionFlowToast";
import WalletPasswordField from "./shared/WalletPasswordField";
import { useLocalWallet } from "@/app/contexts/LocalWalletContext";
import { useStaking } from "@/lib/hooks/useStaking";

interface UnstakeDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

const UnstakeDialog: React.FC<UnstakeDialogProps> = ({
  open,
  onClose,
  onSuccess,
}) => {
  const { stakingInfo, operations, refetch } = useStaking();

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

  useEffect(() => {
    if (open) refetch();
  }, [open, refetch]);

  // BigInt planck end-to-end (audit R-26) — sourced from the raw planck
  // string, not the pre-formatted bondedHip, so no float ever rounds it.
  const bondedPlanck = useMemo(() => {
    try {
      const v = BigInt(stakingInfo?.bonded || "0");
      return v > 0n ? v : 0n;
    } catch {
      return 0n;
    }
  }, [stakingInfo]);

  const formattedBonded = useMemo(
    () => formatUnitsTruncated(bondedPlanck, 18),
    [bondedPlanck],
  );

  const handleAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    if (value === "" || /^\d*\.?\d*$/.test(value)) {
      setAmount(value);
      setActiveButton(null);
      if (amountError) setAmountError(undefined);
    }
  };

  const handlePercentClick = (pct: 100 | 50 | 25) => {
    const next = (bondedPlanck * BigInt(pct)) / 100n;
    const display = formatUnitsTruncated(next, 18);
    setAmount(next > 0n ? display : "");
    setActiveButton(pct === 100 ? "max" : pct === 50 ? "50" : "25");
    setAmountError(undefined);
  };

  const isAmountValid = useMemo(() => {
    const parsed = parseUnitsToBase(amount, 18);
    return parsed !== null && parsed > 0n && parsed <= bondedPlanck;
  }, [amount, bondedPlanck]);

  const runUnstakeFlow = useCallback(
    async (hipAmount: string, password: string) => {
      if (isProcessingRef.current) return;
      isProcessingRef.current = true;
      setFlowState("pending");
      setSubmittedAmount(hipAmount);
      try {
        const planck = await invoke<string>("to_plancks", {
          amount: hipAmount,
        });
        await operations.unbond(planck, password);
        setFlowState("success");
        await refetch();
        onSuccess?.();
      } catch (e: unknown) {
        if (e instanceof TxSubmittedUnconfirmedError) {
          // May already be on-chain — no retry. Balances were already
          // invalidated by the staking hook before this threw.
          setFlowState("submitted");
        } else {
          const msg = e instanceof Error ? e.message : String(e);
          setFlowState("error");
          toast.error("Unstake failed", { description: msg });
        }
      } finally {
        isProcessingRef.current = false;
      }
    },
    [operations, refetch, onSuccess],
  );

  const handleOpenConfirm = () => {
    if (!isAmountValid) {
      setAmountError("Enter an amount up to your bonded balance.");
      return;
    }
    setShowConfirmation(true);
  };

  // Inline password verification on the Confirm Unstaking dialog —
  // the separate WalletPasswordPrompt step has been collapsed into the
  // confirmation dialog so the user enters the password right where
  // they're confirming the action.
  const { verifyPassword } = useLocalWallet();
  const [confirmPassword, setConfirmPassword] = useState("");
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [verifyingPassword, setVerifyingPassword] = useState(false);

  useEffect(() => {
    if (!showConfirmation) return;
    setConfirmPassword("");
    setConfirmError(null);
    setVerifyingPassword(false);
  }, [showConfirmation]);

  const handleConfirmUnstake = async () => {
    if (!isAmountValid) {
      setShowConfirmation(false);
      return;
    }
    if (!confirmPassword) {
      setConfirmError("Enter your wallet password");
      return;
    }
    setVerifyingPassword(true);
    setConfirmError(null);
    try {
      const ok = await verifyPassword(confirmPassword);
      if (!ok) {
        setConfirmError("Incorrect password");
        return;
      }
      const submitted = amount;
      const password = confirmPassword;
      setConfirmPassword("");
      setAmount("");
      setActiveButton(null);
      setShowConfirmation(false);
      onClose();
      setIsMinimized(true);
      await runUnstakeFlow(submitted, password);
    } catch (e) {
      setConfirmError(
        e instanceof Error ? e.message : "Failed to verify password",
      );
    } finally {
      setVerifyingPassword(false);
    }
  };

  const handleRetryUnstake = () => {
    if (!submittedAmount) {
      setFlowState("idle");
      setIsMinimized(false);
      return;
    }
    setAmount(submittedAmount);
    setIsMinimized(false);
    setFlowState("idle");
    setShowConfirmation(true);
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
        title="Unstake hALPHA"
        description="Redeem your staked hAlpha tokens on Hippius"
        icon={<HippiusLogo className="size-4 text-white" />}
        maxWidth="max-w-[600px]"
        titleDescriptionGap="mt-2"
        footer={
          <Button
            type="button"
            variant="primary"
            className="h-[40px] w-full rounded-[6px] px-4 text-[14px] font-medium tracking-[-0.28px]"
            onClick={handleOpenConfirm}
            disabled={!isAmountValid || stakingInfo.isLoading}
          >
            Unstake
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
                <HAlphaCoinLogo className="size-3" />
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
                {formattedBonded} hALPHA Staked
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
                disabled={stakingInfo.isLoading || bondedPlanck === 0n}
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
        title="Confirm Unstaking"
        description="Redeem your staked hAlpha tokens"
        icon={<HippiusLogo className="size-4 text-white" />}
        maxWidth="max-w-[600px]"
        titleDescriptionGap="mt-2"
        footer={
          <WalletDialogFooter
            primaryLabel={verifyingPassword ? "Confirming..." : "Confirm Unstake"}
            secondaryLabel="Cancel"
            onPrimaryClick={handleConfirmUnstake}
            onSecondaryClick={() => setShowConfirmation(false)}
            primaryLoading={verifyingPassword}
            primaryDisabled={!confirmPassword.trim()}
            secondaryDisabled={verifyingPassword}
          />
        }
      >
        <div className="space-y-3">
          <div className="rounded-[14px] bg-[#f4f4f4] px-4 py-4 dark:bg-[#2a2a2a]">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[14px] font-medium leading-[16.8px] text-[#a6a6ab]">
                Action
              </span>
              <span className="rounded-[6px] bg-[#dce7ff] px-2 py-0.5 text-[13px] font-medium leading-5 tracking-[-0.26px] text-[#3167dd] dark:bg-[#1e3a7a] dark:text-[#6b9aff]">
                Unstake Tokens
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
                  <HAlphaCoinLogo className="size-2.5" />
                </span>
              </div>
            </div>
          </div>

          <div className="rounded-[14px] border border-[#3167DD] bg-[#3167DD33] dark:border-[#4a7aff] dark:bg-[#1e2d50] px-3 py-2">
            <p className="text-[10px] font-bold text-[#3167DD] dark:text-[#6b9aff] mb-1">
              Heads up
            </p>
            <p className="text-[10px] font-medium leading-relaxed text-[#3167DD] dark:text-[#6b9aff]">
              Tokens will be available to withdraw after the unbonding
              period completes. This transaction cannot be reversed once
              confirmed.
            </p>
          </div>

          <WalletPasswordField
            id="unstake-confirm-password"
            value={confirmPassword}
            onChange={(v) => {
              setConfirmPassword(v);
              if (confirmError) setConfirmError(null);
            }}
            error={confirmError}
            disabled={verifyingPassword}
            autoFocusOnOpen={showConfirmation}
            onSubmit={handleConfirmUnstake}
          />
        </div>
      </WalletDialogShell>

      {showFlowToast && (
        <TransactionFlowToast
          state={flowState as "pending" | "success" | "error" | "submitted"}
          config={{
            pending: {
              title: "Unstaking hALPHA…",
              description: "Please wait while we process your unstaking transaction.",
            },
            success: {
              title: "hALPHA Unstaked successfully",
              description: `${submittedAmount} hALPHA has been queued to unbond`,
            },
            error: {
              title: "Something went wrong",
              description: "We couldn’t unstake your hALPHA.",
              action: { label: "Try Again", onClick: handleRetryUnstake },
            },
            submitted: {
              title: "Transaction submitted",
              description:
                "Your unstake may already be on-chain. Check your balance before retrying — do not submit again.",
            },
          }}
          onDismiss={closeFlowToast}
        />
      )}

    </>
  );
};

export default UnstakeDialog;
