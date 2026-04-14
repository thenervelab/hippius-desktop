import { invoke } from "@tauri-apps/api/core";

import type { RecoveryCheck } from "@/lib/global-atoms/recoveryAtoms";

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
