//! Drive-relative `path_prefix` validation for folder grants / folder invites.
//!
//! A folder invite's path is NOT the same as a public folder-share prefix:
//! whole-drive (empty) is refused — a grant must name at least one folder.
//! The server also requires NFC, no leading/trailing `/`, and no `.`/`..`
//! segments; we match that before the mint so a typo never becomes a
//! whole-drive invite on an older server that ignores `path_prefix`.

use crate::error::{AppError, Result};
use std::path::{Component, Path};
use unicode_normalization::UnicodeNormalization;

/// Cap the server enforces on folder-invite lifetime (30 days).
pub const FOLDER_INVITE_MAX_SECS: u64 = 30 * 24 * 60 * 60;
/// Folder invites are always single-use.
pub const FOLDER_INVITE_MAX_USES: u32 = 1;
/// Folder invites are always reader.
pub const FOLDER_INVITE_ROLE: &str = "reader";

/// Normalize and validate an untrusted drive-relative folder path into the
/// `path_prefix` a folder invite / grant uses.
///
/// Returns a owned NFC string with no leading/trailing `/`. Empty after trim
/// is refused — that would be a whole-drive invite.
pub fn folder_grant_path_prefix(relative_path: &str) -> Result<String> {
    let trimmed = relative_path.trim_matches('/');
    if trimmed.is_empty() {
        return Err(AppError::Validation(
            "A folder invite needs a folder path; it cannot cover the whole drive.".into(),
        ));
    }
    // NFC recomposition is segment-local (never crosses `/`).
    let nfc: String = trimmed.nfc().collect();
    // Check segments as strings before Path::components: that API drops `.`,
    // which would let `a/./b` through as `a/b`.
    for segment in nfc.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return Err(AppError::Validation(
                "Folder path contains an illegal component.".into(),
            ));
        }
    }
    for component in Path::new(&nfc).components() {
        match component {
            Component::Normal(_) => {}
            _ => {
                return Err(AppError::Validation(
                    "Folder path contains an illegal component.".into(),
                ));
            }
        }
    }
    Ok(nfc)
}

/// Clamp invite policy for a folder mint: always reader / 1 use / ≤30 days.
pub fn apply_folder_invite_policy(expires_in_secs: u64) -> (u64, u32, &'static str) {
    (expires_in_secs.min(FOLDER_INVITE_MAX_SECS), FOLDER_INVITE_MAX_USES, FOLDER_INVITE_ROLE)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_empty_and_root_slash() {
        assert!(folder_grant_path_prefix("").is_err());
        assert!(folder_grant_path_prefix("/").is_err());
        assert!(folder_grant_path_prefix("///").is_err());
    }

    #[test]
    fn trims_slashes_and_keeps_nested() {
        assert_eq!(folder_grant_path_prefix("/Clients/ACME/").unwrap(), "Clients/ACME");
        assert_eq!(folder_grant_path_prefix("Work").unwrap(), "Work");
    }

    #[test]
    fn refuses_dot_segments() {
        assert!(folder_grant_path_prefix("a/../b").is_err());
        assert!(folder_grant_path_prefix(".").is_err());
        assert!(folder_grant_path_prefix("a/./b").is_err());
    }

    #[test]
    fn normalizes_nfd_to_nfc() {
        // `e` + combining acute → precomposed é
        let nfd = "Cafe\u{0301}";
        let got = folder_grant_path_prefix(nfd).unwrap();
        assert_eq!(got, "Caf\u{00E9}");
        assert!(unicode_normalization::is_nfc(&got));
    }

    #[test]
    fn folder_invite_policy_clamps() {
        let (secs, uses, role) = apply_folder_invite_policy(100 * 365 * 24 * 3600);
        assert_eq!(secs, FOLDER_INVITE_MAX_SECS);
        assert_eq!(uses, 1);
        assert_eq!(role, "reader");
        let (secs, _, _) = apply_folder_invite_policy(3600);
        assert_eq!(secs, 3600);
    }
}
