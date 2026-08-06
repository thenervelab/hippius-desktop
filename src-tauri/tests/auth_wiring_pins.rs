//! Static wiring pins for the auth-flow fixes from
//! `AUDIT_LOGIN_2026-08-06.md` (H-1, H-3, H-4).
//!
//! The guarded behaviors themselves are unit-tested next to their code
//! (`auth/service.rs::derive_verified_keys_*`,
//! `auth/session_restore.rs::recovery_probe_*`). What a unit test cannot
//! pin is the WIRING: the re-authentication sites must actually route
//! through `derive_verified_keys` (else the OAuth phantom-account bug
//! returns), and `complete_oauth_flow` must run its recovery probe
//! through the bounded best-effort helper (else a slow hcfs-server fails
//! login after it already succeeded). These source pins follow the
//! pattern of `hippius_relative_path_backfill.rs` (assert the funnel
//! references its guard) and intentionally break if the functions move
//! without updating this file.

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
        .unwrap_or_else(|| panic!("marker {start:?} not found — update auth_wiring_pins.rs if the function moved"));
    let tail = &src[begin..];
    match tail.find(end) {
        Some(stop) => &tail[..stop],
        None => tail,
    }
}

#[test]
fn token_refresh_routes_through_verified_derive() {
    let src = source("src/auth/service.rs");
    let body = slice_between(&src, "pub(crate) async fn refresh_auth_token_internal", "#[cfg(test)]");
    assert!(
        body.contains("derive_verified_keys("),
        "refresh_auth_token_internal must derive via derive_verified_keys — \
         the unverified derive re-authenticates OAuth accounts as a phantom identity (audit H-3)"
    );
    assert!(
        !body.contains("derive_keys(&mnemonic)"),
        "refresh_auth_token_internal must not call the bare derive_keys on the stored mnemonic (audit H-3)"
    );
}

#[test]
fn billing_auth_routes_through_verified_derive() {
    let src = source("src/auth/billing_auth.rs");
    assert!(
        src.contains("derive_verified_keys("),
        "ensure_billing_auth must derive via derive_verified_keys — \
         the unverified derive persisted a foreign identity's token under the OAuth account (audit H-4)"
    );
    assert!(
        !src.contains("service::derive_keys("),
        "billing_auth must not call the bare service::derive_keys (audit H-4)"
    );
}

#[test]
fn oauth_completion_probe_is_bounded_and_best_effort() {
    // Audit H-1: `complete_oauth_flow` runs the recovery probe AFTER the
    // session is persisted. It must go through the bounded, best-effort
    // `probe_recovery_state_bounded` — a bare fatal
    // `check_recovery_state_inner(...).await?` fails (or hangs) the whole
    // login at its last step when hcfs-server is slow, even though
    // authentication already succeeded.
    let src = source("src/auth/oauth.rs");
    let body = slice_between(&src, "pub async fn complete_oauth_flow", "#[cfg(test)]");
    assert!(
        body.contains("probe_recovery_state_bounded("),
        "complete_oauth_flow must run the recovery probe through probe_recovery_state_bounded (audit H-1)"
    );
    assert!(
        !body.contains("check_recovery_state_inner(&state).await?"),
        "complete_oauth_flow must not await the recovery probe fatally/unbounded (audit H-1)"
    );
}

#[test]
fn db_fallback_restore_checks_expiry_before_keychain_soft_path() {
    // Audit M-1 review finding (PR #103): the DB-fallback branch of
    // `restore_session` must apply the same precedence as
    // `classify_restore_token` — expiry metadata wins over keychain
    // state. If the keychain-unavailable soft return runs first, an
    // expired session hit by a keychain hiccup is never cleared and
    // survives indefinitely.
    let src = source("src/auth/session_restore.rs");
    let body = slice_between(&src, "// ── Fall back to Rust DB session", "// Valid session — build OAuth session");
    let expiry_at = body
        .find("row.token_expiry")
        .expect("DB-fallback branch must check row.token_expiry — update this pin if restructured");
    let soft_at = body
        .find("row.token_keychain_unavailable")
        .expect("DB-fallback branch must handle row.token_keychain_unavailable — update this pin if restructured");
    assert!(
        expiry_at < soft_at,
        "expiry check must run BEFORE the keychain-unavailable soft path (expiry wins — audit M-1)"
    );
}

#[test]
fn oauth_mirror_consume_stays_inside_the_state_lock() {
    // PR #105 review finding: the `oauth_pending_states` mirror must be
    // loaded and consumed INSIDE the `pkce_states` critical section. A
    // load before the lock (or a delete after it) lets a concurrent
    // duplicate callback re-read the not-yet-deleted mirror row and
    // resurrect an already-consumed CSRF state — replaying the
    // consume-once guarantee.
    let src = source("src/auth/oauth.rs");
    let body = slice_between(&src, "pub async fn complete_oauth_flow", "#[cfg(test)]");
    let lock_at = body.find(".lock().await").expect("completion must acquire the pkce_states lock");
    let load_at = body.find("load_pending_states(").expect("completion must reload the mirror");
    let delete_at = body.find("delete_pending_state(").expect("strict path must delete its mirror row");
    let clear_at = body.find("clear_pending_states(").expect("fallback path must drain the mirror");
    let after_block = body
        .find("let (token, user_id")
        .expect("marker for the end of the consume block — update this pin if restructured");
    assert!(lock_at < load_at && load_at < after_block, "mirror load must happen inside the lock");
    assert!(
        lock_at < delete_at && delete_at < after_block,
        "strict-path mirror delete must happen inside the lock"
    );
    assert!(
        lock_at < clear_at && clear_at < after_block,
        "fallback mirror drain must happen inside the lock"
    );
}
