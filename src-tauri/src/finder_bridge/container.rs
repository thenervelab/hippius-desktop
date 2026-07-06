//! macOS App Group container path for the Finder bridge socket.
//!
//! The non-sandboxed app reaches this directory by literal path; the sandboxed
//! extension reaches the same directory via
//! `containerURL(forSecurityApplicationGroupIdentifier:)`. Both must agree on
//! the App Group identifier below.

use std::path::PathBuf;

use crate::finder_bridge::error::FinderBridgeError;

/// The App Group identifier shared between the app and the Finder extension.
///
/// MUST stay byte-identical to `macos/group.env`, the
/// `com.apple.security.application-groups` entry in `src-tauri/entitlements.plist`,
/// and `macos/FinderSync.entitlements`. A mismatch means the extension and app
/// resolve different containers and never see each other's socket.
const APP_GROUP: &str = "V28B5X732P.com.hippius.shared";

/// Filename of the bridge socket inside the container.
const SOCKET_FILE: &str = "finder.sock";

/// Absolute path to the Unix-domain socket inside the App Group container:
/// `~/Library/Group Containers/<group>/finder.sock`.
///
/// # Errors
/// [`FinderBridgeError::NoContainer`] if the home directory cannot be resolved.
pub fn socket_path() -> Result<PathBuf, FinderBridgeError> {
    let home = dirs::home_dir().ok_or(FinderBridgeError::NoContainer)?;
    Ok(home.join("Library").join("Group Containers").join(APP_GROUP).join(SOCKET_FILE))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socket_path_is_under_the_group_container() {
        let path = socket_path().expect("home dir on a test host");
        let shown = path.to_string_lossy();
        assert!(
            shown.ends_with("Library/Group Containers/V28B5X732P.com.hippius.shared/finder.sock"),
            "unexpected socket path: {shown}"
        );
    }
}
