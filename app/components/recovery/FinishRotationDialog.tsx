"use client";

import React, { useCallback, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { toast } from "sonner";

import DialogContainer from "@/components/ui/DialogContainer";
import { CardButton } from "@/components/ui";
import * as Typography from "@/components/ui/typography";
import { resumeRecoveryPasswordRotation } from "@/app/lib/utils/recovery";
import { PasswordField, errMessage } from "./_shared";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Finish a recovery password rotation whose local-rewrite step failed
 * on the previous launch. Verifies the entered password matches the
 * server blob, then rewrites the local file and clears the sidecar.
 *
 * The user has ALREADY successfully rotated the server blob, so this
 * is strictly a "re-enter the new password you just set" prompt, not
 * a fresh-password wizard.
 */
const FinishRotationDialog: React.FC<Props> = ({ open, onOpenChange }) => {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setPassword("");
    setError(null);
  };

  const handleSubmit = useCallback(async () => {
    if (!password || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await resumeRecoveryPasswordRotation(password);
      toast.success("Recovery password update finished.");
      reset();
      onOpenChange(false);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setSubmitting(false);
    }
  }, [password, submitting, onOpenChange]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-40" />
        <DialogContainer className="z-50 w-[420px] max-w-[90vw] !left-1/2 !top-1/2 !bottom-auto !right-auto !-translate-x-1/2 !-translate-y-1/2 p-6">
          <div className="flex flex-col gap-4">
            <Typography.H4 className="text-grey-10">Finish recovery password change</Typography.H4>
            <Typography.P size="sm" className="text-grey-40">
              Your new recovery password was saved, but this device didn&apos;t
              finish encrypting local data with it. Re-enter the new password
              to finish now.
            </Typography.P>

            <PasswordField
              label="New recovery password"
              value={password}
              onChange={setPassword}
              errorMessage={error ?? undefined}
              onSubmit={handleSubmit}
            />

            <CardButton
              onClick={handleSubmit}
              disabled={!password || submitting}
              loading={submitting}
              className="self-end"
            >
              Finish
            </CardButton>
          </div>
        </DialogContainer>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

export default FinishRotationDialog;
