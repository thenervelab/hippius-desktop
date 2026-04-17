"use client";

import React, { useCallback, useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useAtom } from "jotai";
import { toast } from "sonner";
import { HelpCircle } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";

import DialogContainer from "@/components/ui/DialogContainer";
import { CardButton } from "@/components/ui";
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
} from "@/app/lib/utils/recovery";
import { PasswordField, StrengthMeter, errMessage, useLiveStrength, UNLOCK_PASSWORD_DOCS_URL } from "./_shared";

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
      <DialogContainer className="md:inset-0 md:m-auto md:w-[90vw] md:max-w-[30rem] h-fit p-6" preventClose>
          <BranchRouter check={check} onDone={() => setCheck(null)} onRetry={async () => {
            const next = await checkRecoveryState();
            setCheck(next);
          }} />
      </DialogContainer>
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
      toast.success("Unlock password set. Your account is now protected.");
      onDone();
    } catch (err) {
      toast.error(`Could not set unlock password: ${errMessage(err)}`);
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, password, onDone]);

  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-xl font-medium text-grey-10">Protect your account</h3>
      <p className="text-sm text-grey-40">
        Choose an unlock password to secure your account. You will need it
        to preview and download your encrypted files on Hippius Console.
      </p>

      <button
        type="button"
        onClick={() => openUrl(UNLOCK_PASSWORD_DOCS_URL)}
        className="flex items-center gap-1.5 text-xs text-primary-50 hover:text-primary-40 transition-colors"
      >
        <HelpCircle className="size-3.5" />
        Learn how this works
      </button>

      <PasswordField label="Unlock password" value={password} onChange={setPassword} placeholder="Enter a strong password" />
      <StrengthMeter strength={strength} />
      <PasswordField
        label="Confirm password"
        placeholder="Confirm your password"
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
      setError(errMessage(err));
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, password, onDone]);

  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-xl font-medium text-grey-10">Unlock your account</h3>
      <p className="text-sm text-grey-40">
        Enter your unlock password to access your files on this device.
      </p>

      <button
        type="button"
        onClick={() => openUrl(UNLOCK_PASSWORD_DOCS_URL)}
        className="flex items-center gap-1.5 text-xs text-primary-50 hover:text-primary-40 transition-colors"
      >
        <HelpCircle className="size-3.5" />
        Learn how this works
      </button>

      <PasswordField
        label="Unlock password"
        value={password}
        onChange={setPassword}
        errorMessage={error ?? undefined}
        onSubmit={handleSubmit}
        placeholder="Enter your unlock password"
      />

      <button
        type="button"
        className="self-start text-xs text-grey-50 underline hover:text-grey-30"
        onClick={() => setShowForgot((v) => !v)}
      >
        Forgot your password?
      </button>
      {showForgot && (
        <p className="text-xs text-grey-50 bg-grey-95 rounded p-3">
          Your files are encrypted with this password and cannot be recovered without it.
          The password is never sent to our servers, so we cannot reset it for you.
        </p>
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
      <h3 className="text-xl font-medium text-grey-10">Check your connection</h3>
      <p className="text-sm text-grey-40">
        We couldn&apos;t reach the recovery service. Make sure you&apos;re online and try again.
      </p>
      <CardButton onClick={handleRetry} loading={retrying} className="self-end">
        Retry
      </CardButton>
    </div>
  );
};

