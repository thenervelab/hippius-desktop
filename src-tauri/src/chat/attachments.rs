//! Saving a chat attachment to disk.
//!
//! Attachments in encrypted rooms are AES-CTR ciphertext on the media
//! server; the webview downloads and decrypts them (the keys live in the
//! event content the Matrix client already holds) and hands the plaintext
//! here to be written. The native save dialog is a UI concern and stays in
//! the frontend, exactly like `downloadFile.ts` does for drive files; this
//! side owns the write: an absolute destination, a temp-file-plus-rename so
//! a crash mid-write never leaves a truncated document the user then opens,
//! and no silent overwrite of a file that appeared after the dialog closed.

use std::path::{Component, Path, PathBuf};

use tauri::ipc::Response;
use tracing::info;

use crate::error::{AppError, Result};

/// Largest attachment we accept from the webview, mirroring the composer's
/// upload cap (`MAX_UPLOAD_BYTES` in `compose.ts`). Anything larger cannot
/// have come from a Hippius client and is refused before it is buffered.
pub const MAX_ATTACHMENT_BYTES: usize = 100 * 1024 * 1024;

/// Validate the destination the save dialog produced.
///
/// The dialog returns an absolute path, so a relative or traversing path
/// means the caller is not the dialog; `..` components are rejected rather
/// than normalised so the file lands exactly where the user pointed. (A
/// `.` segment inside a path is folded away by `Path::components` itself
/// and changes nothing, so it is not an error.)
pub fn validate_destination(path: &str) -> Result<PathBuf> {
    let path = Path::new(path);
    if path.as_os_str().is_empty() {
        return Err(AppError::Validation("No destination chosen".into()));
    }
    if !path.is_absolute() {
        return Err(AppError::Validation("Destination must be an absolute path".into()));
    }
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(AppError::Validation("Destination must not contain '..' components".into()));
    }
    let Some(name) = path.file_name() else {
        return Err(AppError::Validation("Destination must name a file".into()));
    };
    if name.is_empty() {
        return Err(AppError::Validation("Destination must name a file".into()));
    }
    Ok(path.to_path_buf())
}

/// Write `bytes` to `destination` atomically: to a sibling temp file first,
/// then renamed into place, so readers only ever see nothing or the whole
/// file. Fails if `destination` already exists (the dialog asked about
/// overwriting *before* the download; a file created since is not covered
/// by that answer) or if its parent directory is missing.
pub fn write_attachment(destination: &Path, bytes: &[u8]) -> Result<()> {
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err(AppError::Validation(format!(
            "Attachment is larger than {} MB",
            MAX_ATTACHMENT_BYTES / 1024 / 1024
        )));
    }
    let parent = destination
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| AppError::Validation("Destination has no parent directory".into()))?;
    if !parent.is_dir() {
        return Err(AppError::Validation(format!("Folder does not exist: {}", parent.display())));
    }
    if destination.exists() {
        return Err(AppError::Validation(format!("A file already exists at {}", destination.display())));
    }

    let mut temp = tempfile::Builder::new().prefix(".hippius-chat-").suffix(".part").tempfile_in(parent)?;
    std::io::Write::write_all(&mut temp, bytes)?;
    temp.as_file().sync_all()?;
    // `persist_noclobber` is a rename that fails instead of replacing, which
    // closes the window between the `exists()` check above and the rename.
    temp.persist_noclobber(destination).map_err(|e| AppError::Io(e.error))?;
    Ok(())
}

/// Save a decrypted attachment to the path the user chose in the save
/// dialog. `bytes` arrives as the raw IPC body (`tauri::ipc::Response` on
/// the way back is not needed; the request side uses `ArrayBuffer` so a
/// 100 MB file is not base64-inflated through JSON).
#[tauri::command]
pub async fn chat_save_attachment(request: tauri::ipc::Request<'_>) -> Result<Response> {
    let destination = request
        .headers()
        .get("x-destination")
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .ok_or_else(|| AppError::Validation("Missing destination".into()))?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(AppError::Validation("Attachment body must be raw bytes".into()));
    };
    let destination = validate_destination(&destination)?;
    let bytes = bytes.clone();
    let path = destination.clone();
    tauri::async_runtime::spawn_blocking(move || write_attachment(&path, &bytes))
        .await
        .map_err(|e| AppError::Other(format!("save task failed: {e}")))??;
    info!(path = %destination.display(), "chat attachment saved");
    Ok(Response::new(Vec::new()))
}

/// Header values are ASCII; the frontend percent-encodes the path so a
/// non-ASCII filename survives the trip. Only `%XX` sequences are decoded.
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() && input.is_char_boundary(i + 3) {
            let hex = u8::from_str_radix(&input[i + 1..i + 3], 16);
            if let Ok(v) = hex {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `temp_dir()` + separator + `rel`, as a string, so `.`/`..` segments
    /// reach the validator verbatim (`Path::join` would fold `./` away).
    fn abs(rel: &str) -> String {
        let dir = std::env::temp_dir();
        format!(
            "{}{}{}",
            dir.to_string_lossy().trim_end_matches(std::path::MAIN_SEPARATOR),
            std::path::MAIN_SEPARATOR,
            rel
        )
    }

    #[test]
    fn destination_must_be_absolute_and_clean() {
        assert!(validate_destination("").is_err());
        assert!(validate_destination("report.pdf").is_err());
        assert!(validate_destination(&abs("../report.pdf")).is_err());
        assert!(validate_destination(&abs("sub/../report.pdf")).is_err());
        assert!(validate_destination(&abs("sub/./report.pdf")).is_ok());
        let ok = validate_destination(&abs("report.pdf")).unwrap();
        assert!(ok.is_absolute());
        assert_eq!(ok.file_name().unwrap(), "report.pdf");
    }

    #[test]
    fn writes_whole_file_and_leaves_no_temp_behind() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("photo.jpg");
        let payload: Vec<u8> = (0..70_000u32).map(|i| (i % 251) as u8).collect();
        write_attachment(&dest, &payload).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), payload);
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n != "photo.jpg")
            .collect();
        assert!(leftovers.is_empty(), "temp files left: {leftovers:?}");
    }

    #[test]
    fn refuses_to_overwrite_a_file_that_exists() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("doc.pdf");
        std::fs::write(&dest, b"original").unwrap();
        let err = write_attachment(&dest, b"new").unwrap_err();
        assert!(matches!(err, AppError::Validation(_)), "{err:?}");
        assert_eq!(std::fs::read(&dest).unwrap(), b"original");
    }

    #[test]
    fn refuses_missing_parent_and_oversized_payload() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope").join("doc.pdf");
        assert!(matches!(write_attachment(&missing, b"x").unwrap_err(), AppError::Validation(_)));
        // Oversize is rejected before touching the filesystem.
        let big = vec![0u8; MAX_ATTACHMENT_BYTES + 1];
        assert!(matches!(
            write_attachment(&dir.path().join("big.bin"), &big).unwrap_err(),
            AppError::Validation(_)
        ));
        assert!(!dir.path().join("big.bin").exists());
    }

    #[test]
    fn percent_decoding_round_trips_non_ascii_and_leaves_plain_text() {
        assert_eq!(percent_decode("/tmp/plain.txt"), "/tmp/plain.txt");
        assert_eq!(percent_decode("/tmp/r%C3%A9sum%C3%A9.pdf"), "/tmp/résumé.pdf");
        assert_eq!(percent_decode("100%25%20done"), "100% done");
        assert_eq!(percent_decode("trailing%"), "trailing%");
        assert_eq!(percent_decode("bad%zz"), "bad%zz");
    }
}
