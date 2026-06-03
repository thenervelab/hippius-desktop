"use client";

import React, { useCallback, useEffect, useState } from "react";
import { useAtom } from "jotai";
import { toast } from "sonner";
import { HelpCircle, WifiOff } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { FramedDialog } from "@/components/ui/FramedDialog";
import { Button } from "@/components/ui/button";
import { Icons } from "@/components/ui";
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
import {
  PasswordField,
  StrengthMeter,
  errMessage,
  useLiveStrength,
  UNLOCK_PASSWORD_DOCS_URL,
} from "./_shared";
import { cn } from "@/lib/utils";

/** Shared primary-button styling so every branch matches the sibling
 *  recovery dialogs (`SetRecoveryPasswordDialog`, `ChangeRecoveryPasswordDialog`). */
const PRIMARY_BUTTON_CLASS = cn(
  "h-[42px] w-full rounded-[6px] border text-sm font-medium",
  "border-[#3167DD] bg-[#3167DD] text-white",
  "hover:bg-[#2454c4] hover:border-[#2454c4]",
  "dark:hover:bg-[#2a5ad0] dark:hover:border-[#2a5ad0]",
);

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
 *
 * Each branch renders inside the shared `FramedDialog` (`preventClose`)
 * so it matches the rest of the app's dialog design while staying a
 * non-dismissable gate the user must resolve.
 */
const AccountRecoveryDialog: React.FC = () => {
  const [check, setCheck] = useAtom(activeRecoveryCheckAtom);
  if (!check) return null;

  return (
    <BranchRouter
      check={check}
      onDone={() => setCheck(null)}
      onRetry={async () => {
        const next = await checkRecoveryState();
        setCheck(next);
      }}
    />
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
    <FramedDialog
      open
      onClose={() => {}}
      preventClose
      title="Protect Your Account"
      icon={<Icons.ShieldTick className="size-5 text-white" />}
      maxWidth="max-w-[680px]"
    >
      <p className="mb-5 text-center text-sm text-[#7D7D7D] dark:text-grey-dark-600">
        Set an unlock password to access your encrypted files on other devices
        and Hippius Console.
      </p>

      <div className="flex flex-col gap-4">
        {/* Info box explaining why the password matters. */}
        <div className="flex flex-col gap-2 rounded-lg border border-primary-80 bg-primary-95 p-3 dark:border-primary-80/40 dark:bg-primary-50/10">
          <p className="text-xs text-primary-40 dark:text-grey-dark-600">
            Your files are fully encrypted and only you can access them. This
            password is required to decrypt your files on new devices and to
            preview or download them on Hippius Console.
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

        <Button
          variant="primary"
          size="auto"
          onClick={handleSubmit}
          disabled={!canSubmit}
          loading={submitting}
          className={PRIMARY_BUTTON_CLASS}
        >
          {submitting ? "Saving..." : "Save Password"}
        </Button>
      </div>
    </FramedDialog>
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
    <FramedDialog
      open
      onClose={() => {}}
      preventClose
      title="Unlock Your Account"
      icon={<Icons.LockClosed className="size-5 text-white" />}
      maxWidth="max-w-[680px]"
    >
      <p className="mb-5 text-center text-sm text-[#7D7D7D] dark:text-grey-dark-600">
        Enter your unlock password to access your files on this device.
      </p>

      <div className="flex flex-col gap-4">
        <PasswordField
          label="Unlock Password"
          value={password}
          onChange={setPassword}
          errorMessage={error ?? undefined}
          onSubmit={handleSubmit}
          placeholder="Enter your unlock password"
        />

        <button
          type="button"
          className="self-start text-xs text-grey-50 underline hover:text-grey-30 dark:text-grey-dark-600 dark:hover:text-grey-dark-500"
          onClick={() => setShowForgot((v) => !v)}
        >
          Forgot your password?
        </button>
        {showForgot && (
          <div className="rounded-lg border border-primary-80 bg-primary-95 p-3 dark:border-primary-80/40 dark:bg-primary-50/10">
            <p className="text-xs text-primary-40 dark:text-grey-dark-600">
              Your files are encrypted with this password and cannot be
              recovered without it. The password is never sent to our servers,
              so we cannot reset it for you.
            </p>
          </div>
        )}

        <Button
          variant="primary"
          size="auto"
          onClick={handleSubmit}
          disabled={!canSubmit}
          loading={submitting}
          className={PRIMARY_BUTTON_CLASS}
        >
          {submitting ? "Unlocking..." : "Unlock"}
        </Button>
      </div>
    </FramedDialog>
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

const UnknownBranch: React.FC<{ onRetry: () => Promise<void> }> = ({
  onRetry,
}) => {
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
    <FramedDialog
      open
      onClose={() => {}}
      preventClose
      title="Check Your Connection"
      icon={<WifiOff className="size-5 text-white" />}
      maxWidth="max-w-[680px]"
    >
      <p className="mb-5 text-center text-sm text-[#7D7D7D] dark:text-grey-dark-600">
        We couldn&apos;t reach the recovery service. Make sure you&apos;re
        online and try again.
      </p>

      <Button
        variant="primary"
        size="auto"
        onClick={handleRetry}
        loading={retrying}
        className={PRIMARY_BUTTON_CLASS}
      >
        {retrying ? "Retrying..." : "Retry"}
      </Button>
    </FramedDialog>
  );
};
