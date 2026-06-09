"use client";

import React, { useCallback, useState } from "react";
import { toast } from "sonner";
import { HelpCircle, OctagonAlert } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { FramedDialog } from "@/components/ui/FramedDialog";
import { Button, Icons } from "@/components/ui";
import {
  PassphraseStrength,
  changeRecoveryPassword,
} from "@/app/lib/utils/recovery";
import {
  PasswordField,
  StrengthMeter,
  errMessage,
  useLiveStrength,
  UNLOCK_PASSWORD_DOCS_URL,
} from "./_shared";
import { cn } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Rotate the recovery password protecting the sealed mnemonic blob on
 * hcfs-server. The mnemonic itself is unchanged, so no sync re-init or
 * session invalidation happens.
 *
 * All domain rules (decryption, strength, derivation guard) live in Rust.
 * This component just renders inputs and surfaces errors.
 */
const ChangeRecoveryPasswordDialog: React.FC<Props> = ({
  open,
  onOpenChange,
}) => {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [strength, setStrength] = useState<PassphraseStrength | null>(null);
  const [currentError, setCurrentError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  useLiveStrength(next, setStrength);

  const reset = () => {
    setCurrent("");
    setNext("");
    setConfirm("");
    setStrength(null);
    setCurrentError(null);
  };

  const handleClose = () => {
    reset();
    onOpenChange(false);
  };

  const mismatch = confirm.length > 0 && confirm !== next;
  const sameAsCurrent = next.length > 0 && next === current;
  const canSubmit =
    !submitting &&
    current.length > 0 &&
    next.length > 0 &&
    strength?.acceptableForSubmit === true &&
    !mismatch &&
    !sameAsCurrent &&
    next === confirm;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setCurrentError(null);
    try {
      const { alignPending } = await changeRecoveryPassword(current, next);
      if (alignPending) {
        // Server rotation succeeded but this device's folder keys are still
        // finishing realignment to the new password (audit R-19). It completes
        // automatically on the next launch; warn rather than claim a clean done.
        toast.warning(
          "Password updated. Finishing applying it to your synced folders — this completes automatically the next time you open the app.",
        );
      } else {
        toast.success("Password updated.");
      }
      reset();
      onOpenChange(false);
    } catch (err) {
      const msg = errMessage(err);
      // Rust surfaces wrong current password as Validation("Wrong passphrase.")
      if (/wrong passphrase/i.test(msg)) {
        setCurrentError("Incorrect current password.");
        setCurrent("");
      } else {
        toast.error(`Could not change password: ${msg}`);
      }
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, current, next, onOpenChange]);

  return (
    <FramedDialog
      open={open}
      onClose={handleClose}
      title="Change Unlock Password"
      icon={<Icons.ShieldTick className="size-5 text-white" />}
      maxWidth="max-w-[680px]"
    >
      <p className="mb-5 text-center text-sm text-[#7D7D7D] dark:text-grey-dark-600">
        Enter your current password, then choose a new one for accessing your
        files on other devices and Hippius Console.
      </p>

      <div className="flex flex-col gap-4">
        <PasswordField
          label="Current password"
          value={current}
          onChange={(v) => {
            setCurrent(v);
            setCurrentError(null);
          }}
          errorMessage={currentError ?? undefined}
          placeholder="Enter current password"
          autoComplete="current-password"
        />

        <PasswordField
          label="New password"
          value={next}
          onChange={setNext}
          errorMessage={
            sameAsCurrent
              ? "New password must differ from current."
              : undefined
          }
          placeholder="Enter a strong password"
        />
        <StrengthMeter strength={strength} />

        <PasswordField
          label="Confirm new password"
          value={confirm}
          onChange={setConfirm}
          errorMessage={mismatch ? "Passwords do not match." : undefined}
          onSubmit={handleSubmit}
          placeholder="Confirm your password"
        />

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <OctagonAlert className="size-4 text-[#feb101]" />
            <p className="font-geist text-[14px] leading-[1.109] tracking-[-0.28px] font-medium text-black dark:text-white">
              Important
            </p>
          </div>
          <p className="font-geist text-[14px] leading-[1.4] tracking-[-0.28px] text-[#7d7d7d] dark:text-grey-dark-600">
            Changing your unlock password re-encrypts the sealed backup on the
            server. Your files on the desktop app are not affected.
          </p>
          <button
            type="button"
            onClick={() => openUrl(UNLOCK_PASSWORD_DOCS_URL)}
            className="self-start flex items-center gap-1.5 text-xs text-primary-50 hover:text-primary-40 transition-colors"
          >
            <HelpCircle className="size-3.5" />
            Learn how this works
          </button>
        </div>

        <div className="flex gap-3">
          <Button
            variant="defaultStable"
            size="auto"
            onClick={handleClose}
            disabled={submitting}
            className="h-[42px] w-full rounded-[6px] text-sm font-medium"
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="auto"
            onClick={handleSubmit}
            disabled={!canSubmit}
            loading={submitting}
            className={cn(
              "h-[42px] w-full rounded-[6px] border text-sm font-medium",
              "border-[#3167DD] bg-[#3167DD] text-white",
              "hover:bg-[#2454c4] hover:border-[#2454c4]",
              "dark:hover:bg-[#2a5ad0] dark:hover:border-[#2a5ad0]"
            )}
          >
            {submitting ? "Changing..." : "Change password"}
          </Button>
        </div>
      </div>
    </FramedDialog>
  );
};

export default ChangeRecoveryPasswordDialog;
