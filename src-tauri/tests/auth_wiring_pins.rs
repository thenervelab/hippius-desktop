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
fn restore_token_validation_routes_through_the_pure_classifier() {
    // Audit M-1 review finding (PR #103): expiry metadata must win over
    // keychain state, or an expired session hit by a keychain hiccup is
    // never cleared and survives indefinitely. That precedence now lives
    // in ONE place — the pure `classify_restore_token` — so the pin is
    // that `restore_session` routes through it rather than growing a
    // second, drifting copy of the ordering.
    let src = source("src/auth/session_restore.rs");
    let body = slice_between(&src, "pub async fn restore_session", "#[cfg(test)]");
    assert!(
        body.contains("classify_restore_token("),
        "restore_session must classify the token through classify_restore_token (audit M-1)"
    );

    // ...and inside the classifier, expiry is evaluated first.
    let classifier = slice_between(&src, "fn classify_restore_token(", "\n}\n");
    let expiry_at = classifier
        .find("expiry_ms")
        .expect("classifier must inspect expiry_ms — update this pin if restructured");
    let keychain_at = classifier
        .find("keychain_unavailable")
        .expect("classifier must handle keychain_unavailable — update this pin if restructured");
    assert!(
        expiry_at < keychain_at,
        "expiry check must run BEFORE the keychain-unavailable soft path (expiry wins — audit M-1)"
    );
}

#[test]
fn restore_session_takes_no_frontend_supplied_session() {
    // Audit S-4: the renderer no longer hands its localStorage OAuth
    // session to Rust, so the bearer token need not be persisted there and
    // there is no renderer-controlled input left to validate. Reintroducing
    // the parameter would resurrect both the secret-at-rest exposure and
    // the tamper-check (`fe_session_proves_token`) it required.
    let src = source("src/auth/session_restore.rs");
    assert!(
        !src.contains("oauth_session_json"),
        "restore_session must not accept a frontend-supplied OAuth session (audit S-4)"
    );
    assert!(
        !src.contains("fe_session_proves_token"),
        "the FE token tamper-check is obsolete once the row is the only input (audit S-4)"
    );
}

#[test]
fn restore_arms_the_recovery_gate_for_oauth_sessions() {
    // This block used to live ONLY on the localStorage-driven restore
    // path, so a DB-restored OAuth session left the recovery gate at its
    // startup default `Skipped` — the state `recovery_gate_target`'s own
    // docs call unsafe, because `ensure_sync_mnemonic` may then mint a
    // fresh mnemonic on a device that needs the server-sealed blob and
    // corrupt the drive password. Now that there is one restore path, the
    // gate must be armed there or no OAuth restore arms it at all.
    let src = source("src/auth/session_restore.rs");
    let body = slice_between(&src, "pub async fn restore_session", "#[cfg(test)]");
    assert!(
        body.contains("recovery_gate_target("),
        "restore_session must resolve the recovery gate for OAuth sessions"
    );
    assert!(
        body.contains("set_recovery_state("),
        "restore_session must APPLY the resolved recovery gate — resolving without setting is a no-op"
    );
    assert!(
        body.contains("probe_recovery_state_bounded("),
        "the recovery probe must stay bounded so an unreachable hcfs-server cannot hang boot (audit H-1)"
    );
}

#[test]
fn restore_identity_check_routes_through_verified_derive() {
    // The third re-authentication-shaped site (after refresh and billing):
    // restore decides whether a stored keychain mnemonic may act for the
    // session row's account. That equality must come from the canonical
    // guard, not a hand-rolled compare, or the H-3/H-4 phantom-identity
    // class can reappear through a second, subtly-different copy.
    let src = source("src/auth/session_restore.rs");
    let body = slice_between(&src, "fn load_keychain_identity(", "\n}\n");
    assert!(
        body.contains("derive_verified_keys("),
        "load_keychain_identity must decide identity via derive_verified_keys (audit H-3/H-4)"
    );
    assert!(
        !body.contains("service::derive_keys("),
        "restore must not hand-roll the identity comparison on the bare derive_keys (audit H-3/H-4)"
    );
}

#[test]
fn restore_repairs_legacy_mislabelled_provider_rows() {
    // Audit H-4 residue: pre-#102 builds wrote `provider = "mnemonic"`
    // keyed by an OAuth account's login SS58. With the row as restore's
    // only input, believing that label sends an OAuth account down the
    // mnemonic path — `rehydrate_full_session` then writes the address it
    // DERIVES into `AuthInfo`, splitting it from the session returned to
    // the frontend, and `needs_sync_mnemonic` goes false so sync never
    // receives its mnemonic. Both the detection and the repair must stay
    // wired into the restore funnel.
    let src = source("src/auth/session_restore.rs");
    let body = slice_between(&src, "pub async fn restore_session", "#[cfg(test)]");
    assert!(
        body.contains("check_provider("),
        "restore_session must detect a mislabelled provider before deriving auth_type (audit H-4 residue)"
    );
    assert!(
        body.contains("repair_provider("),
        "restore_session must persist the provider repair so the mislabel is fixed once (audit H-4 residue)"
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

#[test]
fn auth_logout_clears_persisted_credentials_before_in_memory_auth() {
    // Wiping AuthInfo first would let a failed DB clear leave a live on-disk
    // token that silently rehydrates the session on the next restore.
    let src = source("src/auth/logout.rs");
    let body = slice_between(&src, "pub async fn auth_logout_internal", "pub async fn logout_full");
    let persist = body.find("auth_session_repo::clear").expect("must clear the auth_session row");
    let token = body.find("clear_api_token").expect("must clear plaintext token fallbacks");
    let memory = body.find("substrate_address = None").expect("must wipe in-memory AuthInfo");
    assert!(
        persist < memory && token < memory,
        "persisted credentials must be cleared before AuthInfo is wiped"
    );
}
