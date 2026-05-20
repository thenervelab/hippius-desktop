"use client";

import React, { useEffect, useRef, useState } from "react";
import { AlertCircle, Eye, EyeOff } from "lucide-react";

import { Input } from "@/components/ui";
import { HippiusLogo } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

import {
  WalletDialogShell,
  WalletDialogFooter,
} from "./shared/WalletDesign";
import { useLocalWallet } from "@/app/contexts/LocalWalletContext";

export interface WalletPasswordPromptProps {
  open: boolean;
  onClose: () => void;
  /** Called with the verified password once the user has entered it
   * correctly. The caller threads this into the signing IPC. */
  onConfirm: (password: string) => Promise<void> | void;
  /** Title shown above the password field (e.g. "Confirm Stake"). */
  title?: string;
  /** Sub-line shown under the title — usually a short reminder of what
   * the user is signing ("Sending 1.0 hALPHA to 5GjN…J96hG"). */
  description?: string;
  /** Whether the parent IPC is in flight, for the submit-button spinner
   * state. Independent from this component's own password-verify
   * state, which only blocks the form briefly. */
  loading?: boolean;
}

const WalletPasswordPrompt: React.FC<WalletPasswordPromptProps> = ({
  open,
  onClose,
  onConfirm,
  title = "Confirm with Password",
  description,
  loading,
}) => {
  const { verifyPassword } = useLocalWallet();
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset on reopen so a stale password / error from the previous
  // signing flow doesn't leak into the next one.
  useEffect(() => {
    if (!open) return;
    setPassword("");
    setShow(false);
    setError(null);
    setVerifying(false);
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [open]);

  const handleSubmit = async () => {
    if (!password) {
      setError("Enter your wallet password");
      return;
    }
    setVerifying(true);
    try {
      const ok = await verifyPassword(password);
      if (!ok) {
        setError("Incorrect password");
        return;
      }
      // Snapshot before clear so the IPC fires with the value even
      // though the prompt is closing.
      const submitted = password;
      setPassword("");
      onClose();
      await onConfirm(submitted);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to verify password");
    } finally {
      setVerifying(false);
    }
  };

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void handleSubmit();
    }
  };

  return (
    <WalletDialogShell
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      icon={<HippiusLogo className="size-4 text-white" />}
      iconTitleGap="mt-4 mb-0"
      titleDescriptionGap="mt-0"
      maxWidth="max-w-[460px]"
      contentClassName="px-4 pb-4 pt-5 sm:w-[400px] sm:px-5 sm:pb-5"
      footer={
        <WalletDialogFooter
          primaryLabel={loading || verifying ? "Confirming..." : "Confirm"}
          secondaryLabel="Cancel"
          onPrimaryClick={handleSubmit}
          onSecondaryClick={onClose}
          primaryLoading={loading || verifying}
          secondaryDisabled={loading || verifying}
        />
      }
    >
      <div className="space-y-2">
        <label
          htmlFor="wallet-password-prompt"
          className="text-[13px] font-medium text-grey-70 dark:text-grey-dark-800 block"
        >
          Wallet Password
        </label>
        <div className="relative">
          <Input
            id="wallet-password-prompt"
            ref={inputRef}
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (error) setError(null);
            }}
            onKeyDown={handleKey}
            type={show ? "text" : "password"}
            placeholder="Enter your wallet password"
            autoComplete="current-password"
            disabled={loading || verifying}
            className={cn(
              "h-12 text-base font-medium pr-10",
              error && "border-error-50",
            )}
          />
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-grey-50 dark:text-grey-dark-600"
            aria-label={show ? "Hide password" : "Show password"}
          >
            {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
        {error ? (
          <div className="flex items-center gap-2 text-error-70 text-sm font-medium">
            <AlertCircle className="size-4" />
            <span>{error}</span>
          </div>
        ) : null}
      </div>
    </WalletDialogShell>
  );
};

export default WalletPasswordPrompt;
