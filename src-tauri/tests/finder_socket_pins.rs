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
        let rule = format!("(allow {operation} (regex #\"^/.*/{escaped_suffix}$\"))");
        assert!(
            entitlements.contains(&rule),
            "macos/FinderSync.entitlements is missing the SBPL rule `{rule}`"
        );
    }
}

/// The home portion must stay home-agnostic. Anchoring it under `/Users` denies
/// every account whose real home is elsewhere (network/mobile homes, a
/// relocated `NFSHomeDirectory`, the Data-volume firmlink form) — and denies it
/// silently, since the extension still loads and only `connect(2)` fails.
#[test]
fn the_socket_rules_do_not_assume_a_home_under_users() {
    let entitlements = read("../macos/FinderSync.entitlements");
    let rules: String = entitlements.lines().filter(|line| line.contains("(allow ")).collect();

    assert!(
        !rules.contains("/Users/"),
        "the SBPL rules hardcode /Users/, which locks out accounts whose home is mounted \
         elsewhere; use the home-agnostic `^/.*/` form"
    );
}

/// The extension paints a badge only for an identifier it registered an image
/// under, and an unregistered one paints nothing without any error. So every
/// state the Rust side can send must appear in the Swift registration table,
/// keyed by the exact wire token, and that token must name a 320×320 template
/// PDF that xcodegen actually copies into the .appex.
#[test]
fn swift_registers_an_image_for_every_painted_badge_state() {
    use tauri_project_lib::finder_bridge::protocol::BadgeState;

    let swift = swift_code_only(&read("../macos/HippiusFinder/HippiusFinderSync.swift"));
    assert!(
        !swift.contains("systemSymbolName"),
        "SF Symbols carry optical padding, so stretching one into a 320×320 frame \
         still leaves a small glyph in the well; Apple wants edge-to-edge PDFs"
    );
    assert!(
        swift.contains("isTemplate = true"),
        "badge PDFs must be template images so Finder can tint them"
    );
    assert!(
        swift.contains("url(forResource: spec.id, withExtension: \"pdf\")"),
        "registerBadges must load the PDF named after the wire token"
    );

    let project = read("../macos/HippiusFinder/project.yml");
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    for state in BadgeState::PAINTED {
        let token = state.token();
        let entry = format!("(\"{token}\", ");
        assert!(
            swift.contains(&entry),
            "HippiusFinderSync.registerBadges has no image for the `{token}` badge; the app will send \
             STATUS:{token}:<path> and Finder will paint nothing"
        );

        let resource = format!("Badges/{token}.pdf");
        assert!(
            project.contains(&resource),
            "project.yml does not copy {resource} into the .appex; url(forResource:) would be nil"
        );

        let pdf = manifest.join("../macos/HippiusFinder").join(&resource);
        let bytes = std::fs::read(&pdf).unwrap_or_else(|e| panic!("read {}: {e}", pdf.display()));
        assert!(bytes.starts_with(b"%PDF"), "{} is not a PDF", pdf.display());
        assert!(
            bytes
                .windows(b"/MediaBox [0 0 320 320]".len())
                .any(|window| window == b"/MediaBox [0 0 320 320]"),
            "{} must be a 320×320 page so it fills Apple's max badge frame",
            pdf.display()
        );
    }
}

/// The pull half of the badge feed: the extension asks for a badge with the
/// same verb the Rust codec parses. A drift here is silent — the app logs
/// "dropping unparseable line" at warn and every badge stays blank.
#[test]
fn swift_asks_for_badges_with_the_verb_the_app_parses() {
    let swift = swift_code_only(&read("../macos/HippiusFinder/WireProtocol.swift"));
    assert!(
        swift.contains("\"BADGE_QUERY:"),
        "WireProtocol.badgeQueryLine must emit the BADGE_QUERY verb that finder_bridge::protocol parses"
    );
    let sync = swift_code_only(&read("../macos/HippiusFinder/HippiusFinderSync.swift"));
    assert!(
        sync.contains("badgeQueryLine(for:"),
        "requestBadgeIdentifier no longer asks the app for a badge it does not hold; only pushed \
         badges would ever paint"
    );
}

/// Apple: the initial badge is set FROM requestBadgeIdentifier before that
/// call returns. An async hop plus a miss that never plants even `""` leaves
/// Finder with nothing, and it will not re-ask for items still on screen.
#[test]
fn swift_plants_the_initial_badge_before_request_returns() {
    let sync = swift_code_only(&read("../macos/HippiusFinder/HippiusFinderSync.swift"));
    assert!(
        sync.contains("func requestBadgeIdentifier(for url: URL)"),
        "requestBadgeIdentifier must still be the Finder entry point"
    );
    assert!(
        !sync.contains("DispatchQueue.main.async { self.applyBadgeRequest"),
        "requestBadgeIdentifier must not hop async before planting a badge"
    );
    assert!(
        sync.contains("setBadgeIdentifier(\"\", for: url)"),
        "a cache miss must plant an empty identifier so later STATUS is an update"
    );
    assert!(
        sync.contains("func beginObservingDirectory(at url: URL)") && sync.contains("func endObservingDirectory(at url: URL)"),
        "begin/endObservingDirectory are Apple's visible-set; without them a closed \
         Finder window keeps URLs in the cache forever"
    );
}

/// Clearing the Swift dict does not clear Finder's paint. Socket drop and
/// unregister must call setBadgeIdentifier(\"\") for every URL they drop.
#[test]
fn swift_clears_finder_paint_when_the_cache_drops() {
    let sync = swift_code_only(&read("../macos/HippiusFinder/HippiusFinderSync.swift"));
    assert!(
        sync.contains("func forgetBadgePaint()"),
        "socket drop must go through forgetBadgePaint so Finder's overlay is cleared"
    );
    let forget_at = sync.find("func forgetBadgePaint()").expect("forgetBadgePaint");
    let forget = &sync[forget_at..];
    assert!(
        forget.contains("setBadgeIdentifier(\"\", for: url)"),
        "forgetBadgePaint must plant empty identifiers, not only drop the dictionary"
    );
}

/// Plan-ready is one REFRESH_ROOT, not a bulk STATUS push. The Swift codec
/// must parse the same verb the Rust side emits.
#[test]
fn swift_parses_the_refresh_root_verb() {
    let swift = swift_code_only(&read("../macos/HippiusFinder/WireProtocol.swift"));
    assert!(
        swift.contains("\"REFRESH_ROOT\""),
        "WireProtocol.parse must accept REFRESH_ROOT so a plan start re-queries visible items"
    );
    let sync = swift_code_only(&read("../macos/HippiusFinder/HippiusFinderSync.swift"));
    assert!(
        sync.contains("requeryDisplayed(under:"),
        "REFRESH_ROOT / REGISTER_PATH must re-query already-displayed URLs; Finder will not \
         call requestBadgeIdentifier again for items still on screen"
    );
}

/// SHARE is spawned (network). BADGE_QUERY is answered on the drain loop so
/// a Finder scroll cannot start unbounded tasks.
#[test]
fn badge_queries_are_serialized_on_the_drain_loop() {
    let src = read("src/finder_bridge/lifecycle.rs");
    assert!(
        src.contains("ClientMessage::BadgeQuery(_) => false"),
        "BadgeQuery must be the serial arm of the drain loop"
    );
    assert!(
        src.contains("ClientMessage::Share(_) => true"),
        "Share must still spawn so a click cannot stall behind queries"
    );
    let serial = src.split("} else {").nth(1).expect("serial else arm");
    let serial_body = serial.split("info!").next().expect("else body");
    assert!(!serial_body.contains("spawn"), "the BadgeQuery else arm must not spawn");
}
