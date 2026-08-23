//! Source-text wiring pins for the folder-share mint guards.
//!
//! The gates are only worth anything if they are actually CALLED. Their logic
//! is unit-tested in isolation (`folder_share_path_prefix`, the capability
//! serde tests), and those tests stay green if a refactor drops the call site
//! — which is exactly how a guard dies quietly. Mirrors the convention used by
//! `tests/keep_awake_wiring.rs` and the previous zip-era pins this file held.
//!
//! Every gate deliberately lives in `create_folder_share_inner` rather than in
//! the IPC command, because the Finder right-click calls that function
//! directly. A guard sitting in the command would leave that path uncovered —
//! the same lesson the zip funnel's settled-folder guard taught.

/// Body of the named fn, from its signature to the next top-level doc comment.
fn fn_body(source: &str, signature: &str) -> String {
    let start = source.find(signature).unwrap_or_else(|| panic!("{signature} must exist"));
    let rest = &source[start..];
    let end = rest[1..].find("\n/// ").map_or(rest.len(), |i| i + 1);
    rest[..end].to_string()
}

fn mint_funnel_body() -> String {
    let source = include_str!("../src/shares/commands.rs");
    fn_body(source, "pub(crate) async fn create_folder_share_inner")
}

#[test]
fn the_mint_funnel_gates_on_the_folder_shares_capability() {
    let body = mint_funnel_body();
    assert!(
        body.contains("require_folder_shares_supported"),
        "create_folder_share_inner must check capabilities.folder_shares; without this call a \
         desktop pointed at an old server surfaces an opaque 404 instead of a feature-unavailable \
         message — and the Finder path has no other gate"
    );
}

#[test]
fn the_mint_funnel_refuses_member_drives() {
    let body = mint_funnel_body();
    assert!(
        body.contains("is_member"),
        "create_folder_share_inner must refuse member drives: folder shares are owner-mint-only \
         (server v1), and a member's derived key is not the owner-chain drive key the fragment \
         must carry"
    );
}

#[test]
fn the_mint_funnel_derives_the_key_through_the_canonical_chain() {
    let body = mint_funnel_body();
    assert!(
        body.contains("encryption_key_for_label"),
        "create_folder_share_inner must derive the drive file key via encryption_key_for_label — \
         the single derivation the sync engine and remote preview share. A second inline \
         derivation here could silently diverge and mint links whose fragment key decrypts nothing"
    );
}

#[test]
fn the_mint_funnel_builds_a_drive_scoped_client() {
    let body = mint_funnel_body();
    assert!(
        body.contains("crate::sync::remote::build_client"),
        "create_folder_share_inner must build the drive-scoped client from the resolved identity; \
         the account-scoped share client has no folder_hash and the mint would be refused \
         client-side as MissingFolderHash"
    );
}

/// The Finder right-click's directory branch must route into the SAME funnel
/// as the in-app IPC, so the two entry points cannot drift on gates or key
/// handling — the invariant the zip funnel enforced for its era.
#[test]
fn the_finder_directory_branch_routes_to_the_mint_funnel() {
    let source = include_str!("../src/finder_bridge/dispatch.rs");
    let body = fn_body(source, "async fn share_for_path");
    assert!(
        body.contains("create_folder_share_inner"),
        "share_for_path's directory branch must mint through create_folder_share_inner"
    );
}
