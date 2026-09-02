//! Source pins for exclude-glob matching and exclude-edit sync trigger.
//!
//! Listing used to tag excluded only when a stored pattern was *exactly* the
//! relative path (`p == &rel_path`), so a user-typed `*.bin` never hid
//! `foo.bin`. add/remove_exclude_pattern wrote the rule and returned without
//! `trigger_sync`, so clearing a pattern left Drive on Pending until a manual
//! refresh. These pins fail if either regression is reintroduced.

/// Extract the brace-matched body of the function whose signature contains
/// `sig` — more precise than a whole-file substring match, which would pass
/// if the call lived in an unrelated helper.
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

fn read_src(rel: &str) -> String {
    std::fs::read_to_string(format!("{}/src/{rel}", env!("CARGO_MANIFEST_DIR"))).unwrap_or_else(|e| panic!("read {rel}: {e}"))
}

/// listing.rs and user_files.rs must route exclusion through the shared
/// ExcludeRules wrapper, never exact path equality.
#[test]
fn listing_and_user_files_use_the_exclude_rules_matcher() {
    let listing = read_src("sync/fileops/files/listing.rs");
    let listing_body = fn_body(&listing, "async fn list_sync_folder_inner_with(");

    assert!(
        listing_body.contains("path_is_excluded") || listing_body.contains("exclude_match"),
        "list_sync_folder_inner_with must tag excluded via the shared ExcludeRules matcher"
    );
    assert!(
        !listing_body.contains("p == &relative_path"),
        "list_sync_folder_inner_with must not compare exclude patterns by exact path equality"
    );

    let user_files = read_src("sync/fileops/files/user_files.rs");
    let walk_body = fn_body(&user_files, "fn walk_disk_files_std(");

    assert!(
        walk_body.contains("path_is_excluded") || walk_body.contains("exclude_match"),
        "walk_disk_files_std must tag excluded via the shared ExcludeRules matcher"
    );
    assert!(
        !walk_body.contains("p == &rel_path"),
        "walk_disk_files_std must not compare exclude patterns by exact path equality"
    );
}

/// A folder row's totals must be walked under the drive's patterns, against
/// the DRIVE root (`base`) — the listing tags rows with drive-relative paths,
/// so relativizing against the walked subfolder would stop matching any
/// pattern that names a folder. And an already-excluded folder must not be
/// walked at all: every consumer drops the row, so the walk is a full
/// traversal of the tree the rule exists to keep out. Neither is reachable
/// from a unit test — `list_sync_folder_inner_with` needs an `AppState`.
#[test]
fn folder_totals_are_walked_under_the_drive_patterns_and_skip_excluded_folders() {
    let listing = read_src("sync/fileops/files/listing.rs");
    let body = fn_body(&listing, "async fn list_sync_folder_inner_with(");

    assert!(
        body.contains("DirStatsExcludes"),
        "folder rows must pass the drive's exclude patterns into the stats walk, or the row counts files the view hides"
    );
    assert!(
        body.contains("root: &base"),
        "the stats walk must relativize against the DRIVE root, not the walked subfolder"
    );
    assert!(
        body.contains("} else if is_excluded {"),
        "an excluded folder must skip the stats walk — every consumer drops the row"
    );
}

/// add/remove_exclude_pattern must kick a sync the same way apply_sync_selection
/// does, or Drive stays Pending after the user clears a pattern.
#[test]
fn add_and_remove_exclude_pattern_trigger_sync() {
    let src = read_src("sync/drive/selective.rs");
    let helper = fn_body(&src, "async fn trigger_sync_after_exclude_edit(");
    assert!(helper.contains("trigger_sync"), "trigger_sync_after_exclude_edit must call trigger_sync");
    assert!(
        helper.contains("ACTIVITY_UPDATED"),
        "trigger_sync_after_exclude_edit must emit the listing-refresh event useSyncEvents already folds"
    );

    for sig in ["pub async fn add_exclude_pattern(", "pub async fn remove_exclude_pattern("] {
        let body = fn_body(&src, sig);
        assert!(
            body.contains("trigger_sync"),
            "{sig}..) must contain trigger_sync (directly or via trigger_sync_after_exclude_edit)"
        );
    }
}

/// Recent-files must drop activity rows through the same matcher, not by
/// deleting history.
#[test]
fn recent_files_filter_uses_the_same_matcher() {
    let src = read_src("sync/fileops/files/recent.rs");
    let body = fn_body(&src, "pub async fn get_recent_files(");

    assert!(
        body.contains("recent_rel_path_is_excluded") || body.contains("path_is_excluded"),
        "get_recent_files must drop excluded rel-paths via the shared ExcludeRules matcher"
    );
    assert!(
        !body.contains("DELETE FROM") && !body.contains("clear_sync_activity"),
        "get_recent_files must filter the feed, not delete activity history"
    );
}

/// The Files-page storage total must be derived from the same per-label stats
/// the rows are counted into, not summed separately over the raw listing.
/// Summed separately it counted "excluded" rows the page hides, so the
/// headline storage figure disagreed with the list under it — and no unit test
/// can catch that, because `get_user_files` is a Tauri command.
#[test]
fn storage_total_is_derived_from_the_counted_label_stats() {
    let src = read_src("sync/fileops/files/user_files.rs");
    let body = fn_body(&src, "pub async fn get_user_files(");

    assert!(
        !body.contains("entries.iter().map(|e| e.size).sum"),
        "total_private_size must not be summed over the unfiltered listing — excluded rows would inflate it"
    );
    assert!(
        body.contains("label_stats.values().map(|s| s.total_bytes).sum"),
        "total_private_size must be derived from label_stats, which already drops excluded rows"
    );
}

/// A pattern the engine cannot compile is stored, listed back as active, and
/// excludes nothing. `validate_pattern` must refuse it up front so the failure
/// is an error next to the input box, not a line in a log file.
#[test]
fn validate_pattern_refuses_globs_the_engine_cannot_compile() {
    let src = read_src("sync/drive/selective.rs");
    let body = fn_body(&src, "fn validate_pattern(");

    assert!(
        body.contains("compile_like_the_engine"),
        "validate_pattern must reject a pattern that fails to compile as a glob"
    );

    let compile = fn_body(&src, "fn compile_like_the_engine(");
    assert!(
        compile.contains("**/"),
        "the check must mirror ExcludeRules::parse's `**/` expansion, or the two parsers can disagree"
    );
}

/// Do not resurrect silent default exclude patterns — everything a user puts
/// in a drive must sync unless they say otherwise.
#[test]
fn default_exclude_patterns_stay_gone() {
    let selective = read_src("sync/drive/selective.rs");
    assert!(
        !selective.contains("DEFAULT_EXCLUDE_PATTERNS"),
        "do not resurrect DEFAULT_EXCLUDE_PATTERNS"
    );
}

/// The folder browser hands over FILE PATHS the user unticked, not globs. A
/// path written verbatim is compiled as a glob, so `Photos [2024]/IMG [1].jpg`
/// never matched itself. The IPC must delegate to the unit-tested helper,
/// and the helper must escape on the way in and remove the same line on the
/// way out.
#[test]
fn apply_sync_selection_writes_picked_paths_literally() {
    let src = read_src("sync/drive/selective.rs");
    let ipc = fn_body(&src, "pub async fn apply_sync_selection(");
    assert!(
        ipc.contains("apply_selection_on_manager("),
        "the IPC must delegate to the helper the tests cover"
    );

    let helper = fn_body(&src, "fn apply_selection_on_manager(");
    assert!(
        helper.contains("literal_pattern("),
        "an unticked path must be escaped before it is written"
    );
    assert!(
        helper.contains("remove_literal_exclusion("),
        "a re-ticked path must remove the escaped line"
    );
    assert!(!helper.contains("add_exclude_pattern(&trimmed)"), "no raw path may be written as a glob");
}
