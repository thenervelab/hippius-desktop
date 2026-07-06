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

export type RotationError = "wrong_password" | "generic";

/**
 * Classify a rotation failure. Rust surfaces a bad current password as
 * `Validation("Wrong passphrase.")`; that case re-prompts the current field
 * inline, everything else is a generic toast.
 */
export const classifyRotationError = (message: string): RotationError =>
  /wrong passphrase/i.test(message) ? "wrong_password" : "generic";
