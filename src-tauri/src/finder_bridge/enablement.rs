//! Whether the macOS Finder Sync extension is switched on — and the UI to switch it on.
//!
//! macOS ships every third-party Finder extension **registered but off**:
//! installing Hippius puts `HippiusFinder.appex` in the system's extension list,
//! but until the user enables it Finder never loads the extension, so the
//! "Share with Hippius" right-click item does not exist *at all* — not even the
//! "Open Hippius to share" fallback [`super::super`]'s Swift `menu(for:)` always
//! returns. Developer machines hide this: `macos/dev-finder.sh` runs
//! `pluginkit -e use`, an election keyed by BUNDLE IDENTIFIER that survives
//! replacing the app with a released build, so every dev Mac has had it on since
//! the first `pnpm finder:dev`. That is why the gap only ever surfaced on a
//! fresh install (report of 2026-08-15).
//!
//! Both operations go through Apple's own host-app API on `FIFinderSyncController`
//! (`isExtensionEnabled` / `showExtensionManagementInterface`, macOS 10.14+,
//! present and undeprecated in the macOS 26 SDK). Deliberately NOT by shelling
//! out to `pluginkit(8)` — a documented *debugging* tool whose line format we
//! would have to parse — and not by opening a hardcoded
//! `x-apple.systempreferences:` pane URL, which has moved between macOS releases
//! (Extensions → Privacy & Security → Login Items & Extensions). Apple's method
//! opens whatever the running OS calls that pane.

use serde::Serialize;
use tauri::AppHandle;

use crate::error::{AppError, Result};

/// Where an app bundle keeps its app extensions.
const PLUGINS_SUBDIR: &str = "Contents/PlugIns";
/// Filename extension of a macOS app-extension bundle.
const APPEX_EXTENSION: &str = "appex";

/// Whether this build can host a Finder extension at all — the precondition
/// that makes [`macos::is_extension_enabled`]'s answer mean anything.
///
/// `+[FIFinderSyncController isExtensionEnabled]` reports on *the calling app's
/// own* extension. A process that embeds none — `pnpm tauri:dev`'s raw binary,
/// `cargo test`'s test binary, any bundle built without the Finder embed step —
/// therefore gets `false` unconditionally, and that `false` means "there is no
/// extension here", NOT "the user switched it off". Reading it as the latter is
/// what made the nudge fire forever on dev builds while the INSTALLED app's
/// extension was enabled and `pluginkit` showed `+` (report of 2026-08-24).
/// The file's own `is_extension_enabled_is_callable` test always documented
/// this ("the test binary is not an app bundle … always gets `false`"); only
/// the runtime path never accounted for it.
///
/// Split from the I/O so the path rule is unit-testable on every platform
/// (`path_is_translocated`'s convention), and compiled everywhere for the same
/// reason — only the macOS branch of [`finder_extension_state`] calls it.
#[cfg_attr(
    not(target_os = "macos"),
    allow(dead_code, reason = "only the macOS branch consults it; kept compiled so its tests run in every CI lane")
)]
mod hosting {
    use super::{APPEX_EXTENSION, PLUGINS_SUBDIR};
    use std::ffi::OsStr;
    use std::path::{Path, PathBuf};

    /// The `.app` bundle containing `exe`, if it is inside one.
    ///
    /// Returns the OUTERMOST match: an app extension is itself a bundle, so an
    /// executable inside `Hippius.app/Contents/PlugIns/HippiusFinder.appex` has
    /// two bundle ancestors, and the host app is the one that owns the
    /// extension list. Pure path logic — nothing is read from disk.
    pub fn app_bundle_root(exe: &Path) -> Option<&Path> {
        let app = OsStr::new("app");
        // `Ancestors` walks inside-out and is not double-ended, so the LAST
        // match is the outermost bundle.
        exe.ancestors().filter(|dir| dir.extension() == Some(app)).last()
    }

    /// Whether `bundle_root` embeds at least one app extension.
    ///
    /// Any `.appex` counts rather than specifically a FinderSync one: the app
    /// ships exactly one extension, and parsing each candidate's Info.plist for
    /// `NSExtensionPointIdentifier` would buy nothing here. A missing or
    /// unreadable `PlugIns` directory is simply "no extension".
    pub fn bundle_embeds_app_extension(bundle_root: &Path) -> bool {
        let plugins: PathBuf = bundle_root.join(PLUGINS_SUBDIR);
        let appex = OsStr::new(APPEX_EXTENSION);
        let Ok(entries) = std::fs::read_dir(plugins) else {
            return false;
        };
        entries.flatten().any(|entry| entry.path().extension() == Some(appex))
    }

    /// Resolve the running executable and apply both rules.
    ///
    /// An unresolvable executable path answers `false`, which routes the caller
    /// to `Unsupported` — staying silent on unverifiable state is this module's
    /// standing rule.
    pub fn current_build_hosts_finder_extension() -> bool {
        let Ok(exe) = std::env::current_exe() else {
            tracing::warn!("could not resolve current executable path; treating the Finder extension state as unknown");
            return false;
        };
        app_bundle_root(&exe).is_some_and(bundle_embeds_app_extension)
    }
}

/// Whether the user has enabled the Finder extension.
///
/// Wire format is the tagged shape (`{"kind": "enabled"}`), matching
/// `DriveStatus`, so a future variant can be added without breaking the
/// frontend. `Unsupported` covers every platform but macOS **and** the macOS
/// cases where the answer can't be obtained (the FinderSync class is missing, or
/// the main-thread hop fails) — the frontend treats it exactly like `Enabled`,
/// i.e. it stays silent, because nagging on an unverifiable state is worse than
/// missing a nudge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum FinderExtensionState {
    Enabled,
    Disabled,
    Unsupported,
}

/// Report whether the Finder extension is enabled for the current user.
///
/// Infallible by design (like `is_app_translocated`): the frontend polls this on
/// mount and on every window focus, and an error there would only be swallowed.
/// Anything it cannot determine is [`FinderExtensionState::Unsupported`].
#[tauri::command]
pub async fn finder_extension_state(app: AppHandle) -> FinderExtensionState {
    #[cfg(target_os = "macos")]
    {
        // Ask only when the answer can carry meaning. Without this, every build
        // that embeds no extension reports `Disabled` and nags about a switch
        // that would not help — see `hosting`.
        if !hosting::current_build_hosts_finder_extension() {
            tracing::debug!("this build embeds no Finder extension; reporting the enablement state as unsupported");
            return FinderExtensionState::Unsupported;
        }

        let state = match on_main_thread(&app, macos::is_extension_enabled).await {
            Some(true) => FinderExtensionState::Enabled,
            Some(false) => FinderExtensionState::Disabled,
            None => FinderExtensionState::Unsupported,
        };
        if state == FinderExtensionState::Disabled {
            // Support bundles: a "the right-click menu is missing" ticket is
            // answered by this one line, without a round-trip asking the user to
            // run pluginkit. The frontend re-checks on window focus, so this can
            // repeat — at human pace, and only while the extension is off.
            tracing::info!("finder extension is not enabled for this user; the Finder share menu will not appear");
        } else {
            tracing::debug!(?state, "finder extension state");
        }
        state
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        FinderExtensionState::Unsupported
    }
}

/// Open the system pane where the user turns the Finder extension on.
///
/// Backs the nudge's action button. Errors surface to the frontend so a button
/// that did nothing can say why, rather than looking broken.
#[tauri::command]
pub async fn open_finder_extension_settings(app: AppHandle) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        on_main_thread(&app, macos::show_extension_management_interface)
            .await
            .ok_or_else(|| AppError::Other("Could not open the macOS Extensions settings pane.".into()))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        // Matches `hcfs_finder_confirm_share`'s platform refusal: a typed
        // Validation rather than the catch-all Other.
        Err(AppError::Validation("Finder extensions are only available on macOS.".into()))
    }
}

/// Run `work` on the AppKit main thread and await its result.
///
/// `FIFinderSyncController`'s host-app API is AppKit UI state;
/// `showExtensionManagementInterface` in particular presents system UI, and
/// Apple's documented usage of `isExtensionEnabled` is from
/// `applicationDidBecomeActive:`. Tauri commands run on the async runtime, never
/// the main thread, so every call hops. `None` means the hop itself failed (the
/// event loop is gone — i.e. the app is shutting down), which both callers treat
/// as "unknown" rather than as an answer.
#[cfg(target_os = "macos")]
async fn on_main_thread<T, F>(app: &AppHandle, work: F) -> Option<T>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    let (tx, rx) = tokio::sync::oneshot::channel();

    if let Err(err) = app.run_on_main_thread(move || {
        // A send error means the receiver was dropped (command future cancelled);
        // there is nothing to report it to.
        let _ = tx.send(work());
    }) {
        tracing::warn!(%err, "finder extension: could not dispatch to the main thread");
        return None;
    }

    rx.await.ok()
}

/// The Objective-C bridge to `FIFinderSyncController`'s two host-app class methods.
#[cfg(target_os = "macos")]
mod macos {
    use objc::runtime::{BOOL, Class, NO};
    use objc::{msg_send, sel, sel_impl};

    // Referencing the class *symbol* — rather than looking the class up by name
    // with `objc_getClass` (what objc's `class!` macro does) — is what forces the
    // linker to record FinderSync.framework as a dependency of the binary. With a
    // name-only lookup nothing pulls the framework in, so the class would never be
    // registered in our process and the lookup would always fail. `Class` is an
    // opaque zero-sized `#[repr(C)]` type, so this declares the class object
    // itself, exactly as the Objective-C compiler emits it.
    #[link(name = "FinderSync", kind = "framework")]
    unsafe extern "C" {
        #[link_name = "OBJC_CLASS_$_FIFinderSyncController"]
        static FI_FINDER_SYNC_CONTROLLER: Class;
    }

    /// `+[FIFinderSyncController isExtensionEnabled]` — has the user switched
    /// *this app's* Finder extension on? Available since macOS 10.14; the app's
    /// minimum is well above that, so no availability check is needed.
    pub fn is_extension_enabled() -> bool {
        // SAFETY: `FI_FINDER_SYNC_CONTROLLER` is the class object exported by the
        // linked FinderSync.framework, so the reference is valid for the life of
        // the process. `isExtensionEnabled` is a readonly class property with the
        // `(id, SEL) -> BOOL` signature this send declares, and it is invoked on
        // the main thread by `on_main_thread`.
        let enabled: BOOL = unsafe { msg_send![&FI_FINDER_SYNC_CONTROLLER, isExtensionEnabled] };
        // `BOOL` is `bool` on aarch64 and `c_schar` elsewhere (objc 0.2), so
        // compare against `NO` rather than casting — the app ships universal.
        enabled != NO
    }

    /// `+[FIFinderSyncController showExtensionManagementInterface]` — open the
    /// system pane listing Finder extensions, so the user can flip ours on.
    pub fn show_extension_management_interface() {
        // SAFETY: same class object as above; the selector takes no arguments and
        // returns void, matching this send. It presents system UI, so it must run
        // on the main thread — `on_main_thread` guarantees that.
        unsafe { msg_send![&FI_FINDER_SYNC_CONTROLLER, showExtensionManagementInterface] }
    }
}

#[cfg(all(test, target_os = "macos"))]
mod macos_tests {
    /// Smoke test for the Objective-C bridge: the class symbol resolves (so
    /// FinderSync.framework really is linked) and the selector exists.
    ///
    /// Deliberately asserts nothing about the ANSWER — the test binary is not an
    /// app bundle, so it has no extension to report on and always gets `false`.
    /// What it catches is the two ways this file can be wrong without any
    /// compiler complaint: a missing framework link (the class is never
    /// registered) and a misspelled selector (`objc_msgSend` aborts the process
    /// with "unrecognized selector"). Both would otherwise only show up as a
    /// crash on a user's Mac.
    #[test]
    fn is_extension_enabled_is_callable() {
        let _ = super::macos::is_extension_enabled();
    }
}

#[cfg(test)]
mod hosting_tests {
    use super::hosting::{app_bundle_root, bundle_embeds_app_extension};
    use std::path::{Path, PathBuf};

    #[test]
    fn finds_the_bundle_of_an_installed_app() {
        let exe = Path::new("/Applications/Hippius.app/Contents/MacOS/Hippius");
        assert_eq!(app_bundle_root(exe), Some(Path::new("/Applications/Hippius.app")));
    }

    /// The case behind the permanent nudge: `pnpm tauri:dev` runs the raw
    /// target binary, which is in no bundle at all.
    #[test]
    fn a_dev_binary_is_in_no_bundle() {
        let exe = Path::new("/Users/me/hippius-desktop/src-tauri/target/debug/hippius-desktop");
        assert_eq!(app_bundle_root(exe), None);
    }

    /// An extension is itself a bundle, so the HOST app must win — it is the
    /// one whose extension list the enablement question is about.
    #[test]
    fn the_host_app_wins_over_a_nested_extension_bundle() {
        let exe = Path::new("/Applications/Hippius.app/Contents/PlugIns/HippiusFinder.appex/Contents/MacOS/HippiusFinder");
        assert_eq!(app_bundle_root(exe), Some(Path::new("/Applications/Hippius.app")));
    }

    #[test]
    fn a_bare_path_is_in_no_bundle() {
        assert_eq!(app_bundle_root(Path::new("")), None);
        assert_eq!(app_bundle_root(Path::new("/")), None);
    }

    fn bundle_with(plugins: &[&str]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        let root: PathBuf = dir.path().join("Hippius.app");
        if !plugins.is_empty() {
            let plugin_dir = root.join("Contents/PlugIns");
            std::fs::create_dir_all(&plugin_dir).expect("create PlugIns");
            for name in plugins {
                std::fs::create_dir_all(plugin_dir.join(name)).expect("create appex");
            }
        }
        dir
    }

    #[test]
    fn an_embedded_extension_is_detected() {
        let dir = bundle_with(&["HippiusFinder.appex"]);
        assert!(bundle_embeds_app_extension(&dir.path().join("Hippius.app")));
    }

    /// A release built without the Finder embed step: the enablement question
    /// is unanswerable, so the caller must stay silent rather than tell the
    /// user to switch on something this build does not contain.
    #[test]
    fn a_bundle_without_plugins_embeds_nothing() {
        let dir = bundle_with(&[]);
        assert!(!bundle_embeds_app_extension(&dir.path().join("Hippius.app")));
    }

    #[test]
    fn an_empty_plugins_directory_embeds_nothing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("Hippius.app");
        std::fs::create_dir_all(root.join("Contents/PlugIns")).expect("create PlugIns");
        assert!(!bundle_embeds_app_extension(&root));
    }

    /// Only `.appex` counts — a stray file in PlugIns is not an extension.
    #[test]
    fn a_non_appex_entry_does_not_count() {
        let dir = bundle_with(&["notes.txt"]);
        assert!(!bundle_embeds_app_extension(&dir.path().join("Hippius.app")));
    }
}

#[cfg(test)]
mod tests {
    use super::FinderExtensionState;

    /// Wire-shape pin: the frontend switches on `kind`, so these three strings are
    /// the contract. A `rename_all` or variant rename would silently turn the
    /// nudge off (every state stops matching `"disabled"`).
    #[test]
    fn state_serializes_to_the_tagged_wire_shape() {
        let json = |state: FinderExtensionState| serde_json::to_value(state).expect("serialize");

        assert_eq!(json(FinderExtensionState::Enabled), serde_json::json!({"kind": "enabled"}));
        assert_eq!(json(FinderExtensionState::Disabled), serde_json::json!({"kind": "disabled"}));
        assert_eq!(json(FinderExtensionState::Unsupported), serde_json::json!({"kind": "unsupported"}));
    }
}
