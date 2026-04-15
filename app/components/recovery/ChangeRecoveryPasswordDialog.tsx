"use client";

import React, { useCallback, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { toast } from "sonner";

import DialogContainer from "@/components/ui/DialogContainer";
import { CardButton } from "@/components/ui";
import * as Typography from "@/components/ui/typography";
import {
  PassphraseStrength,
  changeRecoveryPassword,
} from "@/app/lib/utils/recovery";
import {
  PasswordField,
  StrengthMeter,
  errMessage,
  useLiveStrength,
} from "./_shared";

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
const ChangeRecoveryPasswordDialog: React.FC<Props> = ({ open, onOpenChange }) => {
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
      await changeRecoveryPassword(current, next);
      toast.success("Recovery password updated.");
      reset();
      onOpenChange(false);
    } catch (err) {
      const msg = errMessage(err);
      // Rust surfaces wrong current password as Validation("Wrong passphrase.")
      if (/wrong passphrase/i.test(msg)) {
        setCurrentError("Incorrect current password.");
        setCurrent("");
      } else {
        toast.error(`Could not change recovery password: ${msg}`);
      }
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, current, next, onOpenChange]);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-40" />
        <DialogContainer className="z-50 w-[420px] max-w-[90vw] !left-1/2 !top-1/2 !bottom-auto !right-auto !-translate-x-1/2 !-translate-y-1/2 p-6">
          <div className="flex flex-col gap-4">
            <Typography.H4 className="text-grey-10">Change recovery password</Typography.H4>
            <Typography.P size="sm" className="text-grey-40">
              Enter your current recovery password, then choose a new one.
              <strong> Your new password cannot be reset</strong> if you forget it.
            </Typography.P>

            <PasswordField
              label="Current recovery password"
              value={current}
              onChange={(v) => {
                setCurrent(v);
                setCurrentError(null);
              }}
              errorMessage={currentError ?? undefined}
            />

            <PasswordField
              label="New recovery password"
              value={next}
              onChange={setNext}
              errorMessage={sameAsCurrent ? "New password must differ from current." : undefined}
            />
            <StrengthMeter strength={strength} />

            <PasswordField
              label="Confirm new password"
              value={confirm}
              onChange={setConfirm}
              errorMessage={mismatch ? "Passwords do not match." : undefined}
            />

            <div className="flex gap-2 justify-end">
              <CardButton variant="secondary" onClick={() => { reset(); onOpenChange(false); }}>
                Cancel
              </CardButton>
              <CardButton onClick={handleSubmit} disabled={!canSubmit} loading={submitting}>
                Change password
              </CardButton>
            </div>
          </div>
        </DialogContainer>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

export default ChangeRecoveryPasswordDialog;
