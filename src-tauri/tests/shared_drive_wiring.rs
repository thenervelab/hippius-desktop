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

/// Only the owner changes access. Every command that invites, removes, changes
/// a role, revokes, approves or changes folder grants resolves through the
/// OWNER gate (`resolve_owned_target`, or `resolve_own_drive` for the badge
/// listing), which refuses a drive this account does not own before any key is
/// read or any request made. The reads a member may make (who has access, the
/// panel) go through the access gate, and nothing reaches the raw lenient
/// resolver directly, which would silently skip whichever gate its siblings
/// share.
#[test]
fn access_changes_are_owner_only() {
    let src = shared_drive_commands_src();
    for command in [
        "async fn mint_invite_link(",
        "pub async fn remove_drive_member(",
        "pub async fn change_drive_member_role(",
        "pub async fn list_drive_invites(",
        "pub async fn revoke_drive_invite(",
        "pub async fn email_drive_invite(",
        "pub async fn email_invites_available(",
        "pub async fn approve_email_invite(",
        "pub async fn replace_folder_grants(",
    ] {
        let body = fn_body(&src, command);
        assert!(
            body.contains("resolve_owned_target("),
            "{command} changes access and must resolve through the owner gate"
        );
        assert!(
            !body.contains("resolve_access_target(") && !body.contains("member_owner("),
            "{command} must not admit or name somebody else's drive"
        );
    }
    for command in [
        "pub async fn list_drive_members(",
        "pub async fn list_share_access(",
        "pub async fn list_access_panel(",
        "pub async fn list_drive_folder_grants(",
    ] {
        let body = fn_body(&src, command);
        assert!(
            body.contains("resolve_access_target("),
            "{command} is a read a member may make, through the access gate"
        );
    }
    let sharing = fn_body(&src, "pub async fn list_owned_drive_sharing(");
    assert!(sharing.contains("resolve_own_drive("), "the sharing badge listing stays owner-only");
    let folder_sharing = fn_body(&src, "pub async fn list_owned_folder_sharing(");
    assert!(folder_sharing.contains("resolve_own_drive("), "the folder sharing marks stay owner-only");
    for command in [
        "async fn mint_invite_link(",
        "pub async fn list_drive_members(",
        "pub async fn list_share_access(",
        "pub async fn list_access_panel(",
        "pub async fn list_owned_drive_sharing(",
        "pub async fn list_owned_folder_sharing(",
        "pub async fn approve_email_invite(",
    ] {
        assert!(
            !fn_body(&src, command).contains("resolve_drive_identity_or_own("),
            "{command} must not reach past its gate to the raw lenient resolver"
        );
    }
}

/// The role that goes on the wire is checked FIRST: a `manager` (or anything
/// but Viewer and Editor) is refused before the session, the drive or the
/// network is touched.
#[test]
fn a_manager_role_is_refused_before_anything_else() {
    let src = shared_drive_commands_src();
    for (command, check) in [
        ("async fn mint_invite_link(", "resolve_invite_role(role)"),
        ("pub async fn email_drive_invite(", "resolve_email_invite("),
        ("pub async fn change_drive_member_role(", "require_offered_role(&role)"),
    ] {
        let body = fn_body(&src, command);
        let checked = body.find(check).unwrap_or_else(|| panic!("{command} must check the role with {check}"));
        let ctx = body.find("api_ctx(").unwrap_or_else(|| panic!("{command} reads the session"));
        assert!(checked < ctx, "{command} must refuse the role before reading the session or the drive");
    }
}

/// Seal-back after mint (console `sealMintedToken`): without it the Links
/// tab can never re-show a link once the create dialog closes.
#[test]
fn create_drive_invite_seals_the_token_back() {
    let src = shared_drive_commands_src();
    let body = fn_body(&src, "async fn mint_invite_link(");
    assert!(
        body.contains("seal_invite_token") && body.contains("http_put_sealed_token"),
        "create_drive_invite must park the sealed token so the Links tab can rebuild URLs"
    );
}

/// Both invite commands mint through the ONE funnel, so the gates above hold
/// for folder invites too, and sharing a folder can never be a whole-drive
/// invite: the folder command's path is required (not an `Option`) and is
/// planned, which refuses an empty one, before any request goes out.
#[test]
fn a_folder_invite_can_never_go_out_as_a_drive_invite() {
    let src = shared_drive_commands_src();
    let drive = fn_body(&src, "pub async fn create_drive_invite(");
    let folder = fn_body(&src, "pub async fn create_folder_invite(");
    assert!(drive.contains("mint_invite_link(") && drive.contains("InviteScope::Drive"));
    assert!(folder.contains("mint_invite_link(") && folder.contains("InviteScope::Folder"));
    assert!(
        !drive.contains("path_prefix"),
        "the drive command takes no folder: one command, one kind of invite"
    );

    let sig_start = src.find("pub async fn create_folder_invite(").expect("folder command");
    let sig = &src[sig_start..sig_start + src[sig_start..].find('{').expect("body")];
    assert!(sig.contains("path_prefix: String,"), "the folder is required, never optional");

    let funnel = fn_body(&src, "async fn mint_invite_link(");
    let plan = funnel.find("plan_folder_invite(").expect("the folder is planned");
    let request = funnel.find("http_create_invite(").expect("then minted");
    assert!(plan < request, "the folder path is validated before any request");
    assert!(
        funnel.contains("require_server_knows_folder_invites"),
        "a server that would ignore the folder is never sent one"
    );
    // The same for a MAILED folder invite, which has no echo to check.
    let email = fn_body(&src, "pub async fn email_drive_invite(");
    assert!(email.contains("require_server_knows_folder_invites"));
}

/// Opening sealed tokens on list is what puts a copyable URL on each Links
/// row; without it the tab only shows role/usage/expiry metadata.
#[test]
fn list_drive_invites_opens_sealed_tokens() {
    let src = shared_drive_commands_src();
    let helper = fn_body(&src, "async fn open_invite_links(");
    assert!(
        helper.contains("open_invite_token") && helper.contains("build_invite_url"),
        "open_invite_links must open sealed tokens and attach invite_url"
    );
    assert!(helper.contains("sealed_token = None"), "no ciphertext reaches the FE");
    // Both listings that show a link go through it: the Links rows and the
    // access panel.
    for command in ["pub async fn list_drive_invites(", "pub async fn list_access_panel("] {
        let body = fn_body(&src, command);
        assert!(body.contains("open_invite_links("), "{command} must open sealed links");
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

/// The mint must take the folder key from the ONE resolver that knows where a
/// drive's key lives, never from a copy of that branch.
///
/// A copy is free to drift: a key derived from the wrong mnemonic is simply a
/// different key, and nothing here would fail. The mint succeeds, the link
/// looks right, and the recipient joins and finds that nothing decrypts. The
/// same reasoning, and the same file, as `remote::encryption_key_for_label`,
/// which is unit-tested; this pins the mint to it so the branch cannot be
/// refactored away.
#[test]
fn the_mint_takes_its_folder_key_from_the_one_resolver() {
    let body = fn_body(&shared_drive_commands_src(), "async fn mint_invite_link(");

    assert!(
        body.contains("drive_key_material_for_label"),
        "the mint must take its folder key from the one resolver that knows all three sources"
    );

    // It used to carry its own copy of the member branch, and that copy read
    // the drive password WITHOUT the session mnemonic -- so an encrypted
    // password could not be decrypted and the mint failed outright.
    // The resolver takes the mnemonic; a second copy here would be free to
    // forget it again.
    assert!(
        !body.contains("enc_mnemonic.json"),
        "the mint must not re-implement where a member drive's key lives"
    );
    assert!(
        !body.contains("get_drive_password"),
        "the mint must not read the drive password itself: that is how it came to read it without a mnemonic"
    );
    assert!(!body.contains("derive_folder_mnemonic"), "nor re-derive an own drive's phrase");
}

/// A member's read of somebody else's drive names that drive's owner.
///
/// `folder_hash` is label-derived and collides across owners as a matter of
/// course, so a read that drops the owner addresses whichever row the server
/// finds first. The value comes from ONE helper so a new read cannot quietly
/// omit it.
#[test]
fn every_member_read_names_the_owner() {
    let src = shared_drive_commands_src();
    for sig in [
        "pub async fn list_drive_members",
        "pub async fn list_share_access",
        "pub async fn list_access_panel",
        "pub async fn list_drive_folder_grants",
    ] {
        let body = fn_body(&src, sig);
        assert!(
            body.contains("member_owner(&identity)"),
            "{sig} must name the owner, or a member's read addresses the wrong drive"
        );
    }
}

/// A file's encryption key and its manifest signing key come from ONE folder
/// phrase.
///
/// They used to be derived separately, and only the encryption path had a
/// member branch: on a drive shared with this account, a remote upload
/// encrypted with the OWNER's folder key and signed with one derived from this
/// account's master. Two keys for one file, and nothing local fails when they
/// disagree — the file uploads, and the mismatch is somebody else's problem
/// later. Pinned on the source because no hermetic test round-trips a real
/// manifest.
#[test]
fn upload_and_rename_take_both_keys_from_one_folder_phrase() {
    for (file, sig) in [
        ("/src/sync/fileops/remote_upload.rs", "async fn upload_one_file"),
        ("/src/sync/fileops/remote_rename.rs", "pub async fn rename_remote_file"),
    ] {
        let src = std::fs::read_to_string(format!("{}{file}", env!("CARGO_MANIFEST_DIR"))).unwrap_or_else(|e| panic!("read {file}: {e}"));

        assert!(
            src.contains("drive_key_material_for_label"),
            "{file} must take its keys from the one resolver that knows about member drives"
        );
        assert!(
            !src.contains("signing_key_for_folder(&mnemonic, label)"),
            "{file} must not re-derive a signing key from the master: a member drive's key is the OWNER's"
        );
        let _ = sig;
    }
}

/// `signing_key_for_folder` takes a PHRASE, never `(master, label)`.
///
/// The old signature is what made the member bug invisible: deriving the
/// phrase inside meant the call site could not pass the owner's.
#[test]
fn the_signing_key_is_derived_from_a_phrase_not_a_master() {
    let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/sync/fileops/remote_upload.rs")).expect("read remote_upload.rs");
    let body = fn_body(&src, "pub(crate) fn signing_key_for_folder");
    assert!(
        !body.contains("derive_folder_mnemonic"),
        "deriving the phrase inside means the caller cannot pass the owner's"
    );
}

/// A remote upload resolves its destination drive BEFORE the storage gate.
///
/// Storage on a drive shared with this account is paid for by its OWNER, so
/// the pre-flight has to name the drive; gating first asks about the caller's
/// own allowance instead. The refusal that produces reads as "my plan is
/// full" whoever's plan it actually was, which is why it needs pinning rather
/// than documenting.
#[test]
fn a_remote_upload_names_its_drive_before_the_storage_gate() {
    let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/sync/fileops/remote_upload.rs")).expect("read remote_upload.rs");

    for sig in [
        "pub async fn upload_files_to_remote_folder",
        "pub async fn upload_folder_to_remote_folder",
    ] {
        let body = fn_body(&src, sig);
        let resolved = body.find("upload_target_identity").unwrap_or(usize::MAX);
        let gated = body.find("require_eligible").unwrap_or(0);
        assert!(
            resolved < gated,
            "{sig} must resolve its drive before the storage gate, or the gate asks about the wrong account"
        );
        assert!(
            body.contains("require_eligible_for_drive"),
            "{sig} must name the drive it is writing into"
        );
        assert_eq!(
            body.matches("upload_target_identity").count(),
            1,
            "{sig} must resolve the drive exactly once"
        );
    }
}

/// The folder key is derived ONCE per upload, not once per file.
///
/// It used to be derived inside the per-file function. For a drive shared
/// with this account and not synced here that is an Argon2id grant open for
/// every file, seconds apiece, so a fifty-file upload spent over a minute
/// doing nothing but re-deriving the same key. Nothing fails when it
/// regresses; the upload just gets slower, which is why it is pinned.
#[test]
fn the_folder_key_is_derived_once_per_upload_not_per_file() {
    let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/sync/fileops/remote_upload.rs")).expect("read remote_upload.rs");

    let per_file = fn_body(&src, "pub(crate) async fn upload_to_remote_folder_with_progress");
    assert!(
        !per_file.contains("drive_key_material_for_label"),
        "the per-file path must take the keys, not derive them"
    );

    for sig in [
        "pub async fn upload_files_to_remote_folder",
        "pub async fn upload_folder_to_remote_folder",
    ] {
        let body = fn_body(&src, sig);
        assert_eq!(
            body.matches("drive_key_material_for_label").count(),
            1,
            "{sig} must derive the folder key exactly once"
        );
    }
}

/// An approval seals the DRIVE's key, resolved through the same funnel the
/// link mint uses. Deriving it any other way would admit the recipient to a
/// drive whose files they cannot decrypt.
///
/// The manual Approve and the automatic delivery share two helpers: one
/// resolves the keys, one seals and posts a row. Pinned here so the key rule
/// (derived key for a folder invitation, entropy for a drive) cannot fork.
#[test]
fn approve_email_invite_seals_the_drives_key() {
    let src = shared_drive_commands_src();
    let body = fn_body(&src, "pub async fn approve_email_invite(");
    assert!(body.contains("invite_seal_keys("), "approve resolves keys through the shared helper");
    assert!(body.contains("seal_invite_row("), "approve seals through the shared helper");
    assert!(
        !body.contains("derive_folder_mnemonic"),
        "never derive the drive key from the caller's master"
    );

    let keys = fn_body(&src, "pub(crate) async fn invite_seal_keys(");
    assert!(
        keys.contains("drive_key_material_for_label("),
        "the drive key must come from the key funnel"
    );
    assert!(!keys.contains("derive_folder_mnemonic"), "never derive the drive key by hand");

    let seal = fn_body(&src, "pub(crate) async fn seal_invite_row(");
    assert!(seal.contains("key_for(row.path_prefix.is_some())"), "the key follows the row's folder");
    assert!(
        seal.contains("seal_invite_key("),
        "the key is sealed to the recipient, not sent in the clear"
    );
}

fn auto_seal_src() -> String {
    std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/shared_drives/auto_seal.rs")).expect("read auto_seal.rs")
}

/// Automatic delivery is the manual Approve without the click: owner-only
/// through the same gate, the same key helpers, and it never prompts.
#[test]
fn automatic_delivery_uses_the_approve_path_and_the_owner_gate() {
    let full = auto_seal_src();
    // The module's code, without its tests (which name what they refuse).
    let src = full.split("#[cfg(test)]").next().expect("module code").to_string();
    let pass = [
        fn_body(&src, "async fn may_deliver("),
        fn_body(&src, "async fn pass("),
        fn_body(&src, "async fn seal_drive("),
    ]
    .concat();
    assert!(pass.contains("resolve_owned_target("), "only own drives are sealed for");
    assert!(pass.contains("Some(account_id.to_string())"), "the owner named is always this account");
    assert!(pass.contains("invite_seal_keys("), "keys come from the shared helper");
    assert!(pass.contains("seal_invite_row("), "rows are sealed by the shared helper");
    assert!(!pass.contains("seal_invite_key("), "no second seal path");
    assert!(!pass.contains("derive_folder_mnemonic"), "never derive the drive key by hand");
    assert!(
        pass.contains("fetch_can_share_drives("),
        "delivery follows the plan rule inviting follows"
    );
    assert!(pass.contains("recovery_lock.try_lock()"), "never waits behind a recovery or rotation");
    assert!(!pass.contains("recovery_check") && !pass.contains("unlock"), "never raises a prompt");

    let logout = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/auth/logout.rs")).expect("read logout.rs");
    let body = fn_body(&logout, "pub async fn logout_full(");
    assert!(body.contains("invite_auto_seal.stop()"), "sign-out stops delivery");
}
