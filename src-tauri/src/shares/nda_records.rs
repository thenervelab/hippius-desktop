//! A link's NDA accepts as files the owner keeps: the whole log as CSV, and
//! a record of one accept.
//!
//! Both are built here, on the owner's computer, from the log Rust reads
//! with the link's key ([`super::nda::link_log`]): the text and the signers'
//! emails are opened here and never sent anywhere. The save dialog is the
//! frontend's; this side writes the file (an absolute destination, a temp
//! file and a rename).
//!
//! Both files are the console's, byte for byte (`nda-record.ts`: columns,
//! headers, value formats, record lines and order, file names), so an owner
//! gets the same file from either app. A record names the file, the signer's
//! email, the accept time in UTC and the accept id, the SHA-256 of the text
//! as the viewer read it (placeholders filled), and the text hash the server
//! stored with the accept (BLAKE3), which ties the record to the server's
//! row. An accept of an earlier text has a record too, saying the text is
//! not available, since no copy of an earlier text is kept.

use std::collections::BTreeMap;

use base64::Engine as _;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use sha2::{Digest, Sha256};
use tracing::info;

use super::insights_csv::{Cell, save_stem, to_csv, write_csv, write_file};
use super::nda::{NdaAccept, NdaAccepts, link_log};
use crate::app_state::AppState;
use crate::chat::attachments::validate_destination;
use crate::error::{AppError, Result};

/// Said when the log is empty: an empty file would read as a broken export.
pub const NO_ACCEPTS: &str = "No one has accepted yet.";
/// Said when a record is asked for an accept that has none.
pub const NO_RECORD: &str = "A record needs the text this person accepted, and it can't be opened here.";
/// The CSV's Version for an accept of the current text, and of a replaced one.
pub const CURRENT_TEXT: &str = "Current";
pub const EARLIER_TEXT: &str = "Earlier text";
/// A record's text line for an accept of an earlier text.
pub const TEXT_REPLACED: &str = "This text was replaced after this accept, so it is not available here.";
/// What a saved file's name starts with when the file's own name leaves nothing.
const NAME_FALLBACK: &str = "File";

/// An RFC 3339 time as "2026-11-20 10:42:05 UTC"; empty when it does not
/// parse (the console's `formatUtc`).
pub fn utc(rfc3339: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(rfc3339).map_or_else(
        |_| String::new(),
        |t| t.with_timezone(&chrono::Utc).format("%Y-%m-%d %H:%M:%S UTC").to_string(),
    )
}

/// The `{date}` placeholder's value, "November 20, 2026" in UTC; empty when
/// the time does not parse (the console's `ndaDate`).
fn nda_date(rfc3339: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(rfc3339).map_or_else(|_| String::new(), |t| t.with_timezone(&chrono::Utc).format("%B %-d, %Y").to_string())
}

/// The text as the viewer read it: `{viewer_email}`, `{date}` and
/// `{file_name}` filled, each left as it is when its value is blank (the
/// console's `fillNdaPlaceholders`).
fn fill_placeholders(text: &str, email: Option<&str>, date: &str, file_name: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let tail = &rest[open..];
        let filled = [("{viewer_email}", email.unwrap_or("")), ("{date}", date), ("{file_name}", file_name)]
            .into_iter()
            .find(|(p, _)| tail.starts_with(p));
        if let Some((p, v)) = filled {
            out.push_str(if v.trim().is_empty() { p } else { v.trim() });
            rest = &tail[p.len()..];
        } else {
            out.push('{');
            rest = &tail[1..];
        }
    }
    out.push_str(rest);
    out
}

/// The text's SHA-256 over its UTF-8 bytes, in lowercase hex.
pub fn text_sha256(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}

/// A base64 hash from the server as lowercase hex, `None` when it is not
/// base64 (the console's `base64ToHex`, which reads it with `atob`: padding
/// optional).
fn base64_to_hex(b64: &str) -> Option<String> {
    const LENIENT: GeneralPurpose = GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
    );
    LENIENT.decode(b64).ok().map(hex::encode)
}

/// Newest first, as the NDA tab lists them.
fn newest_first(log: &NdaAccepts) -> Vec<&NdaAccept> {
    let mut accepts: Vec<&NdaAccept> = log.accepts.iter().collect();
    accepts.sort_by(|a, b| {
        let at = |x: &NdaAccept| chrono::DateTime::parse_from_rfc3339(&x.accepted_at).ok();
        at(b).cmp(&at(a)).then(b.id.cmp(&a.id))
    });
    accepts
}

/// Every accept as CSV, newest first, with the console's columns: File,
/// Name, Email, Email verified, Accepted (UTC), Version, Accept id, Viewer
/// id, Text hash (BLAKE3). Name is the name the signer typed when they
/// accepted, else the Viewers tab's name for them (`names`, by viewer id).
/// Refused when there are none.
pub fn accepts_csv(file_name: &str, log: &NdaAccepts, names: &BTreeMap<String, Option<String>>) -> Result<String> {
    if log.accepts.is_empty() {
        return Err(AppError::Validation(NO_ACCEPTS.into()));
    }
    let header = [
        "File",
        "Name",
        "Email",
        "Email verified",
        "Accepted (UTC)",
        "Version",
        "Accept id",
        "Viewer id",
        "Text hash (BLAKE3)",
    ];
    let mut rows = vec![header.into_iter().map(|h| Cell::Text(h.into())).collect::<Vec<_>>()];
    let text = |s: Option<String>| s.map_or(Cell::Empty, Cell::Text);
    for a in newest_first(log) {
        rows.push(vec![
            Cell::Text(file_name.into()),
            text(a.signer_name.clone().or_else(|| names.get(&a.viewer_id).cloned().flatten())),
            text(a.email.clone()),
            // An email shows here only once it matched the server's check.
            Cell::Text(if a.email.is_some() { "Yes" } else { "" }.into()),
            Cell::Text(utc(&a.accepted_at)),
            Cell::Text(if a.earlier { EARLIER_TEXT } else { CURRENT_TEXT }.into()),
            Cell::Number(a.id),
            Cell::Text(a.viewer_id.clone()),
            Cell::Text(base64_to_hex(&a.text_hash).unwrap_or_else(|| a.text_hash.clone())),
        ]);
    }
    Ok(to_csv(&rows))
}

/// One accept's record, as plain text, in the console's lines and order.
/// `None` when the accept is not in the log, or it is of the current text
/// and that text does not open here.
pub fn record(file_name: &str, log: &NdaAccepts, accept_id: u64) -> Option<String> {
    let accept = log.accepts.iter().find(|a| a.id == accept_id)?;
    let text = if accept.earlier {
        None
    } else {
        let text = log.text.as_deref()?;
        Some(fill_placeholders(
            text,
            accept.email.as_deref(),
            &nda_date(&accept.accepted_at),
            file_name,
        ))
    };
    let mut lines = vec!["NDA accept record".to_string(), String::new(), format!("File: {file_name}")];
    // Only what the signer typed, and only when they typed something.
    if let Some(name) = &accept.signer_name {
        lines.push(format!("Signer name: {name}"));
    }
    lines.push(match &accept.email {
        Some(email) => format!("Signer email: {email} (verified with a code)"),
        None => "Signer email: not asked".into(),
    });
    lines.push(format!("Accepted: {}", utc(&accept.accepted_at)));
    lines.push(format!("Accept id: {}", accept.id));
    if let Some(text) = &text {
        lines.push(format!("Text SHA-256: {}", text_sha256(text)));
    }
    if let Some(stored) = base64_to_hex(&accept.text_hash).filter(|_| !accept.text_hash.is_empty()) {
        lines.push(format!("Stored text hash (BLAKE3, before placeholders are filled): {stored}"));
    }
    lines.extend([String::new(), "Text".into(), String::new()]);
    lines.push(text.unwrap_or_else(|| TEXT_REPLACED.into()));
    lines.push(String::new());
    Some(lines.join("\n"))
}

/// "Q3 report.pdf" on 2026-11-20 to "Q3 report NDA accepts 2026-11-20.csv".
pub fn accepts_csv_name(file_name: &str, day: &str) -> String {
    format!("{} NDA accepts {day}.csv", save_stem(file_name, NAME_FALLBACK))
}

/// "Q3 report.pdf", accept 42, to "Q3 report NDA record 42.txt".
pub fn record_name(file_name: &str, accept_id: u64) -> String {
    format!("{} NDA record {accept_id}.txt", save_stem(file_name, NAME_FALLBACK))
}

async fn write_in_background(destination: std::path::PathBuf, contents: Vec<u8>, bom: bool) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        if bom {
            write_csv(&destination, &String::from_utf8_lossy(&contents))
        } else {
            write_file(&destination, &[&contents])
        }
    })
    .await
    .map_err(|e| AppError::Other(format!("save task failed: {e}")))?
}

// ─── Commands ──────────────────────────────────────────────────────────────

/// The name the save dialog suggests for the accept log, dated today.
#[tauri::command]
pub async fn share_nda_accepts_csv_name(file_name: String) -> Result<String> {
    // The UTC day, as the console's `toISOString` gives it.
    Ok(accepts_csv_name(&file_name, &chrono::Utc::now().format("%Y-%m-%d").to_string()))
}

/// The name the save dialog suggests for one accept's record.
#[tauri::command]
pub async fn share_nda_record_name(file_name: String, accept_id: u64) -> Result<String> {
    Ok(record_name(&file_name, accept_id))
}

/// Saves the link's whole accept log as CSV at `destination`. `viewer_names`
/// are the Viewers tab's names by viewer id, for the Name column.
#[tauri::command]
pub async fn share_export_nda_accepts_csv(
    state: tauri::State<'_, AppState>,
    share_token: String,
    file_name: String,
    destination: String,
    viewer_names: Option<BTreeMap<String, Option<String>>>,
) -> Result<()> {
    let destination = validate_destination(&destination)?;
    let log = link_log(&state, &share_token).await?;
    let csv = accepts_csv(&file_name, &log, &viewer_names.unwrap_or_default())?;
    write_in_background(destination.clone(), csv.into_bytes(), true).await?;
    info!(path = %destination.display(), "nda accepts csv saved");
    Ok(())
}

/// Saves one accept's record at `destination`.
#[tauri::command]
pub async fn share_save_nda_record(
    state: tauri::State<'_, AppState>,
    share_token: String,
    file_name: String,
    accept_id: u64,
    destination: String,
) -> Result<()> {
    let destination = validate_destination(&destination)?;
    let log = link_log(&state, &share_token).await?;
    let text = record(&file_name, &log, accept_id).ok_or_else(|| AppError::Validation(NO_RECORD.into()))?;
    write_in_background(destination.clone(), text.into_bytes(), false).await?;
    info!(path = %destination.display(), "nda record saved");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Standard base64 of 32 bytes, as the server stores a text hash.
    const HASH_B64: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
    const HASH_HEX: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

    fn accept(id: u64, email: Option<&str>, at: &str, earlier: bool) -> NdaAccept {
        NdaAccept {
            id,
            viewer_id: format!("v{id}"),
            email: email.map(str::to_string),
            signer_name: None,
            accepted_at: at.into(),
            earlier,
            text_hash: HASH_B64.into(),
        }
    }

    fn log() -> NdaAccepts {
        NdaAccepts {
            offered: true,
            has_text: true,
            text: Some("Keep it to yourself.\nSecond line.".into()),
            accepts: vec![
                accept(1, None, "2026-11-12T09:18:00Z", true),
                accept(7, Some("dana@acme.com"), "2026-11-20T11:42:05+01:00", false),
                accept(3, Some("=cmd@x.com"), "2026-11-19T16:05:00Z", false),
            ],
            next_after: None,
        }
    }

    fn names() -> BTreeMap<String, Option<String>> {
        BTreeMap::from([("v7".to_string(), Some("Dana, Acme".to_string())), ("v1".to_string(), None)])
    }

    #[test]
    fn times_are_written_in_utc_and_an_unreadable_one_is_left_empty() {
        assert_eq!(utc("2026-11-20T11:42:05+01:00"), "2026-11-20 10:42:05 UTC");
        assert_eq!(utc("2026-11-20T10:42:05.123Z"), "2026-11-20 10:42:05 UTC");
        assert_eq!(utc("not a time"), "");
    }

    #[test]
    fn the_hash_is_sha256_of_the_utf8_text() {
        assert_eq!(text_sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn a_stored_hash_reads_as_hex_with_or_without_padding() {
        assert_eq!(base64_to_hex(HASH_B64).as_deref(), Some(HASH_HEX));
        assert_eq!(base64_to_hex(HASH_B64.trim_end_matches('=')).as_deref(), Some(HASH_HEX));
        assert_eq!(base64_to_hex("not base64!"), None);
    }

    #[test]
    fn the_csv_has_the_consoles_columns_newest_first_and_formula_safe() {
        let mut l = log();
        l.accepts[0].text_hash = "not base64!".into();
        let csv = accepts_csv("Q3 report.pdf", &l, &names()).unwrap();
        assert_eq!(
            csv,
            format!(
                "File,Name,Email,Email verified,Accepted (UTC),Version,Accept id,Viewer id,Text hash (BLAKE3)\r\n\
                 Q3 report.pdf,\"Dana, Acme\",dana@acme.com,Yes,2026-11-20 10:42:05 UTC,Current,7,v7,{HASH_HEX}\r\n\
                 Q3 report.pdf,,'=cmd@x.com,Yes,2026-11-19 16:05:00 UTC,Current,3,v3,{HASH_HEX}\r\n\
                 Q3 report.pdf,,,,2026-11-12 09:18:00 UTC,Earlier text,1,v1,not base64!\r\n"
            )
        );
        let empty = NdaAccepts { accepts: vec![], ..log() };
        assert!(matches!(accepts_csv("x", &empty, &names()), Err(AppError::Validation(m)) if m == NO_ACCEPTS));
    }

    #[test]
    fn a_record_has_the_consoles_lines_in_the_consoles_order() {
        let r = record("Q3 report.pdf", &log(), 7).unwrap();
        let text = "Keep it to yourself.\nSecond line.";
        assert_eq!(
            r,
            format!(
                "NDA accept record\n\nFile: Q3 report.pdf\n\
                 Signer email: dana@acme.com (verified with a code)\n\
                 Accepted: 2026-11-20 10:42:05 UTC\nAccept id: 7\nText SHA-256: {}\n\
                 Stored text hash (BLAKE3, before placeholders are filled): {HASH_HEX}\n\
                 \nText\n\n{text}\n",
                text_sha256(text)
            )
        );
        assert!(
            record("Q3 report.pdf", &log(), 3)
                .unwrap()
                .contains("Signer email: =cmd@x.com (verified with a code)\n")
        );
    }

    /// The name the signer typed fills the CSV's Name ahead of the Viewers
    /// tab's, and the record says it right after the file; a record of an
    /// accept without one has no such line.
    #[test]
    fn the_signers_typed_name_fills_the_name_and_the_record() {
        let mut l = log();
        l.accepts[1].signer_name = Some("Dana Reyes".into());
        l.accepts[2].signer_name = Some("@Sam".into());
        let csv = accepts_csv("Q3 report.pdf", &l, &names()).unwrap();
        let rows: Vec<&str> = csv.split("\r\n").collect();
        assert!(rows[1].starts_with("Q3 report.pdf,Dana Reyes,dana@acme.com,"), "{}", rows[1]);
        assert!(
            rows[2].starts_with("Q3 report.pdf,'@Sam,"),
            "a typed name is formula safe too: {}",
            rows[2]
        );
        let r = record("Q3 report.pdf", &l, 7).unwrap();
        assert!(
            r.starts_with("NDA accept record\n\nFile: Q3 report.pdf\nSigner name: Dana Reyes\nSigner email: dana@acme.com"),
            "{r}"
        );
        assert!(!record("Q3 report.pdf", &log(), 7).unwrap().contains("Signer name"));
    }

    #[test]
    fn a_record_hashes_the_text_with_its_placeholders_filled() {
        let mut l = log();
        l.text = Some("I, {viewer_email}, on {date}, keep {file_name} and {other} quiet.".into());
        let filled = "I, dana@acme.com, on November 20, 2026, keep Q3 report.pdf and {other} quiet.";
        let r = record("Q3 report.pdf", &l, 7).unwrap();
        assert!(r.contains(&format!("Text SHA-256: {}\n", text_sha256(filled))));
        assert!(r.ends_with(&format!("\nText\n\n{filled}\n")));
        // Without an email its placeholder stays as written.
        l.accepts[1].email = None;
        assert!(
            record("Q3 report.pdf", &l, 7)
                .unwrap()
                .contains("I, {viewer_email}, on November 20, 2026")
        );
    }

    #[test]
    fn an_earlier_texts_record_says_the_text_is_not_available() {
        let r = record("Q3 report.pdf", &log(), 1).unwrap();
        assert_eq!(
            r,
            format!(
                "NDA accept record\n\nFile: Q3 report.pdf\nSigner email: not asked\n\
                 Accepted: 2026-11-12 09:18:00 UTC\nAccept id: 1\n\
                 Stored text hash (BLAKE3, before placeholders are filled): {HASH_HEX}\n\
                 \nText\n\n{TEXT_REPLACED}\n"
            )
        );
    }

    #[test]
    fn no_record_without_the_accept_or_the_current_text() {
        assert_eq!(record("x", &log(), 99), None);
        let closed = NdaAccepts { text: None, ..log() };
        assert_eq!(record("x", &closed, 7), None);
        // An earlier text never needed the current one.
        assert!(record("x", &closed, 1).is_some());
    }

    #[test]
    fn a_stored_hash_that_is_not_base64_is_left_out_of_the_record() {
        let mut l = log();
        l.accepts[1].text_hash = "not base64!".into();
        assert!(!record("x", &l, 7).unwrap().contains("Stored text hash"));
        l.accepts[1].text_hash = String::new();
        assert!(!record("x", &l, 7).unwrap().contains("Stored text hash"));
    }

    #[test]
    fn saved_files_are_named_like_the_consoles() {
        assert_eq!(accepts_csv_name("Q3 report.pdf", "2026-11-20"), "Q3 report NDA accepts 2026-11-20.csv");
        assert_eq!(record_name("a/b:c.pdf", 42), "a b c NDA record 42.txt");
        assert_eq!(record_name("", 1), "File NDA record 1.txt");
        assert_eq!(record_name(".pdf", 1), "File NDA record 1.txt");
    }
}
