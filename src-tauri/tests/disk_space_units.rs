//! Static regression guard for the migration disk-space check's unit choice.
//!
//! `sync::migrate::migration::check_disk_space` calls `statvfs(2)` and
//! multiplies a block count by a block size. POSIX counts `f_bavail` in units
//! of `f_frsize` (fragment size), NOT `f_bsize` (preferred I/O transfer
//! size). The two differ on many filesystems — bsize 64 KiB–1 MiB against
//! frsize 4 KiB is common — so reading `f_bsize` overstates free space by
//! that ratio, letting a too-small disk pass the gate and then run out
//! mid-download. That bug shipped once already and was fixed deliberately;
//! the fix survived a later typed-error refactor and the `nix` → `libc` FFI
//! rewrite.
//!
//! Why a SOURCE pin rather than a behavioural test: the live call can only be
//! asked about the test runner's own disk, and both end-to-end assertions
//! (1 byte fits, `u64::MAX` does not) hold under EITHER field — verified by
//! mutation, swapping `f_frsize` for `f_bsize` leaves the entire suite green.
//! The arithmetic and boundary are pinned by the `has_enough_space` unit
//! tests; what only a source pin can see is which FIELD reaches it.
//!
//! Same approach as `tests/scan_log_throttle_wiring.rs` and
//! `tests/keep_awake_wiring.rs`.

/// Extract the brace-matched body of the function whose signature contains
/// `sig` — more precise than a whole-file substring match, which would pass
/// if the read lived in an unrelated helper.
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

fn migration_src() -> String {
    std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/sync/migrate/migration.rs")).expect("read migration.rs")
}

const CHECK_DISK_SPACE_SIG: &str = "fn check_disk_space(path: &std::path::Path, required_bytes: u64)";

#[test]
fn disk_space_check_reads_the_fragment_size_field() {
    let src = migration_src();
    let body = fn_body(&src, CHECK_DISK_SPACE_SIG);

    assert!(
        body.contains("stat.f_frsize"),
        "check_disk_space must size blocks with f_frsize (fragment size); \
         f_bavail is counted in those units"
    );
}

#[test]
fn disk_space_check_never_reads_the_io_block_size_field() {
    let src = migration_src();
    let body = fn_body(&src, CHECK_DISK_SPACE_SIG);

    // Matches the field ACCESS, not the explanatory comment above it, which
    // names f_bsize precisely to say it must not be used.
    assert!(
        !body.contains("stat.f_bsize"),
        "check_disk_space must NOT size blocks with f_bsize (preferred I/O \
         transfer size) — it overstates free space wherever bsize > frsize, \
         which is the shipped bug this guard exists to prevent"
    );
}
