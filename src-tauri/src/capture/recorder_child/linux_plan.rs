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
//! - **Camera only on Wayland** ([`pick_camera`], [`camera_capture_tail`]):
//!   no window to film there, so the recorder opens the camera the bubble
//!   showed, found among GStreamer's devices by the id the bar listed or by
//!   its name (WebKitGTK lists cameras through GStreamer too, so the names
//!   are the same), mirrored as the stage shows it.
//! - **A Wayland area** ([`video_capture_bgrx`] on the portal's stream): the
//!   monitor is read whole and cropped in Rust to the area drawn on its
//!   first picture, in the stream's own pixels.
//!
//! See `docs/plans/2026-10-01-capture-windows-linux.md`, decision 3 and
//! Phase 4.

use std::fmt::Write as _;

use serde::{Deserialize, Serialize};

use super::plan::{self, PixelRect};
use super::sizing::{PEAK_TO_AVERAGE, RateControl};
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

    /// The element with the shared rate control: the Swift helper's average,
    /// a ceiling of [`PEAK_TO_AVERAGE`] times it, and its keyframe interval.
    /// Each encoder is put in a mode that spends less on a still screen:
    /// none of them is left in constant bit rate, which pads a still screen
    /// up to the average (x264's and VA's default), and the old VA-API
    /// plugin's default (constant QP) ignored the bit rate altogether.
    ///
    /// - VA (`va` plugin): VBR; `bitrate` is the average and the ceiling is
    ///   `bitrate * 100 / target-percentage`.
    /// - VA-API (`vaapi` plugin): VBR; there `bitrate` is the ceiling and
    ///   the average is `target-percentage` of it.
    /// - x264: constant quality ([`X264_CRF`]) with the ceiling as its VBV
    ///   rate over a one-second buffer, so a still screen costs almost
    ///   nothing and a busy one stops at the ceiling. `veryfast` keeps a
    ///   4K30 screen real time on a laptop CPU.
    /// - OpenH264: its default quality-first rate control with the average
    ///   as target and the ceiling as its maximum.
    ///
    /// Units differ: x264 and the VA encoders take kbit/s, OpenH264 bit/s.
    #[must_use]
    pub fn element(self, rate: RateControl) -> String {
        let (average, peak, keyframes) = (rate.average_kbps(), rate.peak_kbps(), rate.keyframe_frames);
        let target_percentage = 100 / PEAK_TO_AVERAGE;
        match self {
            Self::Va => format!("vah264enc rate-control=vbr bitrate={average} target-percentage={target_percentage} key-int-max={keyframes}"),
            Self::Vaapi => format!("vaapih264enc rate-control=vbr bitrate={peak} target-percentage={target_percentage} keyframe-period={keyframes}"),
            Self::X264 => {
                format!("x264enc pass=qual quantizer={X264_CRF} bitrate={peak} vbv-buf-capacity=1000 key-int-max={keyframes} speed-preset=veryfast")
            }
            Self::OpenH264 => format!("openh264enc bitrate={} max-bitrate={} gop-size={keyframes}", rate.average, rate.peak),
        }
    }
}

/// x264's constant-quality level: x264's own default CRF and OBS's "High
/// Quality, Medium File Size" recording preset. Lower is sharper and bigger.
pub const X264_CRF: u32 = 23;

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
pub const NEEDED_ALWAYS: [&str; 11] = [
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
    "videocrop",
];

/// What camera only on Wayland needs besides a recording's elements:
/// `decodebin` (a camera that sends JPEG) and `videoflip` (the mirror the
/// stage shows), plus one of [`CAMERA_SOURCES`].
pub const NEEDED_FOR_CAMERA: [&str; 2] = ["decodebin", "videoflip"];
/// The camera sources GStreamer's device monitor hands out elements of.
pub const CAMERA_SOURCES: [&str; 2] = ["v4l2src", "pipewiresrc"];
/// Decodes a camera's JPEG; without it only raw formats are asked for.
pub const JPEG_DECODER: &str = "jpegdec";

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
    /// Whether the recorder can open a camera itself (camera only on
    /// Wayland): a camera source and [`NEEDED_FOR_CAMERA`] are installed.
    /// `None` from an older probe.
    #[serde(default)]
    pub camera: Option<bool>,
    /// The highest-ranked H.264 decoder GStreamer would pick (what
    /// WebKitGTK plays a video with; `video_stream::decoder_missing_line`).
    /// Found by caps, not by name, as WebKit's own registry scan does.
    #[serde(default)]
    pub h264_decoder: Option<String>,
    /// The same for AAC, the sound of every Hippius recording.
    #[serde(default)]
    pub aac_decoder: Option<String>,
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
            camera: Some(NEEDED_FOR_CAMERA.iter().all(|e| installed(e)) && CAMERA_SOURCES.iter().any(|e| installed(e))),
            // Decoders are found by caps in the child (`linux::probe`).
            h264_decoder: None,
            aac_decoder: None,
        }
    }

    /// Whether camera only can be recorded without a window to film: the
    /// machine records at all, and the probe found a camera source and
    /// what camera pictures need.
    #[must_use]
    pub fn records_camera(&self, wayland: bool) -> bool {
        self.camera == Some(true) && self.unavailable(wayland).is_none()
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

/// Which family of distribution this is, for naming its packages.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Distro {
    /// Debian, Ubuntu, Mint, Pop!_OS...: `gstreamer1.0-*`.
    Debian,
    /// Fedora, RHEL, CentOS, Nobara...: `gstreamer1-*`.
    Fedora,
    /// Anything else: both families' names are given.
    Other,
}

/// The family from `/etc/os-release` (`ID` and `ID_LIKE`).
#[must_use]
pub fn distro_family(os_release: &str) -> Distro {
    let mut ids: Vec<String> = Vec::new();
    for line in os_release.lines() {
        let Some((key, value)) = line.split_once('=') else { continue };
        if matches!(key.trim(), "ID" | "ID_LIKE") {
            let value = value.trim().trim_matches(['"', '\'']);
            ids.extend(value.split_whitespace().map(str::to_ascii_lowercase));
        }
    }
    if ids.iter().any(|id| matches!(id.as_str(), "debian" | "ubuntu")) {
        Distro::Debian
    } else if ids.iter().any(|id| matches!(id.as_str(), "fedora" | "rhel" | "centos")) {
        Distro::Fedora
    } else {
        Distro::Other
    }
}

/// The package that brings `element` (Debian's name, Fedora's name), or
/// `None` for an element no recording needs.
fn package_of(element: &str) -> Option<(&'static str, &'static str)> {
    match element {
        "appsrc" | "appsink" | "videoconvert" | "videoscale" | "audioconvert" | "audioresample" => {
            Some(("gstreamer1.0-plugins-base", "gstreamer1-plugins-base"))
        }
        "mp4mux" | "pulsesrc" | "videocrop" | "ximagesrc" | "aacparse" => Some(("gstreamer1.0-plugins-good", "gstreamer1-plugins-good")),
        "h264parse" => Some(("gstreamer1.0-plugins-bad", "gstreamer1-plugins-bad-free")),
        "pipewiresrc" => Some(("gstreamer1.0-pipewire", "pipewire-gstreamer")),
        _ => None,
    }
}

/// What a missing H.264 or AAC encoder is installed with: x264 and libav
/// on Debian's family, OpenH264 (Cisco's build) and libav on Fedora's.
const H264_PACKAGES: (&str, &str) = ("gstreamer1.0-plugins-ugly", "gstreamer1-plugin-openh264");
const AAC_PACKAGES: (&str, &str) = ("gstreamer1.0-libav", "gstreamer1-plugin-libav");

/// Exactly the packages this machine lacks, in the order to say them, for
/// `distro`'s family; `None` when the probe says too little to know
/// (GStreamer itself did not start), so the full line is said instead.
#[must_use]
pub fn missing_packages(probe: &Probe, distro: Distro) -> Option<Vec<&'static str>> {
    if !probe.gstreamer || distro == Distro::Other {
        return None;
    }
    let pick = |(debian, fedora): (&'static str, &'static str)| if distro == Distro::Fedora { fedora } else { debian };
    let mut packages: Vec<&'static str> = Vec::new();
    let mut add = |p: &'static str| {
        if !packages.contains(&p) {
            packages.push(p);
        }
    };
    for element in &probe.missing {
        if let Some(pair) = package_of(element) {
            add(pick(pair));
        }
    }
    if probe.h264_encoder.is_none() {
        add(pick(H264_PACKAGES));
    }
    if probe.aac_encoder.is_none() {
        add(pick(AAC_PACKAGES));
    }
    Some(packages)
}

/// The codec line naming only `packages`: "Install a, b and c, then
/// restart Hippius."
#[must_use]
pub fn codecs_missing_line(packages: &[&str]) -> Option<String> {
    let list = match packages {
        [] => return None,
        [one] => (*one).to_string(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    };
    Some(format!(
        "Screen recording needs video codecs your system doesn't have. Install {list}, then restart Hippius."
    ))
}

/// Where the pictures come from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VideoSource {
    /// X11: a rectangle of the root window in pixels (a whole display or an
    /// area), with the pointer drawn in.
    X11Area { x: u32, y: u32, width: u32, height: u32 },
    /// X11: one window by XID; it follows the window and its size.
    /// `inset` pixels are cut from every edge: Hippius's own camera stage,
    /// whose transparent margin and rounded corners would film as black.
    X11Window { xid: u32, inset: u32 },
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
            Self::X11Window { xid, .. } => format!("ximagesrc use-damage=false show-pointer=true xid={xid:#x}"),
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
/// Fragment length in ms: about what a killed recorder can lose (a fragment
/// may wait for the next keyframe, at most `sizing::KEYFRAME_SECONDS` away).
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
    // The camera stage, trimmed of its margin before anything is sized.
    let crop = match *source {
        VideoSource::X11Window { inset, .. } if inset > 0 => {
            format!("videocrop top={inset} bottom={inset} left={inset} right={inset} ! ")
        }
        _ => String::new(),
    };
    let caps = match source.known_size() {
        Some((w, h)) => {
            let (w, h) = plan::output_size(w, h);
            sized_caps(w, h)
        }
        None => "video/x-raw,format=NV12".to_string(),
    };
    format!(
        "{src} name=vsrc ! {rate}queue max-size-buffers=3 leaky=downstream ! {crop}videoconvert ! \
         videoscale add-borders=true ! capsfilter name={SIZE_FILTER} caps={caps} ! \
         appsink name={VIDEO_SINK} max-buffers=4 drop=true sync=false",
        src = source.element(),
        caps = quoted(&caps),
    )
}

/// The capture pipeline whose pictures Rust finishes itself: the source's
/// own pictures at their own size, as BGRx, fitted into the recording's
/// size by the recorder (`frame::to_nv12`), the way Windows does. Two
/// users: an X11 window that gets the camera bubble drawn in (no crop: the
/// stage is never recorded with a bubble), and a Wayland area, cut out of
/// the monitor's stream in Rust (the area is known only after the first
/// picture, so the pipeline never has to renegotiate). X11 is asked for
/// 30 frames a second; a portal stream sends one when the screen changes.
#[must_use]
pub fn video_capture_bgrx(source: &VideoSource) -> String {
    let rate = match source {
        VideoSource::X11Area { .. } | VideoSource::X11Window { .. } => format!("video/x-raw,framerate={FPS}/1 ! "),
        VideoSource::Portal { .. } => String::new(),
    };
    format!(
        "{src} name=vsrc ! {rate}queue max-size-buffers=3 leaky=downstream ! videoconvert ! \
         capsfilter caps={caps} ! appsink name={VIDEO_SINK} max-buffers=4 drop=true sync=false",
        src = source.element(),
        caps = quoted("video/x-raw,format=BGRx"),
    )
}

/// The named element a camera's source is linked into
/// ([`camera_capture_tail`]): the source is an element GStreamer's device
/// monitor makes, so it is added by the recorder, not written as text.
pub const CAMERA_IN: &str = "camin";

/// What follows a camera's source: a bounded caps choice first
/// (`constrained`: at most 1080p, 15 to 60 frames a second, as raw video
/// or, with a JPEG decoder, `image/jpeg`; a camera's first offer is often
/// its largest picture at a few frames a second), decoded, mirrored as the
/// stage shows it, then the open `size` filter the recording's size is set
/// on from the first picture, as for every other source. Unconstrained is
/// the fallback for a camera that offers nothing in that range.
#[must_use]
pub fn camera_capture_tail(constrained: bool, jpeg: bool) -> String {
    let choice = if constrained {
        let raw = "video/x-raw,width=[1,1920],height=[1,1080],framerate=[15/1,60/1]";
        let caps = if jpeg {
            format!("{raw};image/jpeg,width=[1,1920],height=[1,1080],framerate=[15/1,60/1]")
        } else {
            raw.to_string()
        };
        format!("capsfilter caps={} ! ", quoted(&caps))
    } else {
        String::new()
    };
    format!(
        "queue name={CAMERA_IN} max-size-buffers=3 leaky=downstream ! {choice}decodebin ! videoconvert ! \
         videoflip method=horizontal-flip ! videoscale add-borders=true ! capsfilter name={SIZE_FILTER} caps={caps} ! \
         appsink name={VIDEO_SINK} max-buffers=4 drop=true sync=false",
        caps = quoted("video/x-raw,format=NV12"),
    )
}

/// How a camera's name is compared: the bar may hold the name WebKitGTK
/// gave (the same GStreamer name, but a phone's may carry a curly
/// apostrophe one way and a straight one the other), so NFC, straight
/// quotes, single spaces and no case.
#[must_use]
pub fn camera_name_key(name: &str) -> String {
    use unicode_normalization::UnicodeNormalization as _;
    let straight: String = name
        .nfc()
        .map(|c| match c {
            '\u{2018}' | '\u{2019}' | '\u{201B}' | '\u{2032}' => '\'',
            '\u{201C}' | '\u{201D}' | '\u{2033}' => '"',
            c => c,
        })
        .collect();
    straight.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// Which of the cameras GStreamer found to open for `pick`: the one with
/// the bar's id (PipeWire's `node.name` or the V4L2 path), else the one
/// with its name, else the first (the default, as the bubble opens it when
/// nothing is chosen). The flag says whether what was asked for is what
/// is opened; `None` when there is no camera at all.
#[must_use]
pub fn pick_camera(found: &[RawCamera], pick: &crate::capture::recording::protocol::CameraPick) -> Option<(usize, bool)> {
    if found.is_empty() {
        return None;
    }
    let wanted_id = pick.id.as_deref().map(str::trim).filter(|id| !id.is_empty() && *id != "default");
    if let Some(id) = wanted_id
        && let Some(i) = found.iter().position(|c| c.id.as_deref() == Some(id))
    {
        return Some((i, true));
    }
    let wanted_name = pick.name.as_deref().map(camera_name_key).filter(|n| !n.is_empty());
    if let Some(name) = &wanted_name
        && let Some(i) = found.iter().position(|c| camera_name_key(&c.display_name) == *name)
    {
        return Some((i, true));
    }
    Some((0, wanted_id.is_none() && wanted_name.is_none()))
}

/// What the app is told when the camera stopped mid-recording.
pub const CAMERA_ENDED: &str = "The camera stopped sending pictures.";

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

/// What the encoder is given: 8-bit 4:2:0 only (NV12, or I420 for
/// OpenH264, which takes nothing else). Left to choose, x264 takes the
/// first format it can, and from RGB that is 4:4:4, which it writes as
/// H.264 "High 4:4:4 Predictive": a profile browsers' hardware decoders and
/// some browsers refuse. The pictures arrive as NV12 today; this keeps a
/// change upstream from ever producing such a file.
pub const ENCODER_INPUT: &str = "video/x-raw,format={ NV12, I420 }";

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
         queue ! videoconvert ! capsfilter caps={planar} ! {venc} ! h264parse ! {unbounded} ! mux. ",
        caps = quoted(&video_caps),
        planar = quoted(ENCODER_INPUT),
        venc = plan.encoders.video.element(RateControl::for_size(plan.width, plan.height)),
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

/// The finished recording rewritten as one ordinary MP4 with its index
/// (`moov`) first, the layout the macOS helper writes
/// (`shouldOptimizeForNetworkUse`). Nothing is re-encoded: `qtdemux` reads
/// the fragments back and `mp4mux faststart=true` writes the samples once,
/// its index ahead of them (the samples wait in `temp`, next to the file,
/// not in a `/tmp` that may be memory).
///
/// Why: the fragments are only there so a killed recorder leaves a file
/// that plays. Kept in the finished file they cost two ways. GStreamer 1.20
/// (Ubuntu 22.04) writes one `trun` per picture, all but the first without
/// a data offset, which Chrome's demuxer reads from the wrong place: the
/// file fails to decode in Chrome ("PIPELINE_ERROR_DECODE") and a share
/// link shows "can't be played". And with any GStreamer, Chrome walks every
/// fragment of a fragmented file before it plays, jumping back each time,
/// which on a share link (the server ignores Range) restarts the download.
/// A file with its index first is read once, front to back, everywhere.
#[must_use]
pub fn faststart(input: &str, output: &str, temp: &str, audio: bool) -> String {
    let mut out = format!(
        "filesrc location={input} ! qtdemux name=demux \
         mp4mux name=remux faststart=true faststart-file={temp} ! filesink location={output} \
         demux.video_0 ! queue ! remux.video_0",
        input = quoted(input),
        output = quoted(output),
        temp = quoted(temp),
    );
    if audio {
        out.push_str(" demux.audio_0 ! queue ! remux.audio_0");
    }
    out
}

/// Where [`faststart`] writes: the rewritten file, then its samples while
/// the index is built, both next to the recording (`<name>.remux`,
/// `<name>.samples`). The recording itself is replaced only once the
/// rewrite is whole.
#[must_use]
pub fn remux_paths(output: &std::path::Path) -> (std::path::PathBuf, std::path::PathBuf) {
    let with = |suffix: &str| {
        let mut name = output.as_os_str().to_os_string();
        name.push(suffix);
        std::path::PathBuf::from(name)
    };
    (with(".remux"), with(".samples"))
}

/// The four-letter types of an MP4's top-level boxes, in file order, read
/// from the box headers alone (a few bytes per box, whatever the size).
///
/// # Errors
/// The file could not be read or ends inside a box header.
pub fn top_level_boxes<R: std::io::Read + std::io::Seek>(file: &mut R) -> std::io::Result<Vec<[u8; 4]>> {
    use std::io::SeekFrom;
    let len = file.seek(SeekFrom::End(0))?;
    let mut at = 0u64;
    let mut boxes = Vec::new();
    while at + 8 <= len {
        file.seek(SeekFrom::Start(at))?;
        let mut header = [0u8; 8];
        file.read_exact(&mut header)?;
        let size32 = u32::from_be_bytes([header[0], header[1], header[2], header[3]]);
        let kind = [header[4], header[5], header[6], header[7]];
        let size = match size32 {
            0 => len - at,
            1 => {
                let mut large = [0u8; 8];
                file.read_exact(&mut large)?;
                u64::from_be_bytes(large)
            }
            n => u64::from(n),
        };
        if size < 8 {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "a box shorter than its header"));
        }
        boxes.push(kind);
        at = at.saturating_add(size);
    }
    Ok(boxes)
}

/// Whether top-level `boxes` make one ordinary movie with its index first:
/// a `moov` ahead of the first `mdat`, and no fragments (`moof`).
#[must_use]
pub fn index_first(boxes: &[[u8; 4]]) -> bool {
    let moov = boxes.iter().position(|b| b == b"moov");
    let mdat = boxes.iter().position(|b| b == b"mdat");
    let fragmented = boxes.iter().any(|b| b == b"moof");
    matches!((moov, mdat), (Some(i), Some(j)) if i < j) && !fragmented
}

/// What an X11 recording reads, from the start command and the displays
/// RandR lists (physical root pixels, one scale for the screen).
/// `stage_inset` is what to cut from a window's edges ([`stage_inset`]).
///
/// # Errors
/// The display has gone, or the area has no size.
pub fn x11_source(cmd: &StartCommand, displays: &[DisplayTarget], stage_inset: u32) -> Result<VideoSource, String> {
    if let Some(xid) = cmd.window_id {
        return Ok(VideoSource::X11Window { xid, inset: stage_inset });
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

/// Pixels to cut from each edge of a recorded window: the camera stage's
/// margin (`plan::STAGE_INSET` at the screen's one scale) when the window
/// belongs to the app that started this recorder (`window_pid` is the
/// parent's), nothing for any other window.
#[must_use]
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
pub fn stage_inset(window_pid: Option<u32>, parent_pid: u32, scale: f64) -> u32 {
    if window_pid != Some(parent_pid) {
        return 0;
    }
    let scale = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    (plan::STAGE_INSET * scale).round() as u32
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

/// A camera as `GstDeviceMonitor` reports it (`Video/Source`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawCamera {
    /// PipeWire's `node.name`, else the V4L2 device path.
    pub id: Option<String>,
    pub display_name: String,
}

/// The camera menu before the bubble ever opened: each camera once, named as
/// GStreamer names it, which is what WebKitGTK's own device list (also
/// GStreamer's) calls it, so the bubble finds the camera by that name. A
/// camera with no id of its own is listed by its name.
#[must_use]
pub fn cameras(found: Vec<RawCamera>) -> Vec<MediaDevice> {
    tidy_devices(
        found
            .into_iter()
            .map(|c| MediaDevice {
                id: c.id.filter(|id| !id.trim().is_empty()).unwrap_or_else(|| c.display_name.clone()),
                name: c.display_name,
                is_default: false,
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
        let hd = RateControl::for_size(1920, 1080);
        assert_eq!(
            H264Encoder::X264.element(hd),
            "x264enc pass=qual quantizer=23 bitrate=10000 vbv-buf-capacity=1000 key-int-max=120 speed-preset=veryfast"
        );
        assert_eq!(
            H264Encoder::OpenH264.element(hd),
            "openh264enc bitrate=5000000 max-bitrate=10000000 gop-size=120"
        );
        assert_eq!(
            H264Encoder::Va.element(hd),
            "vah264enc rate-control=vbr bitrate=5000 target-percentage=50 key-int-max=120"
        );
        assert_eq!(
            H264Encoder::Vaapi.element(hd),
            "vaapih264enc rate-control=vbr bitrate=10000 target-percentage=50 keyframe-period=120"
        );
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
        "videocrop",
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

    /// The line names exactly what this machine lacks, in its family's
    /// package names; a probe too broken to tell, or an unknown family,
    /// keeps the line that names everything.
    #[test]
    fn the_codec_line_names_only_the_missing_packages() {
        let stock: Vec<&str> = UBUNTU_FULL.iter().copied().filter(|e| !matches!(*e, "x264enc" | "avenc_aac")).collect();
        let probe = Probe::from_registry(false, with(&stock));
        assert_eq!(
            missing_packages(&probe, Distro::Debian).unwrap(),
            ["gstreamer1.0-plugins-ugly", "gstreamer1.0-libav"]
        );
        assert_eq!(
            codecs_missing_line(&missing_packages(&probe, Distro::Debian).unwrap()).unwrap(),
            "Screen recording needs video codecs your system doesn't have. Install gstreamer1.0-plugins-ugly and gstreamer1.0-libav, then restart Hippius."
        );
        assert_eq!(
            missing_packages(&probe, Distro::Fedora).unwrap(),
            ["gstreamer1-plugin-openh264", "gstreamer1-plugin-libav"]
        );
        // Only the AAC encoder missing: only libav.
        let no_aac: Vec<&str> = UBUNTU_FULL.iter().copied().filter(|e| *e != "avenc_aac").collect();
        assert_eq!(
            missing_packages(&Probe::from_registry(false, with(&no_aac)), Distro::Debian).unwrap(),
            ["gstreamer1.0-libav"]
        );
        // A parser and the PipeWire source on Wayland, each once.
        let parts: Vec<&str> = UBUNTU_FULL
            .iter()
            .copied()
            .filter(|e| !matches!(*e, "h264parse" | "pipewiresrc" | "mp4mux" | "aacparse"))
            .collect();
        assert_eq!(
            missing_packages(&Probe::from_registry(true, with(&parts)), Distro::Fedora).unwrap(),
            ["gstreamer1-plugins-good", "gstreamer1-plugins-bad-free", "pipewire-gstreamer"]
        );
        assert_eq!(missing_packages(&Probe::default(), Distro::Debian), None, "GStreamer did not start");
        assert_eq!(missing_packages(&probe, Distro::Other), None);
        assert_eq!(codecs_missing_line(&[]), None);
        assert_eq!(
            codecs_missing_line(&["a", "b", "c"]).unwrap(),
            "Screen recording needs video codecs your system doesn't have. Install a, b and c, then restart Hippius."
        );
    }

    #[test]
    fn the_family_comes_from_os_release() {
        assert_eq!(distro_family("NAME=\"Ubuntu\"\nID=ubuntu\nID_LIKE=debian\n"), Distro::Debian);
        assert_eq!(distro_family("ID=linuxmint\nID_LIKE=\"ubuntu debian\"\n"), Distro::Debian);
        assert_eq!(distro_family("ID=debian\n"), Distro::Debian);
        assert_eq!(distro_family("ID=fedora\nVERSION_ID=42\n"), Distro::Fedora);
        assert_eq!(distro_family("ID=\"rocky\"\nID_LIKE=\"rhel centos fedora\"\n"), Distro::Fedora);
        assert_eq!(distro_family("ID=arch\n"), Distro::Other);
        assert_eq!(distro_family(""), Distro::Other);
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
        assert!(VideoSource::X11Window { xid: 0x0340_0007, inset: 0 }.element().ends_with("xid=0x3400007"));
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

    /// A window with the bubble drawn in is read whole, as BGRx at its own
    /// size, at 30 fps: the recorder composes and sizes it.
    #[test]
    fn a_window_with_the_bubble_is_read_raw_for_the_recorder_to_compose() {
        let text = video_capture_bgrx(&VideoSource::X11Window { xid: 0x40_0007, inset: 0 });
        assert!(
            text.starts_with("ximagesrc use-damage=false show-pointer=true xid=0x400007 name=vsrc"),
            "{text}"
        );
        assert!(text.contains("framerate=30/1"));
        assert!(text.contains("caps=\"video/x-raw,format=BGRx\""), "{text}");
        assert!(!text.contains("videoscale") && !text.contains("name=size"), "no sizing in the pipeline");
        assert!(text.ends_with("appsink name=video max-buffers=4 drop=true sync=false"));
    }

    /// A window or a portal stream says its size with its first frame: the
    /// filter starts open (NV12 only) and the portal is not forced to 30 fps.
    #[test]
    fn a_window_or_portal_capture_learns_its_size_from_the_first_frame() {
        let portal = video_capture(&VideoSource::Portal { fd: 9, node: 70 });
        assert!(portal.contains("caps=\"video/x-raw,format=NV12\""), "{portal}");
        assert!(!portal.contains("framerate"), "{portal}");
        let window = video_capture(&VideoSource::X11Window { xid: 7, inset: 0 });
        assert!(!window.contains("videocrop"), "another app's window is filmed whole");
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
        let peak = RateControl::for_size(3840, 2160).peak_kbps();
        assert!(text.contains(&format!("x264enc pass=qual quantizer=23 bitrate={peak} ")), "{text}");
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

    /// Every encoder is put in a rate control that spends less on a still
    /// screen than the average (never their constant-bit-rate or
    /// constant-QP defaults), with the same ceiling of twice the average and
    /// the Swift helper's keyframe interval, at every size.
    #[test]
    fn every_encoder_spends_less_on_a_still_screen_and_keyframes_alike() {
        for (w, h) in [(1280, 720), (1920, 1080), (3456, 2234), (3840, 2160)] {
            let rate = RateControl::for_size(w, h);
            for encoder in H264Encoder::PREFERENCE {
                let element = encoder.element(rate);
                assert!(element.starts_with(encoder.factory()), "{element}");
                let gop = match encoder {
                    H264Encoder::Va | H264Encoder::X264 => "key-int-max",
                    H264Encoder::Vaapi => "keyframe-period",
                    H264Encoder::OpenH264 => "gop-size",
                };
                let keyframes = format!("{gop}={}", rate.keyframe_frames);
                assert!(element.split(' ').any(|p| p == keyframes), "a keyframe every 4 s: {element}");
                match encoder {
                    H264Encoder::Va => {
                        assert!(element.contains("rate-control=vbr "), "{element}");
                        // The ceiling is bitrate * 100 / target-percentage.
                        assert!(element.contains(&format!("bitrate={} target-percentage=50", rate.average_kbps())));
                        assert_eq!(100 / PEAK_TO_AVERAGE, 50, "a ceiling of twice the average");
                    }
                    H264Encoder::Vaapi => {
                        assert!(element.contains("rate-control=vbr "), "{element}");
                        // Here bitrate is the ceiling and the average its percentage.
                        assert!(element.contains(&format!("bitrate={} target-percentage=50", rate.peak_kbps())));
                    }
                    H264Encoder::X264 => {
                        assert!(element.contains("pass=qual quantizer=23 "), "constant quality, not CBR: {element}");
                        assert!(element.contains(&format!("bitrate={} vbv-buf-capacity=1000", rate.peak_kbps())));
                    }
                    H264Encoder::OpenH264 => {
                        assert!(!element.contains("rate-control="), "its default is quality first: {element}");
                        assert!(element.contains(&format!("bitrate={} max-bitrate={}", rate.average, rate.peak)));
                    }
                }
            }
        }
    }

    /// The encoder only ever gets 8-bit 4:2:0: from RGB, x264 would pick
    /// 4:4:4 and write "High 4:4:4 Predictive".
    #[test]
    fn the_encoder_is_given_4_2_0_only() {
        for audio in [true, false] {
            let text = encode(&encode_plan(audio));
            assert!(
                text.contains("videoconvert ! capsfilter caps=\"video/x-raw,format={ NV12, I420 }\" ! x264enc "),
                "{text}"
            );
        }
        assert!(!ENCODER_INPUT.contains("444") && !ENCODER_INPUT.contains("BGR") && !ENCODER_INPUT.contains("10LE"));
    }

    /// The finished file is remuxed, not re-encoded, with its index first;
    /// the audio track is linked only when the recording has one (a link to
    /// a track that never comes would hold the muxer forever).
    #[test]
    fn the_finished_file_is_remuxed_with_its_index_first() {
        let text = faststart("/c/Recording 1.mp4", "/c/Recording 1.mp4.remux", "/c/Recording 1.mp4.samples", true);
        assert!(
            text.starts_with("filesrc location=\"/c/Recording 1.mp4\" ! qtdemux name=demux "),
            "{text}"
        );
        assert!(text.contains(
            "mp4mux name=remux faststart=true faststart-file=\"/c/Recording 1.mp4.samples\" ! filesink location=\"/c/Recording 1.mp4.remux\""
        ));
        assert!(text.contains("demux.video_0 ! queue ! remux.video_0"));
        assert!(text.contains("demux.audio_0 ! queue ! remux.audio_0"));
        for encoder in ["x264enc", "openh264enc", "vah264enc", "vaapih264enc", "avenc_aac", "videoconvert"] {
            assert!(!text.contains(encoder), "nothing is re-encoded: {text}");
        }
        let silent = faststart("/a.f", "/a.mp4", "/a.t", false);
        assert!(!silent.contains("audio"), "{silent}");
        assert!(silent.contains("demux.video_0 ! queue ! remux.video_0"));
    }

    fn mp4_box(kind: [u8; 4], payload: usize) -> Vec<u8> {
        let mut b = u32::try_from(8 + payload).unwrap().to_be_bytes().to_vec();
        b.extend_from_slice(&kind);
        b.resize(8 + payload, 0);
        b
    }

    /// The layout check reads box headers only: the fragmented file a
    /// recorder writes is not index-first, the rewritten one is, and so is
    /// a 64-bit `mdat` (a recording past 4 GB).
    #[test]
    fn the_layout_check_tells_fragments_from_an_index_first_movie() {
        let read = |parts: &[Vec<u8>]| top_level_boxes(&mut std::io::Cursor::new(parts.concat())).unwrap();
        let fragmented = read(&[
            mp4_box(*b"ftyp", 24),
            mp4_box(*b"moov", 100),
            mp4_box(*b"moof", 50),
            mp4_box(*b"mdat", 1000),
            mp4_box(*b"moof", 50),
            mp4_box(*b"mdat", 900),
            mp4_box(*b"mfra", 40),
        ]);
        assert_eq!(fragmented.len(), 7);
        assert!(!index_first(&fragmented), "fragments");
        let rewritten = read(&[
            mp4_box(*b"ftyp", 24),
            mp4_box(*b"moov", 400),
            mp4_box(*b"uuid", 30),
            mp4_box(*b"mdat", 5000),
        ]);
        assert!(index_first(&rewritten));
        let index_last = read(&[mp4_box(*b"ftyp", 24), mp4_box(*b"mdat", 5000), mp4_box(*b"moov", 400)]);
        assert!(!index_first(&index_last), "index at the end");
        let mut large = 1u32.to_be_bytes().to_vec();
        large.extend_from_slice(b"mdat");
        large.extend_from_slice(&24u64.to_be_bytes());
        large.resize(24, 0);
        assert!(index_first(&read(&[mp4_box(*b"ftyp", 8), mp4_box(*b"moov", 10), large])));
        assert!(top_level_boxes(&mut std::io::Cursor::new(vec![0, 0, 0, 3, b'b', b'a', b'd', b'!'])).is_err());
    }

    #[test]
    fn the_rewrite_lands_next_to_the_recording() {
        let (remuxed, samples) = remux_paths(std::path::Path::new("/c/Recording 1.mp4"));
        assert_eq!(remuxed, std::path::Path::new("/c/Recording 1.mp4.remux"));
        assert_eq!(samples, std::path::Path::new("/c/Recording 1.mp4.samples"));
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
        let screen = x11_source(&start(r#"{"id":1,"output":"/x.mp4","displayId":2}"#), &displays, 0).unwrap();
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
        let VideoSource::X11Area { x, y, width, height } = x11_source(&cmd, &displays, 0).unwrap() else {
            panic!("an area");
        };
        assert_eq!((x, y), (2580, 40));
        assert_eq!((width % 2, height % 2), (0, 0));
        assert!((600..=604).contains(&width) && height == 400, "{width}x{height}");
    }

    #[test]
    fn an_x11_window_is_recorded_by_its_xid_and_a_gone_display_is_refused() {
        let displays = [display(1, 0, 1920, 1080, 1.0)];
        let window = x11_source(&start(r#"{"id":1,"output":"/x.mp4","windowId":62914567}"#), &displays, 0).unwrap();
        assert_eq!(window, VideoSource::X11Window { xid: 62_914_567, inset: 0 });
        assert!(x11_source(&start(r#"{"id":1,"output":"/x.mp4","displayId":9}"#), &displays, 0).is_err());
        assert!(x11_source(&start(r#"{"id":1,"output":"/x.mp4"}"#), &displays, 0).is_err());
    }

    /// Camera only records Hippius's stage window: its transparent margin
    /// is cut at the screen's scale before it is sized; any other window is
    /// filmed whole.
    #[test]
    fn the_camera_stage_is_trimmed_of_its_margin() {
        assert_eq!(stage_inset(Some(400), 400, 1.0), 12);
        assert_eq!(stage_inset(Some(400), 400, 2.0), 24);
        assert_eq!(stage_inset(Some(400), 400, f64::NAN), 12);
        assert_eq!(stage_inset(Some(401), 400, 2.0), 0, "another app's window");
        assert_eq!(stage_inset(None, 400, 2.0), 0, "a window that names no pid");
        let stage = video_capture(&VideoSource::X11Window { xid: 9, inset: 24 });
        assert!(stage.contains("! videocrop top=24 bottom=24 left=24 right=24 ! videoconvert"), "{stage}");
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
            ended_reason(&VideoSource::X11Window { xid: 5, inset: 0 }, &VideoEnd::Error("BadWindow".into())),
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

    /// USB, built-in and v4l2loopback (a phone through DroidCam) cameras,
    /// each once, by the name WebKitGTK also shows.
    #[test]
    fn cameras_are_listed_once_by_their_names() {
        let list = cameras(vec![
            RawCamera {
                id: Some("v4l2_input.pci-0000_00_14.0-usb-0_6_1.0".into()),
                display_name: "Integrated Camera: Integrated C".into(),
            },
            RawCamera {
                id: Some("/dev/video4".into()),
                display_name: "DroidCam Source".into(),
            },
            RawCamera {
                id: None,
                display_name: "Logitech C270".into(),
            },
            RawCamera {
                id: Some("v4l2_input.pci-0000_00_14.0-usb-0_6_1.0".into()),
                display_name: "Integrated Camera: Integrated C".into(),
            },
        ]);
        assert_eq!(
            list.iter().map(|c| (c.id.as_str(), c.name.as_str())).collect::<Vec<_>>(),
            [
                ("v4l2_input.pci-0000_00_14.0-usb-0_6_1.0", "Integrated Camera: Integrated C"),
                ("/dev/video4", "DroidCam Source"),
                ("Logitech C270", "Logitech C270"),
            ]
        );
    }

    /// A Wayland area reads the monitor whole as BGRx, at the stream's own
    /// pace (a portal stream sends a picture when the screen changes), for
    /// the recorder to cut the area out in Rust.
    #[test]
    fn a_wayland_area_reads_the_whole_stream_raw() {
        let text = video_capture_bgrx(&VideoSource::Portal { fd: 9, node: 70 });
        assert!(text.starts_with("pipewiresrc fd=9 path=70"), "{text}");
        assert!(!text.contains("framerate"), "{text}");
        assert!(!text.contains("videocrop") && !text.contains("name=size"), "the crop is Rust's");
        assert!(text.contains("caps=\"video/x-raw,format=BGRx\""), "{text}");
    }

    /// Camera only on Wayland: the camera is asked for at most 1080p at a
    /// real frame rate (JPEG only where it can be decoded), mirrored as the
    /// stage shows it, and sized from its first picture like any source.
    #[test]
    fn a_camera_is_bounded_mirrored_and_sized_from_its_first_picture() {
        let text = camera_capture_tail(true, true);
        assert!(text.starts_with("queue name=camin "), "{text}");
        assert!(
            text.contains("video/x-raw,width=[1,1920],height=[1,1080],framerate=[15/1,60/1];image/jpeg"),
            "{text}"
        );
        assert!(text.contains("decodebin ! videoconvert ! videoflip method=horizontal-flip"), "{text}");
        assert!(text.contains("capsfilter name=size caps=\"video/x-raw,format=NV12\""), "{text}");
        assert!(text.ends_with("appsink name=video max-buffers=4 drop=true sync=false"));
        assert!(!camera_capture_tail(true, false).contains("image/jpeg"), "no decoder, no JPEG");
        let open = camera_capture_tail(false, true);
        assert!(!open.contains("framerate") && open.contains("videoflip"), "{open}");
    }

    fn camera(id: Option<&str>, name: &str) -> RawCamera {
        RawCamera {
            id: id.map(str::to_string),
            display_name: name.into(),
        }
    }

    /// The recorder opens the camera the bubble showed: by the bar's id,
    /// else by the name WebKitGTK and GStreamer share (a phone's curly
    /// apostrophe matches a straight one), else the default with the flag
    /// saying so; nothing at all without a camera.
    #[test]
    fn the_recorder_opens_the_camera_the_bubble_showed() {
        use crate::capture::recording::protocol::CameraPick;
        let found = [
            camera(Some("/dev/video0"), "Integrated Camera: Integrated C"),
            camera(Some("v4l2_input.pci-0000_00_14.0-usb-0_1_1.0"), "Ana\u{2019}s Pixel"),
            camera(None, "OBS Virtual Camera"),
        ];
        let by = |id: Option<&str>, name: Option<&str>| CameraPick {
            id: id.map(str::to_string),
            name: name.map(str::to_string),
        };
        assert_eq!(pick_camera(&found, &by(Some("/dev/video0"), None)), Some((0, true)));
        assert_eq!(
            pick_camera(&found, &by(Some("v4l2_input.pci-0000_00_14.0-usb-0_1_1.0"), Some("whatever"))),
            Some((1, true)),
            "the id wins over the name"
        );
        // A webview deviceId (no match among GStreamer's ids) falls to the name.
        assert_eq!(pick_camera(&found, &by(Some("8d1c0f..."), Some("ana's  pixel"))), Some((1, true)));
        assert_eq!(pick_camera(&found, &by(None, Some("OBS Virtual Camera"))), Some((2, true)));
        assert_eq!(pick_camera(&found, &by(None, None)), Some((0, true)), "nothing chosen: the default");
        assert_eq!(pick_camera(&found, &by(Some("default"), None)), Some((0, true)));
        assert_eq!(
            pick_camera(&found, &by(Some("/dev/video9"), Some("Unplugged"))),
            Some((0, false)),
            "a camera that is gone records the default, and says so"
        );
        assert_eq!(pick_camera(&[], &by(None, None)), None);
        assert_eq!(camera_name_key("  Ana\u{2019}s   PIXEL "), "ana's pixel");
    }

    /// The probe says whether camera only can be recorded without a window:
    /// a camera source and the decoder and mirror, on a machine that records.
    #[test]
    fn the_probe_says_whether_the_recorder_can_open_a_camera() {
        let full: Vec<&str> = H264Encoder::PREFERENCE
            .iter()
            .map(|e| e.factory())
            .chain(AacEncoder::PREFERENCE.iter().map(|e| e.factory()))
            .chain(NEEDED_ALWAYS)
            .chain(["pipewiresrc", "ximagesrc"])
            .collect();
        let with_camera: Vec<&str> = full.iter().copied().chain(NEEDED_FOR_CAMERA).chain(["v4l2src"]).collect();
        let mut probe = Probe::from_registry(true, with(&with_camera));
        probe.screencast_portal = Some(true);
        assert_eq!(probe.camera, Some(true));
        assert!(probe.records_camera(true));
        let mut no_flip = Probe::from_registry(true, with(&full.iter().copied().chain(["decodebin", "v4l2src"]).collect::<Vec<_>>()));
        no_flip.screencast_portal = Some(true);
        assert!(!no_flip.records_camera(true), "no videoflip");
        let mut no_portal = probe.clone();
        no_portal.screencast_portal = Some(false);
        assert!(!no_portal.records_camera(true), "a machine that cannot record cannot record the camera");
        assert!(!Probe::default().records_camera(true), "an older probe that never said");
    }
}
