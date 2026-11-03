//! Save a copy of a file to the Desktop, the way the system screenshot tool
//! leaves its pictures there.
//!
//! The copy keeps the file's name; when the Desktop already holds one by that
//! name the copy is "<name> (2).<ext>", then "(3)", and so on. Nothing on the
//! Desktop is ever overwritten: the bytes go to a hidden staging file first,
//! which is then moved to the first free name with a no-clobber rename, so a
//! name taken in between is skipped rather than replaced, and a failed copy
//! leaves nothing half-written behind. The original (and so a capture in its
//! drive and its share link) is only ever read.

use std::path::{Path, PathBuf};

use crate::error::{AppError, Result};

/// How many names are tried before giving up ("(2)" to "(999)").
const MAX_NAMES: u32 = 999;

/// The name the `n`th copy of `name` gets: the name itself for the first,
/// then " (n)" before the extension. A name with no extension, or a hidden
/// file such as ".env", takes the suffix at its end.
#[must_use]
pub fn numbered_name(name: &str, n: u32) -> String {
    if n <= 1 {
        return name.to_owned();
    }
    match name.rfind('.') {
        Some(dot) if dot > 0 => format!("{} ({n}){}", &name[..dot], &name[dot..]),
        _ => format!("{name} ({n})"),
    }
}

/// Copy `source` into `dir` under its own name, numbered past any file
/// already there ([`numbered_name`]). Returns where the copy landed.
///
/// # Errors
/// [`AppError::Validation`] when `source` is not a file, or every name up to
/// "(999)" is taken; [`AppError::Io`] when the copy or the move fails.
pub fn copy_into(source: &Path, dir: &Path) -> Result<PathBuf> {
    if !source.is_file() {
        return Err(AppError::Validation("That file isn't on this computer any more.".into()));
    }
    let name = source
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| AppError::Validation("That file has no name to save it under.".into()))?;
    let staged = tempfile::Builder::new()
        .prefix(".hippius-desktop-copy-")
        .suffix(".part")
        .tempfile_in(dir)
        .map_err(AppError::Io)?;
    std::fs::copy(source, staged.path()).map_err(AppError::Io)?;
    let mut staged = staged;
    for n in 1..=MAX_NAMES {
        let target = dir.join(numbered_name(name, n));
        match staged.persist_noclobber(&target) {
            Ok(_) => return Ok(target),
            Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => staged = e.file,
            Err(e) => return Err(AppError::Io(e.error)),
        }
    }
    Err(AppError::Validation(format!(
        "Your Desktop already has too many files named {name}. Rename some and try again."
    )))
}

/// The user's Desktop folder.
///
/// # Errors
/// [`AppError::Validation`] when the system names none, or it is missing.
pub fn desktop_dir() -> Result<PathBuf> {
    dirs::desktop_dir()
        .filter(|d| d.is_dir())
        .ok_or_else(|| AppError::Validation("Couldn't find your Desktop folder.".into()))
}

/// Copy `source` to the Desktop ([`copy_into`] the [`desktop_dir`]).
///
/// # Errors
/// As [`desktop_dir`] and [`copy_into`].
pub fn save_to_desktop(source: &Path) -> Result<PathBuf> {
    copy_into(source, &desktop_dir()?)
}

/// What the app says once a copy is on the Desktop.
#[must_use]
pub fn saved_line(saved: &Path) -> String {
    match saved.file_name().and_then(|n| n.to_str()) {
        Some(name) => format!("Saved to your Desktop as {name}."),
        None => "Saved to your Desktop.".to_owned(),
    }
}

/// Save a file of one of this account's drives, synced here, to the Desktop.
/// The path is checked against the account's synced folders first, so the
/// renderer cannot copy any file it names. Returns the copy's file name.
#[tauri::command]
pub async fn save_file_to_desktop(state: tauri::State<'_, crate::app_state::AppState>, path: String) -> Result<String> {
    let canonical = super::reveal::in_account_sync_folder(state.inner(), &path).await?;
    let saved = tauri::async_runtime::spawn_blocking(move || save_to_desktop(&canonical))
        .await
        .map_err(|e| AppError::Other(format!("Copy cancelled: {e}")))??;
    Ok(saved_line(&saved))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_clash_gets_a_number_before_the_extension() {
        assert_eq!(
            numbered_name("Screenshot 2026-11-02 at 10.00.00.png", 1),
            "Screenshot 2026-11-02 at 10.00.00.png"
        );
        assert_eq!(
            numbered_name("Screenshot 2026-11-02 at 10.00.00.png", 2),
            "Screenshot 2026-11-02 at 10.00.00 (2).png"
        );
        assert_eq!(numbered_name("Recording.mp4", 3), "Recording (3).mp4");
        assert_eq!(numbered_name("archive.tar.gz", 2), "archive.tar (2).gz");
        assert_eq!(numbered_name("notes", 2), "notes (2)");
        assert_eq!(numbered_name(".env", 2), ".env (2)");
    }

    #[test]
    fn a_copy_never_overwrites_and_leaves_the_original_alone() {
        let src_dir = tempfile::TempDir::new().unwrap();
        let desk = tempfile::TempDir::new().unwrap();
        let source = src_dir.path().join("Shot.png");
        std::fs::write(&source, b"new picture").unwrap();
        std::fs::write(desk.path().join("Shot.png"), b"already here").unwrap();

        let first = copy_into(&source, desk.path()).unwrap();
        assert_eq!(first, desk.path().join("Shot (2).png"));
        let second = copy_into(&source, desk.path()).unwrap();
        assert_eq!(second, desk.path().join("Shot (3).png"));

        assert_eq!(std::fs::read(desk.path().join("Shot.png")).unwrap(), b"already here");
        assert_eq!(std::fs::read(&first).unwrap(), b"new picture");
        assert_eq!(std::fs::read(&source).unwrap(), b"new picture", "the original is only read");
        let leftovers: Vec<_> = std::fs::read_dir(desk.path())
            .unwrap()
            .filter_map(|e| e.ok()?.file_name().into_string().ok())
            .filter(|n| Path::new(n).extension().is_some_and(|e| e.eq_ignore_ascii_case("part")))
            .collect();
        assert!(leftovers.is_empty(), "no staging file is left behind: {leftovers:?}");
    }

    #[test]
    fn a_missing_file_is_refused_in_plain_words() {
        let desk = tempfile::TempDir::new().unwrap();
        let err = copy_into(&desk.path().join("gone.png"), desk.path()).expect_err("missing");
        assert!(
            matches!(err, AppError::Validation(ref m) if m.contains("isn't on this computer")),
            "{err:?}"
        );
    }

    #[test]
    fn the_line_names_the_copy() {
        assert_eq!(
            saved_line(Path::new("/Users/x/Desktop/Shot (2).png")),
            "Saved to your Desktop as Shot (2).png."
        );
    }
}
