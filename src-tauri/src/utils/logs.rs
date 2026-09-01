//! Bundling of recent application logs for support tickets.
//!
//! When a user opts in while filing a support ticket, the desktop collects the
//! most recent rolling log files (written under `$HOME/.hippius/logs/` by the
//! file appender wired up in `main::init_logging`), scrubs them, zips them, and
//! uploads the archive as a ticket attachment — so support staff get info-rich
//! diagnostics without a back-and-forth. The whole flow is best-effort: a
//! missing logs directory or a failed upload must never block ticket creation
//! (see `attach_logs_to_ticket`).
//!
//! Scrubbing has two layers: **secret redaction** (mnemonics, API tokens, JWTs,
//! PEM private keys, labelled `key=value` secrets, 0x-64 hex keys) so no
//! credential leaves the machine, and **identity anonymization** so a shipped
//! bundle can't be tied back to a person — the user's SS58 wallet address, the
//! OS username inside home-directory paths, user file/folder names, and email
//! addresses are all replaced with inert markers. IPFS CIDs are deliberately
//! kept: they carry no identity and are load-bearing for support debugging.

use crate::error::AppError;
use crate::utils::support::TicketAttachment;
use regex::Regex;
use std::borrow::Cow;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::SystemTime;
use tracing::info;
use zip::CompressionMethod;
use zip::write::{FileOptions, ZipWriter};

/// Newest log files to include. Matches the appender's `max_log_files(7)` so a
/// week of daily rotations is the natural upper bound.
const MAX_FILES: usize = 7;
/// Ship at most this much of any single log file. A file over the cap is
/// TRUNCATED TO ITS TAIL, not dropped: the incident is at the end of the file,
/// and the day a user files a ticket about is the most likely day to have run
/// long. Dropping it produced the worst outcome available — a bundle that looks
/// complete while missing exactly the day support needs.
const MAX_BYTES_PER_FILE: u64 = 5 * 1024 * 1024;
/// Header prepended to a truncated file so support can tell "quiet day" from
/// "we cut 40MB off the front".
const TRUNCATION_NOTICE: &str = "[hippius] earlier lines omitted; this file was truncated to its most recent portion\n";
/// Stop adding files once the (pre-compression) total reaches this, so the
/// attachment stays a reasonable size on the support backend.
const MAX_TOTAL_BYTES: u64 = 20 * 1024 * 1024;

/// Multi-line PEM private-key blocks. Run over the whole file text because a
/// per-line scan cannot see a block that spans many lines. `(?s)` lets `.`
/// match newlines; the lazy `.*?` stops at the first matching `END` line.
static PEM_PRIVATE_KEY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----").expect("static PEM regex is valid"));

/// Per-line redaction patterns, applied in order. Each entry is
/// `(pattern, replacement)`; `replace_all` runs only when `is_match` first
/// confirms a hit, so a clean line keeps its borrowed `Cow` (no allocation).
static LINE_REDACTORS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    vec![
        // BIP-39 mnemonic: a run of 12+ lowercase words (each 3-8 letters)
        // joined by single spaces. Ordinary log prose rarely strings 12 such
        // words together without a capital, digit, or punctuation breaking the
        // run, so this favours catching a leaked seed over preserving an
        // unusually word-dense sentence.
        (
            Regex::new(r"\b[a-z]{3,8}(?:[ ][a-z]{3,8}){11,}\b").expect("mnemonic regex"),
            "[REDACTED_MNEMONIC]",
        ),
        // `key: value` / `key=value` for known secret-bearing keys — redact the
        // value through end of line. The explicit `:`/`=` requirement keeps
        // benign prose that merely mentions the word ("refresh the token soon")
        // intact. The optional quote on either side of the delimiter also covers
        // JSON / `Debug`-formatted forms like {"password":"..."} that a bare
        // `\s*[:=]` missed (audit M-8). `${1}` preserves the original key/case.
        //
        // `share[_-]?token` needs its own alternative: `_` is a word character,
        // so `\btoken\b` can never fire inside `share_token` — and the share
        // commands log exactly that tracing field, so support bundles shipped
        // link capabilities in full. The same boundary rule is what keeps
        // `token_hash` / `token_hash_prefix` loggable, deliberately: the hash
        // is the server's own correlation handle, not the capability.
        (
            Regex::new(
                r#"(?i)\b(authorization|bearer|share[_-]?token|token|api[_-]?key|secret|password|passphrase|seed|mnemonic|private[_-]?key)\b["']?\s*[:=]\s*["']?\S.*"#,
            )
            .expect("labeled-secret regex"),
            "${1}=[REDACTED]",
        ),
        // Bare `Bearer <token>` / `Token <token>` header values (no separator).
        (
            Regex::new(r"(?i)\b(?:bearer|token)\s+[A-Za-z0-9._=+/-]{16,}").expect("bearer regex"),
            "[REDACTED_TOKEN]",
        ),
        // JSON Web Tokens (header.payload[.signature]).
        (
            Regex::new(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*)?").expect("jwt regex"),
            "[REDACTED_TOKEN]",
        ),
        // 0x-prefixed 32-byte hex (private keys / signatures). The exact 64-hex
        // bound avoids nuking shorter hex IDs or IPFS CIDs that aid debugging.
        (Regex::new(r"\b0x[0-9a-fA-F]{64}\b").expect("hex-key regex"), "[REDACTED_KEY]"),
        // ---- identity anonymization (below) -------------------------------
        // These run after the secret passes; the secret tokens above contain no
        // `@`, no 47-48-char base58 run, and no `/Users|home/` prefix, so the two
        // layers never fight. Every replacement token is inert to every pattern
        // here, which is what keeps `redact_log_text` idempotent (proptest pins
        // it). Anonymization favours over-redaction: losing a wallet address from
        // a support log is free, leaking one is not.

        // Email address. Catches the reporter's own address if it ever lands in
        // a log line; ordinary prose has no `@…tld` shape so this is low-noise.
        (
            Regex::new(r"(?i)\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b").expect("email regex"),
            "[REDACTED_EMAIL]",
        ),
        // NOTE: SS58 wallet addresses are handled by `redact_ss58_addresses`,
        // not by a table entry — they need a boundary check the pattern itself
        // cannot express. See that function.
        // Home-directory paths: collapse everything after the `/Users/` or
        // `/home/` root — removing the OS username AND every user file/folder
        // name below it. The tail is non-greedy and ALLOWS internal spaces
        // (sync folders are routinely named "My Drive"), stopping only at a real
        // boundary captured in group 2 and restored verbatim:
        //   ` ident=` → the next `tracing` field, so a sibling like `count=3`
        //               survives instead of being swallowed into the path;
        //   `:`       → a `…/foo.rs:42` line ref keeps its line number;
        //   `"`/`'`   → the closing quote of a `{:?}`-formatted path;
        //   `$`       → end of line.
        // An earlier `[^\s:"']+` tail stopped at the FIRST space, leaking every
        // folder name that followed one; the boundary capture is what closes
        // that hole without eating trailing log context. The `regex` engine is
        // linear-time, so the non-greedy quantifier carries no backtracking
        // cost. Re-running maps `/Users/[REDACTED_PATH]<boundary>` to itself, so
        // idempotence holds.
        (
            Regex::new(r#"(/(?:Users|home)/)[^"'\n]*?( +[A-Za-z_][A-Za-z0-9_]*=|:|["']|$)"#).expect("unix home-path regex"),
            "${1}[REDACTED_PATH]${2}",
        ),
        // Windows equivalent (`C:\Users\name\…`), same boundary handling.
        (
            Regex::new(r#"(?i)([A-Za-z]:\\Users\\)[^"'\n]*?( +[A-Za-z_][A-Za-z0-9_]*=|:|["']|$)"#).expect("windows home-path regex"),
            "${1}[REDACTED_PATH]${2}",
        ),
        // File/folder name as the leaf of a non-home path token (e.g. a temp dir
        // upload `/tmp/report.pdf`). Keeps the separator, drops the name. Bounded
        // to a single path component (`[^/\\…]`) and to a 1-12 char extension so
        // it can't run across separators. Home paths are already collapsed above,
        // so this only catches leaves the home passes didn't reach.
        (
            Regex::new(r#"([/\\])[^/\\\s:"']*\.[A-Za-z0-9]{1,12}\b"#).expect("filename-leaf regex"),
            "${1}[REDACTED_FILENAME]",
        ),
    ]
});

/// Read at most the last `max_bytes` of a UTF-8 text file.
///
/// Seeks rather than reading the whole file, so a runaway multi-hundred-MB log
/// costs one buffer. The seek can land mid-line and mid-UTF-8-sequence, so the
/// bytes are decoded lossily and everything up to the first newline is dropped;
/// what remains starts on a clean line boundary. Returns `None` for a file that
/// can't be read at all, matching the caller's skip-and-continue policy.
fn read_tail_lossy(path: &Path, max_bytes: u64) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();

    if len <= max_bytes {
        let mut buf = Vec::with_capacity(usize::try_from(len).unwrap_or(0));
        file.read_to_end(&mut buf).ok()?;
        return Some(String::from_utf8_lossy(&buf).into_owned());
    }

    file.seek(SeekFrom::Start(len - max_bytes)).ok()?;
    let mut buf = Vec::with_capacity(usize::try_from(max_bytes).unwrap_or(0));
    file.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);

    // Drop the leading partial line; if the window somehow contains no newline
    // the whole thing is one long line, so keep it rather than yielding "".
    let body = text.find('\n').map_or(text.as_ref(), |i| &text[i + 1..]);
    Some(format!("{TRUNCATION_NOTICE}{body}"))
}

/// A run of 47-48 base58 characters — the shape of an SS58 wallet address
/// (32-byte account id + 1-byte network prefix). The length bound is the whole
/// point: IPFS CIDv0 is exactly 46 and CIDv1-base58btc ~49, so both fall
/// outside and survive for debugging while every real address is hit.
///
/// Carries NO boundary assertion; [`redact_ss58_addresses`] applies it.
static SS58_CANDIDATE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[1-9A-HJ-NP-Za-km-z]{47,48}").expect("ss58 address regex"));

/// Replace every SS58 wallet address in `line` with `[REDACTED_ADDRESS]`.
///
/// The boundary check lives HERE, against the surrounding bytes, rather than in
/// the pattern — and that is load-bearing twice over:
///
/// 1. `\b` cannot be used: `_` is a word character, so `\b` never matches
///    between an address and an underscore. The sync engine logs its drive
///    identity as `<ss58>_<folder_hash>`, and a real support bundle shipped
///    that composite with the address fully intact while every standalone
///    occurrence on neighbouring lines was correctly redacted.
/// 2. A *consuming* boundary class (`([^0-9A-Za-z]|$)`) cannot be used either.
///    It swallows the separator, and `replace_all` resumes scanning after it —
///    so with two addresses one character apart (`A,B`), the second has no
///    boundary left to match against and escapes ENTIRELY. That is a total
///    leak, not a cosmetic one, and it is how this function was first written.
///
/// Checking offsets against the haystack asserts both boundaries without
/// consuming either, so adjacent addresses are independent. The length bound
/// stays exact: in a 49-char run the greedy match's right boundary fails, the
/// candidate is returned verbatim, and scanning resumes past it — so a CIDv1
/// is never partially eaten.
fn redact_ss58_addresses(line: &str) -> Cow<'_, str> {
    if !SS58_CANDIDATE.is_match(line) {
        return Cow::Borrowed(line);
    }
    let bytes = line.as_bytes();
    SS58_CANDIDATE.replace_all(line, |caps: &regex::Captures<'_>| {
        let m = caps.get(0).expect("group 0 is always present");
        // base58 is ASCII, so byte indexing can never split a character here.
        let left_free = m.start() == 0 || !bytes[m.start() - 1].is_ascii_alphanumeric();
        let right_free = m.end() == bytes.len() || !bytes[m.end()].is_ascii_alphanumeric();
        if left_free && right_free {
            "[REDACTED_ADDRESS]".to_string()
        } else {
            m.as_str().to_string()
        }
    })
}

/// Resolves the log directory (`$HOME/.hippius/logs`).
fn logs_dir() -> Result<PathBuf, AppError> {
    dirs::home_dir()
        .map(|h| h.join(".hippius").join("logs"))
        .ok_or_else(|| AppError::Other("Could not determine home directory".into()))
}

/// Redacts a single log line, scrubbing any secret or identifying value the
/// patterns recognize (see `LINE_REDACTORS` for the secret + anonymization set).
///
/// Returns `Cow::Borrowed` unchanged when the line is clean (the common case),
/// allocating only when a redaction actually fires.
fn redact_log_line(line: &str) -> Cow<'_, str> {
    let mut current = Cow::Borrowed(line);
    for (re, replacement) in LINE_REDACTORS.iter() {
        if re.is_match(&current) {
            current = Cow::Owned(re.replace_all(&current, *replacement).into_owned());
        }
    }
    // Wallet addresses last. Order is immaterial to the result — no table
    // pattern produces a 47-48 char base58 run, and the home-path passes
    // collapse any address inside a path before this runs (redacting an
    // already-redacted path is a no-op) — so running it here, outside the
    // table, costs nothing and keeps the boundary logic in one place.
    match redact_ss58_addresses(&current) {
        Cow::Borrowed(_) => current,
        Cow::Owned(redacted) => Cow::Owned(redacted),
    }
}

/// Redacts an entire log file's text: a whole-text pass for multi-line PEM
/// private-key blocks, then a per-line pass for single-line secrets.
///
/// Idempotent — running it on already-redacted text yields the same text, since
/// every replacement token (`[REDACTED…]`) is inert to all patterns. Note that
/// line endings are normalized to `\n`.
fn redact_log_text(input: &str) -> String {
    let pem_stripped = PEM_PRIVATE_KEY.replace_all(input, "[REDACTED_PRIVATE_KEY]");

    let mut out = String::with_capacity(pem_stripped.len());
    for line in pem_stripped.lines() {
        out.push_str(&redact_log_line(line));
        out.push('\n');
    }
    out
}

/// Owns a temporary zip file and removes it on drop.
///
/// RAII guarantees the transient upload artifact is cleaned up on every exit
/// path — normal return, an early `?`, an upload failure, or an unwind — so no
/// caller has to remember to delete it.
struct TempZip(PathBuf);

impl TempZip {
    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempZip {
    fn drop(&mut self) {
        // Best-effort: a missing file or a permissions error must not panic
        // during unwind. The OS temp dir is reclaimed regardless.
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Builds a redacted zip of the most recent log files in `dir`, plus a
/// `system-info.txt` entry carrying `system_info` (build identity — see
/// `diagnostics::bundle_system_info`) so the bundle names the build that
/// produced it even after the startup banner has rotated out.
///
/// `dir` is a parameter (not hard-coded) so the bundling logic is unit-testable
/// against a fixture directory. Returns `Ok(None)` when there is nothing to
/// ship — the directory is absent (fresh install) or no eligible file remained
/// after the size caps — so the caller can skip the upload cleanly; metadata
/// alone is never worth an upload.
fn build_log_bundle(dir: &Path, system_info: &str) -> Result<Option<TempZip>, AppError> {
    if !dir.exists() {
        return Ok(None);
    }

    // (path, mtime, size) for every regular file, newest first.
    let mut entries: Vec<(PathBuf, SystemTime, u64)> = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        entries.push((entry.path(), modified, meta.len()));
    }
    entries.sort_by_key(|e| std::cmp::Reverse(e.1));

    // Unique name per bundle (UUID, not PID) so two overlapping bundles — a
    // double-submit, or parallel tests in one process — never share a path
    // where one's `TempZip` drop would delete the other's file mid-read.
    let zip_path = std::env::temp_dir().join(format!("hippius-logs-{}.zip", uuid::Uuid::new_v4()));
    let temp = TempZip(zip_path.clone());

    let file = std::fs::File::create(&zip_path)?;
    let mut zip = ZipWriter::new(file);
    let options: FileOptions<'_, ()> = FileOptions::default().compression_method(CompressionMethod::Deflated);

    let mut total: u64 = 0;
    let mut wrote_any = false;
    for (path, _, _) in entries.into_iter().take(MAX_FILES) {
        if total >= MAX_TOTAL_BYTES {
            break;
        }
        // Take at most the per-file cap AND at most the remaining total budget,
        // so both limits are measured in the same units as what actually goes
        // into the zip. Skip unreadable files rather than aborting the whole
        // bundle; tracing writes UTF-8, so that only trips on foreign files.
        let budget = MAX_BYTES_PER_FILE.min(MAX_TOTAL_BYTES - total);
        let Some(raw) = read_tail_lossy(&path, budget) else { continue };
        let redacted = redact_log_text(&raw);
        let name = path
            .file_name()
            .map_or_else(|| "log.txt".to_string(), |n| n.to_string_lossy().into_owned());
        zip.start_file(name, options)
            .map_err(|e| AppError::Other(format!("zip start_file: {e}")))?;
        zip.write_all(redacted.as_bytes())?;
        total = total.saturating_add(redacted.len() as u64);
        wrote_any = true;
    }
    // Identity metadata rides along only when log files shipped: on its own
    // it explains nothing, and an upload of pure metadata would read as "logs
    // arrived" on the ticket. Written outside the size budget — it is a few
    // fixed lines, and the budget exists to bound log content.
    if wrote_any {
        zip.start_file("system-info.txt", options)
            .map_err(|e| AppError::Other(format!("zip start_file: {e}")))?;
        zip.write_all(system_info.as_bytes())?;
    }
    zip.finish().map_err(|e| AppError::Other(format!("zip finish: {e}")))?;

    // No eligible files: let `temp` drop (removing the empty zip) and signal
    // "nothing to attach" so the caller skips the upload.
    Ok(if wrote_any { Some(temp) } else { None })
}

/// Bundles recent (redacted) logs and uploads them to a support ticket message.
///
/// Best-effort by contract: returns `Ok(None)` when there are no logs to ship,
/// and the temporary zip is always removed (RAII), including on upload failure.
/// The frontend calls this after `create_support_ticket`, wrapped in its own
/// error handling so a log-bundle failure never fails the ticket itself.
///
/// Every failure is logged at `warn!` before it is returned. That matters more
/// here than in most commands: the renderer treats this call as best-effort, so
/// without a Rust-side record a failed upload left no trace ANYWHERE — the
/// user believed logs were sent, and the next bundle they sent by hand couldn't
/// explain why the first never arrived.
#[tauri::command]
pub async fn attach_logs_to_ticket(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: crate::app_state::SessionAccount,
    ticket_id: String,
) -> Result<Option<TicketAttachment>, AppError> {
    attach_logs_to_ticket_inner(&state, &account_id, &ticket_id).await.inspect_err(|e| {
        tracing::warn!(ticket_id = %ticket_id, error = %e, "Failed to attach logs to support ticket");
    })
}

async fn attach_logs_to_ticket_inner(
    state: &tauri::State<'_, crate::app_state::AppState>,
    account_id: &crate::app_state::SessionAccount,
    ticket_id: &str,
) -> Result<Option<TicketAttachment>, AppError> {
    info!(ticket_id = %ticket_id, "Bundling logs for support ticket");

    // Resolved here rather than taken from the caller: attachments hang off a
    // message, and the create response the frontend used to read it from does
    // not guarantee the `messages` array (see `support::first_message_id`).
    let message_id = crate::utils::support::first_message_id(state, account_id, ticket_id).await?;

    let dir = logs_dir()?;
    let system_info = crate::diagnostics::bundle_system_info();
    // File enumeration, reads, redaction, and zipping are blocking; keep them
    // off the async runtime. `build_log_bundle` owns all the blocking work.
    let bundle = tokio::task::spawn_blocking(move || build_log_bundle(&dir, &system_info))
        .await
        .map_err(|e| AppError::Other(format!("Log bundling task failed: {e}")))??;

    let Some(bundle) = bundle else {
        info!("No log files to attach; skipping log upload");
        return Ok(None);
    };

    let bytes = tokio::fs::read(bundle.path())
        .await
        .map_err(|e| AppError::Other(format!("Failed to read log bundle: {e}")))?;

    let attachment = crate::utils::support::upload_attachment_bytes(
        state,
        account_id,
        ticket_id,
        &message_id.to_string(),
        bytes,
        "hippius-logs.zip".to_string(),
    )
    .await?;

    // `bundle` (TempZip) drops here, removing the temp zip from disk.
    Ok(Some(attachment))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    // A valid 12-word BIP-39 mnemonic (all-`a` prefix words from the wordlist).
    const MNEMONIC_12: &str = "abandon ability able about above absent absorb abstract absurd abuse access accident";

    #[test]
    fn redacts_twelve_word_mnemonic() {
        let line = format!("2026-06-08 INFO key import {MNEMONIC_12}");
        let out = redact_log_line(&line);
        assert!(out.contains("[REDACTED_MNEMONIC]"), "got: {out}");
        assert!(!out.contains("abandon"), "mnemonic leaked: {out}");
        assert!(out.contains("INFO"), "non-secret context should survive: {out}");
    }

    #[test]
    fn redacts_twenty_four_word_mnemonic() {
        let m24 = format!("{MNEMONIC_12} {MNEMONIC_12}");
        let out = redact_log_line(&m24);
        assert!(out.contains("[REDACTED_MNEMONIC]"), "got: {out}");
        assert!(!out.contains("abandon"), "mnemonic leaked: {out}");
    }

    #[test]
    fn redacts_authorization_token() {
        let line = "DEBUG header Authorization: Token eyJabc123.def456.ghi789tail";
        let out = redact_log_line(line);
        assert!(!out.contains("eyJabc123"), "token leaked: {out}");
        assert!(out.contains("[REDACTED]"), "expected redaction marker: {out}");
    }

    #[test]
    fn redacts_password_key_value() {
        let line = "config password=hunter2supersecret loaded ok";
        let out = redact_log_line(line);
        assert!(!out.contains("hunter2supersecret"), "password leaked: {out}");
        assert!(out.contains("password=[REDACTED]"), "got: {out}");
    }

    #[test]
    fn redacts_json_and_quoted_secret_forms() {
        // The quote between key and `:` previously bypassed the labeled-secret
        // regex (audit M-8). Cover JSON and single-quoted Debug-style forms.
        for line in [
            r#"{"password":"hunter2supersecret"}"#,
            r#"{"apiKey":"sk_live_abc123def456"}"#,
            "'token':'abc123def456ghi'",
        ] {
            let out = redact_log_line(line);
            assert!(!out.contains("hunter2supersecret"), "json password leaked: {out}");
            assert!(!out.contains("sk_live_abc123def456"), "json apiKey leaked: {out}");
            assert!(!out.contains("abc123def456ghi"), "quoted token leaked: {out}");
            assert!(out.contains("[REDACTED]"), "expected redaction in: {out}");
        }
    }

    #[test]
    fn redacts_share_token_field() {
        // `\btoken\b` cannot fire inside `share_token` (`_` is a word char), so
        // tracing lines like `warn!(share_token = %share_token, ...)` shipped
        // the link capability in full until the dedicated alternative landed.
        for line in [
            "WARN revoke_share failed share_token=AbCd12-efGh34_ijKl56 status=404",
            r#"{"shareToken":"AbCd12efGh34ijKl56"}"#,
            "DEBUG minted share-token: AbCd12efGh34ijKl56",
        ] {
            let out = redact_log_line(line);
            assert!(!out.contains("AbCd12"), "share token leaked: {out}");
            assert!(out.contains("[REDACTED]"), "expected redaction marker: {out}");
        }
    }

    #[test]
    fn preserves_token_hash_fields() {
        // The token HASH is deliberately loggable — it is the server's own
        // correlation handle (request logs carry the same prefix), never the
        // capability. The `\b` boundary that misses `share_token` is the same
        // one that keeps these intact; pin that so a broadened alternation
        // doesn't start eating the one identifier support can join on.
        for line in [
            "WARN compensating folder-share revoke failed token_hash_prefix=af1349b9f5f9a1a6",
            "INFO listing row token_hash=af1349b9f5f9a1a6a0404dea36dcc949 resolvable=false",
        ] {
            let out = redact_log_line(line);
            assert_eq!(out, line, "token_hash must survive redaction: {out}");
        }
    }

    #[test]
    fn redacts_hex_private_key() {
        let key = "0x".to_string() + &"a1b2c3d4".repeat(8); // 0x + 64 hex chars
        let line = format!("signing with {key} now");
        let out = redact_log_line(&line);
        assert!(out.contains("[REDACTED_KEY]"), "got: {out}");
        assert!(!out.contains("a1b2c3d4a1b2"), "key leaked: {out}");
    }

    #[test]
    fn redacts_pem_private_key_block() {
        let text = "before\n-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBg\nkqhkiG9w0BAQEFAA==\n-----END PRIVATE KEY-----\nafter";
        let out = redact_log_text(text);
        assert!(out.contains("[REDACTED_PRIVATE_KEY]"), "got: {out}");
        assert!(!out.contains("MIIBVgIBADAN"), "key body leaked: {out}");
        assert!(out.contains("before") && out.contains("after"), "surrounding text should survive: {out}");
    }

    #[test]
    fn redacts_ss58_wallet_address() {
        // Substrate's well-known public Alice address (48-char base58).
        let addr = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
        let line = format!("INFO auth: refreshed token for {addr}");
        let out = redact_log_line(&line);
        assert!(out.contains("[REDACTED_ADDRESS]"), "got: {out}");
        assert!(!out.contains("5Grwva"), "address leaked: {out}");
        assert!(out.contains("INFO auth"), "context should survive: {out}");
    }

    #[test]
    fn redacts_ss58_joined_to_a_folder_hash_by_underscore() {
        // The leak this boundary change fixes. `sync::drive::lifecycle` logs the
        // drive identity as `<ss58>_<folder_hash>`; `_` is a word character, so
        // the previous `\b`-anchored pattern never fired and a shipped support
        // bundle carried the user's wallet address in full.
        let addr = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
        for line in [
            format!("INFO Hippius::sync::drive::lifecycle: Drive unlocked, user_id: {addr}_6a6dd9c67ff2e846"),
            format!("INFO Hippius::sync::drive::lifecycle: Sync initialized label=12mai user_id={addr}_6a6dd9c67ff2e846"),
        ] {
            let out = redact_log_line(&line);
            assert!(!out.contains("5Grwva"), "address leaked: {out}");
            assert!(out.contains("[REDACTED_ADDRESS]_6a6dd9c67ff2e846"), "got: {out}");
        }
    }

    #[test]
    fn redacts_ss58_against_every_neighbouring_delimiter() {
        // Boundary sweep: the classes must fire at line start/end and against
        // each delimiter the loggers actually produce around an address.
        let addr = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
        for line in [
            addr.to_string(),
            format!("account={addr}"),
            format!("\"{addr}\""),
            format!("{addr}_suffix"),
            format!("prefix_{addr}"),
            format!("[{addr}]"),
            format!("for {addr}."),
        ] {
            let out = redact_log_line(&line);
            assert!(!out.contains("5Grwva"), "address leaked from {line:?}: {out}");
            assert!(out.contains("[REDACTED_ADDRESS]"), "no marker for {line:?}: {out}");
        }
    }

    #[test]
    fn redacts_both_addresses_separated_by_a_single_character() {
        // Consume-and-restore boundaries mean `replace_all` resumes scanning
        // AFTER the separator, so the next address has no boundary character
        // left to match against and escapes entirely. A support bundle logging
        // two addresses on one line would ship the second in full.
        let a = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
        let b = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
        for sep in [" ", ",", "_", "/"] {
            let line = format!("transfer {a}{sep}{b} done");
            let out = redact_log_line(&line);
            assert!(!out.contains("5Grwva"), "first address leaked with sep {sep:?}: {out}");
            assert!(!out.contains("5FHneW"), "second address leaked with sep {sep:?}: {out}");
        }
    }

    #[test]
    fn preserves_ipfs_cid() {
        // CIDv0 is exactly 46 chars — outside the 47-48 address bound, so a CID
        // (no identity, useful for support) must pass through untouched.
        let cid = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
        assert_eq!(cid.len(), 46, "test fixture must be a real 46-char CIDv0");
        let line = format!("INFO pinned content {cid} ok");
        let out = redact_log_line(&line);
        assert_eq!(out, line, "IPFS CID must not be redacted: {out}");
    }

    #[test]
    fn preserves_longer_base58_run_than_an_address() {
        // The length bound must stay exact under the new boundary classes: a
        // 49-char base58 run (CIDv1-base58btc shape) must not have 48 of its
        // chars eaten, whether it sits at line edges or between delimiters.
        let cid = "z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
        let long: String = std::iter::repeat_n('a', 49 - cid.len()).chain(cid.chars()).collect();
        assert_eq!(long.len(), 49, "test fixture must be a 49-char base58 run");
        for line in [long.clone(), format!("INFO cid {long} ok"), format!("cid={long}")] {
            let out = redact_log_line(&line);
            assert_eq!(out, line, "a 49-char run must pass through untouched: {out}");
        }
    }

    #[test]
    fn redacts_email_address() {
        let line = "WARN bounce sending to ourovorosio@gmail.com failed";
        let out = redact_log_line(line);
        assert!(out.contains("[REDACTED_EMAIL]"), "got: {out}");
        assert!(!out.contains("ourovorosio"), "email leaked: {out}");
    }

    #[test]
    fn redacts_macos_home_username_and_tail() {
        let line = r#"INFO sync folder added path="/Users/georgiosdelkos/Documents/TopSecret/plan.pdf""#;
        let out = redact_log_line(line);
        assert!(!out.contains("georgiosdelkos"), "username leaked: {out}");
        assert!(!out.contains("TopSecret"), "folder name leaked: {out}");
        assert!(!out.contains("plan.pdf"), "file name leaked: {out}");
        assert!(out.contains("/Users/[REDACTED_PATH]"), "expected collapsed home path: {out}");
    }

    #[test]
    fn redacts_linux_home_path() {
        let line = "DEBUG master mnemonic at /home/alice/.hippius/master_enc_mnemonic.json";
        let out = redact_log_line(line);
        assert!(!out.contains("alice"), "username leaked: {out}");
        assert!(out.contains("/home/[REDACTED_PATH]"), "got: {out}");
    }

    #[test]
    fn redacts_windows_home_path() {
        let line = r"ERROR open C:\Users\Bob\AppData\hippius.db failed";
        let out = redact_log_line(line);
        assert!(!out.contains("Bob"), "username leaked: {out}");
        assert!(out.contains(r"C:\Users\[REDACTED_PATH]"), "got: {out}");
    }

    #[test]
    fn redacts_filename_in_nonhome_path() {
        let line = "INFO bundling /tmp/quarterly-report.pdf for upload";
        let out = redact_log_line(line);
        assert!(!out.contains("quarterly-report"), "file name leaked: {out}");
        assert!(out.contains("/tmp/[REDACTED_FILENAME]"), "got: {out}");
    }

    #[test]
    fn home_path_line_ref_keeps_line_number() {
        // The `:` boundary stops the home-path match so a `path:line` style ref
        // keeps its line number, which is what makes such a hit worth shipping.
        let line = "WARN failed at /home/alice/work:128";
        let out = redact_log_line(line);
        assert!(!out.contains("alice"), "username leaked: {out}");
        assert!(out.contains(":128"), "line number should survive: {out}");
    }

    #[test]
    fn redacts_home_folder_names_containing_spaces() {
        // The leak the boundary capture fixes: a tail char class that stopped at
        // the first space left every later folder name exposed. Unquoted, EOL.
        let line = "INFO sync folder added path=/Users/bob/My Secret Project/notes";
        let out = redact_log_line(line);
        assert!(!out.contains("bob"), "username leaked: {out}");
        assert!(!out.contains("Secret"), "folder name leaked: {out}");
        assert!(!out.contains("notes"), "leaf folder leaked: {out}");
        assert!(out.contains("/Users/[REDACTED_PATH]"), "got: {out}");
    }

    #[test]
    fn home_path_preserves_following_tracing_field() {
        // The ` ident=` boundary keeps a sibling structured field rather than
        // swallowing it into the path — the cost of allowing spaces in the tail.
        let line = "INFO done path=/Users/bob/My Drive/x count=3 ok=true";
        let out = redact_log_line(line);
        assert!(!out.contains("bob") && !out.contains("Drive"), "path leaked: {out}");
        assert!(out.contains("count=3"), "sibling field swallowed: {out}");
        assert!(out.contains("ok=true"), "sibling field swallowed: {out}");
    }

    #[test]
    fn redacts_quoted_home_path_with_spaces() {
        // `{:?}` formatting wraps the path in quotes; the closing quote bounds
        // the redaction losslessly even with spaces inside.
        let line = r#"DEBUG opening "/Users/bob/My Secret/plan.pdf" now"#;
        let out = redact_log_line(line);
        assert!(
            !out.contains("bob") && !out.contains("Secret") && !out.contains("plan.pdf"),
            "leak: {out}"
        );
        assert!(out.contains(r#""/Users/[REDACTED_PATH]""#), "got: {out}");
        assert!(out.contains("now"), "trailing context after the quote should survive: {out}");
    }

    #[test]
    fn redacts_windows_home_path_with_spaces() {
        let line = r"ERROR open C:\Users\Bob\My Documents\budget.xlsx failed";
        let out = redact_log_line(line);
        assert!(
            !out.contains("Bob") && !out.contains("Documents") && !out.contains("budget"),
            "leak: {out}"
        );
        assert!(out.contains(r"C:\Users\[REDACTED_PATH]"), "got: {out}");
    }

    #[test]
    fn clean_line_is_borrowed_and_unchanged() {
        let line = "2026-06-08T10:00:00Z INFO hippius: started sync for three drives";
        let out = redact_log_line(line);
        assert!(matches!(out, Cow::Borrowed(_)), "clean line must not allocate");
        assert_eq!(out, line);
    }

    #[test]
    fn ordinary_prose_is_not_over_redacted() {
        let line = "INFO uploaded file report.pdf to drive Documents and finished cleanly";
        let out = redact_log_line(line);
        assert_eq!(out, line, "ordinary log prose must pass through unchanged");
    }

    #[test]
    fn empty_dir_returns_none() {
        let dir = tempfile::tempdir().expect("tempdir");
        // Non-empty metadata proves system info alone never creates a bundle.
        let bundle = build_log_bundle(dir.path(), "version: 1.2.3\n").expect("bundle");
        assert!(bundle.is_none(), "empty dir should yield no bundle");
    }

    #[test]
    fn missing_dir_returns_none() {
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = dir.path().join("does-not-exist");
        let bundle = build_log_bundle(&missing, "version: 1.2.3\n").expect("bundle");
        assert!(bundle.is_none(), "missing dir should yield no bundle");
    }

    #[test]
    fn bundle_produces_valid_zip_without_secrets() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("hippius.2026-06-08.log"), format!("INFO ok\nimport {MNEMONIC_12}\n")).expect("write log");
        std::fs::write(dir.path().join("hippius.2026-06-07.log"), "INFO previous day\n").expect("write log");

        let bundle = build_log_bundle(dir.path(), "").expect("bundle").expect("expected a bundle");
        let file = std::fs::File::open(bundle.path()).expect("open zip");
        let mut archive = zip::ZipArchive::new(file).expect("read zip");
        assert!(archive.len() >= 2, "expected both log files zipped, got {}", archive.len());

        let mut combined = String::new();
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).expect("entry");
            let mut contents = String::new();
            entry.read_to_string(&mut contents).expect("read entry");
            combined.push_str(&contents);
        }
        assert!(!combined.contains("abandon"), "mnemonic leaked into zip: {combined}");
        assert!(combined.contains("[REDACTED_MNEMONIC]"), "redaction missing from zip: {combined}");
    }

    #[test]
    fn oversized_file_is_truncated_to_its_tail_not_dropped() {
        // The incident is at the END of a runaway log, and the day a user files
        // a ticket about is the likeliest day to be oversized. Dropping it
        // shipped a bundle that looked complete while missing that day.
        let dir = tempfile::tempdir().expect("tempdir");
        let mut big = String::from("INFO oldest line that must not survive\n");
        while big.len() < (MAX_BYTES_PER_FILE + 1) as usize {
            big.push_str("INFO filler line\n");
        }
        big.push_str("ERROR the incident we actually need\n");
        std::fs::write(dir.path().join("hippius.big.log"), &big).expect("write big");
        std::fs::write(dir.path().join("hippius.small.log"), "INFO small\n").expect("write small");

        let bundle = build_log_bundle(dir.path(), "").expect("bundle").expect("expected a bundle");
        let file = std::fs::File::open(bundle.path()).expect("open zip");
        let mut archive = zip::ZipArchive::new(file).expect("read zip");
        // Both log files plus the system-info entry.
        assert_eq!(archive.len(), 3, "an oversized file must still be shipped, truncated");

        let mut big_entry = archive.by_name("hippius.big.log").expect("oversized file present in zip");
        let mut contents = String::new();
        big_entry.read_to_string(&mut contents).expect("read entry");
        assert!(contents.contains("the incident we actually need"), "the tail is the whole point");
        assert!(!contents.contains("oldest line that must not survive"), "the head should be cut");
        assert!(
            contents.contains("truncated"),
            "truncation must be announced: {}",
            &contents[..120.min(contents.len())]
        );
        assert!(
            contents.len() as u64 <= MAX_BYTES_PER_FILE + TRUNCATION_NOTICE.len() as u64,
            "cap must still bound the entry"
        );
    }

    #[test]
    fn tail_starts_on_a_clean_line_boundary() {
        // The seek lands mid-line by construction; a partial first line would
        // read as a corrupt log entry.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("t.log");
        std::fs::write(&path, "AAAA-partial-line\nBBBB\nCCCC\n").expect("write");

        // 12 bytes lands inside the "BBBB" region, after the first newline.
        let tail = read_tail_lossy(&path, 12).expect("tail");
        assert!(tail.starts_with(TRUNCATION_NOTICE), "truncation must be announced: {tail:?}");
        let body = tail.strip_prefix(TRUNCATION_NOTICE).expect("notice prefix");
        assert!(!body.contains("partial-line"), "partial head line leaked: {body:?}");
        assert!(body.contains("CCCC"), "newest content must survive: {body:?}");
        for line in body.lines() {
            assert!(matches!(line, "BBBB" | "CCCC"), "unexpected fragment {line:?}");
        }
    }

    #[test]
    fn small_file_is_read_whole_without_a_truncation_notice() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("t.log");
        std::fs::write(&path, "INFO one\nINFO two\n").expect("write");
        let out = read_tail_lossy(&path, MAX_BYTES_PER_FILE).expect("tail");
        assert_eq!(out, "INFO one\nINFO two\n", "an under-cap file must be untouched");
    }

    #[test]
    fn total_budget_caps_the_bundle_across_files() {
        // Each file may take up to the per-file cap, but never past the total.
        // The old code compared raw sizes against a total of redacted sizes.
        let dir = tempfile::tempdir().expect("tempdir");
        let chunk = "INFO x\n".repeat(1024);
        for i in 0..9 {
            std::fs::write(dir.path().join(format!("hippius.{i}.log")), &chunk).expect("write");
        }
        let bundle = build_log_bundle(dir.path(), "").expect("bundle").expect("expected a bundle");
        let file = std::fs::File::open(bundle.path()).expect("open zip");
        let mut archive = zip::ZipArchive::new(file).expect("read zip");

        // Count LOG entries by name, so the MAX_FILES cap is proven
        // independently of the system-info entry — a raw `len() <= MAX + 1`
        // would let an eighth log file pass whenever system-info went missing.
        let log_entries = (0..archive.len())
            .filter(|&i| archive.by_index(i).expect("entry").name() != "system-info.txt")
            .count();
        assert!(log_entries <= MAX_FILES, "must never ship more than MAX_FILES log entries");
        assert!(log_entries > 0, "small files must all fit");
    }

    #[test]
    fn bundle_includes_a_system_info_entry() {
        // The startup banner rotates out after seven days, so the bundle
        // itself must name the build that produced it.
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("hippius.log"), "INFO ok\n").expect("write log");

        let bundle = build_log_bundle(dir.path(), "version: 1.2.3\nchannel: staging\n")
            .expect("bundle")
            .expect("expected a bundle");
        let file = std::fs::File::open(bundle.path()).expect("open zip");
        let mut archive = zip::ZipArchive::new(file).expect("read zip");

        let mut entry = archive.by_name("system-info.txt").expect("system-info.txt present in zip");
        let mut contents = String::new();
        entry.read_to_string(&mut contents).expect("read entry");
        assert!(contents.contains("version: 1.2.3"), "got: {contents}");
        assert!(contents.contains("channel: staging"), "got: {contents}");
    }

    #[test]
    fn temp_zip_drop_removes_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("artifact.zip");
        std::fs::write(&path, b"zip").expect("write");
        assert!(path.exists());
        {
            let _guard = TempZip(path.clone());
        }
        assert!(!path.exists(), "TempZip drop should remove the file");
    }

    proptest::proptest! {
        /// Redaction is idempotent: a second pass over already-redacted text is
        /// a no-op. The generator covers printable ASCII plus newlines — the
        /// shape real log text takes.
        #[test]
        fn redaction_is_idempotent(s in "[ -~\n]{0,300}") {
            let once = redact_log_text(&s);
            let twice = redact_log_text(&once);
            proptest::prop_assert_eq!(once, twice);
        }
    }
}
