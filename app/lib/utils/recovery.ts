import { invoke } from "@tauri-apps/api/core";

import type { RecoveryCheck } from "@/lib/global-atoms/recoveryAtoms";

/**
 * Passphrase strength verdict from Rust. The UI renders this into a
 * meter; all scoring rules live on the Rust side so thresholds and
 * copy can evolve without a frontend change.
 */
export type PassphraseVerdict = "too_short" | "weak" | "ok" | "strong";

/** Output of [`validateRecoveryPassword`]. */
export interface PassphraseStrength {
  bits: number;
  verdict: PassphraseVerdict;
  /** Rust-owned user-facing label: "Too short", "Weak", "OK", "Strong". */
  label: string;
  /** 0–100 meter fill, clamped in Rust. */
  progressPercent: number;
  hints: string[];
  /**
   * Authoritative submit gate. UI disables submit on this value; Rust
   * commands re-check so a tampered frontend can't bypass.
   */
  acceptableForSubmit: boolean;
}

/** Live strength check; debounce on the FE side. */
export async function validateRecoveryPassword(passphrase: string): Promise<PassphraseStrength> {
  return invoke<PassphraseStrength>("validate_recovery_password", { passphrase });
}

/**
 * Probe the current recovery state for the active account.
 *
 * Safe to call from any mounted component — the backend short-circuits
 * to `proceed` when a local mnemonic exists, so there's no unnecessary
 * server round-trip on returning devices. Network failure surfaces as
 * `recommendedFlow === "unknown"` rather than throwing so the FE can
 * show a retry prompt.
 */
export async function checkRecoveryState(): Promise<RecoveryCheck> {
  return invoke<RecoveryCheck>("check_recovery_state");
}

/**
 * Decrypt the server-stored recovery blob with the user's password and
 * install the recovered mnemonic into the local store. Resolves the
 * recovery gate on success, so the blocked `ensure_sync_mnemonic` call
 * in `auto_init_sync` can proceed.
 *
 * Wrong password surfaces as an `AppError::Validation` from the
 * backend — caught and displayed inline by the Unlock branch.
 */
export async function recoverMnemonic(password: string): Promise<void> {
  await invoke("recover_mnemonic", { password });
}

/**
 * Seal the account's mnemonic under `password` and upload it to
 * hcfs-server. Used by both the OAuth signup dialog (where the
 * mnemonic is minted inside the command) and the existing-user
 * migration prompt (where a local mnemonic already exists). Resolves
 * the recovery gate on success.
 */
export async function sealAndUploadMnemonic(password: string): Promise<void> {
  await invoke("seal_and_upload_mnemonic", { password });
}

/**
 * Mark the recovery gate as skipped without performing any action.
 * The Proceed branch uses this when a local mnemonic is already
 * present — there's nothing to recover or upload, and sync can
 * continue immediately.
 */
export async function markRecoverySkipped(): Promise<void> {
  await invoke("mark_recovery_skipped");
}

/**
 * Rotate the recovery password for the active account.
 *
 * Delegates to Rust (`change_recovery_password`) which fetches the sealed
 * blob, decrypts with `currentPassword`, re-seals under `newPassword`,
 * POSTs the upsert, and rewrites the local master_enc_mnemonic.json.
 * If the local rewrite fails after a successful upload, a sidecar is
 * written and the next launch finishes it. That case resolves with
 * `alignPending: true` so the caller can warn instead of claiming a clean
 * success (audit R-19); a fully-applied rotation resolves with `false`.
 */
export async function changeRecoveryPassword(
  currentPassword: string,
  newPassword: string,
): Promise<{ alignPending: boolean }> {
  return await invoke<{ alignPending: boolean }>("change_recovery_password", {
    current: currentPassword,
    new: newPassword,
  });
}

/**
 * Prove a typed mnemonic belongs to this account, then reseal the
 * unlock wrap under `newPassword`. Used when the user forgot the
 * unlock password but still has the seed. Rust refuses to POST unless
 * the phrase is confirmed — a wrong phrase cannot overwrite the blob.
 */
export async function restoreWithMnemonic(
  mnemonic: string,
  newPassword: string,
): Promise<{ alignPending: boolean }> {
  return await invoke<{ alignPending: boolean }>("restore_with_mnemonic", {
    mnemonic,
    newPassword,
  });
}

/**
 * Reseal the unlock wrap under `newPassword` using the session's
 * already-held master. Fails with Validation when this device cannot
 * open the mnemonic — the FE then switches to {@link restoreWithMnemonic}.
 */
export async function resetUnlockPassword(
  newPassword: string,
): Promise<{ alignPending: boolean }> {
  return await invoke<{ alignPending: boolean }>("reset_unlock_password", {
    newPassword,
  });
}

/** Finish a rotation whose local-rewrite step failed on a previous run. */
export async function resumeRecoveryPasswordRotation(password: string): Promise<void> {
  await invoke("resume_recovery_password_rotation", { password });
}

/** `true` when a rotation-pending sidecar is on disk for the active account. */
export async function hasPendingRotation(): Promise<boolean> {
  return invoke<boolean>("has_pending_rotation");
}
