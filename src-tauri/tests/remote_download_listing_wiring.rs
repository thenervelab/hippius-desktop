//! Wiring pins for how one-off downloads find the row they verify against.
//!
//! hcfs's plain `download_remote_file` pages the drive's WHOLE listing to
//! find the file's row, once per call. A screen of thumbnails, or a recovery
//! of thousands of files, paid that for every file. The cache itself is
//! unit-tested in `sync::listing_cache` (N lookups, one listing); these pins
//! keep every caller on it. The callers need a live session and server, so
//! they are pinned by source inspection.

fn src(rel: &str) -> String {
    std::fs::read_to_string(format!("{}/{rel}", env!("CARGO_MANIFEST_DIR"))).unwrap_or_else(|e| panic!("read {rel}: {e}"))
}

/// Extract the brace-matched `{ ... }` body of the first fn whose declaration
/// contains `sig`.
fn fn_body<'a>(src: &'a str, sig: &str) -> &'a str {
    let sig_idx = src.find(sig).unwrap_or_else(|| panic!("{sig} declaration present"));
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
    panic!("{sig} body never closes")
}

/// Recovery already holds the rows it just listed; downloading each file
/// through the plain call paged the folder's listing again per file.
#[test]
fn recovery_verifies_against_the_rows_it_listed() {
    for rel in ["src/recovery_binding.rs", "src/recovery.rs"] {
        let source = src(rel);
        assert!(
            !source.contains("download_remote_file("),
            "{rel} must not call the listing-per-download download_remote_file"
        );
        assert!(
            source.contains("download_remote_file_expecting("),
            "{rel} must download against its listed rows"
        );
        assert!(
            source.contains("ExpectedContent::from_info("),
            "{rel} must build the expectation from the listed row"
        );
    }
}

/// Thumbnails, previews and the Download button all go through the cached
/// listing. One stray plain call brings the per-file listing back.
#[test]
fn one_off_downloads_use_the_cached_listing() {
    let remote = src("src/sync/fileops/remote.rs");
    assert!(
        !remote.contains("hcfs_client::drive::remote::download_remote_file("),
        "remote.rs must not call hcfs's listing-per-download download_remote_file"
    );
    for sig in [
        "pub async fn download_remote_file(",
        "pub async fn cache_remote_file(",
        "pub async fn download_cloud_file_to(",
    ] {
        assert!(
            fn_body(&remote, sig).contains("download_with_cached_listing("),
            "{sig} must download through the cached listing"
        );
    }
}

/// A completed sync may change a drive's rows, and a new account must not
/// read the previous one's listings.
#[test]
fn the_cache_is_invalidated_on_sync_completion_and_reset() {
    let bridge = src("src/sync/projection/tauri_bridge.rs");
    assert!(fn_body(&bridge, "fn handle_sync_completed(").contains("remote_listing_cache.invalidate("));
    assert!(fn_body(&bridge, "fn handle_sync_reset(").contains("remote_listing_cache.clear_all()"));
}
