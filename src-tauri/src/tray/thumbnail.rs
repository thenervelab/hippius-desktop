//! The small pictures on the tray popover's file rows.
//!
//! A screenshot row shows the picture itself, through the same cached
//! thumbnailer the Drive grid uses (`sync::remote::image_thumbnail_path`). A
//! recording row shows a frame of the video, read by the recording helper
//! (`--poster`, the same reader the capture card uses, see
//! `capture::poster`), with the recording's length for the corner badge.
//! Anything else gets no picture and the popover keeps its file-type icon.
//!
//! Which files get a picture, and when a video is worth fetching from the
//! cloud for one, is decided here so the popover only draws what it is given.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::app_state::AppState;
use crate::error::{AppError, Result};
use crate::sync::remote::{download_cloud_file_to, image_thumbnail_path, local_source_path, thumbnail_cache_root, unique_part_path};

/// Longest edge of a row picture. The row draws it at 64 x 42, so this is
/// sharp on a Retina display with room to crop.
pub const ROW_MAX_DIM: u32 = 160;

/// How long the helper may take to read a frame before the row keeps its
/// icon. Longer than the capture card's wait: nobody is waiting on a row.
const VIDEO_WAIT: Duration = Duration::from_secs(6);

/// The biggest recording downloaded only to picture it in the popover. A
/// recording not on this computer is fetched whole to read one frame, so a
/// long one keeps its icon instead of costing the network that much.
pub const MAX_CLOUD_VIDEO_BYTES: u64 = 64 * 1024 * 1024;

/// Bumped whenever a cached video frame would look different for the same
/// file, so an old one is never served again.
const VIDEO_PIPELINE_VERSION: u32 = 1;

/// What kind of picture a row can have.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ThumbnailKind {
    Image,
    Video,
}

/// A row's picture. Mirrors `TrayThumbnail` in `app/tray-panel/useTrayThumbnail.ts`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayThumbnail {
    /// The cached JPEG, inside the asset protocol's thumbnail-cache scope.
    pub path: String,
    pub kind: ThumbnailKind,
    /// A recording's length, when the helper reported it.
    pub duration_secs: Option<f64>,
}

/// Which picture a file can have, by its name. Images are the formats the
/// `image` crate is built to decode (Cargo.toml: jpeg, png, bmp); videos the
/// containers the recording helpers write and read.
#[must_use]
pub fn thumbnail_kind(file_name: &str) -> Option<ThumbnailKind> {
    let ext = Path::new(file_name).extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "bmp" => Some(ThumbnailKind::Image),
        "mp4" | "mov" | "m4v" | "webm" | "mkv" => Some(ThumbnailKind::Video),
        _ => None,
    }
}

/// Whether a recording that is not on this computer may be downloaded to
/// picture it: only when its size is known and small enough.
#[must_use]
pub fn cloud_video_allowed(size: Option<u64>) -> bool {
    matches!(size, Some(bytes) if bytes > 0 && bytes <= MAX_CLOUD_VIDEO_BYTES)
}

/// The cached frame's file name. Distinct from an image thumbnail's name for
/// the same key, so the two caches can never serve each other.
#[must_use]
pub fn video_cache_name(key: &str, max_dim: u32) -> String {
    format!("{key}_{max_dim}_video_v{VIDEO_PIPELINE_VERSION}.jpg")
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VideoSidecar {
    duration_secs: Option<f64>,
}

/// The note kept beside a cached frame: the recording's length.
#[must_use]
pub fn sidecar_json(duration_secs: Option<f64>) -> String {
    serde_json::to_string(&VideoSidecar { duration_secs }).unwrap_or_else(|_| "{}".into())
}

/// The length a sidecar recorded; `None` when it is missing or unreadable
/// (the badge is left out, the picture still shows).
#[must_use]
pub fn sidecar_duration(json: &str) -> Option<f64> {
    serde_json::from_str::<VideoSidecar>(json)
        .ok()
        .and_then(|s| s.duration_secs)
        .filter(|d| d.is_finite() && *d >= 0.0)
}

fn path_string(path: &Path) -> Result<String> {
    path.to_str()
        .map(str::to_string)
        .ok_or_else(|| AppError::Other("thumbnail cache path is not valid UTF-8".into()))
}

fn sidecar_path(target: &Path) -> PathBuf {
    let mut name = target.as_os_str().to_owned();
    name.push(".json");
    PathBuf::from(name)
}

/// Write `image` as the row's JPEG through a unique temp and a rename, so a
/// half-written file is never served as a cache hit. Blocking.
fn write_frame(image: &image::DynamicImage, cache_root: &Path, cache_name: &str, target: &Path) -> Result<()> {
    let thumb = image.thumbnail(ROW_MAX_DIM, ROW_MAX_DIM).to_rgb8();
    let part = unique_part_path(cache_root, cache_name);
    if let Err(e) = thumb.save_with_format(&part, image::ImageFormat::Jpeg) {
        let _ = std::fs::remove_file(&part);
        return Err(AppError::Other(format!("encode video thumbnail: {e}")));
    }
    std::fs::rename(&part, target).map_err(AppError::Io)
}

#[allow(clippy::too_many_arguments)]
async fn video_thumbnail(
    state: &AppState,
    account_id: &str,
    label: &str,
    file_id: &str,
    arion_hash: &str,
    source: Option<&str>,
    size: Option<u64>,
) -> Result<Option<TrayThumbnail>> {
    let key = if arion_hash.is_empty() { file_id } else { arion_hash };
    if key.is_empty() {
        return Ok(None);
    }
    let cache_root = thumbnail_cache_root()?;
    tokio::fs::create_dir_all(&cache_root).await?;
    let cache_name = video_cache_name(key, ROW_MAX_DIM);
    let target = cache_root.join(&cache_name);
    let sidecar = sidecar_path(&target);

    if matches!(tokio::fs::metadata(&target).await, Ok(meta) if meta.len() > 0) {
        let duration = tokio::fs::read_to_string(&sidecar).await.ok().and_then(|j| sidecar_duration(&j));
        return Ok(Some(TrayThumbnail {
            path: path_string(&target)?,
            kind: ThumbnailKind::Video,
            duration_secs: duration,
        }));
    }

    let (src, cloud_temp) = if let Some(local) = local_source_path(source).await {
        (local, None)
    } else if cloud_video_allowed(size) && !file_id.is_empty() && !label.is_empty() {
        let tmp = unique_part_path(&cache_root, &cache_name);
        if let Err(e) = download_cloud_file_to(state, account_id, label, file_id, &tmp).await {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(e);
        }
        (tmp.clone(), Some(tmp))
    } else {
        return Ok(None);
    };

    let made = {
        let (cache_root, cache_name, target, sidecar) = (cache_root.clone(), cache_name.clone(), target.clone(), sidecar.clone());
        tokio::task::spawn_blocking(move || -> Result<Option<Option<f64>>> {
            let Some((frame, duration)) = crate::capture::poster::still_from_file(&src, VIDEO_WAIT) else {
                return Ok(None);
            };
            write_frame(&frame, &cache_root, &cache_name, &target)?;
            // The length is a nicety: a failed note costs the badge, not the picture.
            let _ = std::fs::write(&sidecar, sidecar_json(duration));
            Ok(Some(duration))
        })
        .await
        .map_err(|e| AppError::Other(format!("video thumbnail task panicked: {e}")))?
    };

    if let Some(tmp) = cloud_temp {
        let _ = tokio::fs::remove_file(&tmp).await;
    }

    Ok(made?.map(|duration_secs| TrayThumbnail {
        path: target.to_str().map(str::to_string).unwrap_or_default(),
        kind: ThumbnailKind::Video,
        duration_secs,
    }))
}

/// The picture for one tray popover row, or `None` when the file has none
/// (not an image or a recording, a recording this platform cannot read a
/// frame from, or one too big to fetch just for this). The popover keeps
/// the file-type icon then.
///
/// # Errors
/// [`AppError::Auth`] for another account; otherwise what the thumbnailer or
/// the cloud download reports (the popover shows the icon either way).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn get_tray_thumbnail(
    state: tauri::State<'_, AppState>,
    account_id: String,
    label: String,
    file_id: String,
    arion_hash: String,
    source: Option<String>,
    file_name: String,
    size: Option<u64>,
) -> Result<Option<TrayThumbnail>> {
    let account_id = state.require_session_account(&account_id)?;
    match thumbnail_kind(&file_name) {
        None => Ok(None),
        Some(ThumbnailKind::Image) => {
            let path = image_thumbnail_path(
                state.inner(),
                &account_id,
                &label,
                &file_id,
                &arion_hash,
                source.as_deref(),
                Some(ROW_MAX_DIM),
            )
            .await?;
            Ok(Some(TrayThumbnail {
                path: path_string(&path)?,
                kind: ThumbnailKind::Image,
                duration_secs: None,
            }))
        }
        Some(ThumbnailKind::Video) => video_thumbnail(state.inner(), &account_id, &label, &file_id, &arion_hash, source.as_deref(), size).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn screenshots_and_recordings_get_pictures_and_nothing_else_does() {
        assert_eq!(thumbnail_kind("Screenshot 2026-10-06 at 10.00.00.png"), Some(ThumbnailKind::Image));
        assert_eq!(thumbnail_kind("photo.JPEG"), Some(ThumbnailKind::Image));
        assert_eq!(thumbnail_kind("Recording 2026-10-06.mp4"), Some(ThumbnailKind::Video));
        assert_eq!(thumbnail_kind("clip.MOV"), Some(ThumbnailKind::Video));
        assert_eq!(thumbnail_kind("screen.webm"), Some(ThumbnailKind::Video));
        // Formats the image crate is not built to decode would only fail.
        assert_eq!(thumbnail_kind("photo.heic"), None);
        assert_eq!(thumbnail_kind("anim.gif"), None);
        assert_eq!(thumbnail_kind("report.pdf"), None);
        assert_eq!(thumbnail_kind("README"), None);
        assert_eq!(thumbnail_kind(".png"), None);
    }

    #[test]
    fn a_cloud_recording_is_fetched_for_its_picture_only_when_small_and_sized() {
        assert!(cloud_video_allowed(Some(20 * 1024 * 1024)));
        assert!(cloud_video_allowed(Some(MAX_CLOUD_VIDEO_BYTES)));
        assert!(!cloud_video_allowed(Some(MAX_CLOUD_VIDEO_BYTES + 1)));
        assert!(!cloud_video_allowed(Some(0)));
        assert!(!cloud_video_allowed(None));
    }

    #[test]
    fn a_video_frame_never_shares_a_cache_file_with_an_image_thumbnail() {
        let video = video_cache_name("abc", ROW_MAX_DIM);
        assert_eq!(Path::new(&video).extension().and_then(|e| e.to_str()), Some("jpg"));
        assert_ne!(video, format!("abc_{ROW_MAX_DIM}_v2.jpg"));
        assert_ne!(video_cache_name("abc", 160), video_cache_name("abc", 320));
        assert_ne!(video_cache_name("abc", 160), video_cache_name("xyz", 160));
    }

    #[test]
    fn the_length_note_round_trips_and_tolerates_damage() {
        assert_eq!(sidecar_duration(&sidecar_json(Some(42.5))), Some(42.5));
        assert_eq!(sidecar_duration(&sidecar_json(None)), None);
        assert_eq!(sidecar_duration("garbage"), None);
        assert_eq!(sidecar_duration(r#"{"durationSecs": -3}"#), None);
    }

    #[test]
    fn the_sidecar_sits_beside_the_frame() {
        let target = Path::new("/tmp/thumbnail-cache/abc_160_video_v1.jpg");
        assert_eq!(sidecar_path(target), PathBuf::from("/tmp/thumbnail-cache/abc_160_video_v1.jpg.json"));
    }

    #[test]
    fn the_wire_shape_is_what_the_popover_reads() {
        let value = serde_json::to_value(TrayThumbnail {
            path: "/p.jpg".into(),
            kind: ThumbnailKind::Video,
            duration_secs: Some(3.0),
        })
        .unwrap();
        assert_eq!(value, serde_json::json!({ "path": "/p.jpg", "kind": "video", "durationSecs": 3.0 }));
    }

    #[test]
    fn a_frame_is_written_small_and_whole() {
        let dir = tempfile::tempdir().unwrap();
        let frame = image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(1920, 1080, image::Rgb([200, 30, 30])));
        let name = video_cache_name("k", ROW_MAX_DIM);
        let target = dir.path().join(&name);
        write_frame(&frame, dir.path(), &name, &target).unwrap();
        let written = image::open(&target).unwrap();
        assert_eq!(written.width(), ROW_MAX_DIM);
        assert!(written.height() < ROW_MAX_DIM);
        // No temp left behind.
        let leftovers: Vec<_> = std::fs::read_dir(dir.path()).unwrap().flatten().filter(|e| e.path() != target).collect();
        assert!(leftovers.is_empty());
    }
}
