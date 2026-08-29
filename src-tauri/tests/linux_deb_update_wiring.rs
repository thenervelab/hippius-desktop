//! Source pins for H-061: Linux cannot in-place-install a `.deb`.
//!
//! Linux ships `.deb` (`tauri.conf.json` `bundle.targets`), not AppImage.
//! Tauri's updater can only replace a self-contained image in place, so
//! `download_and_install` on Linux is a guaranteed failure that used to
//! look like a silent/opaque "update failed". Both install commands must
//! refuse on a `#[cfg(target_os = "linux")]` arm with a typed
//! `AppError::Validation` and a stable user-facing message, and must still
//! call `download_and_install` on the non-Linux path.
//!
//! This is a source pin (same pattern as `keep_awake_wiring.rs`) so it
//! fails on macOS/Windows CI too — a runtime `#[cfg(target_os = "linux")]`
//! test would be green everywhere the bug actually ships from.

const UPDATES_RS: &str = include_str!("../src/updates.rs");

/// The copy the dialog/toast must show. Rewording it is a product change
/// and must update this pin; silently dropping the instruction would
/// send Linux users back to "try again later".
const LINUX_DEB_INPLACE_UPDATE: &str = "This Linux package cannot update itself. Download the new .deb from the release page.";

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

/// The brace-matched block that follows the first `#[cfg(<predicate>)]`
/// inside `body`. Panics if the attribute is missing — that is the H-061
/// regression: Linux falls through to `download_and_install`.
fn cfg_block<'a>(body: &'a str, predicate: &str) -> &'a str {
    let attr = format!("#[cfg({predicate})]");
    let attr_idx = body
        .find(&attr)
        .unwrap_or_else(|| panic!("missing `{attr}` — Linux currently falls through to download_and_install (H-061)"));
    let after = &body[attr_idx + attr.len()..];
    let brace_rel = after
        .find('{')
        .unwrap_or_else(|| panic!("`{attr}` must open a block so the arm is pin-able"));
    brace_matched(&after[brace_rel..])
}

fn assert_linux_arm_refuses_inplace(sig: &str) {
    let body = fn_body(UPDATES_RS, sig);
    let linux = cfg_block(body, r#"target_os = "linux""#);

    assert!(
        !linux.contains("download_and_install"),
        "{sig} Linux arm must not call download_and_install — Tauri cannot apply a .deb in-place"
    );
    assert!(
        linux.contains("AppError::Validation") || linux.contains("linux_deb_inplace_update_error"),
        "{sig} Linux arm must return typed AppError::Validation so the FE matches {{kind, message}}"
    );
    assert!(
        linux.contains("LINUX_DEB_INPLACE_UPDATE") || linux.contains(LINUX_DEB_INPLACE_UPDATE),
        "{sig} Linux arm must carry the stable .deb instruction, got:\n{linux}"
    );

    let not_linux = cfg_block(body, r#"not(target_os = "linux")"#);
    assert!(
        not_linux.contains("download_and_install"),
        "{sig} macOS/Windows arm must still call download_and_install"
    );
}

#[test]
fn install_update_linux_arm_does_not_call_download_and_install() {
    assert_linux_arm_refuses_inplace("pub async fn install_update(");
}

#[test]
fn switch_release_channel_linux_arm_does_not_call_download_and_install() {
    assert_linux_arm_refuses_inplace("pub async fn switch_release_channel(");
}

/// The refusal copy is a user-facing contract. The FE surfaces
/// `err.message` from the structured `{kind, message}` payload; if this
/// string disappears from `updates.rs` the toast becomes generic again.
#[test]
fn linux_deb_inplace_message_is_stable() {
    assert!(
        UPDATES_RS.contains(LINUX_DEB_INPLACE_UPDATE),
        "updates.rs must contain the stable Linux .deb instruction"
    );
}
