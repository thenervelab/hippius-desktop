"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ArrowDown, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  AlphaCoinLogo,
  GasStation,
  HAlphaCoinLogo,
  HippiusLogo,
} from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { errorMessage } from "@/lib/utils/errorUtils";
import { formatUnitsTruncated, parseUnitsToBase } from "@/lib/utils/planckUnits";

import { WalletDialogShell } from "./shared/WalletDesign";
import WalletPasswordField from "./shared/WalletPasswordField";
import TransactionFlowToast, {
  type TransactionFlowState,
} from "./shared/TransactionFlowToast";

import { useLocalWallet } from "@/app/contexts/LocalWalletContext";
import { useBridge, type BridgeDirection } from "@/lib/hooks/api/useBridge";

/* ── Constants ────────────────────────────────────────────── */

/** Display-only — actual fee + timing live on the chain. Kept in sync
 *  with hippius-web's BRIDGE_CONFIG so the two clients show the same
 *  headline numbers. */
const ESTIMATED_TIME_SECONDS = 120;
const FEE_PERCENTAGE = 0.001; // 0.1%

/** Gas reserve subtracted from the hAlpha MAX so the bridge tx can pay
 *  its own fee. Mirrors `MAX_GAS_FEE_BUFFER_PLANCK` in
 *  `src-tauri/src/blockchain/transfers.rs`. */
const MAX_GAS_FEE_BUFFER_PLANCK = BigInt("10000000000000000");

/* ── Helpers ──────────────────────────────────────────────── */

const formatDisplayAmount = (amount: string) => {
  const num = parseFloat(amount);
  if (!Number.isFinite(num)) return amount || "0";
  if (num === 0) return "0";
  if (num >= 1) return num.toFixed(2);
  const s = num.toFixed(18).replace(/0+$/, "");
  return s.endsWith(".") ? `${s}0` : s;
};

/** Balance line: exactly two decimals (truncated), BigInt-safe — the
 *  balances exceed Number.MAX_SAFE_INTEGER, so `.toFixed(2)` on a float
 *  could show a rounded-up value the user can't actually bridge. */
const formatBalance2dp = (value: bigint, decimals: number) => {
  const s = formatUnitsTruncated(value, decimals, 2);
  const [whole, fraction = ""] = s.split(".");
  return `${whole}.${fraction.padEnd(2, "0")}`;
};

const parseBridgeError = (error: string | Error | unknown): string => {
  const errorStr = errorMessage(error);
  if (errorStr.toLowerCase().includes("insufficient")) return errorStr;
  if (errorStr.toLowerCase().includes("timeout")) {
    return "Transaction timed out. Please try again.";
  }
  if (
    errorStr.toLowerCase().includes("cancelled") ||
    errorStr.toLowerCase().includes("canceled")
  ) {
    return "Transaction was cancelled.";
  }
  return errorStr || "An unknown error occurred";
};

/* ── Token pill (matches hippius-web) ─────────────────────── */

const TokenBadge: React.FC<{
  token: "ALPHA" | "hALPHA";
  size?: "sm" | "lg";
}> = ({ token, size = "sm" }) => {
  const iconSize = size === "lg" ? "size-7" : "size-5";
  const logoSize = size === "lg" ? "size-4" : "size-3";
  const textSize = size === "lg" ? "text-[16px]" : "text-[14px]";
  const pillPadding = size === "lg" ? "px-3 py-1.5" : "px-2.5 py-1";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-full bg-[#e9e9e9] dark:bg-[#3a3a3a]",
        pillPadding,
      )}
    >
      <span
        className={cn(
          "flex items-center justify-center rounded-full",
          iconSize,
          token === "ALPHA"
            ? "bg-[#3167dd]"
            : "border border-[#d0d0d0] bg-white",
        )}
      >
        {token === "ALPHA" ? (
          <AlphaCoinLogo className={logoSize} />
        ) : (
          <HAlphaCoinLogo className={logoSize} />
        )}
      </span>
      <span
        className={cn(
          textSize,
          "font-medium leading-5 text-[#0a0a0a] dark:text-white",
        )}
      >
        {token}
      </span>
    </span>
  );
};

/* ── Component ────────────────────────────────────────────── */

interface BridgeDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

const BridgeDialog: React.FC<BridgeDialogProps> = ({
  open,
  onClose,
  onSuccess,
}) => {
  const bridge = useBridge();
  const { activeWallet, verifyPassword } = useLocalWallet();
  const { balances, balancesLoading, refetchBalances, stakedHotkeys } = bridge;

  const [bridgeDirection, setBridgeDirection] =
    useState<BridgeDirection>("alpha-to-halpha");
  const [amount, setAmount] = useState("");
  const [activeButton, setActiveButton] = useState<"max" | "50" | "25" | null>(
    null,
  );

  const [showConfirmation, setShowConfirmation] = useState(false);
  const [pendingBridgeAmount, setPendingBridgeAmount] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [verifyingPassword, setVerifyingPassword] = useState(false);

  const [flowState, setFlowState] = useState<TransactionFlowState>("idle");
  const [isMinimized, setIsMinimized] = useState(false);
  const [submittedAmount, setSubmittedAmount] = useState("");
  const isProcessingRef = useRef(false);

  /* Refresh balances whenever the dialog opens — keeps MAX honest if
   * a transfer landed since the last close. */
  useEffect(() => {
    if (!open) return;
    void refetchBalances();
    setAmount("");
    setActiveButton(null);
    // Reopening the dialog after a FINISHED bridge (success/error) clears that
    // bridge's lingering minimized toast so the new attempt starts on a clean
    // dialog. A still-running ("pending") bridge is intentionally left alone:
    // its progress toast must survive until it resolves, and a second
    // concurrent bridge is blocked at the confirm step below.
    if (flowState === "success" || flowState === "error") {
      setFlowState("idle");
      setIsMinimized(false);
      setSubmittedAmount("");
      setPendingBridgeAmount("");
      bridge.clearWizardSteps();
    }
    // Intentionally react ONLY to the dialog opening — reading `flowState` at
    // that moment is correct, and re-running on every `flowState`/`bridge`
    // change would wipe the amount field mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, refetchBalances]);

  /* Reset password whenever the confirm step opens so a stale value
   * can't leak across submissions. */
  useEffect(() => {
    if (!showConfirmation) return;
    setConfirmPassword("");
    setConfirmError(null);
    setVerifyingPassword(false);
  }, [showConfirmation]);

  const isAlphaToHAlpha = bridgeDirection === "alpha-to-halpha";
  const sourceToken: "ALPHA" | "hALPHA" = isAlphaToHAlpha ? "ALPHA" : "hALPHA";
  const destToken: "ALPHA" | "hALPHA" = isAlphaToHAlpha ? "hALPHA" : "ALPHA";
  const sourceDecimals = isAlphaToHAlpha ? 9 : 18;

  /* Source / destination balances come from the bridge hook — Alpha
   * stake on Bittensor (netuid 75) and free hAlpha on Hippius testnet.
   * Same wallet address, but the two chains live at separate testnet
   * endpoints so we can't reuse the per-account `useHippiusBalance`
   * (which targets the user's configured wss endpoint, defaulting to
   * mainnet).
   *
   *  alpha-to-halpha : source = staked Alpha, dest = free hAlpha
   *  halpha-to-alpha : source = free hAlpha (minus gas buffer), dest = staked Alpha
   */
  // Balances stay BigInt in the SOURCE/DEST token's own base units (audit
  // R-26): alpha is 9-decimal rao, hAlpha is 18-decimal planck, and both
  // overflow double precision at realistic sizes.
  const sourceBalancePlanck = useMemo<bigint | null>(() => {
    if (!balances) return null;
    if (isAlphaToHAlpha) return balances.alphaStake > 0n ? balances.alphaStake : 0n;
    const after = balances.hAlpha - MAX_GAS_FEE_BUFFER_PLANCK;
    return after > 0n ? after : 0n;
  }, [balances, isAlphaToHAlpha]);

  const destBalancePlanck = useMemo<bigint | null>(() => {
    if (!balances) return null;
    if (isAlphaToHAlpha) return balances.hAlpha > 0n ? balances.hAlpha : 0n;
    return balances.alphaStake > 0n ? balances.alphaStake : 0n;
  }, [balances, isAlphaToHAlpha]);

  const destDecimals = isAlphaToHAlpha ? 18 : 9;

  /* Per-direction minimum sourced from the Rust BridgeConfig so the
   * hint matches the chain-enforced floor. In source base units. */
  const minAmountPlanck = useMemo<bigint>(() => {
    if (!bridge.config) return 0n;
    const planck = isAlphaToHAlpha
      ? bridge.config.minAlphaPlanck
      : bridge.config.minHalphaPlanck;
    try {
      return BigInt(planck);
    } catch {
      return 0n;
    }
  }, [bridge.config, isAlphaToHAlpha]);

  const handleSwapBridgeDirection = useCallback(() => {
    setBridgeDirection((prev) =>
      prev === "alpha-to-halpha" ? "halpha-to-alpha" : "alpha-to-halpha",
    );
    setAmount("");
    setActiveButton(null);
  }, []);

  const handleAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    if (value === "" || /^\d*\.?\d*$/.test(value)) {
      setAmount(value);
      setActiveButton(null);
    }
  };

  const handlePercentClick = (
    pct: 100 | 50 | 25,
    key: "max" | "50" | "25",
  ) => {
    if (sourceBalancePlanck === null) return;
    const next = (sourceBalancePlanck * BigInt(pct)) / 100n;
    // Truncated to 6 decimals, so the typed amount never exceeds available.
    setAmount(next > 0n ? formatUnitsTruncated(next, sourceDecimals) : "");
    setActiveButton(key);
  };

  // The typed amount in source base units; null = unparseable.
  const amountPlanck = useMemo(
    () => parseUnitsToBase(amount, sourceDecimals),
    [amount, sourceDecimals],
  );
  const displayAmount = amount && amountPlanck !== null && amountPlanck > 0n ? amount : "0.00";

  const isAmountValid = useMemo(() => {
    if (amountPlanck === null || amountPlanck <= 0n) return false;
    if (minAmountPlanck > 0n && amountPlanck < minAmountPlanck) return false;
    if (sourceBalancePlanck === null) return true;
    return amountPlanck <= sourceBalancePlanck;
  }, [amountPlanck, minAmountPlanck, sourceBalancePlanck]);

  const handleBridgeSubmit = () => {
    if (!amount || amountPlanck === null || amountPlanck <= 0n) {
      toast.error("Please enter a valid amount to bridge");
      return;
    }
    if (!activeWallet) {
      toast.error("No active wallet — create or unlock one first.");
      return;
    }
    if (minAmountPlanck > 0n && amountPlanck < minAmountPlanck) {
      toast.error(
        `Minimum bridge amount is ${formatBalance2dp(minAmountPlanck, sourceDecimals)} ${sourceToken}`,
      );
      return;
    }
    if (sourceBalancePlanck !== null && amountPlanck > sourceBalancePlanck) {
      toast.error(`Amount exceeds your ${sourceToken} balance`);
      return;
    }
    setPendingBridgeAmount(amount);
    setShowConfirmation(true);
  };

  const toPlanckString = useCallback(
    (decimalStr: string): string | null =>
      parseUnitsToBase(decimalStr, sourceDecimals)?.toString() ?? null,
    [sourceDecimals],
  );

  const runBridgeFlow = useCallback(
    async (decimalAmount: string, password: string) => {
      if (isProcessingRef.current) return;
      isProcessingRef.current = true;
      setFlowState("pending");
      setSubmittedAmount(decimalAmount);
      bridge.clearWizardSteps();

      try {
        const planck = toPlanckString(decimalAmount);
        if (!planck) throw new Error("Invalid amount");

        if (isAlphaToHAlpha) {
          // Auto-pick the hotkey with the most stake — same heuristic
          // hippius-web uses before the picker selection lands. Falls
          // back to undefined (= BRIDGE_CONFIG default) if the wallet
          // has no stake on the configured netuid.
          const hotkey = stakedHotkeys[0]?.hotkey;
          await bridge.submitAlphaToHalpha({
            amount: planck,
            hotkey,
            password,
          });
        } else {
          // Bridge back to the same SS58 on Bittensor by default —
          // mirrors web's `recipientAddress || senderAddress`.
          await bridge.submitHalphaToAlpha({
            amount: planck,
            recipientAddress: activeWallet?.address ?? "",
            password,
          });
        }

        setFlowState("success");
        await refetchBalances();
        onSuccess?.();
      } catch (e: unknown) {
        const msg = parseBridgeError(e);
        setFlowState("error");
        toast.error("Bridge failed", { description: msg });
      } finally {
        isProcessingRef.current = false;
      }
    },
    [
      activeWallet?.address,
      bridge,
      isAlphaToHAlpha,
      onSuccess,
      refetchBalances,
      stakedHotkeys,
      toPlanckString,
    ],
  );

  const handleConfirmBridge = async () => {
    if (!pendingBridgeAmount) {
      setShowConfirmation(false);
      return;
    }
    // Guard against a second concurrent bridge while one is still in flight —
    // the dialog can now be opened during a "pending" bridge, but submitting
    // another (multi-signature) bridge in parallel is unsafe.
    if (flowState === "pending") {
      setConfirmError(
        "A bridge is already in progress. Please wait for it to finish.",
      );
      return;
    }
    if (!confirmPassword) {
      setConfirmError("Enter your wallet password.");
      return;
    }
    setVerifyingPassword(true);
    setConfirmError(null);
    try {
      const ok = await verifyPassword(confirmPassword);
      if (!ok) {
        setConfirmError("Incorrect password.");
        return;
      }
      const decimal = pendingBridgeAmount;
      const password = confirmPassword;

      setShowConfirmation(false);
      setConfirmPassword("");
      setAmount("");
      setIsMinimized(true);
      onClose();
      await runBridgeFlow(decimal, password);
    } catch (e) {
      setConfirmError(
        errorMessage(e),
      );
    } finally {
      setVerifyingPassword(false);
    }
  };

  const handleRetryBridge = () => {
    // Re-open the confirmation so the user can re-enter the password
    // instead of running with a stale credential.
    setIsMinimized(false);
    setFlowState("idle");
    setShowConfirmation(true);
  };

  const handleCloseBridgeConfirmation = () => {
    setShowConfirmation(false);
    setPendingBridgeAmount("");
    setConfirmPassword("");
    setConfirmError(null);
  };

  const handleClose = () => {
    setAmount("");
    setActiveButton(null);
    onClose();
  };

  const closeFlowDialogs = () => {
    setFlowState("idle");
    setIsMinimized(false);
    setSubmittedAmount("");
    setPendingBridgeAmount("");
    bridge.clearWizardSteps();
  };

  const showFlowToast = flowState !== "idle" && isMinimized;
  // The dialog must open whenever the user asks (`open`), independent of any
  // in-flight/finished bridge whose toast is showing. Gating this on
  // `flowState === "idle"` was the bug that made "Bridge Tokens" do nothing
  // while a progress toast was visible.
  const showMainDialog = open && !showConfirmation;

  /* ── Render ──────────────────────────────────────────────── */

  return (
    <>
      {/* Main bridge dialog */}
      <WalletDialogShell
        open={showMainDialog}
        onClose={handleClose}
        title={isAlphaToHAlpha ? "Bridge to hAlpha" : "Bridge to Alpha"}
        description={
          isAlphaToHAlpha
            ? "Bridge your tokens from Bittensor to Hippius"
            : "Bridge your tokens from Hippius to Bittensor"
        }
        icon={<HippiusLogo className="size-8" />}
        iconBgClassName="bg-transparent"
        iconTitleGap="mt-4 mb-0"
        titleDescriptionGap="mt-0"
        maxWidth="max-w-[640px]"
        contentClassName="px-4 pb-4 pt-5 sm:px-5 sm:pb-5"
        footer={
          <div className="space-y-4">
            <Button
              type="button"
              variant="primary"
              className="h-[44px] w-full rounded-[10px] px-4 text-[15px] font-medium tracking-[-0.3px]"
              onClick={handleBridgeSubmit}
              disabled={!isAmountValid || bridge.configLoading}
            >
              Bridge
            </Button>

            {/* Bridge info footer — Best price + Estimated Time + Gas */}
            <div className="rounded-[14px] bg-[#f4f4f4] px-4 py-3 dark:bg-[#2a2a2a]">
              <div className="mb-2">
                <span className="rounded-[4px] bg-[#d4edda] px-2 py-0.5 text-[12px] font-semibold text-[#1e7e34] dark:bg-[#1e3a2a] dark:text-[#6fcf97]">
                  Best price
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-medium text-[#7d7d7d]">
                  Estimated Time
                </span>
                <span className="text-[13px] font-medium text-[#0a0a0a] dark:text-white">
                  ~{ESTIMATED_TIME_SECONDS} Seconds
                </span>
              </div>
              <div className="mt-1.5 flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className="text-[13px] font-medium text-[#7d7d7d]">
                    Gas Fees
                  </span>
                  <GasStation className="size-3.5 text-[#7d7d7d]" />
                </div>
                <span className="text-[13px] font-medium text-[#0a0a0a] dark:text-white">
                  ~{(FEE_PERCENTAGE * 100).toFixed(1)}% Fees
                </span>
              </div>
            </div>
          </div>
        }
      >
        {/* Source / destination stack */}
        <div className="relative">
          {/* Source */}
          <div className="rounded-[14px] bg-[#f4f4f4] px-4 pb-4 pt-4 dark:bg-[#2a2a2a]">
            <div className="flex items-start justify-between gap-3">
              <input
                type="text"
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={handleAmountChange}
                className="w-0 flex-1 bg-transparent text-[32px] font-semibold leading-[38px] tracking-[-0.64px] text-[#0a0a0a] outline-none placeholder:text-[#c5c5c5] dark:text-white dark:placeholder:text-[#555]"
              />
              <TokenBadge token={sourceToken} />
            </div>

            <div className="mt-2 flex items-center justify-between">
              <span className="text-[13px] font-medium text-[#0a0a0a] dark:text-white">
                Min:{" "}
                {minAmountPlanck > 0n
                  ? `${formatBalance2dp(minAmountPlanck, sourceDecimals)} ${sourceToken}`
                  : "--"}
              </span>
              <span className="text-[13px] font-medium text-[#0a0a0a] dark:text-white">
                You have:{" "}
                {balancesLoading ? (
                  <span className="inline-block h-3 w-16 animate-pulse rounded bg-[#dcdcdc] align-middle dark:bg-[#3a3a3a]" />
                ) : sourceBalancePlanck === null ? (
                  <span className="text-[#7d7d7d]">— {sourceToken}</span>
                ) : (
                  <>
                    <span className="font-semibold">
                      {formatBalance2dp(sourceBalancePlanck, sourceDecimals)}
                    </span>
                    {` ${sourceToken}`}
                  </>
                )}
              </span>
            </div>

            <div className="mt-2 flex items-center justify-between">
              <span />
              <div className="flex items-center gap-2">
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
                    onClick={() => handlePercentClick(pct, key)}
                    disabled={sourceBalancePlanck === null || balancesLoading}
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
            </div>
          </div>

          {/* Centered swap-direction button */}
          <div className="relative z-10 flex justify-center -my-3">
            <button
              type="button"
              onClick={handleSwapBridgeDirection}
              className="flex size-8 items-center justify-center rounded-full border-[3px] border-white bg-[#f4f4f4] text-[#7d7d7d] transition-colors hover:bg-[#e9e9e9] dark:border-[#1a1a1a] dark:bg-[#3a3a3a] dark:hover:bg-[#444]"
              aria-label="Swap bridge direction"
            >
              <ArrowDown className="size-4" />
            </button>
          </div>

          {/* Destination */}
          <div className="rounded-[14px] bg-[#f4f4f4] px-4 pb-4 pt-4 dark:bg-[#2a2a2a]">
            <div className="flex items-start justify-between gap-3">
              <span className="text-[32px] font-semibold leading-[38px] tracking-[-0.64px] text-[#0a0a0a] dark:text-white">
                {displayAmount}
              </span>
              <TokenBadge token={destToken} />
            </div>
            <div className="mt-2 flex items-end justify-end">
              <span className="text-[13px] font-medium text-[#0a0a0a] dark:text-white">
                You have:{" "}
                {balancesLoading ? (
                  <span className="inline-block h-3 w-16 animate-pulse rounded bg-[#dcdcdc] align-middle dark:bg-[#3a3a3a]" />
                ) : destBalancePlanck === null ? (
                  <span className="text-[#7d7d7d]">— {destToken}</span>
                ) : (
                  <>
                    <span className="font-semibold">
                      {formatBalance2dp(destBalancePlanck, destDecimals)}
                    </span>
                    {` ${destToken}`}
                  </>
                )}
              </span>
            </div>
          </div>
        </div>
      </WalletDialogShell>

      {/* Confirmation dialog */}
      <WalletDialogShell
        open={showConfirmation}
        onClose={handleCloseBridgeConfirmation}
        title={
          isAlphaToHAlpha ? "Bridge Alpha to hAlpha" : "Bridge hAlpha to Alpha"
        }
        icon={<HippiusLogo className="size-8" />}
        iconBgClassName="bg-transparent"
        iconTitleGap="mt-4 mb-0"
        titleDescriptionGap="mt-0"
        maxWidth="max-w-[640px]"
        contentClassName="px-4 pb-4 pt-5 sm:px-5 sm:pb-5"
        footer={
          <div className="flex gap-4">
            <Button
              type="button"
              variant="defaultStable"
              className="h-[40px] flex-1 rounded-[6px] border border-[#e3e3e3] bg-[#fefefe] px-4 text-[13px] font-medium tracking-[-0.26px] text-[#4f4f4f] dark:border-[#494949] dark:bg-[#2a2a2a] dark:text-white"
              onClick={handleCloseBridgeConfirmation}
              disabled={verifyingPassword}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              className="h-[40px] flex-1 rounded-[6px] px-4 text-[14px] font-medium tracking-[-0.28px]"
              onClick={handleConfirmBridge}
              disabled={verifyingPassword || !confirmPassword.trim()}
            >
              {verifyingPassword ? "Processing..." : "Confirm Bridge"}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          {/* Info card — direction-specific */}
          <div className="mt-4 rounded-[14px] border border-[#3167DD] bg-[#3167DD33] px-3 py-2 dark:border-[#4a7aff] dark:bg-[#1e2d50]">
            {isAlphaToHAlpha ? (
              <>
                <p className="text-[10px] font-bold leading-5 text-[#3167DD] dark:text-[#6b9aff]">
                  Multiple Wallet Confirmations Required
                </p>
                <p className="mt-1 text-[10px] font-medium leading-[16px] text-[#3167DD] dark:text-[#6b9aff]">
                  This bridge operation requires{" "}
                  <strong>3 wallet signatures</strong> on Bittensor:
                </p>
                <ol className="mt-2 text-[10px] font-medium leading-[16px] text-[#3167DD] dark:text-[#6b9aff]">
                  <li>
                    <strong>1. Add Proxy</strong> – Authorize the escrow
                    contract on Bittensor
                  </li>
                  <li>
                    <strong>2. Deposit Alpha</strong> – Deposit your staked
                    Alpha into the bridge contract
                  </li>
                  <li>
                    <strong>3. Remove Proxy</strong> – Revoke bridge access on
                    Bittensor
                  </li>
                </ol>
                <p className="mt-2 text-[10px] leading-[16px] text-[#3167DD] dark:text-[#6b9aff]">
                  After these steps, guardians will mint hAlpha on Hippius.
                </p>
              </>
            ) : (
              <>
                <p className="text-[10px] font-bold leading-5 text-[#3167DD] dark:text-[#6b9aff]">
                  Bridge Info
                </p>
                <p className="mt-1 text-[10px] font-medium leading-[16px] text-[#3167DD] dark:text-[#6b9aff]">
                  Your hAlpha will be burned on Hippius and the equivalent
                  Alpha will be released to your staked balance on Bittensor
                  (not free balance).
                </p>
              </>
            )}
          </div>

          {/* Stacked amount displays with center arrow */}
          <div className="relative">
            <div className="rounded-[14px] bg-[#f4f4f4] px-4 py-4 dark:bg-[#2a2a2a]">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[28px] font-semibold leading-[34px] tracking-[-0.56px] text-[#0a0a0a] dark:text-white">
                  {formatDisplayAmount(pendingBridgeAmount)}
                </span>
                <TokenBadge token={sourceToken} size="lg" />
              </div>
            </div>

            <div className="relative z-10 flex justify-center -my-3">
              <span className="flex size-8 items-center justify-center rounded-full border-[3px] border-white bg-[#f4f4f4] text-[#7d7d7d] dark:border-[#1a1a1a] dark:bg-[#3a3a3a]">
                <ArrowDown className="size-4" />
              </span>
            </div>

            <div className="rounded-[14px] bg-[#f4f4f4] px-4 py-4 dark:bg-[#2a2a2a]">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[28px] font-semibold leading-[34px] tracking-[-0.56px] text-[#0a0a0a] dark:text-white">
                  {formatDisplayAmount(pendingBridgeAmount)}
                </span>
                <TokenBadge token={destToken} size="lg" />
              </div>
            </div>
          </div>

          {/* What to expect */}
          <div className="rounded-[14px] bg-[#f4f4f4] px-4 py-4 dark:bg-[#2a2a2a]">
            <p className="text-[14px] font-semibold leading-5 text-[#0a0a0a] dark:text-white">
              What To Expect:
            </p>
            <ul className="mt-3 space-y-2">
              <li className="flex items-center gap-2.5">
                <CheckCircle2 className="size-[18px] shrink-0 text-[#04C870]" />
                <span className="text-[13px] leading-5 text-[#7d7d7d]">
                  Guardians will process your transaction
                </span>
              </li>
              <li className="flex items-center gap-2.5">
                <CheckCircle2 className="size-[18px] shrink-0 text-[#04C870]" />
                <span className="text-[13px] leading-5 text-[#7d7d7d]">
                  Track progress in the Bridge Transactions widget
                </span>
              </li>
              <li className="flex items-center gap-2.5">
                <CheckCircle2 className="size-[18px] shrink-0 text-[#04C870]" />
                <span className="text-[13px] leading-5 text-[#7d7d7d]">
                  Processing typically takes ~{ESTIMATED_TIME_SECONDS} seconds
                </span>
              </li>
            </ul>
          </div>

          {/* Password — desktop signs with the local wallet, so the
              password is collected inline here instead of via an
              extension prompt the way hippius-web does. */}
          <WalletPasswordField
            id="bridge-confirm-password"
            value={confirmPassword}
            onChange={(v) => {
              setConfirmPassword(v);
              if (confirmError) setConfirmError(null);
            }}
            error={confirmError}
            disabled={verifyingPassword}
            autoFocusOnOpen={showConfirmation}
            onSubmit={handleConfirmBridge}
          />
        </div>
      </WalletDialogShell>

      {/* Minimized progress toast */}
      {showFlowToast && (
        <TransactionFlowToast
          state={flowState as "pending" | "success" | "error"}
          config={{
            pending: {
              title: `Bridging ${sourceToken} to ${destToken}…`,
              description: isAlphaToHAlpha
                ? "Follow the progress steps. Confirm wallet transactions."
                : "Submitting your bridge transaction on Hippius.",
            },
            success: {
              title: "Bridge Initiated Successfully",
              description: `${formatDisplayAmount(submittedAmount)} ${sourceToken} is being bridged to ${destToken}.`,
            },
            error: {
              title: "Something went wrong",
              description: "We couldn't complete the bridge.",
              action: {
                label: "Try Again",
                onClick: handleRetryBridge,
              },
            },
          }}
          onDismiss={closeFlowDialogs}
        />
      )}
    </>
  );
};

export default BridgeDialog;
