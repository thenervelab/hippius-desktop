//! Backwards-compatible migration of drive password ↔ recovery password.
//!
//! # Context
//!
//! Before PR #307 shipped always-on recovery, users had a `drive_password`
//! in `hcfs_config` (encrypts folder mnemonics) set during sync setup, and
//! nothing else. PR #307 added a **separate** recovery password that seals
//! a blob on hcfs-server and encrypts `master_enc_mnemonic.json`. Depending
//! on what the user typed in each prompt, the two passwords may or may not
//! be the same string.
//!
//! # Goal
//!
//! Unify them: **the drive password is the canonical password**, and on
//! first launch after this code ships we automatically bring the server
//! blob + master file into line with it. Users never re-enter anything.
//!
//! # Design
//!
//! The decision is a pure state machine (see [`decide_migration`] and the
//! truth table below). I/O — DB reads, server probes, folder-unlock
//! samples — lives separately so the decision logic can be proven correct
//! in isolation with zero mocks.
//!
//! | has_drive_pw | has_blob | drive→blob    | folder_unlock         | Decision                      |
//! |--------------|----------|---------------|-----------------------|-------------------------------|
//! | false        | false    | —             | —                     | NoMigrationNeeded             |
//! | false        | true     | —             | —                     | DeferUntilUnlock              |
//! | true         | false    | —             | NoFoldersToCheck      | AutoSealAndUpload             |
//! | true         | false    | —             | DrivePasswordWorks    | AutoSealAndUpload             |
//! | true         | false    | —             | DrivePasswordFails    | AbortStaleDrivePassword       |
//! | true         | true     | Some(true)    | any                   | AlreadyAligned                |
//! | true         | true     | Some(false)   | NoFoldersToCheck      | AbortStaleDrivePassword       |
//! | true         | true     | Some(false)   | DrivePasswordWorks    | ResealUnderDrivePassword      |
//! | true         | true     | Some(false)   | DrivePasswordFails    | AbortStaleDrivePassword       |

#![allow(dead_code, reason = "Step 1 lands the pure decision logic. Wiring into session_restore + I/O arrives in Step 3+ per the migration plan.")]

/// Inputs gathered from disk / server, fed into [`decide_migration`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct MigrationInputs {
    /// `true` iff the active account has a non-empty `hcfs_config.drive_password`.
    pub has_drive_password: bool,
    /// `true` iff `GET /v1/mnemonic-blob` returned 200 for this account.
    pub has_server_blob: bool,
    /// Tri-state: `None` when there's no blob to test against; `Some(true)`
    /// when the (decrypted) drive password successfully opens the blob;
    /// `Some(false)` when it doesn't.
    pub drive_password_decrypts_blob: Option<bool>,
    /// Tri-state verification that the drive password is still real — i.e.
    /// that it unlocks at least one existing folder `enc_mnemonic.json`.
    pub folder_unlock_check: FolderUnlockCheck,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FolderUnlockCheck {
    /// No sync folders are configured for this account yet.
    NoFoldersToCheck,
    /// At least one folder's `enc_mnemonic.json` decrypts under the drive password.
    DrivePasswordWorks,
    /// A folder's `enc_mnemonic.json` exists but does not decrypt — the
    /// drive password is stale / wrong.
    DrivePasswordFails,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MigrationDecision {
    /// No migration action required. Set the migrated flag and move on.
    NoMigrationNeeded,
    /// Server blob and drive password already agree. Set the flag.
    AlreadyAligned,
    /// No blob yet; seal the master mnemonic under the drive password and
    /// POST it. State B (sync set up, pre-always-on-recovery).
    AutoSealAndUpload,
    /// Blob exists under a different password but the drive password is
    /// real (verified by a folder unlock). Re-seal under the drive password.
    /// State C-conflict.
    ResealUnderDrivePassword,
    /// Blob exists but we have no drive password yet. Wait for the normal
    /// unlock flow to collect one. State D.
    DeferUntilUnlock,
    /// Drive password is stale or wrong, or we can't verify it is real.
    /// Don't touch the server. The user will re-align naturally on their
    /// next manual password entry (rotation or unlock).
    AbortStaleDrivePassword { reason: &'static str },
}

/// Decide what to do given the inputs. Pure function — no I/O, no side effects.
///
/// See module docs for the full truth table. Every case is covered by a
/// unit test below.
pub(crate) fn decide_migration(inputs: MigrationInputs) -> MigrationDecision {
    match (inputs.has_drive_password, inputs.has_server_blob) {
        // --- No drive password ---
        (false, false) => MigrationDecision::NoMigrationNeeded,
        (false, true) => MigrationDecision::DeferUntilUnlock,

        // --- Drive password, no blob (state B) ---
        (true, false) => match inputs.folder_unlock_check {
            FolderUnlockCheck::NoFoldersToCheck | FolderUnlockCheck::DrivePasswordWorks => {
                MigrationDecision::AutoSealAndUpload
            }
            FolderUnlockCheck::DrivePasswordFails => MigrationDecision::AbortStaleDrivePassword {
                reason: "drive password does not unlock existing folder mnemonics — treating as stale",
            },
        },

        // --- Drive password + blob (states C/E) ---
        (true, true) => match inputs.drive_password_decrypts_blob {
            Some(true) => MigrationDecision::AlreadyAligned,
            Some(false) => match inputs.folder_unlock_check {
                FolderUnlockCheck::DrivePasswordWorks => MigrationDecision::ResealUnderDrivePassword,
                FolderUnlockCheck::NoFoldersToCheck => MigrationDecision::AbortStaleDrivePassword {
                    reason: "blob exists under a different password and no folders exist to verify the drive password against",
                },
                FolderUnlockCheck::DrivePasswordFails => MigrationDecision::AbortStaleDrivePassword {
                    reason: "both the server blob and folder mnemonics reject the drive password — user must re-align manually",
                },
            },
            // Invariant: has_server_blob=true implies drive_password_decrypts_blob=Some.
            // `None` means the caller constructed MigrationInputs incorrectly;
            // treat it as a stale-password abort rather than silently proceeding.
            None => MigrationDecision::AbortStaleDrivePassword {
                reason: "internal: has_server_blob=true but drive_password_decrypts_blob=None",
            },
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inputs(
        has_drive_password: bool,
        has_server_blob: bool,
        drive_password_decrypts_blob: Option<bool>,
        folder_unlock_check: FolderUnlockCheck,
    ) -> MigrationInputs {
        MigrationInputs {
            has_drive_password,
            has_server_blob,
            drive_password_decrypts_blob,
            folder_unlock_check,
        }
    }

    // State A — fresh install.
    #[test]
    fn fresh_install_no_migration_needed() {
        let d = decide_migration(inputs(false, false, None, FolderUnlockCheck::NoFoldersToCheck));
        assert_eq!(d, MigrationDecision::NoMigrationNeeded);
    }

    // State D — blob exists but no drive password yet; wait for normal unlock.
    #[test]
    fn blob_only_defers_until_unlock() {
        let d = decide_migration(inputs(false, true, Some(false), FolderUnlockCheck::NoFoldersToCheck));
        assert_eq!(d, MigrationDecision::DeferUntilUnlock);

        // The blob-only case must also defer regardless of folder check,
        // because folder_unlock_check is meaningless without a drive password.
        let d = decide_migration(inputs(false, true, Some(true), FolderUnlockCheck::DrivePasswordWorks));
        assert_eq!(d, MigrationDecision::DeferUntilUnlock);
    }

    // State B (sub-case): user signed up, drive password set, no folders yet.
    // Trust the freshly-typed password and seal.
    #[test]
    fn state_b_no_folders_auto_seals() {
        let d = decide_migration(inputs(true, false, None, FolderUnlockCheck::NoFoldersToCheck));
        assert_eq!(d, MigrationDecision::AutoSealAndUpload);
    }

    // State B (common case): drive password verified against an existing folder.
    #[test]
    fn state_b_verified_folder_auto_seals() {
        let d = decide_migration(inputs(true, false, None, FolderUnlockCheck::DrivePasswordWorks));
        assert_eq!(d, MigrationDecision::AutoSealAndUpload);
    }

    // Safety: drive password exists but does not unlock folders — don't seal.
    #[test]
    fn state_b_stale_drive_password_aborts() {
        let d = decide_migration(inputs(true, false, None, FolderUnlockCheck::DrivePasswordFails));
        match d {
            MigrationDecision::AbortStaleDrivePassword { reason } => {
                assert!(reason.contains("stale"), "reason={reason}");
            }
            other => panic!("expected AbortStaleDrivePassword, got {other:?}"),
        }
    }

    // State C-aligned / State E — drive password already opens the blob.
    #[test]
    fn state_c_aligned_is_noop() {
        let d = decide_migration(inputs(true, true, Some(true), FolderUnlockCheck::DrivePasswordWorks));
        assert_eq!(d, MigrationDecision::AlreadyAligned);

        // Aligned even when there are no folders (fresh device that recovered then set up sync).
        let d = decide_migration(inputs(true, true, Some(true), FolderUnlockCheck::NoFoldersToCheck));
        assert_eq!(d, MigrationDecision::AlreadyAligned);
    }

    // State C-conflict: blob under a different password, no folders to verify against → safety abort.
    #[test]
    fn state_c_conflict_no_folders_aborts() {
        let d = decide_migration(inputs(true, true, Some(false), FolderUnlockCheck::NoFoldersToCheck));
        match d {
            MigrationDecision::AbortStaleDrivePassword { reason } => {
                assert!(reason.contains("no folders"), "reason={reason}");
            }
            other => panic!("expected AbortStaleDrivePassword, got {other:?}"),
        }
    }

    // State C-conflict: drive password opens folders but not the blob → re-seal.
    #[test]
    fn state_c_conflict_reseals_under_drive_password() {
        let d = decide_migration(inputs(true, true, Some(false), FolderUnlockCheck::DrivePasswordWorks));
        assert_eq!(d, MigrationDecision::ResealUnderDrivePassword);
    }

    // State C-conflict: both passwords wrong → abort (user must re-align manually).
    #[test]
    fn state_c_conflict_folders_fail_aborts() {
        let d = decide_migration(inputs(true, true, Some(false), FolderUnlockCheck::DrivePasswordFails));
        match d {
            MigrationDecision::AbortStaleDrivePassword { reason } => {
                assert!(reason.contains("manually"), "reason={reason}");
            }
            other => panic!("expected AbortStaleDrivePassword, got {other:?}"),
        }
    }

    // Invariant-violation guard: has_server_blob=true but decrypt check is None.
    // Callers should never construct this, but if they do we must abort, not
    // proceed silently.
    #[test]
    fn invariant_violation_aborts() {
        let d = decide_migration(inputs(true, true, None, FolderUnlockCheck::DrivePasswordWorks));
        match d {
            MigrationDecision::AbortStaleDrivePassword { reason } => {
                assert!(reason.contains("internal"), "reason={reason}");
            }
            other => panic!("expected AbortStaleDrivePassword, got {other:?}"),
        }
    }

    // Exhaustive: enumerate every input combination and assert each falls
    // into exactly one decision (no panics, no unreachables). This catches
    // any match-arm gap a future refactor might introduce.
    #[test]
    fn every_input_combination_yields_a_decision() {
        let folder_checks = [
            FolderUnlockCheck::NoFoldersToCheck,
            FolderUnlockCheck::DrivePasswordWorks,
            FolderUnlockCheck::DrivePasswordFails,
        ];
        let drive_decrypts = [None, Some(true), Some(false)];

        for &has_drive in &[false, true] {
            for &has_blob in &[false, true] {
                for &decrypts in &drive_decrypts {
                    for &folder in &folder_checks {
                        let d = decide_migration(inputs(has_drive, has_blob, decrypts, folder));
                        // Any variant is fine; the point is the call
                        // doesn't panic and always returns.
                        let _ = d;
                    }
                }
            }
        }
    }
}
