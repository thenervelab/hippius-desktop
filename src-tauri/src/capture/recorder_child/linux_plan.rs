//! The Linux recorder's decisions, apart from GStreamer and D-Bus so they are
//! tested on every OS. `recorder_child::linux` (Linux only) carries them out.
//!
//! - **Which encoders:** the first the distro installed, in the plan's order
//!   (hardware first), or `codecsMissing` when there is no H.264 or no AAC.
//!   The `--probe` answer ([`Probe`]) also names every other element a
//!   recording needs, so a missing plugin is said before Record is pressed.
//! - **Two kinds of pipeline, joined by Rust.** Each capture device has its
//!   own small pipeline ending in an `appsink`: the picture
//!   ([`video_capture`]: `ximagesrc` on X11, `pipewiresrc` on the ScreenCast
//!   portal's stream on Wayland, scaled to the recording's fixed size) and
//!   each sound source ([`audio_capture`]: `pulsesrc`, which PipeWire serves
//!   too). The file is written by one more pipeline that starts at an
//!   `appsrc` ([`encode`]). In between, Rust places every sample on the
//!   pause [`super::timeline`], mixes the sound into one track with the same
//!   [`super::mixer`] Windows uses, and holds still pictures
//!   ([`super::pacing`]), exactly as on Windows (`super::pipeline`). So pause
//!   needs no pad probes on a live pipeline, a device that will not open is
//!   left out without failing the recording, and every device has ONE owner.
//! - **Which microphones:** PipeWire / PulseAudio sources without the
//!   `.monitor` sources (those are system audio), default first. System
//!   audio is the default output's monitor, `@DEFAULT_MONITOR@`, which both
//!   PulseAudio and `pipewire-pulse` resolve.
//! - **What the portal is asked:** a monitor or a window, the pointer drawn
//!   in, and for a monitor a session that can be restored without asking
//!   again ([`PortalAsk`]).
//! - **Why a recording ended on its own** ([`ended_reason`]), in the words
//!   the app logs and delivers with the file.
//!
//! See `docs/plans/2026-10-01-capture-windows-linux.md`, decision 3 and
//! Phase 4.

use std::fmt::Write as _;

use serde::{Deserialize, Serialize};

use super::plan::{self, PixelRect};
use crate::capture::recording::protocol::StartCommand;
use crate::capture::recording::{MediaDevice, RecordingUnavailable, tidy_devices};
use crate::capture::targets::DisplayTarget;

/// An H.264 encoder element, in the order the plan prefers them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum H264Encoder {
    /// VA-API through GStreamer's `va` plugin (1.22+): hardware.
    Va,
    /// The older `gstreamer-vaapi` plugin: hardware.
    Vaapi,
    /// x264 (plugins-ugly): software, the common Debian and Ubuntu path.
    X264,
    /// Cisco's OpenH264: Fedora's default through its own repository.
    OpenH264,
}

impl H264Encoder {
    pub const PREFERENCE: [Self; 4] = [Self::Va, Self::Vaapi, Self::X264, Self::OpenH264];

    #[must_use]
    pub const fn factory(self) -> &'static str {
        match self {
            Self::Va => "vah264enc",
            Self::Vaapi => "vaapih264enc",
            Self::X264 => "x264enc",
            Self::OpenH264 => "openh264enc",
        }
    }

    /// The element with its bit rate and a keyframe every 2 s at 30 fps
    /// (the Swift helper's GOP). Units differ: x264 and the VA encoders take
    /// kbit/s, OpenH264 bit/s.
    #[must_use]
    pub fn element(self, bits_per_second: u32) -> String {
        let kbps = bits_per_second.div_ceil(1000);
        match self {
            Self::Va => format!("vah264enc bitrate={kbps} key-int-max=60"),
            Self::Vaapi => format!("vaapih264enc bitrate={kbps} keyframe-period=60"),
            // `veryfast` keeps a 4K30 screen real time on a laptop CPU.
            Self::X264 => format!("x264enc bitrate={kbps} key-int-max=60 speed-preset=veryfast"),
            Self::OpenH264 => format!("openh264enc bitrate={bits_per_second} gop-size=60"),
        }
    }
}

/// An AAC encoder element, in the order the plan prefers them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AacEncoder {
    /// FFmpeg's AAC (gstreamer1.0-libav).
    Avenc,
    /// fdk-aac (Fedora's fdk-aac-free).
    Fdk,
    /// VisualOn AAC (plugins-bad).
    VoAac,
}

impl AacEncoder {
    pub const PREFERENCE: [Self; 3] = [Self::Avenc, Self::Fdk, Self::VoAac];

    #[must_use]
    pub const fn factory(self) -> &'static str {
        match self {
            Self::Avenc => "avenc_aac",
            Self::Fdk => "fdkaacenc",
            Self::VoAac => "voaacenc",
        }
    }

    /// The element at the one mixed track's 160 kbps (decision 6).
    #[must_use]
    pub fn element(self) -> String {
        format!("{} bitrate={AUDIO_BITS}", self.factory())
    }
}

/// The one stereo 48 kHz AAC track's bit rate, as on macOS.
pub const AUDIO_BITS: u32 = 160_000;

/// The encoders a recording uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Encoders {
    pub video: H264Encoder,
    pub audio: AacEncoder,
}

/// The first H.264 and the first AAC encoder `installed` reports, or `None`
/// when either is missing (`RecordingUnavailable::CodecsMissing`, whose line
/// names the packages per distro). `installed` is asked by factory name
/// (`gst::ElementFactory::find` in the recorder, a fixture here).
#[must_use]
pub fn choose_encoders(installed: impl Fn(&str) -> bool) -> Option<Encoders> {
    Some(Encoders {
        video: H264Encoder::PREFERENCE.into_iter().find(|e| installed(e.factory()))?,
        audio: AacEncoder::PREFERENCE.into_iter().find(|e| installed(e.factory()))?,
    })
}

/// Every installed H.264 encoder, in the plan's order, each with the first
/// installed AAC encoder: the writer tries them in turn, so a hardware
/// encoder that is installed but cannot start here (a VM without a GPU)
/// falls back to software. Empty = `codecsMissing`.
#[must_use]
pub fn candidates(installed: impl Fn(&str) -> bool) -> Vec<Encoders> {
    let Some(audio) = AacEncoder::PREFERENCE.into_iter().find(|e| installed(e.factory())) else {
        return Vec::new();
    };
    H264Encoder::PREFERENCE
        .into_iter()
        .filter(|e| installed(e.factory()))
        .map(|video| Encoders { video, audio })
        .collect()
}

/// Elements every recording needs besides the encoders: GStreamer's base
/// plugins (conversion, `appsrc` / `appsink`), the good plugins (`mp4mux`,
/// `aacparse`, `pulsesrc`) and the bad plugins (`h264parse`).
pub const NEEDED_ALWAYS: [&str; 10] = [
    "appsrc",
    "appsink",
    "videoconvert",
    "videoscale",
    "audioconvert",
    "audioresample",
    "mp4mux",
    "h264parse",
    "aacparse",
    "pulsesrc",
];

/// The picture's source on each session: `ximagesrc` (good plugins) on X11,
/// `pipewiresrc` (PipeWire's own plugin) on Wayland.
#[must_use]
pub const fn needed_for(wayland: bool) -> &'static str {
    if wayland { "pipewiresrc" } else { "ximagesrc" }
}

/// What `Hippius --capture-recorder --probe` prints on Linux: whether this
/// machine can record, and what is missing when it cannot. The app asks once
/// per launch and turns it into `recordingUnavailable` ([`Probe::unavailable`]).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    /// GStreamer started (its registry loaded).
    #[serde(default)]
    pub gstreamer: bool,
    #[serde(default)]
    pub h264_encoder: Option<String>,
    #[serde(default)]
    pub aac_encoder: Option<String>,
    /// Elements a recording needs that this machine does not have.
    #[serde(default)]
    pub missing: Vec<String>,
    /// `x11` or `wayland`.
    #[serde(default)]
    pub session: Option<String>,
    /// Wayland only: whether a ScreenCast portal answered (`None` on X11).
    #[serde(default)]
    pub screencast_portal: Option<bool>,
}

impl Probe {
    /// What `elements` (asked by factory name) gives on this session.
    #[must_use]
    pub fn from_registry(wayland: bool, installed: impl Fn(&str) -> bool) -> Self {
        let missing = NEEDED_ALWAYS
            .iter()
            .copied()
            .chain(std::iter::once(needed_for(wayland)))
            .filter(|name| !installed(name))
            .map(str::to_string)
            .collect();
        Self {
            gstreamer: true,
            h264_encoder: H264Encoder::PREFERENCE
                .into_iter()
                .find(|e| installed(e.factory()))
                .map(|e| e.factory().to_string()),
            aac_encoder: AacEncoder::PREFERENCE
                .into_iter()
                .find(|e| installed(e.factory()))
                .map(|e| e.factory().to_string()),
            missing,
            session: Some(if wayland { "wayland" } else { "x11" }.to_string()),
            screencast_portal: None,
        }
    }

    /// Why this machine cannot record, from what the probe found. A Wayland
    /// session with no ScreenCast portal is told about the portal first:
    /// nothing records the screen there without it. Any missing element
    /// (an encoder, a parser, the source) is `codecsMissing`, whose line
    /// names every package that brings one.
    #[must_use]
    pub fn unavailable(&self, wayland: bool) -> Option<RecordingUnavailable> {
        if wayland && self.screencast_portal == Some(false) {
            return Some(RecordingUnavailable::PortalMissing);
        }
        let encoders = self.h264_encoder.is_some() && self.aac_encoder.is_some();
        if !self.gstreamer || !encoders || !self.missing.is_empty() {
            return Some(RecordingUnavailable::CodecsMissing);
        }
        None
    }
}

/// Where the pictures come from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VideoSource {
    /// X11: a rectangle of the root window in pixels (a whole display or an
    /// area), with the pointer drawn in.
    X11Area { x: u32, y: u32, width: u32, height: u32 },
    /// X11: one window by XID; it follows the window and its size.
    X11Window { xid: u32 },
    /// Wayland: the ScreenCast portal's PipeWire remote (`fd`) and the
    /// stream's node id.
    Portal { fd: i32, node: u32 },
}

impl VideoSource {
    /// The source element. `ximagesrc`'s `endx` / `endy` are INCLUSIVE, so
    /// a 1920-wide area at x 0 ends at 1919; off by one films a column of
    /// the next display.
    #[must_use]
    pub fn element(&self) -> String {
        match *self {
            Self::X11Area { x, y, width, height } => format!(
                "ximagesrc use-damage=false show-pointer=true startx={x} starty={y} endx={} endy={}",
                x + width.max(1) - 1,
                y + height.max(1) - 1
            ),
            Self::X11Window { xid } => format!("ximagesrc use-damage=false show-pointer=true xid={xid:#x}"),
            Self::Portal { fd, node } => format!("pipewiresrc fd={fd} path={node} do-timestamp=true always-copy=true"),
        }
    }

    /// The picture's size in pixels when it is known before the first
    /// frame (an X11 rectangle); a window or a portal stream says with its
    /// first frame.
    #[must_use]
    pub const fn known_size(&self) -> Option<(u32, u32)> {
        match *self {
            Self::X11Area { width, height, .. } => Some((width, height)),
            Self::X11Window { .. } | Self::Portal { .. } => None,
        }
    }
}

/// A value for a gst-launch property: quoted, with `"` and `\` escaped, so
/// a path with spaces (every capture's name has them) stays one value.
#[must_use]
pub fn quoted(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        if c == '"' || c == '\\' {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('"');
    out
}

/// Frames per second, as on macOS.
pub const FPS: u32 = 30;
/// Fragment length in ms: what a killed recorder can lose at most.
pub const FRAGMENT_MS: u32 = 2000;
/// The named elements the recorder looks up.
pub const VIDEO_SINK: &str = "video";
pub const SIZE_FILTER: &str = "size";
pub const VIDEO_SRC: &str = "video";
pub const AUDIO_SRC: &str = "audio";
pub const AUDIO_SINK: &str = "audio";

/// The caps the picture leaves the capture pipeline with once the
/// recording's size is known: NV12, square pixels, letterboxed into the
/// size (`videoscale add-borders`) if the window changes shape.
#[must_use]
pub fn sized_caps(width: u32, height: u32) -> String {
    format!("video/x-raw,format=NV12,width={width},height={height},pixel-aspect-ratio=1/1")
}

/// The capture pipeline for the picture. Its `size` capsfilter starts at
/// the picture's own size (NV12 only) when it is not known yet: the recorder
/// reads the first frame's size, fixes the recording's ([`plan::output_size`])
/// and sets [`sized_caps`] on the filter. X11 is asked for 30 frames a
/// second; a portal stream sends a frame when the screen changes, and the
/// writer holds the last one ([`super::pacing`]).
#[must_use]
pub fn video_capture(source: &VideoSource) -> String {
    let rate = match source {
        VideoSource::X11Area { .. } | VideoSource::X11Window { .. } => format!("video/x-raw,framerate={FPS}/1 ! "),
        VideoSource::Portal { .. } => String::new(),
    };
    let caps = match source.known_size() {
        Some((w, h)) => {
            let (w, h) = plan::output_size(w, h);
            sized_caps(w, h)
        }
        None => "video/x-raw,format=NV12".to_string(),
    };
    format!(
        "{src} name=vsrc ! {rate}queue max-size-buffers=3 leaky=downstream ! videoconvert ! \
         videoscale add-borders=true ! capsfilter name={SIZE_FILTER} caps={caps} ! \
         appsink name={VIDEO_SINK} max-buffers=4 drop=true sync=false",
        src = source.element(),
        caps = quoted(&caps),
    )
}

/// What "Record system audio" records: the default output's monitor. Both
/// PulseAudio and `pipewire-pulse` resolve the name, so it follows the
/// output the user is listening on.
pub const DEFAULT_MONITOR: &str = "@DEFAULT_MONITOR@";

/// The capture pipeline for one sound source, `device` being a PulseAudio
/// source name (`None` = the default input). Interleaved stereo float at
/// 48 kHz, what the mixer takes; `pulsesrc` stamps its own buffers on the
/// pipeline's clock.
#[must_use]
pub fn audio_capture(device: Option<&str>) -> String {
    let device = device
        .filter(|d| !d.trim().is_empty())
        .map(|d| format!(" device={}", quoted(d)))
        .unwrap_or_default();
    format!(
        "pulsesrc{device} client-name=Hippius provide-clock=false ! queue max-size-time=1000000000 ! \
         audioconvert ! audioresample ! audio/x-raw,format=F32LE,rate=48000,channels=2,layout=interleaved ! \
         appsink name={AUDIO_SINK} sync=false max-buffers=200"
    )
}

/// The microphone meter's pipeline: one channel is enough for a level.
#[must_use]
pub fn meter_capture(device: Option<&str>) -> String {
    let device = device
        .filter(|d| !d.trim().is_empty())
        .map(|d| format!(" device={}", quoted(d)))
        .unwrap_or_default();
    format!(
        "pulsesrc{device} client-name=Hippius provide-clock=false ! audioconvert ! audioresample ! \
         audio/x-raw,format=F32LE,rate=48000,channels=1 ! appsink name={AUDIO_SINK} sync=false max-buffers=50 drop=true"
    )
}

/// What the file is written with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncodePlan {
    pub width: u32,
    pub height: u32,
    pub encoders: Encoders,
    /// Whether the file has its (one) audio track.
    pub audio: bool,
    pub output: String,
}

/// The writing pipeline: pictures (NV12 at the recording's size) and the
/// mixed sound (16-bit stereo 48 kHz) pushed by Rust with their times, into
/// fragmented MP4 every 2 s so a killed recorder leaves a playable file (the
/// Swift helper's rule). The queues in front of the muxer are unbounded:
/// the muxer takes the two tracks in step, and the encoder holds a few
/// pictures back, so a bounded queue there would stall the one thread that
/// feeds both.
#[must_use]
pub fn encode(plan: &EncodePlan) -> String {
    let unbounded = "queue max-size-buffers=0 max-size-bytes=0 max-size-time=0";
    let video_caps = format!(
        "video/x-raw,format=NV12,width={},height={},framerate={FPS}/1,pixel-aspect-ratio=1/1",
        plan.width, plan.height
    );
    let mut out = format!(
        "appsrc name={VIDEO_SRC} format=time is-live=false do-timestamp=false caps={caps} ! \
         queue ! videoconvert ! {venc} ! h264parse ! {unbounded} ! mux. ",
        caps = quoted(&video_caps),
        venc = plan.encoders.video.element(super::sizing::video_bit_rate(plan.width, plan.height)),
    );
    if plan.audio {
        let audio_caps = "audio/x-raw,format=S16LE,rate=48000,channels=2,layout=interleaved";
        let _ = write!(
            out,
            "appsrc name={AUDIO_SRC} format=time is-live=false do-timestamp=false caps={caps} ! \
             queue ! audioconvert ! {aenc} ! aacparse ! {unbounded} ! mux. ",
            caps = quoted(audio_caps),
            aenc = plan.encoders.audio.element(),
        );
    }
    let _ = write!(
        out,
        "mp4mux name=mux fragment-duration={FRAGMENT_MS} ! filesink location={}",
        quoted(&plan.output)
    );
    out
}

/// What an X11 recording reads, from the start command and the displays
/// RandR lists (physical root pixels, one scale for the screen).
///
/// # Errors
/// The display has gone, or the area has no size.
pub fn x11_source(cmd: &StartCommand, displays: &[DisplayTarget]) -> Result<VideoSource, String> {
    if let Some(xid) = cmd.window_id {
        return Ok(VideoSource::X11Window { xid });
    }
    let id = cmd.display_id.ok_or("missing display or window")?;
    let d = displays.iter().find(|d| d.id == id).ok_or("That display is no longer connected.")?;
    let origin_x = u32::try_from(d.x).unwrap_or(0);
    let origin_y = u32::try_from(d.y).unwrap_or(0);
    let rect = match cmd.crop {
        // The area is in the overlay's CSS pixels: the display's pixels
        // over the screen's one scale.
        Some(crop) => plan::area_pixels(crop, d.scale_factor, d.width, d.height).ok_or("Drag to select an area to record.")?,
        None => PixelRect {
            x0: 0,
            y0: 0,
            x1: d.width,
            y1: d.height,
        },
    };
    Ok(VideoSource::X11Area {
        x: origin_x + rect.x0,
        y: origin_y + rect.y0,
        width: rect.width(),
        height: rect.height(),
    })
}

/// What the ScreenCast portal is asked for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortalAsk {
    /// A window rather than a whole monitor.
    pub window: bool,
    /// Ask the portal for a token that restores this choice without its
    /// dialog. A monitor only: a window recording is a new choice each time,
    /// and a restored window session would record the old window unasked.
    pub persist: bool,
    /// The token from a previous recording, when the app decided it applies.
    pub restore_token: Option<String>,
}

/// The portal request for `cmd`: a window when the app chose window mode
/// (`windowId` set; its value means nothing on Wayland, where Hippius sees
/// no windows), a monitor otherwise.
#[must_use]
pub fn portal_ask(cmd: &StartCommand) -> PortalAsk {
    let window = cmd.window_id.is_some();
    PortalAsk {
        window,
        persist: !window,
        restore_token: if window {
            None
        } else {
            cmd.restore_token.clone().filter(|t| !t.trim().is_empty())
        },
    }
}

/// How the picture's pipeline ended without being asked to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VideoEnd {
    /// End of stream from the source.
    Eos,
    /// An error from the source or a converter; the detail is for the log.
    Error(String),
}

/// What the app is told (`stream_stopped`) when the picture stopped on its
/// own; the file is finished with what was recorded either way. On Wayland
/// the stream ends when the user stops sharing from the desktop's own
/// indicator (GNOME's top bar, KDE's tray); on X11 when the window closed
/// or the display went away.
#[must_use]
pub fn ended_reason(source: &VideoSource, end: &VideoEnd) -> String {
    match (source, end) {
        (VideoSource::Portal { .. }, _) => "Screen sharing was stopped from your desktop.".into(),
        (VideoSource::X11Window { .. }, _) => "The window being recorded was closed.".into(),
        (VideoSource::X11Area { .. }, VideoEnd::Eos) => "The screen stopped sending pictures.".into(),
        (VideoSource::X11Area { .. }, VideoEnd::Error(detail)) => format!("The screen could not be read any more: {detail}"),
    }
}

/// The monitor source of an output: what "record system audio" records.
#[must_use]
pub fn monitor_of(sink: &str) -> String {
    format!("{sink}.monitor")
}

/// An audio source as `GstDeviceMonitor` reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawAudioSource {
    /// `node.name` (PipeWire) or `device.name` (PulseAudio): what `pulsesrc
    /// device=` takes.
    pub id: String,
    pub display_name: String,
    /// `device.class` from the device's properties (`monitor` for a sink's
    /// monitor).
    pub device_class: Option<String>,
    pub is_default: bool,
}

/// The microphone menu: every input but the monitors (those are what
/// "Record system audio" records, not a microphone), each once, default
/// first.
#[must_use]
pub fn microphones(sources: Vec<RawAudioSource>) -> Vec<MediaDevice> {
    tidy_devices(
        sources
            .into_iter()
            .filter(|s| s.device_class.as_deref() != Some("monitor") && !s.id.ends_with(".monitor"))
            .map(|s| MediaDevice {
                id: s.id,
                name: s.display_name,
                is_default: s.is_default,
                continuity: false,
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::recording::protocol::CropRect;

    fn with(names: &[&str]) -> impl Fn(&str) -> bool {
        let names: Vec<String> = names.iter().map(|s| (*s).to_string()).collect();
        move |f| names.iter().any(|n| n == f)
    }

    /// The plan's order: hardware first, then x264, then OpenH264; avenc
    /// first for AAC. Each row is a distro's typical install.
    #[test]
    fn the_first_installed_encoder_wins_in_the_plans_order() {
        let ubuntu = choose_encoders(with(&["x264enc", "openh264enc", "avenc_aac", "voaacenc"])).unwrap();
        assert_eq!((ubuntu.video, ubuntu.audio), (H264Encoder::X264, AacEncoder::Avenc));
        let ubuntu_intel = choose_encoders(with(&["vah264enc", "vaapih264enc", "x264enc", "avenc_aac"])).unwrap();
        assert_eq!(ubuntu_intel.video, H264Encoder::Va);
        let old_vaapi = choose_encoders(with(&["vaapih264enc", "x264enc", "avenc_aac"])).unwrap();
        assert_eq!(old_vaapi.video, H264Encoder::Vaapi);
        let fedora = choose_encoders(with(&["openh264enc", "fdkaacenc"])).unwrap();
        assert_eq!((fedora.video, fedora.audio), (H264Encoder::OpenH264, AacEncoder::Fdk));
    }

    /// No H.264 or no AAC is `codecsMissing`: Record disabled with the
    /// packages to install, not a recording that fails at the end.
    #[test]
    fn a_missing_codec_means_no_recording() {
        assert_eq!(choose_encoders(with(&["avenc_aac"])), None, "no H.264");
        assert_eq!(choose_encoders(with(&["x264enc"])), None, "no AAC");
        assert_eq!(choose_encoders(with(&[])), None);
    }

    /// Hardware first, then software, all with the one AAC encoder; no AAC
    /// means nothing to try.
    #[test]
    fn the_writer_tries_every_installed_encoder_in_order() {
        let tried = candidates(with(&["openh264enc", "vah264enc", "x264enc", "fdkaacenc", "voaacenc"]));
        assert_eq!(
            tried.iter().map(|e| e.video).collect::<Vec<_>>(),
            [H264Encoder::Va, H264Encoder::X264, H264Encoder::OpenH264]
        );
        assert!(tried.iter().all(|e| e.audio == AacEncoder::Fdk));
        assert!(candidates(with(&["x264enc"])).is_empty());
        assert!(candidates(with(&["avenc_aac"])).is_empty());
    }

    #[test]
    fn bit_rates_are_in_each_encoders_own_units() {
        assert_eq!(
            H264Encoder::X264.element(14_000_000),
            "x264enc bitrate=14000 key-int-max=60 speed-preset=veryfast"
        );
        assert_eq!(H264Encoder::OpenH264.element(14_000_000), "openh264enc bitrate=14000000 gop-size=60");
        assert_eq!(H264Encoder::Va.element(2_000_500), "vah264enc bitrate=2001 key-int-max=60");
        assert_eq!(AacEncoder::Avenc.element(), "avenc_aac bitrate=160000");
    }

    /// A full Ubuntu desktop install with the recommended packages.
    const UBUNTU_FULL: &[&str] = &[
        "appsrc",
        "appsink",
        "videoconvert",
        "videoscale",
        "audioconvert",
        "audioresample",
        "mp4mux",
        "h264parse",
        "aacparse",
        "pulsesrc",
        "ximagesrc",
        "pipewiresrc",
        "x264enc",
        "avenc_aac",
    ];

    #[test]
    fn a_full_install_can_record_on_both_sessions() {
        for wayland in [false, true] {
            let mut probe = Probe::from_registry(wayland, with(UBUNTU_FULL));
            probe.screencast_portal = wayland.then_some(true);
            assert_eq!(probe.unavailable(wayland), None, "wayland={wayland}: {probe:?}");
            assert_eq!(probe.h264_encoder.as_deref(), Some("x264enc"));
            assert_eq!(probe.aac_encoder.as_deref(), Some("avenc_aac"));
            assert!(probe.missing.is_empty());
        }
    }

    /// A stock Ubuntu without plugins-ugly and libav: no H.264, no AAC.
    /// Record shows disabled with the packages to install, and the probe
    /// names what is missing for the log.
    #[test]
    fn a_stock_install_without_codecs_is_told_which_packages_to_add() {
        let stock: Vec<&str> = UBUNTU_FULL.iter().copied().filter(|e| !matches!(*e, "x264enc" | "avenc_aac")).collect();
        let probe = Probe::from_registry(false, with(&stock));
        assert_eq!(probe.unavailable(false), Some(RecordingUnavailable::CodecsMissing));
        assert_eq!(probe.h264_encoder, None);
        let line = RecordingUnavailable::CodecsMissing.message();
        for package in ["gstreamer1.0-plugins-ugly", "gstreamer1.0-libav", "gstreamer1-plugin-openh264"] {
            assert!(line.contains(package), "{line}");
        }
    }

    /// Encoders without a parser or the picture's source still cannot
    /// record: said up front, with the element in the log.
    #[test]
    fn a_missing_parser_or_source_is_codecs_missing_too() {
        let no_parse: Vec<&str> = UBUNTU_FULL.iter().copied().filter(|e| *e != "h264parse").collect();
        let probe = Probe::from_registry(false, with(&no_parse));
        assert_eq!(probe.missing, ["h264parse"]);
        assert_eq!(probe.unavailable(false), Some(RecordingUnavailable::CodecsMissing));

        let no_pipewire: Vec<&str> = UBUNTU_FULL.iter().copied().filter(|e| *e != "pipewiresrc").collect();
        assert!(
            Probe::from_registry(false, with(&no_pipewire)).unavailable(false).is_none(),
            "X11 needs no PipeWire"
        );
        let mut wayland = Probe::from_registry(true, with(&no_pipewire));
        wayland.screencast_portal = Some(true);
        assert_eq!(wayland.missing, ["pipewiresrc"]);
        assert_eq!(wayland.unavailable(true), Some(RecordingUnavailable::CodecsMissing));
    }

    /// Wayland with no ScreenCast portal is told about the portal first:
    /// nothing records the screen there without it.
    #[test]
    fn wayland_without_a_portal_is_portal_missing() {
        let mut probe = Probe::from_registry(true, with(&[]));
        probe.screencast_portal = Some(false);
        assert_eq!(probe.unavailable(true), Some(RecordingUnavailable::PortalMissing));
        // X11 never asks the portal.
        assert_eq!(probe.unavailable(false), Some(RecordingUnavailable::CodecsMissing));
    }

    /// A probe that could not run (the child crashed, or printed nothing)
    /// reads as the default: codecs missing, never "works".
    #[test]
    fn a_probe_that_said_nothing_cannot_record() {
        assert_eq!(Probe::default().unavailable(false), Some(RecordingUnavailable::CodecsMissing));
        let wire = r#"{"gstreamer":true,"h264Encoder":"x264enc","aacEncoder":"avenc_aac","missing":[],"session":"x11"}"#;
        let probe: Probe = serde_json::from_str(wire).unwrap();
        assert_eq!(probe.unavailable(false), None);
        assert_eq!(serde_json::from_str::<Probe>(&serde_json::to_string(&probe).unwrap()).unwrap(), probe);
    }

    /// `ximagesrc` corners are inclusive: a whole 1920 x 1080 display right
    /// of another ends at 3839, not 3840 (which is the next display).
    #[test]
    fn an_x11_area_is_given_by_its_inclusive_corners() {
        let right = VideoSource::X11Area {
            x: 1920,
            y: 0,
            width: 1920,
            height: 1080,
        };
        assert!(right.element().ends_with("startx=1920 starty=0 endx=3839 endy=1079"));
        assert!(VideoSource::X11Window { xid: 0x0340_0007 }.element().ends_with("xid=0x3400007"));
        assert!(
            VideoSource::Portal { fd: 42, node: 57 }
                .element()
                .starts_with("pipewiresrc fd=42 path=57")
        );
    }

    #[test]
    fn a_path_with_spaces_and_quotes_stays_one_value() {
        assert_eq!(
            quoted("/home/me/Recording 2026-10-01 at 10.00.00.mp4"),
            "\"/home/me/Recording 2026-10-01 at 10.00.00.mp4\""
        );
        assert_eq!(quoted(r#"a"b\c"#), r#""a\"b\\c""#);
    }

    /// An X11 rectangle knows its size up front: a 5K screen is filmed
    /// capped to a 3840 long edge, 30 times a second, ending in the appsink
    /// the recorder reads.
    #[test]
    fn an_x11_capture_is_sized_and_paced_from_the_start() {
        let text = video_capture(&VideoSource::X11Area {
            x: 0,
            y: 0,
            width: 5120,
            height: 2880,
        });
        assert!(text.starts_with("ximagesrc "), "{text}");
        assert!(text.contains("! video/x-raw,framerate=30/1 !"), "{text}");
        assert!(
            text.contains("capsfilter name=size caps=\"video/x-raw,format=NV12,width=3840,height=2160,pixel-aspect-ratio=1/1\""),
            "{text}"
        );
        assert!(
            text.contains("videoscale add-borders=true"),
            "a resized window is letterboxed, never stretched"
        );
        assert!(text.ends_with("appsink name=video max-buffers=4 drop=true sync=false"));
    }

    /// A window or a portal stream says its size with its first frame: the
    /// filter starts open (NV12 only) and the portal is not forced to 30 fps.
    #[test]
    fn a_window_or_portal_capture_learns_its_size_from_the_first_frame() {
        let portal = video_capture(&VideoSource::Portal { fd: 9, node: 70 });
        assert!(portal.contains("caps=\"video/x-raw,format=NV12\""), "{portal}");
        assert!(!portal.contains("framerate"), "{portal}");
        let window = video_capture(&VideoSource::X11Window { xid: 7 });
        assert!(window.contains("caps=\"video/x-raw,format=NV12\""), "{window}");
        assert!(window.contains("framerate=30/1"));
        assert_eq!(
            sized_caps(1280, 720),
            "video/x-raw,format=NV12,width=1280,height=720,pixel-aspect-ratio=1/1"
        );
    }

    /// Each sound source is its own pipeline, delivering what the mixer
    /// takes; system audio is the default output's monitor.
    #[test]
    fn sound_is_captured_as_stereo_float_at_48_khz() {
        let mic = audio_capture(Some("alsa_input.usb-Blue_Yeti"));
        assert!(mic.starts_with("pulsesrc device=\"alsa_input.usb-Blue_Yeti\" "), "{mic}");
        assert!(mic.contains("audio/x-raw,format=F32LE,rate=48000,channels=2,layout=interleaved"));
        assert!(mic.ends_with("appsink name=audio sync=false max-buffers=200"));
        assert!(audio_capture(None).starts_with("pulsesrc client-name=Hippius"), "default input");
        assert!(audio_capture(Some("  ")).starts_with("pulsesrc client-name=Hippius"));
        assert!(audio_capture(Some(DEFAULT_MONITOR)).contains("device=\"@DEFAULT_MONITOR@\""));
        let meter = meter_capture(Some("a b"));
        assert!(meter.contains("device=\"a b\"") && meter.contains("channels=1"), "{meter}");
    }

    fn encode_plan(audio: bool) -> EncodePlan {
        EncodePlan {
            width: 3840,
            height: 2160,
            encoders: Encoders {
                video: H264Encoder::X264,
                audio: AacEncoder::Avenc,
            },
            audio,
            output: "/home/me/.hippius/capture-tmp/capture-x/Recording 1.mp4".into(),
        }
    }

    /// The file: H.264 at the shared bit rate for its size, one AAC track
    /// at 160 kbps when there is sound, 2 s fragments, the path quoted.
    #[test]
    fn the_writer_encodes_one_video_and_one_audio_track_in_fragments() {
        let text = encode(&encode_plan(true));
        let kbps = super::super::sizing::video_bit_rate(3840, 2160).div_ceil(1000);
        assert!(text.contains(&format!("x264enc bitrate={kbps} ")), "{text}");
        assert!(
            text.contains("caps=\"video/x-raw,format=NV12,width=3840,height=2160,framerate=30/1"),
            "{text}"
        );
        assert_eq!(text.matches("avenc_aac bitrate=160000").count(), 1, "one audio track");
        assert!(text.contains("caps=\"audio/x-raw,format=S16LE,rate=48000,channels=2,layout=interleaved\""));
        assert_eq!(text.matches("! mux. ").count(), 2);
        assert!(text.contains("mp4mux name=mux fragment-duration=2000"));
        assert!(text.ends_with("filesink location=\"/home/me/.hippius/capture-tmp/capture-x/Recording 1.mp4\""));
        // Nothing ahead of the muxer may block the thread that feeds both.
        assert_eq!(
            text.matches("queue max-size-buffers=0 max-size-bytes=0 max-size-time=0 ! mux.").count(),
            2
        );
    }

    #[test]
    fn no_sound_means_no_audio_track() {
        let text = encode(&encode_plan(false));
        assert!(!text.contains("avenc_aac") && !text.contains("name=audio"), "{text}");
        assert_eq!(text.matches("! mux. ").count(), 1);
    }

    fn display(id: u32, x: i32, width: u32, height: u32, scale: f64) -> DisplayTarget {
        DisplayTarget {
            id,
            name: format!("DP-{id}"),
            x,
            y: 0,
            width,
            height,
            scale_factor: scale,
            is_primary: id == 1,
        }
    }

    fn start(json: &str) -> StartCommand {
        serde_json::from_str(json).unwrap()
    }

    /// A screen is its display's whole rectangle on the root; an area is
    /// the overlay's CSS pixels times the screen's scale, on even pixels,
    /// moved to its display.
    #[test]
    fn x11_screens_and_areas_are_root_rectangles() {
        let displays = [display(1, 0, 2560, 1600, 2.0), display(2, 2560, 1920, 1080, 2.0)];
        let screen = x11_source(&start(r#"{"id":1,"output":"/x.mp4","displayId":2}"#), &displays).unwrap();
        assert_eq!(
            screen,
            VideoSource::X11Area {
                x: 2560,
                y: 0,
                width: 1920,
                height: 1080
            }
        );
        let mut cmd = start(r#"{"id":1,"output":"/x.mp4","displayId":2}"#);
        cmd.crop = Some(CropRect {
            x: 10.0,
            y: 20.0,
            width: 300.5,
            height: 200.0,
        });
        let VideoSource::X11Area { x, y, width, height } = x11_source(&cmd, &displays).unwrap() else {
            panic!("an area");
        };
        assert_eq!((x, y), (2580, 40));
        assert_eq!((width % 2, height % 2), (0, 0));
        assert!((600..=604).contains(&width) && height == 400, "{width}x{height}");
    }

    #[test]
    fn an_x11_window_is_recorded_by_its_xid_and_a_gone_display_is_refused() {
        let displays = [display(1, 0, 1920, 1080, 1.0)];
        let window = x11_source(&start(r#"{"id":1,"output":"/x.mp4","windowId":62914567}"#), &displays).unwrap();
        assert_eq!(window, VideoSource::X11Window { xid: 62_914_567 });
        assert!(x11_source(&start(r#"{"id":1,"output":"/x.mp4","displayId":9}"#), &displays).is_err());
        assert!(x11_source(&start(r#"{"id":1,"output":"/x.mp4"}"#), &displays).is_err());
    }

    /// A monitor may be restored without the portal's dialog; a window is
    /// always chosen afresh, and never with an old token.
    #[test]
    fn only_a_monitor_is_remembered_by_the_portal() {
        let mut screen = start(r#"{"id":1,"output":"/x.mp4","displayId":0,"restoreToken":"abc"}"#);
        assert_eq!(
            portal_ask(&screen),
            PortalAsk {
                window: false,
                persist: true,
                restore_token: Some("abc".into())
            }
        );
        screen.restore_token = Some("  ".into());
        assert_eq!(portal_ask(&screen).restore_token, None, "a blank token is no token");
        let window = start(r#"{"id":1,"output":"/x.mp4","windowId":0,"restoreToken":"abc"}"#);
        assert_eq!(
            portal_ask(&window),
            PortalAsk {
                window: true,
                persist: false,
                restore_token: None
            }
        );
    }

    /// The app is told why, in plain words; the desktop's "stop sharing"
    /// is a normal way to end a Wayland recording.
    #[test]
    fn a_stream_that_ended_says_why() {
        let portal = VideoSource::Portal { fd: 3, node: 4 };
        assert_eq!(ended_reason(&portal, &VideoEnd::Eos), "Screen sharing was stopped from your desktop.");
        assert_eq!(
            ended_reason(&VideoSource::X11Window { xid: 5 }, &VideoEnd::Error("BadWindow".into())),
            "The window being recorded was closed."
        );
        let area = VideoSource::X11Area {
            x: 0,
            y: 0,
            width: 2,
            height: 2,
        };
        assert!(ended_reason(&area, &VideoEnd::Error("X error".into())).ends_with("X error"));
        for reason in [
            ended_reason(&portal, &VideoEnd::Eos),
            ended_reason(&area, &VideoEnd::Eos),
            RecordingUnavailable::CodecsMissing.message().to_string(),
        ] {
            assert!(!reason.contains('\u{2014}'), "no em dashes: {reason}");
        }
    }

    fn source(id: &str, name: &str, class: Option<&str>, is_default: bool) -> RawAudioSource {
        RawAudioSource {
            id: id.into(),
            display_name: name.into(),
            device_class: class.map(str::to_string),
            is_default,
        }
    }

    /// Monitor sources are system audio, never a microphone; the default
    /// input is listed first.
    #[test]
    fn the_microphone_list_drops_monitors_and_puts_the_default_first() {
        let mics = microphones(vec![
            source(
                "alsa_output.pci.analog-stereo.monitor",
                "Monitor of Built-in Audio",
                Some("monitor"),
                false,
            ),
            source("alsa_input.pci.analog-stereo", "Built-in Audio Analog Stereo", Some("sound"), false),
            source("bluez_input.AA_BB", "Headset", Some("sound"), true),
            source("easyeffects_sink.monitor", "Monitor of Easy Effects Sink", None, false),
            source("alsa_input.pci.analog-stereo", "Built-in Audio Analog Stereo", Some("sound"), false),
        ]);
        assert_eq!(
            mics.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            ["bluez_input.AA_BB", "alsa_input.pci.analog-stereo"]
        );
        assert!(mics[0].is_default);
        assert_eq!(monitor_of("alsa_output.x"), "alsa_output.x.monitor");
    }
}
