//! The picture: a Windows.Graphics.Capture session on a monitor or a window,
//! through `windows-capture` (its session plumbing only; its encoder is not
//! used, see decision 1 of the plan).
//!
//! Settings: the cursor is drawn; the yellow border is turned off where
//! Windows lets an app do that (Windows 11, build 22000), and if it is
//! refused the session starts again with the default, so a refusal never
//! costs the recording; on Windows 11 24H2 (build 26100) WGC itself is
//! asked for at most 30 pictures a second, elsewhere [`Gate`] drops the
//! extra ones before any pixel is read.
//!
//! An area is the monitor's picture cropped on the GPU
//! (`CopySubresourceRegion` into the staging texture), so only its pixels
//! are read back. A window that is resized keeps the size it started at:
//! [`frame::to_nv12`] fits each picture into it. Hippius's own camera stage
//! is trimmed of its transparent margin, like the Swift helper's.

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Gdi::HMONITOR;
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, GetDpiForWindow, MDT_EFFECTIVE_DPI};
use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings, MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};
use windows_capture::window::Window;

use super::super::frame::{self, Bgra};
use super::super::pacing::Gate;
use super::super::plan::{self, PixelRect};
use super::{MAX_PENDING_FRAMES, Msg, Shared, Target, com};
use crate::capture::recording::protocol::CropRect;

/// Windows 11: the border may be switched off.
const BORDERLESS_FROM_BUILD: u32 = 22_000;
/// Windows 11 24H2: WGC takes a minimum update interval.
const MIN_INTERVAL_FROM_BUILD: u32 = 26_100;

/// Which part of each picture is recorded.
#[derive(Debug, Clone, Copy)]
enum Region {
    Whole,
    /// An area of a monitor, in its logical units, with its scale; turned
    /// into pixels from the first picture's size.
    Area {
        crop: CropRect,
        scale: f64,
        pixels: Option<PixelRect>,
    },
    /// Hippius's camera stage at this window scale.
    Stage {
        scale: f64,
    },
}

/// Everything the capture thread's handler needs, cloned into each start
/// attempt.
#[derive(Clone)]
struct Flags {
    shared: Arc<Shared>,
    region: Region,
    /// What a closed capture item means, said to the user.
    closed_reason: &'static str,
}

struct Handler {
    flags: Flags,
    gate: Gate,
    size: Option<(u32, u32)>,
    scratch: Vec<u8>,
    /// One read-back failure is said on stderr, not one per frame.
    warned: bool,
}

impl GraphicsCaptureApiHandler for Handler {
    type Flags = Flags;
    type Error = String;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self {
            flags: ctx.flags,
            gate: Gate::new(),
            size: None,
            scratch: Vec::new(),
            warned: false,
        })
    }

    fn on_frame_arrived(&mut self, frame: &mut Frame, control: InternalCaptureControl) -> Result<(), Self::Error> {
        let shared = Arc::clone(&self.flags.shared);
        let Ok(stamp) = frame.timestamp() else {
            return Ok(());
        };
        let Some(time) = shared.place(com::hns_to_micros(stamp.Duration)) else {
            return Ok(()); // paused
        };
        if shared.pending_frames.load(Ordering::SeqCst) >= MAX_PENDING_FRAMES || !self.gate.accept(time) {
            return Ok(());
        }
        let (width, height) = (frame.width(), frame.height());
        let Some(rect) = self.region_in(width, height) else {
            return Ok(());
        };
        let size = *self.size.get_or_insert_with(|| plan::output_size(rect.width(), rect.height()));
        let whole = rect
            == PixelRect {
                x0: 0,
                y0: 0,
                x1: width,
                y1: height,
            };
        let buffer = if whole {
            frame.buffer()
        } else {
            frame.buffer_crop(rect.x0, rect.y0, rect.x1, rect.y1)
        };
        let mut buffer = match buffer {
            Ok(buffer) => buffer,
            Err(e) => {
                if !self.warned {
                    self.warned = true;
                    let _ = super::writeln_stderr(&format!("a captured picture could not be read: {e}"));
                }
                return Ok(());
            }
        };
        let (w, h, stride) = (buffer.width(), buffer.height(), buffer.row_pitch() as usize);
        let data = buffer.as_raw_buffer();
        frame::to_nv12(
            Bgra {
                data,
                width: w,
                height: h,
                stride,
            },
            size.0,
            size.1,
            &mut self.scratch,
        );
        let picture = std::mem::take(&mut self.scratch);
        shared.pending_frames.fetch_add(1, Ordering::SeqCst);
        if !shared.send(Msg::Video { time, frame: picture, size }) {
            // The writer is gone: nothing more to record.
            control.stop();
        }
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        let _ = self.flags.shared.send(Msg::Ended(self.flags.closed_reason.into()));
        Ok(())
    }
}

impl Handler {
    /// The pixels recorded from a `width` x `height` picture.
    fn region_in(&mut self, width: u32, height: u32) -> Option<PixelRect> {
        let whole = PixelRect {
            x0: 0,
            y0: 0,
            x1: width,
            y1: height,
        };
        match &mut self.flags.region {
            Region::Whole => Some(whole),
            Region::Stage { scale } => Some(plan::stage_crop(width, height, *scale)),
            Region::Area { crop, scale, pixels } => {
                let first = *pixels.get_or_insert(plan::area_pixels(*crop, *scale, width, height)?);
                first.within(width, height)
            }
        }
    }
}

/// A running capture; [`Capture::stop`] ends it and waits for its thread.
pub struct Capture(windows_capture::capture::CaptureControl<Handler, String>);

impl Capture {
    pub fn stop(self) {
        if let Err(e) = self.0.stop() {
            let _ = super::writeln_stderr(&format!("the screen capture did not stop cleanly: {e}"));
        }
    }
}

/// Pixels per logical unit of a monitor (its effective DPI over 96).
fn monitor_scale(handle: isize) -> f64 {
    let (mut x, mut y) = (0u32, 0u32);
    // SAFETY: a monitor handle (possibly stale: the call then fails and
    // the scale falls back to 1) and two valid out-pointers.
    let ok = unsafe { GetDpiForMonitor(HMONITOR(handle as *mut _), MDT_EFFECTIVE_DPI, &raw mut x, &raw mut y) }.is_ok();
    if ok && x > 0 { f64::from(x) / 96.0 } else { 1.0 }
}

/// Pixels per CSS px of a window.
fn window_scale(handle: isize) -> f64 {
    // SAFETY: any window handle; 0 for an invalid one.
    let dpi = unsafe { GetDpiForWindow(HWND(handle as *mut _)) };
    if dpi > 0 { f64::from(dpi) / 96.0 } else { 1.0 }
}

/// Whether `window` belongs to Hippius itself: then it is the camera stage
/// (the app never offers its other windows), recorded without its margin.
fn is_own_window(window: Window) -> bool {
    let own = std::env::current_exe()
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_lowercase()));
    let theirs = window.process_name().ok().map(|n| n.to_lowercase());
    match (own, theirs) {
        (Some(own), Some(theirs)) => own == theirs || own.trim_end_matches(".exe") == theirs.trim_end_matches(".exe"),
        _ => false,
    }
}

/// Start capturing `target`, sending pictures to the writer through
/// `shared`.
pub(super) fn start(target: Target, shared: Arc<Shared>) -> Result<Capture, String> {
    let build = crate::capture::permissions::windows_build().unwrap_or(0);
    match target {
        Target::Monitor { handle, crop } => {
            let region = match crop {
                Some(crop) => Region::Area {
                    crop,
                    scale: monitor_scale(handle),
                    pixels: None,
                },
                None => Region::Whole,
            };
            let flags = Flags {
                shared,
                region,
                closed_reason: "The recorded display was disconnected.",
            };
            start_with(build, flags, || Monitor::from_raw_hmonitor(handle as *mut _))
        }
        Target::Window { handle } => {
            let window = Window::from_raw_hwnd(handle as *mut _);
            let region = if is_own_window(window) {
                Region::Stage { scale: window_scale(handle) }
            } else {
                Region::Whole
            };
            let flags = Flags {
                shared,
                region,
                closed_reason: "The recorded window was closed.",
            };
            start_with(build, flags, || Window::from_raw_hwnd(handle as *mut _))
        }
    }
}

/// Start a session on the item `make` builds, borderless where allowed, and
/// again with the default border if Windows refuses that.
fn start_with<T, F>(build: u32, flags: Flags, make: F) -> Result<Capture, String>
where
    T: TryInto<windows_capture::settings::GraphicsCaptureItemType> + Send + 'static,
    F: Fn() -> T,
{
    let interval = if build >= MIN_INTERVAL_FROM_BUILD {
        MinimumUpdateIntervalSettings::Custom(Duration::from_micros(super::super::pacing::MIN_GAP))
    } else {
        MinimumUpdateIntervalSettings::Default
    };
    let settings = |border: DrawBorderSettings, interval: MinimumUpdateIntervalSettings| {
        Settings::new(
            make(),
            CursorCaptureSettings::WithCursor,
            border,
            SecondaryWindowSettings::Default,
            interval,
            DirtyRegionSettings::Default,
            ColorFormat::Bgra8,
            flags.clone(),
        )
    };
    let attempts = if build >= BORDERLESS_FROM_BUILD {
        vec![
            (DrawBorderSettings::WithoutBorder, interval),
            (DrawBorderSettings::Default, interval),
            (DrawBorderSettings::Default, MinimumUpdateIntervalSettings::Default),
        ]
    } else {
        vec![
            (DrawBorderSettings::Default, interval),
            (DrawBorderSettings::Default, MinimumUpdateIntervalSettings::Default),
        ]
    };
    let mut last = String::new();
    for (border, interval) in attempts {
        match Handler::start_free_threaded(settings(border, interval)) {
            Ok(control) => return Ok(Capture(control)),
            Err(e) => {
                last = e.to_string();
                let _ = super::writeln_stderr(&format!("screen capture refused {border:?} / {interval:?}: {last}"));
            }
        }
    }
    Err(format!("The screen could not be captured: {last}"))
}
