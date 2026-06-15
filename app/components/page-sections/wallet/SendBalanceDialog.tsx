"use client";

import React, { useCallback, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertCircle } from "lucide-react";
import { toast } from "sonner";

import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui";
import { Button } from "@/components/ui/button";
import { OutGoing } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

import AddressSelect from "./AddressSelect";
import SendBalanceConfirmationDialog from "./SendBalanceConfirmationDialog";
import { WalletDialogShell } from "./shared/WalletDesign";
import TransactionFlowToast, {
  type TransactionFlowState,
} from "./shared/TransactionFlowToast";
import { useAddressValidation } from "@/lib/hooks/useAddressValidation";

export interface SendBalanceDialogProps {
  open: boolean;
  onClose: () => void;
  /** Raw planck string — source of truth for the max calculation. */
  availableBalancePlanck: string;
  /** Pre-formatted HIP string from Rust (`planck_to_hip`) for display. */
  availableBalanceHip: string;
  refetchBalance?: () => void;
  polkadotAddress: string;
}

const SendBalanceDialog: React.FC<SendBalanceDialogProps> = ({
  open,
  onClose,
  availableBalancePlanck,
  availableBalanceHip,
  refetchBalance,
  polkadotAddress,
}) => {
  const {
    address,
    setAddress,
    addressError,
    handleAddressChange,
    validateAddress,
    clearAddressError,
  } = useAddressValidation({
    disallowedAddress: polkadotAddress,
    disallowedAddressMessage: "Cannot send to your own address",
  });

  const [amount, setAmount] = useState("");
  const [amountError, setAmountError] = useState<string | undefined>();
  const [activeButton, setActiveButton] = useState<"max" | null>(null);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [validatedPlanck, setValidatedPlanck] = useState<string | null>(null);

  // Minimized-toast lifecycle state. While the toast is showing, the
  // input + confirmation dialogs are hidden but their values stay in
  // state so a "Try Again" press can replay the same transfer.
  const [flowState, setFlowState] = useState<TransactionFlowState>("idle");
  const [isMinimized, setIsMinimized] = useState(false);
  const [submittedAmount, setSubmittedAmount] = useState("");
  const [submittedAddress, setSubmittedAddress] = useState("");
  const [loading, setLoading] = useState(false);
  const isProcessingRef = useRef(false);

  const handleSetMax = async () => {
    try {
      const { hip } = await invoke<{ planck: string; hip: string }>(
        "compute_max_transferable",
        { balancePlanck: availableBalancePlanck || "0" },
      );
      setAmount(hip);
      setAmountError(undefined);
      setActiveButton("max");
    } catch {
      setAmount("0");
      setAmountError(undefined);
    }
  };

  const handleAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setAmount(e.target.value);
    setActiveButton(null);
    if (amountError) setAmountError(undefined);
  };

  /* Client-side "amount > available" guard.
   *
   * The server-side `validate_send_balance` IPC also catches this, but
   * it only fires once the user clicks Send — by then they've already
   * typed an invalid number and clicked through, which reads as
   * surprise-rejection. Computing the error from the current input
   * lets the message appear as they type and the Send button can
   * disable immediately.
   *
   * We compare against the user-visible "Available" (transferable
   * balance, already net of frozen funds). The Rust IPC also subtracts
   * an additional gas-fee buffer; a number that's under the visible
   * available but over the gas-adjusted max still reaches the IPC,
   * which surfaces the precise "you can only send X after fees"
   * error. That two-layer fallback is intentional. */
  const numericAvailable = useMemo(() => {
    const s = (availableBalanceHip || "0").replace(/,/g, "").trim();
    const n = Number.parseFloat(s);
    return Number.isFinite(n) ? n : 0;
  }, [availableBalanceHip]);

  const overBalance = useMemo(() => {
    const trimmed = amount.trim();
    if (!trimmed) return false;
    const n = Number.parseFloat(trimmed);
    if (!Number.isFinite(n) || n <= 0) return false;
    return n > numericAvailable;
  }, [amount, numericAvailable]);

  const displayedAmountError = overBalance
    ? "Amount exceeds available balance"
    : amountError;

  // Calls validate_send_balance, which fetches the on-chain balance,
  // checks address + amount + fee, and returns the planck integer for
  // the eventual transfer_balance call. Returns null if validation
  // fails (error is set on the matching field).
  const validateForm = useCallback(async (): Promise<string | null> => {
    const addressValid = await validateAddress();
    if (!addressValid) return null;
    try {
      const result = await invoke<{
        planckAmount: string;
        estimatedFee: string;
        availableBalancePlanck: string;
      }>("validate_send_balance", {
        recipientAddress: address,
        amount,
      });
      setAmountError(undefined);
      return result.planckAmount;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setAmountError(msg);
      return null;
    }
  }, [address, amount, validateAddress]);

  const handleOpenConfirmation = async () => {
    const planck = await validateForm();
    if (!planck) return;
    setValidatedPlanck(planck);
    setShowConfirmation(true);
  };

  const handleCloseConfirmation = () => setShowConfirmation(false);

  const resetForm = useCallback(() => {
    setAddress("");
    setAmount("");
    setValidatedPlanck(null);
    clearAddressError();
    setAmountError(undefined);
    setActiveButton(null);
    setShowConfirmation(false);
  }, [setAddress, clearAddressError]);

  // Wraps the Rust submit. Runs after the user confirms; the dialog +
  // confirmation are hidden and the bottom-right toast surfaces flow
  // status until dismissed.
  const runTransferFlow = useCallback(
    async (
      planck: string,
      amountForToast: string,
      addrForToast: string,
      password: string,
    ) => {
      if (isProcessingRef.current) return;
      isProcessingRef.current = true;
      setLoading(true);
      setFlowState("pending");
      setSubmittedAmount(amountForToast);
      setSubmittedAddress(addrForToast);
      try {
        await invoke<{ txHash: string; success: boolean }>("transfer_balance", {
          recipientAddress: addrForToast,
          amount: planck,
          password,
        });
        setFlowState("success");
        refetchBalance?.();
        resetForm();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        setFlowState("error");
        toast.error("Transfer failed", { description: msg });
      } finally {
        setLoading(false);
        isProcessingRef.current = false;
      }
    },
    [refetchBalance, resetForm],
  );

  // The confirmation dialog now collects the password inline, so there's
  // no separate password-prompt step here. Retry surfaces the
  // confirmation dialog again instead of a dedicated password modal.
  const handleConfirmTransfer = async (password: string) => {
    if (!validatedPlanck) return;
    const amountForToast = amount;
    const addrForToast = address;
    const planckForRetry = validatedPlanck;
    setShowConfirmation(false);
    onClose();
    setIsMinimized(true);
    await runTransferFlow(
      planckForRetry,
      amountForToast,
      addrForToast,
      password,
    );
  };

  const handleRetryTransfer = async () => {
    if (!submittedAmount || !submittedAddress) {
      setFlowState("idle");
      setIsMinimized(false);
      return;
    }
    // Retry brings the confirmation dialog back so the user re-enters
    // the password before re-firing the transfer.
    setIsMinimized(false);
    setFlowState("idle");
    setShowConfirmation(true);
  };

  const closeFlowToast = () => {
    setFlowState("idle");
    setIsMinimized(false);
    setSubmittedAmount("");
    setSubmittedAddress("");
  };

  const showFlowToast = flowState !== "idle" && isMinimized;
  const showMainDialog = open && !showConfirmation && flowState === "idle";

  return (
    <>
      <WalletDialogShell
        open={showMainDialog}
        onClose={onClose}
        title="Send hALPHA"
        icon={<OutGoing className="size-3 text-white" />}
        maxWidth="max-w-[600px]"
        contentClassName="px-4 pb-4 pt-5 sm:px-5 sm:pb-5"
        footer={
          <div className="flex gap-4">
            <Button
              type="button"
              variant="defaultStable"
              className="h-[40px] flex-1 rounded-[6px] border border-[#e3e3e3] bg-[#fefefe] px-4 text-[13px] font-medium tracking-[-0.26px] text-[#4f4f4f] dark:border-[#494949] dark:bg-[#2a2a2a] dark:text-white"
              onClick={onClose}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              className="h-[40px] flex-1 rounded-[6px] px-4 text-[14px] font-medium tracking-[-0.28px]"
              onClick={handleOpenConfirmation}
              disabled={
                loading || !address.trim() || !amount.trim() || overBalance
              }
            >
              {loading ? "Sending..." : "Send"}
            </Button>
          </div>
        }
      >
        <div className="space-y-3.5">
          {/* Recipient field */}
          <div className="space-y-2">
            <Label
              htmlFor="recipient-address"
              className="text-[14px] font-medium leading-[normal] tracking-[-0.28px] text-[#7d7d7d]"
            >
              Recipient Address
            </Label>
            <AddressSelect
              value={address}
              onChange={handleAddressChange}
              error={addressError}
              disabled={loading}
              placeholder="Enter or choose from address book"
              wrapperClassName="!shadow-none focus-within:!shadow-none dark:!shadow-none dark:focus-within:!shadow-none"
            />
            {addressError ? (
              <div className="flex items-center gap-2 text-error-70 text-sm font-medium">
                <AlertCircle className="size-4" />
                <span>{addressError}</span>
              </div>
            ) : null}
          </div>

          {/* Amount field */}
          <div className="space-y-2">
            <Label
              htmlFor="amount"
              className="text-[14px] font-medium leading-[normal] tracking-[-0.28px] text-[#7d7d7d]"
            >
              Amount
            </Label>
            <Input
              id="amount"
              placeholder="Enter Amount"
              type="text"
              inputMode="decimal"
              value={amount}
              wrapperClassName="!shadow-none focus-within:!shadow-none dark:!shadow-none dark:focus-within:!shadow-none"
              onChange={(e) => {
                const value = e.target.value;
                // Only digits and one decimal point — guards the
                // Rust planck conversion from malformed input.
                if (value === "" || /^\d*\.?\d*$/.test(value)) {
                  handleAmountChange(e);
                }
              }}
              aria-invalid={!!displayedAmountError}
              disabled={loading}
              className={cn(displayedAmountError && "border-error-50")}
              endAdornment={
                <div className="flex items-center gap-2 pr-1 text-[13px] font-medium tracking-[-0.26px] text-[#171717] dark:text-white sm:text-[14px] sm:tracking-[-0.28px]">
                  <span>hALPHA</span>
                  <button
                    type="button"
                    onClick={handleSetMax}
                    disabled={loading}
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-[14px] font-medium leading-5 tracking-[-0.28px] transition-colors disabled:opacity-60",
                      activeButton === "max"
                        ? "border-transparent bg-[#b7cbff] text-[#3167dd] dark:border-transparent dark:bg-[#1e3a7a] dark:text-[#6b9aff]"
                        : "border-[#dfdfdf] bg-[#e9e9e9] text-[#9a9a9a] hover:border-transparent hover:bg-[#b7cbff] hover:text-[#3167dd] dark:border-[#494949] dark:bg-[#363636] dark:text-[#808080] dark:hover:border-transparent dark:hover:bg-[#1e3a7a] dark:hover:text-[#6b9aff]",
                    )}
                  >
                    MAX
                  </button>
                </div>
              }
            />
            {displayedAmountError ? (
              <div className="flex items-center gap-2 text-error-70 text-sm font-medium">
                <AlertCircle className="size-4" />
                <span>{displayedAmountError}</span>
              </div>
            ) : null}
          </div>

          {/* Available balance hint */}
          <div className="flex items-center justify-between pt-0.5 text-[14px] font-medium tracking-[-0.28px]">
            <span className="text-[#7d7d7d]">Available:</span>
            <span className="text-[#3167dd]">
              {availableBalanceHip || "0"} hALPHA
            </span>
          </div>
        </div>
      </WalletDialogShell>

      <SendBalanceConfirmationDialog
        open={showConfirmation}
        onClose={handleCloseConfirmation}
        onConfirm={handleConfirmTransfer}
        loading={loading}
        recipientAddress={address}
        amount={amount}
      />

      {showFlowToast && (
        <TransactionFlowToast
          state={flowState as "pending" | "success" | "error"}
          config={{
            pending: {
              title: "Sending hALPHA…",
              description: "Please wait while we process your transaction.",
            },
            success: {
              title: "hALPHA Sent successfully",
              description: `${submittedAmount} hALPHA has been sent successfully`,
            },
            error: {
              title: "Something went wrong",
              description: "We couldn’t send your hALPHA.",
              action: { label: "Try Again", onClick: handleRetryTransfer },
            },
          }}
          onDismiss={closeFlowToast}
        />
      )}

    </>
  );
};

export default SendBalanceDialog;
