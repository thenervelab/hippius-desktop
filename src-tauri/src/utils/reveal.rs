//! Reveal a path in the OS file manager.
//!
//! macOS and Windows use `tauri_plugin_opener::reveal_item_in_dir` (Finder
//! / Explorer select the item). Linux uses `xdg-open` on the directory —
//! or the file's parent — because the opener plugin's FileManager1 / portal
//! path can return success without opening a window on Thunar (H-085).

use std::path::Path;

use crate::error::{AppError, Result};

/// Directory `xdg-open` should receive: the path itself when it is a
/// directory, otherwise its parent (opening a file would launch the
/// default handler instead of the file manager).
#[cfg(any(test, target_os = "linux"))]
pub(crate) fn linux_open_target(path: &Path) -> &Path {
    if path.is_dir() {
        path
    } else {
        path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(path)
    }
}

/// Reveal `path` in the system file manager.
pub fn reveal_path(path: &Path) -> Result<()> {
    #[cfg(target_os = "linux")]
    {
        linux_xdg_open(path)
    }
    #[cfg(not(target_os = "linux"))]
    {
        tauri_plugin_opener::reveal_item_in_dir(path).map_err(|e| AppError::Other(format!("Failed to reveal '{}': {e}", path.display())))
    }
}

#[cfg(target_os = "linux")]
fn linux_xdg_open(path: &Path) -> Result<()> {
    use std::io::ErrorKind;
    use std::process::Stdio;

    let target = linux_open_target(path);
    match std::process::Command::new("xdg-open")
        .arg(target)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(mut child) => {
            // `xdg-open` hands off and exits; wait off-thread so we reap
            // without blocking the IPC (and without Tokio killing the child
            // on drop).
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            Ok(())
        }
        Err(e) if e.kind() == ErrorKind::NotFound => Err(AppError::Other("Couldn't open the file manager (xdg-open was not found).".into())),
        Err(e) => Err(AppError::Io(e)),
    }
}

/// Reveal an arbitrary on-disk path. Same opener as
/// [`crate::sync::control::reveal_drive_in_finder`], so Drive kebabs and
/// Settings "Open in …" cannot disagree about Linux.
#[tauri::command]
pub fn reveal_path_in_file_manager(path: String) -> Result<()> {
    if path.is_empty() {
        return Err(AppError::Validation("No path to reveal".into()));
    }
    reveal_path(Path::new(&path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn linux_open_target_opens_a_directory_as_itself() {
        let tmp = tempfile::TempDir::new().unwrap();
        assert_eq!(linux_open_target(tmp.path()), tmp.path());
    }

    #[test]
    fn linux_open_target_opens_a_file_at_its_parent() {
        let tmp = tempfile::TempDir::new().unwrap();
        let file = tmp.path().join("visible-renamed.txt");
        fs::write(&file, b"x").unwrap();
        assert_eq!(linux_open_target(&file), tmp.path());
    }

    #[test]
    fn linux_open_target_of_a_missing_file_still_uses_the_parent() {
        let tmp = tempfile::TempDir::new().unwrap();
        let missing = tmp.path().join("gone.txt");
        assert_eq!(linux_open_target(&missing), tmp.path());
    }

    #[test]
    fn reveal_path_in_file_manager_rejects_an_empty_path() {
        let err = reveal_path_in_file_manager(String::new()).expect_err("empty");
        assert!(matches!(err, AppError::Validation(_)), "empty path is Validation, got {err:?}");
    }

    #[test]
    fn linux_reveal_uses_xdg_open() {
        let src = include_str!("reveal.rs");
        assert!(
            src.contains("xdg-open"),
            "Linux reveal must spawn xdg-open; the opener plugin's FileManager1 path is a silent no-op on Thunar"
        );
        assert!(
            src.contains("cfg(target_os = \"linux\")"),
            "xdg-open is Linux-only; macOS/Windows keep the opener plugin"
        );
    }

    #[test]
    fn reveal_path_command_is_registered() {
        let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/main.rs")).expect("main.rs");
        assert!(
            src.contains("reveal_path_in_file_manager,"),
            "Drive kebabs call this command; omitting it from generate_handler is a silent no-op"
        );
    }
}
