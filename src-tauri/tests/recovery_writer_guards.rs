//! Static wiring pins for the two guards that protect local key material
//! now that the sealed mnemonic blob has a SECOND writer.
//!
//! Until Hippius Console learned to create and replace `/v1/mnemonic-blob`,
//! desktop was the only writer, so a blob that opened with the user's
//! password was implicitly the one this device's folder seals derived from,
//! and "no blob at boot" stayed true until desktop itself uploaded one.
//! Neither holds any more:
//!
//! - `recover_mnemonic` (the Unlock path) must run
//!   `validate_master_against_existing_folders` BEFORE
//!   `install_recovered_mnemonic`. Installing first would let
//!   `align_drive_password` re-derive every own-folder seal under a foreign
//!   master and destroy the only local copies of the real folder keys.
//! - `seal_and_upload_mnemonic` must re-probe the server immediately BEFORE
//!   its `post_json_discard` upsert. The boot-time routing can be minutes
//!   old; a console-created blob in the meantime would be overwritten with
//!   this device's master.
//!
//! The decisions themselves are unit-tested next to the code
//! (`recovery.rs::decide_seal_upload_*`, `guard_wording_*`,
//! `validate_master_*`). What a unit test cannot pin is the ORDER of the
//! calls inside the commands, which is the whole protection. Same pattern
//! as `auth_wiring_pins.rs`; these break loudly if the functions move.

use std::fs;

fn source(path: &str) -> String {
    fs::read_to_string(path).unwrap_or_else(|e| panic!("cannot read {path}: {e}"))
}

/// Slice `src` from the first occurrence of `start` to the next
/// occurrence of `end` (or EOF), panicking if `start` is absent so a
/// rename fails loudly instead of vacuously passing.
fn slice_between<'a>(src: &'a str, start: &str, end: &str) -> &'a str {
    let begin = src
        .find(start)
        .unwrap_or_else(|| panic!("marker {start:?} not found — update recovery_writer_guards.rs if the function moved"));
    let tail = &src[begin..];
    match tail.find(end) {
        Some(stop) => &tail[..stop],
        None => tail,
    }
}

/// Position of `needle` inside `body`, panicking with `what` when absent.
fn position(body: &str, needle: &str, what: &str) -> usize {
    body.find(needle)
        .unwrap_or_else(|| panic!("{what}: {needle:?} not found in the function body"))
}

#[test]
fn unlock_path_validates_the_recovered_master_before_installing_it() {
    let src = source("src/recovery.rs");
    let body = slice_between(&src, "pub async fn recover_mnemonic(", "fn spawn_post_unlock_sync_init(");

    let guard = position(
        body,
        "validate_master_against_existing_folders(",
        "recover_mnemonic must run the folder-derivation guard — a console-written blob may hold a different master",
    );
    let install = position(
        body,
        "install_recovered_mnemonic(",
        "recover_mnemonic must still install the recovered mnemonic",
    );
    let align = position(body, "align_drive_password(", "recover_mnemonic must still align the drive password");

    assert!(
        guard < install,
        "the guard must run BEFORE install_recovered_mnemonic — after it the foreign master is already on disk"
    );
    assert!(
        guard < align,
        "the guard must run BEFORE align_drive_password re-derives every folder seal"
    );
    assert!(
        body.contains("GuardFlow::Unlock"),
        "the unlock path must ask for the unlock wording — the seal wording tells the user to unlock, which they just did"
    );
}

#[test]
fn seal_and_upload_probes_for_an_existing_blob_immediately_before_the_post() {
    let src = source("src/recovery.rs");
    let body = slice_between(&src, "pub async fn seal_and_upload_mnemonic(", "pub struct RecoveryRotationResult");

    let probe = position(
        body,
        "probe_blob_metadata(",
        "seal_and_upload_mnemonic must re-probe the server for an existing blob",
    );
    let decide = position(
        body,
        "decide_seal_upload(",
        "seal_and_upload_mnemonic must gate the POST on the probe outcome",
    );
    let post = position(body, "post_json_discard(", "seal_and_upload_mnemonic must still POST the blob");
    let kdf = position(body, "seal_mnemonic(", "seal_and_upload_mnemonic must still seal the mnemonic");

    assert!(
        probe < post && decide < post,
        "the probe and its decision must both run BEFORE the upsert"
    );
    assert!(
        kdf < probe,
        "the probe belongs AFTER the KDF so the check-then-write window is as narrow as possible"
    );

    let between = &body[decide..post];
    assert!(
        !between.contains("install_recovered_mnemonic(") && !between.contains("align_drive_password("),
        "nothing local may be written between the probe decision and the POST"
    );
}
