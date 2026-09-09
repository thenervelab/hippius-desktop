//! Recognise a sync root that lives inside ANOTHER cloud provider's folder.
//!
//! macOS keeps every File Provider domain under `~/Library/CloudStorage/`
//! (`GoogleDrive-<account>`, `Dropbox`, `OneDrive-<org>`, `Box-Box`, …) and
//! iCloud Drive under `~/Library/Mobile Documents/`. A Hippius drive rooted
//! there works, but two things the user expects do not:
//!
//! - The Finder Sync extension never renders on a File Provider path — Apple
//!   confirmed that, and only the provider that owns the domain can add menu
//!   items or badges there. No enablement fix helps; "Share with Hippius" and
//!   the badges are simply absent inside that folder.
//! - The files are the other provider's placeholders, so every scan makes
//!   that provider download them first.
//!
//! Nothing here refuses the root: users have working drives there today.
//! The listing carries the provider's name so the folder row and the
//! add-folder dialog can say so, once, where the user can act on it.

use std::path::{Component, Path};

/// Folder under `~/Library` that holds every File Provider domain.
const CLOUD_STORAGE: &str = "CloudStorage";
/// Folder under `~/Library` that holds iCloud Drive.
const MOBILE_DOCUMENTS: &str = "Mobile Documents";

/// The display name of the cloud provider whose folder `path` sits inside,
/// or `None` for a root Hippius owns outright.
///
/// `home` is the account's home directory; matching is on whole path
/// components, so `~/LibraryCloudStorage-ish` names cannot false-positive.
pub fn root_host(path: &Path, home: &Path) -> Option<String> {
    let library = home.join("Library");
    let rest = path.strip_prefix(&library).ok()?;
    let mut components = rest.components().filter_map(|c| match c {
        Component::Normal(name) => name.to_str(),
        _ => None,
    });
    match components.next()? {
        MOBILE_DOCUMENTS => Some("iCloud Drive".to_string()),
        CLOUD_STORAGE => components.next().map(provider_display_name),
        _ => None,
    }
}

/// `GoogleDrive-me@example.com` → `Google Drive`. The domain folder is named
/// `<Provider>[-<account>]` by the provider's own extension, so the part
/// before the first `-` is the product; the known ones get their spelling.
fn provider_display_name(domain_dir: &str) -> String {
    let product = domain_dir.split('-').next().unwrap_or(domain_dir);
    match product {
        "GoogleDrive" => "Google Drive".to_string(),
        "OneDrive" => "OneDrive".to_string(),
        "Dropbox" => "Dropbox".to_string(),
        "Box" => "Box".to_string(),
        other => other.to_string(),
    }
}

/// The provider whose folder `path` sits inside, for the current user, or
/// `None`. The frontend asks this the moment a folder is picked so the
/// add-folder dialog can say what will not work there before the drive
/// exists.
#[tauri::command]
pub fn sync_root_host(path: String) -> Option<String> {
    let home = dirs::home_dir()?;
    root_host(Path::new(&path), &home)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn home() -> PathBuf {
        PathBuf::from("/Users/stellie")
    }

    #[test]
    fn a_google_drive_domain_is_named_without_the_account() {
        let path = home().join("Library/CloudStorage/GoogleDrive-stellie@example.com/Other computers/My MacBook/Design");
        assert_eq!(root_host(&path, &home()).as_deref(), Some("Google Drive"));
    }

    #[test]
    fn the_known_providers_get_their_spelling_and_unknown_ones_their_folder_name() {
        for (dir, name) in [
            ("Dropbox", "Dropbox"),
            ("OneDrive-Contoso", "OneDrive"),
            ("Box-Box", "Box"),
            ("ProtonDrive-me", "ProtonDrive"),
        ] {
            let path = home().join("Library/CloudStorage").join(dir).join("Work");
            assert_eq!(root_host(&path, &home()).as_deref(), Some(name), "{dir}");
        }
    }

    #[test]
    fn icloud_drive_lives_under_mobile_documents() {
        let path = home().join("Library/Mobile Documents/com~apple~CloudDocs/Notes");
        assert_eq!(root_host(&path, &home()).as_deref(), Some("iCloud Drive"));
    }

    #[test]
    fn the_domain_folder_itself_counts_but_the_container_does_not() {
        assert_eq!(
            root_host(&home().join("Library/CloudStorage/Dropbox"), &home()).as_deref(),
            Some("Dropbox")
        );
        // The container has no provider to name.
        assert_eq!(root_host(&home().join("Library/CloudStorage"), &home()), None);
    }

    #[test]
    fn ordinary_roots_and_lookalikes_are_not_hosted() {
        for path in [
            home().join("Hippius"),
            home().join("Documents/CloudStorage/Dropbox"),
            home().join("Library/CloudStorageBackup/Dropbox"),
            home().join("Library/Application Support/Hippius"),
            PathBuf::from("/Users/someone-else/Library/CloudStorage/Dropbox"),
        ] {
            assert_eq!(root_host(&path, &home()), None, "{}", path.display());
        }
    }
}
