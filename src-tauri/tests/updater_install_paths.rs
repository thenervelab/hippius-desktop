//! Source pins for the in-app install path.
//!
//! The updater is the one surface whose regressions are silent: a build that
//! cannot install its own successor reports nothing, and the fleet simply stops
//! moving. Neither rule is checkable at runtime on the platform that would
//! break — a `#[cfg(target_os = "linux")]` test is green on the macOS and
//! Windows lanes, which is where a Linux-only regression would be merged from.
//! So this reads the source, like `keep_awake_wiring.rs`.
//!
//! 1. **Deb/Rpm refuse before `download_and_install`.** plugin-updater applies
//!    a `.deb` with `dpkg -i` behind pkexec; QA on amd64 got `Permission
//!    denied (os error 13)` instead of a prompt. `refuse_if_privileged_package`
//!    must run first so Install never fetches a payload it cannot apply. Gating
//!    the whole command on `target_os = "linux"` would also disable AppImage,
//!    which still self-updates.
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

fn assert_refuses_privileged_packages_before_install(sig: &str) {
    let body = fn_body(UPDATES_RS, sig);

    assert!(
        body.contains("refuse_if_privileged_package"),
        "{sig} must refuse Deb/Rpm before calling the plugin:\n{body}"
    );
    assert!(
        body.contains("download_and_install"),
        "{sig} must still install through the updater plugin when the bundle supports it:\n{body}"
    );

    let refuse = body.find("refuse_if_privileged_package").expect("refuse marker");
    let install = body.find("download_and_install").expect("install marker");
    assert!(
        refuse < install,
        "{sig} must refuse privileged packages BEFORE download_and_install. Body:\n{body}"
    );

    assert!(
        !body.contains("#[cfg(target_os"),
        "{sig} must not gate the install on the OS — AppImage still self-updates, \
         and a per-OS refusal would disable it. Body:\n{body}"
    );
    assert!(
        !body.contains("cfg!(target_os"),
        "{sig} must not branch the install on the OS — see the comment above"
    );
}

#[test]
fn install_update_refuses_privileged_packages_before_install() {
    assert_refuses_privileged_packages_before_install("pub async fn install_update(");
}

#[test]
fn switch_release_channel_refuses_privileged_packages_before_install() {
    assert_refuses_privileged_packages_before_install("pub async fn switch_release_channel(");
}

/// The copy must name the artifact the running build was PACKAGED as, because
/// `target_os = "linux"` cannot tell a `.deb` from an AppImage — a build that
/// starts shipping AppImages alongside the `.deb` must not keep telling those
/// users to fetch a `.deb` they cannot install.
///
/// The OS is consulted ONLY where the marker is absent. tauri-bundler does not
/// patch it into the `.deb`, so `None` on Linux is the shipped package rather
/// than a dev build, and the generic "download the installer" names a file the
/// release page does not carry. Every known bundle must therefore be answered
/// BEFORE the OS fallback is reached.
#[test]
fn the_manual_install_hint_is_keyed_on_the_bundle() {
    let body = fn_body(UPDATES_RS, "fn manual_install_hint_on(");

    for bundle in ["BundleType::Deb", "BundleType::Rpm", "BundleType::AppImage"] {
        assert!(body.contains(bundle), "manual_install_hint must answer for {bundle}:\n{body}");
    }

    let last_bundle_arm = ["BundleType::Deb", "BundleType::Rpm", "BundleType::AppImage"]
        .iter()
        .map(|bundle| body.find(bundle).expect("arm asserted above"))
        .max()
        .expect("three arms");
    let os_fallback = body
        .find("on_linux")
        .expect("the unknown-bundle arm must fall back to the OS, or a shipped .deb gets generic copy");

    assert!(
        os_fallback > last_bundle_arm,
        "the OS may only break the tie for an UNKNOWN bundle; a known .deb/AppImage must be \
         answered by its marker first:\n{body}"
    );

    assert!(
        fn_body(UPDATES_RS, "fn manual_install_hint(").contains("bundle_type()"),
        "manual_install_hint must still read the bundle marker"
    );
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
