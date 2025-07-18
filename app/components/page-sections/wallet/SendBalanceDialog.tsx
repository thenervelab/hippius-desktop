/* eslint-disable @typescript-eslint/no-explicit-any */
import * as Dialog from "@radix-ui/react-dialog";
import React, { useState } from "react";
import { Label } from "@/components/ui/label";
import DialogContainer from "../../ui/dialog-container";
import { AbstractIconWrapper, CardButton, Icons, Input } from "../../ui";
import { AlertCircle } from "lucide-react";

import { toast } from "sonner";
import { invoke } from "@tauri-apps/api/core";
import { isAddress } from "@polkadot/util-crypto";
import SendBalanceConfirmationDialog from "./SendBalanceConfirmationDialog";

// Use string to preserve precision for very small values
export const TRANSACTION_FEE = "0.000000000270233151"; // hALPHA

export interface SendBalanceDialogProps {
  open: boolean;
  onClose: () => void;
  availableBalance: number | undefined;
  mnemonic: string;
  refetchBalance?: () => void;
  polkadotAddress: string;
}

const SendBalanceDialog: React.FC<SendBalanceDialogProps> = ({
  open,
  onClose,
  availableBalance,
  mnemonic,
  refetchBalance,
  polkadotAddress,
}) => {
  const [address, setAddress] = useState("");
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<{
    address?: string;
    amount?: string;
  }>({});
  const [showConfirmation, setShowConfirmation] = useState(false);
  const balanceAfterFee =
    availableBalance !== undefined
      ? Math.max(0, availableBalance - parseFloat(TRANSACTION_FEE))
      : 0;

  const handleSetMax = () => {
    // Set the amount to the maximum transferable value (balance minus fee)
    setAmount(balanceAfterFee.toString()); // Use 6 decimal places for clarity
    // Clear any amount error when max is set
    setErrors((prev) => ({ ...prev, amount: undefined }));
  };

  const validateForm = () => {
    const newErrors: { address?: string; amount?: string } = {};
    let isValid = true;

    // Address validation
    if (!address.trim()) {
      newErrors.address = "Address is required";
      isValid = false;
    } else if (!isAddress(address)) {
      newErrors.address = "Invalid address format";
      isValid = false;
    } else if (address.trim() === polkadotAddress) {
      newErrors.address = "Cannot send to your own address";
      isValid = false;
    }

    // Amount validation
    if (!amount.trim()) {
      newErrors.amount = "Amount is required";
      isValid = false;
    } else {
      const numAmount = parseFloat(amount);
      if (isNaN(numAmount)) {
        newErrors.amount = "Amount must be a valid number";
        isValid = false;
      } else if (numAmount <= 0) {
        newErrors.amount = "Amount must be greater than zero";
        isValid = false;
      } else if (availableBalance !== undefined) {
        // First check if amount alone exceeds balance
        if (numAmount > availableBalance) {
          newErrors.amount = "Amount exceeds your available balance";
          isValid = false;
        }
        // Then check if amount plus fee exceeds balance
        else if (numAmount + parseFloat(TRANSACTION_FEE) > availableBalance) {
          newErrors.amount = `Amount (incl. transaction fee) exceeds your balance`;
          isValid = false;
        }
      }
    }

    setErrors(newErrors);
    return isValid;
  };

  const handleOpenConfirmation = () => {
    if (!validateForm()) return;
    setShowConfirmation(true);
  };

  const handleCloseConfirmation = () => {
    setShowConfirmation(false);
  };

  const handleTransfer = async () => {
    setLoading(true);
    try {
      // Convert amount (string) to plancks (u128) with 18 decimals
      let planckAmount: string;
      if (!amount || isNaN(Number(amount))) {
        toast.error("Invalid amount");
        setLoading(false);
        return;
      }

      // Support both integer and decimal input
      const [whole, fraction = ""] = amount.split(".");
      const fractionPadded = (fraction + "0".repeat(18)).slice(0, 18);
      planckAmount = whole + fractionPadded;
      // Remove leading zeros
      planckAmount = planckAmount.replace(/^0+/, "");
      if (!planckAmount) planckAmount = "0";

      await invoke<string>("transfer_balance_tauri", {
        senderSeed: mnemonic,
        recipientAddress: address,
        amount: planckAmount,
      });

      toast.success("Transfer successful!", { duration: 3000 });

      // Refresh balance so UI is up to date
      refetchBalance?.();

      // Reset form & close
      onClose();
      setAddress("");
      setAmount("");
      setErrors({});
      setShowConfirmation(false);
    } catch (e: any) {
      toast.error("Transfer failed", {
        description: e.toString(),
        duration: 5000,
      });
    } finally {
      setLoading(false);
    }
  };

  const handleAddressChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setAddress(e.target.value);
    if (errors.address) setErrors((prev) => ({ ...prev, address: undefined }));
  };

  const handleAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setAmount(e.target.value);
    if (errors.amount) setErrors((prev) => ({ ...prev, amount: undefined }));
  };

  return (
    <>
      <Dialog.Root open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
        <DialogContainer className="md:inset-0 md:m-auto md:w-[90vw] md:max-w-[428px] h-fit">
          <Dialog.Title className="sr-only">Send Balance</Dialog.Title>
          {/* Mobile accent line */}
          <div className="h-4 bg-primary-50 md:hidden" />

          <div className="px-4">
            {/* Desktop Header */}
            <div className="hidden md:flex flex-col items-center justify-center pb-4 pt-4 gap-2">
              <div className="flex items-center mb-2 p-2">
                <AbstractIconWrapper className="size-8 sm:size-10">
                  <Icons.SendSquare className="absolute size-4 sm:size-6 text-primary-50" />
                </AbstractIconWrapper>
              </div>
              <span className="text-center text-2xl text-grey-10 font-medium">
                Send Balance
              </span>
            </div>

            {/* Mobile Header */}
            <div className="flex py-4 items-center justify-between text-grey-10 md:hidden">
              <span className="text-lg font-medium">Send Balance</span>
              <button onClick={onClose}>
                <Icons.CloseCircle className="size-6" />
              </button>
            </div>

            {/* Form Fields */}
            <div className="flex flex-col gap-4 mb-2">
              {/* Address */}
              <div className="flex flex-col gap-2 w-full text-grey-10">
                <Label
                  htmlFor="address"
                  className="text-sm font-medium text-grey-70"
                >
                  Recipient Address
                </Label>
                <Input
                  id="address"
                  placeholder="Enter Address"
                  type="text"
                  value={address}
                  onChange={handleAddressChange}
                  className={`border-grey-80 h-14 text-grey-30 w-full bg-transparent py-4 font-medium text-base rounded-lg duration-300 outline-none hover:shadow-input-focus placeholder-grey-60 focus:ring-offset-transparent focus:!shadow-input-focus ${errors.address ? "border-error-50" : ""}`}
                  disabled={loading}
                />
                {errors.address && (
                  <div className="flex items-center gap-2 text-error-70 text-sm font-medium mt-1">
                    <AlertCircle className="size-4" />
                    <span>{errors.address}</span>
                  </div>
                )}
              </div>

              {/* Amount */}
              <div className="flex flex-col gap-2 w-full text-grey-10">
                <Label
                  htmlFor="amount"
                  className="text-sm font-medium text-grey-70"
                >
                  Amount
                </Label>
                <div className="relative flex items-start w-full">
                  <Input
                    id="amount"
                    placeholder="Enter Amount"
                    type="text"
                    value={amount}
                    onChange={handleAmountChange}
                    className={`pr-24 border-grey-80 h-14 text-grey-30 w-full bg-transparent py-4 font-medium text-base rounded-lg duration-300 outline-none hover:shadow-input-focus placeholder-grey-60 focus:ring-offset-transparent focus:!shadow-input-focus ${errors.amount ? "border-error-50" : ""}`}
                    disabled={loading}
                  />
                  <div className="absolute right-3 top-[29px] -translate-y-1/2 flex items-center gap-2 text-base font-medium">
                    <span className="text-grey-10">hALPHA</span>
                    <button
                      onClick={handleSetMax}
                      className="text-primary-50 hover:text-primary-40"
                      disabled={loading}
                    >
                      Max
                    </button>
                  </div>
                </div>
                {errors.amount && (
                  <div className="flex items-center gap-2 text-error-70 text-sm font-medium mt-1">
                    <AlertCircle className="size-4" />
                    <span>{errors.amount}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Available Balance */}
            <div className="flex justify-between items-center">
              <span className="text-base leading-22px] font-medium text-grey-60">
                Available
              </span>
              <span className="text-sm font-medium text-success-50">
                {availableBalance ?? 0} hALPHA
              </span>
            </div>

            {/* Actions */}
            <div className="flex flex-col gap-4 my-4">
              <CardButton
                className="bg-primary-50 text-[18px] hover:bg-primary-40 transition text-white w-full font-medium"
                variant="dialog"
                onClick={handleOpenConfirmation}
                disabled={loading || !address.trim() || !amount.trim()}
                loading={loading}
              >
                {loading ? "Sending..." : "Send"}
              </CardButton>

              <CardButton
                className="w-full text-[18px]"
                variant="secondary"
                onClick={onClose}
                disabled={loading}
              >
                Cancel
              </CardButton>
            </div>
          </div>
        </DialogContainer>
      </Dialog.Root>

      <SendBalanceConfirmationDialog
        open={showConfirmation}
        onClose={handleCloseConfirmation}
        onConfirm={handleTransfer}
        loading={loading}
        recipientAddress={address}
        amount={amount}
      />
    </>
  );
};

export default SendBalanceDialog;
