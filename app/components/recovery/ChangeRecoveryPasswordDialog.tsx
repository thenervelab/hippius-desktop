"use client";

import React, { useCallback, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { toast } from "sonner";
import { HelpCircle } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";

import DialogContainer from "@/components/ui/DialogContainer";
import { CardButton, Graphsheet, Icons } from "@/components/ui";
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
      toast.success("Password updated.");
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
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContainer className="md:inset-0 md:m-auto md:w-[90vw] md:max-w-[26.75rem] h-fit">
        <Dialog.Title className="sr-only">Change Unlock Password</Dialog.Title>

        <div className="px-4 py-6 flex flex-col gap-5">
          {/* Centered icon header */}
          <div className="flex flex-col items-center text-center gap-3">
            <div className="size-14 flex justify-center items-center relative">
              <Graphsheet
                majorCell={{ lineColor: [31, 80, 189, 1.0], lineWidth: 2, cellDim: 200 }}
                minorCell={{ lineColor: [49, 103, 211, 1.0], lineWidth: 1, cellDim: 20 }}
                className="absolute w-full h-full duration-500 opacity-30 z-0"
              />
              <div className="bg-white-cloud-gradient-sm absolute w-full h-full z-10" />
              <div className="h-8 w-8 bg-primary-50 rounded-lg flex items-center justify-center z-20">
                <Icons.ShieldSecurity className="size-5 text-grey-100" />
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <h2 className="text-xl font-semibold text-grey-10">Change Unlock Password</h2>
              <p className="text-sm text-grey-50 max-w-sm">
                Enter your current password, then choose a new one for
                accessing your files on other devices and Hippius Console.
              </p>
            </div>
          </div>

          {/* Info box */}
          <div className="p-3 bg-primary-95 border border-primary-80 rounded-lg flex flex-col gap-2">
            <p className="text-xs text-primary-40">
              Changing your unlock password re-encrypts the sealed backup on
              the server. Your files on the desktop app are not affected.
            </p>
            <button
              type="button"
              onClick={() => openUrl(UNLOCK_PASSWORD_DOCS_URL)}
              className="flex items-center gap-1.5 text-xs text-primary-50 hover:text-primary-40 transition-colors"
            >
              <HelpCircle className="size-3.5" />
              Learn how this works
            </button>
          </div>

            <PasswordField
              label="Current password"
              value={current}
              onChange={(v) => {
                setCurrent(v);
                setCurrentError(null);
              }}
              errorMessage={currentError ?? undefined}
              placeholder="Enter current password"
            />

            <PasswordField
              label="New password"
              value={next}
              onChange={setNext}
              errorMessage={sameAsCurrent ? "New password must differ from current." : undefined}
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

          {/* Actions */}
          <div className="flex gap-3">
            <CardButton className="w-full" variant="secondary" onClick={() => { reset(); onOpenChange(false); }}>
              Cancel
            </CardButton>
            <CardButton className="w-full" onClick={handleSubmit} disabled={!canSubmit} loading={submitting}>
              Change password
            </CardButton>
          </div>
        </div>
        </DialogContainer>
    </Dialog.Root>
  );
};

export default ChangeRecoveryPasswordDialog;
