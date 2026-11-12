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

/// The engine is LGPL and stays that way: the build refuses GPL, nonfree
/// and version-3 code, and the script never asks for any.
#[test]
fn the_engine_build_stays_lgpl() {
    let script = read("../scripts/video-engine/build-ffmpeg.sh");
    for flag in ["--enable-gpl", "--enable-nonfree", "--enable-version3", "libx264", "libx265", "libfdk"] {
        let used = script
            .lines()
            .filter(|l| !l.trim_start().starts_with('#'))
            .any(|l| l.contains(flag) && !l.contains("grep"));
        assert!(!used, "{flag} in the engine build");
    }
    assert!(script.contains("--disable-everything"));
    assert!(script.contains("FFMPEG_SHA256="), "the source is pinned by checksum");
}
