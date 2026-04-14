"use client";

import React, { useEffect } from "react";

import { Input } from "@/components/ui";
import {
  PassphraseStrength,
  validateRecoveryPassword,
} from "@/app/lib/utils/recovery";
import { cn } from "@/lib/utils";

/**
 * Shared recovery-dialog UI primitives. Used by
 * `AccountRecoveryDialog.tsx` and `ExistingUserRecoveryPrompt.tsx` so
 * the signup form and the migration nag stay visually and behaviourally
 * identical — both password fields, both strength meters, same debounce.
 */

export const PasswordField: React.FC<{
  label: string;
  value: string;
  onChange: (v: string) => void;
  errorMessage?: string;
  /** When provided, Enter key triggers submit. */
  onSubmit?: () => void;
  autoComplete?: "current-password" | "new-password";
}> = ({ label, value, onChange, errorMessage, onSubmit, autoComplete = "new-password" }) => (
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
      autoComplete={autoComplete}
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
