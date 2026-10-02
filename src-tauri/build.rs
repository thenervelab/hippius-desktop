use std::path::Path;

fn main() {
    // The `objc` crate's `class!` and `msg_send!` macros check
    // `cfg(feature = "cargo-clippy")` internally. Register it as
    // a known cfg value so the compiler doesn't emit warnings.
    println!("cargo::rustc-check-cfg=cfg(feature, values(\"cargo-clippy\"))");

    let mut attributes = tauri_build::Attributes::new();
    if windows_msvc() {
        // tauri-build embeds its manifest as a resource on the app binary
        // only. A test binary links the same Common Controls v6 imports
        // (TaskDialogIndirect, for dialogs) without it, so Windows refuses
        // to start it: STATUS_ENTRYPOINT_NOT_FOUND before any test runs.
        // Hand the same manifest to the linker instead, which embeds it in
        // every binary, tests included, and turn tauri-build's copy off so
        // the app does not get two.
        embed_windows_manifest();
        attributes = attributes.windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    }
    if let Err(error) = tauri_build::try_build(attributes) {
        panic!("error found during tauri-build: {error:#}");
    }
}

/// Build scripts run on the host, so the target comes from Cargo's
/// variables, not `cfg!`.
fn windows_msvc() -> bool {
    let var = |name| std::env::var(name).unwrap_or_default();
    var("CARGO_CFG_TARGET_OS") == "windows" && var("CARGO_CFG_TARGET_ENV") == "msvc"
}

/// `windows-app-manifest.xml` is tauri-build's default manifest, unchanged.
fn embed_windows_manifest() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("windows-app-manifest.xml");
    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
}
