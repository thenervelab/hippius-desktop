//! Preview preparation for the in-app file viewer.
//!
//! Two commands, one shared gate. `prepare_motion_photo_preview` splits a
//! Hippius Live image (a still, the paired MOV, and a fixed 24-byte trailer
//! written by mobile) into the plaintext preview cache; ordinary images are
//! rejected cheaply after reading only their final 24 bytes.
//! `read_preview_bytes` hands the renderer the plaintext bytes of a document
//! (DOCX/XLSX/PPTX/CSV/JSON/text/HTML/Markdown/SVG) under a byte cap.
//!
//! Both take a caller-supplied path and both run it through
//! [`validate_preview_source`] first, so neither can be used as an arbitrary
//! filesystem reader by a compromised renderer.

use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::error::{AppError, Result};

const TRAILER_SIZE: u64 = 24;
const MAGIC: &[u8; 11] = b"HIPPIUSLIVE";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct MotionPhotoParts {
    still_length: u64,
    video_length: u64,
}

/// Paths prepared for the image viewer. `still_path` and `video_path` are set
/// together only when the source has a valid Hippius Live trailer.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MotionPhotoPreview {
    is_live: bool,
    still_path: Option<String>,
    video_path: Option<String>,
}

/// Detect and split a Hippius Live image for the desktop preview.
///
/// The extracted plaintext parts live below `$HOME/.hippius/preview-cache`, the
/// same narrowly scoped location used by remote-file previews. Cache names are
/// derived from the source path and metadata, so reopening an unchanged photo
/// reuses the prepared files while a changed source gets a new entry.
#[tauri::command]
pub async fn prepare_motion_photo_preview(state: tauri::State<'_, crate::app_state::AppState>, source_path: String) -> Result<MotionPhotoPreview> {
    let source = validate_preview_source(&state, Path::new(&source_path)).await?;
    tokio::task::spawn_blocking(move || {
        let cache_root = dirs::home_dir()
            .ok_or_else(|| AppError::Other("could not determine home directory".into()))?
            .join(".hippius")
            .join("preview-cache")
            .join("live-photo");
        prepare_motion_photo_file(&source, &cache_root)
    })
    .await
    .map_err(|error| AppError::Other(format!("Live Photo preview task failed: {error}")))?
}

/// Hard ceiling on a single preview read, whatever the renderer asks for.
///
/// The frontend passes a per-format cap (see `app/lib/utils/filePreviewType.ts`)
/// but that number arrives from the renderer, so it is treated as a *request*
/// rather than a limit: the effective cap is the smaller of the two. Sized
/// above the largest per-format cap (40 MiB, presentations) so a legitimate
/// request is never clipped by it.
const MAX_PREVIEW_READ_BYTES: u64 = 64 * 1024 * 1024;

/// Resolve the effective read limit and reject files that exceed it.
///
/// Pure so the cap policy is unit-testable without touching the filesystem.
/// Rejecting up front (on the file's real length) rather than truncating is
/// deliberate: half a DOCX is a corrupt DOCX, and every renderer would fail
/// with a parse error instead of the honest "too large to preview" state that
/// carries the download fallback.
fn preview_read_limit(requested_max_bytes: u64, file_length: u64) -> Result<u64> {
    // The budget is compared BEFORE any floor is applied. Clamping the request
    // up to 1 first would let a 1-byte file through a 0-byte budget, which is
    // the one thing a 0 request must never allow.
    let effective = requested_max_bytes.min(MAX_PREVIEW_READ_BYTES);
    if file_length > effective {
        return Err(AppError::Validation(PREVIEW_TOO_LARGE.into()));
    }
    // Never hand back 0: `read_preview_bytes` re-checks the bytes it actually
    // holds against this limit, and a 0 would reject the empty file that just
    // passed the check above.
    Ok(effective.max(1))
}

/// User-facing copy for an over-cap preview. Owned here, not in the renderer,
/// so every surface that hits the cap says the same thing.
pub const PREVIEW_TOO_LARGE: &str = "This file is too large to preview. Download it to open it.";

/// Read a previewable file's plaintext bytes for the in-app viewer.
///
/// `source_path` is the already-resolved local path: the file's own location
/// inside a sync folder, or the decrypted copy `cache_remote_file` wrote for a
/// cloud-only file. This command therefore adds no download, decryption or
/// caching of its own — it is the read step those flows stop short of.
///
/// Returns raw bytes via [`tauri::ipc::Response`] rather than a serialised
/// `Vec<u8>`; the JSON path would encode a 25 MiB document as ~75 MiB of
/// decimal digits.
#[tauri::command]
pub async fn read_preview_bytes(
    state: tauri::State<'_, crate::app_state::AppState>,
    source_path: String,
    max_bytes: u64,
) -> Result<tauri::ipc::Response> {
    let source = validate_preview_source(&state, Path::new(&source_path)).await?;
    let metadata = tokio::fs::metadata(&source).await?;
    if !metadata.is_file() {
        return Err(AppError::Validation("preview source is not a file".into()));
    }
    let limit = preview_read_limit(max_bytes, metadata.len())?;

    let bytes = tokio::fs::read(&source).await?;
    // The file can grow between the metadata probe and the read (an upload
    // still landing), so the cap is enforced a second time on what we actually
    // hold rather than on what we expected to hold.
    if bytes.len() as u64 > limit {
        return Err(AppError::Validation(PREVIEW_TOO_LARGE.into()));
    }
    Ok(tauri::ipc::Response::new(bytes))
}

/// Restrict the caller-provided source path to this account's registered sync
/// roots or the dedicated remote-preview cache. Without this gate a compromised
/// renderer could use either preview command as an arbitrary filesystem reader.
///
/// Both roots are canonicalised before the prefix test, so a `..` segment or a
/// symlink pointing out of a sync folder resolves to its real location and
/// fails the check rather than escaping it. The video stream
/// (`video_stream.rs`) runs every file it serves through this same gate.
pub(crate) async fn validate_preview_source(state: &crate::app_state::AppState, source: &Path) -> Result<PathBuf> {
    let mut roots = vec![preview_cache_root()?];
    // The preview cache alone needs no account; only consult the drives when
    // the file is not there, as before.
    if let Ok(found) = path_under_roots(source, &roots) {
        return Ok(found);
    }
    let account_id = state.current_account_id()?;
    let sync_paths = crate::sync::folders::get_all_sync_paths_internal(state.pool()?, &account_id).await?;
    roots.extend(sync_paths.into_iter().filter(|p| !p.path.is_empty()).map(|p| PathBuf::from(p.path)));
    let source = source.to_path_buf();
    tokio::task::spawn_blocking(move || path_under_roots(&source, &roots))
        .await
        .map_err(|e| AppError::Other(format!("preview gate task failed: {e}")))?
}

/// `$HOME/.hippius/preview-cache`, where cloud-only files are decrypted for
/// the viewer.
fn preview_cache_root() -> Result<PathBuf> {
    Ok(dirs::home_dir()
        .ok_or_else(|| AppError::Other("could not determine home directory".into()))?
        .join(".hippius")
        .join("preview-cache"))
}

/// The pure half of [`validate_preview_source`]: `source`'s real location
/// when it sits under one of `roots` (each canonicalised; a root that does
/// not exist is skipped), else a refusal. A missing source is an error too.
pub(crate) fn path_under_roots(source: &Path, roots: &[PathBuf]) -> Result<PathBuf> {
    let canonical_source = fs::canonicalize(source)?;
    for root in roots {
        if let Ok(canonical_root) = fs::canonicalize(root)
            && canonical_source.starts_with(&canonical_root)
        {
            return Ok(canonical_source);
        }
    }
    Err(AppError::Validation("preview source is outside the account's registered drives".into()))
}

/// Where a file of one of this account's drives is on this device, for a
/// viewer row that knows the file only by its drive and drive-relative path.
///
/// The upload feed's rows for uploads this device just made (Recent Files,
/// the tray) come from the live sync snapshot, which names a file by
/// `label` + relative path and carries neither the on-disk `source` nor the
/// server's file id. The viewer used to refuse such a row ("This file can't
/// be previewed"), and it stayed at the top of Recent Files until the page
/// was left and rebuilt. An upload is read from a drive synced here, so the
/// file is on disk; this answers where.
///
/// `None` when the label is not a drive synced here or the file is not on
/// disk (the caller then has nothing to show, not an error to raise). The
/// relative path may not climb out of the drive (`..`, an absolute path, a
/// drive prefix) and a symlink inside the drive may not lead out of it:
/// without both, this would turn any path into a readable asset URL.
#[tauri::command]
pub async fn resolve_drive_file_source(
    state: tauri::State<'_, crate::app_state::AppState>,
    label: String,
    relative_path: String,
) -> Result<Option<String>> {
    let account_id = state.current_account_id()?;
    let sync_paths = crate::sync::folders::get_all_sync_paths_internal(state.pool()?, &account_id).await?;
    let Some(root) = sync_paths
        .iter()
        .find(|sp| sp.label == label && !sp.path.is_empty() && sp.label != "migration")
    else {
        return Ok(None);
    };
    let root = PathBuf::from(&root.path);
    tokio::task::spawn_blocking(move || file_in_drive(&root, &relative_path))
        .await
        .map_err(|e| AppError::Other(format!("resolve drive file task failed: {e}")))?
}

/// `relative` under `root`, as a path the webview may load, when it names an
/// existing regular file inside `root`. Refuses a path that climbs out
/// (`Validation`) and answers `None` for a missing file or one that is only
/// reachable through a link pointing outside `root`.
///
/// The returned path is `root` joined with the cleaned relative path, not the
/// canonical one: the asset scope was armed with the drive's path as stored,
/// and a canonical form (`/private/var` for `/var` on macOS) would fall
/// outside it.
pub(crate) fn file_in_drive(root: &Path, relative: &str) -> Result<Option<String>> {
    let cleaned = clean_relative(relative).ok_or_else(|| AppError::Validation(format!("{relative} is not a path inside a drive")))?;
    let candidate = root.join(&cleaned);
    let (Ok(canonical), Ok(canonical_root)) = (fs::canonicalize(&candidate), fs::canonicalize(root)) else {
        return Ok(None);
    };
    if !canonical.starts_with(&canonical_root) || !canonical.is_file() {
        return Ok(None);
    }
    candidate
        .to_str()
        .map(|s| Some(s.replace('\\', "/")))
        .ok_or_else(|| AppError::Other("drive file path is not valid UTF-8".into()))
}

/// A drive-relative path as plain components: leading separators dropped
/// (the server and the snapshot write some paths with a leading `/`), and
/// `None` for an empty path or one with `..`, a root or a drive prefix in it.
fn clean_relative(relative: &str) -> Option<PathBuf> {
    use std::path::Component;
    let trimmed = relative.trim_start_matches(['/', '\\']);
    if trimmed.is_empty() {
        return None;
    }
    let mut out = PathBuf::new();
    for part in Path::new(trimmed).components() {
        match part {
            Component::Normal(p) => out.push(p),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    // Windows separators inside a path written on another system.
    if out.as_os_str().is_empty() || trimmed.split(['/', '\\']).any(|seg| seg == "..") {
        return None;
    }
    Some(out)
}

fn prepare_motion_photo_file(source: &Path, cache_root: &Path) -> Result<MotionPhotoPreview> {
    let mut input = File::open(source)?;
    let total_length = input.metadata()?.len();
    let Some(parts) = read_motion_photo_parts(&mut input, total_length)? else {
        return Ok(MotionPhotoPreview {
            is_live: false,
            still_path: None,
            video_path: None,
        });
    };

    fs::create_dir_all(cache_root)?;
    let cache_key = preview_cache_key(source, total_length)?;
    let still_extension = source
        .extension()
        .and_then(|extension| extension.to_str())
        .filter(|extension| !extension.is_empty() && extension.chars().all(|character| character.is_ascii_alphanumeric()))
        .map_or_else(|| "jpg".to_string(), str::to_ascii_lowercase);
    let still_path = cache_root.join(format!("{cache_key}.{still_extension}"));
    let video_path = cache_root.join(format!("{cache_key}.mov"));

    copy_range_if_needed(source, &still_path, 0, parts.still_length)?;
    copy_range_if_needed(source, &video_path, parts.still_length, parts.video_length)?;

    Ok(MotionPhotoPreview {
        is_live: true,
        still_path: Some(path_to_string(&still_path)?),
        video_path: Some(path_to_string(&video_path)?),
    })
}

fn read_motion_photo_parts(input: &mut File, total_length: u64) -> Result<Option<MotionPhotoParts>> {
    if total_length <= TRAILER_SIZE {
        return Ok(None);
    }

    input.seek(SeekFrom::End(-(TRAILER_SIZE as i64)))?;
    let mut trailer = [0_u8; TRAILER_SIZE as usize];
    input.read_exact(&mut trailer)?;
    Ok(parse_motion_photo_trailer(&trailer, total_length))
}

fn parse_motion_photo_trailer(trailer: &[u8; TRAILER_SIZE as usize], total_length: u64) -> Option<MotionPhotoParts> {
    if &trailer[12..23] != MAGIC {
        return None;
    }

    let video_length = u64::from_le_bytes(trailer[0..8].try_into().ok()?);
    let still_length = total_length.checked_sub(TRAILER_SIZE)?.checked_sub(video_length)?;
    if video_length == 0 || still_length == 0 {
        return None;
    }

    Some(MotionPhotoParts { still_length, video_length })
}

fn preview_cache_key(source: &Path, total_length: u64) -> Result<String> {
    let metadata = source.metadata()?;
    let modified = metadata.modified().ok().and_then(|value| value.duration_since(UNIX_EPOCH).ok());
    let mut hasher = Sha256::new();
    hasher.update(source.to_string_lossy().as_bytes());
    hasher.update(total_length.to_le_bytes());
    if let Some(modified) = modified {
        hasher.update(modified.as_secs().to_le_bytes());
        hasher.update(modified.subsec_nanos().to_le_bytes());
    }
    Ok(hex::encode(hasher.finalize()))
}

fn copy_range_if_needed(source: &Path, target: &Path, start: u64, length: u64) -> Result<()> {
    if matches!(target.metadata(), Ok(metadata) if metadata.len() == length) {
        return Ok(());
    }
    if target.exists() {
        fs::remove_file(target)?;
    }

    let part = target.with_extension(format!(
        "{}.{}.part",
        target.extension().and_then(|extension| extension.to_str()).unwrap_or("preview"),
        uuid::Uuid::new_v4()
    ));
    let copy_result = (|| -> io::Result<()> {
        let mut input = File::open(source)?;
        input.seek(SeekFrom::Start(start))?;
        let mut limited = input.take(length);
        let mut output = File::create(&part)?;
        let written = io::copy(&mut limited, &mut output)?;
        if written != length {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "Live Photo ended before the advertised video length",
            ));
        }
        output.flush()?;
        fs::rename(&part, target)
    })();

    if copy_result.is_err() {
        let _ = fs::remove_file(&part);
    }
    copy_result.map_err(AppError::Io)
}

fn path_to_string(path: &Path) -> Result<String> {
    path.to_str()
        .map(str::to_string)
        .ok_or_else(|| AppError::Other("Live Photo preview path is not valid UTF-8".into()))
}

#[cfg(test)]
mod tests {

    mod drive_file_source {
        use super::super::{clean_relative, file_in_drive};
        use std::fs;
        use std::path::PathBuf;

        fn drive() -> (tempfile::TempDir, PathBuf) {
            let dir = tempfile::tempdir().expect("temp dir");
            let root = dir.path().join("Photos");
            fs::create_dir_all(root.join("Trips")).unwrap();
            fs::write(root.join("Trips/beach.png"), b"png").unwrap();
            (dir, root)
        }

        // The reported bug: a just-uploaded file in Recent Files names its
        // file only by drive and relative path, and the viewer refused it.
        #[test]
        fn finds_a_file_uploaded_from_a_drive_by_its_relative_path() {
            let (_dir, root) = drive();
            let found = file_in_drive(&root, "Trips/beach.png").unwrap().expect("on disk");
            assert!(found.ends_with("Photos/Trips/beach.png"), "{found}");
            // The snapshot and the server write some paths with a leading slash.
            assert_eq!(file_in_drive(&root, "/Trips/beach.png").unwrap(), Some(found));
        }

        #[test]
        fn has_nothing_for_a_missing_file_or_a_folder() {
            let (_dir, root) = drive();
            assert_eq!(file_in_drive(&root, "Trips/gone.png").unwrap(), None);
            assert_eq!(file_in_drive(&root, "Trips").unwrap(), None);
        }

        #[test]
        fn refuses_a_path_that_climbs_out_of_the_drive() {
            let (dir, root) = drive();
            fs::write(dir.path().join("secret.txt"), b"x").unwrap();
            assert!(file_in_drive(&root, "../secret.txt").is_err());
            assert!(file_in_drive(&root, "Trips/../../secret.txt").is_err());
            assert!(file_in_drive(&root, "Trips\\..\\..\\secret.txt").is_err());
            assert!(file_in_drive(&root, "").is_err());
            assert_eq!(clean_relative("./Trips/beach.png"), Some(PathBuf::from("Trips/beach.png")));
        }

        #[cfg(unix)]
        #[test]
        fn will_not_follow_a_link_out_of_the_drive() {
            let (dir, root) = drive();
            fs::write(dir.path().join("secret.txt"), b"x").unwrap();
            std::os::unix::fs::symlink(dir.path().join("secret.txt"), root.join("link.txt")).unwrap();
            assert_eq!(file_in_drive(&root, "link.txt").unwrap(), None);
        }
    }
    use super::*;

    /// The gate every preview and the video stream go through: only a file
    /// under a drive or the preview cache, judged by its real location.
    mod gate {
        use super::super::path_under_roots;
        use std::fs;

        #[test]
        fn allows_a_file_under_a_root_and_refuses_one_outside() {
            let dir = tempfile::tempdir().unwrap();
            let drive = dir.path().join("Drive");
            fs::create_dir_all(drive.join("Captures")).unwrap();
            fs::write(drive.join("Captures/Recording.mp4"), b"mp4").unwrap();
            fs::write(dir.path().join("secret.mp4"), b"x").unwrap();
            let roots = vec![dir.path().join("missing-cache"), drive.clone()];

            let found = path_under_roots(&drive.join("Captures/Recording.mp4"), &roots).unwrap();
            assert_eq!(found, fs::canonicalize(drive.join("Captures/Recording.mp4")).unwrap());
            assert!(path_under_roots(&dir.path().join("secret.mp4"), &roots).is_err());
            assert!(path_under_roots(&drive.join("../secret.mp4"), &roots).is_err(), "`..` resolves first");
            assert!(path_under_roots(&drive.join("Captures/gone.mp4"), &roots).is_err());
            assert!(path_under_roots(&drive.join("Captures/Recording.mp4"), &[]).is_err());
            // A sibling whose name starts like the drive is not inside it.
            fs::create_dir_all(dir.path().join("Drive2")).unwrap();
            fs::write(dir.path().join("Drive2/a.mp4"), b"x").unwrap();
            assert!(path_under_roots(&dir.path().join("Drive2/a.mp4"), &roots).is_err());
        }

        #[cfg(unix)]
        #[test]
        fn a_link_out_of_a_root_is_refused() {
            let dir = tempfile::tempdir().unwrap();
            let drive = dir.path().join("Drive");
            fs::create_dir_all(&drive).unwrap();
            fs::write(dir.path().join("secret.mp4"), b"x").unwrap();
            std::os::unix::fs::symlink(dir.path().join("secret.mp4"), drive.join("link.mp4")).unwrap();
            assert!(path_under_roots(&drive.join("link.mp4"), std::slice::from_ref(&drive)).is_err());
        }
    }

    fn bundle(still: &[u8], video: &[u8]) -> Vec<u8> {
        let mut bytes = Vec::from(still);
        bytes.extend_from_slice(video);
        bytes.extend_from_slice(&(video.len() as u64).to_le_bytes());
        bytes.extend_from_slice(&1_u32.to_le_bytes());
        bytes.extend_from_slice(MAGIC);
        bytes.push(0);
        bytes
    }

    #[test]
    fn parses_the_mobile_motion_photo_trailer() {
        let bytes = bundle(b"still-image", b"paired-video");
        let trailer: [u8; TRAILER_SIZE as usize] = bytes[bytes.len() - TRAILER_SIZE as usize..].try_into().expect("fixed trailer");

        assert_eq!(
            parse_motion_photo_trailer(&trailer, bytes.len() as u64),
            Some(MotionPhotoParts {
                still_length: 11,
                video_length: 12,
            })
        );
    }

    #[test]
    fn rejects_plain_images_and_out_of_bounds_lengths() {
        let mut plain = [0_u8; TRAILER_SIZE as usize];
        assert_eq!(parse_motion_photo_trailer(&plain, 100), None);

        plain[0..8].copy_from_slice(&100_u64.to_le_bytes());
        plain[12..23].copy_from_slice(MAGIC);
        assert_eq!(parse_motion_photo_trailer(&plain, 100), None);
    }

    #[test]
    fn preview_read_limit_clamps_a_renderer_request_to_the_hard_ceiling() {
        // A renderer asking for more than the ceiling gets the ceiling, and a
        // file that fits under the ceiling still reads even though the request
        // was absurd — the request is a hint, never an authority.
        assert_eq!(preview_read_limit(u64::MAX, 1_024).expect("under ceiling"), MAX_PREVIEW_READ_BYTES);
        // ...but a file over the ceiling is refused no matter what was asked.
        assert!(preview_read_limit(u64::MAX, MAX_PREVIEW_READ_BYTES + 1).is_err());
    }

    #[test]
    fn preview_read_limit_honours_the_tighter_per_format_cap() {
        // 1 MiB Markdown cap: a 2 MiB file is refused even though the hard
        // ceiling would have allowed it. This is the guard that keeps a
        // renderer from being handed more than its parser is sized for.
        let markdown_cap = 1024 * 1024;
        assert!(preview_read_limit(markdown_cap, markdown_cap + 1).is_err());
        assert_eq!(preview_read_limit(markdown_cap, markdown_cap).expect("at cap"), markdown_cap);
    }

    #[test]
    fn preview_read_limit_rejects_a_zero_request_rather_than_reading_everything() {
        // `clamp(1, ..)` must not turn a 0 request into "no limit"; a 0-byte
        // budget can only ever satisfy an empty file.
        assert!(preview_read_limit(0, 1).is_err());
        assert_eq!(preview_read_limit(0, 0).expect("empty file"), 1);
    }

    #[test]
    fn preview_read_ceiling_clears_every_per_format_cap() {
        // Mirrored as `RUST_PREVIEW_READ_CEILING_BYTES` in
        // `app/lib/utils/filePreviewType.ts`. The renderer's per-format caps
        // must all fit under this, or a file inside its own format's cap would
        // still be refused here and surface as "too large to preview" — the FE
        // side pins the same relationship from the other direction.
        //
        // The largest per-format cap is presentations at 40 MiB.
        const LARGEST_FORMAT_CAP: u64 = 40 * 1024 * 1024;
        // A `const` block, not a plain `assert!`: both sides are constants, so
        // this is decided at compile time and never needs the test to run
        // (clippy's `assertions_on_constants` rejects the runtime form).
        const {
            assert!(
                MAX_PREVIEW_READ_BYTES >= LARGEST_FORMAT_CAP,
                "read ceiling must clear the largest per-format cap"
            );
        };
        // A file at that cap reads rather than being rejected by the ceiling.
        assert!(preview_read_limit(LARGEST_FORMAT_CAP, LARGEST_FORMAT_CAP).is_ok());
    }

    #[test]
    fn preview_read_limit_reports_the_shared_too_large_copy() {
        // The FE renders this string verbatim, so the copy is pinned here
        // rather than duplicated in TypeScript.
        let error = preview_read_limit(10, 11).expect_err("over cap");
        assert_eq!(error.to_string(), PREVIEW_TOO_LARGE);
    }

    #[test]
    fn extracts_still_and_video_to_the_preview_cache() {
        let temp = tempfile::tempdir().expect("temp dir");
        let source = temp.path().join("photo.heic");
        fs::write(&source, bundle(b"heic-still", b"mov-video")).expect("write source");
        let cache = temp.path().join("cache");

        let prepared = prepare_motion_photo_file(&source, &cache).expect("prepare preview");

        assert!(prepared.is_live);
        assert_eq!(fs::read(prepared.still_path.expect("still path")).expect("read still"), b"heic-still");
        assert_eq!(fs::read(prepared.video_path.expect("video path")).expect("read video"), b"mov-video");
    }
}
