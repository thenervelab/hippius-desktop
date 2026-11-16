"use client";

import React, { useEffect, useId, useState } from "react";

import { Input, Icons } from "@/components/ui";
import {
  inputFieldControlClassName,
  inputFieldShellClassName,
} from "@/components/ui/input";
import {
  PassphraseStrength,
  validateRecoveryPassword,
} from "@/app/lib/utils/recovery";
import { cn } from "@/lib/utils";

/** Documentation URL explaining unlock-password and encryption flow. */
export const UNLOCK_PASSWORD_DOCS_URL =
  "https://docs.hippius.com/use/desktop/file-system#unlock-password";

/**
 * Shared recovery-dialog UI primitives. Used across the
 * `AccountRecoveryDialog.tsx` branches (signup / unlock) and
 * `ChangeRecoveryPasswordDialog` so every recovery form stays visually
 * and behaviourally identical — same password fields, mnemonic field,
 * strength meters, and debounce.
 */

/**
 * What the 12 words are called for this account. Accounts that sign in with
 * Google or another provider back them up as their **recovery seed**;
 * accounts that sign in with the words call them their **access key**.
 */
export interface SeedWords {
  /** Mid-sentence name: "recovery seed" / "access key". */
  name: string;
  /** Field label in Title Case: "Recovery Seed" / "Access Key". */
  title: string;
  placeholder: string;
}

export function seedWordsFor(authType: "mnemonic" | "oauth" | null | undefined): SeedWords {
  return authType === "mnemonic"
    ? {
        name: "access key",
        title: "Access Key",
        placeholder: "Enter or paste your 12-word access key",
      }
    : {
        name: "recovery seed",
        title: "Recovery Seed",
        placeholder: "Enter or paste your 12-word recovery seed",
      };
}

export const PasswordField: React.FC<{
  label: string;
  value: string;
  onChange: (v: string) => void;
  errorMessage?: string;
  /** When provided, Enter key triggers submit. */
  onSubmit?: () => void;
  autoComplete?: "current-password" | "new-password";
  placeholder?: string;
  inputRef?: React.Ref<HTMLInputElement>;
  autoFocus?: boolean;
  /** Keeps the value and focus while a submit is being checked. */
  readOnly?: boolean;
}> = ({
  label,
  value,
  onChange,
  errorMessage,
  onSubmit,
  autoComplete = "new-password",
  placeholder,
  inputRef,
  autoFocus,
  readOnly,
}) => {
  const [visible, setVisible] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const id = useId();
  const errorId = `${id}-error`;
  const capsId = `${id}-caps`;
  const describedBy =
    [errorMessage ? errorId : null, capsLock ? capsId : null]
      .filter(Boolean)
      .join(" ") || undefined;
  // `getModifierState` reports Caps Lock on any key event, so the note
  // follows the key as it is toggled while typing.
  const trackCapsLock = (e: React.KeyboardEvent<HTMLInputElement>) => {
    setCapsLock(e.getModifierState?.("CapsLock") ?? false);
  };

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs text-grey-40 dark:text-grey-dark-600">
        {label}
      </label>
      <div className="relative">
        <Input
          id={id}
          ref={inputRef}
          type={visible ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-invalid={Boolean(errorMessage)}
          aria-describedby={describedBy}
          autoFocus={autoFocus}
          readOnly={readOnly}
          onKeyDown={(e) => {
            trackCapsLock(e);
            if (e.key === "Enter" && onSubmit) {
              e.preventDefault();
              onSubmit();
            }
          }}
          onKeyUp={trackCapsLock}
          onBlur={() => setCapsLock(false)}
          autoComplete={autoComplete}
          autoCapitalize="off"
          spellCheck={false}
          className="w-full pr-10"
        />
        <button
          type="button"
          aria-label={visible ? "Hide password" : "Show password"}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-grey-50 hover:text-grey-30 transition-colors"
          onClick={(e) => {
            e.preventDefault();
            setVisible((v) => !v);
          }}
        >
          {visible ? (
            <Icons.EyeOff className="size-4" aria-hidden="true" />
          ) : (
            <Icons.Eye className="size-4" aria-hidden="true" />
          )}
        </button>
      </div>
      {capsLock && (
        <span id={capsId} className="text-xs text-grey-50 dark:text-grey-dark-600">
          Caps Lock is on.
        </span>
      )}
      {errorMessage && (
        <span id={errorId} role="alert" className="text-xs text-error-60">
          {errorMessage}
        </span>
      )}
    </div>
  );
};

/**
 * Multi-line mnemonic entry using the same Input shell as PasswordField
 * and the rest of the app's dialog fields (`rounded-[8px]`, dark
 * `#494949` / `#1f1f1f`, focus ring). Keep the 4px halo — recovery
 * dialogs sit PasswordField next to this, so stripping it here would
 * make the seed box look like a different control.
 */
export const MnemonicField: React.FC<{
  label: string;
  value: string;
  onChange: (v: string) => void;
  errorMessage?: string;
  placeholder?: string;
  disabled?: boolean;
}> = ({ label, value, onChange, errorMessage, placeholder, disabled }) => {
  const isInvalid = Boolean(errorMessage);
  const id = useId();
  const errorId = `${id}-error`;

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs text-grey-40 dark:text-grey-dark-600">
        {label}
      </label>
      <div
        className={cn(
          inputFieldShellClassName,
          "min-h-[91px] items-start",
          disabled && "cursor-not-allowed opacity-60",
          isInvalid &&
            "border-error-70 shadow-[0px_0px_0px_4px_rgba(235,87,87,0.12)]",
        )}
      >
        <textarea
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={3}
          disabled={disabled}
          aria-invalid={isInvalid}
          aria-describedby={isInvalid ? errorId : undefined}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          className={cn(
            inputFieldControlClassName,
            "min-h-[59px] resize-none",
          )}
        />
      </div>
      {errorMessage && (
        <span id={errorId} role="alert" className="text-xs text-error-60">
          {errorMessage}
        </span>
      )}
    </div>
  );
};

const VERDICT_BARS: Record<string, string> = {
  too_short: "bg-grey-70",
  weak: "bg-error-60",
  ok: "bg-warning-50",
  strong: "bg-success-50",
};

export const StrengthMeter: React.FC<{ strength: PassphraseStrength | null }> = ({ strength }) => {
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

/**
 * Debounced live passphrase strength fetcher. Every score call goes
 * through the Rust IPC so scoring rules never diverge between backend
 * and frontend.
 */
export function useLiveStrength(password: string, setStrength: (s: PassphraseStrength | null) => void) {
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

/** Best-effort coercion of an unknown error to a user-facing string. */
export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}
