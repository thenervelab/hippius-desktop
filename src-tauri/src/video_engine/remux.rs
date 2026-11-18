//! Copying a playable picture into an MP4 the webview opens.
//!
//! The output is plaintext video, so it goes only under the app's private
//! preview cache (`~/.hippius/preview-cache/converted/`, owner-only), is
//! deleted when the viewer closes or the remux is cancelled, and whatever a
//! crash left behind is swept at the next launch ([`sweep`]).

use std::path::{Path, PathBuf};
use std::process::Stdio;

use tokio::io::{AsyncBufReadExt, BufReader};

use super::plan::{self, AudioPlan};
use super::probe::MediaInfo;

/// The folder remuxed copies live in, created owner-only.
///
/// # Errors
///
/// No home directory, or the folder could not be made.
pub fn converted_dir() -> std::io::Result<PathBuf> {
    let dir = dirs::home_dir()
        .ok_or_else(|| std::io::Error::other("no home directory"))?
        .join(".hippius")
        .join("preview-cache")
        .join("converted");
    create_private_dir(&dir)?;
    Ok(dir)
}

/// `dir` and its parents, `dir` itself readable by its owner only.
///
/// # Errors
///
/// The folder could not be made or its permissions set.
pub fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Delete every file in `dir` (a launch, a logout: no viewer is open).
pub fn sweep(dir: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter(|e| std::fs::remove_file(e.path()).is_ok())
        .count()
}

/// Progress from one `-progress` line: the output position in seconds.
#[must_use]
pub fn progress_seconds(line: &str) -> Option<f64> {
    let value = line.strip_prefix("out_time_us=").or_else(|| line.strip_prefix("out_time_ms="))?;
    let micros: i64 = value.trim().parse().ok()?;
    #[allow(clippy::cast_precision_loss)]
    (micros >= 0).then(|| micros as f64 / 1_000_000.0)
}

/// Remux `input` into `output`, calling `progress` with 0..=1 as it goes.
/// Dropping the future kills the engine; the caller deletes `output`.
///
/// # Errors
///
/// The engine could not start or did not finish cleanly (its last line).
pub async fn remux(
    engine: &Path,
    input: &Path,
    output: &Path,
    info: &MediaInfo,
    audio: AudioPlan,
    mut progress: impl FnMut(f64) + Send,
) -> Result<(), String> {
    let args = plan::remux_args(&input.to_string_lossy(), &output.to_string_lossy(), info, audio);
    let mut child = super::engine::command(engine)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn: {e}"))?;
    let stderr = child.stderr.take();
    let stderr_task = tokio::spawn(async move {
        let mut last = String::new();
        if let Some(stderr) = stderr {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if !line.trim().is_empty() {
                    last = line;
                }
            }
        }
        last
    });
    if let Some(stdout) = child.stdout.take() {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let (Some(at), Some(total)) = (progress_seconds(&line), info.duration) {
                progress((at / total).clamp(0.0, 1.0));
            }
        }
    }
    let status = child.wait().await.map_err(|e| format!("wait: {e}"))?;
    let last = stderr_task.await.unwrap_or_default();
    if status.success() {
        progress(1.0);
        Ok(())
    } else {
        Err(if last.is_empty() { format!("{status}") } else { last })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_lines_read_as_seconds() {
        assert_eq!(progress_seconds("out_time_us=2500000"), Some(2.5));
        assert_eq!(progress_seconds("out_time_ms=1000000"), Some(1.0));
        assert_eq!(progress_seconds("out_time_us=N/A"), None);
        assert_eq!(progress_seconds("out_time_us=-5"), None);
        assert_eq!(progress_seconds("frame=10"), None);
    }

    #[test]
    fn the_converted_folder_is_owner_only_and_sweeps_clean() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("preview-cache").join("converted");
        create_private_dir(&dir).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        }
        std::fs::write(dir.join("a.mp4"), b"x").unwrap();
        std::fs::write(dir.join("b.mp4"), b"y").unwrap();
        assert_eq!(sweep(&dir), 2);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        assert_eq!(sweep(&root.path().join("missing")), 0);
    }
}
