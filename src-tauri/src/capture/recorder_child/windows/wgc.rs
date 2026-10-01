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
//!
//! A window recording with the camera bubble on screen runs a second session
//! on the bubble's window ([`WithCamera`]): WGC films one item, so the
//! latest picture of each window is kept and the bubble drawn into the
//! recorded window's picture ([`overlay`]) whenever either changes, where it
//! sits on screen. The bubble's video moves on even while the recorded
//! window is still (WGC only sends a window's picture when it changes).

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Dwm::{DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute};
use windows::Win32::Graphics::Gdi::HMONITOR;
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, GetDpiForWindow, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::WindowsAndMessaging::{IsIconic, IsWindowVisible};
use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
use windows_capture::frame::{Frame, FrameBuffer};
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings, MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};
use windows_capture::window::Window;

use super::super::frame::{self, Bgra};
use super::super::overlay::{self, Pixels};
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
    /// A window recording with the camera bubble drawn in: pictures go
    /// through it instead of straight to the writer.
    composer: Option<Composer>,
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
        let placed = shared.place(com::hns_to_micros(stamp.Duration));
        if let Some(composer) = self.flags.composer.clone() {
            // Every picture of the window is kept, paused or not (WGC sends
            // one only when the window changes); the composer paces what is
            // recorded.
            let Some(picture) = self.read_whole(frame) else {
                return Ok(());
            };
            if !lock(&composer).window_arrived(picture, placed, &shared) {
                control.stop();
            }
            return Ok(());
        }
        let Some(time) = placed else {
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
    /// The whole picture, read back without row padding.
    fn read_whole(&mut self, frame: &mut Frame) -> Option<Picture> {
        match frame.buffer() {
            Ok(buffer) => Some(Picture::read(&buffer, &mut self.scratch)),
            Err(e) => {
                if !self.warned {
                    self.warned = true;
                    let _ = super::writeln_stderr(&format!("a captured picture could not be read: {e}"));
                }
                None
            }
        }
    }

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
/// A window recording with the camera holds the bubble's session too.
pub struct Capture {
    main: windows_capture::capture::CaptureControl<Handler, String>,
    camera: Option<windows_capture::capture::CaptureControl<CameraHandler, String>>,
}

impl Capture {
    pub fn stop(self) {
        if let Some(camera) = self.camera
            && let Err(e) = camera.stop()
        {
            let _ = super::writeln_stderr(&format!("the camera capture did not stop cleanly: {e}"));
        }
        if let Err(e) = self.main.stop() {
            let _ = super::writeln_stderr(&format!("the screen capture did not stop cleanly: {e}"));
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A window's picture, BGRA without row padding.
struct Picture {
    pixels: Vec<u8>,
    width: u32,
    height: u32,
}

impl Picture {
    fn read(buffer: &FrameBuffer<'_>, scratch: &mut Vec<u8>) -> Self {
        let (width, height) = (buffer.width(), buffer.height());
        let pixels = buffer.as_nopadding_buffer(scratch).to_vec();
        Self { pixels, width, height }
    }
}

/// A window recording with the camera bubble drawn in: the latest picture
/// of the recorded window and of the bubble's window, composited and sent
/// whenever either arrives (at most 30 a second, by one [`Gate`]).
pub(super) struct WithCamera {
    window_hwnd: isize,
    camera_hwnd: isize,
    window: Option<Picture>,
    camera: Option<Picture>,
    size: Option<(u32, u32)>,
    gate: Gate,
    composed: Vec<u8>,
    nv12: Vec<u8>,
}

type Composer = Arc<Mutex<WithCamera>>;

impl WithCamera {
    fn new(window_hwnd: isize, camera_hwnd: isize) -> Self {
        Self {
            window_hwnd,
            camera_hwnd,
            window: None,
            camera: None,
            size: None,
            gate: Gate::new(),
            composed: Vec::new(),
            nv12: Vec::new(),
        }
    }

    /// A new picture of the recorded window, recorded at `time` (`None`
    /// while paused: kept, not recorded). False once the writer is gone.
    fn window_arrived(&mut self, picture: Picture, time: Option<u64>, shared: &Shared) -> bool {
        self.window = Some(picture);
        time.is_none_or(|time| self.render(time, shared))
    }

    /// A new picture of the bubble, as [`Self::window_arrived`].
    fn camera_arrived(&mut self, picture: Picture, time: Option<u64>, shared: &Shared) -> bool {
        self.camera = Some(picture);
        time.is_none_or(|time| self.render(time, shared))
    }

    fn render(&mut self, time: u64, shared: &Shared) -> bool {
        if shared.pending_frames.load(Ordering::SeqCst) >= MAX_PENDING_FRAMES || !self.gate.accept(time) {
            return true;
        }
        let Some(window) = &self.window else {
            return true;
        };
        // The output size is the window's size when recording began; a
        // resized window is fitted into it.
        let size = *self.size.get_or_insert_with(|| plan::output_size(window.width, window.height));
        self.composed.clear();
        self.composed.extend_from_slice(&window.pixels);
        if let Some(camera) = &self.camera
            && window_shown(self.camera_hwnd)
            && let (Some(on_screen), Some(bubble)) = (frame_bounds(self.window_hwnd), frame_bounds(self.camera_hwnd))
        {
            let at = overlay::placement(on_screen, bubble, (window.width, window.height));
            let shape = overlay::bubble_shape(camera.width, camera.height, window_scale(self.camera_hwnd));
            overlay::composite(
                &mut self.composed,
                window.width,
                window.height,
                window.width as usize * 4,
                Pixels {
                    data: &camera.pixels,
                    width: camera.width,
                    height: camera.height,
                    stride: camera.width as usize * 4,
                },
                at,
                shape,
            );
        }
        frame::to_nv12(
            Bgra {
                data: &self.composed,
                width: window.width,
                height: window.height,
                stride: window.width as usize * 4,
            },
            size.0,
            size.1,
            &mut self.nv12,
        );
        let picture = std::mem::take(&mut self.nv12);
        shared.pending_frames.fetch_add(1, Ordering::SeqCst);
        shared.send(Msg::Video { time, frame: picture, size })
    }
}

/// The bubble's own session: each picture goes to the composer.
pub(super) struct CameraHandler {
    composer: Composer,
    shared: Arc<Shared>,
    scratch: Vec<u8>,
}

impl GraphicsCaptureApiHandler for CameraHandler {
    type Flags = (Composer, Arc<Shared>);
    type Error = String;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        let (composer, shared) = ctx.flags;
        Ok(Self {
            composer,
            shared,
            scratch: Vec::new(),
        })
    }

    fn on_frame_arrived(&mut self, frame: &mut Frame, control: InternalCaptureControl) -> Result<(), Self::Error> {
        let Ok(stamp) = frame.timestamp() else {
            return Ok(());
        };
        let time = self.shared.place(com::hns_to_micros(stamp.Duration));
        let Ok(buffer) = frame.buffer() else {
            return Ok(());
        };
        let picture = Picture::read(&buffer, &mut self.scratch);
        if !lock(&self.composer).camera_arrived(picture, time, &self.shared) {
            control.stop();
        }
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        // The bubble went away: the recording goes on without it.
        lock(&self.composer).camera = None;
        Ok(())
    }
}

/// Whether a window is on screen now (the pill can hide the bubble).
fn window_shown(handle: isize) -> bool {
    let hwnd = HWND(handle as *mut _);
    // SAFETY: plain queries on a window handle; a stale one reads as hidden.
    unsafe { IsWindowVisible(hwnd).as_bool() && !IsIconic(hwnd).as_bool() }
}

/// A window's frame on screen in physical pixels, without its invisible
/// resize borders (what WGC films).
fn frame_bounds(handle: isize) -> Option<overlay::Rect> {
    let mut rect = RECT::default();
    // SAFETY: a RECT-sized out-buffer for the attribute that fills a RECT.
    unsafe {
        DwmGetWindowAttribute(
            HWND(handle as *mut _),
            DWMWA_EXTENDED_FRAME_BOUNDS,
            (&raw mut rect).cast(),
            u32::try_from(std::mem::size_of::<RECT>()).ok()?,
        )
        .ok()?;
    }
    Some(overlay::Rect {
        x: rect.left,
        y: rect.top,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
    })
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
/// `shared`. A window recording with `camera` (the bubble's window) films
/// the bubble into it; if the bubble cannot be captured the window is
/// recorded without it.
pub(super) fn start(target: Target, shared: Arc<Shared>, camera: Option<isize>) -> Result<Capture, String> {
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
                composer: None,
            };
            let main = start_with(build, flags, || Monitor::from_raw_hmonitor(handle as *mut _))?;
            Ok(Capture { main, camera: None })
        }
        Target::Window { handle } => {
            let window = Window::from_raw_hwnd(handle as *mut _);
            let region = if is_own_window(window) {
                Region::Stage { scale: window_scale(handle) }
            } else {
                Region::Whole
            };
            let with_camera = camera.filter(|c| *c != handle && matches!(region, Region::Whole));
            let composer = with_camera.map(|camera| Arc::new(Mutex::new(WithCamera::new(handle, camera))));
            let flags = Flags {
                shared: Arc::clone(&shared),
                region,
                closed_reason: "The recorded window was closed.",
                composer: composer.clone(),
            };
            let main = start_with(build, flags, || Window::from_raw_hwnd(handle as *mut _))?;
            let camera = match (with_camera, composer) {
                (Some(camera), Some(composer)) => match start_camera(build, camera, composer, shared) {
                    Ok(control) => Some(control),
                    Err(e) => {
                        let _ = super::writeln_stderr(&format!("the camera bubble could not be added to the window recording: {e}"));
                        None
                    }
                },
                _ => None,
            };
            Ok(Capture { main, camera })
        }
    }
}

/// The bubble's own session, feeding `composer`. No cursor: the recorded
/// window's picture already carries it.
fn start_camera(
    build: u32,
    camera: isize,
    composer: Composer,
    shared: Arc<Shared>,
) -> Result<windows_capture::capture::CaptureControl<CameraHandler, String>, String> {
    let border = if build >= BORDERLESS_FROM_BUILD {
        DrawBorderSettings::WithoutBorder
    } else {
        DrawBorderSettings::Default
    };
    let settings = |border: DrawBorderSettings| {
        Settings::new(
            Window::from_raw_hwnd(camera as *mut _),
            CursorCaptureSettings::WithoutCursor,
            border,
            SecondaryWindowSettings::Default,
            MinimumUpdateIntervalSettings::Default,
            DirtyRegionSettings::Default,
            ColorFormat::Bgra8,
            (Arc::clone(&composer), Arc::clone(&shared)),
        )
    };
    CameraHandler::start_free_threaded(settings(border))
        .or_else(|_| CameraHandler::start_free_threaded(settings(DrawBorderSettings::Default)))
        .map_err(|e| e.to_string())
}

/// Start a session on the item `make` builds, borderless where allowed, and
/// again with the default border if Windows refuses that.
fn start_with<T, F>(build: u32, flags: Flags, make: F) -> Result<windows_capture::capture::CaptureControl<Handler, String>, String>
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
            Ok(control) => return Ok(control),
            Err(e) => {
                last = e.to_string();
                let _ = super::writeln_stderr(&format!("screen capture refused {border:?} / {interval:?}: {last}"));
            }
        }
    }
    Err(format!("The screen could not be captured: {last}"))
}
