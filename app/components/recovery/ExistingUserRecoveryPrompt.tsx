"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { toast } from "sonner";
import { HelpCircle } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";

import DialogContainer from "@/components/ui/DialogContainer";
import { CardButton, Graphsheet, Icons } from "@/components/ui";
import {
  PassphraseStrength,
  checkRecoveryState,
  sealAndUploadMnemonic,
} from "@/app/lib/utils/recovery";
import { PasswordField, StrengthMeter, errMessage, useLiveStrength, UNLOCK_PASSWORD_DOCS_URL } from "./_shared";

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
        if (check.shouldPromptLegacyMigration) {
          setOpen(true);
        }
      } catch (err) {
        console.warn("[ExistingUserRecoveryPrompt] check failed:", err);
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
      toast.success("Unlock password set. You can now preview and download files on Console.");
      setOpen(false);
      setPassword("");
      setConfirm("");
    } catch (err) {
      toast.error(`Could not save unlock password: ${errMessage(err)}`);
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
      <DialogContainer className="md:inset-0 md:m-auto md:w-[90vw] md:max-w-[26.75rem] h-fit">
        <Dialog.Title className="sr-only">Set Unlock Password</Dialog.Title>

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
              <h2 className="text-xl font-semibold text-grey-10">Set Your Unlock Password</h2>
              <p className="text-sm text-grey-50 max-w-sm">
                Set a password to preview and download your encrypted files
                on Hippius Console.
              </p>
            </div>
          </div>

          {/* Info box */}
          <div className="p-3 bg-primary-95 border border-primary-80 rounded-lg flex flex-col gap-2">
            <p className="text-xs text-primary-40">
              Your files are fully encrypted and only you can access them.
              This password lets you securely preview and download your
              files on Hippius Console.
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

          <PasswordField label="Unlock password" value={password} onChange={setPassword} placeholder="Enter a strong password" />
          <StrengthMeter strength={strength} />
          <PasswordField
            label="Confirm password"
            placeholder="Confirm your password"
            value={confirm}
            onChange={setConfirm}
            errorMessage={mismatch ? "Passwords do not match." : undefined}
            onSubmit={handleSubmit}
          />

          {/* Actions */}
          <div className="flex gap-3">
            <CardButton className="w-full" variant="secondary" onClick={handleRemindLater}>
              Remind me later
            </CardButton>
            <CardButton className="w-full" onClick={handleSubmit} disabled={!canSubmit} loading={submitting}>
              Save password
            </CardButton>
          </div>
        </div>
      </DialogContainer>
    </Dialog.Root>
  );
};

export default ExistingUserRecoveryPrompt;
