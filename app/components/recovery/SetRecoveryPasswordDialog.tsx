"use client";

import React, { useCallback, useState } from "react";
import { toast } from "sonner";
import { OctagonAlert } from "lucide-react";

import { FramedDialog } from "@/components/ui/FramedDialog";
import { Button } from "@/components/ui/button";
import { Icons } from "@/components/ui";
import {
  PassphraseStrength,
  sealAndUploadMnemonic,
} from "@/app/lib/utils/recovery";
import {
  PasswordField,
  StrengthMeter,
  errMessage,
  useLiveStrength,
} from "./_shared";
import { cn } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful save so the parent can refresh state. */
  onSuccess?: () => void;
}

/**
 * Dialog to set a recovery password for the first time from Settings.
 * Used when the user has not yet configured a recovery password
 * (no server blob exists).
 */
const SetRecoveryPasswordDialog: React.FC<Props> = ({
  open,
  onOpenChange,
  onSuccess,
}) => {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [strength, setStrength] = useState<PassphraseStrength | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useLiveStrength(password, setStrength);

  const reset = () => {
    setPassword("");
    setConfirm("");
    setStrength(null);
  };

  const handleClose = () => {
    reset();
    onOpenChange(false);
  };

  const mismatch = confirm.length > 0 && confirm !== password;
  const canSubmit =
    !submitting &&
    strength?.acceptableForSubmit === true &&
    !mismatch &&
    password === confirm;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await sealAndUploadMnemonic(password);
      toast.success(
        "Unlock password set. You can now access your files on other devices and Console."
      );
      reset();
      onOpenChange(false);
      onSuccess?.();
    } catch (err) {
      toast.error(`Could not save unlock password: ${errMessage(err)}`);
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, password, onOpenChange, onSuccess]);

  return (
    <FramedDialog
      open={open}
      onClose={handleClose}
      title="Protect Your Account"
      icon={<Icons.ShieldTick className="size-5 text-white" />}
      maxWidth="max-w-[680px]"
    >
      <p className="mb-5 text-center text-sm text-[#7D7D7D] dark:text-grey-dark-600">
        Set an unlock password to open your mnemonic seed on other devices
        and Hippius Console.
      </p>

      <div className="flex flex-col gap-4">
        <PasswordField
          label="Create Unlock Password"
          value={password}
          onChange={setPassword}
          placeholder="Create a Strong Password"
        />
        <StrengthMeter strength={strength} />
        <PasswordField
          label="Confirm Password"
          placeholder="Confirm Your Password"
          value={confirm}
          onChange={setConfirm}
          errorMessage={mismatch ? "Passwords do not match." : undefined}
          onSubmit={handleSubmit}
        />

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <OctagonAlert className="size-4 text-[#feb101]" />
            <p className="font-geist text-[14px] leading-[1.109] tracking-[-0.28px] font-medium text-black dark:text-white">
              Important
            </p>
          </div>
          <p className="font-geist text-[14px] leading-[1.4] tracking-[-0.28px] text-[#7d7d7d] dark:text-grey-dark-600">
            Your files are encrypted with your mnemonic seed, not this password.
            The password unlocks a sealed copy of that seed on new devices and
            on Hippius Console.
          </p>
        </div>

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
          {submitting ? "Creating..." : "Create Password"}
        </Button>
      </div>
    </FramedDialog>
  );
};

export default SetRecoveryPasswordDialog;
