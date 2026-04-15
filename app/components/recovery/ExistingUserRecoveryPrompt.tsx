"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { toast } from "sonner";

import DialogContainer from "@/components/ui/DialogContainer";
import { CardButton } from "@/components/ui";
import * as Typography from "@/components/ui/typography";
import {
  PassphraseStrength,
  checkRecoveryState,
  sealAndUploadMnemonic,
} from "@/app/lib/utils/recovery";
import { PasswordField, StrengthMeter, errMessage, useLiveStrength } from "./_shared";

/**
 * One-shot prompt for users who had an account before account recovery
 * shipped — they have a local mnemonic but no server-sealed blob, so if
 * they wipe their device they lose everything. On first load after an
 * app update, this dialog invites them to set a recovery password.
 *
 * Dismissal is not persisted: if the user closes the dialog, it shows
 * again on the next launch. No silent skip — the plan is explicit that
 * unrecoverable accounts are the problem we're fixing, so we keep
 * nagging until they either set a password or reset their account.
 *
 * Only fires once per session even if re-rendered. The check is cheap
 * (one DB read + one HTTP HEAD-style GET) but doing it on every render
 * would hammer the server.
 */
const ExistingUserRecoveryPrompt: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [strength, setStrength] = useState<PassphraseStrength | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const hasCheckedRef = useRef(false);

  useLiveStrength(password, setStrength);

  useEffect(() => {
    if (hasCheckedRef.current) return;
    hasCheckedRef.current = true;

    void (async () => {
      try {
        const check = await checkRecoveryState();
        // Rust owns the nag predicate — see `RecoveryCheck`'s
        // `should_prompt_legacy_migration` docstring. FE just renders.
        if (check.shouldPromptLegacyMigration) {
          setOpen(true);
        }
      } catch (err) {
        console.warn("[ExistingUserRecoveryPrompt] check failed:", err);
        // Silent — this is a nag prompt, not critical path. Try again
        // next session.
      }
    })();
  }, []);

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
      toast.success("Recovery password set. You can now sign in from any device.");
      setOpen(false);
      setPassword("");
      setConfirm("");
    } catch (err) {
      toast.error(`Could not save recovery password: ${errMessage(err)}`);
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, password]);

  const handleRemindLater = useCallback(() => {
    setOpen(false);
  }, []);

  if (!open) return null;

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-40" />
        <DialogContainer className="z-50 w-[420px] max-w-[90vw] !left-1/2 !top-1/2 !bottom-auto !right-auto !-translate-x-1/2 !-translate-y-1/2 p-6">
          <div className="flex flex-col gap-4">
            <Typography.H4 className="text-grey-10">Add a recovery password</Typography.H4>
            <Typography.P size="sm" className="text-grey-40">
              We&apos;ve added a way to recover your account from any device. Set a recovery
              password now so you don&apos;t lose your files if you reinstall or switch devices.
              <strong> This password cannot be reset.</strong>
            </Typography.P>

            <PasswordField label="Recovery password" value={password} onChange={setPassword} />
            <StrengthMeter strength={strength} />
            <PasswordField
              label="Confirm password"
              value={confirm}
              onChange={setConfirm}
              errorMessage={mismatch ? "Passwords do not match." : undefined}
            />

            <div className="flex gap-2 justify-end">
              <CardButton variant="secondary" onClick={handleRemindLater}>
                Remind me later
              </CardButton>
              <CardButton onClick={handleSubmit} disabled={!canSubmit} loading={submitting}>
                Save password
              </CardButton>
            </div>
          </div>
        </DialogContainer>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

export default ExistingUserRecoveryPrompt;
