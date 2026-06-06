//! Static regression guard for cross-account authority.
//!
//! Every token-backed, account-scoped `#[tauri::command]` must validate the
//! frontend-supplied `account_id` against the authenticated session via
//! `state.require_session_account(&account_id)?` before using it to fetch a
//! per-account bearer token. The audit on 2026-06-05 found this was applied by
//! hand per command, and a whole subsystem (VM / support / SSH / billing) was
//! missed because the guard has no framework chokepoint.
//!
//! This test IS the chokepoint: it scans the command source for any command
//! that (a) takes an `account_id` parameter and (b) builds a token-backed
//! client (`ApiClient` / `get_api_token` / `get_auth_token_for_account`), and
//! fails if that command does not call `require_session_account`. A new command
//! that forgets the guard fails CI here instead of shipping a cross-account
//! hole. Commands that are intentionally public (indexer reads keyed by a
//! global API key over already-public chain data, where the FE may pass a
//! non-session wallet) are listed in `ALLOWLIST` with that rationale.
//!
//! Known limitation: the token-backed heuristic keys off three call shapes; a
//! command that obtains a bearer token through a differently-named helper would
//! not be detected. Extend `token_backed` if a new token path is introduced.

use std::collections::HashSet;
use std::path::Path;

/// Source files that expose account-scoped IPC commands.
const COMMAND_FILES: &[&str] = &[
    "src/infra/vm.rs",
    "src/utils/support.rs",
    "src/auth/ssh_keys.rs",
    "src/billing/credits.rs",
    "src/billing/subscriptions.rs",
    "src/billing/queries.rs",
    "src/notifications/settings.rs",
];

/// Commands intentionally NOT guarded, each a documented exception: public
/// on-chain / indexer reads keyed by a global indexer API key (not a
/// per-account bearer token), where `account_id` is a filter over data that is
/// already public on-chain and the FE legitimately passes the header-selected
/// `activeWallet` rather than the session account.
// NOTE: get_billing_transactions is intentionally NOT here — it uses ApiClient
// (a per-account bearer token), so it is genuinely token-backed and is now
// guarded via `account_id: SessionAccount`. The fully-typed ApiClient signature
// caught that it had been mis-allowlisted as an indexer read.
const ALLOWLIST: &[&str] = &[
    "get_credits",
    "get_marketplace_credits",
    "get_drive_storage_stats",
    "get_system_balance",
    "get_balance_transfers",
    "get_add_credit_events",
];

/// A command builds a per-account bearer-token client if its body references
/// any of the three token-acquisition shapes used in this codebase.
fn token_backed(body: &str) -> bool {
    body.contains("ApiClient::new") || body.contains("get_api_token") || body.contains("get_auth_token_for_account")
}

/// Extract the function name from a `pub async fn NAME(` chunk.
fn command_fn_name(chunk: &str) -> Option<String> {
    let start = chunk.find("pub async fn ")? + "pub async fn ".len();
    let rest = &chunk[start..];
    let end = rest.find('(')?;
    Some(rest[..end].trim().to_string())
}

#[test]
fn token_backed_account_commands_validate_session() {
    let root = env!("CARGO_MANIFEST_DIR");
    let allow: HashSet<&str> = ALLOWLIST.iter().copied().collect();
    let mut offenders = Vec::new();
    let mut checked = 0usize;

    for rel in COMMAND_FILES {
        let path = Path::new(root).join(rel);
        let src = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {rel}: {e}"));

        // Splitting on the command attribute yields one chunk per command
        // (signature + body, up to the next command). chunk[0] is the
        // pre-first-command preamble, skipped.
        for chunk in src.split("#[tauri::command]").skip(1) {
            let Some(name) = command_fn_name(chunk) else { continue };
            let takes_account = chunk.contains("account_id:");
            if !takes_account || !token_backed(chunk) || allow.contains(name.as_str()) {
                continue;
            }
            checked += 1;
            // A token-backed command is guarded if it either takes the validated
            // `SessionAccount` extractor type (preferred — the compiler enforces
            // it) or calls `require_session_account` in its body. A raw
            // `account_id: String` with neither is the cross-account hole.
            let guarded = chunk.contains("SessionAccount") || chunk.contains("require_session_account");
            if !guarded {
                offenders.push(format!("{rel}::{name}"));
            }
        }
    }

    // Guard against the heuristic silently matching nothing (e.g. a refactor
    // renames ApiClient) and giving false confidence.
    assert!(checked >= 20, "expected to check >=20 token-backed commands, only saw {checked} — the detector may be broken");
    assert!(
        offenders.is_empty(),
        "these token-backed account-scoped #[tauri::command]s neither take a \
         validated `account_id: SessionAccount` nor call \
         `state.require_session_account(&account_id)?` — use `SessionAccount` \
         (preferred) or add the guard, or if the command is intentionally public \
         add it to ALLOWLIST with a rationale:\n  {}",
        offenders.join("\n  ")
    );
}
