//! Source pins for the in-app install path (H-061).
//!
//! The updater is the one surface whose regressions are silent: a build that
//! cannot install its own successor reports nothing, and the fleet simply stops
//! moving. Two rules hold it together, and neither is checkable at runtime on
//! the platform that would break — a `#[cfg(target_os = "linux")]` test is green
//! on the macOS and Windows lanes, which is where a Linux-only regression would
//! be merged from. So this reads the source, like `keep_awake_wiring.rs`.
//!
//! 1. **Both install commands call `download_and_install` on every target.**
//!    `tauri-plugin-updater` installs a `.deb` with `dpkg -i` (escalating
//!    through pkexec, a graphical sudo prompt, then sudo), and every published
//!    `latest.json` carries a `linux-x86_64-deb` entry pointing at the signed
//!    package. Gating the install on `target_os = "linux"` would switch a
//!    working path off for every user who does have pkexec — and, because the
//!    manifest still advertises the build, would do it while the app keeps
//!    announcing updates it refuses to apply.
//!
//! 2. **The manual-install fallback is keyed on the BUNDLE, not the OS.**
//!    `bundle_type()` distinguishes a `.deb` from an AppImage, which
//!    `target_os` cannot. Naming the wrong artifact sends the user to a file
//!    they have no way to install.

const UPDATES_RS: &str = include_str!("../src/updates.rs");

/// Brace-matched body of the function whose signature contains `sig`.
fn fn_body<'a>(src: &'a str, sig: &str) -> &'a str {
    let sig_idx = src.find(sig).unwrap_or_else(|| panic!("`{sig}` declaration present"));
    let body_start = src[sig_idx..].find('{').expect("fn body opens") + sig_idx;

    brace_matched(&src[body_start..])
}

fn brace_matched(from_open: &str) -> &str {
    assert!(from_open.starts_with('{'), "brace_matched starts at '{{'");

    let mut depth = 0usize;
    for (i, ch) in from_open.char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return &from_open[..=i];
                }
            }
            _ => {}
        }
    }

    panic!("block never closes");
}

fn assert_installs_on_every_target(sig: &str) {
    let body = fn_body(UPDATES_RS, sig);

    assert!(body.contains("download_and_install"), "{sig} must install through the updater plugin");
    assert!(
        !body.contains("#[cfg(target_os"),
        "{sig} must not gate the install on the OS — the plugin installs a .deb via dpkg, \
         and every published latest.json carries a linux-x86_64-deb entry (H-061). \
         A per-OS refusal disables a working path and leaves the app announcing \
         updates it will not apply. Body:\n{body}"
    );
    assert!(
        !body.contains("cfg!(target_os"),
        "{sig} must not branch the install on the OS — see the comment above"
    );
}

#[test]
fn install_update_installs_on_every_target() {
    assert_installs_on_every_target("pub async fn install_update(");
}

#[test]
fn switch_release_channel_installs_on_every_target() {
    assert_installs_on_every_target("pub async fn switch_release_channel(");
}

/// The fallback copy must name the artifact the running build was PACKAGED as.
/// `target_os = "linux"` cannot tell a `.deb` from an AppImage, so a build that
/// starts shipping AppImages alongside the `.deb` would keep telling those users
/// to fetch a `.deb` they cannot install.
#[test]
fn the_manual_install_hint_is_keyed_on_the_bundle() {
    let body = fn_body(UPDATES_RS, "fn manual_install_hint(");

    assert!(
        body.contains("bundle_type()"),
        "manual_install_hint must read the bundle marker, not the OS:\n{body}"
    );
    assert!(
        !body.contains("target_os"),
        "manual_install_hint must not branch on the OS — a .deb and an AppImage are both Linux:\n{body}"
    );

    for bundle in ["BundleType::Deb", "BundleType::Rpm", "BundleType::AppImage"] {
        assert!(body.contains(bundle), "manual_install_hint must answer for {bundle}:\n{body}");
    }
}

/// A failed install is the moment the user needs a link most. Every arm of the
/// classifier ends in the manual-install hint, which carries the channel's
/// release page — dropping it is exactly the H-061 symptom, a dead end with no
/// next step.
#[test]
fn every_install_failure_carries_the_manual_hint() {
    let body = fn_body(UPDATES_RS, "fn install_failure(");

    assert!(
        body.contains("manual_install_hint(channel)"),
        "install_failure must append the manual-install hint:\n{body}"
    );
    assert!(
        body.contains("error!("),
        "install_failure must log the raw plugin error — it is the only diagnostic \
         the support bundle gets once the user-facing copy replaces it:\n{body}"
    );
}
