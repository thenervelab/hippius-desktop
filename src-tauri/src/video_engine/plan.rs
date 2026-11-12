//! What to do with a video the webview cannot play, and the engine command
//! lines that do it. Pure: every decision here is unit-tested on every OS.
//!
//! The engine has no H.264, HEVC or AAC decoder and no encoder of its own
//! (see `scripts/video-engine/build-ffmpeg.sh`): H.264 and HEVC are only ever
//! copied, and anything converted is encoded by the operating system
//! (VideoToolbox and AudioToolbox on macOS, Media Foundation on Windows).
//!
//! - **Remux** when the picture is already something the webview decodes
//!   (H.264 up to High profile everywhere; HEVC on macOS, whose WebKit plays
//!   it): the video is copied untouched into an MP4. Lossless and as fast as
//!   the disk. Audio the webview plays (AAC, MP3, Opus) is copied; audio it
//!   does not (AC-3, WMA, FLAC, ...) is re-encoded to AAC by the OS; where
//!   there is no OS encoder (Linux) or no decoder (E-AC-3, DTS) the video
//!   plays without sound and the viewer says so.
//! - **Transcode** the old formats (WMV, VC-1, MPEG-2, MPEG-4 Part 2, FLV,
//!   ...) to H.264 + AAC with the OS encoders, a few seconds at a time, as
//!   the player asks for them (`session.rs`). Only where the OS has an H.264
//!   encoder: on Linux these are not previewable.
//! - **Unsupported** otherwise, which the viewer shows with Download.

use std::fmt::Write as _;

use super::probe::{AudioStream, MediaInfo};

/// The OS the decision is for (the webview differs per OS).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    MacOs,
    Windows,
    Linux,
}

impl Platform {
    #[must_use]
    pub const fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::MacOs
        } else if cfg!(target_os = "windows") {
            Self::Windows
        } else {
            Self::Linux
        }
    }
}

/// What this machine can do: its OS, and which of the OS encoders passed
/// their test encode (`engine.rs`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Capabilities {
    pub platform: Platform,
    pub video_encoder: Option<Encoder>,
    pub audio_encoder: Option<AudioEncoder>,
}

/// What happens to the audio.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioPlan {
    /// Copied as it is (the player decodes it).
    Copy,
    /// Decoded and encoded to AAC by this OS encoder.
    Encode(AudioEncoder),
    /// The file has no audio.
    None,
    /// The file has audio nothing here can play: the video plays silent and
    /// the viewer says so ([`SILENT_NOTICE`]).
    Drop,
}

impl AudioPlan {
    /// The viewer's line beside a video whose sound was left out.
    #[must_use]
    pub const fn notice(self) -> Option<&'static str> {
        match self {
            Self::Drop => Some(SILENT_NOTICE),
            _ => None,
        }
    }
}

/// What the viewer says under a video playing without its sound.
/// Worded like the web console's line for the same case.
pub const SILENT_NOTICE: &str = "Playing without sound: Hippius can't play this video's audio track.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Remux {
        audio: AudioPlan,
    },
    Transcode {
        audio: AudioPlan,
    },
    /// Not previewable; the string is for the log, never for the user.
    Unsupported(&'static str),
}

/// Extensions the webview plays itself: the viewer keeps its existing path
/// for these and only comes here if that playback fails.
pub const WEBVIEW_EXTENSIONS: &[&str] = &["mp4", "m4v", "mov", "webm", "ogg", "ogv"];

/// Extensions the viewer sends here first. Plain `.ts` is not one of them:
/// it is far more often TypeScript than a video.
pub const ENGINE_EXTENSIONS: &[&str] = &[
    "wmv", "asf", "avi", "divx", "mkv", "flv", "f4v", "mpg", "mpeg", "m2v", "vob", "m2ts", "mts", "m2t", "3gp", "3g2",
];

/// Whether `ext` (any case) is a video this preview knows how to open.
#[must_use]
pub fn is_engine_extension(ext: &str) -> bool {
    let ext = ext.to_ascii_lowercase();
    ENGINE_EXTENSIONS.contains(&ext.as_str())
}

#[must_use]
pub fn is_webview_extension(ext: &str) -> bool {
    let ext = ext.to_ascii_lowercase();
    WEBVIEW_EXTENSIONS.contains(&ext.as_str())
}

/// Video codecs the engine decodes, so can convert where the OS encodes.
/// Mirrors the build script's `--enable-decoder` list.
const DECODABLE_VIDEO: &[&str] = &[
    "vc1",
    "wmv1",
    "wmv2",
    "wmv3",
    "mpeg1video",
    "mpeg2video",
    "mpeg4",
    "msmpeg4v1",
    "msmpeg4v2",
    "msmpeg4v3",
    "h263",
    "h263p",
    "flv1",
    "vp6",
    "vp6a",
    "vp6f",
    "vp8",
    "vp9",
    "theora",
    "mjpeg",
    "dvvideo",
    "cinepak",
    "msvideo1",
    "rawvideo",
];

/// Audio codecs the engine decodes, so can re-encode to AAC.
fn decodable_audio(codec: &str) -> bool {
    matches!(
        codec,
        "mp1"
            | "mp2"
            | "mp3"
            | "ac3"
            | "wmav1"
            | "wmav2"
            | "wmapro"
            | "wmalossless"
            | "flac"
            | "opus"
            | "vorbis"
            | "alac"
            | "adpcm_ms"
            | "adpcm_ima_wav"
    ) || codec.starts_with("pcm_")
}

/// Whether the webview decodes this picture as it is.
fn picture_plays(info: &MediaInfo, platform: Platform) -> bool {
    let Some(video) = &info.video else { return false };
    // The engine cannot decode H.264 or HEVC, so their pixel format is
    // usually unknown; the profile says whether it is beyond what webviews
    // play (10-bit, 4:2:2, 4:4:4).
    let profile = video.profile.as_deref().unwrap_or("");
    let beyond_8bit_420 = ["10", "4:2:2", "4:4:4", "Rext"].iter().any(|p| profile.contains(p));
    let pix_ok = video.pix_fmt.as_deref().is_none_or(|p| matches!(p, "yuv420p" | "yuvj420p" | "nv12"));
    // 4K is the most any of the three webviews decodes reliably.
    let fits = video.width > 0 && video.height > 0 && video.width <= 4096 && video.height <= 4096;
    match video.codec.as_str() {
        "h264" => !beyond_8bit_420 && pix_ok && fits,
        // WebKit on macOS decodes HEVC, 8 or 10-bit (with the `hvc1` tag the
        // remux writes); Windows needs a paid Store extension, Linux a plugin.
        "hevc" => platform == Platform::MacOs && !profile.contains("4:") && !profile.contains("Rext") && fits,
        _ => false,
    }
}

/// The audio plan for `audio` into `container_plays` (what the target
/// container and the webview play as they are).
fn audio_plan(audio: Option<&AudioStream>, copyable: &[&str], encoder: Option<AudioEncoder>) -> AudioPlan {
    let Some(audio) = audio else { return AudioPlan::None };
    if copyable.contains(&audio.codec.as_str()) {
        return AudioPlan::Copy;
    }
    match encoder {
        Some(encoder) if decodable_audio(&audio.codec) => AudioPlan::Encode(encoder),
        _ => AudioPlan::Drop,
    }
}

/// Decide for `info` on a machine that can do `caps`.
#[must_use]
pub fn decide(info: &MediaInfo, caps: Capabilities) -> Decision {
    let Some(video) = &info.video else {
        return Decision::Unsupported("no video stream");
    };
    if picture_plays(info, caps.platform) {
        // Into MP4, which every webview plays with AAC, MP3 or Opus in it.
        let audio = audio_plan(info.audio.as_ref(), &["aac", "mp3", "opus"], caps.audio_encoder);
        return Decision::Remux { audio };
    }
    if matches!(video.codec.as_str(), "h264" | "hevc") {
        // Never decoded: a 10-bit H.264 or HEVC off macOS is not previewable.
        return Decision::Unsupported("H.264/HEVC the webview cannot play");
    }
    if !DECODABLE_VIDEO.contains(&video.codec.as_str()) {
        return Decision::Unsupported("no decoder for the video");
    }
    let Some(_) = caps.video_encoder else {
        return Decision::Unsupported("no OS video encoder");
    };
    // A transcode is a VOD playlist cut from the duration up front.
    if info.duration.is_none() {
        return Decision::Unsupported("unknown duration");
    }
    // Into MPEG-TS for hls.js and WebKit: AAC and MP3 travel as they are.
    let audio = audio_plan(info.audio.as_ref(), &["aac", "mp3"], caps.audio_encoder);
    Decision::Transcode { audio }
}

/// The H.264 encoder a transcode uses: the operating system's, picked once
/// per launch by a test encode (`engine.rs`), best first.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Encoder {
    /// macOS VideoToolbox (hardware; `allow_sw` covers a Mac without it).
    VideoToolbox,
    /// Windows Media Foundation through a hardware encoder (Intel, AMD, NVIDIA).
    MediaFoundationHardware,
    /// Windows Media Foundation's own software encoder.
    MediaFoundation,
}

impl Encoder {
    /// Candidates for `platform`, best first. Linux has none: there is no
    /// system H.264 encoder to call, and the engine carries none of its own.
    #[must_use]
    pub fn candidates(platform: Platform) -> &'static [Self] {
        match platform {
            Platform::MacOs => &[Self::VideoToolbox],
            Platform::Windows => &[Self::MediaFoundationHardware, Self::MediaFoundation],
            Platform::Linux => &[],
        }
    }

    /// The engine's encoder name, as `-encoders` lists it.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::VideoToolbox => "h264_videotoolbox",
            Self::MediaFoundationHardware | Self::MediaFoundation => "h264_mf",
        }
    }

    /// `-c:v ...` and the options that make it a preview: a bitrate for the
    /// output size, no B-frames (simple timestamps across restarts) and
    /// speed over quality where the encoder offers the choice. No `-maxrate`:
    /// VideoToolbox's data-rate limit made a 1080p WMV convert 1.8x slower,
    /// and a preview has no buffer model to honour.
    #[must_use]
    pub fn args(self, bitrate_kbps: u32) -> Vec<String> {
        let rate = format!("{bitrate_kbps}k");
        let mut out: Vec<String> = vec!["-c:v".into(), self.name().into(), "-b:v".into(), rate];
        let extra: &[&str] = match self {
            Self::VideoToolbox => &["-allow_sw", "1", "-prio_speed", "1", "-profile:v", "high", "-bf", "0"],
            Self::MediaFoundationHardware => &["-hw_encoding", "1", "-scenario", "display_remoting", "-bf", "0"],
            Self::MediaFoundation => &["-scenario", "display_remoting", "-bf", "0"],
        };
        out.extend(extra.iter().map(|s| (*s).to_string()));
        out
    }
}

/// The AAC encoder: the operating system's, like the video one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioEncoder {
    /// macOS AudioToolbox.
    AudioToolbox,
    /// Windows Media Foundation.
    MediaFoundation,
}

impl AudioEncoder {
    /// The candidate for `platform`, if it has one.
    #[must_use]
    pub const fn candidate(platform: Platform) -> Option<Self> {
        match platform {
            Platform::MacOs => Some(Self::AudioToolbox),
            Platform::Windows => Some(Self::MediaFoundation),
            Platform::Linux => None,
        }
    }

    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::AudioToolbox => "aac_at",
            Self::MediaFoundation => "aac_mf",
        }
    }

    /// `-c:a ...`: stereo 48 kHz at 160 kb/s, which Media Foundation's AAC
    /// encoder accepts (it takes only 96, 128, 160 or 192 kb/s).
    #[must_use]
    pub fn args(self) -> Vec<String> {
        ["-c:a", self.name(), "-b:a", "160k", "-ac", "2", "-ar", "48000"]
            .iter()
            .map(|s| (*s).to_string())
            .collect()
    }
}

/// Previews are capped at 1080p and 60 fps: enough for a preview, and it
/// keeps a 4K source from pinning the CPU.
pub const MAX_WIDTH: u32 = 1920;
pub const MAX_HEIGHT: u32 = 1080;
pub const MAX_FPS: u32 = 60;

/// The output size for a `width` x `height` source: fitted inside 1920x1080
/// keeping its shape, never enlarged, even dimensions.
#[must_use]
pub fn output_size(width: u32, height: u32) -> (u32, u32) {
    if width == 0 || height == 0 {
        return (MAX_WIDTH, MAX_HEIGHT);
    }
    let scale = f64::min(
        1.0,
        f64::min(f64::from(MAX_WIDTH) / f64::from(width), f64::from(MAX_HEIGHT) / f64::from(height)),
    );
    let even = |v: f64| -> u32 {
        // Truncation is the point: round down to an even pixel count.
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let v = v.max(2.0) as u32;
        v & !1
    };
    (even(f64::from(width) * scale), even(f64::from(height) * scale))
}

/// Bitrate for an output height: enough for a clean preview, no more.
#[must_use]
pub const fn bitrate_kbps(height: u32) -> u32 {
    if height <= 480 {
        1500
    } else if height <= 720 {
        3000
    } else {
        6000
    }
}

/// The video filter: square pixels (a DVD's 720x480 at 8:9 becomes
/// 640x480), deinterlaced when the frames say they are interlaced, fitted
/// inside 1080p without enlarging, 8-bit 4:2:0.
#[must_use]
pub fn video_filter() -> String {
    format!(
        "scale=w='trunc(iw*sar/2)*2':h=ih,setsar=1,bwdif=deint=interlaced,\
         scale=w='min({MAX_WIDTH},iw)':h='min({MAX_HEIGHT},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,\
         format=yuv420p"
    )
}

/// Seconds per HLS segment: the step a seek lands on and how much is
/// converted before the first frame shows.
pub const SEGMENT_SECS: u32 = 4;

/// `-ss` / `-output_ts_offset` value for segment `index`.
#[must_use]
pub fn segment_start(index: u32) -> String {
    format!("{}", u64::from(index) * u64::from(SEGMENT_SECS))
}

/// The `-map`/`-c:a` arguments for `audio` under `plan` (`-an` to leave it out).
fn audio_args(audio: Option<&AudioStream>, plan: AudioPlan) -> Vec<String> {
    match (audio, plan) {
        (Some(a), AudioPlan::Copy) => vec!["-map".into(), format!("0:{}", a.index), "-c:a".into(), "copy".into()],
        (Some(a), AudioPlan::Encode(encoder)) => {
            let mut out = vec!["-map".into(), format!("0:{}", a.index)];
            out.extend(encoder.args());
            out
        }
        _ => vec!["-an".into()],
    }
}

/// The engine command line for a transcode starting at segment `start_index`,
/// writing MPEG-TS to stdout. Keyframes are forced on every segment boundary
/// so `segmenter.rs` can cut there, and timestamps carry the real position
/// (`-output_ts_offset`) so segments from different runs line up.
#[must_use]
pub fn transcode_args(input: &str, info: &MediaInfo, encoder: Encoder, audio: AudioPlan, start_index: u32) -> Vec<String> {
    let video = info.video.as_ref();
    let (_, out_h) = video.map_or((MAX_WIDTH, MAX_HEIGHT), |v| output_size(v.width, v.height));
    let source_fps = video.and_then(|v| v.fps).filter(|f| f.is_finite() && *f > 0.0);
    let fps = source_fps.map_or(30.0, |f| f.min(f64::from(MAX_FPS)));
    // A GOP of one segment backs up the forced keyframes for an encoder that
    // ignores them.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let gop = ((fps * f64::from(SEGMENT_SECS)).round() as u32).max(1);
    let start = segment_start(start_index);
    let mut args: Vec<String> = ["-hide_banner", "-nostdin", "-loglevel", "error"]
        .iter()
        .map(|s| (*s).to_string())
        .collect();
    if start_index > 0 {
        args.extend(["-ss".into(), start.clone()]);
    }
    args.extend(["-i".into(), input.into()]);
    if let Some(v) = video {
        args.extend(["-map".into(), format!("0:{}", v.index)]);
    }
    args.extend(["-sn".into(), "-dn".into(), "-vf".into(), video_filter()]);
    // Only for a source above the cap: `-fpsmax` on a 24 fps WMV made the
    // whole conversion twice as slow while changing nothing.
    if source_fps.is_some_and(|f| f > f64::from(MAX_FPS)) {
        args.extend(["-fpsmax".into(), MAX_FPS.to_string()]);
    }
    args.extend(encoder.args(bitrate_kbps(out_h)));
    args.extend([
        "-g".into(),
        gop.to_string(),
        "-force_key_frames".into(),
        format!("expr:gte(t,n_forced*{SEGMENT_SECS})"),
    ]);
    args.extend(audio_args(info.audio.as_ref(), audio));
    args.extend(["-output_ts_offset".into(), start, "-f".into(), "mpegts".into(), "pipe:1".into()]);
    args
}

/// The engine command line for a remux into `output` (an MP4), reporting
/// progress as `key=value` lines on stdout. The picture is always copied.
#[must_use]
pub fn remux_args(input: &str, output: &str, info: &MediaInfo, audio: AudioPlan) -> Vec<String> {
    let mut args: Vec<String> = ["-hide_banner", "-nostdin", "-loglevel", "error", "-nostats", "-progress", "pipe:1", "-y"]
        .iter()
        .map(|s| (*s).to_string())
        .collect();
    args.extend(["-i".into(), input.into()]);
    if let Some(v) = &info.video {
        args.extend(["-map".into(), format!("0:{}", v.index), "-c:v".into(), "copy".into()]);
        if v.codec == "hevc" {
            // WebKit plays HEVC in MP4 only under the `hvc1` tag.
            args.extend(["-tag:v".into(), "hvc1".into()]);
        }
    }
    args.extend(audio_args(info.audio.as_ref(), audio));
    args.extend(["-sn".into(), "-dn".into(), "-f".into(), "mp4".into(), output.into()]);
    args
}

/// The HLS playlist for a `duration`-second video cut into
/// [`SEGMENT_SECS`] segments named `0.ts`, `1.ts`, ...
#[must_use]
pub fn playlist(duration: f64) -> String {
    let count = segment_count(duration);
    let mut out = format!("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:{SEGMENT_SECS}\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n");
    for i in 0..count {
        let start = f64::from(i) * f64::from(SEGMENT_SECS);
        let len = (duration - start).min(f64::from(SEGMENT_SECS)).max(0.001);
        let _ = write!(out, "#EXTINF:{len:.3},\n{i}.ts\n");
    }
    out.push_str("#EXT-X-ENDLIST\n");
    out
}

/// How many segments a `duration`-second video has. A sliver of under a
/// tenth of a second at the end joins the segment before it rather than
/// becoming one the player would have to fetch for nothing.
#[must_use]
pub fn segment_count(duration: f64) -> u32 {
    let secs = f64::from(SEGMENT_SECS);
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let n = ((duration - 0.1).max(0.0) / secs).ceil() as u32;
    n.max(1)
}

#[cfg(test)]
mod tests {
    use super::super::probe::{AudioStream, VideoStream};
    use super::*;

    const MAC: Capabilities = Capabilities {
        platform: Platform::MacOs,
        video_encoder: Some(Encoder::VideoToolbox),
        audio_encoder: Some(AudioEncoder::AudioToolbox),
    };
    const WINDOWS: Capabilities = Capabilities {
        platform: Platform::Windows,
        video_encoder: Some(Encoder::MediaFoundation),
        audio_encoder: Some(AudioEncoder::MediaFoundation),
    };
    const LINUX: Capabilities = Capabilities {
        platform: Platform::Linux,
        video_encoder: None,
        audio_encoder: None,
    };

    fn info(codec: &str, profile: Option<&str>, audio: Option<&str>) -> MediaInfo {
        MediaInfo {
            formats: vec!["matroska".into()],
            duration: Some(600.0),
            video: Some(VideoStream {
                index: 0,
                codec: codec.into(),
                // What the shipped engine reports for H.264/HEVC: no decoder.
                pix_fmt: if matches!(codec, "h264" | "hevc") {
                    None
                } else {
                    Some("yuv420p".into())
                },
                profile: profile.map(str::to_string),
                width: 1920,
                height: 1080,
                fps: Some(25.0),
            }),
            audio: audio.map(|c| AudioStream { index: 1, codec: c.into() }),
        }
    }

    #[test]
    fn playable_h264_is_remuxed_everywhere_and_audio_follows_what_the_os_can_encode() {
        for caps in [MAC, WINDOWS, LINUX] {
            for copyable in ["aac", "mp3", "opus"] {
                assert_eq!(
                    decide(&info("h264", Some("High"), Some(copyable)), caps),
                    Decision::Remux { audio: AudioPlan::Copy }
                );
            }
            assert_eq!(
                decide(&info("h264", Some("Main"), None), caps),
                Decision::Remux { audio: AudioPlan::None }
            );
            // No decoder at all for these: the picture plays silent.
            for undecodable in ["eac3", "dts", "truehd", "aac_latm", "amr_nb"] {
                assert_eq!(
                    decide(&info("h264", None, Some(undecodable)), caps),
                    Decision::Remux { audio: AudioPlan::Drop }
                );
            }
        }
        assert_eq!(
            decide(&info("h264", None, Some("ac3")), MAC),
            Decision::Remux {
                audio: AudioPlan::Encode(AudioEncoder::AudioToolbox)
            }
        );
        assert_eq!(
            decide(&info("h264", None, Some("wmav2")), WINDOWS),
            Decision::Remux {
                audio: AudioPlan::Encode(AudioEncoder::MediaFoundation)
            }
        );
        // Linux has no OS AAC encoder: AC-3 is left out and the viewer says so.
        assert_eq!(
            decide(&info("h264", None, Some("ac3")), LINUX),
            Decision::Remux { audio: AudioPlan::Drop }
        );
        assert_eq!(AudioPlan::Drop.notice(), Some(SILENT_NOTICE));
        assert_eq!(AudioPlan::Copy.notice(), None);
    }

    /// H.264 and HEVC are never decoded, so one the webview cannot play is
    /// not previewable, never converted.
    #[test]
    fn h264_and_hevc_are_only_ever_copied() {
        for profile in ["High 10", "High 4:2:2", "High 4:4:4 Predictive"] {
            for caps in [MAC, WINDOWS, LINUX] {
                assert!(
                    matches!(decide(&info("h264", Some(profile), Some("aac")), caps), Decision::Unsupported(_)),
                    "{profile}"
                );
            }
        }
        assert_eq!(
            decide(&info("hevc", Some("Main 10"), Some("aac")), MAC),
            Decision::Remux { audio: AudioPlan::Copy }
        );
        assert_eq!(decide(&info("hevc", None, Some("aac")), MAC), Decision::Remux { audio: AudioPlan::Copy });
        assert!(matches!(
            decide(&info("hevc", Some("Main"), Some("aac")), WINDOWS),
            Decision::Unsupported(_)
        ));
        assert!(matches!(
            decide(&info("hevc", Some("Main"), Some("aac")), LINUX),
            Decision::Unsupported(_)
        ));
        let mut big = info("h264", Some("High"), None);
        big.video.as_mut().unwrap().width = 7680;
        big.video.as_mut().unwrap().height = 4320;
        assert!(matches!(decide(&big, MAC), Decision::Unsupported(_)));
    }

    #[test]
    fn old_formats_are_converted_with_the_os_encoders_and_not_at_all_on_linux() {
        for codec in ["wmv3", "wmv2", "vc1", "mpeg2video", "mpeg4", "msmpeg4v3", "flv1", "vp6f"] {
            assert_eq!(
                decide(&info(codec, None, Some("wmav2")), MAC),
                Decision::Transcode {
                    audio: AudioPlan::Encode(AudioEncoder::AudioToolbox)
                },
                "{codec}"
            );
            assert_eq!(
                decide(&info(codec, None, Some("mp3")), WINDOWS),
                Decision::Transcode { audio: AudioPlan::Copy },
                "{codec}"
            );
            assert!(
                matches!(decide(&info(codec, None, Some("wmav2")), LINUX), Decision::Unsupported(_)),
                "{codec}"
            );
        }
        // AAC travels into the stream as it is: it is never decoded.
        assert_eq!(
            decide(&info("vp6f", None, Some("aac")), MAC),
            Decision::Transcode { audio: AudioPlan::Copy }
        );
        // Opus goes into MPEG-TS as AAC.
        assert_eq!(
            decide(&info("mpeg4", None, Some("opus")), MAC),
            Decision::Transcode {
                audio: AudioPlan::Encode(AudioEncoder::AudioToolbox)
            }
        );
        assert_eq!(
            decide(&info("mpeg4", None, Some("dts")), MAC),
            Decision::Transcode { audio: AudioPlan::Drop }
        );
        // A Mac whose encoder failed its test is like Linux.
        let no_encoder = Capabilities { video_encoder: None, ..MAC };
        assert!(matches!(decide(&info("wmv3", None, None), no_encoder), Decision::Unsupported(_)));
    }

    #[test]
    fn no_video_no_decoder_or_no_duration_for_a_transcode_is_unsupported() {
        let mut none = info("wmv3", None, None);
        none.video = None;
        assert!(matches!(decide(&none, MAC), Decision::Unsupported(_)));
        assert!(matches!(decide(&info("prores", None, None), MAC), Decision::Unsupported(_)));
        assert!(matches!(decide(&info("av1", None, None), MAC), Decision::Unsupported(_)));
        let mut endless = info("wmv3", None, None);
        endless.duration = None;
        assert!(matches!(decide(&endless, MAC), Decision::Unsupported(_)));
        // A remux needs no duration.
        let mut copy = info("h264", None, None);
        copy.duration = None;
        assert!(matches!(decide(&copy, LINUX), Decision::Remux { .. }));
    }

    /// The decoders the decision counts on are the ones the build compiles.
    #[test]
    fn the_decodable_lists_match_the_engine_build() {
        let script = std::fs::read_to_string(format!("{}/../scripts/video-engine/build-ffmpeg.sh", env!("CARGO_MANIFEST_DIR"))).unwrap();
        let enabled: Vec<&str> = script
            .lines()
            .filter_map(|l| l.trim().strip_prefix("--enable-decoder="))
            .flat_map(|l| l.split(','))
            .collect();
        // The build names the FLV decoder `flv`; streams report `flv1`.
        for codec in DECODABLE_VIDEO.iter().map(|c| if *c == "flv1" { "flv" } else { c }) {
            assert!(enabled.contains(&codec), "{codec} is not in the build");
        }
        for codec in ["mp2", "mp3", "ac3", "wmav2", "wmapro", "flac", "opus", "vorbis", "pcm_s16le"] {
            assert!(decodable_audio(codec) && enabled.contains(&codec), "{codec}");
        }
        for codec in ["h264", "hevc", "aac", "eac3", "dca", "truehd"] {
            assert!(!enabled.contains(&codec), "{codec} must not be decoded");
            assert!(!decodable_audio(codec) && !DECODABLE_VIDEO.contains(&codec));
        }
    }

    #[test]
    fn only_os_encoders_are_ever_named() {
        assert_eq!(Encoder::candidates(Platform::MacOs), &[Encoder::VideoToolbox]);
        assert_eq!(
            Encoder::candidates(Platform::Windows),
            &[Encoder::MediaFoundationHardware, Encoder::MediaFoundation]
        );
        assert!(Encoder::candidates(Platform::Linux).is_empty());
        assert_eq!(AudioEncoder::candidate(Platform::MacOs).map(AudioEncoder::name), Some("aac_at"));
        assert_eq!(AudioEncoder::candidate(Platform::Windows).map(AudioEncoder::name), Some("aac_mf"));
        assert_eq!(AudioEncoder::candidate(Platform::Linux), None);
    }

    #[test]
    fn extensions_route_to_the_engine_or_the_webview_and_typescript_stays_code() {
        for ext in ["wmv", "WMV", "asf", "avi", "mkv", "flv", "mpg", "mpeg", "m2ts", "mts", "3gp", "vob"] {
            assert!(is_engine_extension(ext), "{ext}");
            assert!(!is_webview_extension(ext), "{ext}");
        }
        for ext in ["mp4", "m4v", "MOV", "webm", "ogg", "ogv"] {
            assert!(is_webview_extension(ext), "{ext}");
            assert!(!is_engine_extension(ext), "{ext}");
        }
        assert!(!is_engine_extension("ts"));
        assert!(!is_engine_extension("pdf"));
    }

    #[test]
    fn output_is_capped_at_1080p_keeping_shape_and_never_enlarged() {
        assert_eq!(output_size(3840, 2160), (1920, 1080));
        assert_eq!(output_size(1920, 1200), (1728, 1080));
        assert_eq!(output_size(640, 480), (640, 480));
        assert_eq!(output_size(1440, 1080), (1440, 1080));
        assert_eq!(output_size(1081, 1081), (1080, 1080));
        assert_eq!(output_size(0, 0), (1920, 1080));
    }

    #[test]
    fn the_playlist_lists_every_segment_with_the_remainder_last() {
        let p = playlist(10.03);
        assert!(p.starts_with("#EXTM3U\n"));
        assert!(p.contains("#EXT-X-PLAYLIST-TYPE:VOD\n"));
        assert!(p.contains("#EXTINF:4.000,\n0.ts\n#EXTINF:4.000,\n1.ts\n#EXTINF:2.030,\n2.ts\n"));
        assert!(p.ends_with("#EXT-X-ENDLIST\n"));
        assert_eq!(segment_count(8.05), 2, "a sliver joins the last segment");
        assert_eq!(segment_count(8.2), 3);
        assert_eq!(segment_count(0.5), 1);
        assert_eq!(segment_count(3600.0), 900);
    }

    #[test]
    fn a_transcode_seeks_to_its_segment_stamps_the_real_time_and_uses_os_encoders() {
        let wmv = info("wmv3", None, Some("wmav2"));
        let args = transcode_args("/in.wmv", &wmv, Encoder::VideoToolbox, AudioPlan::Encode(AudioEncoder::AudioToolbox), 5);
        let joined = args.join(" ");
        let ss = args.iter().position(|a| a == "-ss").expect("-ss");
        let input = args.iter().position(|a| a == "-i").expect("-i");
        assert!(ss < input, "input seeking: -ss before -i");
        assert_eq!(args[ss + 1], "20");
        assert!(joined.contains("-output_ts_offset 20 -f mpegts pipe:1"));
        assert!(joined.contains("-force_key_frames expr:gte(t,n_forced*4)"));
        assert!(joined.contains("-g 100"), "{joined}");
        assert!(joined.contains("-c:v h264_videotoolbox"));
        assert!(joined.contains("-map 0:1 -c:a aac_at -b:a 160k"));
        assert!(!joined.contains("-hwaccel"));
        assert!(!joined.contains("-fpsmax"), "25 fps is under the cap");
        assert!(!joined.contains("-maxrate"));
        let copy = transcode_args("/in.flv", &info("vp6f", None, Some("aac")), Encoder::MediaFoundation, AudioPlan::Copy, 0).join(" ");
        assert!(
            copy.contains("-c:v h264_mf") && copy.contains("-map 0:1 -c:a copy") && !copy.contains("-ss"),
            "{copy}"
        );
        let silent = transcode_args("/in.avi", &info("mpeg4", None, Some("dts")), Encoder::VideoToolbox, AudioPlan::Drop, 0).join(" ");
        assert!(silent.contains("-an") && !silent.contains("-c:a"), "{silent}");
        let mut fast = info("wmv3", None, None);
        fast.video.as_mut().unwrap().fps = Some(120.0);
        let fast = transcode_args("/in.wmv", &fast, Encoder::VideoToolbox, AudioPlan::None, 0).join(" ");
        assert!(fast.contains("-fpsmax 60") && fast.contains("-g 240"), "{fast}");
    }

    #[test]
    fn a_remux_copies_the_picture_tags_hevc_and_reports_progress() {
        let args = remux_args(
            "/in.mkv",
            "/out.mp4",
            &info("hevc", None, Some("ac3")),
            AudioPlan::Encode(AudioEncoder::AudioToolbox),
        )
        .join(" ");
        assert!(args.contains("-progress pipe:1"));
        assert!(args.contains("-c:v copy -tag:v hvc1"));
        assert!(args.contains("-c:a aac_at"));
        assert!(args.ends_with("-f mp4 /out.mp4"));
        let copy = remux_args("/in.mkv", "/out.mp4", &info("h264", None, Some("aac")), AudioPlan::Copy).join(" ");
        assert!(copy.contains("-c:a copy") && !copy.contains("hvc1"));
        let silent = remux_args("/in.mkv", "/out.mp4", &info("h264", None, Some("ac3")), AudioPlan::Drop).join(" ");
        assert!(silent.contains("-an") && !silent.contains("-c:a"), "{silent}");
    }
}
