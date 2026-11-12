//! What to do with a video the webview cannot play, and the engine command
//! lines that do it. Pure: every decision here is unit-tested on every OS.
//!
//! - **Remux** when the picture is already something the webview decodes
//!   (H.264 8-bit 4:2:0 everywhere; HEVC on macOS, whose WebKit plays it):
//!   the video is copied untouched into an MP4, the audio copied when the
//!   webview plays it (AAC, MP3) or re-encoded to AAC (AC-3, DTS, WMA, ...),
//!   which costs almost nothing. Lossless and as fast as the disk.
//! - **Transcode** everything else (WMV, VC-1, MPEG-2, MPEG-4 Part 2,
//!   10-bit H.264, ...) to H.264 + AAC, a few seconds at a time, as the
//!   player asks for them (`session.rs`).

use std::fmt::Write as _;

use super::probe::MediaInfo;

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

/// What happens to the audio in a remux.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioPlan {
    Copy,
    Encode,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Remux {
        audio: AudioPlan,
    },
    Transcode,
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

/// Decide for `info` on `platform`.
#[must_use]
pub fn decide(info: &MediaInfo, platform: Platform) -> Decision {
    let Some(video) = &info.video else {
        return Decision::Unsupported("no video stream");
    };
    let pix = video.pix_fmt.as_deref().unwrap_or("");
    let eight_bit_420 = matches!(pix, "yuv420p" | "yuvj420p" | "nv12");
    // 4K is the most any of the three webviews decodes reliably.
    let fits = video.width > 0 && video.height > 0 && video.width <= 4096 && video.height <= 4096;
    let video_plays = match video.codec.as_str() {
        "h264" => eight_bit_420 && fits,
        // WebKit on macOS decodes HEVC (with the `hvc1` tag the remux
        // writes); Windows needs a paid Store extension, Linux a plugin.
        "hevc" => platform == Platform::MacOs && (eight_bit_420 || pix == "yuv420p10le") && fits,
        _ => false,
    };
    if video_plays {
        let audio = match info.audio.as_ref().map(|a| a.codec.as_str()) {
            None => AudioPlan::None,
            Some("aac" | "mp3") => AudioPlan::Copy,
            Some(_) => AudioPlan::Encode,
        };
        return Decision::Remux { audio };
    }
    // A transcode is a VOD playlist cut from the duration up front.
    if info.duration.is_none() {
        return Decision::Unsupported("unknown duration");
    }
    Decision::Transcode
}

/// The H.264 encoder a transcode uses, picked once per launch by a test
/// encode (`engine.rs`), best first.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Encoder {
    /// macOS VideoToolbox (hardware; `allow_sw` covers a Mac without it).
    VideoToolbox,
    /// Windows Media Foundation through a hardware encoder (Intel, AMD, NVIDIA).
    MediaFoundationHardware,
    /// Windows Media Foundation's own software encoder.
    MediaFoundation,
    /// Cisco OpenH264, software, built into the Linux and Windows engines.
    OpenH264,
}

impl Encoder {
    /// Candidates for `platform`, best first.
    #[must_use]
    pub fn candidates(platform: Platform) -> &'static [Self] {
        match platform {
            Platform::MacOs => &[Self::VideoToolbox],
            Platform::Windows => &[Self::MediaFoundationHardware, Self::MediaFoundation, Self::OpenH264],
            Platform::Linux => &[Self::OpenH264],
        }
    }

    /// The engine's encoder name, as `-encoders` lists it.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::VideoToolbox => "h264_videotoolbox",
            Self::MediaFoundationHardware | Self::MediaFoundation => "h264_mf",
            Self::OpenH264 => "libopenh264",
        }
    }

    /// `-c:v ...` and the options that make it a preview: a bitrate for the
    /// output size, no B-frames (simple timestamps across restarts) and
    /// speed over quality where the encoder offers the choice.
    #[must_use]
    pub fn args(self, bitrate_kbps: u32) -> Vec<String> {
        let rate = format!("{bitrate_kbps}k");
        let maxrate = format!("{}k", bitrate_kbps * 3 / 2);
        let mut out: Vec<String> = vec!["-c:v".into(), self.name().into(), "-b:v".into(), rate, "-maxrate".into(), maxrate];
        let extra: &[&str] = match self {
            Self::VideoToolbox => &["-allow_sw", "1", "-prio_speed", "1", "-profile:v", "high", "-bf", "0"],
            Self::MediaFoundationHardware => &["-hw_encoding", "1", "-scenario", "display_remoting", "-bf", "0"],
            Self::MediaFoundation => &["-scenario", "display_remoting", "-bf", "0"],
            Self::OpenH264 => &["-allow_skip_frames", "0"],
        };
        out.extend(extra.iter().map(|s| (*s).to_string()));
        out
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

/// The engine command line for a transcode starting at segment `start_index`,
/// writing MPEG-TS to stdout. Keyframes are forced on every segment boundary
/// so `segmenter.rs` can cut there, and timestamps carry the real position
/// (`-output_ts_offset`) so segments from different runs line up.
#[must_use]
pub fn transcode_args(input: &str, info: &MediaInfo, encoder: Encoder, start_index: u32) -> Vec<String> {
    let video = info.video.as_ref();
    let (_, out_h) = video.map_or((MAX_WIDTH, MAX_HEIGHT), |v| output_size(v.width, v.height));
    let fps = video
        .and_then(|v| v.fps)
        .filter(|f| f.is_finite() && *f > 0.0)
        .map_or(30.0, |f| f.min(f64::from(MAX_FPS)));
    // A GOP of one segment backs up the forced keyframes for an encoder that
    // ignores them.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let gop = ((fps * f64::from(SEGMENT_SECS)).round() as u32).max(1);
    let start = segment_start(start_index);
    let mut args: Vec<String> = ["-hide_banner", "-nostdin", "-loglevel", "error"]
        .iter()
        .map(|s| (*s).to_string())
        .collect();
    // Hardware decoding where it is cheap and the source is heavy.
    if encoder == Encoder::VideoToolbox && video.is_some_and(|v| matches!(v.codec.as_str(), "hevc" | "h264")) {
        args.extend(["-hwaccel".into(), "videotoolbox".into()]);
    }
    if start_index > 0 {
        args.extend(["-ss".into(), start.clone()]);
    }
    args.extend(["-i".into(), input.into()]);
    if let Some(v) = video {
        args.extend(["-map".into(), format!("0:{}", v.index)]);
    }
    if let Some(a) = &info.audio {
        args.extend(["-map".into(), format!("0:{}", a.index)]);
    }
    args.extend([
        "-sn".into(),
        "-dn".into(),
        "-vf".into(),
        video_filter(),
        "-fpsmax".into(),
        MAX_FPS.to_string(),
    ]);
    args.extend(encoder.args(bitrate_kbps(out_h)));
    args.extend([
        "-g".into(),
        gop.to_string(),
        "-force_key_frames".into(),
        format!("expr:gte(t,n_forced*{SEGMENT_SECS})"),
    ]);
    if info.audio.is_some() {
        args.extend(
            ["-c:a", "aac", "-b:a", "160k", "-ac", "2", "-ar", "48000"]
                .iter()
                .map(|s| (*s).to_string()),
        );
    }
    args.extend(["-output_ts_offset".into(), start, "-f".into(), "mpegts".into(), "pipe:1".into()]);
    args
}

/// The engine command line for a remux into `output` (an MP4), reporting
/// progress as `key=value` lines on stdout.
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
    if let Some(a) = &info.audio {
        match audio {
            AudioPlan::Copy => args.extend(["-map".into(), format!("0:{}", a.index), "-c:a".into(), "copy".into()]),
            AudioPlan::Encode => args.extend(
                ["-map".to_string(), format!("0:{}", a.index)]
                    .into_iter()
                    .chain(["-c:a", "aac", "-b:a", "192k", "-ac", "2"].iter().map(|s| (*s).to_string())),
            ),
            AudioPlan::None => {}
        }
    }
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

    fn info(codec: &str, pix: &str, audio: Option<&str>) -> MediaInfo {
        MediaInfo {
            formats: vec!["matroska".into()],
            duration: Some(600.0),
            video: Some(VideoStream {
                index: 0,
                codec: codec.into(),
                pix_fmt: Some(pix.into()),
                width: 1920,
                height: 1080,
                fps: Some(25.0),
            }),
            audio: audio.map(|c| AudioStream { index: 1, codec: c.into() }),
        }
    }

    #[test]
    fn playable_h264_is_remuxed_and_audio_is_copied_only_when_the_webview_plays_it() {
        for platform in [Platform::MacOs, Platform::Windows, Platform::Linux] {
            assert_eq!(
                decide(&info("h264", "yuv420p", Some("aac")), platform),
                Decision::Remux { audio: AudioPlan::Copy }
            );
            assert_eq!(
                decide(&info("h264", "yuv420p", Some("mp3")), platform),
                Decision::Remux { audio: AudioPlan::Copy }
            );
            assert_eq!(
                decide(&info("h264", "yuv420p", Some("ac3")), platform),
                Decision::Remux { audio: AudioPlan::Encode }
            );
            assert_eq!(
                decide(&info("h264", "yuv420p", None), platform),
                Decision::Remux { audio: AudioPlan::None }
            );
        }
    }

    #[test]
    fn wmv_vc1_mpeg2_and_10_bit_h264_are_transcoded() {
        for codec in ["wmv3", "wmv2", "vc1", "mpeg2video", "mpeg4", "msmpeg4v3", "flv1", "vp6f"] {
            assert_eq!(
                decide(&info(codec, "yuv420p", Some("wmav2")), Platform::MacOs),
                Decision::Transcode,
                "{codec}"
            );
        }
        assert_eq!(decide(&info("h264", "yuv420p10le", None), Platform::Windows), Decision::Transcode);
        assert_eq!(decide(&info("h264", "yuv422p", None), Platform::MacOs), Decision::Transcode);
    }

    /// Only macOS's WebKit plays HEVC without extra software.
    #[test]
    fn hevc_is_remuxed_on_macos_and_transcoded_elsewhere() {
        assert_eq!(
            decide(&info("hevc", "yuv420p10le", Some("aac")), Platform::MacOs),
            Decision::Remux { audio: AudioPlan::Copy }
        );
        assert_eq!(decide(&info("hevc", "yuv420p", Some("aac")), Platform::Windows), Decision::Transcode);
        assert_eq!(decide(&info("hevc", "yuv420p", Some("aac")), Platform::Linux), Decision::Transcode);
    }

    #[test]
    fn oversized_h264_is_transcoded_down() {
        let mut big = info("h264", "yuv420p", None);
        big.video.as_mut().unwrap().width = 7680;
        big.video.as_mut().unwrap().height = 4320;
        assert_eq!(decide(&big, Platform::MacOs), Decision::Transcode);
    }

    #[test]
    fn no_video_or_no_duration_for_a_transcode_is_unsupported() {
        let mut none = info("wmv3", "yuv420p", None);
        none.video = None;
        assert!(matches!(decide(&none, Platform::MacOs), Decision::Unsupported(_)));
        let mut endless = info("wmv3", "yuv420p", None);
        endless.duration = None;
        assert!(matches!(decide(&endless, Platform::MacOs), Decision::Unsupported(_)));
        // A remux needs no duration.
        let mut copy = info("h264", "yuv420p", None);
        copy.duration = None;
        assert!(matches!(decide(&copy, Platform::Linux), Decision::Remux { .. }));
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
    fn a_transcode_seeks_to_its_segment_and_stamps_the_real_time() {
        let args = transcode_args("/in.wmv", &info("wmv3", "yuv420p", Some("wmav2")), Encoder::VideoToolbox, 5);
        let joined = args.join(" ");
        let ss = args.iter().position(|a| a == "-ss").expect("-ss");
        let input = args.iter().position(|a| a == "-i").expect("-i");
        assert!(ss < input, "input seeking: -ss before -i");
        assert_eq!(args[ss + 1], "20");
        assert!(joined.contains("-output_ts_offset 20 -f mpegts pipe:1"));
        assert!(joined.contains("-force_key_frames expr:gte(t,n_forced*4)"));
        assert!(joined.contains("-g 100"), "{joined}");
        assert!(joined.contains("-c:v h264_videotoolbox"));
        assert!(joined.contains("-c:a aac"));
        assert!(joined.contains("-map 0:0 -map 0:1"));
        assert!(!joined.contains("-hwaccel"), "VC-1/WMV are decoded in software");
        let first = transcode_args("/in.wmv", &info("h264", "yuv420p10le", None), Encoder::OpenH264, 0);
        assert!(!first.contains(&"-ss".to_string()));
        assert!(!first.contains(&"-c:a".to_string()));
    }

    #[test]
    fn a_remux_copies_video_tags_hevc_and_reports_progress() {
        let args = remux_args("/in.mkv", "/out.mp4", &info("hevc", "yuv420p", Some("ac3")), AudioPlan::Encode).join(" ");
        assert!(args.contains("-progress pipe:1"));
        assert!(args.contains("-c:v copy -tag:v hvc1"));
        assert!(args.contains("-c:a aac"));
        assert!(args.ends_with("-f mp4 /out.mp4"));
        let copy = remux_args("/in.mkv", "/out.mp4", &info("h264", "yuv420p", Some("aac")), AudioPlan::Copy).join(" ");
        assert!(copy.contains("-c:a copy") && !copy.contains("hvc1"));
    }
}
