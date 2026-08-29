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
