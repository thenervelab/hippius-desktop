//! Read-only probe: which keys can open a re-keyed drive's remote files?
//!
//! A re-key (`ensure_derived_mnemonic`) overwrites the drive's folder key.
//! Remote files uploaded under the previous key stay on the server, and every
//! sync re-downloads and fails to open the ones with no local copy. The
//! previous key is often NOT gone, just not where the engine looks:
//!
//! - `RawMasterInFolderSeal`: the old folder key WAS the account master, which
//!   is still on disk.
//! - Since hcfs `02191cc`, `save_encrypted_mnemonic` leaves the blob it
//!   replaced as a `.bak`, so a re-key on a current build keeps the previous
//!   folder seal beside the new one.
//! - `DerivedFromAnotherMaster`: the other master may be the server's mnemonic
//!   blob (it has two writers) or an older recovery phrase the user still has.
//!
//! This module answers, from ONE metadata listing and no file content, how
//! many of a drive's remote files each of those candidates opens. It is the
//! evidence step before any recovery flow is built: a candidate that opens
//! nothing is ruled out having touched nothing.
//!
//! The test is a file's `encrypted_path`: hcfs encrypts a file's path and its
//! contents with the same drive key (`Drive::upload`), so a key that opens the
//! path opens the file. This module never downloads, writes, or deletes —
//! pinned by `the_probe_is_read_only`.

use crate::app_state::AppState;
use crate::error::{AppError, Result};
use crate::sync::mnemonic::{config_dir_for_folder, derive_folder_mnemonic, master_mnemonic_path};
use crate::sync::remote::{build_client, encryption_key_for_label, encryption_key_from_phrase, session_mnemonic};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tracing::info;
use zeroize::{Zeroize, Zeroizing};

/// A place a drive's previous folder key might still be found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum KeyCandidate {
    /// The account master used directly as the folder phrase — the state
    /// `RekeyReason::RawMasterInFolderSeal` repaired.
    LocalMasterAsFolderKey,
    /// `enc_mnemonic.json.bak`: the folder seal the last overwrite replaced.
    PreviousFolderSeal,
    /// `master_enc_mnemonic.json.bak`: the master the last overwrite replaced,
    /// derived for this drive's label.
    PreviousMaster,
    /// A recovery phrase the user typed in, derived for this drive's label.
    SuppliedMaster,
}

/// What happened when a candidate was tried.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CandidateOutcome {
    /// No key could be built from this source; `reason` says why in words a
    /// support engineer can act on. Not an error: most drives have no `.bak`.
    Unavailable { reason: String },
    /// The key was tried against every listed file. `rescues` counts files it
    /// opens that the current key does NOT — the ones it would recover.
    Tried { rescues: usize },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateResult {
    pub candidate: KeyCandidate,
    pub outcome: CandidateOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RekeyProbeReport {
    pub total_files: usize,
    /// Files the drive's current key opens — nothing to recover there.
    pub readable_now: usize,
    /// Files with no encrypted path on the server, so no key can be tested
    /// against them. Reported rather than folded into `unexplained`.
    pub unclassifiable: usize,
    /// Files neither the current key nor any available candidate opens.
    pub unexplained: usize,
    pub candidates: Vec<CandidateResult>,
}

/// The counts behind a report, before candidate outcomes are attached.
#[derive(Debug, Default, PartialEq, Eq)]
struct Tally {
    total_files: usize,
    readable_now: usize,
    unclassifiable: usize,
    unexplained: usize,
    /// One count per entry of `keys`, in the same order.
    rescues: Vec<usize>,
}

/// Count, per key, the files it opens that the current key does not.
///
/// A file two candidates both open counts toward each: the question per
/// candidate is "would this key recover it", and two sources can hold the
/// same key (a `.bak` of a raw-master seal IS the local master).
fn tally(encrypted_paths: &[Vec<u8>], current: &[u8; 32], keys: &[[u8; 32]]) -> Tally {
    let opens = |ciphertext: &[u8], key: &[u8; 32]| hcfs_client::crypto::decrypt_small(ciphertext, key).is_ok();
    let mut tally = Tally {
        total_files: encrypted_paths.len(),
        rescues: vec![0; keys.len()],
        ..Tally::default()
    };

    for path in encrypted_paths {
        if path.is_empty() {
            tally.unclassifiable += 1;
            continue;
        }
        if opens(path, current) {
            tally.readable_now += 1;
            continue;
        }

        let mut rescued = false;
        for (count, key) in tally.rescues.iter_mut().zip(keys) {
            if opens(path, key) {
                *count += 1;
                rescued = true;
            }
        }
        if !rescued {
            tally.unexplained += 1;
        }
    }

    tally
}

/// Where the candidate keys are read from.
struct KeySources<'a> {
    folder_dir: &'a Path,
    master_path: &'a Path,
    password: &'a str,
    label: &'a str,
    supplied: Option<&'a str>,
}

/// `<path>.bak`, the name hcfs's `save_encrypted_mnemonic` gives the blob an
/// overwrite replaced.
fn backup_of(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".bak");
    path.with_file_name(name)
}

/// Open a sealed phrase, mapping the two expected misses to plain reasons.
fn open_seal(path: &Path, password: &str, missing: &str) -> std::result::Result<Zeroizing<String>, String> {
    if !path.exists() {
        return Err(missing.to_owned());
    }
    hcfs_client::auth::recover_mnemonic(path, password)
        .map(|m| Zeroizing::new(m.to_string()))
        .map_err(|_| "Present, but it does not open with the current drive password.".to_owned())
}

/// A folder key from a MASTER phrase: derive for the label, then take the key.
fn key_from_master(master: &str, label: &str) -> std::result::Result<[u8; 32], String> {
    let folder = Zeroizing::new(derive_folder_mnemonic(master, label).map_err(|_| "Not a valid recovery phrase.".to_owned())?);
    encryption_key_from_phrase(&folder).map_err(|e| e.to_string())
}

/// Build every candidate key the sources allow. Argon2 runs per sealed file,
/// so the caller runs this off the async runtime.
fn build_candidate_keys(src: &KeySources<'_>) -> Vec<(KeyCandidate, std::result::Result<[u8; 32], String>)> {
    let mut out = Vec::with_capacity(4);

    let master = open_seal(src.master_path, src.password, "No account master on this device.");
    out.push((
        KeyCandidate::LocalMasterAsFolderKey,
        master.and_then(|m| encryption_key_from_phrase(&m).map_err(|e| e.to_string())),
    ));

    let previous_seal = open_seal(
        &backup_of(&src.folder_dir.join("enc_mnemonic.json")),
        src.password,
        "No previous folder seal on this device.",
    );
    out.push((
        KeyCandidate::PreviousFolderSeal,
        previous_seal.and_then(|p| encryption_key_from_phrase(&p).map_err(|e| e.to_string())),
    ));

    let previous_master = open_seal(&backup_of(src.master_path), src.password, "No previous account master on this device.");
    out.push((KeyCandidate::PreviousMaster, previous_master.and_then(|m| key_from_master(&m, src.label))));

    if let Some(supplied) = src.supplied {
        out.push((KeyCandidate::SuppliedMaster, key_from_master(supplied, src.label)));
    }

    out
}

/// Attach each candidate's outcome to the tally of the keys that were built.
fn assemble(tally: Tally, built: &[(KeyCandidate, std::result::Result<[u8; 32], String>)]) -> RekeyProbeReport {
    let mut rescues = tally.rescues.into_iter();
    let candidates = built
        .iter()
        .map(|(candidate, key)| CandidateResult {
            candidate: *candidate,
            outcome: match key {
                Ok(_) => CandidateOutcome::Tried {
                    rescues: rescues.next().unwrap_or(0),
                },
                Err(reason) => CandidateOutcome::Unavailable { reason: reason.clone() },
            },
        })
        .collect();

    RekeyProbeReport {
        total_files: tally.total_files,
        readable_now: tally.readable_now,
        unclassifiable: tally.unclassifiable,
        unexplained: tally.unexplained,
        candidates,
    }
}

/// Probe a drive's remote files against every key its previous folder key
/// might be found under. Read-only: lists metadata once, downloads nothing.
///
/// `supplied_phrase` is an optional recovery phrase to test as a master (for
/// example, one the user opened from the server blob). It is never logged
/// or stored.
#[tauri::command]
pub async fn probe_rekey_recovery(
    state: tauri::State<'_, AppState>,
    account_id: String,
    label: String,
    supplied_phrase: Option<String>,
) -> Result<RekeyProbeReport> {
    let supplied = supplied_phrase.map(Zeroizing::new);
    let account_id = state.require_session_account(&account_id)?;
    probe_rekey_recovery_inner(state.inner(), &account_id, &label, supplied).await
}

async fn probe_rekey_recovery_inner(
    state: &AppState,
    account_id: &str,
    label: &str,
    supplied: Option<Zeroizing<String>>,
) -> Result<RekeyProbeReport> {
    let pool = state.pool()?;
    let mnemonic = session_mnemonic(state)?;

    // Strict resolve: a probe needs this device's config dir, so a label with
    // no local row has nothing to probe.
    let identity = crate::sync::identity::resolve_drive_identity(pool, account_id, label).await?;
    if identity.is_member {
        // A member drive's key is the OWNER's; `ensure_derived_mnemonic` never
        // runs on it, so it cannot have been re-keyed by this device.
        return Err(AppError::Validation(
            "Shared drives you have joined are never re-keyed on this device, so there is nothing to probe.".into(),
        ));
    }

    let mut current = encryption_key_for_label(state, account_id, label, &mnemonic, &identity).await?;
    let password = crate::sync::config::get_drive_password(pool, account_id, Some(&mnemonic)).await?;
    let folder_dir = config_dir_for_folder(account_id, label)?;
    let master_path = master_mnemonic_path(account_id)?;

    let client = build_client(pool, account_id, &identity).await?;
    let entries = client
        .get_all_files(&identity.wire_ss58, &identity.wire_folder_hash, None::<fn(u64, u64)>)
        .await
        .map_err(|e| AppError::Hcfs(format!("Failed to list remote files: {e}")))?;
    let encrypted_paths: Vec<Vec<u8>> = entries.into_iter().map(|e| e.encrypted_path).collect();

    let label_owned = label.to_owned();
    let report = tokio::task::spawn_blocking(move || {
        let sources = KeySources {
            folder_dir: &folder_dir,
            master_path: &master_path,
            password: &password,
            label: &label_owned,
            supplied: supplied.as_deref().map(String::as_str),
        };
        let mut built = build_candidate_keys(&sources);
        let mut keys: Vec<[u8; 32]> = built.iter().filter_map(|(_, k)| k.as_ref().ok().copied()).collect();

        let report = assemble(tally(&encrypted_paths, &current, &keys), &built);

        current.zeroize();
        keys.zeroize();
        for (_, key) in &mut built {
            if let Ok(key) = key {
                key.zeroize();
            }
        }
        report
    })
    .await
    .map_err(|e| AppError::Other(format!("rekey probe task failed: {e}")))?;

    // Counts only: no phrase, key, or file path ever reaches the log.
    info!(
        label = %label,
        total = report.total_files,
        readable_now = report.readable_now,
        unexplained = report.unexplained,
        unclassifiable = report.unclassifiable,
        candidates = ?report.candidates,
        "Rekey recovery probe"
    );
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MASTER: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const OTHER_MASTER: &str = "legal winner thank year wave sausage worth useful legal winner thank yellow";

    fn seal(key: &[u8; 32], path: &str) -> Vec<u8> {
        hcfs_client::crypto::encrypt_small(path.as_bytes(), key).expect("encrypt path")
    }

    fn key_of_phrase(phrase: &str) -> [u8; 32] {
        encryption_key_from_phrase(phrase).expect("key")
    }

    #[test]
    fn tally_splits_files_by_which_key_opens_them() {
        let current = key_of_phrase(&derive_folder_mnemonic(MASTER, "docs").expect("derive"));
        let old = key_of_phrase(MASTER);
        let stranger = [7u8; 32];
        let paths = vec![
            seal(&current, "a.txt"),
            seal(&current, "b.txt"),
            seal(&old, "c.txt"),
            seal(&old, "d.txt"),
            seal(&old, "e.txt"),
            seal(&stranger, "f.txt"),
            Vec::new(),
        ];

        let tally = tally(&paths, &current, &[old]);

        assert_eq!(
            tally,
            Tally {
                total_files: 7,
                readable_now: 2,
                unclassifiable: 1,
                unexplained: 1,
                rescues: vec![3],
            }
        );
    }

    /// A file the current key opens is never a rescue, even when a candidate
    /// opens it too — otherwise a candidate identical to the current key would
    /// claim to recover the whole drive.
    #[test]
    fn a_candidate_equal_to_the_current_key_rescues_nothing() {
        let current = [1u8; 32];
        let paths = vec![seal(&current, "a"), seal(&current, "b")];

        let tally = tally(&paths, &current, &[current]);

        assert_eq!(tally.rescues, vec![0]);
        assert_eq!(tally.readable_now, 2);
    }

    #[test]
    fn a_file_two_candidates_open_counts_toward_both() {
        let current = [1u8; 32];
        let old = [2u8; 32];
        let paths = vec![seal(&old, "a")];

        let tally = tally(&paths, &current, &[old, old]);

        assert_eq!(tally.rescues, vec![1, 1]);
        assert_eq!(tally.unexplained, 0);
    }

    /// The whole scenario offline, on real hcfs sealing: a drive whose seal
    /// held the raw master is re-keyed by `ensure_derived_mnemonic`. Its old
    /// files must be recoverable from BOTH the local master and the `.bak` the
    /// overwrite left — which also pins that hcfs still writes that `.bak`.
    #[test]
    fn a_raw_master_rekey_is_recoverable_from_the_master_and_the_backup() {
        let tmp = tempfile::TempDir::new().expect("tempdir");
        let folder_dir = tmp.path().join("folder");
        std::fs::create_dir_all(&folder_dir).expect("folder dir");
        let master_path = tmp.path().join("master_enc_mnemonic.json");
        hcfs_client::auth::save_encrypted_mnemonic(&master_path, MASTER, "pw").expect("seal master");
        hcfs_client::auth::save_encrypted_mnemonic(folder_dir.join("enc_mnemonic.json"), MASTER, "pw").expect("seal raw master");

        crate::sync::mnemonic::ensure_derived_mnemonic(&folder_dir, &master_path, "pw", "docs").expect("re-key");

        let old = key_of_phrase(MASTER);
        let current = key_of_phrase(&derive_folder_mnemonic(MASTER, "docs").expect("derive"));
        let paths = vec![seal(&old, "stranded-1"), seal(&old, "stranded-2"), seal(&current, "fine")];
        let built = build_candidate_keys(&KeySources {
            folder_dir: &folder_dir,
            master_path: &master_path,
            password: "pw",
            label: "docs",
            supplied: None,
        });
        let keys: Vec<[u8; 32]> = built.iter().filter_map(|(_, k)| k.as_ref().ok().copied()).collect();

        let report = assemble(tally(&paths, &current, &keys), &built);

        assert_eq!(report.readable_now, 1);
        assert_eq!(report.unexplained, 0);
        let outcome_of = |c| report.candidates.iter().find(|r| r.candidate == c).map(|r| r.outcome.clone());
        assert_eq!(
            outcome_of(KeyCandidate::LocalMasterAsFolderKey),
            Some(CandidateOutcome::Tried { rescues: 2 })
        );
        assert_eq!(
            outcome_of(KeyCandidate::PreviousFolderSeal),
            Some(CandidateOutcome::Tried { rescues: 2 }),
            "the re-key's own overwrite must leave the previous seal as a usable .bak"
        );
        let Some(CandidateOutcome::Unavailable { .. }) = outcome_of(KeyCandidate::PreviousMaster) else {
            panic!("no master was ever overwritten, so there is no previous master to try");
        };
    }

    /// `DerivedFromAnotherMaster`: only the other master recovers the files,
    /// and a supplied phrase is how it gets in.
    #[test]
    fn a_supplied_master_recovers_files_derived_from_it() {
        let tmp = tempfile::TempDir::new().expect("tempdir");
        let master_path = tmp.path().join("master_enc_mnemonic.json");
        hcfs_client::auth::save_encrypted_mnemonic(&master_path, MASTER, "pw").expect("seal master");

        let old = key_of_phrase(&derive_folder_mnemonic(OTHER_MASTER, "docs").expect("derive other"));
        let current = key_of_phrase(&derive_folder_mnemonic(MASTER, "docs").expect("derive"));
        let built = build_candidate_keys(&KeySources {
            folder_dir: tmp.path(),
            master_path: &master_path,
            password: "pw",
            label: "docs",
            supplied: Some(OTHER_MASTER),
        });
        let keys: Vec<[u8; 32]> = built.iter().filter_map(|(_, k)| k.as_ref().ok().copied()).collect();

        let report = assemble(tally(&[seal(&old, "x")], &current, &keys), &built);

        let supplied = report
            .candidates
            .iter()
            .find(|r| r.candidate == KeyCandidate::SuppliedMaster)
            .expect("supplied tried");
        assert_eq!(supplied.outcome, CandidateOutcome::Tried { rescues: 1 });
    }

    /// A bad phrase is a candidate outcome, not a failed probe — and the
    /// reason never echoes what was typed.
    #[test]
    fn an_invalid_supplied_phrase_is_unavailable_without_echoing_it() {
        let tmp = tempfile::TempDir::new().expect("tempdir");
        let built = build_candidate_keys(&KeySources {
            folder_dir: tmp.path(),
            master_path: &tmp.path().join("missing.json"),
            password: "pw",
            label: "docs",
            supplied: Some("not a real phrase secretword"),
        });

        let (_, supplied) = built.iter().find(|(c, _)| *c == KeyCandidate::SuppliedMaster).expect("supplied present");
        let reason = supplied.as_ref().expect_err("invalid phrase is unavailable");
        assert!(!reason.contains("secretword"), "the reason must not echo the phrase: {reason}");
    }

    /// A seal that no longer opens with the drive password (it predates a
    /// password change) is reported as such, not as absent.
    #[test]
    fn a_backup_under_an_old_password_is_reported_as_unopenable() {
        let tmp = tempfile::TempDir::new().expect("tempdir");
        let seal_path = tmp.path().join("enc_mnemonic.json");
        hcfs_client::auth::save_encrypted_mnemonic(&seal_path, MASTER, "old-pw").expect("first seal");
        hcfs_client::auth::save_encrypted_mnemonic(&seal_path, MASTER, "old-pw").expect("overwrite leaves .bak");

        let result = open_seal(&backup_of(&seal_path), "new-pw", "absent");

        let reason = result.expect_err("wrong password must not open");
        assert_ne!(reason, "absent", "a present-but-unopenable seal must not read as missing");
    }

    #[test]
    fn report_serializes_in_camel_case_with_tagged_outcomes() {
        let report = RekeyProbeReport {
            total_files: 1,
            readable_now: 0,
            unclassifiable: 0,
            unexplained: 0,
            candidates: vec![CandidateResult {
                candidate: KeyCandidate::PreviousFolderSeal,
                outcome: CandidateOutcome::Tried { rescues: 1 },
            }],
        };

        let json = serde_json::to_value(&report).expect("serialize");

        assert_eq!(
            json,
            serde_json::json!({
                "totalFiles": 1,
                "readableNow": 0,
                "unclassifiable": 0,
                "unexplained": 0,
                "candidates": [{ "candidate": "previousFolderSeal", "outcome": { "kind": "tried", "rescues": 1 } }]
            })
        );
    }

    /// The contract that makes this safe to run on an affected user's machine:
    /// it lists metadata and changes nothing, locally or on the server.
    #[test]
    fn the_probe_is_read_only() {
        let source = include_str!("rekey_probe.rs");
        // Code lines only: the docs above legitimately say what it never does.
        let production: String = source
            .split("#[cfg(test)]")
            .next()
            .expect("production half")
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        for forbidden in [
            "fs::write",
            "remove_file",
            "remove_dir",
            "rename(",
            "save_encrypted_mnemonic",
            "download",
            "upload",
            "unregister",
            "delete",
        ] {
            assert!(
                !production.contains(forbidden),
                "the rekey probe must stay read-only, found `{forbidden}`"
            );
        }
    }
}
