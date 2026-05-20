"use client";

import React, { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui";
import { AlertCircle, Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

import { useLocalWallet } from "@/app/contexts/LocalWalletContext";

interface CreatePasswordScreenProps {
  mnemonic: string;
  /** Default name pre-filled in the input. Used so re-entering the
   * screen after a back-and-forth keeps the user's chosen name. */
  initialName?: string;
  onCreated: () => void;
  onBack: () => void;
}

const MIN_LEN = 8;

/* Final step of the create/import flows.
 *
 * Collects:
 *   - A wallet display name (defaults to "Main Wallet" — the user can
 *     rename later from the active-wallet selector).
 *   - A password used to encrypt the mnemonic at rest.
 *
 * On submit, calls the context's `createWallet`. The mnemonic is handed
 * off to Rust via `local_wallet_create` and never seen by this component
 * after the IPC resolves. */

const CreatePasswordScreen: React.FC<CreatePasswordScreenProps> = ({
  mnemonic,
  initialName,
  onCreated,
  onBack,
}) => {
  const { createWallet } = useLocalWallet();
  const [name, setName] = useState(initialName ?? "Main Wallet");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const validationError: string | null = useMemo(() => {
    if (!name.trim()) return "Wallet name is required";
    if (password.length < MIN_LEN) {
      return `Password must be at least ${MIN_LEN} characters`;
    }
    if (password !== confirm) return "Passwords don't match";
    return null;
  }, [name, password, confirm]);

  const handleSubmit = async () => {
    if (validationError) {
      setError(validationError);
      return;
    }
    setSubmitting(true);
    try {
      const ok = await createWallet(name.trim(), mnemonic, password);
      if (ok) {
        toast.success("Wallet created");
        onCreated();
      } else {
        setError("Failed to create wallet. Please try again.");
      }
    } catch (e) {
      console.error("Failed to create wallet:", e);
      setError(e instanceof Error ? e.message : "Failed to create wallet");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col items-center w-full max-w-[460px] mx-auto px-4 pt-12 pb-8">
      <h1 className="text-2xl font-semibold text-grey-10 dark:text-grey-light-100 mb-2 text-center">
        Set a Password
      </h1>
      <p className="text-base text-grey-60 dark:text-grey-dark-600 text-center mb-6 max-w-[400px]">
        This password encrypts your wallet on this device. You'll enter it
        whenever you sign a transaction.
      </p>

      <div className="w-full space-y-3.5">
        <div>
          <label className="text-[13px] font-medium text-grey-70 dark:text-grey-dark-800 mb-1.5 block">
            Wallet Name
          </label>
          <Input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            placeholder="Main Wallet"
            className="h-11 text-base font-medium"
          />
        </div>

        <div>
          <label className="text-[13px] font-medium text-grey-70 dark:text-grey-dark-800 mb-1.5 block">
            Password
          </label>
          <div className="relative">
            <Input
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError(null);
              }}
              type={showPassword ? "text" : "password"}
              placeholder="At least 8 characters"
              autoComplete="new-password"
              className="h-11 text-base font-medium pr-10"
            />
            <button
              type="button"
              onClick={() => setShowPassword((s) => !s)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-grey-50 dark:text-grey-dark-600"
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? (
                <EyeOff className="size-4" />
              ) : (
                <Eye className="size-4" />
              )}
            </button>
          </div>
        </div>

        <div>
          <label className="text-[13px] font-medium text-grey-70 dark:text-grey-dark-800 mb-1.5 block">
            Confirm Password
          </label>
          <div className="relative">
            <Input
              value={confirm}
              onChange={(e) => {
                setConfirm(e.target.value);
                setError(null);
              }}
              type={showConfirm ? "text" : "password"}
              placeholder="Repeat your password"
              autoComplete="new-password"
              className={cn(
                "h-11 text-base font-medium pr-10",
                confirm && password !== confirm && "border-error-50",
              )}
            />
            <button
              type="button"
              onClick={() => setShowConfirm((s) => !s)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-grey-50 dark:text-grey-dark-600"
              aria-label={showConfirm ? "Hide password" : "Show password"}
            >
              {showConfirm ? (
                <EyeOff className="size-4" />
              ) : (
                <Eye className="size-4" />
              )}
            </button>
          </div>
        </div>
      </div>

      {error ? (
        <div className="w-full mt-4 flex items-center gap-2 text-error-70 text-sm font-medium">
          <AlertCircle className="size-4" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="w-full mt-6 flex gap-3">
        <Button
          type="button"
          variant="defaultStable"
          size="auto"
          className="flex-1 h-11 rounded-[6px] border border-grey-80 dark:border-[#494949] bg-white dark:bg-[#2a2a2a] dark:text-white text-[14px] font-medium"
          onClick={onBack}
          disabled={submitting}
        >
          Back
        </Button>
        <Button
          type="button"
          variant="primary"
          size="auto"
          className="flex-1 h-11 rounded-[6px] text-[14px] font-medium tracking-[-0.28px]"
          onClick={handleSubmit}
          disabled={submitting || validationError !== null}
        >
          {submitting ? "Creating..." : "Create Wallet"}
        </Button>
      </div>
    </div>
  );
};

export default CreatePasswordScreen;
