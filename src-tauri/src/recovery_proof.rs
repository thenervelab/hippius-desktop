//! Pure decision table: is this typed mnemonic the account's master?
//!
//! I/O lives in [`crate::recovery`]. This module only combines probe results
//! so the fail-closed rule — never reseal the server blob without
//! [`MasterProof::Confirmed`] — is unit-testable without a server, a pool,
//! or `$HOME`.
//!
//! Evaluation order (first confirmed wins; any mismatch aborts):
//! 1. mnemonic identity (`derive_verified_keys` matches the login SS58)
//! 2. drive-password row decrypts under the candidate
//! 3. local folder seals match `derive_folder_mnemonic`
//! 4. recovery-binding owned-namespaces includes this login SS58
//! 5. a remote file AEAD-opens under `derive_encryption_key`
//!
//! Anything else is [`MasterProof::Unproven`] — refuse to POST.

/// How a candidate master was confirmed to belong to this account.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProofMethod {
    /// Phrase derives the login SS58 (mnemonic-login accounts).
    MnemonicIdentity,
    /// Candidate decrypts this account's `hcfs_config.drive_password` row.
    DrivePasswordRow,
    /// Candidate re-derives the on-disk folder `enc_mnemonic.json` values.
    LocalFolderSeals,
    /// Recovery-binding owned-namespaces includes this login SS58.
    RecoveryBinding,
    /// At least one remote file decrypts under the candidate's folder key.
    RemoteDecrypt,
}

/// Outcome of proving a typed mnemonic against an account.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MasterProof {
    Confirmed { method: ProofMethod },
    Mismatch,
    Unproven,
}

/// One I/O probe, collapsed to a three-way so the combiner stays pure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Probe {
    Confirmed,
    Mismatch,
    /// Not applicable: no row, no folders, no files, feature off.
    Absent,
}

/// Snapshot of every probe. Later fields may still be [`Probe::Absent`]
/// when an earlier step already decided — the combiner is defined on
/// partial snapshots so the async gatherer can stop early.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ProofProbes {
    pub identity_match: bool,
    pub drive: Probe,
    pub folders: Probe,
    pub binding: Probe,
    pub remote: Probe,
}

impl ProofProbes {
    pub(crate) fn none() -> Self {
        Self {
            identity_match: false,
            drive: Probe::Absent,
            folders: Probe::Absent,
            binding: Probe::Absent,
            remote: Probe::Absent,
        }
    }
}

/// Combine probe results. Identity match is not a mismatch when it
/// fails: OAuth accounts have a custodial login SS58 that the sync
/// mnemonic does not derive, so a `false` here means "keep looking",
/// never "wrong phrase".
pub(crate) fn decide_master_proof(p: ProofProbes) -> MasterProof {
    if p.identity_match {
        return MasterProof::Confirmed {
            method: ProofMethod::MnemonicIdentity,
        };
    }
    match p.drive {
        Probe::Confirmed => {
            return MasterProof::Confirmed {
                method: ProofMethod::DrivePasswordRow,
            };
        }
        Probe::Mismatch => return MasterProof::Mismatch,
        Probe::Absent => {}
    }
    match p.folders {
        Probe::Confirmed => {
            return MasterProof::Confirmed {
                method: ProofMethod::LocalFolderSeals,
            };
        }
        Probe::Mismatch => return MasterProof::Mismatch,
        Probe::Absent => {}
    }
    match p.binding {
        Probe::Confirmed => {
            return MasterProof::Confirmed {
                method: ProofMethod::RecoveryBinding,
            };
        }
        Probe::Mismatch => return MasterProof::Mismatch,
        Probe::Absent => {}
    }
    match p.remote {
        Probe::Confirmed => {
            return MasterProof::Confirmed {
                method: ProofMethod::RemoteDecrypt,
            };
        }
        Probe::Mismatch => return MasterProof::Mismatch,
        Probe::Absent => {}
    }
    MasterProof::Unproven
}

/// One remote file/folder probe. Pure so transport vs decrypt-miss
/// cannot be collapsed into "wrong phrase" without a test noticing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RemoteAttempt {
    Opened,
    DecryptMiss,
    Transport,
    EmptyFolder,
}

/// Fold of remote attempts. Transport never becomes [`Probe::Mismatch`]:
/// a timeout is not a wrong seed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RemoteProbeOutcome {
    Confirmed,
    Mismatch,
    Unproven,
    Transport,
}

pub(crate) fn classify_remote_attempts(attempts: &[RemoteAttempt]) -> RemoteProbeOutcome {
    if attempts.iter().any(|a| matches!(a, RemoteAttempt::Opened)) {
        return RemoteProbeOutcome::Confirmed;
    }
    if attempts.iter().any(|a| matches!(a, RemoteAttempt::Transport)) {
        return RemoteProbeOutcome::Transport;
    }
    if attempts.iter().any(|a| matches!(a, RemoteAttempt::DecryptMiss)) {
        return RemoteProbeOutcome::Mismatch;
    }
    RemoteProbeOutcome::Unproven
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_match_confirms_without_other_probes() {
        let mut p = ProofProbes::none();
        p.identity_match = true;
        assert_eq!(
            decide_master_proof(p),
            MasterProof::Confirmed {
                method: ProofMethod::MnemonicIdentity
            }
        );
    }

    #[test]
    fn oauth_identity_split_is_not_a_mismatch() {
        // identity_match=false is the OAuth shape, not "wrong phrase".
        assert_eq!(decide_master_proof(ProofProbes::none()), MasterProof::Unproven);
    }

    #[test]
    fn drive_password_mismatch_aborts_before_later_probes() {
        let p = ProofProbes {
            identity_match: false,
            drive: Probe::Mismatch,
            folders: Probe::Confirmed,
            binding: Probe::Confirmed,
            remote: Probe::Confirmed,
        };
        assert_eq!(decide_master_proof(p), MasterProof::Mismatch);
    }

    #[test]
    fn drive_password_confirm_wins() {
        let mut p = ProofProbes::none();
        p.drive = Probe::Confirmed;
        assert_eq!(
            decide_master_proof(p),
            MasterProof::Confirmed {
                method: ProofMethod::DrivePasswordRow
            }
        );
    }

    #[test]
    fn folder_mismatch_aborts() {
        let mut p = ProofProbes::none();
        p.folders = Probe::Mismatch;
        assert_eq!(decide_master_proof(p), MasterProof::Mismatch);
    }

    #[test]
    fn folder_confirm_wins_when_drive_absent() {
        let mut p = ProofProbes::none();
        p.folders = Probe::Confirmed;
        assert_eq!(
            decide_master_proof(p),
            MasterProof::Confirmed {
                method: ProofMethod::LocalFolderSeals
            }
        );
    }

    #[test]
    fn binding_confirm_wins_when_local_state_absent() {
        let mut p = ProofProbes::none();
        p.binding = Probe::Confirmed;
        assert_eq!(
            decide_master_proof(p),
            MasterProof::Confirmed {
                method: ProofMethod::RecoveryBinding
            }
        );
    }

    #[test]
    fn remote_decrypt_confirm_wins_on_fresh_device() {
        let mut p = ProofProbes::none();
        p.remote = Probe::Confirmed;
        assert_eq!(
            decide_master_proof(p),
            MasterProof::Confirmed {
                method: ProofMethod::RemoteDecrypt
            }
        );
    }

    #[test]
    fn remote_mismatch_when_files_exist_but_none_decrypt() {
        let mut p = ProofProbes::none();
        p.remote = Probe::Mismatch;
        assert_eq!(decide_master_proof(p), MasterProof::Mismatch);
    }

    #[test]
    fn empty_account_with_nothing_to_check_is_unproven() {
        assert_eq!(decide_master_proof(ProofProbes::none()), MasterProof::Unproven);
    }

    #[test]
    fn remote_opened_confirms_even_if_later_attempts_fail() {
        assert_eq!(
            classify_remote_attempts(&[RemoteAttempt::DecryptMiss, RemoteAttempt::Opened, RemoteAttempt::Transport]),
            RemoteProbeOutcome::Confirmed
        );
    }

    #[test]
    fn remote_decrypt_miss_only_is_mismatch() {
        assert_eq!(
            classify_remote_attempts(&[RemoteAttempt::EmptyFolder, RemoteAttempt::DecryptMiss]),
            RemoteProbeOutcome::Mismatch
        );
    }

    #[test]
    fn remote_transport_is_not_a_wrong_phrase() {
        assert_eq!(classify_remote_attempts(&[RemoteAttempt::Transport]), RemoteProbeOutcome::Transport);
        assert_eq!(
            classify_remote_attempts(&[RemoteAttempt::DecryptMiss, RemoteAttempt::Transport]),
            RemoteProbeOutcome::Transport
        );
    }

    #[test]
    fn remote_empty_folders_are_unproven() {
        assert_eq!(classify_remote_attempts(&[]), RemoteProbeOutcome::Unproven);
        assert_eq!(classify_remote_attempts(&[RemoteAttempt::EmptyFolder]), RemoteProbeOutcome::Unproven);
    }
}
