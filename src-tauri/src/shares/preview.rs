//! The picture a chat app shows for a share link.
//!
//! When a share link is pasted into Discord, Slack and the like, the chat app
//! asks the console for the link's page and shows the picture it names. By
//! default that is a generic Hippius card. With a preview uploaded
//! (`PUT /v1/shares/{token}/preview`), the card shows the screenshot itself,
//! or a recording's poster frame with a play button and its length.
//!
//! The preview is a plaintext picture of the file and its name is a plaintext
//! title, so the server can read both. That is why:
//!
//! - it is the user's choice, per share, and never sent for a password share
//!   ([`allowed`]): the server cannot tell those apart, so the rule lives here;
//! - it is a small re-encoded JPEG ([`render_image`]), never the file's own
//!   bytes, so no EXIF, GPS, ICC or other metadata leaves with it;
//! - the upload is best-effort and runs after the link is minted
//!   ([`spawn_upload`]): a failed preview never fails or slows the share.
//!
//! The rendering is pure and tested everywhere; only [`render_file`] reads a
//! file (and, for a video, runs the recording helper's `--poster`).

use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::time::Duration;

use image::{DynamicImage, ImageDecoder, Rgb, RgbImage};
use tauri::Manager;
use tracing::{debug, info, warn};

use super::commands::ShareChoice;
use crate::app_state::AppState;
use crate::auth::tokens::get_api_token;
use crate::error::{AppError, Result};

/// The largest side the server takes, in pixels.
pub const MAX_SIDE: u32 = 1200;
/// The size budget. The server refuses over 300 KiB; this stays under 300 KB
/// so a rounding difference in what "KB" means can never get one refused.
pub const MAX_BYTES: usize = 300_000;
/// The server's title limit, in characters.
pub const MAX_TITLE_CHARS: usize = 200;

/// JPEG qualities tried in turn until the picture fits [`MAX_BYTES`].
const QUALITIES: [u8; 5] = [85, 75, 65, 55, 45];
/// When even the lowest quality is too big (a noisy photo), the picture
/// shrinks by this much and the qualities are tried again.
const SHRINK: f64 = 0.75;
/// Below this side a preview is no longer worth showing.
const MIN_SIDE: u32 = 64;
/// An image file larger than this is not decoded for a preview: the decode
/// alone would hold hundreds of megabytes for a picture the size of a card.
const MAX_SOURCE_BYTES: u64 = 64 * 1024 * 1024;
/// How long a video's poster frame may take to read.
const POSTER_WAIT: Duration = Duration::from_secs(5);
/// How long the upload may take before it is given up.
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(30);

/// What kind of picture a file can have, by its extension.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreviewKind {
    /// A picture this build can decode: the picture itself.
    Image,
    /// A video the recording helper can read stills from: its poster frame
    /// with a play button.
    Video,
}

impl PreviewKind {
    /// The kind for `file_name`, or `None` when no preview can be made for it
    /// here (a document, an archive, a picture format this build cannot read).
    #[must_use]
    pub fn of(file_name: &str) -> Option<Self> {
        let ext = Path::new(file_name).extension()?.to_str()?.to_ascii_lowercase();
        match ext.as_str() {
            // The decoders compiled in (`image` features in Cargo.toml).
            "png" | "jpg" | "jpeg" | "bmp" => Some(Self::Image),
            // What every platform's poster helper reads (AVFoundation, Media
            // Foundation, GStreamer).
            "mp4" | "mov" | "m4v" => Some(Self::Video),
            _ => None,
        }
    }
}

/// Whether `file_name` is named like a capture this app took
/// (`Screenshot 2026-09-22 at 14.03.11.png`, see `capture::naming`), an
/// edited copy or a numbered duplicate of one included.
#[must_use]
pub fn is_capture_name(file_name: &str) -> bool {
    let Some(rest) = file_name.strip_prefix("Screenshot ").or_else(|| file_name.strip_prefix("Recording ")) else {
        return false;
    };
    // `YYYY-MM-DD at HH.MM.SS`, then anything (an extension, " (edited)").
    let b = rest.as_bytes();
    let digits = |range: std::ops::Range<usize>| b.get(range).is_some_and(|s| s.iter().all(u8::is_ascii_digit));
    b.len() >= 22
        && digits(0..4)
        && b[4] == b'-'
        && digits(5..7)
        && b[7] == b'-'
        && digits(8..10)
        && &b[10..14] == b" at "
        && digits(14..16)
        && b[16] == b'.'
        && digits(17..19)
        && b[19] == b'.'
        && digits(20..22)
}

/// What the share dialog's "Show a preview in chats" switch does for a file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewDefault {
    /// A preview can be made for this file, so the switch is shown.
    pub offered: bool,
    /// Where the switch starts.
    pub on: bool,
}

/// The switch for a file named `file_name`: offered for a picture or video
/// this build can preview, never for a folder; on by default for a capture
/// (`is_capture`, by its drive or its name) when the Settings default is on,
/// off for every other file.
#[must_use]
pub fn default_for(file_name: &str, is_folder: bool, is_capture: bool, captures_default: bool) -> PreviewDefault {
    let offered = !is_folder && PreviewKind::of(file_name).is_some();
    PreviewDefault {
        offered,
        on: offered && is_capture && captures_default,
    }
}

/// Whether a preview may be sent for a share: only when the user asked for
/// one AND the link has no password. A password link's picture would show
/// to anyone who has the link, which is what its password is meant to stop,
/// and the server cannot tell such a link apart, so this is the only place
/// the rule can hold.
#[must_use]
pub fn allowed(choice: &ShareChoice, wanted: bool) -> bool {
    wanted && matches!(choice, ShareChoice::Public)
}

/// `file_name` as the preview's title, cleaned to the server's rules: no
/// control, bidi or zero-width characters, trimmed, at most
/// [`MAX_TITLE_CHARS`] characters. `None` when nothing is left.
#[must_use]
pub fn sanitize_title(file_name: &str) -> Option<String> {
    let cleaned: String = file_name.chars().filter(|c| !is_hidden_char(*c)).collect();
    let title: String = cleaned.trim().chars().take(MAX_TITLE_CHARS).collect();
    let title = title.trim_end().to_string();
    (!title.is_empty()).then_some(title)
}

/// Control characters, bidi controls and zero-width characters: the ones
/// the server refuses in a title, since they can make a name read as
/// something it is not.
fn is_hidden_char(c: char) -> bool {
    c.is_control()
        || matches!(
            c,
            '\u{061C}' | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}'
        )
}

/// A recording's length the way a video player shows it: `0:42`, `12:05`,
/// `1:02:03`. Rounded to the second; anything that started counts as one.
#[must_use]
pub fn format_duration(secs: f64) -> String {
    let secs = if secs.is_finite() { secs.max(0.0) } else { 0.0 };
    // Bounded above by any real recording's length, so the cast is exact.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let mut total = secs.round() as u64;
    if total == 0 && secs > 0.0 {
        total = 1;
    }
    let (h, m, s) = (total / 3600, (total / 60) % 60, total % 60);
    if h > 0 { format!("{h}:{m:02}:{s:02}") } else { format!("{m}:{s:02}") }
}

/// The largest size at most `max` on each side with `width` x `height`'s
/// shape; never enlarged, never zero.
#[must_use]
pub fn fit_within(width: u32, height: u32, max: u32) -> (u32, u32) {
    if width <= max && height <= max {
        return (width.max(1), height.max(1));
    }
    let scale = f64::from(max) / f64::from(width.max(height));
    // Both results lie in 1..=max, so the casts cannot truncate.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let fit = |side: u32| ((f64::from(side) * scale).round() as u32).clamp(1, max);
    (fit(width), fit(height))
}

/// The picture flattened onto white (a screenshot's transparent corners
/// would otherwise turn black in a JPEG) and scaled to fit [`MAX_SIDE`].
fn prepared(image: &DynamicImage) -> RgbImage {
    let (w, h) = fit_within(image.width(), image.height(), MAX_SIDE);
    let scaled = if (w, h) == (image.width(), image.height()) {
        image.clone()
    } else {
        image.resize_exact(w, h, image::imageops::FilterType::Triangle)
    };
    flatten_on_white(&scaled)
}

fn flatten_on_white(image: &DynamicImage) -> RgbImage {
    if !image.color().has_alpha() {
        return image.to_rgb8();
    }
    let rgba = image.to_rgba8();
    RgbImage::from_fn(rgba.width(), rgba.height(), |x, y| {
        let [r, g, b, a] = rgba.get_pixel(x, y).0;
        let a = u32::from(a);
        // White under the picture, in integers; the result is at most 255.
        #[allow(clippy::cast_possible_truncation)]
        let over = |c: u8| ((u32::from(c) * a + 255 * (255 - a)) / 255) as u8;
        Rgb([over(r), over(g), over(b)])
    })
}

fn encode_jpeg(image: &RgbImage, quality: u8) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    // A fresh encoder writes the picture and a JFIF header only: no EXIF,
    // no ICC profile, no comment. That is what strips the source's metadata.
    image::codecs::jpeg::JpegEncoder::new_with_quality(Cursor::new(&mut bytes), quality)
        .encode_image(image)
        .map_err(|e| AppError::Other(format!("Could not encode the preview: {e}")))?;
    Ok(bytes)
}

/// Encode a prepared picture as a JPEG under [`MAX_BYTES`]: the best
/// quality that fits, shrinking the picture when none does.
fn encode_within_budget(mut image: RgbImage) -> Result<Vec<u8>> {
    loop {
        for quality in QUALITIES {
            let bytes = encode_jpeg(&image, quality)?;
            if bytes.len() <= MAX_BYTES {
                return Ok(bytes);
            }
        }
        // Sides only shrink here, and stay at least MIN_SIDE.
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let (w, h) = (
            (f64::from(image.width()) * SHRINK).round() as u32,
            (f64::from(image.height()) * SHRINK).round() as u32,
        );
        if w.min(h) < MIN_SIDE {
            return Err(AppError::Other("The preview could not be made small enough.".into()));
        }
        image = image::imageops::resize(&image, w, h, image::imageops::FilterType::Triangle);
    }
}

/// A picture's chat preview: at most [`MAX_SIDE`] on each side, a JPEG of
/// at most [`MAX_BYTES`], carrying no metadata.
///
/// # Errors
///
/// [`AppError::Other`] for an empty picture or one that cannot be encoded.
pub fn render_image(image: &DynamicImage) -> Result<Vec<u8>> {
    if image.width() == 0 || image.height() == 0 {
        return Err(AppError::Other("There is no picture to preview.".into()));
    }
    encode_within_budget(prepared(image))
}

/// A recording's chat preview: its poster frame with a play button in the
/// middle and, when known, its length in the bottom-right corner, as a
/// video card in a chat app shows one. Same limits as [`render_image`].
///
/// # Errors
///
/// As [`render_image`].
pub fn render_recording(frame: &DynamicImage, duration_secs: Option<f64>) -> Result<Vec<u8>> {
    if frame.width() == 0 || frame.height() == 0 {
        return Err(AppError::Other("There is no picture to preview.".into()));
    }
    let mut picture = prepared(frame);
    draw_play_button(&mut picture);
    if let Some(secs) = duration_secs.filter(|d| d.is_finite() && *d > 0.0) {
        draw_duration(&mut picture, &format_duration(secs));
    }
    encode_within_budget(picture)
}

/// Mix `color` into the pixel at `(x, y)` by `alpha` (0 to 1).
fn blend(image: &mut RgbImage, x: u32, y: u32, color: [u8; 3], alpha: f32) {
    if alpha <= 0.0 || x >= image.width() || y >= image.height() {
        return;
    }
    let alpha = alpha.min(1.0);
    let px = image.get_pixel_mut(x, y);
    for (c, over) in px.0.iter_mut().zip(color) {
        // A mix of two bytes stays within 0..=255.
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let mixed = (f32::from(*c) * (1.0 - alpha) + f32::from(over) * alpha).round() as u8;
        *c = mixed;
    }
}

/// A round dark button with a white triangle, centred, sized to the picture.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss, clippy::cast_precision_loss)]
fn draw_play_button(image: &mut RgbImage) {
    let (w, h) = (image.width(), image.height());
    let radius = (f32::from(u16::try_from(w.min(h)).unwrap_or(u16::MAX)) * 0.13).clamp(14.0, 90.0);
    let (cx, cy) = (w as f32 / 2.0, h as f32 / 2.0);
    // The triangle points right, nudged right so it looks centred.
    let tri = [
        (cx - radius * 0.32, cy - radius * 0.45),
        (cx - radius * 0.32, cy + radius * 0.45),
        (cx + radius * 0.5, cy),
    ];
    let x0 = (cx - radius - 1.0).max(0.0) as u32;
    let y0 = (cy - radius - 1.0).max(0.0) as u32;
    let x1 = ((cx + radius + 1.0) as u32).min(w.saturating_sub(1));
    let y1 = ((cy + radius + 1.0) as u32).min(h.saturating_sub(1));
    for y in y0..=y1 {
        for x in x0..=x1 {
            let (px, py) = (x as f32 + 0.5, y as f32 + 0.5);
            let d = ((px - cx).powi(2) + (py - cy).powi(2)).sqrt();
            // Edge smoothing: a pixel half in is half covered.
            let disc = (radius - d + 0.5).clamp(0.0, 1.0);
            blend(image, x, y, [0, 0, 0], disc * 0.6);
            blend(image, x, y, [255, 255, 255], triangle_coverage(tri, px, py));
        }
    }
}

/// How much of the pixel centred on `(px, py)` the triangle covers, 0 to 1,
/// from its distance to the nearest edge (smooth edges, no jaggies).
fn triangle_coverage(tri: [(f32, f32); 3], px: f32, py: f32) -> f32 {
    let mut inside = f32::INFINITY;
    for i in 0..3 {
        let (ax, ay) = tri[i];
        let (bx, by) = tri[(i + 1) % 3];
        let (ex, ey) = (bx - ax, by - ay);
        let len = (ex * ex + ey * ey).sqrt();
        if len == 0.0 {
            return 0.0;
        }
        // Signed distance to the edge; positive inside for this winding.
        let d = ((px - ax) * ey - (py - ay) * ex) / len;
        inside = inside.min(d);
    }
    (inside + 0.5).clamp(0.0, 1.0)
}

/// 5 x 7 pixel digits and a colon, one row per byte, high bit on the left.
const GLYPH_W: u32 = 5;
const GLYPH_H: u32 = 7;
fn glyph(c: char) -> Option<[u8; 7]> {
    Some(match c {
        '0' => [0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E],
        '1' => [0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E],
        '2' => [0x0E, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1F],
        '3' => [0x1F, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0E],
        '4' => [0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02],
        '5' => [0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E],
        '6' => [0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E],
        '7' => [0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
        '8' => [0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E],
        '9' => [0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C],
        ':' => [0x00, 0x0C, 0x0C, 0x00, 0x0C, 0x0C, 0x00],
        _ => return None,
    })
}

/// The length in white on a dark rounded label, bottom right.
fn draw_duration(image: &mut RgbImage, text: &str) {
    let (w, h) = (image.width(), image.height());
    // Each font pixel is `scale` picture pixels: about 2% of the height.
    let scale = (h / 110).clamp(1, 4);
    let advance = (GLYPH_W + 1) * scale;
    let glyphs: Vec<[u8; 7]> = text.chars().filter_map(glyph).collect();
    let Ok(count) = u32::try_from(glyphs.len()) else { return };
    if count == 0 {
        return;
    }
    let text_w = count * advance - scale;
    let text_h = GLYPH_H * scale;
    let pad_x = 3 * scale;
    let pad_y = 2 * scale;
    let margin = (h / 40).max(4);
    let box_w = text_w + 2 * pad_x;
    let box_h = text_h + 2 * pad_y;
    if box_w + margin >= w || box_h + margin >= h {
        return;
    }
    let (bx, by) = (w - margin - box_w, h - margin - box_h);
    let radius = (box_h / 3).max(1);
    for y in 0..box_h {
        for x in 0..box_w {
            if !inside_rounded(x, y, box_w, box_h, radius) {
                continue;
            }
            blend(image, bx + x, by + y, [0, 0, 0], 0.7);
        }
    }
    let (tx, ty) = (bx + pad_x, by + pad_y);
    for (i, rows) in (0u32..).zip(glyphs.iter()) {
        for (row, bits) in (0u32..).zip(rows.iter()) {
            for col in 0..GLYPH_W {
                if bits & (0x10 >> col) == 0 {
                    continue;
                }
                for dy in 0..scale {
                    for dx in 0..scale {
                        blend(image, tx + i * advance + col * scale + dx, ty + row * scale + dy, [255, 255, 255], 1.0);
                    }
                }
            }
        }
    }
}

/// Whether `(x, y)` lies inside a `width` x `height` box with corners of
/// `radius`.
fn inside_rounded(x: u32, y: u32, width: u32, height: u32, radius: u32) -> bool {
    let corner_x = if x < radius {
        radius
    } else if x >= width - radius {
        width - radius - 1
    } else {
        return true;
    };
    let corner_y = if y < radius {
        radius
    } else if y >= height - radius {
        height - radius - 1
    } else {
        return true;
    };
    let (dx, dy) = (i64::from(x) - i64::from(corner_x), i64::from(y) - i64::from(corner_y));
    dx * dx + dy * dy <= i64::from(radius) * i64::from(radius)
}

/// Decode an image file the right way up: a phone photo's EXIF orientation
/// is applied, since the preview carries no EXIF to say it later.
fn decode_upright(path: &Path) -> Option<DynamicImage> {
    let reader = image::ImageReader::open(path).ok()?.with_guessed_format().ok()?;
    let mut decoder = reader.into_decoder().ok()?;
    let orientation = decoder.orientation().ok();
    let mut image = DynamicImage::from_decoder(decoder).ok()?;
    if let Some(o) = orientation {
        image.apply_orientation(o);
    }
    Some(image)
}

/// The chat preview for the file at `path` named `file_name`, or `None` when
/// none can be made here (a type this build cannot read, a file too large to
/// decode, a video whose frames the helper cannot read). Blocking.
#[must_use]
pub fn render_file(path: &Path, file_name: &str) -> Option<Vec<u8>> {
    match PreviewKind::of(file_name)? {
        PreviewKind::Image => {
            if std::fs::metadata(path).ok()?.len() > MAX_SOURCE_BYTES {
                return None;
            }
            render_image(&decode_upright(path)?).ok()
        }
        PreviewKind::Video => {
            let (frame, duration) = crate::capture::poster::still_from_file(path, POSTER_WAIT)?;
            render_recording(&frame, duration).ok()
        }
    }
}

// ─── Server ────────────────────────────────────────────────────────────────

/// Where `/v1/shares/{token}/preview` lives for this account, and its bearer.
async fn endpoint(state: &AppState, account_id: &str, share_token: &str) -> Result<(String, String)> {
    let pool = state.pool()?;
    let server_url = crate::sync::remote::get_server_url(pool, account_id).await?;
    let base = crate::sync::region::resolve_base_url(&server_url).trim_end_matches('/').to_string();
    let bearer = get_api_token(pool, account_id)
        .await?
        .ok_or_else(|| AppError::Auth("No authentication token found. Please log in again.".into()))?;
    Ok((format!("{base}/v1/shares/{share_token}/preview"), bearer))
}

/// Whether this account's server takes previews. Production lacks the
/// routes until it is deployed, and then this reads `false` and nothing is
/// sent. A probe that fails reads as `false` too: the preview is an extra.
async fn server_takes_previews(state: &AppState, account_id: &str) -> bool {
    match super::capabilities::fetch_capabilities(state, account_id).await {
        Ok(caps) => caps.share_preview,
        Err(e) => {
            debug!(error = %e, "share preview skipped: capabilities unavailable");
            false
        }
    }
}

/// `PUT /v1/shares/{token}/preview` with the picture and the cleaned file
/// name. A second PUT replaces the first.
///
/// # Errors
///
/// Anything short of a 2xx, as an [`AppError`]; the callers log it and move on.
pub async fn upload(state: &AppState, account_id: &str, share_token: &str, jpeg: Vec<u8>, file_name: &str) -> Result<()> {
    let (url, bearer) = endpoint(state, account_id, share_token).await?;
    let image = reqwest::multipart::Part::bytes(jpeg)
        .file_name("preview.jpg")
        .mime_str("image/jpeg")
        .map_err(|e| AppError::Other(format!("preview part: {e}")))?;
    let mut form = reqwest::multipart::Form::new().part("image", image);
    if let Some(title) = sanitize_title(file_name) {
        form = form.text("title", title);
    }
    let resp = state
        .api_client
        .put(&url)
        .bearer_auth(&bearer)
        .timeout(UPLOAD_TIMEOUT)
        .multipart(form)
        .send()
        .await
        // Without the URL: its path carries the link's token, which alone
        // opens this unencrypted preview.
        .map_err(|e| AppError::Hcfs(format!("share preview upload failed: {}", e.without_url())))?;
    if !resp.status().is_success() {
        return Err(AppError::Api {
            status: resp.status().as_u16(),
            body: resp.text().await.unwrap_or_default(),
        });
    }
    Ok(())
}

/// `DELETE /v1/shares/{token}/preview`: the link shows the generic card
/// again. Fine when there was none (the server answers 204 either way), and
/// a no-op on a server without previews, which cannot hold one.
///
/// # Errors
///
/// Anything short of a 2xx from a server that takes previews.
pub async fn remove(state: &AppState, account_id: &str, share_token: &str) -> Result<()> {
    if !server_takes_previews(state, account_id).await {
        return Ok(());
    }
    let (url, bearer) = endpoint(state, account_id, share_token).await?;
    let resp = state
        .api_client
        .delete(&url)
        .bearer_auth(&bearer)
        .timeout(UPLOAD_TIMEOUT)
        .send()
        .await
        .map_err(|e| AppError::Hcfs(format!("share preview removal failed: {}", e.without_url())))?;
    if !resp.status().is_success() {
        return Err(AppError::Api {
            status: resp.status().as_u16(),
            body: resp.text().await.unwrap_or_default(),
        });
    }
    Ok(())
}

/// Ask the server whether it takes previews, then render the preview for
/// `source` on a blocking thread. Starts at once, so a capture's preview is
/// read while its link is still being minted. `None` when the server takes
/// none or no preview can be made.
pub(crate) fn render_in_background(
    app: tauri::AppHandle,
    account_id: String,
    source: PathBuf,
    file_name: String,
) -> tauri::async_runtime::JoinHandle<Option<Vec<u8>>> {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        if !server_takes_previews(&state, &account_id).await {
            debug!("share preview skipped: the server does not take previews");
            return None;
        }
        tauri::async_runtime::spawn_blocking(move || render_file(&source, &file_name))
            .await
            .ok()
            .flatten()
    })
}

/// Send a rendered preview for a minted share, logging the outcome. Never
/// returns an error: the link is already live and copied.
pub(crate) async fn send_rendered(state: &AppState, account_id: &str, share_token: &str, jpeg: Option<Vec<u8>>, file_name: &str) {
    let Some(jpeg) = jpeg else { return };
    let bytes = jpeg.len();
    match upload(state, account_id, share_token, jpeg, file_name).await {
        Ok(()) => info!(bytes, "share preview uploaded"),
        Err(e) => warn!(error = %e, "share preview not uploaded (the link itself is fine)"),
    }
}

/// After a share is minted: make its preview from `source` and upload it, in
/// the background, so the share returns (and its link is copied) without
/// waiting. `remove_source` deletes `source` once it has been read (a
/// plaintext temp copy that only existed for the share).
pub(crate) fn spawn_upload(app: tauri::AppHandle, account_id: String, share_token: String, source: PathBuf, file_name: String, remove_source: bool) {
    tauri::async_runtime::spawn(async move {
        let rendered = render_in_background(app.clone(), account_id.clone(), source.clone(), file_name.clone())
            .await
            .ok()
            .flatten();
        if remove_source {
            let _ = tokio::fs::remove_file(&source).await;
        }
        let state = app.state::<AppState>();
        send_rendered(&state, &account_id, &share_token, rendered, &file_name).await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The marker of every segment before the picture data. A JPEG carrying
    /// metadata has APP1 (EXIF, XMP), APP2 (ICC) or COM segments here.
    fn jpeg_markers(bytes: &[u8]) -> Vec<u8> {
        assert_eq!(&bytes[..2], &[0xFF, 0xD8], "starts as a JPEG");
        let mut markers = Vec::new();
        let mut i = 2;
        while i + 4 <= bytes.len() {
            assert_eq!(bytes[i], 0xFF, "a segment starts at {i}");
            let marker = bytes[i + 1];
            markers.push(marker);
            if marker == 0xDA {
                break;
            }
            let len = usize::from(u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]));
            i += 2 + len;
        }
        markers
    }

    fn assert_no_metadata(bytes: &[u8]) {
        let markers = jpeg_markers(bytes);
        for m in &markers {
            assert!(
                matches!(m, 0xE0 | 0xDB | 0xC0 | 0xC2 | 0xC4 | 0xDD | 0xDA),
                "unexpected segment 0xFF{m:02X} in {markers:02X?}"
            );
        }
        assert!(!bytes.windows(4).any(|w| w == b"Exif"), "no EXIF anywhere");
    }

    /// Deterministic noise, the worst case for a JPEG's size.
    fn noise(w: u32, h: u32) -> DynamicImage {
        let mut seed: u32 = 0x1234_5678;
        DynamicImage::ImageRgb8(RgbImage::from_fn(w, h, |_, _| {
            let mut next = || {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                seed.to_be_bytes()[0]
            };
            Rgb([next(), next(), next()])
        }))
    }

    fn gradient(w: u32, h: u32) -> DynamicImage {
        DynamicImage::ImageRgb8(RgbImage::from_fn(w, h, |x, y| {
            #[allow(clippy::cast_possible_truncation)]
            Rgb([(x * 255 / w) as u8, (y * 255 / h) as u8, 128])
        }))
    }

    fn decoded(bytes: &[u8]) -> DynamicImage {
        image::load_from_memory_with_format(bytes, image::ImageFormat::Jpeg).expect("a JPEG")
    }

    #[test]
    fn a_big_screenshot_fits_1200_and_the_size_budget() {
        let out = render_image(&gradient(3456, 2234)).unwrap();
        assert!(out.len() <= MAX_BYTES, "{} bytes", out.len());
        let back = decoded(&out);
        assert_eq!((back.width(), back.height()), (1200, 776), "fitted, shape kept");
        assert_no_metadata(&out);
    }

    #[test]
    fn a_tall_picture_fits_by_its_height_and_a_small_one_is_not_enlarged() {
        let tall = decoded(&render_image(&gradient(800, 4000)).unwrap());
        assert_eq!((tall.width(), tall.height()), (240, 1200));
        let small = decoded(&render_image(&gradient(300, 200)).unwrap());
        assert_eq!((small.width(), small.height()), (300, 200));
    }

    #[test]
    fn noise_that_no_quality_fits_is_shrunk_until_it_does() {
        let out = render_image(&noise(2400, 2400)).unwrap();
        assert!(out.len() <= MAX_BYTES, "{} bytes", out.len());
        let back = decoded(&out);
        assert!(back.width() <= MAX_SIDE && back.height() <= MAX_SIDE);
        assert!(back.width() >= MIN_SIDE);
    }

    #[test]
    fn transparent_corners_turn_white_not_black() {
        let clear = DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(64, 64, image::Rgba([0, 0, 0, 0])));
        let back = decoded(&render_image(&clear).unwrap()).to_rgb8();
        let [r, g, b] = back.get_pixel(32, 32).0;
        assert!(r > 240 && g > 240 && b > 240, "{r} {g} {b}");
    }

    #[test]
    fn an_empty_picture_is_refused() {
        assert!(render_image(&DynamicImage::new_rgb8(0, 0)).is_err());
        assert!(render_recording(&DynamicImage::new_rgb8(0, 10), Some(3.0)).is_err());
    }

    /// A JPEG with an EXIF block (orientation "rotate 90", a camera name and
    /// GPS-like bytes) spliced in after its start marker, as a phone writes.
    fn jpeg_with_exif(w: u32, h: u32) -> Vec<u8> {
        let mut plain = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(Cursor::new(&mut plain), 90)
            .encode_image(&gradient(w, h).to_rgb8())
            .unwrap();
        // TIFF header (big endian), one IFD entry: Orientation (0x0112) = 6.
        let mut tiff = vec![b'M', b'M', 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0];
        tiff.extend_from_slice(b"SecretCamera GPS 51.5N 0.12W");
        let mut payload = b"Exif\0\0".to_vec();
        payload.extend_from_slice(&tiff);
        let len = u16::try_from(payload.len() + 2).unwrap().to_be_bytes();
        let mut out = vec![0xFF, 0xD8, 0xFF, 0xE1, len[0], len[1]];
        out.extend_from_slice(&payload);
        out.extend_from_slice(&plain[2..]);
        out
    }

    #[test]
    fn a_photos_metadata_is_stripped_and_its_orientation_applied() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("photo.jpg");
        std::fs::write(&path, jpeg_with_exif(400, 200)).unwrap();
        assert!(jpeg_markers(&std::fs::read(&path).unwrap()).contains(&0xE1), "the source carries EXIF");

        let out = render_file(&path, "photo.jpg").expect("a preview");
        assert_no_metadata(&out);
        assert!(!out.windows(12).any(|w| w == b"SecretCamera"));
        let back = decoded(&out);
        assert_eq!((back.width(), back.height()), (200, 400), "turned the right way up");
    }

    #[test]
    fn a_png_screenshot_file_renders() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Screenshot 2026-09-22 at 14.03.11.png");
        gradient(2000, 1000).save(&path).unwrap();
        let out = render_file(&path, "Screenshot 2026-09-22 at 14.03.11.png").expect("a preview");
        assert!(out.len() <= MAX_BYTES);
        assert_eq!(decoded(&out).width(), 1200);
    }

    #[test]
    fn files_that_cannot_be_previewed_render_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let doc = dir.path().join("notes.pdf");
        std::fs::write(&doc, b"%PDF-1.7").unwrap();
        assert!(render_file(&doc, "notes.pdf").is_none());
        let broken = dir.path().join("broken.png");
        std::fs::write(&broken, b"not a png").unwrap();
        assert!(render_file(&broken, "broken.png").is_none());
    }

    #[test]
    fn a_recording_gets_a_play_button_and_its_length() {
        let frame = DynamicImage::ImageRgb8(RgbImage::from_pixel(1920, 1080, Rgb([240, 240, 240])));
        let out = render_recording(&frame, Some(83.0)).unwrap();
        assert!(out.len() <= MAX_BYTES);
        assert_no_metadata(&out);
        let back = decoded(&out).to_rgb8();
        assert_eq!((back.width(), back.height()), (1200, 675));
        // The button's dark disc sits in the middle, white triangle inside.
        let [r, _, _] = back.get_pixel(600 - 60, 337).0;
        assert!(r < 140, "dark disc left of centre ({r})");
        let [r, g, b] = back.get_pixel(605, 337).0;
        assert!(r > 200 && g > 200 && b > 200, "white triangle at centre");
        // The corners stay the picture.
        assert!(back.get_pixel(5, 5).0[0] > 220);
        // The length label darkens the bottom-right corner (its right-hand
        // padding, mid-height), not the left.
        let label = back.get_pixel(1176, 637).0[0];
        let left = back.get_pixel(30, 637).0[0];
        assert!(label < 200 && left > 220, "label {label}, left {left}");
    }

    /// Writes a sample recording preview to look at:
    /// `HIPPIUS_PREVIEW_OUT=/tmp/p.jpg cargo test --lib writes_a_sample_recording_preview -- --ignored`.
    #[test]
    #[ignore = "writes a file named in HIPPIUS_PREVIEW_OUT"]
    fn writes_a_sample_recording_preview() {
        let out = std::env::var("HIPPIUS_PREVIEW_OUT").expect("HIPPIUS_PREVIEW_OUT");
        std::fs::write(out, render_recording(&gradient(1920, 1080), Some(754.0)).unwrap()).unwrap();
    }

    #[test]
    fn a_recording_with_no_known_length_has_no_label() {
        let frame = DynamicImage::ImageRgb8(RgbImage::from_pixel(640, 360, Rgb([240, 240, 240])));
        let back = decoded(&render_recording(&frame, None).unwrap()).to_rgb8();
        assert!(back.get_pixel(640 - 20, 360 - 16).0[0] > 220);
    }

    #[test]
    fn lengths_read_like_a_video_player() {
        assert_eq!(format_duration(0.4), "0:01", "anything that started counts");
        assert_eq!(format_duration(0.0), "0:00");
        assert_eq!(format_duration(42.4), "0:42");
        assert_eq!(format_duration(725.0), "12:05");
        assert_eq!(format_duration(3723.0), "1:02:03");
        assert_eq!(format_duration(f64::NAN), "0:00");
    }

    #[test]
    fn every_glyph_the_length_uses_is_drawn() {
        for c in "0123456789:".chars() {
            assert!(glyph(c).is_some(), "{c}");
        }
    }

    #[test]
    fn titles_follow_the_servers_rules() {
        assert_eq!(sanitize_title("  Screenshot.png  ").as_deref(), Some("Screenshot.png"));
        // A right-to-left override would make "gpj.exe" read as "exe.jpg".
        assert_eq!(sanitize_title("photo\u{202E}gpj.exe").as_deref(), Some("photogpj.exe"));
        assert_eq!(sanitize_title("a\u{200B}b\u{FEFF}c\u{2066}d\n").as_deref(), Some("abcd"));
        assert_eq!(sanitize_title("\u{200B}\t "), None);
        let long = "x".repeat(250);
        assert_eq!(sanitize_title(&long).unwrap().chars().count(), MAX_TITLE_CHARS);
        let accents = "é".repeat(250);
        assert_eq!(
            sanitize_title(&accents).unwrap().chars().count(),
            MAX_TITLE_CHARS,
            "counted in characters"
        );
    }

    #[test]
    fn pictures_and_videos_are_previewable_and_other_files_are_not() {
        assert_eq!(PreviewKind::of("a.PNG"), Some(PreviewKind::Image));
        assert_eq!(PreviewKind::of("a.jpeg"), Some(PreviewKind::Image));
        assert_eq!(PreviewKind::of("Recording.mp4"), Some(PreviewKind::Video));
        assert_eq!(PreviewKind::of("clip.MOV"), Some(PreviewKind::Video));
        for name in ["a.pdf", "a.zip", "a.heic", "a.gif", "README", ".png"] {
            assert_eq!(PreviewKind::of(name), None, "{name}");
        }
    }

    #[test]
    fn capture_names_are_recognised() {
        assert!(is_capture_name("Screenshot 2026-09-22 at 14.03.11.png"));
        assert!(is_capture_name("Recording 2026-09-22 at 09.00.05.mp4"));
        assert!(is_capture_name("Screenshot 2026-09-22 at 14.03.11 (edited).png"));
        assert!(is_capture_name("Screenshot 2026-09-22 at 14.03.11 (1).png"));
        assert!(!is_capture_name("Screenshot of my app.png"));
        assert!(!is_capture_name("holiday.png"));
        assert!(!is_capture_name("Screenshot 2026-9-22 at 14.03.11.png"));
    }

    /// The names the capture code writes are the names recognised here.
    #[test]
    fn the_names_captures_are_saved_under_are_recognised() {
        use crate::capture::session::CaptureKind;
        let at = chrono::NaiveDate::from_ymd_opt(2026, 1, 2).unwrap().and_hms_opt(3, 4, 5).unwrap();
        for kind in [CaptureKind::Screenshot, CaptureKind::Recording] {
            let name = crate::capture::naming::capture_file_name(kind, at);
            assert!(is_capture_name(&name), "{name}");
            assert!(PreviewKind::of(&name).is_some(), "{name}");
        }
    }

    #[test]
    fn the_switch_is_on_for_captures_and_off_for_everything_else() {
        let capture = default_for("Screenshot 2026-09-22 at 14.03.11.png", false, true, true);
        assert_eq!(capture, PreviewDefault { offered: true, on: true });
        let recording = default_for("Recording 2026-09-22 at 09.00.05.mp4", false, true, true);
        assert_eq!(recording, PreviewDefault { offered: true, on: true });
        // Another picture: offered, but off until the user turns it on.
        assert_eq!(
            default_for("holiday.jpg", false, false, true),
            PreviewDefault { offered: true, on: false }
        );
        // Nothing to preview: not offered, so off.
        assert_eq!(default_for("notes.pdf", false, false, true), PreviewDefault { offered: false, on: false });
        // A folder never gets one, whatever its name.
        assert_eq!(
            default_for("Screenshots.png", true, true, true),
            PreviewDefault { offered: false, on: false }
        );
    }

    #[test]
    fn settings_off_starts_the_switch_off_for_captures_too() {
        let off = default_for("Screenshot 2026-09-22 at 14.03.11.png", false, true, false);
        assert_eq!(off, PreviewDefault { offered: true, on: false });
        let off = default_for("Recording 2026-09-22 at 09.00.05.mp4", false, true, false);
        assert_eq!(off, PreviewDefault { offered: true, on: false });
    }

    #[test]
    fn a_password_share_never_sends_a_preview() {
        let private = ShareChoice::Private {
            password: "correct horse battery".into(),
        };
        assert!(!allowed(&private, true), "the password wins over the switch");
        assert!(!allowed(&private, false));
        assert!(allowed(&ShareChoice::Public, true));
        assert!(!allowed(&ShareChoice::Public, false), "switched off sends nothing");
    }
}
