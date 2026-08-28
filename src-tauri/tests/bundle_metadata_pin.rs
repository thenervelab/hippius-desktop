//! Static guard: the macOS bundle must not hardcode its own version.
//!
//! `src-tauri/Info.plist` is merged OVER Tauri's generated Info.plist, so any
//! version key here overrides `version` in `tauri.conf.json`. A stale
//! `CFBundleShortVersionString` of `0.0.1` sat in that file from the pre-1.0
//! era and shipped in every release while the project was on 0.3.4 — including
//! signed, notarized production builds.
//!
//! Nothing malfunctions as a result, which is exactly why it survived: the cost
//! is that no installed build can report which build it is. Diagnosing a
//! missing Finder extension in August 2026 meant four rounds of guessing,
//! because a developer's Mac and a colleague's Mac both answered `0.0.1` to
//! `CFBundleShortVersionString` and there was no way to tell a months-old DMG
//! from that morning's.
//!
//! A unit test cannot catch this (the plist is build input, not code) and CI
//! does not install the artifact, so pin the file itself.

/// The key Tauri must be left to generate from `tauri.conf.json`.
///
/// `CFBundleVersion` is deliberately NOT in this list. Tauri would generate it
/// from the same `version` string (a dotted release version), and macOS orders
/// CFBundleVersion component-wise, so any `0.x` sorts BELOW the `1` every
/// shipped build carries —
/// an in-place upgrade would lower the bundle version, which Apple requires to
/// increase monotonically and which LaunchServices/pkd consult when arbitrating
/// duplicate registrations of one bundle id. See the comment in Info.plist.
const GENERATED_VERSION_KEYS: [&str; 1] = ["CFBundleShortVersionString"];

fn info_plist() -> String {
    std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/Info.plist")).expect("read src-tauri/Info.plist")
}

/// Comments mentioning a key are fine — an actual `<key>` element is not.
fn declares_key(plist: &str, key: &str) -> bool {
    plist.contains(&format!("<key>{key}</key>"))
}

#[test]
fn info_plist_does_not_hardcode_a_version() {
    let plist = info_plist();

    for key in GENERATED_VERSION_KEYS {
        assert!(
            !declares_key(&plist, key),
            "src-tauri/Info.plist declares <key>{key}</key>, which overrides the version from \
             tauri.conf.json and makes every build misreport itself. Delete the key and let \
             Tauri generate it."
        );
    }
}

/// The guard above is only meaningful while `tauri.conf.json` actually carries a
/// version for Tauri to generate FROM. Without this, deleting that field would
/// leave both files silent and the bundle would fall back to a default.
#[test]
fn tauri_config_carries_the_version() {
    let config: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tauri.conf.json")).expect("read tauri.conf.json"))
            .expect("tauri.conf.json parses");

    let version = config
        .get("version")
        .and_then(|v| v.as_str())
        .expect("tauri.conf.json has a top-level string `version`");

    assert!(
        version.split('.').count() >= 2,
        "`version` should look like a release version, got {version:?}"
    );
    assert_ne!(
        version, "0.0.1",
        "`version` is still the pre-1.0 placeholder that caused this pin to exist"
    );
}

/// The counterpart guard: `CFBundleVersion` must KEEP its explicit value, so a
/// later cleanup does not "finish the job" by deleting it and silently move
/// every install's bundle version from `1` down to the dotted release version.
#[test]
fn info_plist_still_pins_cf_bundle_version() {
    assert!(
        declares_key(&info_plist(), "CFBundleVersion"),
        "src-tauri/Info.plist must keep an explicit <key>CFBundleVersion</key>: letting Tauri \
         generate it from tauri.conf.json's `version` would sort BELOW the `1` every shipped \
         build carries, lowering the bundle version on upgrade. See the comment in that file."
    );
}
