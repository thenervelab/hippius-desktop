"use client";

import React, { useEffect, useState } from "react";

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

export const PasswordField: React.FC<{
  label: string;
  value: string;
  onChange: (v: string) => void;
  errorMessage?: string;
  /** When provided, Enter key triggers submit. */
  onSubmit?: () => void;
  autoComplete?: "current-password" | "new-password";
  placeholder?: string;
}> = ({ label, value, onChange, errorMessage, onSubmit, autoComplete = "new-password", placeholder }) => {
  const [visible, setVisible] = useState(false);
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-grey-40 dark:text-grey-dark-600">{label}</span>
      <div className="relative">
        <Input
          type={visible ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-invalid={Boolean(errorMessage)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && onSubmit) {
              e.preventDefault();
              onSubmit();
            }
          }}
          autoComplete={autoComplete}
          autoCapitalize="off"
          spellCheck={false}
          className="w-full pr-10"
        />
        <button
          type="button"
          tabIndex={-1}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-grey-50 hover:text-grey-30 transition-colors"
          onClick={(e) => {
            e.preventDefault();
            setVisible((v) => !v);
          }}
        >
          {visible ? (
            <Icons.EyeOff className="size-4" />
          ) : (
            <Icons.Eye className="size-4" />
          )}
        </button>
      </div>
      {errorMessage && <span className="text-xs text-error-60">{errorMessage}</span>}
    </label>
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

  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-grey-40 dark:text-grey-dark-600">{label}</span>
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
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={3}
          disabled={disabled}
          aria-invalid={isInvalid}
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
        <span className="text-xs text-error-60">{errorMessage}</span>
      )}
    </label>
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
