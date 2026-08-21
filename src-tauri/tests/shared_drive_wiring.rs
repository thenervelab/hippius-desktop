//! Source-text wiring pins for the shared-drives member guards (phase 2,
//! Task 3).
//!
//! The member-aware init funnel is a set of GUARDS on existing code paths:
//! their logic is unit-tested beside the code, and those tests stay green if
//! a refactor drops a guard's call site — which is exactly how a guard dies
//! quietly. Each of the three recon land mines is a data-loss bug when its
//! guard is missing:
//!
//! 1. `ensure_derived_mnemonic` rewrites a member drive's owner-sealed folder
//!    key and wipes sync state (the seal never matches the member's master
//!    derivation).
//! 2. The `user_id` assert must expect the WIRE composite (owner ss58 + owner
//!    hash for members), or every member init hard-fails.
//! 3. `folder_hash(local_label)` cannot derive a member drive's wire hash, so
//!    the funnel must resolve the identity ONCE and thread it down.
//!
//! Convention mirrors `tests/folder_share_wiring.rs` /
//! `tests/keep_awake_wiring.rs` / the spawn pins in the backfill suites.

/// Brace-matched body of the function whose signature contains `sig`, so a
/// reference in an unrelated helper elsewhere in the file can't satisfy an
/// assertion (mirrors the folder-entries backfill pin's extractor).
fn fn_body(src: &str, sig: &str) -> String {
    let sig_idx = src.find(sig).unwrap_or_else(|| panic!("signature not found: {sig}"));
    let body_start = src[sig_idx..].find('{').expect("fn body opens") + sig_idx;
    let mut depth = 0usize;
    let mut body_end = body_start;
    for (i, ch) in src[body_start..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    body_end = body_start + i;
                    break;
                }
            }
            _ => {}
        }
    }
    src[body_start..=body_end].to_string()
}

fn lifecycle_src() -> String {
    std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/sync/drive/lifecycle.rs")).expect("read lifecycle.rs")
}

/// The funnel resolves the wire identity exactly once and gates every
/// member-skip on it. COUNTING the guard sites (the scan-throttle pin
/// precedent) rather than merely `contains` means a refactor that drops ONE
/// of the four — credits pre-gate, `prepare_config_dir`'s member flag, the
/// folder-registration gate, the recovery-binding gate — fails here even
/// while the other three keep the substring present.
#[test]
fn initialize_sync_inner_resolves_identity_once_and_gates_the_member_skips() {
    let src = lifecycle_src();
    let body = fn_body(&src, "async fn initialize_sync_inner(");

    assert_eq!(
        body.matches("lookup_drive_identity(").count(),
        1,
        "initialize_sync_inner must resolve the drive identity exactly ONCE at the funnel top \
         (re-resolving mid-operation can split the init across two wire identities)"
    );

    let guard_sites = body.matches("identity.is_member").count();
    assert_eq!(
        guard_sites, 4,
        "expected exactly 4 member-guard sites in initialize_sync_inner (credits pre-gate, \
         prepare_config_dir flag, spawn_folder_registration gate, recovery-binding gate); found {guard_sites}"
    );
}

/// LAND MINE 2: `unlock` composes the user id from the client config's
/// ss58 + folder hash, so the funnel must assert the WIRE composite. An
/// `{account_id}_{fhash}` expectation would fail every member init.
#[test]
fn initialize_sync_inner_asserts_the_wire_user_id_composite() {
    let src = lifecycle_src();
    let body = fn_body(&src, "async fn initialize_sync_inner(");
    assert!(
        body.contains("format!(\"{}_{}\", identity.wire_ss58, identity.wire_folder_hash)"),
        "the user_id assert must expect the wire composite (owner pair for member drives)"
    );
}

/// LAND MINE 1: `ensure_derived_mnemonic` must run ONLY behind the member
/// gate. The count assertion matters: a `contains` check alone would still
/// pass if a refactor reinstated an unconditional call beside the guarded
/// one.
#[test]
fn prepare_config_dir_gates_ensure_derived_mnemonic_on_membership() {
    let src = lifecycle_src();
    let body = fn_body(&src, "fn prepare_config_dir(");
    assert!(
        body.contains("if !is_member"),
        "prepare_config_dir must gate the derived-mnemonic check on !is_member"
    );
    assert_eq!(
        body.matches("ensure_derived_mnemonic(").count(),
        1,
        "ensure_derived_mnemonic must be called exactly once (inside the member gate)"
    );
}

/// The member refusal in `recover_drive` must come BEFORE the cleanup that
/// deletes `enc_mnemonic.json` — a guard placed after it would "refuse"
/// having already destroyed the only local copy of the owner's folder key.
#[test]
fn recover_drive_refuses_members_before_deleting_the_seal() {
    let src = lifecycle_src();
    let body = fn_body(&src, "async fn recover_drive(");
    let guard = body.find("ctx.identity.is_member").expect("recover_drive must carry the member guard");
    // The CODE that resolves the seal path for deletion — not the guard's own
    // doc comment, which also mentions the filename.
    let cleanup = body
        .find("join(\"enc_mnemonic.json\")")
        .expect("recover_drive resolves the seal file for cleanup");
    assert!(
        guard < cleanup,
        "the member guard must precede the seal cleanup (guard at {guard}, cleanup at {cleanup})"
    );
}

/// The fresh-init branch must refuse member drives before `init_new_drive`
/// derives (wrong) key material from this account's master.
#[test]
fn init_or_unlock_refuses_member_fresh_init_before_deriving() {
    let src = lifecycle_src();
    let body = fn_body(&src, "async fn init_or_unlock_drive(");
    let guard = body
        .find("recovery_ctx.identity.is_member")
        .expect("init_or_unlock_drive must carry the fresh-init member guard");
    let derive = body.find("init_new_drive(").expect("init_or_unlock_drive calls init_new_drive");
    assert!(
        guard < derive,
        "the member guard must precede init_new_drive (guard at {guard}, derive at {derive})"
    );
}

/// The one-shot relative-path backfill must skip member drives (their server
/// rows are the OWNER's) and stamp the flag so the FE's pre-backfill banner
/// clears instead of waiting forever.
#[test]
fn relative_path_backfill_gates_member_drives() {
    let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/sync/migrate/relative_path_backfill.rs")).expect("read backfill");
    let body = fn_body(&src, "pub async fn run_backfill_for_drive(");
    assert!(body.contains("is_member"), "run_backfill_for_drive must check drive membership");
    assert!(
        body.contains("SkippedMemberDrive"),
        "run_backfill_for_drive must short-circuit member drives with the dedicated outcome"
    );
}

/// Same gate for the one-shot folder-entity backfill.
#[test]
fn folder_entries_backfill_gates_member_drives() {
    let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/sync/migrate/folder_entries_backfill.rs")).expect("read backfill");
    let body = fn_body(&src, "pub async fn run_folder_entries_backfill_for_drive(");
    assert!(
        body.contains("is_member"),
        "run_folder_entries_backfill_for_drive must check drive membership"
    );
    assert!(
        body.contains("SkippedMemberDrive"),
        "run_folder_entries_backfill_for_drive must short-circuit member drives with the dedicated outcome"
    );
}

fn shared_drive_commands_src() -> String {
    std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/shared_drives/commands.rs")).expect("read shared_drives/commands.rs")
}

/// Self-leave must ALWAYS name the drive owner: the server's bare fallback
/// (`?owner=` absent) deletes EVERY same-hash membership of the caller in one
/// statement, and folder hashes are label-derived so two owners' "Documents"
/// drives collide as a matter of course. The behavioral pass-through is
/// covered in `tests/shared_drive_server_mock.rs`; this pins the COMMAND to
/// the resolved owner value so a refactor can't quietly drop the param.
#[test]
fn leave_shared_drive_always_passes_the_owner_param() {
    let src = shared_drive_commands_src();
    let body = fn_body(&src, "pub async fn leave_shared_drive(");
    assert!(
        body.contains("Some(&identity.wire_ss58)"),
        "leave_shared_drive must pass the resolved owner as the ?owner= param"
    );
}

/// Every owner-side command resolves its label through the single
/// `resolve_own_drive` gate (which refuses member labels). Counting the call
/// sites means dropping the gate from ONE command still fails here.
#[test]
fn owner_side_commands_route_through_the_own_drive_gate() {
    let src = shared_drive_commands_src();
    for command in [
        "pub async fn create_drive_invite(",
        "pub async fn list_drive_members(",
        "pub async fn remove_drive_member(",
    ] {
        let body = fn_body(&src, command);
        assert!(
            body.contains("resolve_own_drive("),
            "{command} must resolve its label through resolve_own_drive"
        );
    }
}

/// Storage on a shared drive bills the OWNER: `add_shared_drive` must not
/// grow a `require_eligible` gate on the member's own balance (the init
/// funnel's member skip and the server 402 are the authorities).
#[test]
fn add_shared_drive_has_no_member_side_credit_gate() {
    let src = shared_drive_commands_src();
    let body = fn_body(&src, "pub async fn add_shared_drive(");
    assert!(
        !body.contains("require_eligible"),
        "add_shared_drive must not gate on the MEMBER's credit balance — the owner pays"
    );
}

/// Every complete `macro_name(...)` invocation in `src`, paren-matched so a
/// multi-line tracing call is captured whole (a line-based scan would miss a
/// secret binding on the call's second line).
fn macro_calls(src: &str, macro_name: &str) -> Vec<String> {
    let mut calls = Vec::new();
    let mut search_from = 0;
    while let Some(rel) = src[search_from..].find(macro_name) {
        let start = search_from + rel;
        let args_start = start + macro_name.len();
        let mut depth = 0usize;
        let mut end = args_start;
        for (i, ch) in src[args_start..].char_indices() {
            match ch {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        end = args_start + i;
                        break;
                    }
                }
                _ => {}
            }
        }
        calls.push(src[start..=end].to_string());
        search_from = end + 1;
    }
    calls
}

/// Secret hygiene pin: the invite token, the folder-key entropy, the
/// assembled invite URL, and every mnemonic/passphrase binding are
/// drive-access capabilities — no tracing call in the shared_drives module
/// may reference one. The module docs state the rule ("log labels and folder
/// hashes only"); this makes a violating `info!(token = %token, ...)` a CI
/// failure instead of a review catch.
#[test]
fn shared_drives_tracing_calls_never_name_secret_bindings() {
    let grant_src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/shared_drives/grant.rs")).expect("read grant.rs");
    let forbidden = [
        "token",
        "entropy",
        "invite_url",
        "phrase",
        "passphrase",
        "grant_blob",
        "master",
        "mnemonic",
    ];

    for (file, src) in [("commands.rs", shared_drive_commands_src()), ("grant.rs", grant_src)] {
        for macro_name in ["trace!", "debug!", "info!", "warn!", "error!"] {
            for call in macro_calls(&src, macro_name) {
                for secret in forbidden {
                    assert!(
                        !call.contains(secret),
                        "{file}: a {macro_name} call references '{secret}' — shared-drive logs may carry labels and folder hashes only:\n{call}"
                    );
                }
            }
        }
    }
}

/// The per-cycle folder-entity sync must carry its OWN member gate: the
/// member backfill stamps `folder_entries_backfilled_at`, so the
/// `NotBackfilledYet` gate above it does NOT defend member drives.
#[test]
fn folder_entity_sync_gates_member_drives() {
    let src =
        std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/sync/migrate/folder_entries_materialize.rs")).expect("read materialize");
    let body = fn_body(&src, "pub async fn run_folder_entity_sync_for_drive(");
    assert!(body.contains("is_member"), "run_folder_entity_sync_for_drive must check drive membership");
    // Match the CODE token, not the bare enum name — `SkippedMemberDrive`
    // alone is satisfiable by a comment mentioning the variant.
    assert!(
        body.contains("return Ok(FolderEntitySyncOutcome::SkippedMemberDrive)"),
        "run_folder_entity_sync_for_drive must short-circuit member drives with the dedicated outcome"
    );
}

// ─────────────────────────────────────────────────────────────────────
// Task 5: revocation surfacing (SHARED_DRIVE_REVOKED_MARKER routing)
// ─────────────────────────────────────────────────────────────────────

fn tauri_bridge_src() -> String {
    std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/sync/projection/tauri_bridge.rs")).expect("read tauri_bridge.rs")
}

/// The revoked branch must exist in `handle_sync_error` AND be ordered
/// BEFORE the flaky-endpoint counting: a revocation that reaches
/// `error_notify.record_failure` would (a) pollute the 3-strike counter and
/// (b) wait out the gate before notifying — both wrong for a definitive
/// server-side state. The `SharedDriveRevoked` match arm needle binds to the
/// dispatch, and the `record_failure` needle to the gating it must precede.
#[test]
fn handle_sync_error_routes_revocation_before_error_notify_counting() {
    let src = tauri_bridge_src();
    let body = fn_body(&src, "pub(crate) fn handle_sync_error(");

    let revoked_idx = body
        .find("SyncErrorDisposition::SharedDriveRevoked =>")
        .expect("handle_sync_error must dispatch the revoked marker to its own arm");
    assert!(
        body[revoked_idx..].contains("handle_shared_drive_revoked("),
        "the revoked arm must delegate to handle_shared_drive_revoked"
    );
    let gate_idx = body
        .find("record_failure(")
        .expect("handle_sync_error must still gate generic errors via error_notify.record_failure");
    assert!(
        revoked_idx < gate_idx,
        "the revoked dispatch must come BEFORE error_notify counting (revoked {revoked_idx} / gate {gate_idx})"
    );
}

/// The revoked handler's contract, pinned structurally:
/// - exactly ONE `SYNC_FAILED_NOTIFY` emit, gated behind the
///   `revoked_notify` edge latch (the engine re-emits the marker every
///   backoff retry until the teardown lands — each must not add a row);
/// - the terminal teardown spawn (`teardown_revoked_drive`);
/// - a `SYNC_ERROR` emit for the live consumers;
/// - NO use of the flaky-endpoint counter.
#[test]
fn revoked_handler_notifies_once_and_never_feeds_the_flaky_counter() {
    let src = tauri_bridge_src();
    let body = fn_body(&src, "fn handle_shared_drive_revoked(");

    assert_eq!(
        body.matches("SYNC_FAILED_NOTIFY").count(),
        1,
        "handle_shared_drive_revoked must emit SYNC_FAILED_NOTIFY exactly once (latch-gated)"
    );
    let latch_idx = body
        .find("revoked_notify.record_failure(")
        .expect("the notify + teardown must be gated on the revoked_notify latch");
    let notify_idx = body.find("SYNC_FAILED_NOTIFY").expect("notify emit present");
    let teardown_idx = body
        .find("teardown_revoked_drive(")
        .expect("handle_shared_drive_revoked must spawn the terminal teardown");
    assert!(
        latch_idx < teardown_idx && latch_idx < notify_idx,
        "latch must gate both the teardown spawn and the notify emit \
         (latch {latch_idx} / teardown {teardown_idx} / notify {notify_idx})"
    );
    assert!(
        body.contains("SYNC_ERROR"),
        "live consumers (ConflictEventListener) must still see the failed cycle via SYNC_ERROR"
    );
    assert!(
        !body.contains("error_notify"),
        "a revocation must never touch the flaky-endpoint counter (error_notify)"
    );

    // Copy unification (Task 6 ride-along): the persisted notification must
    // carry the user copy the drive row settles on, not the engine's internal
    // marker — and the rewrite must be local to the notify emit, with
    // `SYNC_ERROR` still forwarding the raw payload for the live-consumer
    // contract (classify_sync_error matches the marker by exact equality).
    assert!(
        body.contains("notify_payload.error = crate::sync::drive_status::SHARED_DRIVE_REVOKED_MESSAGE"),
        "the notify payload's error must be rewritten to SHARED_DRIVE_REVOKED_MESSAGE"
    );
    assert!(
        body.contains("app.emit(events::SYNC_FAILED_NOTIFY, notify_payload)"),
        "the SYNC_FAILED_NOTIFY emit must carry the rewritten payload"
    );
    assert!(
        body.contains("app.emit(events::SYNC_ERROR, payload)"),
        "SYNC_ERROR must keep the RAW marker payload — never the rewritten copy"
    );
}

/// The revocation latch re-arms on the SAME edges as the flaky counter, so a
/// fresh episode (resume / re-add / account switch) notifies again while a
/// spent latch keeps suppressing backoff re-emits within one episode.
#[test]
fn revoked_latch_clears_ride_the_existing_teardown_edges() {
    let src = tauri_bridge_src();

    let stopped = fn_body(&src, "fn handle_sync_stopped(");
    assert!(
        stopped.contains("revoked_notify.clear("),
        "handle_sync_stopped must re-arm the revocation latch (the teardown's own tail)"
    );

    let completed = fn_body(&src, "pub(crate) fn handle_sync_completed(");
    assert!(
        completed.contains("revoked_notify.clear("),
        "handle_sync_completed must re-arm the revocation latch on the recovery edge"
    );

    let reset = fn_body(&src, "fn handle_sync_reset(");
    assert!(
        reset.contains("revoked_notify.clear_all()"),
        "handle_sync_reset must wipe the revocation latch across accounts"
    );
}
