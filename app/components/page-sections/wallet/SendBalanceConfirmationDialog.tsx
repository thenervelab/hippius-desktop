"use client";

import React, { useEffect, useState } from "react";
import { HippiusLogo } from "@/components/ui/icons";
import {
  WalletDialogShell,
  WalletDialogFooter,
} from "./shared/WalletDesign";
import WalletPasswordField from "./shared/WalletPasswordField";
import { useLocalWallet } from "@/app/contexts/LocalWalletContext";

interface SendBalanceConfirmationDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called once the password verifies. Parent should run the actual
   *  transfer IPC with this password. */
  onConfirm: (password: string) => void | Promise<void>;
  /** Parent IPC in flight — drives the primary button's spinner. */
  loading: boolean;
  recipientAddress: string;
  amount: string;
}

/**
 * Confirm Transaction dialog. Previously this dialog only summarised the
 * transfer and a follow-up `WalletPasswordPrompt` collected the password;
 * the prompt has been collapsed into this dialog so the user enters the
 * password right where they confirm the action. Confirm button is gated
 * on a non-empty password so the user can't fire an empty submit.
 */
const SendBalanceConfirmationDialog: React.FC<
  SendBalanceConfirmationDialogProps
> = ({ open, onClose, onConfirm, loading, recipientAddress, amount }) => {
  const { verifyPassword } = useLocalWallet();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  // Reset password / error every time the dialog re-opens so a stale
  // value from a previous flow doesn't leak across confirmations.
  useEffect(() => {
    if (!open) return;
    setPassword("");
    setError(null);
    setVerifying(false);
  }, [open]);

  const truncatedRecipient =
    recipientAddress.length > 14
      ? `${recipientAddress.substring(0, 6)}...${recipientAddress.substring(
          recipientAddress.length - 4,
        )}`
      : recipientAddress;

  const busy = loading || verifying;

  const handleConfirm = async () => {
    if (!password) {
      setError("Enter your wallet password");
      return;
    }
    setVerifying(true);
    setError(null);
    try {
      const ok = await verifyPassword(password);
      if (!ok) {
        setError("Incorrect password");
        return;
      }
      const submitted = password;
      setPassword("");
      await onConfirm(submitted);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to verify password");
    } finally {
      setVerifying(false);
    }
  };

  return (
    <WalletDialogShell
      open={open}
      onClose={onClose}
      title="Confirm Transaction"
      description="Sending hAlpha tokens."
      icon={<HippiusLogo className="size-4 text-white" />}
      maxWidth="max-w-[600px]"
      titleDescriptionGap="mt-2"
      footer={
        <WalletDialogFooter
          primaryLabel={busy ? "Confirming..." : "Confirm Transfer"}
          secondaryLabel="Cancel"
          onPrimaryClick={handleConfirm}
          onSecondaryClick={onClose}
          primaryLoading={busy}
          primaryDisabled={!password.trim()}
          secondaryDisabled={busy}
        />
      }
    >
      <div className="space-y-4">
        <div className="rounded-[14px] bg-[#f4f4f4] px-4 py-4 dark:bg-[#2a2a2a]">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[14px] font-medium leading-[16.8px] text-[#a6a6ab]">
              Amount
            </span>
            <div className="flex items-center gap-[7px]">
              <span className="text-[14px] font-medium leading-[16.8px] text-[#0a0a0a] dark:text-white">
                {amount} hALPHA
              </span>
              <span className="flex justify-center items-center w-4 h-4 rounded-full border border-[#d0d0d0] bg-white">
                <HippiusLogo className="size-2.5 text-[#3167dd]" />
              </span>
            </div>
          </div>
          <div className="mt-2.5 flex items-center justify-between gap-3">
            <span className="text-[14px] font-medium leading-[16.8px] text-[#a6a6ab]">
              Recipient
            </span>
            <span className="text-[14px] font-medium leading-[16.8px] text-[#0a0a0a] dark:text-white">
              {truncatedRecipient}
            </span>
          </div>
        </div>

        <WalletPasswordField
          id="send-confirm-password"
          value={password}
          onChange={(v) => {
            setPassword(v);
            if (error) setError(null);
          }}
          error={error}
          disabled={busy}
          autoFocusOnOpen={open}
          onSubmit={handleConfirm}
        />
      </div>
    </WalletDialogShell>
  );
};

export default SendBalanceConfirmationDialog;
