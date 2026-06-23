"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorMessage } from "@/lib/utils/errorUtils";
import { toast } from "sonner";

import { HAlphaCoinLogo, HippiusLogo } from "@/components/ui/icons";

import {
  WalletDialogShell,
  WalletDialogFooter,
} from "./shared/WalletDesign";
import TransactionFlowToast, {
  type TransactionFlowState,
} from "./shared/TransactionFlowToast";
import WalletPasswordField from "./shared/WalletPasswordField";
import { useStaking } from "@/lib/hooks/useStaking";
import { useLocalWallet } from "@/app/contexts/LocalWalletContext";
import { dispatchSigningError } from "@/lib/utils/dispatchTauriError";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { TxSubmittedUnconfirmedError } from "@/lib/utils/txOutcome";

interface WithdrawDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

/**
 * Withdraw dialog — a single-step dialog (unlike Send/Stake/Unstake
 * which use a separate confirmation). The password field lives directly
 * on this dialog: enter password, click Confirm Withdraw, done.
 */
const WithdrawDialog: React.FC<WithdrawDialogProps> = ({
  open,
  onClose,
  onSuccess,
}) => {
  const { stakingInfo, operations, refetch } = useStaking();
  const { verifyPassword } = useLocalWallet();
  const { logout } = useWalletAuth();
  const withdrawableHip = stakingInfo?.withdrawableHip ?? "0";
  // Gate on the raw planck value, not a float parse of the display string.
  const hasWithdrawable = useMemo(() => {
    try {
      return BigInt(stakingInfo?.withdrawable || "0") > 0n;
    } catch {
      return false;
    }
  }, [stakingInfo?.withdrawable]);

  const [flowState, setFlowState] = useState<TransactionFlowState>("idle");
  const [isMinimized, setIsMinimized] = useState(false);
  const [submittedAmount, setSubmittedAmount] = useState("");
  const isProcessingRef = useRef(false);

  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [verifyingPassword, setVerifyingPassword] = useState(false);

  // Reset password / error when the dialog reopens so a stale value
  // from a previous flow doesn't leak across confirmations.
  useEffect(() => {
    if (!open) return;
    refetch();
    setPassword("");
    setPasswordError(null);
    setVerifyingPassword(false);
  }, [open, refetch]);

  const runWithdrawFlow = useCallback(
    async (signingPassword: string) => {
      if (isProcessingRef.current) return;
      isProcessingRef.current = true;
      setFlowState("pending");
      setSubmittedAmount(withdrawableHip);
      try {
        await operations.withdrawUnbonded(signingPassword);
        setFlowState("success");
        await refetch();
        onSuccess?.();
      } catch (e: unknown) {
        if (e instanceof TxSubmittedUnconfirmedError) {
          // May already be on-chain — no retry. Balances were already
          // invalidated by the staking hook before this threw.
          setFlowState("submitted");
        } else {
          setFlowState("error");
          // Offer re-auth instead of a dead toast when the signing key is
          // unavailable (M-14).
          if (!dispatchSigningError(e, () => logout("/login?reauth=1"))) {
            toast.error("Withdraw failed", { description: errorMessage(e) });
          }
        }
      } finally {
        isProcessingRef.current = false;
      }
    },
    [operations, refetch, withdrawableHip, onSuccess, logout],
  );

  const handleConfirm = async () => {
    if (!hasWithdrawable) return;
    if (!password) {
      setPasswordError("Enter your wallet password");
      return;
    }
    setVerifyingPassword(true);
    setPasswordError(null);
    try {
      const ok = await verifyPassword(password);
      if (!ok) {
        setPasswordError("Incorrect password");
        return;
      }
      const signingPassword = password;
      setPassword("");
      onClose();
      setIsMinimized(true);
      await runWithdrawFlow(signingPassword);
    } catch (e) {
      setPasswordError(
        e instanceof Error ? e.message : "Failed to verify password",
      );
    } finally {
      setVerifyingPassword(false);
    }
  };

  const handleRetry = () => {
    // Bring the dialog back open so the user re-enters the password.
    setIsMinimized(false);
    setFlowState("idle");
  };

  const closeFlowToast = () => {
    setFlowState("idle");
    setIsMinimized(false);
    setSubmittedAmount("");
  };

  const showFlowToast = flowState !== "idle" && isMinimized;
  const showMainDialog = open && flowState === "idle";
  const confirmDisabled =
    !hasWithdrawable || !password.trim() || verifyingPassword;

  return (
    <>
      <WalletDialogShell
        open={showMainDialog}
        onClose={onClose}
        title="Withdraw hALPHA"
        description="Withdraw your redeemable hAlpha tokens on Hippius."
        icon={<HippiusLogo className="size-8" />}
        iconBgClassName="bg-transparent"
        maxWidth="max-w-[600px]"
        titleDescriptionGap="mt-2"
        footer={
          <WalletDialogFooter
            primaryLabel={verifyingPassword ? "Confirming..." : "Confirm Withdraw"}
            secondaryLabel="Cancel"
            onPrimaryClick={handleConfirm}
            onSecondaryClick={onClose}
            primaryDisabled={confirmDisabled}
            primaryLoading={verifyingPassword}
            secondaryDisabled={verifyingPassword}
          />
        }
      >
        <div className="space-y-4">
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
                  <HAlphaCoinLogo className="size-2.5" />
                </span>
              </div>
            </div>
            <p className="mt-3 text-[12px] font-medium leading-relaxed text-[#a6a6ab]">
              Tokens will be transferred to your wallet immediately after
              confirmation.
            </p>
          </div>

          <WalletPasswordField
            id="withdraw-password"
            value={password}
            onChange={(v) => {
              setPassword(v);
              if (passwordError) setPasswordError(null);
            }}
            error={passwordError}
            disabled={verifyingPassword || !hasWithdrawable}
            autoFocusOnOpen={open && hasWithdrawable}
            onSubmit={handleConfirm}
          />
        </div>
      </WalletDialogShell>

      {showFlowToast && (
        <TransactionFlowToast
          state={flowState as "pending" | "success" | "error" | "submitted"}
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
            submitted: {
              title: "Transaction submitted",
              description:
                "Your withdrawal may already be on-chain. Check your balance before retrying — do not submit again.",
            },
          }}
          onDismiss={closeFlowToast}
        />
      )}
    </>
  );
};

export default WithdrawDialog;
