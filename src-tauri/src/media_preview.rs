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
/// fails the check rather than escaping it.
async fn validate_preview_source(state: &crate::app_state::AppState, source: &Path) -> Result<PathBuf> {
    let canonical_source = tokio::fs::canonicalize(source).await?;
    let preview_root = dirs::home_dir()
        .ok_or_else(|| AppError::Other("could not determine home directory".into()))?
        .join(".hippius")
        .join("preview-cache");
    if let Ok(canonical_preview_root) = tokio::fs::canonicalize(&preview_root).await
        && canonical_source.starts_with(canonical_preview_root)
    {
        return Ok(canonical_source);
    }

    let account_id = state.current_account_id()?;
    let sync_paths = crate::sync::folders::get_all_sync_paths_internal(state.pool()?, &account_id).await?;
    for sync_path in sync_paths {
        if sync_path.path.is_empty() {
            continue;
        }
        if let Ok(canonical_root) = tokio::fs::canonicalize(&sync_path.path).await
            && canonical_source.starts_with(canonical_root)
        {
            return Ok(canonical_source);
        }
    }

    Err(AppError::Validation(
        "image preview source is outside the account's registered drives".into(),
    ))
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
    use super::*;

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
            )
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
