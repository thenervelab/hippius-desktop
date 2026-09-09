//! Recognise a sync root that Finder Sync cannot fully serve.
//!
//! Two cases, both told rather than refused (users have working drives there):
//!
//! - **File Provider domain.** macOS keeps every File Provider domain under
//!   `~/Library/CloudStorage/` (`GoogleDrive-<account>`, `Dropbox`, …) and
//!   iCloud Drive under `~/Library/Mobile Documents/`. Finder Sync never
//!   renders menus or badges on those paths (Apple forum 718381), and every
//!   scan first makes that provider download its placeholders.
//! - **Special folders.** Desktop, Documents, Downloads, and Applications
//!   are folders Finder Sync may ignore even when they are not a File
//!   Provider path (Quinn, forum 729720). iCloud Desktop & Documents also
//!   firmlinks `~/Desktop` / `~/Documents` into Mobile Documents — we
//!   canonicalise first so that setup is named as iCloud Drive.

use serde::{Deserialize, Serialize};
use std::path::{Component, Path};

/// Folder under `~/Library` that holds every File Provider domain.
const CLOUD_STORAGE: &str = "CloudStorage";
/// Folder under `~/Library` that holds iCloud Drive.
const MOBILE_DOCUMENTS: &str = "Mobile Documents";

const SPECIAL_FOLDERS: &[(&str, &str)] = &[
    ("Desktop", "Desktop"),
    ("Documents", "Documents"),
    ("Downloads", "Downloads"),
    ("Applications", "Applications"),
];

/// Why Finder integration will not work as expected on this root.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HostedBy {
    /// Inside another cloud provider's File Provider domain.
    FileProvider { name: String },
    /// A folder Finder Sync may ignore (Desktop / Documents / Downloads /
    /// Applications), even when it is not a File Provider path.
    SpecialFolder { name: String },
}

/// The host classification for `path`, or `None` for a root Hippius owns
/// outright.
///
/// Canonicalises when the path exists so iCloud Desktop & Documents
/// firmlinks (`~/Documents` → `~/Library/Mobile Documents/…`) are named as
/// iCloud Drive rather than as a silent special folder. A path that cannot
/// be canonicalised is classified as-is.
pub fn root_host(path: &Path, home: &Path) -> Option<HostedBy> {
    let resolved = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    classify_root_host(&resolved, home)
}

/// Pure classifier over an already-resolved path. Tests call this so they
/// do not depend on the path existing on disk.
pub fn classify_root_host(path: &Path, home: &Path) -> Option<HostedBy> {
    file_provider_host(path, home).or_else(|| special_folder_host(path, home))
}

fn file_provider_host(path: &Path, home: &Path) -> Option<HostedBy> {
    let library = home.join("Library");
    let rest = path.strip_prefix(&library).ok()?;
    let mut components = rest.components().filter_map(|c| match c {
        Component::Normal(name) => name.to_str(),
        _ => None,
    });
    match components.next()? {
        MOBILE_DOCUMENTS => Some(HostedBy::FileProvider {
            name: "iCloud Drive".to_string(),
        }),
        CLOUD_STORAGE => components.next().map(|dir| HostedBy::FileProvider {
            name: provider_display_name(dir),
        }),
        _ => None,
    }
}

fn special_folder_host(path: &Path, home: &Path) -> Option<HostedBy> {
    let rest = path.strip_prefix(home).ok()?;
    let first = match rest.components().next()? {
        Component::Normal(name) => name.to_str()?,
        _ => return None,
    };
    for (folder, label) in SPECIAL_FOLDERS {
        if first == *folder {
            return Some(HostedBy::SpecialFolder { name: (*label).to_string() });
        }
    }
    None
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
pub fn sync_root_host(path: String) -> Option<HostedBy> {
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
        assert_eq!(
            classify_root_host(&path, &home()),
            Some(HostedBy::FileProvider {
                name: "Google Drive".to_string()
            })
        );
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
            assert_eq!(
                classify_root_host(&path, &home()),
                Some(HostedBy::FileProvider { name: name.to_string() }),
                "{dir}"
            );
        }
    }

    #[test]
    fn icloud_drive_lives_under_mobile_documents() {
        let path = home().join("Library/Mobile Documents/com~apple~CloudDocs/Notes");
        assert_eq!(
            classify_root_host(&path, &home()),
            Some(HostedBy::FileProvider {
                name: "iCloud Drive".to_string()
            })
        );
    }

    #[test]
    fn the_domain_folder_itself_counts_but_the_container_does_not() {
        assert_eq!(
            classify_root_host(&home().join("Library/CloudStorage/Dropbox"), &home()),
            Some(HostedBy::FileProvider { name: "Dropbox".to_string() })
        );
        assert_eq!(classify_root_host(&home().join("Library/CloudStorage"), &home()), None);
    }

    #[test]
    fn ordinary_roots_and_lookalikes_are_not_hosted() {
        for path in [
            home().join("Hippius"),
            home().join("Library/CloudStorageBackup/Dropbox"),
            home().join("Library/Application Support/Hippius"),
            PathBuf::from("/Users/someone-else/Library/CloudStorage/Dropbox"),
        ] {
            assert_eq!(classify_root_host(&path, &home()), None, "{}", path.display());
        }
    }

    #[test]
    fn desktop_documents_downloads_and_applications_are_special() {
        for (folder, label) in SPECIAL_FOLDERS {
            let path = home().join(folder).join("Hippius");
            assert_eq!(
                classify_root_host(&path, &home()),
                Some(HostedBy::SpecialFolder { name: (*label).to_string() }),
                "{folder}"
            );
        }
        // A lookalike under Documents/CloudStorage is still Documents.
        assert_eq!(
            classify_root_host(&home().join("Documents/CloudStorage/Dropbox"), &home()),
            Some(HostedBy::SpecialFolder {
                name: "Documents".to_string()
            })
        );
    }

    #[test]
    fn file_provider_wins_over_special_folder_when_the_path_is_already_resolved() {
        // iCloud Desktop & Documents: the canonical path lives under Mobile
        // Documents. Classification of that resolved path is iCloud, not Desktop.
        let resolved = home().join("Library/Mobile Documents/com~apple~CloudDocs/Desktop/Hippius");
        assert_eq!(
            classify_root_host(&resolved, &home()),
            Some(HostedBy::FileProvider {
                name: "iCloud Drive".to_string()
            })
        );
    }

    #[test]
    fn hosted_by_wire_is_tagged() {
        let json = serde_json::to_value(HostedBy::FileProvider { name: "Google Drive".into() }).expect("ser");
        assert_eq!(json["kind"], "fileProvider");
        assert_eq!(json["name"], "Google Drive");
        let json = serde_json::to_value(HostedBy::SpecialFolder { name: "Documents".into() }).expect("ser");
        assert_eq!(json["kind"], "specialFolder");
        assert_eq!(json["name"], "Documents");
    }
}
