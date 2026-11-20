//! A link's NDA accepts as files the owner keeps: the whole log as CSV, and
//! a record of one accept.
//!
//! Both are built here, on the owner's computer, from the log Rust reads
//! with the link's key ([`super::nda::link_log`]): the text and the signers'
//! emails are opened here and never sent anywhere. The save dialog is the
//! frontend's; this side writes the file (an absolute destination, a temp
//! file and a rename).
//!
//! A record holds the file's name, the accept's id and time in UTC, the
//! email the signer proved (when the link asked for one), and the full text
//! they accepted with its SHA-256, so anyone can check the text was not
//! changed since. Only an accept of the link's current text has a record:
//! an earlier text is not kept anywhere it could be read back from.

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
/// The CSV's line for an accept of the current text, and of a replaced one.
pub const CURRENT_TEXT: &str = "Current";
pub const EARLIER_TEXT: &str = "Earlier text";

/// An RFC 3339 time as "2026-11-20 10:42:05 UTC"; the server's own string
/// when it does not parse.
pub fn utc(rfc3339: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(rfc3339).map_or_else(
        |_| rfc3339.to_string(),
        |t| t.with_timezone(&chrono::Utc).format("%Y-%m-%d %H:%M:%S UTC").to_string(),
    )
}

/// The text's SHA-256 over its UTF-8 bytes, in lowercase hex.
pub fn text_sha256(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
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

/// Every accept as CSV: File, Accept ID, Email, Accepted (UTC), Text.
/// Refused when there are none.
pub fn accepts_csv(file_name: &str, log: &NdaAccepts) -> Result<String> {
    if log.accepts.is_empty() {
        return Err(AppError::Validation(NO_ACCEPTS.into()));
    }
    let mut rows = vec![
        ["File", "Accept ID", "Email", "Accepted (UTC)", "Text"]
            .into_iter()
            .map(|h| Cell::Text(h.into()))
            .collect::<Vec<_>>(),
    ];
    for a in newest_first(log) {
        rows.push(vec![
            Cell::Text(file_name.into()),
            Cell::Number(a.id),
            a.email.clone().map_or(Cell::Empty, Cell::Text),
            Cell::Text(utc(&a.accepted_at)),
            Cell::Text(if a.earlier { EARLIER_TEXT } else { CURRENT_TEXT }.into()),
        ]);
    }
    Ok(to_csv(&rows))
}

/// One accept's record, as plain text. `None` when the accept has none: an
/// accept of an earlier text, or a text that does not open here.
pub fn record(file_name: &str, log: &NdaAccepts, accept_id: u64) -> Option<String> {
    let accept = log.accepts.iter().find(|a| a.id == accept_id && !a.earlier)?;
    let text = log.text.as_deref()?;
    let email = accept.email.as_deref().unwrap_or("Not asked");
    Some(format!(
        "NDA accept record\n\
         \n\
         File: {file_name}\n\
         Accept ID: {}\n\
         Signer email: {email}\n\
         Accepted (UTC): {}\n\
         Text SHA-256: {}\n\
         \n\
         Text accepted\n\
         \n\
         {text}\n",
        accept.id,
        utc(&accept.accepted_at),
        text_sha256(text),
    ))
}

/// "Q3 report.pdf" on 2026-11-20 to "Q3 report NDA accepts 2026-11-20.csv".
pub fn accepts_csv_name(file_name: &str, day: &str) -> String {
    format!("{} NDA accepts {day}.csv", save_stem(file_name, "NDA"))
}

/// "Q3 report.pdf", accept 42, to "Q3 report NDA record 42.txt".
pub fn record_name(file_name: &str, accept_id: u64) -> String {
    format!("{} NDA record {accept_id}.txt", save_stem(file_name, "NDA"))
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
    Ok(accepts_csv_name(&file_name, &chrono::Local::now().format("%Y-%m-%d").to_string()))
}

/// The name the save dialog suggests for one accept's record.
#[tauri::command]
pub async fn share_nda_record_name(file_name: String, accept_id: u64) -> Result<String> {
    Ok(record_name(&file_name, accept_id))
}

/// Saves the link's whole accept log as CSV at `destination`.
#[tauri::command]
pub async fn share_export_nda_accepts_csv(
    state: tauri::State<'_, AppState>,
    share_token: String,
    file_name: String,
    destination: String,
) -> Result<()> {
    let destination = validate_destination(&destination)?;
    let log = link_log(&state, &share_token).await?;
    let csv = accepts_csv(&file_name, &log)?;
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

    fn accept(id: u64, email: Option<&str>, at: &str, earlier: bool) -> NdaAccept {
        NdaAccept {
            id,
            viewer_id: format!("v{id}"),
            email: email.map(str::to_string),
            accepted_at: at.into(),
            earlier,
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

    #[test]
    fn times_are_written_in_utc() {
        assert_eq!(utc("2026-11-20T11:42:05+01:00"), "2026-11-20 10:42:05 UTC");
        assert_eq!(utc("2026-11-20T10:42:05.123Z"), "2026-11-20 10:42:05 UTC");
        assert_eq!(utc("not a time"), "not a time");
    }

    #[test]
    fn the_hash_is_sha256_of_the_utf8_text() {
        assert_eq!(text_sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn the_csv_lists_every_accept_newest_first_and_formula_safe() {
        let csv = accepts_csv("Q3 report.pdf", &log()).unwrap();
        assert_eq!(
            csv,
            "File,Accept ID,Email,Accepted (UTC),Text\r\n\
             Q3 report.pdf,7,dana@acme.com,2026-11-20 10:42:05 UTC,Current\r\n\
             Q3 report.pdf,3,'=cmd@x.com,2026-11-19 16:05:00 UTC,Current\r\n\
             Q3 report.pdf,1,,2026-11-12 09:18:00 UTC,Earlier text\r\n"
        );
        let empty = NdaAccepts { accepts: vec![], ..log() };
        assert!(matches!(accepts_csv("x", &empty), Err(AppError::Validation(m)) if m == NO_ACCEPTS));
    }

    #[test]
    fn a_record_holds_the_file_the_signer_the_time_and_the_whole_text_with_its_hash() {
        let r = record("Q3 report.pdf", &log(), 7).unwrap();
        let text = "Keep it to yourself.\nSecond line.";
        assert_eq!(
            r,
            format!(
                "NDA accept record\n\nFile: Q3 report.pdf\nAccept ID: 7\nSigner email: dana@acme.com\n\
                 Accepted (UTC): 2026-11-20 10:42:05 UTC\nText SHA-256: {}\n\nText accepted\n\n{text}\n",
                text_sha256(text)
            )
        );
        assert!(record("Q3 report.pdf", &log(), 3).unwrap().contains("Signer email: =cmd@x.com"));
    }

    #[test]
    fn no_record_without_the_text_that_was_accepted() {
        // An earlier text is not kept, so its accept has no record.
        assert_eq!(record("x", &log(), 1), None);
        // An accept that is not in the log.
        assert_eq!(record("x", &log(), 99), None);
        // The text does not open here.
        let closed = NdaAccepts { text: None, ..log() };
        assert_eq!(record("x", &closed, 7), None);
    }

    #[test]
    fn a_record_without_an_email_says_so() {
        let mut l = log();
        l.accepts[1].email = None;
        assert!(record("x", &l, 7).unwrap().contains("Signer email: Not asked\n"));
    }

    #[test]
    fn saved_files_are_named_after_the_file() {
        assert_eq!(accepts_csv_name("Q3 report.pdf", "2026-11-20"), "Q3 report NDA accepts 2026-11-20.csv");
        assert_eq!(record_name("a/b:c.pdf", 42), "a b c NDA record 42.txt");
        assert_eq!(record_name("", 1), "NDA NDA record 1.txt");
    }
}
