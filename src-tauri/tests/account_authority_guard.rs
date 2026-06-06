//! Static regression guard for cross-account authority.
//!
//! Every account-scoped `#[tauri::command]` that uses a frontend-supplied
//! `account_id` to reach that account's secrets (a per-account bearer token, or
//! its on-disk master mnemonic / S3 credentials) MUST validate it against the
//! authenticated session — by taking `account_id: SessionAccount` (preferred,
//! compiler-enforced) or calling `state.require_session_account(&account_id)?`.
//! The 2026-06-05 audit found this was applied by hand per command, so the guard
//! has no framework chokepoint and omissions were invisible.
//!
//! This test IS the chokepoint. It walks EVERY `.rs` file under `src/` (not a
//! hardcoded list — an earlier hardcoded `COMMAND_FILES` missed
//! `sync/lifecycle.rs`, `auth/billing_auth.rs`, `sync/migration.rs`, etc. and
//! gave false confidence), finds each `#[tauri::command]` that takes an
//! `account_id` and touches an account-secret API, and fails if it is not
//! guarded. A new command that forgets the guard fails CI here.
//!
//! Known limitation: the secret-access heuristic keys off named call shapes; a
//! command that reaches a per-account secret through a differently-named helper
//! would not be detected. Extend [`touches_account_secret`] if a new one is
//! introduced.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// Commands intentionally NOT guarded, each a documented exception: public
/// on-chain / indexer reads keyed by a global indexer API key (not a
/// per-account bearer token), where `account_id` is a filter over data that is
/// already public on-chain and the FE legitimately passes the header-selected
/// `activeWallet` rather than the session account.
const ALLOWLIST: &[&str] = &[
    "get_credits",
    "get_marketplace_credits",
    "get_drive_storage_stats",
    "get_system_balance",
    "get_balance_transfers",
    "get_add_credit_events",
];

/// A command reaches a per-account SECRET if its body references a known
/// account-keyed accessor: a Hippius API bearer token (`ApiClient` /
/// `get_api_token` / `get_auth_token_for_account` / `build_client`, the last
/// constructing an HcfsClient via get_api_token), the decrypted master mnemonic
/// (`get_mnemonic_for_account`), or S3 creds (`fetch_s3_credentials`).
///
/// This is the high-severity surface (token/mnemonic/credential exfiltration).
/// It intentionally does NOT flag commands that merely scope a DB query by
/// `account_id` (config/paths/folder-stat reads) — a broader cross-account-read
/// surface tracked separately — nor thin wrappers that delegate the secret call
/// to an `_inner` helper (e.g. initialize_sync/auto_init_sync); those are
/// guarded directly and noted in the module docs.
fn touches_account_secret(body: &str) -> bool {
    [
        "ApiClient::new",
        "get_api_token",
        "get_auth_token_for_account",
        "get_mnemonic_for_account",
        "fetch_s3_credentials",
        "build_client",
    ]
    .iter()
    .any(|needle| body.contains(needle))
}

/// From a post-`#[tauri::command]` chunk, extract (name, signature, body) for
/// the command function, where `body` is precisely the fn's braced block (via
/// brace matching). This keeps helper fns/structs that sit between this command
/// and the next out of the analysis — a coarse "split to next command" bled
/// trailing code in and produced false positives (e.g. create_encrypted_backup,
/// which takes no account_id). Brace counting is byte-based; `format!` braces
/// are balanced so they net out, and command bodies don't contain lone brace
/// char literals.
fn extract_command(chunk: &str) -> Option<(String, &str, &str)> {
    let fn_pos = chunk.find("pub async fn ")?;
    let name_start = fn_pos + "pub async fn ".len();
    let name_end = name_start + chunk[name_start..].find('(')?;
    let name = chunk[name_start..name_end].trim().to_string();
    let body_open = fn_pos + chunk[fn_pos..].find('{')?;
    let signature = &chunk[fn_pos..body_open];
    let mut depth = 0usize;
    let mut end = body_open;
    for (idx, b) in chunk[body_open..].bytes().enumerate() {
        match b {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    end = body_open + idx + 1;
                    break;
                }
            }
            _ => {}
        }
    }
    Some((name, signature, &chunk[body_open..end]))
}

/// Recursively collect every `.rs` file under `dir` as (relative-path, source).
fn collect_rs(dir: &Path, root: &Path, out: &mut Vec<(String, String)>) {
    for entry in std::fs::read_dir(dir).unwrap_or_else(|e| panic!("read_dir {}: {e}", dir.display())) {
        let path = entry.expect("dir entry").path();
        if path.is_dir() {
            collect_rs(&path, root, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
            let rel = path.strip_prefix(root).unwrap_or(&path).display().to_string();
            let src = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {rel}: {e}"));
            out.push((rel, src));
        }
    }
}

#[test]
fn account_secret_commands_validate_session() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let allow: HashSet<&str> = ALLOWLIST.iter().copied().collect();
    let mut files = Vec::new();
    collect_rs(&root.join("src"), &root, &mut files);

    let mut offenders = Vec::new();
    let mut checked = 0usize;

    for (rel, src) in &files {
        // Splitting on the command attribute yields one chunk per command
        // (signature + body, up to the next command). chunk[0] is the
        // pre-first-command preamble, skipped.
        for chunk in src.split("#[tauri::command]").skip(1) {
            let Some((name, signature, body)) = extract_command(chunk) else { continue };
            let takes_account = signature.contains("account_id:");
            if !takes_account || !touches_account_secret(body) || allow.contains(name.as_str()) {
                continue;
            }
            checked += 1;
            // Guarded if it takes the validated `SessionAccount` extractor type
            // (signature, compiler-enforced) or calls `require_session_account`
            // (body). A raw `account_id: String` with neither is the hole.
            let guarded = signature.contains("SessionAccount") || body.contains("require_session_account");
            if !guarded {
                offenders.push(format!("{rel}::{name}"));
            }
        }
    }

    // Guard against the heuristic silently matching nothing (e.g. a refactor
    // renames every accessor) and giving false confidence.
    assert!(checked >= 25, "expected to check >=25 account-secret commands, only saw {checked} — the detector may be broken");
    assert!(
        offenders.is_empty(),
        "these account-scoped #[tauri::command]s reach a per-account secret with a \
         frontend-supplied account_id but neither take `account_id: SessionAccount` \
         nor call `state.require_session_account(&account_id)?` — add the guard, or \
         if intentionally public add to ALLOWLIST with a rationale:\n  {}",
        offenders.join("\n  ")
    );
}
