//! Static regression guards for the upload-chunk reclaim wiring.
//!
//! The reclaim policy itself (the pure plan, the filesystem scan, the
//! remove-drive wipe) is pinned by the unit tests in
//! `src/sync/shared/chunk_reclaim.rs`. What those cannot see is whether
//! anything still CALLS it — a refactor of the init funnel could drop the hook
//! and every unit test would stay green while users' disks refill with
//! abandoned encrypted chunks, which is the exact bug this feature exists to
//! end. Same pattern as `tests/keep_awake_wiring.rs`.
//!
//! The ORDERING assertion below is the load-bearing one. The reclaim's budget
//! rule may delete a still-resumable staging directory, which is only safe
//! because it runs once, before any drive has started uploading. If it were
//! ever moved after drive registration, or made to run per-init, it could
//! delete the chunks an in-flight upload is streaming.

/// Extract the brace-matched body of the function whose signature contains
/// `sig` — more precise than a whole-file substring match, which would pass if
/// the call lived in an unrelated helper.
fn fn_body<'a>(src: &'a str, sig: &str) -> &'a str {
    let sig_idx = src.find(sig).unwrap_or_else(|| panic!("`{sig}` declaration present"));
    let body_start = src[sig_idx..].find('{').expect("fn body opens") + sig_idx;
    let mut depth = 0usize;
    for (i, ch) in src[body_start..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return &src[body_start..=body_start + i];
                }
            }
            _ => {}
        }
    }
    panic!("`{sig}` body never closes");
}

fn lifecycle_src() -> String {
    std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/sync/drive/lifecycle.rs")).expect("read lifecycle.rs")
}

/// `initialize_sync_inner` is the single funnel every init path goes through,
/// so it is the only place a once-per-process reclaim can sit and still be
/// guaranteed to run for every user who syncs anything.
#[test]
fn init_funnel_runs_the_startup_reclaim() {
    let src = lifecycle_src();
    let body = fn_body(&src, "pub(crate) async fn initialize_sync_inner(");
    assert!(
        body.contains("chunk_reclaim") && body.contains("reclaim_startup"),
        "initialize_sync_inner must run the abandoned-chunk reclaim, or stranded \
         encrypted chunks are never freed on launch",
    );
}

/// The reclaim must be latched through the `OnceCell` rather than called
/// directly. A bare call would re-run on every drive init — including one that
/// happens while another drive is mid-upload, where the budget rule could evict
/// the staging directory that upload is actively reading from.
#[test]
fn the_reclaim_is_latched_once_per_process_not_run_per_init() {
    let src = lifecycle_src();
    let body = fn_body(&src, "pub(crate) async fn initialize_sync_inner(");
    assert!(
        body.contains("get_or_init"),
        "the reclaim must go through AppState.chunk_reclaim's OnceCell: running it \
         per-init could delete chunks an in-flight upload on another drive is streaming",
    );
}

/// The reclaim must precede the epoch/registration work that leads to a drive
/// actually syncing. Pinned positionally because "runs first" is the property
/// that makes deleting resumable directories safe at all.
#[test]
fn the_reclaim_runs_before_the_drive_is_registered() {
    let src = lifecycle_src();
    let body = fn_body(&src, "pub(crate) async fn initialize_sync_inner(");

    let reclaim_at = body.find("reclaim_startup").expect("reclaim call present");
    // `.expect` rather than `if let`: an optional anchor makes the whole
    // assertion vacuous the moment the marker is renamed, which is exactly when
    // an ordering regression would slip through.
    let register_at = body.find("register_drive(").expect("initialize_sync_inner registers the drive");

    assert!(
        reclaim_at < register_at,
        "the reclaim must complete BEFORE the drive is registered with the runner, \
         otherwise it can race an upload that has already started",
    );
}

/// The init funnel skips paused drives (`auto_init_sync` filters on
/// `is_paused`), so it cannot be the only trigger: a user who reacted to a full
/// disk by pausing every drive would reclaim nothing on the launch that matters
/// most. `setup()` runs unconditionally and covers that.
#[test]
fn launch_runs_the_reclaim_even_with_no_active_drives() {
    let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/main.rs")).expect("read main.rs");
    let body = fn_body(&src, "builder.setup(");

    assert!(
        body.contains("chunk_reclaim") && body.contains("reclaim_startup"),
        "setup() must trigger the reclaim, or paused/removed-drive users never reclaim anything",
    );
    assert!(
        body.contains("get_or_init"),
        "the setup trigger must share the OnceCell with the init funnel so the pass runs once",
    );
}

/// A removed drive's staged chunks are unreachable by every other code path —
/// no cycle will resume them and no `sync_paths` row points at them. Leaving
/// them to the age rule means a user who removes a drive to free disk does not
/// actually free it.
#[test]
fn remove_drive_clears_the_drives_staged_chunks() {
    let src = lifecycle_src();
    assert!(
        src.contains("clear_staged_upload_chunks"),
        "remove_drive must drop the drive's staging area alongside its sync baseline",
    );

    let baseline_at = src.find("clear_persisted_sync_state(acct, &label)").expect("baseline wipe present");
    let chunks_at = src.find("clear_staged_upload_chunks").expect("chunk wipe present");
    assert!(
        chunks_at > baseline_at,
        "the chunk wipe belongs in the same remove_drive teardown block as the baseline wipe",
    );
}
