"use client";

import React, { useCallback, useEffect, useState } from "react";
import { useAtom, useSetAtom } from "jotai";
import { toast } from "sonner";
import { HelpCircle, WifiOff } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useRouter } from "next/navigation";

import { useWalletAuth } from "@/app/lib/wallet-auth-context";

import { FramedDialog } from "@/components/ui/FramedDialog";
import { Button } from "@/components/ui/button";
import { Icons } from "@/components/ui";
import {
  RecoveryCheck,
  activeRecoveryCheckAtom,
} from "@/app/lib/global-atoms/recoveryAtoms";
import { syncRequiresReauthAtom } from "@/app/lib/global-atoms/unpinAtoms";
import {
  PassphraseStrength,
  checkRecoveryState,
  markRecoverySkipped,
  recoverMnemonic,
  restoreWithMnemonic,
  sealAndUploadMnemonic,
} from "@/app/lib/utils/recovery";
import {
  PasswordField,
  StrengthMeter,
  errMessage,
  useLiveStrength,
  UNLOCK_PASSWORD_DOCS_URL,
} from "./_shared";
import { canSubmitPhraseRestore } from "./recoveryRotationLogic";
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
        Set an unlock password to open your mnemonic seed on other devices
        and Hippius Console.
      </p>

      <div className="flex flex-col gap-4">
        {/* Info box explaining why the password matters. */}
        <div className="flex flex-col gap-2 rounded-lg border border-primary-80 bg-primary-95 p-3 dark:border-primary-80/40 dark:bg-primary-50/10">
          <p className="text-xs text-primary-40 dark:text-grey-dark-600">
            Your files are encrypted with your mnemonic seed, not this password.
            The password unlocks a sealed copy of that seed on new devices and
            on Hippius Console.
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
  const [showPhraseRestore, setShowPhraseRestore] = useState(false);
  const setSyncRequiresReauth = useSetAtom(syncRequiresReauthAtom);
  const { authType } = useWalletAuth();
  const router = useRouter();

  // Mnemonic users reach this dialog via the mount-time self-heal when
  // their keychain is locked/empty but a server blob exists (they set an
  // unlock password in settings). Unlike OAuth users they hold a second,
  // fully independent recovery path — re-entering the seed phrase — so
  // the preventClose dialog must not be a dead end for them when the
  // unlock password is forgotten (PR #124 review).
  const canEscapeToSeedPhrase = authType === "mnemonic";

  const handleSeedPhraseEscape = useCallback(() => {
    // `?reauth=1` keeps the login page from bouncing an authenticated
    // user home (audit R-13). Close the dialog first so it doesn't sit
    // over the login form.
    onDone();
    router.push("/login?reauth=1");
  }, [onDone, router]);

  const canSubmit = !submitting && password.length > 0;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await recoverMnemonic(password);
      // A successful unlock invalidates the reauth banner's premise —
      // the mnemonic is now cached and files decrypt again. Without
      // this, the banner raised by a mnemonic-labelled restore (the
      // pre-#102 mislabelled-row path) or by the OAuth banner's own
      // CTA would linger until the next restart. Clearing when the
      // banner isn't up is a no-op.
      setSyncRequiresReauth(false);
      toast.success("Account unlocked.");
      onDone();
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, password, onDone, setSyncRequiresReauth]);

  return (
    <FramedDialog
      open
      onClose={() => {}}
      preventClose
      title="Unlock Your Account"
      icon={<Icons.LockClosed className="size-5 text-white" />}
      maxWidth="max-w-[680px]"
    >
      {showPhraseRestore ? (
        <PhraseRestoreForm
          onDone={onDone}
          onBack={() => setShowPhraseRestore(false)}
        />
      ) : (
        <>
          <p className="mb-5 text-center text-sm text-[#7D7D7D] dark:text-grey-dark-600">
            Enter your unlock password to unwrap your mnemonic seed on this
            device.
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
                  {canEscapeToSeedPhrase
                    ? "Your files are encrypted with your mnemonic seed, not this password. The password only unlocks a sealed copy of that seed. We never see it, so we cannot reset it. If you still have your recovery phrase, you can sign in with it instead — that fully restores access without the unlock password. You can also restore here and set a new password."
                    : "Your files are encrypted with your mnemonic seed, not this password. The password only unlocks a sealed copy of that seed. We never see the password, so we cannot reset it for you. If you still have your mnemonic seed, you can restore access and set a new password."}
                </p>
                <button
                  type="button"
                  className="mt-2 text-xs font-medium text-primary-50 underline hover:no-underline dark:text-primary-brand-dark"
                  onClick={() => setShowPhraseRestore(true)}
                >
                  Use your mnemonic seed
                </button>
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

            {canEscapeToSeedPhrase && (
              <button
                type="button"
                onClick={handleSeedPhraseEscape}
                className="self-center text-sm font-medium text-primary-50 underline hover:no-underline dark:text-primary-brand-dark"
              >
                Sign in with your recovery phrase instead
              </button>
            )}
          </div>
        </>
      )}
    </FramedDialog>
  );
};

const PhraseRestoreForm: React.FC<{
  onDone: () => void;
  onBack: () => void;
}> = ({ onDone, onBack }) => {
  const [mnemonic, setMnemonic] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [strength, setStrength] = useState<PassphraseStrength | null>(null);
  const [phraseError, setPhraseError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const setSyncRequiresReauth = useSetAtom(syncRequiresReauthAtom);
  useLiveStrength(next, setStrength);

  const mismatch = confirm.length > 0 && confirm !== next;
  const canSubmit = canSubmitPhraseRestore({
    submitting,
    mnemonic,
    next,
    confirm,
    strength,
  });

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setPhraseError(null);
    try {
      const { alignPending } = await restoreWithMnemonic(mnemonic.trim(), next);
      setSyncRequiresReauth(false);
      if (alignPending) {
        toast.warning(
          "Account unlocked. Finishing applying the new password to your synced folders — this completes automatically the next time you open the app."
        );
      } else {
        toast.success("Account unlocked. Unlock password updated.");
      }
      onDone();
    } catch (err) {
      setPhraseError(errMessage(err));
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, mnemonic, next, onDone, setSyncRequiresReauth]);

  return (
    <>
      <p className="mb-5 text-center text-sm text-[#7D7D7D] dark:text-grey-dark-600">
        Enter your mnemonic seed and choose a new unlock password. Your files
        are encrypted with the seed, not the password.
      </p>
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-grey-40 dark:text-grey-dark-600">
            Mnemonic seed
          </span>
          <textarea
            value={mnemonic}
            onChange={(e) => {
              setMnemonic(e.target.value);
              setPhraseError(null);
            }}
            placeholder="Enter or paste your 12-word seed phrase"
            rows={3}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            className="w-full rounded-md border border-grey-80 bg-white p-3 font-mono text-sm text-grey-10 dark:border-[#3a3a3a] dark:bg-[#1a1a1a] dark:text-white"
          />
          {phraseError && (
            <p className="text-xs text-error-50">{phraseError}</p>
          )}
        </label>
        <PasswordField
          label="New unlock password"
          value={next}
          onChange={setNext}
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
        <Button
          variant="primary"
          size="auto"
          onClick={handleSubmit}
          disabled={!canSubmit}
          loading={submitting}
          className={PRIMARY_BUTTON_CLASS}
        >
          {submitting ? "Restoring..." : "Restore and set password"}
        </Button>
        <button
          type="button"
          onClick={onBack}
          disabled={submitting}
          className="self-center text-sm font-medium text-primary-50 underline hover:no-underline dark:text-primary-brand-dark"
        >
          Back to unlock password
        </button>
      </div>
    </>
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
    } catch (err) {
      // The common offline case resolves to flow "unknown" without
      // throwing; a THROWN retry is an IPC-level failure and used to
      // surface only as an unhandled rejection with no user feedback.
      console.error("[AccountRecoveryDialog] recovery retry failed:", err);
      toast.error(
        "Couldn't reach the recovery service. Check your connection and try again."
      );
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
