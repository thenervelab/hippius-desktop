//! Static guards for the macOS Finder-bridge socket location.
//!
//! The bridge socket used to live in the App Group container
//! (`~/Library/Group Containers/V28B5X732P.com.hippius.shared/finder.sock`).
//! That is the documented way for two SANDBOXED peers to share state, but this
//! app is non-sandboxed on purpose — `pluginkit(8)` calls fail from inside a
//! sandbox — and since macOS 15 a non-sandboxed process touching that tree is
//! gated by `kTCCServiceSystemPolicyAppData`. Every launch raised "Hippius would
//! like to access data from other apps", and tccd wrote a fresh grant each time
//! rather than matching the previous one, so answering Allow never ended it.
//! There is no entitlement that opts out of the service.
//!
//! The socket therefore lives in the app's own `~/.hippius/`, reached from
//! inside the extension's sandbox by SBPL exceptions. Four files have to agree
//! on that and nothing at build time checks them against each other: Rust
//! resolves the path, Swift resolves it independently, and two entitlements
//! files decide whether either process may touch it. A drift is silent — the
//! extension loads, and every right-click just falls back to "Open Hippius to
//! share" — so pin the files themselves.

/// Path segments the Rust side is expected to build the socket path from.
const RUST_DIR_CONST: &str = r#"const HIPPIUS_DIR: &str = ".hippius";"#;
const RUST_FILE_CONST: &str = r#"const SOCKET_FILE: &str = "finder.sock";"#;

/// The tail every side must agree on, derived from the two consts above.
const SOCKET_SUFFIX: &str = ".hippius/finder.sock";

/// The entitlement whose return would reintroduce the per-launch TCC prompt.
const APP_GROUP_KEY: &str = "com.apple.security.application-groups";

fn read(relative: &str) -> String {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(relative);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

/// A `<key>` element, not a mention in a comment — the comments in both
/// entitlements files name the app group deliberately, to explain its absence.
fn declares_key(plist: &str, key: &str) -> bool {
    plist.contains(&format!("<key>{key}</key>"))
}

/// Swift source with `//` comment lines dropped, for the same reason: the
/// extension documents why it does NOT use a container, and that explanation is
/// the part most worth keeping. Only line comments appear in this file.
fn swift_code_only(source: &str) -> String {
    source
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn rust_builds_the_socket_path_from_the_pinned_segments() {
    let source = read("src/finder_bridge/endpoint.rs");

    for expected in [RUST_DIR_CONST, RUST_FILE_CONST] {
        assert!(
            source.contains(expected),
            "finder_bridge/endpoint.rs no longer declares `{expected}`. The Swift extension \
             resolves the socket path independently, so changing it here alone silently breaks \
             every right-click share."
        );
    }
}

#[test]
fn swift_resolves_the_same_socket_path() {
    let swift = read("../macos/HippiusFinder/HippiusFinderSync.swift");

    assert!(
        swift.contains(&format!("\"/{SOCKET_SUFFIX}\"")),
        "HippiusFinderSync.socketPath() must resolve `~/{SOCKET_SUFFIX}` to match \
         finder_bridge::endpoint::resolve"
    );
    let code = swift_code_only(&swift);
    assert!(
        !code.contains("Group Containers") && !code.contains("forSecurityApplicationGroupIdentifier"),
        "the Finder extension is reaching for an App Group container again; that path costs a TCC \
         consent prompt on every launch of the non-sandboxed app"
    );
}

#[test]
fn neither_bundle_claims_an_app_group() {
    for (label, relative) in [
        ("the app", "entitlements.plist"),
        ("the Finder extension", "../macos/FinderSync.entitlements"),
    ] {
        assert!(
            !declares_key(&read(relative), APP_GROUP_KEY),
            "{label} declares <key>{APP_GROUP_KEY}</key> again. The app group is what put the \
             bridge socket under ~/Library/Group Containers/, which raised a \"would like to \
             access data from other apps\" prompt on EVERY launch. See this file's module docs."
        );
    }
}

/// Without both rules the extension loads and looks healthy, then fails every
/// share click: a Unix-domain socket needs the file node AND the socket
/// operation, and Apple's `temporary-exception.files.*` keys cover regular
/// files but not sockets — which is why both are expressed in SBPL.
#[test]
fn the_extension_can_reach_the_socket_from_its_sandbox() {
    let entitlements = read("../macos/FinderSync.entitlements");

    assert!(
        declares_key(&entitlements, "com.apple.security.app-sandbox"),
        "an app extension that is not sandboxed is one macOS refuses to load"
    );
    assert!(
        declares_key(&entitlements, "com.apple.security.temporary-exception.sbpl"),
        "the extension has no sandbox exception for the bridge socket, so it can never connect"
    );

    let escaped_suffix = SOCKET_SUFFIX.replace('.', r"\.");
    for operation in ["file-read* file-write*", "network-outbound"] {
        let rule = format!("(allow {operation} (regex #\"^/Users/[^/]+/{escaped_suffix}$\"))");
        assert!(
            entitlements.contains(&rule),
            "macos/FinderSync.entitlements is missing the SBPL rule `{rule}`"
        );
    }
}
