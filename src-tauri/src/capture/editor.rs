//! The screenshot editor: crop, redact and annotate a screenshot, then save
//! the edited picture as a copy beside it or over it.
//!
//! The editor is a full-screen layer inside the main window
//! (`app/components/capture/editor`), not a window of its own: every way in
//! (the capture card, the tray's Annotate, Drive's "Edit image") stores the
//! session here, brings the main window forward and tells it
//! [`OPEN_EVENT`]. The page draws and edits the pixels; everything that
//! decides where they go is here. Rust hands it the picture, takes the
//! flattened PNG back, checks it and writes it.
//!
//! **Copy or replace.** A picture in a drive is saved either as a copy
//! (`<name> (edited).<ext>` beside it, numbered when taken, see
//! [`unique_copy_name`]): a new file with a link of its own, the original
//! and its links untouched; or over the original (the sync engine uploads
//! the change, or it is uploaded again to a drive only on the server). The
//! page asks which, unless the user chose to be asked no more
//! ([`SavePreference`], kept in `user_preferences`).
//!
//! **The link, on replace.** A file share is a snapshot: hcfs re-encrypts a
//! COPY of the file under the link's own key, and there is no call that
//! swaps that copy's bytes. So an edited capture cannot keep its old URL.
//! The capture card's link is replaced: a new link is made from the edited
//! file and copied, and the old one is revoked, because the usual reason to
//! edit a screenshot is to hide something, and a link that still served the
//! unedited picture would leak exactly that. The old link is revoked even
//! when the new one cannot be made. A file opened from Drive may carry
//! links with a password or an expiry this device cannot recreate, so those
//! are left alone and the user is told before saving that they still show
//! the earlier picture.
//!
//! **Annotate from the tray.** The popover's Annotate button opens the latest
//! screenshot or a picture the user picks in the system's file dialog. Rust
//! shows the dialog itself and reads only the file it answered with, so no
//! IPC ever names a path to read. A picked file inside one of the user's
//! own drives synced here is edited exactly like Drive's "Edit image"; any
//! other file is never written: Save files the edited picture as a NEW
//! screenshot in the capture drive (card, upload and link as for a fresh
//! capture), so the user's original outside Hippius stays as it was.

use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::destination::CaptureDestination;
use crate::app_state::AppState;
use crate::error::{AppError, Result};

/// Sent to the main window when a picture is open in the editor (the
/// session's id): the window shows the editor over whatever page is up and
/// asks for [`capture_editor_context`].
pub const OPEN_EVENT: &str = "capture_editor_open";

/// The header the page names its session with, so a save meant for a picture
/// that has since been replaced is refused rather than written over another.
const SESSION_HEADER: &str = "x-editor-session";

/// The header that says how a picture in a drive is saved ([`SaveMode`]).
const SAVE_MODE_HEADER: &str = "x-editor-save-mode";

/// The `user_preferences` key for [`SavePreference`].
pub const SAVE_PREFERENCE_KEY: &str = "capture_editor_save_mode";

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
    /// The account that opened it: another account signed in on this
    /// computer never sees (or saves) it.
    pub account_id: String,
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
    /// A Drive file that had a share link as the editor opened: replacing
    /// it leaves that link on the earlier picture, which the page says.
    pub drive_shared: bool,
    /// The file as it was read, so the editor never reads a half-written
    /// file and a card closing meanwhile (which removes a temp copy) does
    /// not take the picture away.
    pub original: std::sync::Arc<Vec<u8>>,
}

/// How a picture in a drive is saved.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SaveMode {
    /// A new file beside the original ([`unique_copy_name`]); the original
    /// and its links are untouched.
    Copy,
    /// Over the original, as the editor always did.
    Replace,
}

impl SaveMode {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "copy" => Some(Self::Copy),
            "replace" => Some(Self::Replace),
            _ => None,
        }
    }
}

/// What Save does without asking: the user's "Remember my choice", also
/// changeable in Settings. Anything unknown in storage reads as `Ask`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SavePreference {
    #[default]
    Ask,
    Copy,
    Replace,
}

impl SavePreference {
    #[must_use]
    pub fn parse(stored: Option<&str>) -> Self {
        match stored.map(str::trim) {
            Some("copy") => Self::Copy,
            Some("replace") => Self::Replace,
            _ => Self::Ask,
        }
    }

    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ask => "ask",
            Self::Copy => "copy",
            Self::Replace => "replace",
        }
    }
}

/// What a save writes: `None` for a picked picture (always a new capture,
/// whatever the page says), else the mode the page named. A picture in a
/// drive with no mode is refused rather than guessed, so a page that did
/// not ask can never replace a file.
///
/// # Errors
///
/// [`AppError::Validation`] for a missing or unknown mode.
pub fn requested_mode(target: &SaveTarget, header: Option<&str>) -> Result<Option<SaveMode>> {
    if *target == SaveTarget::NewCapture {
        return Ok(None);
    }
    header
        .and_then(SaveMode::parse)
        .map(Some)
        .ok_or_else(|| AppError::Validation("Choose whether to save a copy or replace the original.".into()))
}

/// How the page offers Save.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SaveKind {
    /// A file in a drive: save a copy or replace it.
    InDrive,
    /// A picked picture outside the drives: "Save to Captures", nothing else.
    NewCapture,
}

/// What the editor page is told about the picture.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorContext {
    pub session: u64,
    pub file_name: String,
    pub drive_name: String,
    pub mime: &'static str,
    pub save_kind: SaveKind,
    /// Rust's sentence about what Save does, shown for a picked picture's
    /// "Save to Captures".
    pub save_note: String,
    /// What "Save as a copy" does, naming the copy, in Rust's words.
    pub copy_note: String,
    /// What "Replace the original" does, in Rust's words (with the link
    /// warning when the file has a public link).
    pub replace_note: String,
    /// The file has a link that a replace takes from, or leaves on, the
    /// earlier picture.
    pub has_public_link: bool,
    /// The user's saved choice ([`SAVE_PREFERENCE_KEY`]).
    pub save_preference: SavePreference,
}

impl EditorSession {
    #[must_use]
    pub fn context(&self, save_preference: SavePreference) -> EditorContext {
        let card_link = self.share_token.is_some();
        EditorContext {
            session: self.id,
            file_name: self.file_name.clone(),
            drive_name: self.drive_name.clone(),
            mime: self.format.mime(),
            save_kind: if self.target == SaveTarget::NewCapture {
                SaveKind::NewCapture
            } else {
                SaveKind::InDrive
            },
            save_note: save_note(self.origin, card_link).to_string(),
            copy_note: copy_note(&self.file_name),
            replace_note: replace_note(self.origin, &self.file_name, card_link, self.drive_shared),
            has_public_link: card_link || self.drive_shared,
            save_preference,
        }
    }
}

/// The line about what Save does to the file and its link.
#[must_use]
pub fn save_note(origin: EditorOrigin, has_card_link: bool) -> &'static str {
    match (origin, has_card_link) {
        (EditorOrigin::Card { .. }, true) => "Saving replaces the screenshot and its link. The old link stops working.",
        (EditorOrigin::Card { .. }, false) => "Saving replaces the screenshot in your drive.",
        (EditorOrigin::Drive, _) => "Saving replaces the file in your drive.",
        (EditorOrigin::Picked, _) => "Your original stays as it is. Saving uploads an edited copy, like a screenshot.",
    }
}

/// What "Save as a copy" does. The name is the first one tried; a taken
/// one is numbered at save time.
#[must_use]
pub fn copy_note(file_name: &str) -> String {
    format!(
        "Adds \"{}\" next to the original. The original, and any link to it, stay as they are.",
        edited_copy_name(file_name)
    )
}

/// What "Replace the original" does, said before the user commits: the
/// card's link is replaced (see the module note); a Drive file's links stay
/// on the earlier picture.
#[must_use]
pub fn replace_note(origin: EditorOrigin, file_name: &str, has_card_link: bool, drive_shared: bool) -> String {
    match origin {
        EditorOrigin::Card { .. } if has_card_link => {
            format!("Overwrites {file_name}. It gets a new link, and the old link stops working.")
        }
        EditorOrigin::Drive if drive_shared => {
            format!("Overwrites {file_name}. Its public link will show the old image until it is shared again.")
        }
        EditorOrigin::Card { .. } | EditorOrigin::Drive | EditorOrigin::Picked => format!("Overwrites {file_name}."),
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

// ── Save as a copy ──────────────────────────────────────────────────────────

/// Most numbered names tried before falling back to a random suffix; a
/// folder with this many edited copies of one picture is not a real case,
/// but the search must end.
const MAX_NUMBERED_COPIES: u32 = 9_999;

/// The `n`th name for an edited copy: `<name> (edited).<ext>` first, then
/// `<name> (edited 2).<ext>` and so on.
#[must_use]
pub fn numbered_copy_name(original: &str, n: u32) -> String {
    let (stem, ext) = copy_name_parts(original);
    if n <= 1 {
        format!("{stem} (edited).{ext}")
    } else {
        format!("{stem} (edited {n}).{ext}")
    }
}

/// The first edited-copy name that `taken` does not claim. `taken` is asked
/// about the bare name (the caller decides what is taken: a file in the
/// folder, a name the server lists).
#[must_use]
pub fn unique_copy_name(original: &str, taken: impl Fn(&str) -> bool) -> String {
    (1..=MAX_NUMBERED_COPIES)
        .map(|n| numbered_copy_name(original, n))
        .find(|name| !taken(name))
        .unwrap_or_else(|| {
            let (stem, ext) = copy_name_parts(original);
            let suffix = uuid::Uuid::new_v4().simple().to_string();
            format!("{stem} (edited {}).{ext}", &suffix[..8])
        })
}

/// A sibling's path in the drive: `rel_path` with its last part replaced by
/// `name` (`Captures/Shot.png` + `Shot (edited).png`).
#[must_use]
pub fn sibling_rel_path(rel_path: &str, name: &str) -> String {
    match rel_path.trim_matches('/').rsplit_once('/') {
        Some((parent, _)) if !parent.is_empty() => format!("{parent}/{name}"),
        _ => name.to_string(),
    }
}

/// Write `bytes` as a NEW file beside `original`, under the first free
/// edited-copy name, and return its path. Like [`replace_atomically`] it is
/// staged in a hidden file the sync engine never lists and moved into place
/// whole, but the move never overwrites: a name taken in the meantime (by
/// another save, or the sync engine bringing a file down) moves on to the
/// next number. The original is never opened for writing.
///
/// # Errors
///
/// The I/O error; the staging file is removed.
pub fn write_beside(original: &Path, bytes: &[u8]) -> std::io::Result<PathBuf> {
    use std::io::Write;
    let dir = original.parent().ok_or_else(|| std::io::Error::other("the file has no folder"))?;
    let name = original
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| std::io::Error::other("the file has no usable name"))?;
    let mut staging = tempfile::Builder::new()
        .prefix(".hippius-incoming-capture-")
        .suffix(".part")
        .tempfile_in(dir)?;
    staging.write_all(bytes)?;
    staging.as_file().sync_all()?;
    let mut attempts = 0;
    loop {
        let target = dir.join(unique_copy_name(name, |candidate| dir.join(candidate).exists()));
        match staging.persist_noclobber(&target) {
            Ok(_) => return Ok(target),
            Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists && attempts < 5 => {
                attempts += 1;
                staging = e.file;
            }
            // A folder that cannot hard-link (exFAT, some network shares)
            // refuses the no-clobber move itself: the name was free a
            // moment ago, so a plain move is the fallback. Dropping the temp
            // file on any other error removes the staging copy.
            Err(e) if e.error.kind() != std::io::ErrorKind::AlreadyExists && !target.exists() => {
                return e.file.persist(&target).map(|_| target).map_err(|e| e.error);
            }
            Err(e) => return Err(e.error),
        }
    }
}

/// The parts of an edited copy's name: the stem with characters a Windows
/// drive cannot hold made `-` (the copy goes into a drive any of the user's
/// machines may sync), and the extension as it was.
fn copy_name_parts(original: &str) -> (String, &str) {
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
    (clean.trim().to_string(), ext)
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

/// What an edited copy is first called: its name with " (edited)" before
/// the extension, so it reads as the user's picture. The new screenshot made
/// from a picked picture takes this name; a copy beside a drive file takes
/// the first free one ([`unique_copy_name`]).
#[must_use]
pub fn edited_copy_name(original: &str) -> String {
    numbered_copy_name(original, 1)
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
    let account_id = state.current_account_id()?;
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
        account_id,
        origin: EditorOrigin::Card { card_id: card.id },
        file_name: card.file_name.clone(),
        drive_label: card.drive_label.clone(),
        drive_name: card.drive_name.clone(),
        rel_path: card.rel_path.clone(),
        format,
        target,
        share_token: card.share_token.clone(),
        drive_shared: false,
        original: std::sync::Arc::new(original),
    };
    open_with(&app, session)
}

/// "Edit image" on a Drive file: a PNG or JPEG in a drive of this account's.
///
/// A file on disk in a drive synced here is edited in place and the sync
/// engine uploads the change. A file that is only on the server (a drive not
/// synced here, or one whose copy has not come down yet) is edited when the
/// caller names its server `file_id`: it is downloaded the way the viewer
/// downloads it and saved back by upload ([`open_remote_file`]). Drives
/// shared with this account are refused either way.
#[tauri::command]
pub async fn capture_editor_open_file(
    state: tauri::State<'_, AppState>,
    app: AppHandle,
    label: String,
    relative_path: String,
    file_id: Option<String>,
    arion_hash: Option<String>,
) -> Result<()> {
    let account_id = state.current_account_id()?;
    let pool = state.pool()?;
    refuse_if_open(&app)?;
    let local_root = super::destination::own_local_path(pool, &account_id, &label).await?;
    let on_disk = match &local_root {
        Some(root) => path_in_drive(root, &relative_path)?.is_file(),
        None => false,
    };
    if let (Some(file_id), false) = (file_id, on_disk) {
        return open_remote_file(&state, &app, account_id, label, &relative_path, file_id, arion_hash.unwrap_or_default()).await;
    }
    let root = local_root.ok_or_else(|| AppError::Validation("Only files in your own drives can be edited.".into()))?;
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
    let rel_path = relative_path.trim_start_matches(['/', '\\']).replace('\\', "/");
    // Whether a link already shows this file, so Replace can say before
    // saving that it will keep showing the earlier picture.
    let owner = crate::auth::account_key::account_key(&account_id);
    let drive_shared = crate::shares::origin::is_shared(pool, &owner, &label, &rel_path).await.unwrap_or(false);
    let session = EditorSession {
        id: next_session_id(&state),
        account_id,
        origin: EditorOrigin::Drive,
        file_name,
        drive_label: label,
        drive_name,
        rel_path,
        format,
        target: SaveTarget::Local(path),
        share_token: None,
        drive_shared,
        original: std::sync::Arc::new(original),
    };
    open_with(&app, session)
}

/// The picture is only on the server: download it into the preview cache
/// (the viewer's own path, so a picture just viewed opens at once) and edit
/// that copy. Saving goes back by upload into the file's own folder
/// ([`SaveTarget::Remote`]): Replace uploads over it under the same name,
/// Save a copy uploads an edited copy beside it.
///
/// The session's `temp` is deliberately empty: a remote save writes the
/// picture into `temp` when its folder exists, and the preview cache is keyed
/// by the ORIGINAL's content hash, so writing the edit there would show the
/// old file's preview as the new picture. An empty path has no folder, so the
/// save stages in a capture folder of its own.
async fn open_remote_file(
    state: &tauri::State<'_, AppState>,
    app: &AppHandle,
    account_id: String,
    label: String,
    relative_path: &str,
    file_id: String,
    arion_hash: String,
) -> Result<()> {
    let pool = state.pool()?;
    let identity = crate::sync::identity::resolve_drive_identity_or_own(pool, &account_id, &label).await?;
    if identity.is_member {
        return Err(AppError::Validation("Only files in your own drives can be edited.".into()));
    }
    let (rel_path, folder, file_name) = remote_edit_parts(relative_path)?;
    let format = EditableFormat::from_name(&file_name).ok_or_else(|| AppError::Validation("Only PNG and JPEG pictures can be edited.".into()))?;
    let cached =
        crate::sync::remote::cache_remote_file(state.clone(), account_id.clone(), label.clone(), file_id, file_name.clone(), arion_hash).await?;
    let original = read_original(PathBuf::from(cached)).await?;
    let drive_name = super::destination::load(pool, &account_id)
        .await
        .ok()
        .flatten()
        .filter(|d| d.label == label)
        .map_or_else(|| label.clone(), |d| d.display_name);
    let owner = crate::auth::account_key::account_key(&account_id);
    let drive_shared = crate::shares::origin::is_shared(pool, &owner, &label, &rel_path).await.unwrap_or(false);
    let destination = CaptureDestination {
        folder,
        ..CaptureDestination::own(&label, &drive_name)
    };
    let session = EditorSession {
        id: next_session_id(state),
        account_id,
        origin: EditorOrigin::Drive,
        file_name,
        drive_label: label,
        drive_name,
        rel_path,
        format,
        target: SaveTarget::Remote {
            destination,
            temp: PathBuf::new(),
        },
        share_token: None,
        drive_shared,
        original: std::sync::Arc::new(original),
    };
    open_with(app, session)
}

/// A server file's drive-relative path as the editor keeps it: the path with
/// `/` separators and no leading one, its folder (empty at the drive's root)
/// and its name. Refuses a path that is empty or climbs out of the drive.
///
/// # Errors
///
/// [`AppError::Validation`].
pub fn remote_edit_parts(relative_path: &str) -> Result<(String, String, String)> {
    let cleaned = path_in_drive(Path::new(""), relative_path)?;
    let parts: Vec<&str> = cleaned.iter().filter_map(|p| p.to_str()).collect();
    let (name, folder) = parts
        .split_last()
        .ok_or_else(|| AppError::Validation("That file isn't in this drive.".into()))?;
    let folder = folder.join("/");
    let rel_path = if folder.is_empty() {
        (*name).to_string()
    } else {
        format!("{folder}/{name}")
    };
    Ok((rel_path, folder, (*name).to_string()))
}

/// What the editor page shows about the picture; `None` when nothing is
/// open, or what is open was opened by another account (it is then
/// forgotten, so it can never be saved into the wrong account's drive).
#[tauri::command]
pub async fn capture_editor_context(state: tauri::State<'_, AppState>) -> Result<Option<EditorContext>> {
    let account_id = state.current_account_id().ok();
    let session = {
        let mut open = lock(&state.capture.editor);
        if open.as_ref().is_some_and(|s| Some(&s.account_id) != account_id.as_ref()) {
            open.take();
        }
        open.clone()
    };
    let Some(session) = session else { return Ok(None) };
    let preference = read_save_preference(state.pool()?).await;
    Ok(Some(session.context(preference)))
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

async fn read_save_preference(pool: &sqlx::SqlitePool) -> SavePreference {
    let stored = crate::utils::preferences::get_user_preference_internal(pool, SAVE_PREFERENCE_KEY)
        .await
        .unwrap_or_else(|e| {
            tracing::warn!(error = %e, "editor save preference not read; asking");
            None
        });
    SavePreference::parse(stored.as_deref())
}

/// The user's choice for Save: ask each time, or always save a copy, or
/// always replace. Settings shows and changes it.
#[tauri::command]
pub async fn capture_editor_save_preference(state: tauri::State<'_, AppState>) -> Result<SavePreference> {
    Ok(read_save_preference(state.pool()?).await)
}

/// The save dialog's "Remember my choice", and Settings' control.
#[tauri::command]
pub async fn capture_editor_set_save_preference(state: tauri::State<'_, AppState>, preference: SavePreference) -> Result<()> {
    crate::utils::preferences::save_user_preference_internal(state.pool()?, SAVE_PREFERENCE_KEY, preference.as_str()).await
}

/// Where the last save went, kept for the main window's "Copy link" after
/// the editor has closed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SavedEdit {
    /// A link already made from the edited picture (the card's new link).
    Link(String),
    /// A file in a drive synced here, linked through the quick-link path.
    File { label: String, rel_path: String },
}

/// What "Copy link" after a save can copy: the card's new link when one was
/// made; else, for a file in a drive synced here, a link made (or reused)
/// from the file on disk. Nothing for a file whose links still show the
/// earlier picture (a reused link would be one of them), for one only on
/// the server (there is no copy here to link), or when the link could not
/// be settled.
#[must_use]
pub fn saved_link(local: bool, link: LinkResult, new_url: Option<&str>, label: &str, rel_path: &str) -> Option<SavedEdit> {
    match (link, new_url) {
        (LinkResult::Replaced { .. }, Some(url)) => Some(SavedEdit::Link(url.to_string())),
        (LinkResult::Unchanged, _) if local => Some(SavedEdit::File {
            label: label.to_string(),
            rel_path: rel_path.to_string(),
        }),
        _ => None,
    }
}

/// The outcome of Save, for the main window's toast.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveOutcome {
    /// "Saved" or "Saved a copy".
    pub title: String,
    /// Rust's sentence about the file and its link.
    pub message: String,
    /// The name the picture was saved under.
    pub file_name: String,
    /// "Copy link" is offered ([`capture_editor_copy_saved_link`]).
    pub offer_link: bool,
}

/// Save: the editor's flattened PNG (the raw request body) is written as a
/// copy beside the file or over it ([`SAVE_MODE_HEADER`]), or, for a picked
/// picture, as a new screenshot. On replace the link is settled (see the
/// module note). The editor closes itself on success.
#[tauri::command]
pub async fn capture_editor_save(state: tauri::State<'_, AppState>, app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<SaveOutcome> {
    let session = session_for(&state, &request)?;
    let mode = requested_mode(&session.target, request.headers().get(SAVE_MODE_HEADER).and_then(|v| v.to_str().ok()))?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(AppError::Validation(NOT_A_PICTURE.into()));
    };
    let account_id = state.current_account_id()?;
    let bytes = bytes.clone();
    let format = session.format;
    let (encoded, rgba) = tokio::task::spawn_blocking(move || prepare_edited(&bytes, format))
        .await
        .map_err(|e| AppError::Other(format!("editor save task failed: {e}")))??;
    lock(&state.capture.editor_saved).take();
    let Some(mode) = mode else {
        return save_as_new_capture(&app, &session, encoded, &rgba).await;
    };
    if mode == SaveMode::Copy {
        return save_copy(&state, &app, &account_id, &session, &encoded).await;
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
    if let Some(id) = card_id {
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
        });
    }
    // The main window's toast says what happened; the card shows its link.
    let saved = saved_link(
        matches!(session.target, SaveTarget::Local(_)),
        link,
        new_link.as_ref().map(|(url, ..)| url.as_str()),
        &session.drive_label,
        &session.rel_path,
    );
    let offer_link = saved.is_some();
    *lock(&state.capture.editor_saved) = saved;
    tracing::info!(session = session.id, "screenshot edited and saved over the original");
    Ok(SaveOutcome {
        title: "Saved".into(),
        message,
        file_name: session.file_name.clone(),
        offer_link,
    })
}

/// "Save as a copy": the edited picture becomes a new file beside the
/// original (same folder, first free edited-copy name); the original, its
/// card and its links are not touched.
async fn save_copy(state: &AppState, app: &AppHandle, account_id: &str, session: &EditorSession, encoded: &[u8]) -> Result<SaveOutcome> {
    let (name, local) = match &session.target {
        SaveTarget::Local(path) => {
            let (path, bytes) = (path.clone(), encoded.to_vec());
            let written = tokio::task::spawn_blocking(move || write_beside(&path, &bytes))
                .await
                .map_err(|e| AppError::Other(format!("editor write task failed: {e}")))?
                .map_err(|e| {
                    tracing::warn!(error = %e, "edited copy not written");
                    AppError::Validation("The copy couldn't be saved. Check the drive's folder is still there.".into())
                })?;
            nudge_sync(app);
            let name = written
                .file_name()
                .and_then(|n| n.to_str())
                .map_or_else(|| edited_copy_name(&session.file_name), str::to_string);
            (name, true)
        }
        SaveTarget::Remote { destination, .. } => (upload_remote_copy(state, app, account_id, session, destination, encoded).await?, false),
        SaveTarget::NewCapture => return Err(AppError::Other("a picked picture is saved as a new screenshot".into())),
    };
    let saved = local.then(|| SavedEdit::File {
        label: session.drive_label.clone(),
        rel_path: sibling_rel_path(&session.rel_path, &name),
    });
    let offer_link = saved.is_some();
    *lock(&state.capture.editor_saved) = saved;
    tracing::info!(session = session.id, "screenshot edited and saved as a copy");
    Ok(SaveOutcome {
        title: "Saved a copy".into(),
        message: format!("Saved as \"{name}\" next to the original."),
        file_name: name,
        offer_link,
    })
}

/// A copy of a capture in a drive that is only on the server: uploaded into
/// the same folder under the first edited-copy name the server does not
/// list there. Returns the name.
async fn upload_remote_copy(
    state: &AppState,
    app: &AppHandle,
    account_id: &str,
    session: &EditorSession,
    destination: &CaptureDestination,
    encoded: &[u8],
) -> Result<String> {
    let folder = sibling_rel_path(&session.rel_path, "");
    let folder = folder.trim_end_matches('/').to_lowercase();
    // Best effort: a listing that fails leaves the numbered names unchecked,
    // and the first one is used.
    let taken: std::collections::HashSet<String> =
        match crate::sync::remote::list_remote_folder_files_inner(state, account_id, &destination.label).await {
            Ok(files) => files
                .into_iter()
                .filter_map(|f| {
                    let path = f.path.trim_matches('/').to_lowercase();
                    let parent = path.rsplit_once('/').map_or("", |(p, _)| p).to_string();
                    (parent == folder).then_some(f.name.to_lowercase())
                })
                .collect(),
            Err(e) => {
                tracing::warn!(error = %e, "remote folder not listed; the copy's name is not checked");
                std::collections::HashSet::new()
            }
        };
    let name = unique_copy_name(&session.file_name, |candidate| taken.contains(&candidate.to_lowercase()));
    let dir = super::screenshot::fresh_capture_dir(&super::screenshot::capture_tmp_root()?)?;
    let file = dir.join(&name);
    let (to, bytes) = (file.clone(), encoded.to_vec());
    let written = tokio::task::spawn_blocking(move || std::fs::write(&to, &bytes))
        .await
        .map_err(|e| AppError::Other(format!("editor write task failed: {e}")))?;
    let source = file.to_str().map(str::to_string);
    let failure = match (written, source) {
        (Err(e), _) => Some(AppError::from(e)),
        (Ok(()), None) => Some(AppError::Other("Capture path is not valid UTF-8".into())),
        (Ok(()), Some(source)) => match crate::sync::remote_upload::upload_files_to_remote_folder_inner(
            state,
            app.clone(),
            account_id,
            &destination.label,
            destination.upload_folder(),
            &[source],
            destination.owner_ss58.clone(),
            destination.folder_hash.clone(),
        )
        .await
        {
            Ok(failures) => failures.into_iter().next().map(|f| AppError::Other(f.error)),
            Err(e) => Some(e),
        },
    };
    let _ = std::fs::remove_dir_all(&dir);
    if let Some(e) = failure {
        tracing::warn!(error = %e, "edited copy not uploaded");
        return Err(AppError::Validation(super::deliver::failure_copy(&e)));
    }
    Ok(name)
}

/// "Copy link" on the toast after a save: the card's new link, or a link
/// for the saved file made (or reused) through the tray's quick-link path.
/// A failure is an outcome with Rust's sentence, as for the tray.
#[tauri::command]
pub async fn capture_editor_copy_saved_link(
    state: tauri::State<'_, AppState>,
    app: AppHandle,
) -> Result<crate::shares::quick_link::QuickLinkOutcome> {
    use crate::shares::quick_link::QuickLinkOutcome;
    let saved = lock(&state.capture.editor_saved).clone();
    match saved {
        Some(SavedEdit::Link(url)) => {
            if super::commands::copy_link_to_clipboard(&app, Some(&url)) {
                Ok(QuickLinkOutcome::Copied { url, reused: true })
            } else {
                Ok(QuickLinkOutcome::Failed {
                    message: "The link couldn't be copied. Try again.".into(),
                })
            }
        }
        Some(SavedEdit::File { label, rel_path }) => crate::shares::quick_link::copy_file_share_link(state, app, label, rel_path, None).await,
        None => Ok(QuickLinkOutcome::Failed {
            message: "There is no link to copy for this picture.".into(),
        }),
    }
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

/// Cancel, Close or Discard: the editor goes and its picture is forgotten.
/// Nothing is written. Only the session the page names: a page closing late
/// never drops a picture opened since.
#[tauri::command]
pub fn capture_editor_close(state: tauri::State<'_, AppState>, session: u64) {
    let mut open = lock(&state.capture.editor);
    if open.as_ref().is_some_and(|s| s.id == session) {
        open.take();
    }
}

fn next_session_id(state: &AppState) -> u64 {
    state.capture.editor_seq.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1
}

/// One picture at a time: the open one is brought forward again and the new
/// one refused, so unsaved changes are never thrown away by another click.
fn refuse_if_open(app: &AppHandle) -> Result<()> {
    let open = lock(&app.state::<AppState>().capture.editor).as_ref().map(|s| s.id);
    if let Some(id) = open {
        show_in_main_window(app, id);
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

/// Store the session and show it in the main window.
fn open_with(app: &AppHandle, session: EditorSession) -> Result<()> {
    let id = session.id;
    *lock(&app.state::<AppState>().capture.editor) = Some(session);
    show_in_main_window(app, id);
    Ok(())
}

/// The editor is a layer of the main window: the window comes forward
/// (unminimized, shown, focused) and is told which session to show. The
/// tray popover goes first, so it never sits over the editor.
fn show_in_main_window(app: &AppHandle, session: u64) {
    if let Err(e) = crate::tray::panel::hide_tray_panel(app.clone()) {
        tracing::debug!(error = %e, "tray popover not hidden for the editor");
    }
    super::commands::show_main_window(app);
    if let Err(e) = app.emit_to(super::commands::MAIN_WINDOW_LABEL, OPEN_EVENT, session) {
        tracing::warn!(error = %e, "the main window was not told to show the editor");
    }
}

/// Start a sync round for a file just written in a drive synced here. Not
/// awaited: it runs a whole round (see `deliver::place`).
fn nudge_sync(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = crate::sync::control::trigger_sync_now(app).await {
            tracing::warn!(error = %e, "edited screenshot saved; sync not nudged");
        }
    });
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
            nudge_sync(app);
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
            Some(Latest::InFolder { label, rel_path, .. }) => capture_editor_open_file(state.clone(), app.clone(), label, rel_path, None, None)
                .await
                .map(|()| true),
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
        return capture_editor_open_file(state.clone(), app.clone(), label, rel_path, None, None).await;
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
        account_id: account_id.to_string(),
        origin: EditorOrigin::Picked,
        file_name,
        drive_label: String::new(),
        drive_name,
        rel_path: String::new(),
        format,
        target: SaveTarget::NewCapture,
        share_token: None,
        drive_shared: false,
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
    // The new screenshot's card makes, copies and shows its link.
    Ok(SaveOutcome {
        title: "Saved to Captures".into(),
        message: format!("Saved as {name} in {}. Your original is unchanged.", session.drive_name),
        file_name: name,
        offer_link: false,
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

    // A picture only on the server is saved back by upload into its own
    // folder, so the folder and name must come out of the path exactly.
    #[test]
    fn a_server_file_is_split_into_its_folder_and_name() {
        assert_eq!(
            remote_edit_parts("/Trips/2026/beach.png").unwrap(),
            ("Trips/2026/beach.png".into(), "Trips/2026".into(), "beach.png".into())
        );
        assert_eq!(
            remote_edit_parts("shot.jpg").unwrap(),
            ("shot.jpg".into(), String::new(), "shot.jpg".into())
        );
        assert_eq!(remote_edit_parts("./a/./b.png").unwrap(), ("a/b.png".into(), "a".into(), "b.png".into()));
        for bad in ["../other/a.png", "Trips/../../a.png", "", "/", "."] {
            assert!(remote_edit_parts(bad).is_err(), "{bad}");
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

    fn session(origin: EditorOrigin, target: SaveTarget) -> EditorSession {
        EditorSession {
            id: 7,
            account_id: "acct".into(),
            origin,
            file_name: "Shot.png".into(),
            drive_label: "Work".into(),
            drive_name: "Work".into(),
            rel_path: "Captures/Shot.png".into(),
            format: EditableFormat::Png,
            target,
            share_token: None,
            drive_shared: false,
            original: std::sync::Arc::new(Vec::new()),
        }
    }

    #[test]
    fn the_context_names_the_session_and_the_format() {
        let mut card = session(
            EditorOrigin::Card { card_id: 2 },
            SaveTarget::Local(PathBuf::from("/x/Captures/Shot.png")),
        );
        card.share_token = Some("t".into());
        let ctx = card.context(SavePreference::Copy);
        assert_eq!(ctx.session, 7);
        assert_eq!(ctx.mime, "image/png");
        assert_eq!(ctx.save_kind, SaveKind::InDrive);
        assert!(ctx.has_public_link);
        assert_eq!(ctx.save_preference, SavePreference::Copy);
        assert!(ctx.copy_note.contains("\"Shot (edited).png\""), "{}", ctx.copy_note);
        let json = serde_json::to_value(&ctx).unwrap();
        for key in ["fileName", "saveKind", "copyNote", "replaceNote", "hasPublicLink", "savePreference"] {
            assert!(json.get(key).is_some(), "{key} on the wire");
        }
        assert_eq!(json["saveKind"], "inDrive");
        assert_eq!(json["savePreference"], "copy");
    }

    /// A picked picture has no original to replace: the page offers only
    /// "Save to Captures".
    #[test]
    fn a_picked_picture_is_offered_only_save_to_captures() {
        let ctx = session(EditorOrigin::Picked, SaveTarget::NewCapture).context(SavePreference::Replace);
        assert_eq!(ctx.save_kind, SaveKind::NewCapture);
        assert!(!ctx.has_public_link);
        assert_eq!(serde_json::to_value(&ctx).unwrap()["saveKind"], "newCapture");
    }

    /// The link warning is said only where the file has a public link; a
    /// file without one gets the neutral line.
    #[test]
    fn replace_warns_about_the_link_only_when_there_is_one() {
        assert_eq!(
            replace_note(EditorOrigin::Drive, "Shot.png", false, true),
            "Overwrites Shot.png. Its public link will show the old image until it is shared again."
        );
        assert_eq!(replace_note(EditorOrigin::Drive, "Shot.png", false, false), "Overwrites Shot.png.");
        assert_eq!(
            replace_note(EditorOrigin::Card { card_id: 1 }, "Shot.png", false, false),
            "Overwrites Shot.png."
        );
        assert!(replace_note(EditorOrigin::Card { card_id: 1 }, "Shot.png", true, false).contains("old link stops working"));
        let mut drive = session(EditorOrigin::Drive, SaveTarget::Local(PathBuf::from("/x/Shot.png")));
        assert!(!drive.context(SavePreference::Ask).has_public_link);
        drive.drive_shared = true;
        let ctx = drive.context(SavePreference::Ask);
        assert!(ctx.has_public_link && ctx.replace_note.contains("public link"));
        for note in [ctx.replace_note, ctx.copy_note] {
            assert!(!note.contains('\u{2014}'), "no em dash in user copy");
        }
    }

    /// A page that did not say how to save can never replace a file; a
    /// picked picture is always a new capture whatever the page says.
    #[test]
    fn a_save_in_a_drive_must_name_its_mode() {
        let local = SaveTarget::Local(PathBuf::from("/x/Shot.png"));
        assert_eq!(requested_mode(&local, Some("copy")).unwrap(), Some(SaveMode::Copy));
        assert_eq!(requested_mode(&local, Some("replace")).unwrap(), Some(SaveMode::Replace));
        for bad in [None, Some(""), Some("Replace"), Some("overwrite")] {
            assert!(matches!(requested_mode(&local, bad), Err(AppError::Validation(_))), "{bad:?}");
        }
        assert_eq!(requested_mode(&SaveTarget::NewCapture, Some("replace")).unwrap(), None);
        assert_eq!(requested_mode(&SaveTarget::NewCapture, None).unwrap(), None);
    }

    #[test]
    fn the_saved_choice_reads_back_and_anything_unknown_asks() {
        for p in [SavePreference::Ask, SavePreference::Copy, SavePreference::Replace] {
            assert_eq!(SavePreference::parse(Some(p.as_str())), p);
            // The IPC's wire form is the stored form.
            assert_eq!(serde_json::to_value(p).unwrap(), p.as_str());
        }
        assert_eq!(SavePreference::parse(None), SavePreference::Ask);
        assert_eq!(SavePreference::parse(Some("always")), SavePreference::Ask);
        assert_eq!(SavePreference::default(), SavePreference::Ask);
    }

    #[test]
    fn copies_are_numbered_from_the_second() {
        assert_eq!(numbered_copy_name("Shot.png", 1), "Shot (edited).png");
        assert_eq!(numbered_copy_name("Shot.png", 2), "Shot (edited 2).png");
        assert_eq!(numbered_copy_name("a|b.JPG", 3), "a-b (edited 3).JPG");
        let taken = ["Shot (edited).png", "Shot (edited 2).png"];
        assert_eq!(unique_copy_name("Shot.png", |n| taken.contains(&n)), "Shot (edited 3).png");
        assert_eq!(unique_copy_name("Shot.png", |_| false), "Shot (edited).png");
        // A gap is filled rather than skipped past.
        assert_eq!(unique_copy_name("Shot.png", |n| n == "Shot (edited).png"), "Shot (edited 2).png");
        // Even a folder where every number is taken gets a name, of the same kind.
        let last = unique_copy_name("Shot.png", |_| true);
        assert!(last.starts_with("Shot (edited ") && last.ends_with(").png"), "{last}");
    }

    #[test]
    fn a_copy_sits_in_the_originals_folder() {
        assert_eq!(sibling_rel_path("Captures/Shot.png", "Shot (edited).png"), "Captures/Shot (edited).png");
        assert_eq!(sibling_rel_path("a/b/c.png", "c (edited).png"), "a/b/c (edited).png");
        assert_eq!(sibling_rel_path("Shot.png", "Shot (edited).png"), "Shot (edited).png");
        assert_eq!(sibling_rel_path("/Shot.png", "x.png"), "x.png");
    }

    /// The copy is a new file beside the original, numbered past the names
    /// already there; the original keeps its bytes and no staging file stays.
    #[test]
    fn a_copy_is_written_beside_the_original_and_never_over_a_file() {
        let tmp = tempfile::tempdir().unwrap();
        let original = tmp.path().join("Shot.png");
        std::fs::write(&original, b"original").unwrap();
        let first = write_beside(&original, b"edit one").unwrap();
        assert_eq!(first, tmp.path().join("Shot (edited).png"));
        let second = write_beside(&original, b"edit two").unwrap();
        assert_eq!(second, tmp.path().join("Shot (edited 2).png"));
        assert_eq!(std::fs::read(&original).unwrap(), b"original");
        assert_eq!(std::fs::read(&first).unwrap(), b"edit one");
        assert_eq!(std::fs::read(&second).unwrap(), b"edit two");
        let names: Vec<String> = std::fs::read_dir(tmp.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names.len(), 3, "no staging file left: {names:?}");
    }

    #[test]
    fn a_copy_into_a_missing_folder_fails_and_writes_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(write_beside(&tmp.path().join("gone").join("Shot.png"), b"x").is_err());
        assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 0);
    }

    /// "Copy link" after a save: the card's new link as it is; a file synced
    /// here through the quick-link path; never a link that still shows the
    /// earlier picture, and nothing for a file only on the server.
    #[test]
    fn copy_link_is_offered_only_for_a_link_to_the_saved_picture() {
        let replaced = LinkResult::Replaced {
            copied: true,
            old_revoked: true,
        };
        assert_eq!(
            saved_link(true, replaced, Some("https://x/s/1"), "Work", "Captures/Shot.png"),
            Some(SavedEdit::Link("https://x/s/1".into()))
        );
        assert_eq!(
            saved_link(true, LinkResult::Unchanged, None, "Work", "a/Shot.png"),
            Some(SavedEdit::File {
                label: "Work".into(),
                rel_path: "a/Shot.png".into()
            })
        );
        assert_eq!(saved_link(false, LinkResult::Unchanged, None, "Work", "a/Shot.png"), None);
        assert_eq!(saved_link(true, LinkResult::Stale, None, "Work", "a/Shot.png"), None);
        assert_eq!(saved_link(true, LinkResult::NotMade { old_revoked: true }, None, "Work", "a.png"), None);
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
