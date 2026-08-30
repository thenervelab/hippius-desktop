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
///
/// Canonicalise first so a missing path (or a URL the renderer passed as a
/// "path") is an error the FE can fall back on, and so Linux `xdg-open`
/// never receives a scheme string.
pub fn reveal_path(path: &Path) -> Result<()> {
    let path = std::fs::canonicalize(path).map_err(AppError::Io)?;
    #[cfg(target_os = "linux")]
    {
        linux_xdg_open(&path)
    }
    #[cfg(not(target_os = "linux"))]
    {
        tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|e| AppError::Other(format!("Failed to reveal '{}': {e}", path.display())))
    }
}

#[cfg(target_os = "linux")]
fn linux_xdg_open(path: &Path) -> Result<()> {
    use std::io::ErrorKind;
    use std::process::Stdio;
    use std::time::Duration;

    // Canonicalised paths always start with `/`, so `--` is unnecessary and
    // older XFCE `xdg-open` treats it as the file to open — a silent no-op
    // (H-085 still failing on 0.6.0-beta.5).
    let target = linux_open_target(path);
    let mut child = match std::process::Command::new("xdg-open")
        .arg(target)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(e) if e.kind() == ErrorKind::NotFound => {
            return Err(AppError::Other("Couldn't open the file manager (xdg-open was not found).".into()));
        }
        Err(e) => return Err(AppError::Io(e)),
    };

    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait());
    });
    match rx.recv_timeout(Duration::from_secs(3)) {
        Ok(Ok(status)) if status.success() => Ok(()),
        Ok(Ok(status)) => Err(AppError::Other(format!(
            "Couldn't open the file manager (xdg-open exited {}).",
            status.code().unwrap_or(-1)
        ))),
        Ok(Err(e)) => Err(AppError::Io(e)),
        // Still running: xdg-open handed off to the file manager.
        Err(_) => Ok(()),
    }
}

fn require_nonempty_path(path: &str) -> Result<()> {
    if path.is_empty() {
        return Err(AppError::Validation("No path to reveal".into()));
    }
    Ok(())
}

/// True when `canonical` sits under a canonicalised `root` (component-wise,
/// so `/workspace/foo` does not match `/workspace/foobar`).
fn path_is_under_root(canonical: &Path, root: &Path) -> bool {
    canonical.starts_with(root)
}

/// Reveal an on-disk path in this account's synced folders.
///
/// Canonicalise + prefix against `sync_paths` so a compromised renderer
/// cannot `xdg-open` a URL or a path outside the account's drives.
/// Same opener as [`crate::sync::control::reveal_drive_in_finder`].
#[tauri::command]
pub async fn reveal_path_in_file_manager(state: tauri::State<'_, crate::app_state::AppState>, path: String) -> Result<()> {
    require_nonempty_path(&path)?;
    let canonical = tokio::fs::canonicalize(&path).await.map_err(AppError::Io)?;
    let account_id = state.current_account_id()?;
    let sync_paths = crate::sync::folders::get_all_sync_paths_internal(state.pool()?, &account_id).await?;
    for sync_path in &sync_paths {
        if sync_path.path.is_empty() {
            continue;
        }
        if let Ok(root) = tokio::fs::canonicalize(&sync_path.path).await
            && path_is_under_root(&canonical, &root)
        {
            return reveal_path(&canonical);
        }
    }
    Err(AppError::Validation(
        "That location is not in one of this account's synced folders.".into(),
    ))
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
        let err = require_nonempty_path("").expect_err("empty");
        assert!(matches!(err, AppError::Validation(_)), "empty path is Validation, got {err:?}");
    }

    #[test]
    fn reveal_path_rejects_a_url_shaped_string() {
        let err = reveal_path(Path::new("https://evil.example/file")).expect_err("url");
        assert!(
            matches!(err, AppError::Io(_)),
            "a scheme string must fail canonicalize, not reach xdg-open, got {err:?}"
        );
    }

    #[test]
    fn path_is_under_root_is_component_wise() {
        assert!(path_is_under_root(
            Path::new("/workspace/hippius-qa-beta4-be/a.txt"),
            Path::new("/workspace/hippius-qa-beta4-be"),
        ));
        assert!(
            !path_is_under_root(
                Path::new("/workspace/hippius-qa-beta4-be-other/a.txt"),
                Path::new("/workspace/hippius-qa-beta4-be"),
            ),
            "a sibling prefix must not count as inside the drive"
        );
    }

    #[test]
    fn linux_reveal_uses_xdg_open() {
        let src = include_str!("reveal.rs");
        assert!(
            src.contains("xdg-open"),
            "Linux reveal must spawn xdg-open; the opener plugin's FileManager1 path is a silent no-op on Thunar"
        );
        assert!(
            !src.contains(".arg(\"--\")"),
            "canonical paths start with /; -- made XFCE xdg-open a silent no-op"
        );
        assert!(
            src.contains("cfg(target_os = \"linux\")"),
            "xdg-open is Linux-only; macOS/Windows keep the opener plugin"
        );
        assert!(
            src.contains("get_all_sync_paths_internal"),
            "the IPC must prefix-check against this account's sync_paths"
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
