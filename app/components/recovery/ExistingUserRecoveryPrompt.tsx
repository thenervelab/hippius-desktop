"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { toast } from "sonner";

import DialogContainer from "@/components/ui/DialogContainer";
import { CardButton, Input } from "@/components/ui";
import * as Typography from "@/components/ui/typography";
import {
  PassphraseStrength,
  checkRecoveryState,
  sealAndUploadMnemonic,
  validateRecoveryPassword,
} from "@/app/lib/utils/recovery";
import { cn } from "@/lib/utils";

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
        // Existing user condition: we have a local mnemonic but no
        // server-sealed blob. `recommendedFlow === "proceed"` when
        // local is present; we differentiate via `hasServerBlob`.
        if (check.hasLocalMnemonic && !check.hasServerBlob && check.recommendedFlow === "proceed") {
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
      toast.error(`Could not save recovery password: ${msg(err)}`);
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
        <DialogContainer className="z-50 w-[420px] max-w-[90vw]">
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

// ---------------------------------------------------------------------------
// Local UI helpers (copies of the ones in AccountRecoveryDialog to keep
// each file self-contained — shared helpers live in a follow-up refactor)
// ---------------------------------------------------------------------------

const PasswordField: React.FC<{
  label: string;
  value: string;
  onChange: (v: string) => void;
  errorMessage?: string;
}> = ({ label, value, onChange, errorMessage }) => (
  <label className="flex flex-col gap-1">
    <span className="text-xs text-grey-40">{label}</span>
    <Input
      type="password"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      autoComplete="new-password"
      autoCapitalize="off"
      spellCheck={false}
    />
    {errorMessage && <span className="text-xs text-error-60">{errorMessage}</span>}
  </label>
);

const VERDICT_BARS: Record<string, string> = {
  too_short: "bg-grey-70",
  weak: "bg-error-60",
  ok: "bg-warning-50",
  strong: "bg-success-50",
};

const StrengthMeter: React.FC<{ strength: PassphraseStrength | null }> = ({ strength }) => {
  if (!strength) return null;
  const bar = VERDICT_BARS[strength.verdict] ?? "bg-grey-70";
  return (
    <div className="flex flex-col gap-1">
      <div className="h-1.5 w-full bg-grey-90 rounded-full overflow-hidden">
        <div className={cn("h-full rounded-full transition-[width]", bar)} style={{ width: `${strength.progressPercent}%` }} />
      </div>
      <div className="flex justify-between text-xs text-grey-50">
        <span>{strength.label}</span>
        <span>{strength.bits.toFixed(0)} bits</span>
      </div>
    </div>
  );
};

function useLiveStrength(password: string, setStrength: (s: PassphraseStrength | null) => void) {
  useEffect(() => {
    if (password.length === 0) {
      setStrength(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      validateRecoveryPassword(password)
        .then((s) => { if (!cancelled) setStrength(s); })
        .catch(() => { if (!cancelled) setStrength(null); });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [password, setStrength]);
}

function msg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}
