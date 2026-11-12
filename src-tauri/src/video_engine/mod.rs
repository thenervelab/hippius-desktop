//! Previews for videos the webview cannot play: WMV/ASF, AVI, MKV, FLV,
//! MPEG-PS/TS, 3GP, and (after the webview fails on one) HEVC or other
//! codecs in MP4/MOV.
//!
//! The work is done by a small LGPL ffmpeg shipped beside the app
//! (`engine.rs`), run as a child process: never linked in, so a decoder
//! crash on a hostile file takes down only the child, and killing it is how
//! a seek or a closed viewer stops the work.
//!
//! The viewer calls [`video_preview_open`] with the file's local path (in a
//! drive, or the decrypted preview-cache copy of a cloud-only file). Rust
//! reads the file's streams (`probe.rs`) and decides (`plan.rs`):
//!
//! - **native**: an MP4/WebM/MOV/Ogg the webview plays, or no engine in
//!   this build: the viewer's existing path, unchanged.
//! - **file**: the picture is already playable (H.264 in MKV/AVI/TS/FLV);
//!   it is copied into an MP4 in the private cache (`remux.rs`), lossless
//!   and as fast as the disk, with progress, and played like any MP4.
//! - **stream**: it must be converted (WMV, VC-1, MPEG-2, ...): an HLS
//!   playlist whose segments are converted on demand to H.264 + AAC and
//!   handed to the player over IPC (`session.rs`, [`video_preview_segment`]);
//!   playback starts after the first four seconds are ready, and a seek
//!   restarts the conversion at the segment it lands in.
//! - **unsupported**: [`CANNOT_PREVIEW`], with Download beside it.
//!
//! Every session is closed when the viewer moves on ([`video_preview_close`]),
//! at logout and at quit.

pub mod engine;
pub mod plan;
pub mod probe;
pub mod remux;
pub mod segmenter;
pub mod session;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::Emitter;

use crate::error::{AppError, Result};
use plan::{Decision, Platform};
use session::{EngineLauncher, HlsSession, SegmentFailure};

/// What the viewer says when a video cannot be previewed.
pub const CANNOT_PREVIEW: &str = "This video can't be previewed. Download it to play it.";
/// The event a remux reports its progress on.
pub const PROGRESS_EVENT: &str = "video-preview-progress";
/// The scheme of the playlist URL the player is given. Nothing serves it:
/// the viewer's HLS loader turns each request into [`video_preview_segment`].
pub const STREAM_SCHEME: &str = "hippius-video";
/// At most this many previews are open at once; opening another closes the
/// oldest.
const MAX_SESSIONS: usize = 4;
/// The only window that may open a preview.
const MAIN_WINDOW: &str = "main";

/// The viewer's instruction.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum VideoPreview {
    /// Play the file itself, as before.
    Native,
    /// Play this converted copy (a local path, like any other video).
    File { path: String },
    /// Play this HLS playlist.
    Stream { url: String, duration_secs: f64 },
    /// No player: this line and Download.
    Unsupported { message: String },
}

impl VideoPreview {
    fn unsupported() -> Self {
        Self::Unsupported {
            message: CANNOT_PREVIEW.to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    session_id: &'a str,
    /// 0..=100
    percent: u8,
}

enum Entry {
    Stream { session: Arc<HlsSession>, account: String },
    Remux { path: PathBuf, task: Option<tokio::task::AbortHandle> },
}

struct Slot {
    entry: Entry,
    opened: u64,
}

/// The engine and every open preview.
#[derive(Default)]
pub struct VideoEngineState {
    engine: engine::EngineCell,
    sessions: Mutex<HashMap<String, Slot>>,
    counter: std::sync::atomic::AtomicU64,
}

impl std::fmt::Debug for VideoEngineState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VideoEngineState").finish_non_exhaustive()
    }
}

impl VideoEngineState {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Slot>> {
        self.sessions.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn insert(&self, id: &str, entry: Entry) {
        let opened = self.counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let mut evicted = Vec::new();
        {
            let mut map = self.lock();
            if let Some(old) = map.insert(id.to_string(), Slot { entry, opened }) {
                evicted.push(old.entry);
            }
            while map.len() > MAX_SESSIONS {
                let Some(oldest) = map.iter().min_by_key(|(_, s)| s.opened).map(|(k, _)| k.clone()) else {
                    break;
                };
                if let Some(slot) = map.remove(&oldest) {
                    evicted.push(slot.entry);
                }
            }
        }
        evicted.into_iter().for_each(end);
    }

    /// Close one preview: stop its engine, delete its converted copy.
    pub fn close(&self, id: &str) {
        let slot = self.lock().remove(id);
        if let Some(slot) = slot {
            end(slot.entry);
        }
    }

    /// Close every preview (logout, quit).
    pub fn close_all(&self) {
        let all: Vec<Slot> = self.lock().drain().map(|(_, s)| s).collect();
        for slot in all {
            end(slot.entry);
        }
    }

    fn stream(&self, id: &str, account: &str) -> Option<Arc<HlsSession>> {
        match self.lock().get(id).map(|s| &s.entry) {
            Some(Entry::Stream { session, account: owner }) if owner == account => Some(Arc::clone(session)),
            _ => None,
        }
    }

    /// Number of open previews (tests).
    #[must_use]
    pub fn open_count(&self) -> usize {
        self.lock().len()
    }
}

fn end(entry: Entry) {
    match entry {
        Entry::Stream { session, .. } => session.close(),
        Entry::Remux { path, task } => {
            if let Some(task) = task {
                task.abort();
            }
            // The engine may still hold the file for a moment after the
            // abort; a leftover is swept at the next launch.
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// A session id the viewer made up: short, and safe as a file name.
fn valid_session_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn extension(path: &str) -> String {
    Path::new(path).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase()
}

/// Whether the viewer should even ask the engine: before the webview tried,
/// only for the engine's own extensions; after it failed, for any video.
#[must_use]
pub fn wants_engine(ext: &str, webview_failed: bool) -> bool {
    if webview_failed {
        plan::is_engine_extension(ext) || plan::is_webview_extension(ext)
    } else {
        plan::is_engine_extension(ext)
    }
}

/// How to preview the video at `source_path` (its local copy).
///
/// `webview_failed` is set when the viewer already tried the file in the
/// webview and the player reported an error: the engine is then tried for
/// MP4/MOV too (HEVC on Windows, an `hev1` MOV on macOS, MPEG-4 Part 2 in
/// MP4).
///
/// # Errors
///
/// Another window asked, the id is malformed, the file is outside the
/// viewer's gate, or the preview was closed while it was being prepared.
#[tauri::command]
pub async fn video_preview_open(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    state: tauri::State<'_, crate::app_state::AppState>,
    source_path: String,
    session_id: String,
    webview_failed: bool,
) -> Result<VideoPreview> {
    if webview.label() != MAIN_WINDOW {
        return Err(AppError::Validation("only the main window previews videos".into()));
    }
    if !valid_session_id(&session_id) {
        return Err(AppError::Validation("invalid preview session id".into()));
    }
    if !wants_engine(&extension(&source_path), webview_failed) {
        return Ok(if webview_failed {
            VideoPreview::unsupported()
        } else {
            VideoPreview::Native
        });
    }
    let source = crate::media_preview::validate_preview_source(&state, Path::new(&source_path)).await?;
    let account = state.current_account_id()?;
    let Some(engine) = state.video_engine.engine.get().await else {
        // A build without the engine: let the webview try, as before.
        return Ok(if webview_failed {
            VideoPreview::unsupported()
        } else {
            VideoPreview::Native
        });
    };
    let Some(info) = engine::probe(&engine.path, &source).await else {
        tracing::info!("video preview: the engine does not recognise the file");
        return Ok(VideoPreview::unsupported());
    };
    let decision = plan::decide(&info, Platform::current());
    tracing::info!(
        formats = ?info.formats,
        video = ?info.video.as_ref().map(|v| (&v.codec, v.width, v.height)),
        audio = ?info.audio.as_ref().map(|a| &a.codec),
        ?decision,
        "video preview planned"
    );
    match decision {
        Decision::Unsupported(_) => Ok(VideoPreview::unsupported()),
        Decision::Transcode => {
            let (Some(encoder), Some(duration)) = (engine.encoder, info.duration) else {
                return Ok(VideoPreview::unsupported());
            };
            let launcher = EngineLauncher {
                engine: engine.path.clone(),
                input: source.to_string_lossy().into_owned(),
                info,
                encoder,
            };
            let session = HlsSession::new(duration, Arc::new(launcher));
            state.video_engine.insert(&session_id, Entry::Stream { session, account });
            Ok(VideoPreview::Stream {
                url: format!("{STREAM_SCHEME}://{session_id}/index.m3u8"),
                duration_secs: duration,
            })
        }
        Decision::Remux { audio } => {
            let dir = tokio::task::spawn_blocking(remux::converted_dir)
                .await
                .map_err(|e| AppError::Other(format!("preview folder task failed: {e}")))??;
            let output = dir.join(format!("{session_id}.mp4"));
            let app_for_progress = app.clone();
            let id = session_id.clone();
            let mut last = u8::MAX;
            let engine_path = engine.path.clone();
            let out = output.clone();
            let task = tokio::spawn(async move {
                remux::remux(&engine_path, &source, &out, &info, audio, move |fraction| {
                    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                    let percent = (fraction * 100.0).floor() as u8;
                    if percent != last {
                        last = percent;
                        let _ = app_for_progress.emit(PROGRESS_EVENT, Progress { session_id: &id, percent });
                    }
                })
                .await
            });
            state.video_engine.insert(
                &session_id,
                Entry::Remux {
                    path: output.clone(),
                    task: Some(task.abort_handle()),
                },
            );
            match task.await {
                Ok(Ok(())) => Ok(VideoPreview::File {
                    path: output.to_string_lossy().into_owned(),
                }),
                Ok(Err(e)) => {
                    tracing::warn!(error = %e, "video preview remux failed");
                    state.video_engine.close(&session_id);
                    Ok(VideoPreview::unsupported())
                }
                Err(_) => {
                    state.video_engine.close(&session_id);
                    Err(AppError::Validation("the preview was closed".into()))
                }
            }
        }
    }
}

/// The viewer moved on: stop the preview and delete what it made.
#[tauri::command]
pub fn video_preview_close(state: tauri::State<'_, crate::app_state::AppState>, session_id: String) {
    state.video_engine.close(&session_id);
}

/// One file of a stream: `index.m3u8` or `<n>.ts`, as raw bytes.
///
/// # Errors
///
/// Another window or account asked, the session is closed, the name is not
/// one of the stream's, or the segment could not be converted.
#[tauri::command]
pub async fn video_preview_segment(
    webview: tauri::Webview,
    state: tauri::State<'_, crate::app_state::AppState>,
    session_id: String,
    name: String,
) -> Result<tauri::ipc::Response> {
    if webview.label() != MAIN_WINDOW {
        return Err(AppError::Validation("only the main window previews videos".into()));
    }
    let account = state.current_account_id()?;
    let session = state
        .video_engine
        .stream(&session_id, &account)
        .ok_or_else(|| AppError::NotFound("video preview".into()))?;
    match parse_segment_name(&name) {
        Some(SegmentName::Playlist) => Ok(tauri::ipc::Response::new(session.playlist().into_bytes())),
        Some(SegmentName::Segment(index)) => match session.segment(index).await {
            Ok(bytes) => Ok(tauri::ipc::Response::new(bytes.to_vec())),
            Err(SegmentFailure::OutOfRange | SegmentFailure::Closed | SegmentFailure::Superseded) => Err(AppError::NotFound("video segment".into())),
            Err(e) => Err(AppError::Other(format!("video segment {index}: {e:?}"))),
        },
        None => Err(AppError::NotFound("video segment".into())),
    }
}

#[derive(Debug, PartialEq, Eq)]
enum SegmentName {
    Playlist,
    Segment(u32),
}

fn parse_segment_name(name: &str) -> Option<SegmentName> {
    if name == "index.m3u8" {
        return Some(SegmentName::Playlist);
    }
    let digits = name.strip_suffix(".ts")?;
    if digits.is_empty() || digits.len() > 7 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok().map(SegmentName::Segment)
}

/// At launch: delete converted copies a crash left behind.
pub fn sweep_converted_at_launch() {
    if let Ok(dir) = remux::converted_dir() {
        let n = remux::sweep(&dir);
        if n > 0 {
            tracing::info!(files = n, "removed leftover video previews");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_ids_are_short_and_file_name_safe() {
        assert!(valid_session_id("3f2c9a1e-8b7d-4c6e-9f01-23456789abcd"));
        for bad in ["", "../x", "a/b", "a.b", "a b", &"a".repeat(65)] {
            assert!(!valid_session_id(bad), "{bad}");
        }
    }

    #[test]
    fn segment_names_are_the_playlist_or_numbered_ts_only() {
        assert_eq!(parse_segment_name("index.m3u8"), Some(SegmentName::Playlist));
        assert_eq!(parse_segment_name("0.ts"), Some(SegmentName::Segment(0)));
        assert_eq!(parse_segment_name("123.ts"), Some(SegmentName::Segment(123)));
        for bad in ["", ".ts", "-1.ts", "1.mp4", "../1.ts", "12345678.ts", "x.ts", "index.m3u"] {
            assert_eq!(parse_segment_name(bad), None, "{bad}");
        }
    }

    #[test]
    fn the_engine_is_asked_for_its_formats_first_and_for_any_video_after_the_webview_failed() {
        assert!(wants_engine("wmv", false));
        assert!(wants_engine("mkv", false));
        assert!(!wants_engine("mp4", false), "MP4 keeps the existing path");
        assert!(wants_engine("mp4", true), "HEVC MP4 on Windows");
        assert!(wants_engine("mov", true));
        assert!(!wants_engine("pdf", true));
        assert!(!wants_engine("ts", false));
    }

    #[test]
    fn the_wire_shape_is_what_the_viewer_reads() {
        let stream = serde_json::to_value(VideoPreview::Stream {
            url: "hippius-video://a/index.m3u8".into(),
            duration_secs: 12.5,
        })
        .unwrap();
        assert_eq!(
            stream,
            serde_json::json!({"kind": "stream", "url": "hippius-video://a/index.m3u8", "durationSecs": 12.5})
        );
        assert_eq!(serde_json::to_value(VideoPreview::Native).unwrap(), serde_json::json!({"kind": "native"}));
        assert_eq!(
            serde_json::to_value(VideoPreview::unsupported()).unwrap(),
            serde_json::json!({"kind": "unsupported", "message": CANNOT_PREVIEW})
        );
        assert_eq!(
            serde_json::to_value(VideoPreview::File { path: "/p.mp4".into() }).unwrap(),
            serde_json::json!({"kind": "file", "path": "/p.mp4"})
        );
    }

    /// Closing a remux deletes its copy; opening past the cap closes the
    /// oldest preview.
    #[test]
    fn closing_deletes_the_copy_and_the_cap_closes_the_oldest() {
        let dir = tempfile::tempdir().unwrap();
        let state = VideoEngineState::default();
        let mut paths = Vec::new();
        for i in 0..=MAX_SESSIONS {
            let path = dir.path().join(format!("{i}.mp4"));
            std::fs::write(&path, b"x").unwrap();
            state.insert(
                &format!("s{i}"),
                Entry::Remux {
                    path: path.clone(),
                    task: None,
                },
            );
            paths.push(path);
        }
        assert_eq!(state.open_count(), MAX_SESSIONS);
        assert!(!paths[0].exists(), "the oldest was closed and its copy deleted");
        state.close("s1");
        assert!(!paths[1].exists());
        state.close_all();
        assert_eq!(state.open_count(), 0);
        assert!(paths.iter().all(|p| !p.exists()));
    }
}
