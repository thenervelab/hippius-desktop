// Pure form/error logic for the recovery-password rotation dialog, extracted so
// the submit gate and the wrong-password classification can be unit-tested
// without rendering. All crypto/decryption rules stay in Rust; this is purely
// the client-side gate and error routing.

/** Confirm field set and disagreeing with the new password. */
export const isPasswordMismatch = (next: string, confirm: string): boolean =>
  confirm.length > 0 && confirm !== next;

/** New password equals the current one (a no-op rotation). */
export const isSameAsCurrent = (current: string, next: string): boolean =>
  next.length > 0 && next === current;

/**
 * Whether the rotation form may be submitted: not already submitting, all three
 * fields present, the strength meter accepts it, confirm matches, and it isn't
 * a no-op (next === current).
 */
export function canSubmitRecoveryRotation(form: {
  submitting: boolean;
  current: string;
  next: string;
  confirm: string;
  strength: { acceptableForSubmit: boolean } | null | undefined;
}): boolean {
  return (
    !form.submitting &&
    form.current.length > 0 &&
    form.next.length > 0 &&
    form.strength?.acceptableForSubmit === true &&
    !isPasswordMismatch(form.next, form.confirm) &&
    !isSameAsCurrent(form.current, form.next) &&
    form.next === form.confirm
  );
}

/** Settings forgot-password when the session already holds the master. */
export function canSubmitNewPasswordOnly(form: {
  submitting: boolean;
  next: string;
  confirm: string;
  strength: { acceptableForSubmit: boolean } | null | undefined;
}): boolean {
  return (
    !form.submitting &&
    form.next.length > 0 &&
    form.strength?.acceptableForSubmit === true &&
    form.next === form.confirm
  );
}

/** Unlock/settings phrase restore: seed + new password + confirm. */
export function canSubmitPhraseRestore(form: {
  submitting: boolean;
  mnemonic: string;
  next: string;
  confirm: string;
  strength: { acceptableForSubmit: boolean } | null | undefined;
}): boolean {
  return (
    !form.submitting &&
    form.mnemonic.trim().length > 0 &&
    canSubmitNewPasswordOnly({
      submitting: form.submitting,
      next: form.next,
      confirm: form.confirm,
      strength: form.strength,
    })
  );
}

export type RotationError = "wrong_password" | "mnemonic_missing" | "generic";

/**
 * Classify a rotation failure. Rust surfaces a bad current password as
 * `Validation("Wrong passphrase.")`; that case re-prompts the current field
 * inline. `mnemonic_missing` is the Settings forgot path when this device
 * cannot open the master — the FE switches to the seed form.
 */
export const classifyRotationError = (message: string): RotationError => {
  if (/wrong passphrase/i.test(message)) return "wrong_password";
  if (/doesn't have your mnemonic seed/i.test(message)) return "mnemonic_missing";
  return "generic";
};
