"use client";

import React, { useCallback, useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useAtom } from "jotai";
import { toast } from "sonner";
import { HelpCircle } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";

import DialogContainer from "@/components/ui/DialogContainer";
import { CardButton, Icons } from "@/components/ui";
import Graphsheet from "@/components/ui/graphsheet";
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
      <DialogContainer className="md:inset-0 md:m-auto md:w-[90vw] md:max-w-[26.75rem] h-fit" preventClose>
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
          <h2 className="text-xl font-semibold text-grey-10">Protect Your Account</h2>
          <p className="text-sm text-grey-50 max-w-sm">
            Set an unlock password to access your encrypted files on
            other devices and Hippius Console.
          </p>
        </div>
      </div>

      {/* Info box */}
      <div className="p-3 bg-primary-95 border border-primary-80 rounded-lg flex flex-col gap-2">
        <p className="text-xs text-primary-40">
          Your files are fully encrypted and only you can access them.
          This password is required to decrypt your files on new
          devices and to preview or download them on Hippius Console.
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
      />

      <CardButton className="w-full" onClick={handleSubmit} disabled={!canSubmit} loading={submitting}>
        Save password
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
          <h2 className="text-xl font-semibold text-grey-10">Unlock Your Account</h2>
          <p className="text-sm text-grey-50 max-w-sm">
            Enter your unlock password to access your files on this device.
          </p>
        </div>
      </div>

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
        <div className="p-3 bg-primary-95 border border-primary-80 rounded-lg">
          <p className="text-xs text-primary-40">
            Your files are encrypted with this password and cannot be recovered without it.
            The password is never sent to our servers, so we cannot reset it for you.
          </p>
        </div>
      )}

      <CardButton className="w-full" onClick={handleSubmit} disabled={!canSubmit} loading={submitting}>
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
          <h2 className="text-xl font-semibold text-grey-10">Check Your Connection</h2>
          <p className="text-sm text-grey-50 max-w-sm">
            We couldn&apos;t reach the recovery service. Make sure you&apos;re online and try again.
          </p>
        </div>
      </div>

      <CardButton className="w-full" onClick={handleRetry} loading={retrying}>
        Retry
      </CardButton>
    </div>
  );
};

