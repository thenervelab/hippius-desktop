"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { HelpCircle, OctagonAlert } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { FramedDialog } from "@/components/ui/FramedDialog";
import { Button, Icons } from "@/components/ui";
import {
  PassphraseStrength,
  changeRecoveryPassword,
  resetUnlockPassword,
  restoreWithMnemonic,
} from "@/app/lib/utils/recovery";
import {
  PasswordField,
  MnemonicField,
  StrengthMeter,
  errMessage,
  seedWordsFor,
  type SeedWords,
  useLiveStrength,
  UNLOCK_PASSWORD_DOCS_URL,
} from "./_shared";
import { cn } from "@/lib/utils";
import {
  isPasswordMismatch,
  isSameAsCurrent,
  canSubmitRecoveryRotation,
  canSubmitNewPasswordOnly,
  canSubmitPhraseRestore,
  classifyRotationError,
} from "./recoveryRotationLogic";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What this account calls its 12 words; recovery seed unless given. */
  seedWords?: SeedWords;
}

/**
 * Rotate the recovery password protecting the sealed mnemonic blob on
 * hcfs-server. The mnemonic itself is unchanged, so no sync re-init or
 * session invalidation happens.
 *
 * All domain rules (decryption, strength, derivation guard) live in Rust.
 * This component just renders inputs and surfaces errors.
 */
type ChangeMode = "rotate" | "reset" | "phrase";

const ChangeRecoveryPasswordDialog: React.FC<Props> = ({
  open,
  onOpenChange,
  seedWords = seedWordsFor("oauth"),
}) => {
  const [mode, setMode] = useState<ChangeMode>("rotate");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [mnemonic, setMnemonic] = useState("");
  const [strength, setStrength] = useState<PassphraseStrength | null>(null);
  const [currentError, setCurrentError] = useState<string | null>(null);
  const [phraseError, setPhraseError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const currentRef = useRef<HTMLInputElement>(null);
  useLiveStrength(next, setStrength);

  // A wrong current password keeps what was typed, selected, so it can be
  // typed straight over.
  useEffect(() => {
    if (!currentError || submitting) return;
    currentRef.current?.focus();
    currentRef.current?.select();
  }, [currentError, submitting]);

  const reset = () => {
    setMode("rotate");
    setCurrent("");
    setNext("");
    setConfirm("");
    setMnemonic("");
    setStrength(null);
    setCurrentError(null);
    setPhraseError(null);
  };

  const handleClose = () => {
    reset();
    onOpenChange(false);
  };

  const reportAlign = (alignPending: boolean) => {
    if (alignPending) {
      toast.warning(
        "Password updated. It finishes applying to your synced folders the next time you open the app.",
      );
    } else {
      toast.success("Password updated.");
    }
    reset();
    onOpenChange(false);
  };

  const mismatch = isPasswordMismatch(next, confirm);
  const sameAsCurrent = isSameAsCurrent(current, next);
  const canSubmitRotate = canSubmitRecoveryRotation({
    submitting,
    current,
    next,
    confirm,
    strength,
  });
  const canSubmitReset = canSubmitNewPasswordOnly({
    submitting,
    next,
    confirm,
    strength,
  });
  const canSubmitPhrase = canSubmitPhraseRestore({
    submitting,
    mnemonic,
    next,
    confirm,
    strength,
  });

  const handleSubmit = useCallback(async () => {
    if (mode === "rotate" && !canSubmitRotate) return;
    if (mode === "reset" && !canSubmitReset) return;
    if (mode === "phrase" && !canSubmitPhrase) return;
    setSubmitting(true);
    setCurrentError(null);
    setPhraseError(null);
    try {
      if (mode === "rotate") {
        const { alignPending } = await changeRecoveryPassword(current, next);
        reportAlign(alignPending);
        return;
      }
      if (mode === "reset") {
        try {
          const { alignPending } = await resetUnlockPassword(next);
          reportAlign(alignPending);
        } catch (err) {
          if (classifyRotationError(err) === "mnemonic_missing") {
            setMode("phrase");
            return;
          }
          throw err;
        }
        return;
      }
      const { alignPending } = await restoreWithMnemonic(mnemonic.trim(), next);
      reportAlign(alignPending);
    } catch (err) {
      const msg = errMessage(err);
      if (mode === "rotate" && classifyRotationError(err) === "wrong_password") {
        setCurrentError(msg);
      } else if (mode === "phrase") {
        setPhraseError(msg);
      } else {
        toast.error(`Could not change password: ${msg}`);
      }
    } finally {
      setSubmitting(false);
    }
  }, [mode, canSubmitRotate, canSubmitReset, canSubmitPhrase, current, next, mnemonic, onOpenChange]);

  return (
    <FramedDialog
      open={open}
      onClose={handleClose}
      title="Change Unlock Password"
      icon={<Icons.ShieldTick className="size-5 text-white" />}
      maxWidth="max-w-[680px]"
    >
      <p className="mb-5 text-center text-sm text-[#7D7D7D] dark:text-grey-dark-600">
        {mode === "rotate"
          ? "Enter your current unlock password, then choose a new one."
          : mode === "reset"
            ? "Choose a new unlock password. You don't need the current one on this computer."
            : `Enter your ${seedWords.name} and choose a new unlock password.`}
      </p>

      <div className="flex flex-col gap-4">
        {mode === "rotate" && (
          <PasswordField
            label="Current password"
            value={current}
            onChange={(v) => {
              setCurrent(v);
              setCurrentError(null);
            }}
            errorMessage={currentError ?? undefined}
            placeholder="Enter your current password"
            autoComplete="current-password"
            inputRef={currentRef}
          />
        )}

        {mode === "phrase" && (
          <MnemonicField
            label={seedWords.title}
            value={mnemonic}
            onChange={(v) => {
              setMnemonic(v);
              setPhraseError(null);
            }}
            errorMessage={phraseError ?? undefined}
            placeholder={seedWords.placeholder}
            disabled={submitting}
          />
        )}

        <PasswordField
          label="New password"
          value={next}
          onChange={setNext}
          errorMessage={
            mode === "rotate" && sameAsCurrent
              ? "New password must differ from current."
              : undefined
          }
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

        {mode === "rotate" && (
          <button
            type="button"
            className="self-start text-xs text-grey-50 underline hover:text-grey-30 dark:text-grey-dark-600 dark:hover:text-grey-dark-500"
            onClick={() => setMode("reset")}
          >
            Forgot current password?
          </button>
        )}

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <OctagonAlert className="size-4 text-[#feb101]" />
            <p className="font-geist text-[14px] leading-[1.109] tracking-[-0.28px] font-medium text-black dark:text-white">
              Important
            </p>
          </div>
          <p className="font-geist text-[14px] leading-[1.4] tracking-[-0.28px] text-[#7d7d7d] dark:text-grey-dark-600">
            Your files stay as they are. Use the new password the next time you
            unlock on another computer or in Hippius Console.
          </p>
          <button
            type="button"
            onClick={() => openUrl(UNLOCK_PASSWORD_DOCS_URL)}
            className="self-start flex items-center gap-1.5 text-xs text-primary-50 hover:text-primary-40 transition-colors"
          >
            <HelpCircle className="size-3.5" />
            Learn how this works
          </button>
        </div>

        <div className="flex gap-3">
          <Button
            variant="defaultStable"
            size="auto"
            onClick={handleClose}
            disabled={submitting}
            className="h-[42px] w-full rounded-[6px] text-sm font-medium"
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="auto"
            onClick={handleSubmit}
            disabled={
              mode === "rotate"
                ? !canSubmitRotate
                : mode === "reset"
                  ? !canSubmitReset
                  : !canSubmitPhrase
            }
            loading={submitting}
            className={cn(
              "h-[42px] w-full rounded-[6px] border text-sm font-medium",
              "border-[#3167DD] bg-[#3167DD] text-white",
              "hover:bg-[#2454c4] hover:border-[#2454c4]",
              "dark:hover:bg-[#2a5ad0] dark:hover:border-[#2a5ad0]"
            )}
          >
            {submitting ? "Changing..." : "Change password"}
          </Button>
        </div>
      </div>
    </FramedDialog>
  );
};

export default ChangeRecoveryPasswordDialog;
