"use client";

import React, { useCallback, useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useAtom } from "jotai";
import { toast } from "sonner";

import DialogContainer from "@/components/ui/DialogContainer";
import { CardButton, Input } from "@/components/ui";
import * as Typography from "@/components/ui/typography";
import {
  RecoveryCheck,
  activeRecoveryCheckAtom,
} from "@/app/lib/global-atoms/recoveryAtoms";
import {
  PassphraseStrength,
  checkRecoveryState,
  markRecoverySkipped,
  recoverMnemonic,
  sealAndUploadMnemonic,
  validateRecoveryPassword,
} from "@/app/lib/utils/recovery";
import { cn } from "@/lib/utils";

/**
 * Blocking recovery dialog shown after OAuth login when the backend
 * signals the account needs password setup (`signup`), password entry
 * (`unlock`), or a network-retry (`unknown`). The `proceed` branch is
 * a fast-path that calls `mark_recovery_skipped` and auto-closes — the
 * user sees nothing.
 *
 * Consumes the `activeRecoveryCheckAtom` set by `RecoveryEventListener`
 * from the Rust `oauth_recovery_check_needed` event.
 *
 * All domain decisions live in Rust: passphrase scoring, gate state,
 * error mapping. This component only renders state and captures input.
 */
const AccountRecoveryDialog: React.FC = () => {
  const [check, setCheck] = useAtom(activeRecoveryCheckAtom);
  if (!check) return null;

  return (
    <Dialog.Root open>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
        <DialogContainer className="z-50 w-[420px] max-w-[90vw]">
          <BranchRouter check={check} onDone={() => setCheck(null)} onRetry={async () => {
            const next = await checkRecoveryState();
            setCheck(next);
          }} />
        </DialogContainer>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

export default AccountRecoveryDialog;

// ---------------------------------------------------------------------------
// Branch router
// ---------------------------------------------------------------------------

const BranchRouter: React.FC<{
  check: RecoveryCheck;
  onDone: () => void;
  onRetry: () => Promise<void>;
}> = ({ check, onDone, onRetry }) => {
  switch (check.recommendedFlow) {
    case "signup":
      return <SignupBranch onDone={onDone} />;
    case "unlock":
      return <UnlockBranch onDone={onDone} />;
    case "proceed":
      return <ProceedBranch onDone={onDone} />;
    case "unknown":
      return <UnknownBranch onRetry={onRetry} />;
    default:
      return <UnknownBranch onRetry={onRetry} />;
  }
};

// ---------------------------------------------------------------------------
// Signup — first-time OAuth user sets a recovery password
// ---------------------------------------------------------------------------

const SignupBranch: React.FC<{ onDone: () => void }> = ({ onDone }) => {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [strength, setStrength] = useState<PassphraseStrength | null>(null);
  const [submitting, setSubmitting] = useState(false);
  useLiveStrength(password, setStrength);

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
      toast.success("Recovery password set. Your account is now protected.");
      onDone();
    } catch (err) {
      toast.error(`Could not set recovery password: ${msg(err)}`);
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, password, onDone]);

  return (
    <div className="flex flex-col gap-4">
      <Typography.H4 className="text-grey-10">Protect your account</Typography.H4>
      <Typography.P size="sm" className="text-grey-40">
        Choose a recovery password. It encrypts your data and lets you sign in
        from any device. <strong>This password cannot be reset.</strong> If you
        forget it, your files cannot be recovered.
      </Typography.P>

      <PasswordField label="Recovery password" value={password} onChange={setPassword} />
      <StrengthMeter strength={strength} />
      <PasswordField
        label="Confirm password"
        value={confirm}
        onChange={setConfirm}
        errorMessage={mismatch ? "Passwords do not match." : undefined}
      />

      <CardButton onClick={handleSubmit} disabled={!canSubmit} loading={submitting} className="self-end">
        Continue
      </CardButton>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Unlock — returning user on a fresh device enters their password
// ---------------------------------------------------------------------------

const UnlockBranch: React.FC<{ onDone: () => void }> = ({ onDone }) => {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showForgot, setShowForgot] = useState(false);

  const canSubmit = !submitting && password.length > 0;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await recoverMnemonic(password);
      toast.success("Account unlocked.");
      onDone();
    } catch (err) {
      setError(msg(err));
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, password, onDone]);

  return (
    <div className="flex flex-col gap-4">
      <Typography.H4 className="text-grey-10">Unlock your account</Typography.H4>
      <Typography.P size="sm" className="text-grey-40">
        Enter your recovery password to decrypt your data on this device.
      </Typography.P>

      <PasswordField
        label="Recovery password"
        value={password}
        onChange={setPassword}
        errorMessage={error ?? undefined}
        onSubmit={handleSubmit}
      />

      <button
        type="button"
        className="self-start text-xs text-grey-50 underline hover:text-grey-30"
        onClick={() => setShowForgot((v) => !v)}
      >
        Forgot your password?
      </button>
      {showForgot && (
        <Typography.P size="xs" className="text-grey-50 bg-grey-95 rounded p-3">
          Your files are encrypted with this password and cannot be recovered without it.
          The password is never sent to our servers, so we cannot reset it for you.
        </Typography.P>
      )}

      <CardButton onClick={handleSubmit} disabled={!canSubmit} loading={submitting} className="self-end">
        Unlock
      </CardButton>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Proceed — local mnemonic already present; skip silently
// ---------------------------------------------------------------------------

const ProceedBranch: React.FC<{ onDone: () => void }> = ({ onDone }) => {
  useEffect(() => {
    void (async () => {
      try {
        await markRecoverySkipped();
      } catch (err) {
        // Backend default gate is `Skipped`, so a failure here is
        // cosmetic — sync is already unblocked. Log for triage; no
        // toast because the user was never shown this branch.
        console.warn("[AccountRecovery] mark_recovery_skipped failed:", err);
      }
      onDone();
    })();
  }, [onDone]);
  return null;
};

// ---------------------------------------------------------------------------
// Unknown — server probe failed, offer retry
// ---------------------------------------------------------------------------

const UnknownBranch: React.FC<{ onRetry: () => Promise<void> }> = ({ onRetry }) => {
  const [retrying, setRetrying] = useState(false);
  const handleRetry = useCallback(async () => {
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  }, [onRetry]);

  return (
    <div className="flex flex-col gap-4">
      <Typography.H4 className="text-grey-10">Check your connection</Typography.H4>
      <Typography.P size="sm" className="text-grey-40">
        We couldn&apos;t reach the recovery service. Make sure you&apos;re online and try again.
      </Typography.P>
      <CardButton onClick={handleRetry} loading={retrying} className="self-end">
        Retry
      </CardButton>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Shared UI
// ---------------------------------------------------------------------------

const PasswordField: React.FC<{
  label: string;
  value: string;
  onChange: (v: string) => void;
  errorMessage?: string;
  onSubmit?: () => void;
}> = ({ label, value, onChange, errorMessage, onSubmit }) => (
  <label className="flex flex-col gap-1">
    <span className="text-xs text-grey-40">{label}</span>
    <Input
      type="password"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && onSubmit) {
          e.preventDefault();
          onSubmit();
        }
      }}
      autoComplete="current-password"
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
