//! Screenshots on Wayland, through the desktop's own screenshot tool.
//!
//! A Wayland app can neither see other windows nor draw over the screen, so
//! there is no Hippius overlay there: `capture_start` asks the
//! xdg-desktop-portal Screenshot interface with `interactive = true`, and the
//! desktop's tool (GNOME Shell's screenshot UI, KDE's dialog, the wlroots
//! portal's picker) lets the user choose an area, a window or a screen. The
//! portal answers with a `file://` URI of the PNG it wrote, usually in
//! `~/Pictures/Screenshots` or a temp folder. Hippius MOVES that file into
//! its own capture folder under its own name, so the user is not left with a
//! second copy outside the drive, then shows the card and delivers it like
//! any other screenshot. Cancelling in the desktop's tool ends the session as
//! a cancel, never as a failure.
//!
//! Everything but the D-Bus call is pure and tested on every OS; the call
//! itself (`request`) is Linux only.

use std::path::{Path, PathBuf};

use crate::error::{AppError, Result};

/// What the portal answered, before Hippius does anything with it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PortalAnswer {
    /// The screenshot was saved here (a `file://` URI).
    Saved(String),
    /// The user closed the desktop's screenshot tool without taking one.
    Cancelled,
    /// No portal answers on this desktop (none installed, or its backend has
    /// no Screenshot interface).
    Missing,
    /// The portal answered with an error; the detail is for the log.
    Failed(String),
}

/// What the session does next.
#[derive(Debug)]
pub enum PortalShot {
    /// The screenshot is at `path` (moved into the capture folder). `image`
    /// is its pixels for the card's picture, when they could be read.
    Taken {
        path: PathBuf,
        image: Option<image::RgbaImage>,
    },
    Cancelled,
}

/// No screenshot portal on this desktop.
pub const PORTAL_MISSING: &str = "Your desktop has no screenshot service Hippius can use. Install xdg-desktop-portal and the portal for your desktop (GNOME, KDE or wlroots), then try again.";
/// The portal answered without a screenshot.
pub const PORTAL_FAILED: &str = "Your desktop's screenshot tool didn't take the screenshot. Try again.";
/// The portal named a file Hippius cannot read.
pub const PORTAL_FILE_UNREADABLE: &str = "Hippius couldn't open the screenshot your desktop saved. Try again.";

/// A local path from a `file://` URI: `file:///home/me/A%20B.png` and
/// `file://localhost/...` alike, percent-decoded byte for byte (a Linux file
/// name is bytes, not necessarily UTF-8). `None` for any other scheme, a
/// remote host, a relative path, or a broken escape.
#[must_use]
pub fn file_uri_to_path(uri: &str) -> Option<PathBuf> {
    let rest = uri.strip_prefix("file://").or_else(|| {
        // Schemes are case-insensitive.
        let (scheme, rest) = uri.split_once("://")?;
        scheme.eq_ignore_ascii_case("file").then_some(rest)
    })?;
    let path = if rest.starts_with('/') {
        rest
    } else {
        let (host, _) = rest.split_once('/')?;
        if !host.eq_ignore_ascii_case("localhost") {
            return None;
        }
        // Put back the slash `split_once` took.
        &rest[host.len()..]
    };
    debug_assert!(path.starts_with('/'));
    // A query or fragment is not part of a file path.
    let path = path.split(['?', '#']).next()?;
    let bytes = percent_decode(path)?;
    if bytes.contains(&0) {
        return None;
    }
    Some(path_from_bytes(bytes))
}

#[cfg(unix)]
fn path_from_bytes(bytes: Vec<u8>) -> PathBuf {
    use std::os::unix::ffi::OsStringExt;
    PathBuf::from(std::ffi::OsString::from_vec(bytes))
}

#[cfg(not(unix))]
fn path_from_bytes(bytes: Vec<u8>) -> PathBuf {
    PathBuf::from(String::from_utf8_lossy(&bytes).into_owned())
}

fn percent_decode(s: &str) -> Option<Vec<u8>> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes.get(i + 1..i + 3)?;
            let text = std::str::from_utf8(hex).ok()?;
            out.push(u8::from_str_radix(text, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    Some(out)
}

/// Move `src` to `dest`: a rename where both are on one filesystem, else a
/// copy and then the original removed, so either way exactly one copy is
/// left and it is Hippius's. Never overwrites `dest`.
///
/// # Errors
///
/// The move failed; `src` is then still where it was.
pub fn move_into(src: &Path, dest: &Path) -> std::io::Result<()> {
    if dest.exists() {
        return Err(std::io::Error::new(std::io::ErrorKind::AlreadyExists, "the destination exists"));
    }
    if std::fs::rename(src, dest).is_ok() {
        return Ok(());
    }
    // EXDEV and friends: another filesystem (a /tmp on tmpfs).
    std::fs::copy(src, dest)?;
    if let Err(e) = std::fs::remove_file(src) {
        // The copy is kept; a leftover original is only untidy.
        tracing::warn!(error = %e, "capture: the desktop's copy of the screenshot was not removed");
    }
    Ok(())
}

/// Turn the portal's answer into a screenshot at `dest` (a `.png` in a
/// fresh capture folder). Blocking: file moves and a PNG decode.
///
/// # Errors
///
/// The portal is missing or failed, or its file could not be taken; every
/// message is a sentence the card and the toast can show as is.
pub fn settle(answer: PortalAnswer, dest: &Path) -> Result<PortalShot> {
    let uri = match answer {
        PortalAnswer::Saved(uri) => uri,
        PortalAnswer::Cancelled => return Ok(PortalShot::Cancelled),
        PortalAnswer::Missing => return Err(AppError::Validation(PORTAL_MISSING.into())),
        PortalAnswer::Failed(detail) => {
            tracing::warn!(detail = %detail, "capture: the screenshot portal failed");
            return Err(AppError::Validation(PORTAL_FAILED.into()));
        }
    };
    let src = file_uri_to_path(&uri).ok_or_else(|| {
        tracing::warn!("capture: the screenshot portal returned a location that is not a local file");
        AppError::Validation(PORTAL_FILE_UNREADABLE.into())
    })?;
    // A regular file the portal just wrote: never follow a link somewhere else.
    let meta = std::fs::symlink_metadata(&src).map_err(|_| AppError::Validation(PORTAL_FILE_UNREADABLE.into()))?;
    if !meta.is_file() {
        return Err(AppError::Validation(PORTAL_FILE_UNREADABLE.into()));
    }
    let is_png = src.extension().is_some_and(|e| e.eq_ignore_ascii_case("png"));
    if is_png {
        move_into(&src, dest).map_err(|e| AppError::Other(format!("Could not save the screenshot: {e}")))?;
        // The picture is only for the card; a file that will not decode is
        // still delivered.
        let image = image::open(dest).ok().map(|i| i.to_rgba8());
        return Ok(PortalShot::Taken {
            path: dest.to_path_buf(),
            image,
        });
    }
    // Some backends can be set to save JPEG: Captures are PNG, so it is
    // re-encoded, and the desktop's copy removed only once ours exists.
    let image = image::open(&src)
        .map_err(|_| AppError::Validation(PORTAL_FILE_UNREADABLE.into()))?
        .to_rgba8();
    crate::capture::screenshot::save_png(&image, dest)?;
    if let Err(e) = std::fs::remove_file(&src) {
        tracing::warn!(error = %e, "capture: the desktop's copy of the screenshot was not removed");
    }
    Ok(PortalShot::Taken {
        path: dest.to_path_buf(),
        image: Some(image),
    })
}

/// Ask the desktop's screenshot tool for a screenshot, letting the user
/// choose what (`interactive`). Waits as long as the user takes.
#[cfg(target_os = "linux")]
pub async fn request() -> PortalAnswer {
    use ashpd::desktop::screenshot::Screenshot;

    let sent = Screenshot::request().interactive(true).modal(false).send().await;
    match sent.and_then(|request| request.response()) {
        Ok(shot) => PortalAnswer::Saved(shot.uri().as_str().to_string()),
        Err(e) => classify(&e),
    }
}

/// No portal outside Linux. `capture_start` only takes this path where
/// `support::Surfaces::selection` is the system picker (Wayland), so this
/// answer is never reached; it keeps the session code the same on every OS.
#[cfg(not(target_os = "linux"))]
#[allow(clippy::unused_async)]
pub async fn request() -> PortalAnswer {
    PortalAnswer::Missing
}

/// Which [`PortalAnswer`] an ashpd error is. A missing portal shows as
/// `PortalNotFound`, or as a D-Bus "no such service / method / interface"
/// error from a bus with no portal frontend at all.
#[cfg(target_os = "linux")]
fn classify(e: &ashpd::Error) -> PortalAnswer {
    use ashpd::desktop::ResponseError;

    match e {
        ashpd::Error::Response(ResponseError::Cancelled) => PortalAnswer::Cancelled,
        ashpd::Error::PortalNotFound(_) => PortalAnswer::Missing,
        ashpd::Error::Zbus(ashpd::zbus::Error::MethodError(name, _, _)) if is_missing_service(name.as_str()) => PortalAnswer::Missing,
        other => PortalAnswer::Failed(other.to_string()),
    }
}

/// The D-Bus error names that mean nobody serves the Screenshot portal.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn is_missing_service(error_name: &str) -> bool {
    matches!(
        error_name,
        "org.freedesktop.DBus.Error.ServiceUnknown"
            | "org.freedesktop.DBus.Error.UnknownMethod"
            | "org.freedesktop.DBus.Error.UnknownInterface"
            | "org.freedesktop.DBus.Error.UnknownObject"
            | "org.freedesktop.DBus.Error.NameHasNoOwner"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_uri_becomes_its_path_with_escapes_decoded() {
        assert_eq!(
            file_uri_to_path("file:///home/me/Pictures/Screenshots/Screenshot%20from%202026-10-01%2010-00-00.png"),
            Some(PathBuf::from("/home/me/Pictures/Screenshots/Screenshot from 2026-10-01 10-00-00.png"))
        );
        assert_eq!(file_uri_to_path("FILE:///tmp/a.png"), Some(PathBuf::from("/tmp/a.png")));
        assert_eq!(file_uri_to_path("file://localhost/tmp/a.png"), Some(PathBuf::from("/tmp/a.png")));
        // UTF-8 names arrive percent-encoded byte by byte.
        assert_eq!(
            file_uri_to_path("file:///home/me/Bilder/Bildschirmfoto%20%C3%BCber.png"),
            Some(PathBuf::from("/home/me/Bilder/Bildschirmfoto \u{fc}ber.png"))
        );
    }

    /// KDE and the wlroots portal write to a temp folder, not the home
    /// directory; that is still the user's screenshot to take.
    #[test]
    fn a_uri_outside_the_home_directory_is_accepted() {
        assert_eq!(
            file_uri_to_path("file:///tmp/Screenshot_20261001_100000.png"),
            Some(PathBuf::from("/tmp/Screenshot_20261001_100000.png"))
        );
        assert_eq!(
            file_uri_to_path("file:///run/user/1000/doc/abc/shot.png"),
            Some(PathBuf::from("/run/user/1000/doc/abc/shot.png"))
        );
    }

    #[test]
    fn anything_but_a_local_file_is_refused() {
        assert_eq!(file_uri_to_path("https://example.com/a.png"), None);
        assert_eq!(file_uri_to_path("file://otherhost/tmp/a.png"), None, "a remote host");
        assert_eq!(file_uri_to_path("file://relative.png"), None);
        assert_eq!(file_uri_to_path("/tmp/a.png"), None, "a bare path is not a URI");
        assert_eq!(file_uri_to_path("file:///tmp/a%2.png"), None, "a broken escape");
        assert_eq!(file_uri_to_path("file:///tmp/a%00.png"), None, "a NUL is never part of a path");
        assert_eq!(file_uri_to_path("file:///tmp/a.png?x=1"), Some(PathBuf::from("/tmp/a.png")));
    }

    fn png_at(path: &Path, w: u32, h: u32) {
        let img = image::RgbaImage::from_pixel(w, h, image::Rgba([10, 20, 30, 255]));
        crate::capture::screenshot::save_png(&img, path).unwrap();
    }

    /// The desktop's copy is MOVED: after a capture there is one file, the
    /// one in the capture folder, under Hippius's name.
    #[test]
    fn the_portals_file_is_moved_not_copied() {
        let pictures = tempfile::tempdir().unwrap();
        let capture = tempfile::tempdir().unwrap();
        let src = pictures.path().join("Screenshot from 2026-10-01 10-00-00.png");
        png_at(&src, 40, 20);
        let dest = capture.path().join("Screenshot 2026-10-01 at 10.00.00.png");
        let uri = format!("file://{}", src.display()).replace(' ', "%20");
        let PortalShot::Taken { path, image } = settle(PortalAnswer::Saved(uri), &dest).unwrap() else {
            panic!("a screenshot");
        };
        assert_eq!(path, dest);
        assert!(dest.is_file());
        assert!(!src.exists(), "the desktop's copy is gone");
        assert_eq!(image.map(|i| (i.width(), i.height())), Some((40, 20)));
    }

    #[test]
    fn a_jpeg_from_the_portal_is_saved_as_png_and_the_original_removed() {
        let pictures = tempfile::tempdir().unwrap();
        let capture = tempfile::tempdir().unwrap();
        let src = pictures.path().join("shot.jpg");
        image::RgbImage::from_pixel(8, 6, image::Rgb([200, 0, 0])).save(&src).unwrap();
        let dest = capture.path().join("Screenshot.png");
        let PortalShot::Taken { path, .. } = settle(PortalAnswer::Saved(format!("file://{}", src.display())), &dest).unwrap() else {
            panic!("a screenshot");
        };
        assert_eq!(image::ImageFormat::from_path(&path).unwrap(), image::ImageFormat::Png);
        assert_eq!(image::open(&path).unwrap().width(), 8);
        assert!(!src.exists());
    }

    #[test]
    fn a_move_never_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("a.png");
        let dest = dir.path().join("b.png");
        std::fs::write(&src, b"new").unwrap();
        std::fs::write(&dest, b"old").unwrap();
        assert!(move_into(&src, &dest).is_err());
        assert_eq!(std::fs::read(&dest).unwrap(), b"old");
        assert!(src.exists(), "a refused move leaves the original");
    }

    /// Cancelling in the desktop's tool is the user's choice: no error, so
    /// no toast, no failed card.
    #[test]
    fn a_cancelled_portal_is_a_cancel_not_a_failure() {
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(
            settle(PortalAnswer::Cancelled, &dir.path().join("x.png")),
            Ok(PortalShot::Cancelled)
        ));
    }

    #[test]
    fn a_missing_or_failed_portal_says_what_to_do() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("x.png");
        let Err(AppError::Validation(missing)) = settle(PortalAnswer::Missing, &dest) else {
            panic!("a refusal");
        };
        assert!(missing.contains("xdg-desktop-portal"), "{missing}");
        let Err(AppError::Validation(failed)) = settle(PortalAnswer::Failed("org.freedesktop.portal.Error.Failed".into()), &dest) else {
            panic!("a refusal");
        };
        assert_eq!(failed, PORTAL_FAILED, "the D-Bus detail is logged, never shown");
        let Err(AppError::Validation(gone)) = settle(PortalAnswer::Saved("file:///nowhere/at/all.png".into()), &dest) else {
            panic!("a refusal");
        };
        assert_eq!(gone, PORTAL_FILE_UNREADABLE);
        assert!(!dest.exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_link_is_never_followed() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real.png");
        png_at(&real, 4, 4);
        let link = dir.path().join("link.png");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let dest = dir.path().join("out.png");
        assert!(settle(PortalAnswer::Saved(format!("file://{}", link.display())), &dest).is_err());
        assert!(real.exists() && !dest.exists());
    }

    #[test]
    fn only_a_bus_without_the_service_reads_as_missing() {
        assert!(is_missing_service("org.freedesktop.DBus.Error.ServiceUnknown"));
        assert!(is_missing_service("org.freedesktop.DBus.Error.UnknownMethod"));
        assert!(!is_missing_service("org.freedesktop.portal.Error.NotAllowed"));
        assert!(!is_missing_service("org.freedesktop.DBus.Error.AccessDenied"));
    }
}
