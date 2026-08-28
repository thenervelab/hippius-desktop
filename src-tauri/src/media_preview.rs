//! Preview preparation for Hippius Live photos.
//!
//! Mobile stores a Live Photo as one plaintext file containing a valid still
//! image, the paired MOV, and a fixed 24-byte trailer. This module owns the
//! desktop-side format parsing and materialises the two renderable parts under
//! the existing plaintext preview cache. Ordinary images are rejected cheaply
//! after reading only their final 24 bytes.

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

/// Restrict the caller-provided source path to this account's registered sync
/// roots or the dedicated remote-preview cache. Without this gate a compromised
/// renderer could use the extraction command as an arbitrary filesystem reader.
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
