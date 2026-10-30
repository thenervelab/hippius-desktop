//! What the main window's capability lets the webview reach on disk.
//!
//! The fs and opener plugins are reached straight from the webview, so their
//! scopes are the whole of what a flaw in the page could read or open. They
//! stay at what the app uses: files the user picks in a dialog or drops on
//! the window (the plugins add those at runtime), the app's own folders, and
//! files opened in their app through `open_in_default_app`, which checks the
//! file is in a synced folder.

use std::path::Path;

fn read(rel: &str) -> String {
    std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join(rel)).unwrap_or_else(|e| panic!("{rel}: {e}"))
}

fn json(rel: &str) -> serde_json::Value {
    serde_json::from_str(&read(rel)).unwrap_or_else(|e| panic!("{rel}: {e}"))
}

#[test]
fn the_main_window_reads_no_static_path_under_home() {
    let text = read("capabilities/default.json");
    for broad in ["$HOME/**", "\"/**/*\"", "$HOME/**/*"] {
        assert!(!text.contains(broad), "default.json must not grant {broad}");
    }
    let capability = json("capabilities/default.json");
    for permission in capability["permissions"].as_array().expect("permissions") {
        let id = permission.as_str().or_else(|| permission["identifier"].as_str()).unwrap_or_default();
        assert_ne!(
            id, "opener:allow-open-path",
            "files open through open_in_default_app, which checks the path"
        );
        if id.starts_with("fs:") {
            assert!(
                permission.get("allow").is_none(),
                "{id} carries a static path; the plugins scope picked and dropped files themselves"
            );
        }
    }
}

#[test]
fn files_open_in_their_app_through_the_checked_command() {
    let main = read("src/main.rs");
    assert!(main.contains("open_in_default_app,"), "the command must be registered");
    let preview = read("src/media_preview.rs");
    let start = preview.find("pub async fn open_in_default_app(").expect("open_in_default_app");
    let body = &preview[start..start + preview[start..].find("\n}\n").expect("end of fn")];
    assert!(
        body.find("validate_preview_source(").expect("the path is checked") < body.find("open_path(").expect("the file is opened"),
        "the path is checked before it is opened"
    );
    for page in [
        "../app/components/page-sections/drive/file-preview/VideoPreviewBody.tsx",
        "../app/components/page-sections/drive/file-preview/PdfPreviewBody.tsx",
        "../app/components/page-sections/drive/files-table/VideoPlayerError.tsx",
    ] {
        assert!(!read(page).contains("openPath"), "{page} must open files through open_in_default_app");
    }
}

/// With `app.security.capabilities` set, a capability file it does not list
/// is never loaded: its window silently gets nothing. Every file is listed,
/// and no plugin is configured that the app does not run.
#[test]
fn every_capability_file_is_listed_and_no_dead_plugin_is_configured() {
    let conf = json("tauri.conf.json");
    let listed: Vec<&str> = conf["app"]["security"]["capabilities"]
        .as_array()
        .expect("capabilities")
        .iter()
        .filter_map(|c| c.as_str())
        .collect();
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
    for entry in std::fs::read_dir(&dir).expect("capabilities dir").flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(stem) = name.strip_suffix(".json") else { continue };
        let identifier = json(&format!("capabilities/{name}"))["identifier"].as_str().unwrap_or(stem).to_string();
        assert!(
            listed.contains(&identifier.as_str()),
            "capabilities/{name} ({identifier}) is not listed in tauri.conf.json"
        );
    }
    assert!(
        conf["plugins"].get("shell").is_none(),
        "the shell plugin is not run, so it has no settings"
    );
    assert!(!read("Cargo.toml").contains("tauri-plugin-shell"), "the shell plugin is not a dependency");
}
