import { atom } from "jotai";

/** Matches the Rust `RecoveryFlow` enum — `snake_case` wire values. */
export type RecoveryFlow = "signup" | "unlock" | "proceed" | "unknown";

/** Matches the Rust `RecoveryCheck` struct (camelCase on the wire). */
export interface RecoveryCheck {
  hasServerBlob: boolean;
  hasLocalMnemonic: boolean;
  updatedAt: string | null;
  recommendedFlow: RecoveryFlow;
  /**
   * `true` iff the account pre-dates always-on recovery (local mnemonic
   * exists but no server blob). Rust-computed so the nag policy stays
   * backend-owned; the FE just renders on this flag.
   */
  shouldPromptLegacyMigration: boolean;
}

/**
 * Active recovery check — non-null means the `AccountRecoveryDialog` is
 * mounted with this payload. `RecoveryEventListener` sets it when the
 * backend emits `oauth_recovery_check_needed` after OAuth; the dialog
 * clears it once the user has resolved their branch (or the Proceed
 * branch auto-clears).
 */
export const activeRecoveryCheckAtom = atom<RecoveryCheck | null>(null);
