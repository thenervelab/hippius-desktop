//! Phase 4 groundwork (Linux recording): the pure decisions the GStreamer
//! recorder will make, settled and tested before any GStreamer code exists.
//! Nothing here links GStreamer or runs on its own yet.
//!
//! - Which encoders: the first the distro installed, in the plan's order
//!   (hardware first), or `codecsMissing` when there is no H.264 or no AAC.
//! - The pipeline text: the source for X11 (`ximagesrc`, an area by its
//!   inclusive corners or a window by XID) or Wayland (`pipewiresrc` on the
//!   ScreenCast portal's fd and node), scaled to `sizing::capped`, encoded at
//!   `sizing::video_bit_rate`, into fragmented MP4 every 2 s so a killed
//!   recorder leaves a playable file (the Swift helper's rule).
//! - Which microphones: PipeWire / PulseAudio sources without the `.monitor`
//!   sources (those are system audio), default first.
//!
//! See `docs/plans/2026-10-01-capture-windows-linux.md`, decision 3 and
//! Phase 4.

// Phase 4 wires these into the recorder; until then only the tests call them.
#![allow(dead_code)]

use std::fmt::Write as _;

use super::sizing;
use crate::capture::recording::{MediaDevice, tidy_devices};

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

/// What one recording records.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipelinePlan {
    pub source: VideoSource,
    /// The size the source delivers, in pixels.
    pub source_width: u32,
    pub source_height: u32,
    pub encoders: Encoders,
    /// PulseAudio / PipeWire source names to mix: the microphone and, when
    /// the user turned it on, the default output's monitor.
    pub audio_sources: Vec<String>,
    pub output: String,
}

/// Frames per second, as on macOS.
pub const FPS: u32 = 30;
/// Fragment length in ms: what a killed recorder can lose at most.
pub const FRAGMENT_MS: u32 = 2000;

/// The gst-launch description of `plan`. Named elements (`vsrc`, `venc`,
/// `mix`, `mux`) are where the recorder hangs its pause probes and reads its
/// bus errors. No audio source = no audio branch and no audio track.
#[must_use]
pub fn pipeline(plan: &PipelinePlan) -> String {
    let (w, h) = sizing::capped(plan.source_width, plan.source_height);
    // H.264 wants even sizes; `capped` keeps a capped size even, a small
    // source is evened here.
    let (w, h) = ((w & !1).max(2), (h & !1).max(2));
    let mut out = format!(
        "{src} name=vsrc ! videorate ! videoconvert ! videoscale ! \
         video/x-raw,format=I420,width={w},height={h},framerate={FPS}/1,pixel-aspect-ratio=1/1 ! \
         {venc} name=venc ! h264parse ! queue ! mux. ",
        src = plan.source.element(),
        venc = plan.encoders.video.element(sizing::video_bit_rate(w, h)),
    );
    if !plan.audio_sources.is_empty() {
        out.push_str("audiomixer name=mix ! audioconvert ! audioresample ! audio/x-raw,rate=48000,channels=2 ! ");
        out.push_str(&plan.encoders.audio.element());
        out.push_str(" ! aacparse ! queue ! mux. ");
        for device in &plan.audio_sources {
            // Writing into a String cannot fail.
            let _ = write!(
                out,
                "pulsesrc device={} do-timestamp=true ! audioconvert ! audioresample ! queue ! mix. ",
                quoted(device)
            );
        }
    }
    let _ = write!(
        out,
        "mp4mux name=mux fragment-duration={FRAGMENT_MS} ! filesink location={}",
        quoted(&plan.output)
    );
    out
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

    fn plan(audio: &[&str]) -> PipelinePlan {
        PipelinePlan {
            source: VideoSource::X11Area {
                x: 0,
                y: 0,
                width: 5120,
                height: 2880,
            },
            source_width: 5120,
            source_height: 2880,
            encoders: Encoders {
                video: H264Encoder::X264,
                audio: AacEncoder::Avenc,
            },
            audio_sources: audio.iter().map(|s| (*s).to_string()).collect(),
            output: "/home/me/.hippius/capture-tmp/capture-x/Recording.mp4".into(),
        }
    }

    /// A 5K screen is capped to a 3840 long edge, encoded at the shared bit
    /// rate for that size, and written as 2 s MP4 fragments.
    #[test]
    fn the_pipeline_caps_the_size_and_writes_fragments() {
        let text = pipeline(&plan(&[]));
        assert!(text.contains("width=3840,height=2160,framerate=30/1"), "{text}");
        let kbps = sizing::video_bit_rate(3840, 2160).div_ceil(1000);
        assert!(text.contains(&format!("x264enc bitrate={kbps} ")), "{text}");
        assert!(text.contains("mp4mux name=mux fragment-duration=2000"));
        assert!(!text.contains("audiomixer"), "no audio source, no audio track");
        assert!(text.ends_with("filesink location=\"/home/me/.hippius/capture-tmp/capture-x/Recording.mp4\""));
    }

    /// The microphone and the system's sound are MIXED into one track
    /// (decision 6): one encoder, every source into the mixer.
    #[test]
    fn every_audio_source_goes_into_one_mixed_track() {
        let text = pipeline(&plan(&["alsa_input.usb-mic", &monitor_of("alsa_output.pci-analog-stereo")]));
        assert_eq!(text.matches("avenc_aac").count(), 1);
        assert_eq!(text.matches("! mix. ").count(), 2);
        assert!(text.contains("pulsesrc device=\"alsa_output.pci-analog-stereo.monitor\""));
        assert!(text.contains("audio/x-raw,rate=48000,channels=2"));
    }

    #[test]
    fn an_odd_sized_source_is_evened() {
        let mut p = plan(&[]);
        p.source_width = 801;
        p.source_height = 601;
        assert!(pipeline(&p).contains("width=800,height=600,"));
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
    }
}
