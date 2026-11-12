//! Source pins for the video preview engine (`src/video_engine/`).
//!
//! Each of these fails silently: an unregistered command fails only when a
//! WMV is opened; a preview that outlives logout or quit keeps an engine
//! converting; a release that forgets the bundle config ships without the
//! engine and quietly previews nothing new; an extension Rust converts that
//! the viewer does not list is never opened at all.

fn read(rel: &str) -> String {
    std::fs::read_to_string(format!("{}/{rel}", env!("CARGO_MANIFEST_DIR"))).unwrap_or_else(|e| panic!("read {rel}: {e}"))
}

#[test]
fn the_commands_are_registered() {
    let main = read("src/main.rs");
    for command in ["video_preview_open", "video_preview_close", "video_preview_segment"] {
        assert!(main.contains(&format!("crate::video_engine::{command},")), "{command} is not registered");
    }
    assert!(main.contains("pub mod video_engine;") && read("src/lib.rs").contains("pub mod video_engine;"));
}

#[test]
fn logout_quit_and_launch_clean_up_every_preview() {
    assert!(read("src/auth/logout.rs").contains("state.video_engine.close_all();"));
    let main = read("src/main.rs");
    let exit = main.find("tauri::RunEvent::Exit =>").expect("an Exit arm");
    assert!(
        main[exit..exit + 600].contains("state.video_engine.close_all();"),
        "quit stops the engines"
    );
    assert!(main.contains("crate::video_engine::sweep_converted_at_launch"), "launch sweeps leftovers");
}

/// Converted copies are plaintext video: only under the private preview
/// cache, which is the one place the asset protocol may serve from.
#[test]
fn converted_copies_live_in_the_private_preview_cache() {
    let remux = read("src/video_engine/remux.rs");
    assert!(remux.contains(".join(\".hippius\")\n        .join(\"preview-cache\")\n        .join(\"converted\")"));
    assert!(remux.contains("from_mode(0o700)"));
    let conf: serde_json::Value = serde_json::from_str(&read("tauri.conf.json")).unwrap();
    let scope = conf["app"]["security"]["assetProtocol"]["scope"].as_array().unwrap();
    assert!(scope.iter().any(|s| s == "$HOME/.hippius/preview-cache/**"));
}

/// A stream's segments travel over IPC: nothing new reaches the network
/// policy, and the loopback server keeps serving media only.
#[test]
fn streams_need_no_csp_or_cors_change() {
    let conf: serde_json::Value = serde_json::from_str(&read("tauri.conf.json")).unwrap();
    let csp = conf["app"]["security"]["csp"].as_str().unwrap();
    assert!(!csp.contains("hippius-video"), "the stream scheme is never fetched by the webview");
    let connect = csp.split(';').map(str::trim).find(|d| d.starts_with("connect-src ")).unwrap();
    assert!(!connect.contains("127.0.0.1"));
}

/// The bundle config that ships the engine names the binary the app looks
/// for, beside its own.
#[test]
fn the_bundle_config_ships_the_engine_the_app_looks_for() {
    let conf: serde_json::Value = serde_json::from_str(&read("tauri.video-engine.conf.json")).unwrap();
    let bins = conf["bundle"]["externalBin"].as_array().expect("externalBin");
    assert_eq!(bins.len(), 1);
    assert_eq!(bins[0], "binaries/hippius-ffmpeg");
    assert_eq!(
        tauri_project_lib::video_engine::engine::binary_name(),
        format!("hippius-ffmpeg{}", std::env::consts::EXE_SUFFIX)
    );
}

/// Every extension Rust previews is one the viewer opens.
#[test]
fn the_viewer_lists_every_extension_rust_previews() {
    use tauri_project_lib::video_engine::plan::{ENGINE_EXTENSIONS, WEBVIEW_EXTENSIONS};
    let list = read("../app/lib/constants/supportedFileTypes.ts");
    for ext in ENGINE_EXTENSIONS.iter().chain(WEBVIEW_EXTENSIONS) {
        assert!(list.contains(&format!("\"{ext}\"")), "{ext} is missing from SUPPORTED_VIDEO_FORMATS");
    }
    assert!(!list.contains("\"ts\""), ".ts stays TypeScript");
}

/// The engine is LGPL and patent-minimal, and stays that way: no GPL,
/// nonfree or version-3 code; no decoder for H.264, HEVC, AAC or the other
/// pooled codecs; no encoder but the operating system's; no OpenH264.
#[test]
fn the_engine_build_stays_lgpl_and_patent_minimal() {
    let script = read("../scripts/video-engine/build-ffmpeg.sh");
    let code: Vec<&str> = script.lines().filter(|l| !l.trim_start().starts_with('#')).collect();
    for flag in [
        "--enable-gpl",
        "--enable-nonfree",
        "--enable-version3",
        "openh264",
        "libx264",
        "libx265",
        "libfdk",
    ] {
        let used = code.iter().any(|l| l.contains(flag) && !l.contains("grep"));
        assert!(!used, "{flag} in the engine build");
    }
    assert!(script.contains("--disable-everything"));
    assert!(script.contains("FFMPEG_SHA256="), "the source is pinned by checksum");
    let list = |prefix: &str| -> Vec<String> {
        code.iter()
            .flat_map(|l| l.split_whitespace())
            .filter_map(|w| w.trim_end_matches(')').strip_prefix(prefix))
            .flat_map(|v| v.split(','))
            .map(str::to_string)
            .collect()
    };
    let decoders = list("--enable-decoder=");
    assert!(decoders.iter().any(|d| d == "wmv3") && decoders.iter().any(|d| d == "vc1"));
    for banned in [
        "h264", "hevc", "svq3", "prores", "aac", "aac_latm", "eac3", "dca", "truehd", "mlp", "amrnb", "amrwb", "wmavoice",
    ] {
        assert!(!decoders.iter().any(|d| d == banned), "decoder {banned} in the engine build");
    }
    let encoders = list("--enable-encoder=");
    for encoder in &encoders {
        assert!(
            ["wrapped_avframe", "pcm_s16le", "h264_videotoolbox", "aac_at", "h264_mf", "aac_mf"].contains(&encoder.as_str()),
            "encoder {encoder} is not the OS's"
        );
    }
    let hwaccels = list("--enable-hwaccel=");
    assert!(hwaccels.iter().all(|h| !h.starts_with("h264") && !h.starts_with("hevc")), "{hwaccels:?}");
}

/// Every release lane builds the engine, bundles it, and attaches the exact
/// source and configuration it was built from (the LGPL's corresponding
/// source) to the release.
#[test]
fn every_release_lane_ships_the_engine_with_its_source() {
    for lane in ["tauri-staging.yml", "tauri-beta.yml", "tauri-build.yml"] {
        let text = read(&format!("../.github/workflows/{lane}"));
        assert_eq!(
            text.matches("scripts/video-engine/build-ffmpeg.sh").count(),
            3,
            "{lane}: one engine build per OS job (macOS, Linux, Windows)"
        );
        assert!(text.contains("build-ffmpeg.sh --universal"), "{lane}: the macOS engine is universal");
        assert_eq!(
            text.matches("--config src-tauri/tauri.video-engine.conf.json").count(),
            if lane == "tauri-staging.yml" { 4 } else { 3 },
            "{lane}: every Tauri build bundles it"
        );
        assert!(
            text.contains("scripts/video-engine/attach-source.sh"),
            "{lane}: the source goes up with the release"
        );
    }
    let attach = read("../scripts/video-engine/attach-source.sh");
    assert!(attach.contains("ffmpeg-${FFMPEG_VERSION}.tar.xz") || attach.contains("ffmpeg-*.tar.xz"));
    assert!(attach.contains("build-ffmpeg.sh") && attach.contains("buildconf"));
}

/// The app names ffmpeg and its licence, links the exact source, and ships
/// the notice and the licence text inside every install.
#[test]
fn the_notices_name_ffmpeg_its_licence_and_its_source() {
    let notices = read("THIRD_PARTY_NOTICES.md");
    let script = read("../scripts/video-engine/build-ffmpeg.sh");
    let version = script
        .lines()
        .find_map(|l| l.strip_prefix("FFMPEG_VERSION=\"").map(|v| v.trim_end_matches('"').to_string()))
        .expect("FFMPEG_VERSION");
    assert!(notices.contains("FFmpeg") && notices.contains("LGPL"), "names ffmpeg and its licence");
    assert!(
        notices.contains(&format!("https://ffmpeg.org/releases/ffmpeg-{version}.tar.xz")),
        "links the exact source"
    );
    assert!(read("licenses/LGPL-2.1.txt").contains("GNU LESSER GENERAL PUBLIC LICENSE"));
    let conf: serde_json::Value = serde_json::from_str(&read("tauri.conf.json")).unwrap();
    let resources: Vec<&str> = conf["bundle"]["resources"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|v| v.as_str())
        .collect();
    assert!(
        resources.contains(&"THIRD_PARTY_NOTICES.md") && resources.contains(&"licenses/*"),
        "{resources:?}"
    );
}
