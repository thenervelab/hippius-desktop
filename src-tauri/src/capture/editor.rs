//! The screenshot editor: crop, redact and annotate a screenshot, then put
//! the edited picture back where the screenshot was.
//!
//! `app/capture-editor` draws and edits the pixels; everything that decides
//! where they go is here. Rust opens the editor (from the capture card or a
//! Drive file's menu), hands it the picture, takes the flattened PNG back,
//! checks it, writes it over the file (the sync engine uploads the change,
//! or it is uploaded again to a drive only on the server) and settles the
//! share link.
//!
//! **The link.** A file share is a snapshot: hcfs re-encrypts a COPY of the
//! file under the link's own key, and there is no call that swaps that copy's
//! bytes. So an edited capture cannot keep its old URL. The capture card's
//! link is replaced: a new link is made from the edited file and copied, and
//! the old one is revoked, because the usual reason to edit a screenshot is
//! to hide something, and a link that still served the unedited picture would
//! leak exactly that. The old link is revoked even when the new one cannot be
//! made. A file opened from Drive may carry links with a password or an
//! expiry this device cannot recreate, so those are left alone and the user
//! is told they still show the earlier picture.
//!
//! **Annotate from the tray.** The popover's Annotate button opens the latest
//! screenshot or a picture the user picks in the system's file dialog. Rust
//! shows the dialog itself and reads only the file it answered with, so no
//! IPC ever names a path to read. A picked file inside one of the user's
//! own drives synced here is edited in place exactly like Drive's "Edit
//! image"; any other file is never written: Save files the edited picture
//! as a NEW screenshot in the capture drive (card, upload and link as for a
//! fresh capture), so the user's original outside Hippius stays as it was.

use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::destination::CaptureDestination;
use crate::app_state::AppState;
use crate::error::{AppError, Result};

/// The editor window's label (and its capability's only window).
pub const EDITOR_LABEL: &str = "capture-editor";

/// Sent to the editor when its window's close button is pressed, so a page
/// with unsaved changes can ask first. The window is not closed by the OS.
pub const CLOSE_REQUESTED_EVENT: &str = "capture_editor_close_requested";

/// The header the page names its session with, so a save meant for a picture
/// that has since been replaced is refused rather than written over another.
const SESSION_HEADER: &str = "x-editor-session";

/// Largest picture the editor takes or gives back, per side. Well above any
/// display (an 8K screen is 7680 wide), and a bound on the decode's memory.
pub const MAX_SIDE: u32 = 16_384;

/// Largest file the editor reads or accepts, in bytes.
pub const MAX_BYTES: usize = 200 * 1024 * 1024;

/// What kind of file is being edited; the edited picture is saved in it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EditableFormat {
    Png,
    Jpeg,
}

impl EditableFormat {
    /// The format of a file the editor can open, from its name; `None` for
    /// anything else (a recording, a GIF, a HEIC photo).
    #[must_use]
    pub fn from_name(name: &str) -> Option<Self> {
        let ext = Path::new(name).extension()?.to_str()?.to_ascii_lowercase();
        match ext.as_str() {
            "png" => Some(Self::Png),
            "jpg" | "jpeg" => Some(Self::Jpeg),
            _ => None,
        }
    }

    #[must_use]
    pub fn mime(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
        }
    }
}

/// Where the editor was opened from, which decides what happens to links.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditorOrigin {
    /// The capture card of capture `card_id`.
    Card { card_id: u64 },
    /// A file's menu in Drive.
    Drive,
    /// A picture picked in the tray's Annotate, outside every drive synced
    /// here: saved as a new screenshot, the original never written.
    Picked,
}

/// Where the edited picture is written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SaveTarget {
    /// A file in a drive synced on this computer: written over, and the sync
    /// engine uploads the change.
    Local(PathBuf),
    /// A capture in a drive that is only on the server: uploaded again into
    /// its Captures folder under the same name. `temp` is the card's own
    /// copy, which "Create link" reads, so it is brought up to date too.
    Remote { destination: CaptureDestination, temp: PathBuf },
    /// A picture outside the drives: a new screenshot is made from the
    /// edited picture and delivered like a fresh capture (see
    /// [`edited_copy_name`]). The picked file is never written.
    NewCapture,
}

/// The picture open in the editor. There is at most one.
#[derive(Debug, Clone)]
pub struct EditorSession {
    pub id: u64,
    pub origin: EditorOrigin,
    pub file_name: String,
    pub drive_label: String,
    pub drive_name: String,
    /// The file's path in its drive (`Captures/<name>` for a capture).
    pub rel_path: String,
    pub format: EditableFormat,
    pub target: SaveTarget,
    /// The link the card made, when it had one as the editor opened.
    pub share_token: Option<String>,
    /// The file as it was read, so the editor never reads a half-written
    /// file and a card closing meanwhile (which removes a temp copy) does
    /// not take the picture away.
    pub original: std::sync::Arc<Vec<u8>>,
}

/// What the editor page is told about the picture.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorContext {
    pub session: u64,
    pub file_name: String,
    pub drive_name: String,
    pub mime: &'static str,
    /// Rust's sentence about what Save does to the link, shown by Save.
    pub save_note: String,
}

impl EditorSession {
    #[must_use]
    pub fn context(&self) -> EditorContext {
        EditorContext {
            session: self.id,
            file_name: self.file_name.clone(),
            drive_name: self.drive_name.clone(),
            mime: self.format.mime(),
            save_note: save_note(self.origin, self.share_token.is_some()).to_string(),
        }
    }
}

/// The line beside Save, so the user knows before saving what happens to
/// the link.
#[must_use]
pub fn save_note(origin: EditorOrigin, has_card_link: bool) -> &'static str {
    match (origin, has_card_link) {
        (EditorOrigin::Card { .. }, true) => "Saving replaces the screenshot and its link. The old link stops working.",
        (EditorOrigin::Card { .. }, false) => "Saving replaces the screenshot in your drive.",
        (EditorOrigin::Drive, _) => "Saving replaces the file in your drive.",
        (EditorOrigin::Picked, _) => "Your original stays as it is. Saving uploads an edited copy, like a screenshot.",
    }
}

/// What Save does about links, decided from where the editor was opened.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkPlan {
    /// The card's link: make a new one from the edited file, revoke the old.
    Replace,
    /// Links made from Drive still show the earlier picture: say so.
    WarnStale,
    Nothing,
}

#[must_use]
pub fn link_plan(origin: EditorOrigin, card_link: bool, drive_file_shared: bool) -> LinkPlan {
    match origin {
        EditorOrigin::Card { .. } if card_link => LinkPlan::Replace,
        EditorOrigin::Drive if drive_file_shared => LinkPlan::WarnStale,
        EditorOrigin::Card { .. } | EditorOrigin::Drive | EditorOrigin::Picked => LinkPlan::Nothing,
    }
}

/// How the link came out of a save.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkResult {
    Unchanged,
    /// A new link was made (and `copied` to the clipboard) and the old one
    /// revoked (`old_revoked`).
    Replaced {
        copied: bool,
        old_revoked: bool,
    },
    /// No new link could be made; the old one was revoked or not.
    NotMade {
        old_revoked: bool,
    },
    /// Links made before still show the earlier picture.
    Stale,
}

/// What the user is told after a save, in Rust's words.
#[must_use]
pub fn saved_message(link: LinkResult) -> String {
    match link {
        LinkResult::Unchanged => "Screenshot saved.".into(),
        LinkResult::Replaced {
            copied: true,
            old_revoked: true,
        } => "Saved. The new link is copied, and the old link no longer works.".into(),
        LinkResult::Replaced {
            copied: false,
            old_revoked: true,
        } => "Saved. The new link is ready, and the old link no longer works.".into(),
        LinkResult::Replaced { old_revoked: false, .. } => {
            "Saved with a new link. The old link couldn't be turned off and still shows the earlier picture; revoke it from Shared Links.".into()
        }
        LinkResult::NotMade { old_revoked: true } => {
            "Saved. The old link no longer works, and a new one couldn't be made yet. Create one from the file in Drive.".into()
        }
        LinkResult::NotMade { old_revoked: false } => {
            "Saved, but the link couldn't be updated. The old link still shows the earlier picture; revoke it from Shared Links.".into()
        }
        LinkResult::Stale => "Saved. Links you shared before still show the earlier picture. Share the file again for a link to this version.".into(),
    }
}

/// Check the editor's PNG and turn it into the bytes to save: the PNG as
/// it came for a PNG, re-encoded for a JPEG. Returns the bytes and the
/// decoded picture (for the card's new thumbnail).
///
/// # Errors
///
/// [`AppError::Validation`] for anything that is not a sane PNG.
pub fn prepare_edited(bytes: &[u8], format: EditableFormat) -> Result<(Vec<u8>, image::RgbaImage)> {
    let rgba = decode_checked(bytes)?;
    let encoded = match format {
        EditableFormat::Png => bytes.to_vec(),
        EditableFormat::Jpeg => {
            let rgb = image::DynamicImage::ImageRgba8(rgba.clone()).to_rgb8();
            let mut out = Vec::new();
            image::codecs::jpeg::JpegEncoder::new_with_quality(std::io::Cursor::new(&mut out), JPEG_QUALITY)
                .encode_image(&rgb)
                .map_err(|e| AppError::Other(format!("Could not encode the edited picture: {e}")))?;
            out
        }
    };
    Ok((encoded, rgba))
}

const JPEG_QUALITY: u8 = 92;

const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

const NOT_A_PICTURE: &str = "The edited picture couldn't be read. Try saving again.";

/// Decode a PNG from the editor, refusing anything else, anything empty and
/// anything past [`MAX_SIDE`] / [`MAX_BYTES`]. The limits apply before the
/// pixels are allocated.
///
/// # Errors
///
/// [`AppError::Validation`] with the user's sentence.
pub fn decode_checked(bytes: &[u8]) -> Result<image::RgbaImage> {
    if bytes.len() > MAX_BYTES {
        return Err(AppError::Validation("The edited picture is too large to save.".into()));
    }
    if !bytes.starts_with(PNG_SIGNATURE) {
        return Err(AppError::Validation(NOT_A_PICTURE.into()));
    }
    let mut reader = image::ImageReader::with_format(std::io::Cursor::new(bytes), image::ImageFormat::Png);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_SIDE);
    limits.max_image_height = Some(MAX_SIDE);
    reader.limits(limits);
    let image = reader.decode().map_err(|_| AppError::Validation(NOT_A_PICTURE.into()))?;
    if image.width() == 0 || image.height() == 0 {
        return Err(AppError::Validation(NOT_A_PICTURE.into()));
    }
    Ok(image.to_rgba8())
}

/// `root` joined with a drive-relative path, refused when the path could
/// leave the drive (`..`, an absolute path, a drive prefix) or is empty.
///
/// # Errors
///
/// [`AppError::Validation`].
pub fn path_in_drive(root: &Path, rel_path: &str) -> Result<PathBuf> {
    let rel = Path::new(rel_path.trim_start_matches(['/', '\\']));
    let mut out = root.to_path_buf();
    let mut parts = 0;
    for component in rel.components() {
        match component {
            Component::Normal(part) => {
                out.push(part);
                parts += 1;
            }
            Component::CurDir => {}
            _ => return Err(AppError::Validation("That file isn't in this drive.".into())),
        }
    }
    if parts == 0 {
        return Err(AppError::Validation("That file isn't in this drive.".into()));
    }
    Ok(out)
}

/// Write `bytes` over `path` all at once: a hidden staging file in the same
/// folder (one the sync engine never lists, like a capture's cross-volume
/// copy), flushed, then renamed over the file. A save that fails half-way
/// leaves the old picture whole, and the engine never uploads half a file.
///
/// # Errors
///
/// The I/O error; the staging file is removed.
pub fn replace_atomically(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let dir = path.parent().ok_or_else(|| std::io::Error::other("the file has no folder"))?;
    let staging = dir.join(format!(".hippius-incoming-capture-{}.part", uuid::Uuid::new_v4().simple()));
    let written = (|| {
        let mut file = std::fs::File::create(&staging)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&staging, path)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&staging);
    }
    written
}

/// The editor window's size for a picture of `width` x `height` pixels at
/// `scale`, in logical points: the picture at its natural size plus the
/// toolbars, inside `max` (the screen's usable area), never below the
/// smallest window the toolbar fits in.
#[must_use]
pub fn window_size(width: u32, height: u32, scale: f64, max: (f64, f64)) -> (f64, f64) {
    const CHROME_W: f64 = 48.0;
    const CHROME_H: f64 = 140.0;
    const MIN: (f64, f64) = (720.0, 520.0);
    let scale = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    let want_w = f64::from(width) / scale + CHROME_W;
    let want_h = f64::from(height) / scale + CHROME_H;
    let cap_w = (max.0 * 0.9).max(MIN.0);
    let cap_h = (max.1 * 0.9).max(MIN.1);
    (want_w.clamp(MIN.0, cap_w).round(), want_h.clamp(MIN.1, cap_h).round())
}

// ── Annotate from the tray ──────────────────────────────────────────────────

/// The drive a picked file is in, and its path there with `/` separators:
/// the deepest of `roots` (label, folder) that holds `file`. Both sides must
/// already be canonical, so a link or `..` cannot make a file look inside.
/// `None` for a file outside every drive, or a drive's own folder.
#[must_use]
pub fn locate_in_drives(file: &Path, roots: &[(String, PathBuf)]) -> Option<(String, String)> {
    roots
        .iter()
        .filter_map(|(label, root)| {
            let rel = file.strip_prefix(root).ok()?;
            let parts: Vec<&str> = rel
                .components()
                .map(|c| match c {
                    Component::Normal(part) => part.to_str(),
                    _ => None,
                })
                .collect::<Option<_>>()?;
            (!parts.is_empty()).then(|| (root.components().count(), label.clone(), parts.join("/")))
        })
        .max_by_key(|(depth, ..)| *depth)
        .map(|(_, label, rel)| (label, rel))
}

/// What the new screenshot made from a picked picture is called: its name
/// with " (edited)" before the extension, so it reads as the user's picture.
/// Characters a Windows drive cannot hold become `-`, since the copy is
/// uploaded into a drive any of the user's machines may sync.
#[must_use]
pub fn edited_copy_name(original: &str) -> String {
    // Split by hand, not with `Path`: the same on every platform.
    let (stem, ext) = original.rsplit_once('.').unwrap_or((original, "png"));
    let stem = if stem.trim().is_empty() { "Picture" } else { stem };
    let clean: String = stem
        .chars()
        .map(|c| {
            if matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|' | '/' | '\\') || c.is_control() {
                '-'
            } else {
                c
            }
        })
        .collect();
    format!("{} (edited).{ext}", clean.trim())
}

/// The newest picture the editor can open among a folder's files (name,
/// modified time); hidden files (a save's staging file among them) never.
#[must_use]
pub fn newest_editable(files: impl IntoIterator<Item = (String, std::time::SystemTime)>) -> Option<String> {
    files
        .into_iter()
        .filter(|(name, _)| !name.starts_with('.') && EditableFormat::from_name(name).is_some())
        .max_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)))
        .map(|(name, _)| name)
}

/// Where the file dialog opens: the first of `candidates` (the capture
/// folder synced here, then Pictures, then Desktop) that is a folder.
#[must_use]
pub fn picker_start(candidates: impl IntoIterator<Item = Option<PathBuf>>, is_dir: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    candidates.into_iter().flatten().find(|p| is_dir(p))
}

/// The latest screenshot Annotate offers, for the popover's menu.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatestScreenshot {
    pub file_name: String,
}

// ── Commands ────────────────────────────────────────────────────────────────

use super::commands::{lock, update_card};
use super::preview::{LinkState, PreviewCard};

/// "Edit" on the capture card: the screenshot opens in the editor.
#[tauri::command]
pub async fn capture_preview_edit(state: tauri::State<'_, AppState>, app: AppHandle) -> Result<()> {
    let card: PreviewCard = lock(&state.capture.preview)
        .clone()
        .filter(|c| c.actions.edit)
        .ok_or_else(|| AppError::Validation("This capture can't be edited right now.".into()))?;
    refuse_if_open(&app)?;
    let placed = card
        .placed_path
        .clone()
        .ok_or_else(|| AppError::Validation("This capture can't be edited right now.".into()))?;
    let format = EditableFormat::from_name(&card.file_name).ok_or_else(|| AppError::Validation("Only screenshots can be edited.".into()))?;
    let original = read_original(placed.clone()).await?;
    let target = if card.remote {
        SaveTarget::Remote {
            destination: card.destination.clone(),
            temp: placed,
        }
    } else {
        SaveTarget::Local(placed)
    };
    let session = EditorSession {
        id: next_session_id(&state),
        origin: EditorOrigin::Card { card_id: card.id },
        file_name: card.file_name.clone(),
        drive_label: card.drive_label.clone(),
        drive_name: card.drive_name.clone(),
        rel_path: card.rel_path.clone(),
        format,
        target,
        share_token: card.share_token.clone(),
        original: std::sync::Arc::new(original),
    };
    open_with(&app, session)
}

/// "Edit image" on a Drive file: a PNG or JPEG in a drive of this account's
/// that is synced on this computer.
#[tauri::command]
pub async fn capture_editor_open_file(state: tauri::State<'_, AppState>, app: AppHandle, label: String, relative_path: String) -> Result<()> {
    let account_id = state.current_account_id()?;
    let pool = state.pool()?;
    refuse_if_open(&app)?;
    let root = super::destination::own_local_path(pool, &account_id, &label)
        .await?
        .ok_or_else(|| AppError::Validation("Only files in your own drives synced on this computer can be edited.".into()))?;
    let path = path_in_drive(&root, &relative_path)?;
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| AppError::Validation("That file has no usable name.".into()))?
        .to_string();
    let format = EditableFormat::from_name(&file_name).ok_or_else(|| AppError::Validation("Only PNG and JPEG pictures can be edited.".into()))?;
    // The file must really be inside the drive once links are followed.
    let inside = tokio::task::spawn_blocking({
        let (root, path) = (root.clone(), path.clone());
        move || -> std::io::Result<bool> { Ok(path.canonicalize()?.starts_with(root.canonicalize()?)) }
    })
    .await
    .map_err(|e| AppError::Other(format!("editor open task failed: {e}")))??;
    if !inside {
        return Err(AppError::Validation("That file isn't in this drive.".into()));
    }
    let original = read_original(path.clone()).await?;
    let drive_name = super::destination::load(pool, &account_id)
        .await
        .ok()
        .flatten()
        .filter(|d| d.label == label)
        .map_or_else(|| label.clone(), |d| d.display_name);
    let session = EditorSession {
        id: next_session_id(&state),
        origin: EditorOrigin::Drive,
        file_name,
        drive_label: label,
        drive_name,
        rel_path: relative_path.trim_start_matches(['/', '\\']).replace('\\', "/"),
        format,
        target: SaveTarget::Local(path),
        share_token: None,
        original: std::sync::Arc::new(original),
    };
    open_with(&app, session)
}

/// What the editor page shows about the picture; `None` once it is closed.
#[tauri::command]
pub fn capture_editor_context(state: tauri::State<'_, AppState>) -> Option<EditorContext> {
    lock(&state.capture.editor).as_ref().map(EditorSession::context)
}

/// The picture's bytes, raw (a JSON array would be several times its size).
#[tauri::command]
pub fn capture_editor_image(state: tauri::State<'_, AppState>) -> Result<tauri::ipc::Response> {
    let bytes = lock(&state.capture.editor)
        .as_ref()
        .map(|s| s.original.clone())
        .ok_or_else(|| AppError::Validation("Nothing is open in the editor.".into()))?;
    Ok(tauri::ipc::Response::new(bytes.as_ref().clone()))
}

/// The outcome of Save, for the editor.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveOutcome {
    pub message: String,
}

/// Save: the editor's flattened PNG (the raw request body) replaces the
/// file, which is uploaded again, and the link is settled (see the module
/// note). The editor closes itself on success.
#[tauri::command]
pub async fn capture_editor_save(state: tauri::State<'_, AppState>, app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<SaveOutcome> {
    let session = session_for(&state, &request)?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(AppError::Validation(NOT_A_PICTURE.into()));
    };
    let account_id = state.current_account_id()?;
    let bytes = bytes.clone();
    let format = session.format;
    let (encoded, rgba) = tokio::task::spawn_blocking(move || prepare_edited(&bytes, format))
        .await
        .map_err(|e| AppError::Other(format!("editor save task failed: {e}")))??;
    if session.target == SaveTarget::NewCapture {
        return save_as_new_capture(&app, &session, encoded, &rgba).await;
    }

    // The card's link as it is NOW: it may have been made after the editor
    // opened. A link still being made would be made from the old picture.
    let card_id = match session.origin {
        EditorOrigin::Card { card_id } => Some(card_id),
        EditorOrigin::Drive | EditorOrigin::Picked => None,
    };
    let card_now = card_id.and_then(|id| lock(&state.capture.preview).clone().filter(|c| c.id == id));
    if card_now.as_ref().is_some_and(|c| c.link == LinkState::Creating) {
        return Err(AppError::Validation("The link is still being made. Save again in a moment.".into()));
    }
    let old_token = match &card_now {
        Some(card) => card.share_token.clone(),
        None => session.share_token.clone(),
    };

    let written = write_edited(&state, &app, &account_id, &session, &encoded).await?;

    let drive_shared = if session.origin == EditorOrigin::Drive {
        let owner = crate::auth::account_key::account_key(&account_id);
        crate::shares::origin::is_shared(state.pool()?, &owner, &session.drive_label, &session.rel_path)
            .await
            .unwrap_or(false)
    } else {
        false
    };
    let mut new_link = None;
    let link = match link_plan(session.origin, old_token.is_some(), drive_shared) {
        LinkPlan::Nothing => LinkResult::Unchanged,
        LinkPlan::WarnStale => LinkResult::Stale,
        LinkPlan::Replace => {
            let (result, minted) = replace_link(&state, &app, &account_id, &written.link_source, old_token.as_deref()).await;
            new_link = minted;
            result
        }
    };
    if let Some(temp_dir) = written.own_temp_dir {
        let _ = std::fs::remove_dir_all(temp_dir);
    }

    let message = saved_message(link);
    let thumbnail = super::thumbnail::from_image(&image::DynamicImage::ImageRgba8(rgba)).ok();
    let shown = card_id.is_some_and(|id| {
        update_card(&app, &state.capture, id, |card| {
            if thumbnail.is_some() {
                card.thumbnail.clone_from(&thumbnail);
            }
            match &new_link {
                Some((url, token, copied)) => {
                    card.share_url = Some(url.clone());
                    card.share_token = Some(token.clone());
                    card.link = LinkState::Public { copied: *copied };
                }
                None if matches!(link, LinkResult::NotMade { old_revoked: true }) => {
                    card.share_url = None;
                    card.share_token = None;
                    card.link = LinkState::Revoked;
                }
                None => {}
            }
        })
    });
    // The card says what happened to the link when it is there; otherwise a
    // notification does, but only when there is more to say than "saved".
    if !shown && link != LinkResult::Unchanged {
        super::commands::notify(&app, "Screenshot saved".into(), message.clone());
    }
    tracing::info!(session = session.id, "screenshot edited and saved");
    Ok(SaveOutcome { message })
}

/// Copy: the editor's flattened PNG (the raw request body) on the clipboard
/// as a picture.
#[tauri::command]
pub async fn capture_editor_copy(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<()> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(AppError::Validation(NOT_A_PICTURE.into()));
    };
    let bytes = bytes.clone();
    let rgba = tokio::task::spawn_blocking(move || decode_checked(&bytes))
        .await
        .map_err(|e| AppError::Other(format!("editor copy task failed: {e}")))??;
    let (w, h) = (rgba.width(), rgba.height());
    app.clipboard()
        .write_image(&tauri::image::Image::new_owned(rgba.into_raw(), w, h))
        .map_err(|e| {
            tracing::warn!(error = %e, "edited screenshot not copied");
            AppError::Validation("The picture couldn't be copied. Try again.".into())
        })
}

/// Cancel, or the window's close button once the page agreed: the editor
/// goes and its picture is forgotten. Nothing is written.
#[tauri::command]
pub fn capture_editor_close(state: tauri::State<'_, AppState>, app: AppHandle) {
    lock(&state.capture.editor).take();
    if let Some(w) = app.get_webview_window(EDITOR_LABEL) {
        // `destroy`, not `close`: close asks the page again (see `open_with`).
        let _ = w.destroy();
    }
}

fn next_session_id(state: &AppState) -> u64 {
    state.capture.editor_seq.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1
}

/// One picture at a time: an open editor is brought forward and the new
/// one refused, so unsaved changes are never thrown away by another click.
fn refuse_if_open(app: &AppHandle) -> Result<()> {
    if let Some(w) = app.get_webview_window(EDITOR_LABEL) {
        let _ = w.unminimize();
        let _ = w.set_focus();
        return Err(AppError::Validation(
            "Another picture is open in the editor. Save or cancel it first.".into(),
        ));
    }
    Ok(())
}

async fn read_original(path: PathBuf) -> Result<Vec<u8>> {
    tokio::task::spawn_blocking(move || -> Result<Vec<u8>> {
        let len = std::fs::metadata(&path)?.len();
        if usize::try_from(len).map_or(true, |l| l > MAX_BYTES) {
            return Err(AppError::Validation("This picture is too large to edit.".into()));
        }
        Ok(std::fs::read(&path)?)
    })
    .await
    .map_err(|e| AppError::Other(format!("editor read task failed: {e}")))?
}

/// The session the request names; a request for a session that has since
/// been replaced or closed is refused.
fn session_for(state: &AppState, request: &tauri::ipc::Request<'_>) -> Result<EditorSession> {
    let named = request
        .headers()
        .get(SESSION_HEADER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    lock(&state.capture.editor)
        .clone()
        .filter(|s| Some(s.id) == named)
        .ok_or_else(|| AppError::Validation("This picture is no longer open in the editor.".into()))
}

/// Store the session and show its window.
fn open_with(app: &AppHandle, session: EditorSession) -> Result<()> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    let (w, h) = image::ImageReader::new(std::io::Cursor::new(session.original.as_slice()))
        .with_guessed_format()
        .ok()
        .and_then(|r| r.into_dimensions().ok())
        .unwrap_or((1280, 800));
    let title = format!("Edit {}", session.file_name);
    let state = app.state::<AppState>();
    *lock(&state.capture.editor) = Some(session);

    let monitor = app
        .get_webview_window(super::commands::MAIN_WINDOW_LABEL)
        .and_then(|m| m.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    let (scale, max) = monitor.map_or((2.0, (1440.0, 900.0)), |m| {
        let s = m.scale_factor();
        let size = m.size().to_logical::<f64>(s);
        (s, (size.width, size.height))
    });
    let (width, height) = window_size(w, h, scale, max);
    let route = if cfg!(dev) { "capture-editor" } else { "capture-editor.html" };
    let built = WebviewWindowBuilder::new(app, EDITOR_LABEL, WebviewUrl::App(route.into()))
        .title(title)
        .inner_size(width, height)
        .min_inner_size(720.0, 520.0)
        .resizable(true)
        .center()
        .focused(true)
        .build();
    let window = match built {
        Ok(w) => w,
        Err(e) => {
            lock(&state.capture.editor).take();
            return Err(AppError::Other(format!("Could not open the editor: {e}")));
        }
    };
    let handle = app.clone();
    window.on_window_event(move |event| match event {
        // The page decides: it asks first when there are unsaved changes,
        // then calls `capture_editor_close`.
        tauri::WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let _ = handle.emit_to(EDITOR_LABEL, CLOSE_REQUESTED_EVENT, ());
        }
        tauri::WindowEvent::Destroyed => {
            lock(&handle.state::<AppState>().capture.editor).take();
        }
        _ => {}
    });
    let _ = window.set_focus();
    Ok(())
}

/// Where the edited picture went.
struct Written {
    /// For a link: the file in the synced drive, or the copy that was uploaded.
    link_source: super::deliver::LinkSource,
    /// A temp folder made for this save alone, removed once done.
    own_temp_dir: Option<PathBuf>,
}

async fn write_edited(state: &AppState, app: &AppHandle, account_id: &str, session: &EditorSession, encoded: &[u8]) -> Result<Written> {
    match &session.target {
        SaveTarget::Local(path) => {
            let (path, bytes) = (path.clone(), encoded.to_vec());
            tokio::task::spawn_blocking(move || replace_atomically(&path, &bytes))
                .await
                .map_err(|e| AppError::Other(format!("editor write task failed: {e}")))?
                .map_err(|e| {
                    tracing::warn!(error = %e, "edited screenshot not written");
                    AppError::Validation("The screenshot couldn't be saved. Check the drive's folder is still there.".into())
                })?;
            // Not awaited: it runs a whole sync round (see `deliver::place`).
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = crate::sync::control::trigger_sync_now(app).await {
                    tracing::warn!(error = %e, "edited screenshot saved; sync not nudged");
                }
            });
            Ok(Written {
                link_source: super::deliver::LinkSource::Synced {
                    label: session.drive_label.clone(),
                    rel_path: session.rel_path.clone(),
                },
                own_temp_dir: None,
            })
        }
        SaveTarget::Remote { destination, temp } => {
            // The card's copy when it is still there (its "Create link"
            // reads it), else a folder of this save's own.
            let (file, own_temp_dir) = if temp.parent().is_some_and(Path::is_dir) {
                (temp.clone(), None)
            } else {
                let dir = super::screenshot::fresh_capture_dir(&super::screenshot::capture_tmp_root()?)?;
                (dir.join(&session.file_name), Some(dir))
            };
            let (to, bytes) = (file.clone(), encoded.to_vec());
            tokio::task::spawn_blocking(move || replace_atomically(&to, &bytes))
                .await
                .map_err(|e| AppError::Other(format!("editor write task failed: {e}")))??;
            let source = file
                .to_str()
                .ok_or_else(|| AppError::Other("Capture path is not valid UTF-8".into()))?
                .to_string();
            let uploaded = crate::sync::remote_upload::upload_files_to_remote_folder_inner(
                state,
                app.clone(),
                account_id,
                &destination.label,
                destination.upload_folder(),
                &[source],
                destination.owner_ss58.clone(),
                destination.folder_hash.clone(),
            )
            .await;
            let failure = match uploaded {
                Ok(failures) => failures.into_iter().next().map(|f| AppError::Other(f.error)),
                Err(e) => Some(e),
            };
            if let Some(e) = failure {
                if let Some(dir) = &own_temp_dir {
                    let _ = std::fs::remove_dir_all(dir);
                }
                tracing::warn!(error = %e, "edited screenshot not uploaded");
                return Err(AppError::Validation(super::deliver::failure_copy(&e)));
            }
            Ok(Written {
                link_source: super::deliver::LinkSource::External(file),
                own_temp_dir,
            })
        }
        // Handled by `save_as_new_capture` before any write: the picked
        // file is never the one written.
        SaveTarget::NewCapture => Err(AppError::Other("a picked picture is saved as a new screenshot".into())),
    }
}

/// Make the new link from the edited file, copy it, then revoke the old
/// one, which goes even when no new link could be made (see the module note).
/// Returns the outcome and the new link: url, token, whether it was copied.
async fn replace_link(
    state: &tauri::State<'_, AppState>,
    app: &AppHandle,
    account_id: &str,
    source: &super::deliver::LinkSource,
    old_token: Option<&str>,
) -> (LinkResult, Option<(String, String, bool)>) {
    let minted = super::deliver::mint(state, account_id, source).await;
    let old_revoked = match old_token {
        Some(token) => match crate::shares::commands::hcfs_revoke_share(state.clone(), token.to_string()).await {
            Ok(()) => true,
            Err(e) => {
                tracing::warn!(error = %e, "edited screenshot's old link not revoked");
                false
            }
        },
        None => true,
    };
    match minted {
        Ok(link) => {
            let copied = super::commands::copy_link_to_clipboard(app, Some(&link.share_url));
            (
                LinkResult::Replaced { copied, old_revoked },
                Some((link.share_url, link.share_token, copied)),
            )
        }
        Err(_) => (LinkResult::NotMade { old_revoked }, None),
    }
}

/// Where the latest screenshot is: on the capture card still showing (its
/// link is replaced on save, as from the card), or the newest picture in
/// the capture folder of a drive synced here (edited as from Drive).
enum Latest {
    Card,
    InFolder { label: String, rel_path: String, file_name: String },
}

async fn find_latest(state: &AppState, account_id: &str) -> Result<Option<Latest>> {
    if lock(&state.capture.preview).as_ref().is_some_and(|c| c.actions.edit) {
        return Ok(Some(Latest::Card));
    }
    let pool = state.pool()?;
    let Some(destination) = super::destination::load(pool, account_id).await.ok().flatten() else {
        return Ok(None);
    };
    let Some(root) = super::destination::own_local_path(pool, account_id, &destination.label).await? else {
        return Ok(None);
    };
    let dir = root.join(&destination.folder);
    let newest = tokio::task::spawn_blocking(move || {
        let Ok(entries) = std::fs::read_dir(&dir) else { return None };
        newest_editable(entries.flatten().filter_map(|entry| {
            let meta = entry.metadata().ok().filter(std::fs::Metadata::is_file)?;
            Some((entry.file_name().to_str()?.to_string(), meta.modified().ok()?))
        }))
    })
    .await
    .map_err(|e| AppError::Other(format!("latest screenshot task failed: {e}")))?;
    Ok(newest.map(|file_name| Latest::InFolder {
        rel_path: destination.rel_path(&file_name),
        label: destination.label,
        file_name,
    }))
}

/// Tell the user why Annotate opened nothing: the popover is already gone.
fn tell_not_opened(app: &AppHandle, e: &AppError) {
    let body = match e {
        AppError::Validation(message) => message.clone(),
        other => {
            tracing::warn!(error = %other, "annotate: picture not opened");
            "The picture couldn't be opened. Try again.".to_string()
        }
    };
    super::commands::notify(app, "Couldn't open the picture".into(), body);
}

/// The tray's Annotate: the latest screenshot, when there is one.
#[tauri::command]
pub async fn capture_annotate_latest(state: tauri::State<'_, AppState>) -> Result<Option<LatestScreenshot>> {
    let account_id = state.current_account_id()?;
    let file_name = match find_latest(&state, &account_id).await? {
        Some(Latest::Card) => lock(&state.capture.preview).as_ref().map(|c| c.file_name.clone()),
        Some(Latest::InFolder { file_name, .. }) => Some(file_name),
        None => None,
    };
    Ok(file_name.map(|file_name| LatestScreenshot { file_name }))
}

/// "Latest screenshot" in the tray's Annotate menu: decided again here, so
/// the page names nothing. `false` when there is none any more.
#[tauri::command]
pub async fn capture_annotate_open_latest(state: tauri::State<'_, AppState>, app: AppHandle) -> Result<bool> {
    let opened = async {
        let account_id = state.current_account_id()?;
        match find_latest(&state, &account_id).await? {
            Some(Latest::Card) => capture_preview_edit(state.clone(), app.clone()).await.map(|()| true),
            Some(Latest::InFolder { label, rel_path, .. }) => {
                capture_editor_open_file(state.clone(), app.clone(), label, rel_path).await.map(|()| true)
            }
            None => Ok(false),
        }
    }
    .await;
    if let Err(e) = &opened {
        tell_not_opened(&app, e);
    }
    opened
}

/// One file dialog at a time: a second Annotate press while one is open
/// does nothing.
static PICKING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// "Choose image…" in the tray's Annotate: the system's file dialog, shown
/// by Rust, and the one file it answers with opened in the editor. The page
/// passes no path, so this can read nothing the user did not pick. `false`
/// when the user cancelled (or a dialog is already open).
#[tauri::command]
pub async fn capture_annotate_pick(state: tauri::State<'_, AppState>, app: AppHandle) -> Result<bool> {
    use std::sync::atomic::Ordering;
    if PICKING.swap(true, Ordering::SeqCst) {
        return Ok(false);
    }
    let opened = pick_and_open(&state, &app).await;
    PICKING.store(false, Ordering::SeqCst);
    if let Err(e) = &opened {
        tell_not_opened(&app, e);
    }
    opened
}

async fn pick_and_open(state: &tauri::State<'_, AppState>, app: &AppHandle) -> Result<bool> {
    use tauri_plugin_dialog::DialogExt;
    let account_id = state.current_account_id()?;
    refuse_if_open(app)?;
    let pool = state.pool()?;
    let capture_folder = match super::destination::load(pool, &account_id).await.ok().flatten() {
        Some(d) => super::destination::own_local_path(pool, &account_id, &d.label)
            .await
            .ok()
            .flatten()
            .map(|root| root.join(&d.folder)),
        None => None,
    };
    let start = picker_start([capture_folder, dirs::picture_dir(), dirs::desktop_dir()], Path::is_dir);

    let mut dialog = app
        .dialog()
        .file()
        .set_title("Choose a picture to annotate")
        .add_filter("Images", &["png", "jpg", "jpeg"]);
    if let Some(dir) = start {
        dialog = dialog.set_directory(dir);
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    dialog.pick_file(move |picked| {
        let _ = tx.send(picked);
    });
    let Some(picked) = rx.await.ok().flatten() else {
        return Ok(false);
    };
    let picked = picked
        .into_path()
        .map_err(|_| AppError::Validation("That file can't be opened from here.".into()))?;
    open_picked(state, app, &account_id, picked).await.map(|()| true)
}

/// Open the file the dialog answered with: in place when it is in one of
/// this account's own drives synced here (the same path and checks as
/// Drive's "Edit image"), else as a picture whose edit becomes a new
/// screenshot.
async fn open_picked(state: &tauri::State<'_, AppState>, app: &AppHandle, account_id: &str, picked: PathBuf) -> Result<()> {
    let pool = state.pool()?;
    let mut roots = Vec::new();
    // `own_local_path` only answers for an own drive whose sync is running,
    // so a member or paused drive falls through to "edit becomes a new
    // screenshot" below.
    for drive in super::destination::drives_here(pool, account_id).await?.into_iter().filter(|d| !d.member) {
        if let Some(root) = super::destination::own_local_path(pool, account_id, &drive.label).await? {
            roots.push((drive.label, root));
        }
    }
    let (file, roots) = tokio::task::spawn_blocking(move || -> std::io::Result<_> {
        let file = picked.canonicalize()?;
        if !std::fs::metadata(&file)?.is_file() {
            return Err(std::io::Error::other("not a file"));
        }
        let roots: Vec<(String, PathBuf)> = roots
            .into_iter()
            .filter_map(|(label, root)| root.canonicalize().ok().map(|r| (label, r)))
            .collect();
        Ok((file, roots))
    })
    .await
    .map_err(|e| AppError::Other(format!("annotate open task failed: {e}")))?
    .map_err(|_| AppError::Validation("That file can't be opened. It may have been moved.".into()))?;

    if let Some((label, rel_path)) = locate_in_drives(&file, &roots) {
        return capture_editor_open_file(state.clone(), app.clone(), label, rel_path).await;
    }

    let file_name = file
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| AppError::Validation("That file has no usable name.".into()))?
        .to_string();
    let format = EditableFormat::from_name(&file_name).ok_or_else(|| AppError::Validation("Only PNG and JPEG pictures can be edited.".into()))?;
    let original = read_original(file).await?;
    let drive_name = super::destination::load(pool, account_id)
        .await
        .ok()
        .flatten()
        .map_or_else(|| super::naming::DEFAULT_DRIVE_NAME.to_string(), |d| d.display_name);
    let session = EditorSession {
        id: next_session_id(state),
        origin: EditorOrigin::Picked,
        file_name,
        drive_label: String::new(),
        drive_name,
        rel_path: String::new(),
        format,
        target: SaveTarget::NewCapture,
        share_token: None,
        original: std::sync::Arc::new(original),
    };
    open_with(app, session)
}

/// Save for a picked picture: the edited picture becomes a new screenshot
/// in a capture folder of its own and goes through the capture card and
/// delivery like a fresh capture (drive, upload, link). The original file
/// is never touched.
async fn save_as_new_capture(app: &AppHandle, session: &EditorSession, encoded: Vec<u8>, rgba: &image::RgbaImage) -> Result<SaveOutcome> {
    let name = edited_copy_name(&session.file_name);
    let dir = super::screenshot::fresh_capture_dir(&super::screenshot::capture_tmp_root()?)?;
    let path = dir.join(&name);
    let written = tokio::task::spawn_blocking({
        let path = path.clone();
        move || std::fs::write(&path, &encoded)
    })
    .await
    .map_err(|e| AppError::Other(format!("editor write task failed: {e}")))?;
    if let Err(e) = written {
        let _ = std::fs::remove_dir_all(&dir);
        tracing::warn!(error = %e, "edited picture not written");
        return Err(AppError::Validation("The picture couldn't be saved. Try again.".into()));
    }
    let thumbnail = super::thumbnail::from_image(&image::DynamicImage::ImageRgba8(rgba.clone())).ok();
    super::commands::deliver_as_new_screenshot(app, &path, thumbnail).await;
    tracing::info!(session = session.id, "picked picture edited and saved as a new screenshot");
    Ok(SaveOutcome {
        message: format!("Saved as {name} in {}. Your original is unchanged.", session.drive_name),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(width: u32, height: u32) -> Vec<u8> {
        let image = image::RgbaImage::from_pixel(width, height, image::Rgba([10, 20, 30, 255]));
        let mut out = Vec::new();
        image::DynamicImage::ImageRgba8(image)
            .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
            .unwrap();
        out
    }

    #[test]
    fn only_pngs_and_jpegs_open_in_the_editor() {
        assert_eq!(
            EditableFormat::from_name("Screenshot 2026-10-05 at 10.00.00.png"),
            Some(EditableFormat::Png)
        );
        assert_eq!(EditableFormat::from_name("photo.JPG"), Some(EditableFormat::Jpeg));
        assert_eq!(EditableFormat::from_name("photo.jpeg"), Some(EditableFormat::Jpeg));
        assert_eq!(EditableFormat::from_name("Recording.mp4"), None);
        assert_eq!(EditableFormat::from_name("png"), None);
        assert_eq!(EditableFormat::from_name("anim.gif"), None);
    }

    #[test]
    fn the_editors_png_is_saved_as_it_came_for_a_png() {
        let bytes = png(4, 3);
        let (saved, rgba) = prepare_edited(&bytes, EditableFormat::Png).unwrap();
        assert_eq!(saved, bytes);
        assert_eq!((rgba.width(), rgba.height()), (4, 3));
    }

    /// A JPEG stays a JPEG: PNG bytes under a .jpg name would be a file no
    /// viewer agrees about.
    #[test]
    fn a_jpeg_is_saved_as_a_jpeg() {
        let (saved, _) = prepare_edited(&png(8, 8), EditableFormat::Jpeg).unwrap();
        assert_eq!(&saved[..3], &[0xFF, 0xD8, 0xFF], "JPEG start-of-image");
        assert_eq!(image::guess_format(&saved).unwrap(), image::ImageFormat::Jpeg);
    }

    #[test]
    fn anything_but_a_sane_png_is_refused() {
        for bad in [Vec::new(), b"not a picture".to_vec(), {
            let mut truncated = png(4, 4);
            truncated.truncate(30);
            truncated
        }] {
            let e = decode_checked(&bad).unwrap_err();
            assert!(matches!(e, AppError::Validation(_)), "{e:?}");
        }
        // A JPEG is not what the editor sends.
        let (jpeg, _) = prepare_edited(&png(2, 2), EditableFormat::Jpeg).unwrap();
        assert!(decode_checked(&jpeg).is_err());
    }

    /// The limit applies to the header, before the pixels are allocated.
    #[test]
    fn a_picture_past_the_side_limit_is_refused() {
        let mut header = png(1, 1);
        // IHDR width is bytes 16..20.
        header[16..20].copy_from_slice(&(MAX_SIDE + 1).to_be_bytes());
        assert!(decode_checked(&header).is_err());
    }

    #[test]
    fn a_drive_path_never_leaves_the_drive() {
        let root = Path::new("/Users/x/Hippius/Work");
        assert_eq!(
            path_in_drive(root, "Captures/Shot.png").unwrap(),
            Path::new("/Users/x/Hippius/Work/Captures/Shot.png")
        );
        assert_eq!(path_in_drive(root, "/Captures/Shot.png").unwrap(), root.join("Captures/Shot.png"));
        assert_eq!(path_in_drive(root, "./a.png").unwrap(), root.join("a.png"));
        for bad in ["../other/a.png", "Captures/../../a.png", "", "/", "."] {
            assert!(path_in_drive(root, bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_save_replaces_the_file_whole_and_leaves_no_staging_file() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("Shot.png");
        std::fs::write(&file, b"old").unwrap();
        replace_atomically(&file, b"new picture").unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"new picture");
        assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 1, "no staging file left");
    }

    #[test]
    fn a_failed_save_keeps_the_old_picture() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("gone").join("Shot.png");
        assert!(replace_atomically(&missing, b"new").is_err());
        assert!(!missing.exists());
    }

    /// The card's link is replaced; a Drive file's links are reported, never
    /// replaced (a password or an expiry can't be made again here).
    #[test]
    fn the_link_plan_follows_where_the_editor_opened() {
        let card = EditorOrigin::Card { card_id: 3 };
        assert_eq!(link_plan(card, true, false), LinkPlan::Replace);
        assert_eq!(link_plan(card, false, true), LinkPlan::Nothing);
        assert_eq!(link_plan(EditorOrigin::Drive, true, true), LinkPlan::WarnStale);
        assert_eq!(link_plan(EditorOrigin::Drive, false, false), LinkPlan::Nothing);
    }

    #[test]
    fn every_save_outcome_says_where_the_link_stands() {
        assert_eq!(saved_message(LinkResult::Unchanged), "Screenshot saved.");
        let replaced = saved_message(LinkResult::Replaced {
            copied: true,
            old_revoked: true,
        });
        assert!(
            replaced.contains("new link is copied") && replaced.contains("no longer works"),
            "{replaced}"
        );
        let kept_old = saved_message(LinkResult::Replaced {
            copied: true,
            old_revoked: false,
        });
        assert!(kept_old.contains("still shows the earlier picture"), "{kept_old}");
        let none = saved_message(LinkResult::NotMade { old_revoked: true });
        assert!(none.contains("no longer works") && none.contains("Create one"), "{none}");
        assert!(saved_message(LinkResult::NotMade { old_revoked: false }).contains("still shows the earlier picture"));
        assert!(saved_message(LinkResult::Stale).contains("still show the earlier picture"));
        for link in [
            LinkResult::Unchanged,
            LinkResult::Replaced {
                copied: false,
                old_revoked: true,
            },
            LinkResult::Stale,
        ] {
            assert!(!saved_message(link).contains('\u{2014}'), "no em dash in user copy");
        }
    }

    #[test]
    fn the_note_beside_save_warns_when_the_link_will_change() {
        assert!(save_note(EditorOrigin::Card { card_id: 1 }, true).contains("old link stops working"));
        assert!(!save_note(EditorOrigin::Card { card_id: 1 }, false).contains("link"));
        assert!(!save_note(EditorOrigin::Drive, false).contains("link"));
    }

    #[test]
    fn the_window_fits_the_picture_inside_the_screen() {
        // A small Retina shot: natural size plus chrome, never under the minimum.
        assert_eq!(window_size(400, 300, 2.0, (1512.0, 982.0)), (720.0, 520.0));
        // A whole Retina screen: capped at 90% of the screen.
        let (w, h) = window_size(3024, 1964, 2.0, (1512.0, 982.0));
        assert!(w <= 1512.0 * 0.9 + 0.5 && h <= 982.0 * 0.9 + 0.5, "{w}x{h}");
        // A medium shot at 1x is shown at its size.
        assert_eq!(window_size(900, 500, 1.0, (1920.0, 1080.0)), (948.0, 640.0));
        // A bad scale does not divide by zero.
        assert_eq!(window_size(900, 500, 0.0, (1920.0, 1080.0)), (948.0, 640.0));
    }

    #[test]
    fn the_context_names_the_session_and_the_format() {
        let session = EditorSession {
            id: 7,
            origin: EditorOrigin::Card { card_id: 2 },
            file_name: "Shot.png".into(),
            drive_label: "Work".into(),
            drive_name: "Work".into(),
            rel_path: "Captures/Shot.png".into(),
            format: EditableFormat::Png,
            target: SaveTarget::Local(PathBuf::from("/x/Captures/Shot.png")),
            share_token: Some("t".into()),
            original: std::sync::Arc::new(Vec::new()),
        };
        let ctx = session.context();
        assert_eq!(ctx.session, 7);
        assert_eq!(ctx.mime, "image/png");
        assert!(ctx.save_note.contains("link"));
        let json = serde_json::to_value(&ctx).unwrap();
        assert!(json.get("fileName").is_some() && json.get("saveNote").is_some());
    }

    fn roots() -> Vec<(String, PathBuf)> {
        vec![
            ("Work".into(), PathBuf::from("/Users/x/Hippius/Work")),
            ("Nested".into(), PathBuf::from("/Users/x/Hippius/Work/Inner")),
            ("Home".into(), PathBuf::from("/Users/x/Hippius")),
        ]
    }

    /// A picked file in a drive is edited in place, through the deepest
    /// drive that holds it, by its path there.
    #[test]
    fn a_picked_file_in_a_drive_is_found_in_that_drive() {
        assert_eq!(
            locate_in_drives(Path::new("/Users/x/Hippius/Work/Captures/Shot.png"), &roots()),
            Some(("Work".into(), "Captures/Shot.png".into()))
        );
        assert_eq!(
            locate_in_drives(Path::new("/Users/x/Hippius/Work/Inner/a.jpg"), &roots()),
            Some(("Nested".into(), "a.jpg".into()))
        );
        assert_eq!(
            locate_in_drives(Path::new("/Users/x/Hippius/top.png"), &roots()),
            Some(("Home".into(), "top.png".into()))
        );
    }

    /// Anything else is outside: Save never writes it, it makes a new
    /// screenshot. A sibling folder sharing a name prefix is not inside.
    #[test]
    fn a_picked_file_outside_every_drive_is_never_edited_in_place() {
        let roots = roots();
        for outside in [
            "/Users/x/Desktop/Shot.png",
            "/Users/x/Hippius Drive/Shot.png",
            "/Users/x/HippiusWork/Shot.png",
            "/Users/x/Hippius",
        ] {
            assert_eq!(locate_in_drives(Path::new(outside), &roots), None, "{outside}");
        }
        assert_eq!(locate_in_drives(Path::new("/Users/x/Hippius/Work/a.png"), &[]), None);
    }

    #[test]
    fn a_picked_picture_is_saved_as_a_new_screenshot_never_over_the_original() {
        assert_eq!(
            save_note(EditorOrigin::Picked, false),
            "Your original stays as it is. Saving uploads an edited copy, like a screenshot."
        );
        assert_eq!(link_plan(EditorOrigin::Picked, true, true), LinkPlan::Nothing);
        assert!(!save_note(EditorOrigin::Picked, false).contains('\u{2014}'));
    }

    #[test]
    fn the_copy_is_named_after_the_picture_and_keeps_its_format() {
        assert_eq!(edited_copy_name("Holiday.JPG"), "Holiday (edited).JPG");
        assert_eq!(
            edited_copy_name("Screenshot 2026-10-05 at 10.00.00.png"),
            "Screenshot 2026-10-05 at 10.00.00 (edited).png"
        );
        assert_eq!(edited_copy_name("what?: <x>.jpeg"), "what-- -x- (edited).jpeg");
        assert_eq!(edited_copy_name(".png"), "Picture (edited).png");
        let name = edited_copy_name("a|b*c.png");
        assert!(!name.contains([':', '*', '?', '"', '<', '>', '|', '/', '\\']), "{name}");
        assert_eq!(EditableFormat::from_name(&edited_copy_name("x.jpeg")), Some(EditableFormat::Jpeg));
    }

    #[test]
    fn the_latest_screenshot_is_the_newest_picture_in_the_folder() {
        use std::time::{Duration, SystemTime};
        let t = |s| SystemTime::UNIX_EPOCH + Duration::from_secs(s);
        let files = vec![
            ("Old.png".to_string(), t(10)),
            ("New.jpg".to_string(), t(30)),
            ("Recording.mp4".to_string(), t(50)),
            (".hippius-incoming-capture-1.part".to_string(), t(60)),
            (".hidden.png".to_string(), t(70)),
        ];
        assert_eq!(newest_editable(files), Some("New.jpg".into()));
        assert_eq!(newest_editable(vec![("Recording.mp4".to_string(), t(1))]), None);
        assert_eq!(newest_editable(Vec::new()), None);
    }

    #[test]
    fn the_dialog_opens_in_the_capture_folder_else_pictures_else_desktop() {
        let dirs = [PathBuf::from("/c"), PathBuf::from("/p"), PathBuf::from("/d")];
        let have = |present: &'static [&'static str]| move |p: &Path| present.iter().any(|x| Path::new(x) == p);
        let all = || dirs.iter().cloned().map(Some).collect::<Vec<_>>();
        assert_eq!(picker_start(all(), have(&["/c", "/p", "/d"])), Some(PathBuf::from("/c")));
        assert_eq!(picker_start(all(), have(&["/p", "/d"])), Some(PathBuf::from("/p")));
        assert_eq!(
            picker_start([None, None, Some(PathBuf::from("/d"))], have(&["/d"])),
            Some(PathBuf::from("/d"))
        );
        assert_eq!(picker_start(all(), have(&[])), None);
    }
}
