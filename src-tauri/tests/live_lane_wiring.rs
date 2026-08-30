//! Static pin: every `*_real_backend.rs` suite must be a step in `e2e-live.yml`.
//!
//! The live files are `#[ignore]`d so a plain `cargo test` stays hermetic. That
//! also means they run only when `e2e-live.yml` names them. A new live file that
//! is not a `cargo test --test <stem>` line in the workflow is a silent skip —
//! the exact failure the lane exists to prevent. Same pattern as
//! `tests/keep_awake_wiring.rs`.

use std::fs;
use std::path::PathBuf;

fn workflow_src() -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.github/workflows/e2e-live.yml");
    fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()))
}

fn tests_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests")
}

/// Every live suite must appear as `cargo test --test <stem>` in the workflow
/// so `suite=both` / `suite=all` cannot drop a file by omission.
#[test]
fn every_real_backend_suite_is_dispatched_by_e2e_live() {
    let wf = workflow_src();
    let mut missing = Vec::new();

    let entries = fs::read_dir(tests_dir()).expect("read src-tauri/tests");
    for entry in entries {
        let entry = entry.expect("dirent");
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Some(stem) = name.strip_suffix(".rs") else {
            continue;
        };
        if !stem.ends_with("_real_backend") {
            continue;
        }
        let needle = format!("cargo test --test {stem}");
        if !wf.contains(&needle) {
            missing.push(stem.to_string());
        }
    }

    assert!(
        missing.is_empty(),
        "e2e-live.yml must `cargo test --test` each *_real_backend.rs; missing: {missing:?}"
    );
}

/// REQUIRE=1 is what turns a quiet env-skip into a panic. Without it a
/// mistyped secret produces a green job that asserted nothing.
#[test]
fn live_workflow_sets_require_exactly_one() {
    let wf = workflow_src();
    assert!(
        wf.contains("HCFS_DESKTOP_E2E_REQUIRE: \"1\""),
        "e2e-live.yml must set HCFS_DESKTOP_E2E_REQUIRE to the exact string 1"
    );
}

/// Live-lane credentials belong in GitHub secrets, never in this public tree.
/// A placeholder (`<admin-bypass>`) or `${{ secrets.NAME }}` is fine; a
/// literal token or ss58 in a `HCFS_DESKTOP_E2E_*` assignment is not.
#[test]
fn live_lane_credentials_are_not_committed() {
    let mut leaks = Vec::new();
    scan_file_for_literal_credentials(&workflow_src(), ".github/workflows/e2e-live.yml", &mut leaks);

    let entries = fs::read_dir(tests_dir()).expect("read src-tauri/tests");
    for entry in entries {
        let entry = entry.expect("dirent");
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("rs") {
            continue;
        }
        let src = fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        let label = format!("src-tauri/tests/{}", path.file_name().unwrap().to_string_lossy());
        scan_file_for_literal_credentials(&src, &label, &mut leaks);
    }

    assert!(
        leaks.is_empty(),
        "live-lane credentials must not be committed in this public repo: {leaks:?}"
    );
}

fn scan_file_for_literal_credentials(src: &str, label: &str, leaks: &mut Vec<String>) {
    // Bearer / identity env vars only. SERVER_URL may name a public host.
    const NAMES: &[&str] = &[
        "HCFS_DESKTOP_E2E_ADMIN_BEARER",
        "HCFS_DESKTOP_E2E_BEARER_OWNER",
        "HCFS_DESKTOP_E2E_BEARER_MEMBER",
        "HCFS_DESKTOP_E2E_BEARER",
        "HCFS_DESKTOP_E2E_OWNER_SS58",
        "HCFS_DESKTOP_E2E_MEMBER_SS58",
        "HCFS_DESKTOP_E2E_SS58",
        "HCFS_E2E_STUB_USER_TOKEN",
        "HCFS_E2E_STUB_USER_SS58",
    ];

    for (i, line) in src.lines().enumerate() {
        let stripped = line.trim().trim_start_matches(['/', '#', '!', '*', ' ']);
        for name in NAMES {
            let Some(rest) = stripped.strip_prefix(name) else {
                continue;
            };
            let rest = rest.trim_start();
            let Some(rest) = rest.strip_prefix('=').or_else(|| rest.strip_prefix(':')) else {
                continue;
            };
            let value = rest.trim().trim_end_matches('\\').trim().trim_matches('"').trim_matches('\'');
            if value.is_empty() || is_credential_placeholder(value) {
                continue;
            }
            leaks.push(format!("{label}:{} {name} has a literal value", i + 1));
        }
    }
}

fn is_credential_placeholder(value: &str) -> bool {
    value.starts_with('<') || value.starts_with("${{") || value.starts_with("${") || value.starts_with('$') || value.contains("secrets.")
}
