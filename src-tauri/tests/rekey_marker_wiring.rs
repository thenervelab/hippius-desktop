//! Source pins for the rekey marker's "nobody deletes this" contract.
//!
//! The unit test `reporting_the_marker_does_not_delete_it` pins the extracted
//! helper, but the delete that shipped was at the CALL SITE in `register_drive`
//! — and a second one survived in `recover_drive` for a year after the purge it
//! belonged to was removed. A helper-level test passes with either of those
//! reinstated one line away from the call, so the guard has to be a scan for
//! the pattern rather than a test of the function.

use std::path::PathBuf;

fn src(relative: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src").join(relative);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

/// Every file that names the marker at all. A new one must be added here
/// consciously, which is the point.
const FILES_THAT_NAME_THE_MARKER: &[&str] = &["sync/shared/mnemonic.rs", "sync/drive/lifecycle.rs", "sync/fileops/folders.rs"];

/// The ONLY sanctioned removal of a rekey marker: `clear_rekey_marker`, called
/// after a successful server-side folder delete has taken the stranded remote
/// revisions with it.
#[test]
fn only_clear_rekey_marker_removes_the_marker() {
    for file in FILES_THAT_NAME_THE_MARKER {
        let source = src(file);
        let mut current_fn = String::new();

        for (idx, raw) in source.lines().enumerate() {
            let line = raw.trim();
            // Comments first: a doc comment that names a function must not be
            // mistaken for that function's declaration.
            if line.starts_with("//") {
                continue;
            }
            if let Some(name) = fn_name_declared_on(line) {
                current_fn = name;
            }
            let touches_marker = line.contains("REKEY_MARKER") || line.contains(".needs_rekey");
            let removes = line.contains("remove_file") || line.contains("remove_dir_all");
            if !touches_marker || !removes {
                continue;
            }
            assert_eq!(
                current_fn,
                "clear_rekey_marker",
                "{file}:{} removes the rekey marker from `{current_fn}`:\n  {line}\n\
                 The marker is a standing diagnosis, not a one-shot flag — deleting it erases \
                 the only record of why a drive's remote files became undecryptable. If this \
                 site genuinely retires the condition (it deleted the remote revisions), call \
                 `clear_rekey_marker` and say why.",
                idx + 1,
            );
        }
    }
}

/// `recover_drive` re-derives the folder key and, without a login mnemonic,
/// mints a brand-new ACCOUNT master — the single most destructive rekey in the
/// app. It must RECORD that, not clean up after it.
#[test]
fn recovery_records_a_rekey_instead_of_clearing_one() {
    let source = src("sync/drive/lifecycle.rs");
    let body = fn_body(&source, "async fn recover_drive(");

    assert!(
        body.contains("append_rekey_record"),
        "`recover_drive` must append a RekeyRecord: generating a new random master strands \
         every remote file on the account, and a log line alone rotates away."
    );
    assert!(
        body.contains("RecoveryGeneratedNewMaster"),
        "the recovery rekey needs its own reason variant so triage can tell it from the two \
         legacy seal states."
    );
    assert!(
        !body.contains("remove_file(ctx.folder_dir.join(\".needs_rekey\"))"),
        "`recover_drive` must not delete the rekey marker — it runs BEFORE `register_drive` \
         reports it, so the delete erased the diagnosis one step ahead of the code that logs it."
    );
}

/// The registration path reports and returns; a delete beside the call is the
/// exact regression that shipped.
#[test]
fn register_drive_reports_the_marker_without_consuming_it() {
    let source = src("sync/drive/lifecycle.rs");
    let body = fn_body(&source, "async fn register_drive(");

    assert!(
        body.contains("report_rekey_marker"),
        "`register_drive` must report the marker on every registration"
    );
    assert!(
        !body.contains("remove_file"),
        "`register_drive` must not remove anything — it used to 'consume' the marker here, \
         which is the bug this pin exists for."
    );
}

/// The name of the function a line declares, if it declares one.
fn fn_name_declared_on(line: &str) -> Option<String> {
    let after_fn = line.split_once("fn ")?.1;
    let name: String = after_fn.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
    if name.is_empty() {
        return None;
    }
    Some(name)
}

/// Extract a function body by brace matching from its signature.
fn fn_body<'a>(source: &'a str, signature: &str) -> &'a str {
    let sig_idx = source.find(signature).unwrap_or_else(|| panic!("{signature} present"));
    let start = source[sig_idx..].find('{').expect("fn body opens") + sig_idx;

    let mut depth = 0usize;
    for (i, ch) in source[start..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return &source[start..start + i];
                }
            }
            _ => {}
        }
    }
    panic!("{signature} body never closes");
}
