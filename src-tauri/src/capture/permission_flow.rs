//! Where the Screen Recording permission dialog stands, and the facts it
//! needs about how macOS keys the grant.
//!
//! macOS (TCC) keeps the grant against the app's designated requirement. For
//! an app signed with a certificate that is the bundle id plus the
//! certificate, which every rebuild shares. For an ad hoc app (a local build
//! with no signing identity, or an unsigned CI fallback) it is the build's own
//! code hash, so every rebuild is a new app to TCC: a switch turned on for the
//! previous build does nothing for this one, and the entry in System Settings
//! can show "on" while this build reads as denied. The dialog detects that
//! case (it was asked for, the user relaunched to pick the grant up, and it is
//! still denied) and offers to reset the entry.
//!
//! The recording helper needs no grant of its own. It is spawned as a plain
//! child process (`std::process::Command`, no launchd or XPC), so macOS makes
//! Hippius its responsible process and attributes its ScreenCaptureKit and
//! microphone use to Hippius. `HippiusCapture` never appears in the list.
//!
//! Which build was asked is remembered as [`CodeSignature::key`], not a bare
//! flag: a flag that outlived a rebuild or a `tccutil reset` made the button
//! open System Settings on a list without Hippius in it, where the only way
//! in was the "+" button.

use serde::Serialize;

/// The preference holding the [`CodeSignature::key`] of the build that last
/// showed macOS's prompt.
pub const ASKED_KEY: &str = "capture_screen_permission_asked_v2";
/// The preference holding the [`CodeSignature::key`] of the build that was
/// relaunched to pick the grant up. Cleared once the grant is seen.
pub const RELAUNCHED_KEY: &str = "capture_screen_permission_relaunched_v1";

/// How the running app is signed, as far as TCC cares.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodeSignature {
    /// The team of the signing certificate; `None` when signed ad hoc or not
    /// at all.
    pub team_id: Option<String>,
    /// The code directory hash, hex. What TCC keys an ad hoc app by.
    pub cdhash: Option<String>,
}

impl CodeSignature {
    /// Whether TCC will treat the next rebuild as a different app.
    #[must_use]
    pub fn is_ad_hoc(&self) -> bool {
        self.team_id.is_none()
    }

    /// A key that changes exactly when TCC would see a different app: the
    /// team for a signed build, the code hash for an ad hoc one.
    #[must_use]
    pub fn key(&self) -> String {
        match (&self.team_id, &self.cdhash) {
            (Some(team), _) => format!("team:{team}"),
            (None, Some(hash)) => format!("cdhash:{hash}"),
            (None, None) => "unsigned".to_string(),
        }
    }
}

/// This process's signature, read once per launch (it cannot change while
/// the app runs). Off macOS there is nothing to read.
#[must_use]
pub fn current_signature() -> &'static CodeSignature {
    static SIGNATURE: std::sync::OnceLock<CodeSignature> = std::sync::OnceLock::new();
    SIGNATURE.get_or_init(read_signature)
}

#[cfg(not(target_os = "macos"))]
fn read_signature() -> CodeSignature {
    CodeSignature { team_id: None, cdhash: None }
}

#[cfg(target_os = "macos")]
fn read_signature() -> CodeSignature {
    use std::ffi::{c_char, c_void};

    type CFTypeRef = *const c_void;
    /// `kSecCSSigningInformation`: include the certificate facts.
    const SIGNING_INFORMATION: u32 = 1 << 1;
    const UTF8: u32 = 0x0800_0100;

    #[link(name = "Security", kind = "framework")]
    unsafe extern "C" {
        fn SecCodeCopySelf(flags: u32, code: *mut CFTypeRef) -> i32;
        fn SecCodeCopySigningInformation(code: CFTypeRef, flags: u32, info: *mut CFTypeRef) -> i32;
        static kSecCodeInfoTeamIdentifier: CFTypeRef;
        static kSecCodeInfoUnique: CFTypeRef;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFDictionaryGetValue(dict: CFTypeRef, key: CFTypeRef) -> CFTypeRef;
        fn CFGetTypeID(cf: CFTypeRef) -> usize;
        fn CFStringGetTypeID() -> usize;
        fn CFDataGetTypeID() -> usize;
        fn CFStringGetCString(s: CFTypeRef, buf: *mut c_char, size: isize, encoding: u32) -> u8;
        fn CFDataGetLength(data: CFTypeRef) -> isize;
        fn CFDataGetBytePtr(data: CFTypeRef) -> *const u8;
        fn CFRelease(cf: CFTypeRef);
    }

    let mut signature = CodeSignature { team_id: None, cdhash: None };
    // SAFETY: Security and CoreFoundation calls on objects this function
    // owns (the two Copy results, each released once) or borrows from them
    // (dictionary values, read before the dictionary is released). Every
    // pointer is null-checked and type-checked before it is read.
    unsafe {
        let mut code: CFTypeRef = std::ptr::null();
        if SecCodeCopySelf(0, &raw mut code) != 0 || code.is_null() {
            tracing::warn!("capture: could not read this app's code signature");
            return signature;
        }
        let mut info: CFTypeRef = std::ptr::null();
        let status = SecCodeCopySigningInformation(code, SIGNING_INFORMATION, &raw mut info);
        CFRelease(code);
        if status != 0 || info.is_null() {
            tracing::warn!("capture: could not read this app's signing information ({status})");
            return signature;
        }

        let team = CFDictionaryGetValue(info, kSecCodeInfoTeamIdentifier);
        if !team.is_null() && CFGetTypeID(team) == CFStringGetTypeID() {
            let mut buf = [0 as c_char; 64];
            if CFStringGetCString(team, buf.as_mut_ptr(), buf.len() as isize, UTF8) != 0 {
                let text = std::ffi::CStr::from_ptr(buf.as_ptr()).to_string_lossy().into_owned();
                if !text.is_empty() {
                    signature.team_id = Some(text);
                }
            }
        }

        let unique = CFDictionaryGetValue(info, kSecCodeInfoUnique);
        if !unique.is_null() && CFGetTypeID(unique) == CFDataGetTypeID() {
            let len = usize::try_from(CFDataGetLength(unique)).unwrap_or(0);
            let bytes = CFDataGetBytePtr(unique);
            if len > 0 && !bytes.is_null() {
                let hash = std::slice::from_raw_parts(bytes, len);
                signature.cdhash = Some(hex::encode(hash));
            }
        }
        CFRelease(info);
    }
    signature
}

/// Where the permission stands for this build.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionState {
    /// Captures see other apps' windows.
    Granted,
    /// macOS has not been asked for this build: the button asks it, which
    /// shows the prompt and adds Hippius to the list (switched off).
    NotAsked,
    /// macOS was asked for this build: the button opens System Settings.
    Asked,
    /// The user relaunched this very build to pick the grant up and it is
    /// still denied. Either the switch is off, or System Settings shows an
    /// entry left by another build (the ad hoc case), which macOS will not
    /// apply to this one. Removing the entry and asking again fixes it.
    Stale,
}

/// Decide [`PermissionState`] from what was stored against which build.
#[must_use]
pub fn permission_state(granted: bool, asked_for: Option<&str>, relaunched_for: Option<&str>, this_build: &str) -> PermissionState {
    if granted {
        PermissionState::Granted
    } else if relaunched_for == Some(this_build) {
        PermissionState::Stale
    } else if asked_for == Some(this_build) {
        PermissionState::Asked
    } else {
        PermissionState::NotAsked
    }
}

/// A stored preference, with an empty value meaning cleared (the preference
/// table has no delete).
#[must_use]
pub fn stored(value: Option<String>) -> Option<String> {
    value.filter(|v| !v.is_empty())
}

/// The permission dialog's view of things (`capture_permission_status`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionStatus {
    pub state: PermissionState,
    /// Signed ad hoc: every rebuild needs the grant again. The dialog says
    /// so, since it is the one case where "it was on" is expected to fail.
    pub ad_hoc_signed: bool,
}

/// `tccutil` arguments that clear Hippius's own Screen Recording entry, and
/// nothing else. Needs no privileges for the calling user's own app.
#[must_use]
pub fn tccutil_reset_args(bundle_id: &str) -> [&str; 3] {
    ["reset", "ScreenCapture", bundle_id]
}

#[cfg(test)]
mod tests {
    use super::*;

    const BUILD: &str = "cdhash:aa";

    #[test]
    fn granted_wins_over_anything_stored() {
        assert_eq!(permission_state(true, None, None, BUILD), PermissionState::Granted);
        assert_eq!(permission_state(true, Some(BUILD), Some(BUILD), BUILD), PermissionState::Granted);
    }

    /// Nothing stored, or a flag left by another build (a rebuild, a flag
    /// from before the key was per build): ask macOS, which is what puts
    /// Hippius into the list.
    #[test]
    fn a_new_build_is_asked_again() {
        assert_eq!(permission_state(false, None, None, BUILD), PermissionState::NotAsked);
        assert_eq!(permission_state(false, Some("cdhash:old"), None, BUILD), PermissionState::NotAsked);
        assert_eq!(permission_state(false, Some("1"), None, BUILD), PermissionState::NotAsked);
    }

    #[test]
    fn once_asked_the_button_opens_settings() {
        assert_eq!(permission_state(false, Some(BUILD), None, BUILD), PermissionState::Asked);
        // A relaunch of an older build says nothing about this one.
        assert_eq!(permission_state(false, Some(BUILD), Some("cdhash:old"), BUILD), PermissionState::Asked);
    }

    /// Relaunched to pick the grant up and still denied: the stale entry.
    #[test]
    fn denied_after_a_relaunch_for_the_grant_is_stale() {
        assert_eq!(permission_state(false, Some(BUILD), Some(BUILD), BUILD), PermissionState::Stale);
        assert_eq!(permission_state(false, None, Some(BUILD), BUILD), PermissionState::Stale);
    }

    /// The key follows TCC: stable across rebuilds when signed, per build
    /// when ad hoc.
    #[test]
    fn the_key_changes_exactly_when_tcc_sees_a_new_app() {
        let signed = |hash: &str| CodeSignature {
            team_id: Some("TEAM1".into()),
            cdhash: Some(hash.into()),
        };
        let ad_hoc = |hash: &str| CodeSignature {
            team_id: None,
            cdhash: Some(hash.into()),
        };
        assert_eq!(signed("aa").key(), signed("bb").key());
        assert_ne!(ad_hoc("aa").key(), ad_hoc("bb").key());
        assert!(ad_hoc("aa").is_ad_hoc());
        assert!(!signed("aa").is_ad_hoc());
        assert_eq!(CodeSignature { team_id: None, cdhash: None }.key(), "unsigned");
    }

    #[test]
    fn an_empty_preference_reads_as_cleared() {
        assert_eq!(stored(Some(String::new())), None);
        assert_eq!(stored(None), None);
        assert_eq!(stored(Some("team:X".into())), Some("team:X".into()));
    }

    #[test]
    fn the_reset_touches_only_our_screen_recording_entry() {
        assert_eq!(tccutil_reset_args("hippius.com"), ["reset", "ScreenCapture", "hippius.com"]);
    }

    /// The test binary is linker-signed ad hoc on Apple silicon (Intel
    /// binaries may be unsigned); either way the read must yield a key.
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[test]
    fn this_process_has_a_readable_signature() {
        let sig = current_signature();
        assert!(sig.team_id.is_some() || sig.cdhash.is_some(), "{sig:?}");
        assert_ne!(sig.key(), "unsigned");
    }
}
