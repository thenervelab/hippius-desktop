//! Source pins for the file viewer's video stream (`src/video_stream.rs`).
//!
//! Each of these fails silently: a CSP without the loopback origin leaves
//! every Linux video on a black frame with no error; an unregistered command
//! fails only when a video is opened; a stream that outlives logout keeps
//! serving the previous account's files.

fn read(rel: &str) -> String {
    std::fs::read_to_string(format!("{}/{rel}", env!("CARGO_MANIFEST_DIR"))).unwrap_or_else(|e| panic!("read {rel}: {e}"))
}

fn fn_body(src: &str, sig: &str) -> String {
    let sig_idx = src.find(sig).unwrap_or_else(|| panic!("signature not found: {sig}"));
    let body_start = src[sig_idx..].find('{').expect("fn body opens") + sig_idx;
    let mut depth = 0usize;
    for (i, ch) in src[body_start..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return src[body_start..=body_start + i].to_string();
                }
            }
            _ => {}
        }
    }
    panic!("fn body never closes: {sig}");
}

fn csp_directive(name: &str) -> String {
    let conf: serde_json::Value = serde_json::from_str(&read("tauri.conf.json")).expect("tauri.conf.json parses");
    let csp = conf["app"]["security"]["csp"].as_str().expect("a CSP string");
    csp.split(';')
        .map(str::trim)
        .find(|d| d.starts_with(&format!("{name} ")))
        .unwrap_or_else(|| panic!("CSP has no {name}"))
        .to_string()
}

/// The webview may load media from the loopback stream, and only media: no
/// fetch, frame or image can reach it.
#[test]
fn the_csp_lets_media_and_only_media_reach_the_loopback_stream() {
    assert!(
        csp_directive("media-src").split_whitespace().any(|s| s == "http://127.0.0.1:*"),
        "media-src must allow http://127.0.0.1:* (the port is the OS's pick)"
    );
    for other in ["connect-src", "frame-src", "img-src", "default-src"] {
        assert!(!csp_directive(other).contains("127.0.0.1"), "{other} must not reach the loopback stream");
    }
}

#[test]
fn both_commands_are_registered() {
    let main = read("src/main.rs");
    assert!(main.contains("crate::video_stream::video_playback_source,"));
    assert!(main.contains("crate::video_stream::video_stream_release,"));
    assert!(main.contains("pub mod video_stream;") && read("src/lib.rs").contains("pub mod video_stream;"));
}

/// Loopback only, the viewer's gate, the main window only.
#[test]
fn the_stream_is_loopback_gated_and_main_window_only() {
    let src = read("src/video_stream.rs");
    assert!(src.contains("TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))"));
    let command = fn_body(&src, "pub async fn video_playback_source(");
    assert!(command.contains("webview.label() != MAIN_WINDOW"));
    assert!(command.contains("crate::media_preview::validate_preview_source(&state"));
    let gate = command.find("validate_preview_source").unwrap();
    let mint = command.find("url_for(").unwrap();
    assert!(gate < mint, "the gate runs before a token is minted");
    assert!(!src.contains("ACCESS_CONTROL_ALLOW_ORIGIN"), "no CORS headers");
}

#[test]
fn logout_stops_the_stream() {
    let src = read("src/auth/logout.rs");
    assert!(fn_body(&src, "pub async fn logout_full(").contains("state.video_stream.stop().await"));
}

/// The viewer asks Rust and gives the token back; it never builds a stream
/// URL or decides support itself.
#[test]
fn the_viewer_asks_rust_how_to_play() {
    let body = read("../app/components/page-sections/drive/file-preview/VideoPreviewBody.tsx");
    assert!(body.contains(r#"invoke<VideoPlayback>("video_playback_source", { sourcePath: localPath })"#));
    assert!(body.contains(r#"invoke("video_stream_release", { url: streamUrl })"#));
    assert!(!body.contains("127.0.0.1"));
    assert!(!body.contains("supportsInAppVideo"));
}
