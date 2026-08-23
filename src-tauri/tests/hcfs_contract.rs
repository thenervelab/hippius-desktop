//! Golden-vector (known-answer) regression tests pinning the deterministic
//! output of the hcfs-client identity/crypto functions the desktop depends on.
//!
//! The IPC wire-contract guards (sync/events.rs, sync/tauri_bridge.rs) pin the
//! JSON *shape* an hcfs bump must not change. These pin the *values* three
//! pure functions must keep producing:
//!
//! - `folder_hash(label)` — the server namespace + on-disk subdir for a drive.
//! - `derive_folder_mnemonic(master, label)` — the per-folder BIP-39 identity.
//! - `derive_encryption_key(master, label)` — the per-folder content key.
//!
//! All three are deterministic over (master, label). If an hcfs bump changed
//! any of these algorithms, every existing user's data would silently become
//! undecryptable / their server identity would move — the data-loss class that
//! a wire-shape test cannot catch. A known-answer test catches it: the expected
//! values below were captured from the current pinned rev, so a drift fails here
//! BEFORE the bump ships. If you change an algorithm ON PURPOSE, regenerate the
//! goldens deliberately and document the migration.

use base64::Engine;
use hcfs_client::client::folder_share::{
    CreatedFolderShare, FolderShareListItem, FolderShareOptions, ShareTtl, build_folder_share_url, build_folder_share_url_for,
    build_folder_share_url_private, folder_share_token_hash,
};
use hcfs_client::client::share::{ShareSecret, wrap_share_key};
use hcfs_client::crypto::{decrypt_small, encrypt_small};
use hcfs_client::drive::keys::{derive_folder_mnemonic, folder_hash};
use hcfs_client::drive::remote::derive_encryption_key;
use hcfs_client::mnemonic_blob::{MnemonicBlobError, open_mnemonic, seal_mnemonic};
use hcfs_shared::network::{
    AcceptDriveInviteRequest, AcceptDriveInviteResponse, CreateDriveInviteRequest, CreateDriveInviteResponse, DriveInviteMetaResponse,
    DriveMemberEntry, DriveMembersResponse, DriveMembershipEntry, DriveMembershipsResponse, ListFolderEntriesResult, RegisterFolderEntriesRequest,
    UnregisterFolderEntriesRequest,
};
use proptest::prelude::*;
use std::collections::BTreeSet;

/// Canonical public BIP-39 zero-vector ("entropy = all zeros"). A well-known
/// test mnemonic — NEVER a real wallet — safe to commit as a fixture.
const TEST_MNEMONIC: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

#[test]
fn folder_hash_is_pinned() {
    // Real labels plus two external-boundary edges (empty + unicode): the
    // function hashes `label.as_bytes()`, so these probe its documented domain.
    assert_eq!(folder_hash("default"), "37a8eec1ce19687d", "folder_hash(\"default\") drifted");
    assert_eq!(folder_hash("alpha"), "8ed3f6ad685b959e", "folder_hash(\"alpha\") drifted");
    assert_eq!(folder_hash(""), "e3b0c44298fc1c14", "folder_hash(\"\") drifted");
    assert_eq!(folder_hash("Über/Δrive"), "4f768ad9fa301d1c", "folder_hash(unicode) drifted");

    // Per-folder uniqueness is the security property the namespace relies on.
    assert_ne!(folder_hash("alpha"), folder_hash("beta"), "distinct labels must hash distinctly");
}

#[test]
fn derive_folder_mnemonic_is_pinned() {
    let alpha = derive_folder_mnemonic(TEST_MNEMONIC, "alpha").expect("derive folder mnemonic");
    assert_eq!(
        alpha,
        "charge random negative trouble surprise sample suffer company unusual sound code rhythm prize much reveal link local morning clarify one cigar spare paddle hat",
        "derive_folder_mnemonic(master, \"alpha\") drifted"
    );

    // Deterministic: same (master, label) → same mnemonic (re-encryption relies on this).
    assert_eq!(
        derive_folder_mnemonic(TEST_MNEMONIC, "alpha").expect("re-derive"),
        alpha,
        "derive_folder_mnemonic must be deterministic"
    );
    // Per-folder distinct identity.
    assert_ne!(
        derive_folder_mnemonic(TEST_MNEMONIC, "beta").expect("beta"),
        alpha,
        "distinct labels must derive distinct folder mnemonics"
    );
}

#[test]
fn derive_encryption_key_is_pinned() {
    let alpha = derive_encryption_key(TEST_MNEMONIC, "alpha").expect("derive encryption key");
    assert_eq!(
        hex::encode(alpha),
        "b8a5eaafb059a3ed9860023f33622205851004ea2ee3750bb2b5c06653b45eec",
        "derive_encryption_key(master, \"alpha\") drifted"
    );

    // Deterministic over (master, label).
    assert_eq!(
        derive_encryption_key(TEST_MNEMONIC, "alpha").expect("re-derive"),
        alpha,
        "derive_encryption_key must be deterministic"
    );
    // Per-folder distinct key — the isolation property at-rest encryption needs.
    assert_ne!(
        derive_encryption_key(TEST_MNEMONIC, "beta").expect("beta"),
        alpha,
        "distinct labels must derive distinct content keys"
    );
}

/// Composition pin: `derive_encryption_key(master, label)` IS the first 32
/// bytes of `to_seed("")` of `derive_folder_mnemonic(master, label)`. The
/// member remote-preview/download path relies on exactly this equality — it
/// holds only the sealed folder MNEMONIC (from the grant blob) and re-derives
/// the content key from its seed tail, so if an hcfs bump ever decoupled the
/// two derivations, member downloads would silently decrypt with the wrong
/// key. The per-function KATs above cannot see that relationship.
#[test]
fn derive_encryption_key_is_the_folder_mnemonic_seed_tail() {
    let phrase = derive_folder_mnemonic(TEST_MNEMONIC, "alpha").expect("derive folder mnemonic");
    let parsed: bip39::Mnemonic = phrase.parse().expect("folder mnemonic parses");
    let seed = parsed.to_seed("");

    let key = derive_encryption_key(TEST_MNEMONIC, "alpha").expect("derive encryption key");
    assert_eq!(
        &seed[..32],
        key.as_slice(),
        "derive_encryption_key must equal the folder mnemonic's seed tail (member key path)"
    );
}

proptest! {
    /// Format invariant across the whole label input space: `folder_hash` is
    /// always 16 lowercase-hex chars and deterministic. Hand-picked KATs above
    /// pin specific values; this pins the shape for inputs the author didn't list.
    #[test]
    fn folder_hash_format_invariant(label in ".*") {
        let h = folder_hash(&label);
        prop_assert_eq!(h.len(), 16, "folder_hash must be 16 chars");
        prop_assert!(h.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()), "must be lowercase hex: {}", h);
        prop_assert_eq!(folder_hash(&label), h, "folder_hash must be deterministic");
    }

    /// `derive_encryption_key` determinism across the realistic label space (the
    /// golden above pins only "alpha"). The security property at-rest encryption
    /// relies on is per-`(master, label)` stability — a non-deterministic key
    /// would make a file written one launch undecryptable the next.
    #[test]
    fn derive_encryption_key_is_deterministic(label in "[A-Za-z0-9 _/.-]{0,64}") {
        let a = derive_encryption_key(TEST_MNEMONIC, &label).expect("derive");
        let b = derive_encryption_key(TEST_MNEMONIC, &label).expect("re-derive");
        prop_assert_eq!(a, b);
    }

    /// At-rest round-trip over arbitrary plaintext: `decrypt(encrypt(x)) == x`.
    /// The shrinker probes lengths and byte patterns the fixed fixtures below
    /// miss — an off-by-one in chunk framing surfaces here. Bounded under the
    /// 256 KiB chunk size so each case is a single chunk (fast).
    #[test]
    fn at_rest_round_trips_any_plaintext(plaintext in proptest::collection::vec(any::<u8>(), 0..4096)) {
        let key = enc_key_alpha();
        let ciphertext = encrypt_small(&plaintext, &key).expect("encrypt");
        let decrypted = decrypt_small(&ciphertext, &key).expect("decrypt");
        prop_assert_eq!(decrypted, plaintext);
    }
}

// ── At-rest AEAD decrypt known-answer tests ────────────────────────────────
//
// The golden vectors above pin the deterministic KEY-DERIVATION functions. These
// pin the at-rest ENCRYPTION FORMAT itself — the XChaCha20-Poly1305 streaming
// layout (`[nonce:24][chunk_count:u32][len:u32][ciphertext][tag:16]`) the
// desktop's `download_remote_file` uses to decrypt every user file. A wire-shape
// test cannot see a format change here; this is the data-loss guard.

/// The per-folder content key for label `"alpha"` under the canonical test
/// mnemonic — the exact value pinned by `derive_encryption_key_is_pinned`.
/// Hardcoded (not re-derived) so this KAT isolates the at-rest AEAD format from
/// the key-derivation algorithm, which has its own golden above.
const ENC_KEY_ALPHA_HEX: &str = "b8a5eaafb059a3ed9860023f33622205851004ea2ee3750bb2b5c06653b45eec";

/// Fixed plaintext for the at-rest decrypt KATs.
const KAT_PLAINTEXT: &[u8] = b"hippius hcfs at-rest decrypt KAT v1";

/// One ciphertext of `KAT_PLAINTEXT` under `ENC_KEY_ALPHA`, captured at the pinned
/// hcfs rev `829ceb67`. The XChaCha20-Poly1305 nonce is random per encrypt, so
/// this is a single frozen instance — but `decrypt_small` of it is deterministic.
/// If an hcfs bump changes the streaming at-rest format (header layout, chunk
/// framing, nonce derivation, AEAD construction), every already-uploaded user file
/// becomes undecryptable and THIS test fails before the bump ships. Regenerate
/// deliberately — and ship a migration — only when changing the format on purpose.
const FROZEN_CIPHERTEXT_HEX: &str = "b76413f1c1633749ed02dfaee004b11d44a8126ee12f0ed10100000033000000cfd276eb49236f6c3a83df13c42a769f2c478a0415ae380801be09e0d30c1052eb4bf1a090bba946bc2d284f7e621ee0137eb2";

fn enc_key_alpha() -> [u8; 32] {
    hex::decode(ENC_KEY_ALPHA_HEX).expect("valid hex key").try_into().expect("32-byte key")
}

#[test]
fn at_rest_decrypt_frozen_ciphertext_is_pinned() {
    let key = enc_key_alpha();
    let ciphertext = hex::decode(FROZEN_CIPHERTEXT_HEX).expect("valid frozen ciphertext hex");
    let plaintext = decrypt_small(&ciphertext, &key).expect("a file encrypted at the pinned rev must still decrypt");
    assert_eq!(
        plaintext, KAT_PLAINTEXT,
        "at-rest format drifted: a file encrypted at the pinned hcfs rev no longer decrypts to its plaintext"
    );
}

// ── Folder-entry wire-contract pins ────────────────────────────────────────
//
// The first-class-empty-folders feature added three foreign `hcfs_shared::network`
// types the desktop serializes onto / deserializes off the hcfs-server folder-entry
// endpoints (backfill + per-cycle directory reconcile). The FE is decoupled from
// Rust types (no codegen), but these cross the desktop↔hcfs DEPENDENCY boundary:
// the desktop's `hcfs-client` register/unregister calls send/receive exactly this
// JSON. A future `hcfs-shared` rev that reshapes them (a stray `rename_all`, a
// renamed field, a dropped `#[serde(alias = "user_id")]`) would silently break
// those calls at runtime. These pins fail desktop CI on the bump instead.
//
// The hcfs-shared crate has its own copies of these tests, but they live in its
// `#[cfg(test)]` module and never compile into the desktop — only a pin in THIS
// crate guards the desktop's use of the bumped dep.

/// The share modal reads these keys directly to render the size line and to
/// disable its Create button. A serde rename would blank both silently — the
/// modal would show no size and never refuse an oversized folder, leaving the
/// mint as the only thing that says no.
#[test]
fn folder_share_preflight_wire_pinned() {
    let preflight = tauri_project_lib::shares::commands::FolderSharePreflight {
        total_bytes: 12,
        file_count: 3,
        within_limits: true,
        limit_bytes: 2_000_000_000,
        limit_files: 10_000,
    };

    let json = serde_json::to_value(&preflight).expect("serialize");
    let keys: BTreeSet<&str> = json.as_object().expect("object").keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        ["fileCount", "limitBytes", "limitFiles", "totalBytes", "withinLimits"]
            .into_iter()
            .collect::<BTreeSet<_>>(),
        "FolderSharePreflight wire keys must stay exactly these camelCase names"
    );
}

#[test]
fn register_folder_entries_request_wire_pinned() {
    let req = RegisterFolderEntriesRequest {
        ss58_address: "5GTestAddress".to_string(),
        folder_hash: "abc123".to_string(),
        relative_paths: vec!["Work".to_string(), "Work/Reports".to_string()],
    };

    let json = serde_json::to_value(&req).expect("serialize");
    let keys: BTreeSet<&str> = json.as_object().expect("object").keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        ["folder_hash", "relative_paths", "ss58_address"].into_iter().collect::<BTreeSet<_>>(),
        "RegisterFolderEntriesRequest wire keys must stay exactly these snake_case names"
    );

    // Round-trip: serialize → deserialize → field equality.
    let decoded: RegisterFolderEntriesRequest = serde_json::from_value(json).expect("deserialize");
    assert_eq!(decoded.ss58_address, "5GTestAddress");
    assert_eq!(decoded.folder_hash, "abc123");
    assert_eq!(decoded.relative_paths, vec!["Work", "Work/Reports"]);

    // The desktop relies on the legacy `user_id` key still deserializing into
    // `ss58_address`; a bump dropping the `#[serde(alias = "user_id")]` breaks here.
    let aliased: RegisterFolderEntriesRequest =
        serde_json::from_str(r#"{"user_id":"5GLegacy","folder_hash":"h","relative_paths":[]}"#).expect("user_id alias deserializes");
    assert_eq!(aliased.ss58_address, "5GLegacy", "user_id alias must map onto ss58_address");
}

#[test]
fn unregister_folder_entries_request_wire_pinned() {
    let req = UnregisterFolderEntriesRequest {
        ss58_address: "5GTestAddress".to_string(),
        folder_hash: "abc123".to_string(),
        relative_paths: vec!["Work/Reports".to_string()],
    };

    let json = serde_json::to_value(&req).expect("serialize");
    let keys: BTreeSet<&str> = json.as_object().expect("object").keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        ["folder_hash", "relative_paths", "ss58_address"].into_iter().collect::<BTreeSet<_>>(),
        "UnregisterFolderEntriesRequest wire keys must stay exactly these snake_case names"
    );

    let decoded: UnregisterFolderEntriesRequest = serde_json::from_value(json).expect("deserialize");
    assert_eq!(decoded.ss58_address, "5GTestAddress");
    assert_eq!(decoded.folder_hash, "abc123");
    assert_eq!(decoded.relative_paths, vec!["Work/Reports"]);

    let aliased: UnregisterFolderEntriesRequest =
        serde_json::from_str(r#"{"user_id":"5GLegacy","folder_hash":"h","relative_paths":[]}"#).expect("user_id alias deserializes");
    assert_eq!(aliased.ss58_address, "5GLegacy", "user_id alias must map onto ss58_address");
}

#[test]
fn list_folder_entries_result_wire_pinned() {
    let resp = ListFolderEntriesResult {
        relative_paths: vec!["Work".to_string(), "Work/Reports".to_string()],
    };

    let json = serde_json::to_value(&resp).expect("serialize");
    let keys: BTreeSet<&str> = json.as_object().expect("object").keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        ["relative_paths"].into_iter().collect::<BTreeSet<_>>(),
        "ListFolderEntriesResult must carry exactly the relative_paths key"
    );

    let decoded: ListFolderEntriesResult = serde_json::from_value(json).expect("deserialize");
    assert_eq!(decoded.relative_paths, vec!["Work", "Work/Reports"]);
}

// ── Shared-drive wire-contract pins (hcfs #348, phase 2 desktop) ───────────
//
// The invite/membership DTOs the desktop serializes onto / deserializes off
// the `/v1/drive-invites` + `/v1/drive-memberships` + `/v1/drives/{fh}/members`
// endpoints (Tasks 4-6). Same rationale as the folder-entry pins above: these
// cross the desktop↔hcfs DEPENDENCY boundary, so a reshaping bump must fail
// desktop CI here rather than at runtime.

#[test]
fn create_drive_invite_request_wire_pinned() {
    let req = CreateDriveInviteRequest {
        folder_hash: "0123456789abcdef".to_string(),
        expires_in_secs: Some(3600),
        max_uses: Some(5),
    };

    let json = serde_json::to_value(&req).expect("serialize");
    let keys: BTreeSet<&str> = json.as_object().expect("object").keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        ["expires_in_secs", "folder_hash", "max_uses"].into_iter().collect::<BTreeSet<_>>(),
        "CreateDriveInviteRequest wire keys must stay exactly these snake_case names"
    );

    let decoded: CreateDriveInviteRequest = serde_json::from_value(json).expect("deserialize");
    assert_eq!(decoded.folder_hash, "0123456789abcdef");
    assert_eq!(decoded.expires_in_secs, Some(3600));
    assert_eq!(decoded.max_uses, Some(5));

    // Both limits are `#[serde(default)]`: a body carrying only folder_hash
    // must deserialize with the server-default sentinels (None).
    let minimal: CreateDriveInviteRequest = serde_json::from_str(r#"{"folder_hash":"h"}"#).expect("minimal body deserializes");
    assert_eq!(minimal.expires_in_secs, None);
    assert_eq!(minimal.max_uses, None);
}

#[test]
fn create_drive_invite_response_wire_pinned() {
    let resp: CreateDriveInviteResponse = serde_json::from_str(r#"{"invite_token":"tok_abc"}"#).expect("deserialize");
    assert_eq!(resp.invite_token, "tok_abc");

    let json = serde_json::to_value(&resp).expect("serialize");
    let keys: BTreeSet<&str> = json.as_object().expect("object").keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        ["invite_token"].into_iter().collect::<BTreeSet<_>>(),
        "CreateDriveInviteResponse must carry exactly the invite_token key"
    );
}

#[test]
fn drive_invite_meta_response_wire_pinned() {
    let meta: DriveInviteMetaResponse = serde_json::from_str(
        r#"{
            "owner_ss58": "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
            "folder_hash": "0123456789abcdef",
            "display_label": "team-docs",
            "expires_at": "2026-08-27T00:00:00Z",
            "valid": true
        }"#,
    )
    .expect("deserialize");
    assert_eq!(meta.owner_ss58, "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY");
    assert_eq!(meta.folder_hash, "0123456789abcdef");
    assert_eq!(meta.display_label, "team-docs");
    assert_eq!(meta.expires_at, "2026-08-27T00:00:00Z");
    assert!(meta.valid);

    let json = serde_json::to_value(&meta).expect("serialize");
    let keys: BTreeSet<&str> = json.as_object().expect("object").keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        ["display_label", "expires_at", "folder_hash", "owner_ss58", "valid"]
            .into_iter()
            .collect::<BTreeSet<_>>(),
        "DriveInviteMetaResponse wire keys must stay exactly these snake_case names"
    );
}

#[test]
fn accept_drive_invite_request_wire_pinned() {
    let req = AcceptDriveInviteRequest {
        grant_blob: "eyJjaXBoZXJ0ZXh0IjoiLi4uIn0=".to_string(),
    };

    let json = serde_json::to_value(&req).expect("serialize");
    let keys: BTreeSet<&str> = json.as_object().expect("object").keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        ["grant_blob"].into_iter().collect::<BTreeSet<_>>(),
        "AcceptDriveInviteRequest must carry exactly the grant_blob key"
    );

    let decoded: AcceptDriveInviteRequest = serde_json::from_value(json).expect("deserialize");
    assert_eq!(decoded.grant_blob, "eyJjaXBoZXJ0ZXh0IjoiLi4uIn0=");
}

/// `already_owner` is the field that replaced the earlier `already` bool: it
/// must be ABSENT from the JSON when false (old clients never see an
/// unexpected key) and present when true (the owner-self-join no-op).
#[test]
fn accept_drive_invite_response_wire_pinned() {
    let member_accept = AcceptDriveInviteResponse {
        owner_ss58: "5Owner".to_string(),
        folder_hash: "0123456789abcdef".to_string(),
        already_owner: false,
    };
    let json = serde_json::to_value(&member_accept).expect("serialize");
    let keys: BTreeSet<&str> = json.as_object().expect("object").keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        ["folder_hash", "owner_ss58"].into_iter().collect::<BTreeSet<_>>(),
        "already_owner must be omitted from a real member accept"
    );

    let owner_self_join = AcceptDriveInviteResponse {
        already_owner: true,
        ..member_accept
    };
    let json = serde_json::to_value(&owner_self_join).expect("serialize");
    assert_eq!(
        json.get("already_owner").and_then(serde_json::Value::as_bool),
        Some(true),
        "already_owner must be present (true) on the owner self-join no-op"
    );

    // The desktop consumes this response: a body WITHOUT the key must
    // deserialize as a plain member accept (`already_owner = false`).
    let decoded: AcceptDriveInviteResponse =
        serde_json::from_str(r#"{"owner_ss58":"5Owner","folder_hash":"0123456789abcdef"}"#).expect("deserialize");
    assert_eq!(decoded.owner_ss58, "5Owner");
    assert_eq!(decoded.folder_hash, "0123456789abcdef");
    assert!(!decoded.already_owner, "a missing already_owner key must read as false");
}

/// The login-rehydration listing (`GET /v1/drive-memberships`): each entry
/// carries the sealed grant blob (padded standard base64), the owner's
/// display label, and the member's role — the exact fields Task 4's
/// membership IPC forwards to the FE.
#[test]
fn drive_memberships_response_wire_pinned() {
    let resp: DriveMembershipsResponse = serde_json::from_str(
        r#"{
            "memberships": [{
                "owner_ss58": "5Owner",
                "folder_hash": "0123456789abcdef",
                "role": "writer",
                "grant_blob": "eyJjaXBoZXJ0ZXh0IjoiLi4uIn0=",
                "display_label": "team-docs",
                "created_at": "2026-08-20T00:00:00Z"
            }]
        }"#,
    )
    .expect("deserialize");
    let entry = &resp.memberships[0];
    assert_eq!(entry.owner_ss58, "5Owner");
    assert_eq!(entry.folder_hash, "0123456789abcdef");
    assert_eq!(entry.role, "writer");
    assert_eq!(entry.grant_blob, "eyJjaXBoZXJ0ZXh0IjoiLi4uIn0=");
    assert_eq!(entry.display_label, "team-docs");
    assert_eq!(entry.created_at, "2026-08-20T00:00:00Z");

    let json = serde_json::to_value(&DriveMembershipEntry { ..entry.clone() }).expect("serialize");
    let keys: BTreeSet<&str> = json.as_object().expect("object").keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        ["created_at", "display_label", "folder_hash", "grant_blob", "owner_ss58", "role"]
            .into_iter()
            .collect::<BTreeSet<_>>(),
        "DriveMembershipEntry wire keys must stay exactly these snake_case names"
    );
}

/// The owner-side members listing (`GET /v1/drives/{fh}/members`), consumed
/// by Task 6's members surface. Deliberately blob-free: grants are sealed to
/// each member and useless to the owner.
#[test]
fn drive_members_response_wire_pinned() {
    let resp: DriveMembersResponse =
        serde_json::from_str(r#"{"members": [{"member_ss58": "5Member", "role": "writer", "created_at": "2026-08-20T00:00:00Z"}]}"#)
            .expect("deserialize");
    let entry = &resp.members[0];
    assert_eq!(entry.member_ss58, "5Member");
    assert_eq!(entry.role, "writer");
    assert_eq!(entry.created_at, "2026-08-20T00:00:00Z");

    let json = serde_json::to_value(&DriveMemberEntry { ..entry.clone() }).expect("serialize");
    let keys: BTreeSet<&str> = json.as_object().expect("object").keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        ["created_at", "member_ss58", "role"].into_iter().collect::<BTreeSet<_>>(),
        "DriveMemberEntry wire keys must stay exactly these snake_case names, and never a grant blob"
    );
}

// ── Invite-fragment contract KATs ──────────────────────────────────────────
//
// The invite link carries the owner's folder-mnemonic ENTROPY (32 bytes) as
// `#k=<base64url no-pad>`; the recipient decodes and rebuilds the phrase via
// BIP-39. Both halves are cross-client contracts (Phase 3 console must
// produce/consume the identical encoding), so pin them with known answers.

#[test]
fn invite_fragment_entropy_round_trips_through_bip39() {
    // Canonical BIP-39 zero vector: 32 zero bytes → 23x "abandon" + "art".
    // A published vector, so the console can copy it verbatim.
    let zero = [0u8; 32];
    let mnemonic = bip39::Mnemonic::from_entropy(&zero).expect("entropy to mnemonic");
    assert_eq!(
        mnemonic.to_string(),
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon \
         abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art",
        "BIP-39 zero-vector phrase drifted"
    );

    // Round-trip with a non-trivial entropy: entropy → phrase → parse →
    // identical entropy. This is the exact path the invite accept runs.
    let entropy: Vec<u8> = (0u8..32).collect();
    let mnemonic = bip39::Mnemonic::from_entropy(&entropy).expect("entropy to mnemonic");
    let parsed = mnemonic.to_string().parse::<bip39::Mnemonic>().expect("phrase parses back");
    assert_eq!(parsed.to_entropy(), entropy, "entropy must survive the phrase round-trip");
}

#[test]
fn invite_fragment_base64url_no_pad_is_pinned() {
    let engine = &base64::engine::general_purpose::URL_SAFE_NO_PAD;

    // Known answer for the incrementing 32-byte pattern; 43 chars, no '='.
    let entropy: Vec<u8> = (0u8..32).collect();
    let encoded = engine.encode(&entropy);
    assert_eq!(
        encoded, "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
        "base64url no-pad encoding of the invite entropy drifted"
    );
    assert!(!encoded.contains(['=', '+', '/']), "fragment must be URL-safe with no padding");

    let decoded = engine.decode(&encoded).expect("decode");
    assert_eq!(decoded, entropy, "entropy must survive the fragment round-trip");
}

// ── Shared-drive client-surface reachability ───────────────────────────────

/// Compile-time pin: Tasks 3-4 build on these exact paths. A bump that moves
/// or renames them must fail here, in the pin-bump PR, not in the feature
/// branch that consumes them.
#[test]
fn shared_drive_client_surface_is_reachable() {
    // `for_shared_drive` is the member-drive constructor Task 3 wires into
    // the init funnel. Taking the fn item is a pure compile-time reference.
    let _ = hcfs_client::drive::Drive::for_shared_drive::<&std::path::Path, &std::path::Path>;

    let identity = hcfs_client::drive::ForeignDriveIdentity {
        owner_ss58: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY".to_string(),
        folder_hash: "0123456789abcdef".to_string(),
        folder_mnemonic: zeroize::Zeroizing::new(TEST_MNEMONIC.to_string()),
        bearer_token: "bearer".to_string(),
        base_url: String::new(),
    };
    assert_eq!(identity.folder_hash.len(), 16);

    // The member flag Task 3 threads through `build_hcfs_config`.
    let config = hcfs_client::client::HcfsClientConfig {
        shared_drive_member: true,
        ..Default::default()
    };
    assert!(config.shared_drive_member);
}

/// The grant blob (Task 4) seals the owner's folder mnemonic to the member
/// via `mnemonic_blob`. Round-trip it and prove the SS58 AAD binding: a blob
/// sealed for one member must not open under another member's address.
#[test]
fn mnemonic_blob_seal_open_round_trips_with_ss58_binding() {
    const MEMBER_SS58: &str = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    const OTHER_SS58: &str = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

    let blob = seal_mnemonic(TEST_MNEMONIC, "correct horse battery staple", MEMBER_SS58).expect("seal");
    let opened = open_mnemonic(&blob, "correct horse battery staple", MEMBER_SS58).expect("open");
    assert_eq!(opened.as_str(), TEST_MNEMONIC, "sealed mnemonic must round-trip");

    let err = open_mnemonic(&blob, "correct horse battery staple", OTHER_SS58).expect_err("a different ss58 must fail the AEAD tag check");
    assert!(matches!(err, MnemonicBlobError::AeadTag), "got {err:?}");
}

// ── Folder-share client-surface pins (hcfs 27a48bd, desktop phase 3) ───────
//
// The browsable folder-share surface (`hcfs_client::client::folder_share`)
// the mint/list/revoke/expiry IPCs build on. Its wire types are private to
// hcfs-client (serialization happens inside `create_folder_share` et al. and
// hcfs pins the JSON in its own unit tests), so the desktop-visible contract
// is the URL builders, the token-hash digest, and the public structs —
// pinned here so a reshaping bump fails in the pin-bump PR, not at runtime
// in the feature branch that consumes them.

/// Exact recipient-URL vectors, copied from hcfs-client's own unit tests:
/// 32 zero bytes encode as 43 'A's in base64url-no-pad, and a trailing slash
/// on the console base must be trimmed. The console recipient page parses
/// exactly this `/share/folder/{token}#k=|#p=` shape, so the whole string is
/// pinned — a drifted path segment or fragment key breaks every minted link.
#[test]
fn folder_share_url_builders_are_pinned() {
    let public = build_folder_share_url("https://x.io/", "tok", &[0u8; 32]);
    assert_eq!(
        public,
        format!("https://x.io/share/folder/tok#k={}", "A".repeat(43)),
        "public folder-share URL drifted"
    );
    assert_eq!(
        public,
        build_folder_share_url("https://x.io", "tok", &[0u8; 32]),
        "a trailing slash on the console base must be trimmed"
    );

    let private = build_folder_share_url_private("https://x.io/", "tok", &[1, 2, 3]);
    assert_eq!(private, "https://x.io/share/folder/tok#p=AQID", "password folder-share URL drifted");
}

/// The owner listing carries `token_hash` (blake3 hex of the plaintext
/// token) ONLY; the desktop matches rows back to the tokens in its SQLite
/// keystore with this digest. Pin it to blake3 via the empty-string known
/// answer (the same vector hcfs pins against its server's `hash_token`) so
/// a digest swap can never silently orphan every stored share.
#[test]
fn folder_share_token_hash_is_pinned() {
    assert_eq!(
        folder_share_token_hash(""),
        "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262",
        "folder_share_token_hash must stay blake3 of the token bytes"
    );

    let hash = folder_share_token_hash("some-token");
    assert_eq!(hash.len(), 64, "token hash must be a 32-byte digest in hex");
    assert!(
        hash.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()),
        "token hash must be lowercase hex: {hash}"
    );
    assert_eq!(folder_share_token_hash("some-token"), hash, "token hash must be deterministic");
    assert_ne!(folder_share_token_hash("other-token"), hash, "distinct tokens must hash distinctly");
}

/// The structural invariant the keystore round-trip relies on: a
/// password-protected share's stored secret can only ever rebuild its `#p=`
/// link — never a password-free `#k=` one, which would strip the password
/// gate from a link the owner re-copies off the shares page.
#[test]
fn a_private_folder_share_secret_can_never_produce_a_key_url() {
    let blob = wrap_share_key("correct horse battery staple", &[7u8; 32]).expect("wrap share key");
    let url = build_folder_share_url_for("https://console.example.com", "tok", &ShareSecret::Private(blob));
    assert!(url.contains("#p="), "private secret must yield a #p= URL: {url}");
    assert!(!url.contains("#k="), "private secret must never yield a password-free #k= URL: {url}");

    let url = build_folder_share_url_for("https://console.example.com", "tok", &ShareSecret::Public([7u8; 32]));
    assert_eq!(
        url,
        build_folder_share_url("https://console.example.com", "tok", &[7u8; 32]),
        "public secret must yield the plain #k= URL"
    );
}

/// Compile-time pin of the folder-share structs and owner operations the
/// mint/list/revoke/expiry IPCs consume, mirroring
/// `shared_drive_client_surface_is_reachable`: the exhaustive struct
/// literals make a field rename, drop, or addition fail here, in the
/// pin-bump PR.
#[test]
fn folder_share_client_surface_is_reachable() {
    let options = FolderShareOptions {
        path_prefix: "photos/2026",
        display_name: "2026",
        ttl: ShareTtl::Days7,
        password: Some("correct horse battery staple"),
        console_base_url: "https://console.example.com",
    };
    assert_eq!(options.path_prefix, "photos/2026");

    let created_at = "2026-08-23T00:00:00Z".parse::<chrono::DateTime<chrono::Utc>>().expect("timestamp parses");
    let item = FolderShareListItem {
        token_hash: folder_share_token_hash("tok"),
        folder_hash: "0123456789abcdef".to_string(),
        path_prefix: String::new(),
        display_name: "My Drive".to_string(),
        created_at,
        expires_at: None,
        revoked_at: Some(created_at),
    };
    assert_eq!(item.path_prefix, "", "whole-drive share is the empty prefix");

    let created = CreatedFolderShare {
        share_token: "tok".to_string(),
        share_url: build_folder_share_url("https://console.example.com", "tok", &[0u8; 32]),
        expires_at: None,
    };
    assert!(created.share_url.contains("/share/folder/"));

    // The four owner operations the IPCs wire up. Taking the fn items is a
    // pure compile-time reference.
    let _ = hcfs_client::client::HcfsClient::create_folder_share;
    let _ = hcfs_client::client::HcfsClient::list_folder_shares;
    let _ = hcfs_client::client::HcfsClient::revoke_folder_share;
    let _ = hcfs_client::client::HcfsClient::update_folder_share_expiry;
}
