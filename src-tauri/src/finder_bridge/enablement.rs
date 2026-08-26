//! Whether the macOS Finder Sync extension is switched on — and the UI to switch it on.
//!
//! A third-party Finder extension is not usable on a fresh install, and there
//! are TWO distinct reasons — the second was missed for months because the first
//! is the documented one:
//!
//! 1. **Registered but off.** macOS lists `HippiusFinder.appex` in the system's
//!    extension list and leaves the switch off. Until the user flips it, Finder
//!    never loads the extension, so the "Share with Hippius" right-click item
//!    does not exist *at all* — not even the "Open Hippius to share" fallback
//!    [`super::super`]'s Swift `menu(for:)` always returns (report of
//!    2026-08-15).
//! 2. **Never registered.** The system does not always pick the extension up
//!    from `Contents/PlugIns` in the first place. On a colleague's Mac in
//!    August 2026 the appex was present in `/Applications/Hippius.app` while
//!    `pluginkit -mAvvv -p com.apple.FinderSync` answered `(no matches)`. In
//!    that state the extension is in NO pane, so "go to Settings and enable it"
//!    is advice that cannot be followed — which is exactly how it was reported:
//!    "the button takes me to the wrong place and I don't see it in the list".
//!
//! Developer machines hide both: `macos/dev-finder.sh` runs `pluginkit -a`
//! (register) and `pluginkit -e use` (elect), and the election is keyed by
//! BUNDLE IDENTIFIER, so it survives replacing the app with a released build.
//! Every dev Mac has had this working since its first `pnpm finder:dev`.
//!
//! **Reading state** goes through Apple's own host-app API on
//! `FIFinderSyncController` (`isExtensionEnabled` /
//! `showExtensionManagementInterface`, macOS 10.14+, present and undeprecated in
//! the macOS 26 SDK) — never by parsing `pluginkit(8)`'s line format, and never
//! by opening a hardcoded `x-apple.systempreferences:` pane URL, which has moved
//! between macOS releases (Extensions → Privacy & Security → Login Items &
//! Extensions). Apple's method opens whatever the running OS calls that pane.
//!
//! **Changing state** has no such API — `FIFinderSyncController` can show the
//! pane but not flip the switch — so [`enable_finder_extension`] shells out to
//! `pluginkit`, the only thing that works, and the only thing that addresses
//! case 2 at all. That call is contained deliberately: its output is never
//! parsed, its failure is never fatal, and the caller falls back to opening the
//! pane. See that function's docs for why the trade is acceptable.

#[cfg(target_os = "macos")]
use std::ffi::OsStr;
#[cfg(target_os = "macos")]
use std::time::Duration;

use serde::Serialize;
use tauri::AppHandle;

use crate::error::{AppError, Result};

/// Where an app bundle keeps its app extensions.
const PLUGINS_SUBDIR: &str = "Contents/PlugIns";
/// Filename extension of a macOS app-extension bundle.
const APPEX_EXTENSION: &str = "appex";

/// Bundle identifier of the embedded Finder Sync extension.
///
/// `pluginkit`'s enable verb is keyed by identifier, not by path. Must stay
/// equal to `PRODUCT_BUNDLE_IDENTIFIER` in `macos/HippiusFinder/project.yml`;
/// pinned by `bundle_id_matches_the_extension_project`, which is compiled on
/// every platform so the drift guard runs in every CI lane.
#[cfg_attr(
    not(target_os = "macos"),
    allow(dead_code, reason = "only the macOS enable path uses it; kept compiled so its drift pin runs everywhere")
)]
const FINDER_EXTENSION_BUNDLE_ID: &str = "hippius.com.FinderSync";

/// Absolute path to `pluginkit`, rather than a bare name resolved through
/// `PATH` — this is a fixed OS utility and the lookup should not be
/// environment-dependent.
#[cfg(target_os = "macos")]
const PLUGINKIT_BIN: &str = "/usr/bin/pluginkit";

/// How long either `pluginkit` invocation may run before it is abandoned.
#[cfg(target_os = "macos")]
const PLUGINKIT_TIMEOUT: Duration = Duration::from_secs(10);

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

    /// The app extension embedded in `bundle_root`, if any.
    ///
    /// Any `.appex` counts rather than specifically a FinderSync one: the app
    /// ships exactly one extension, and parsing each candidate's Info.plist for
    /// `NSExtensionPointIdentifier` would buy nothing here. A missing or
    /// unreadable `PlugIns` directory is simply "no extension".
    ///
    /// `read_dir` order is unspecified, so with several extensions this picks an
    /// arbitrary one. That is fine while the app ships exactly one, and the
    /// registration path below names the bundle identifier explicitly rather
    /// than trusting whichever bundle came back.
    pub fn embedded_appex(bundle_root: &Path) -> Option<PathBuf> {
        let plugins: PathBuf = bundle_root.join(PLUGINS_SUBDIR);
        let appex = OsStr::new(APPEX_EXTENSION);
        let entries = std::fs::read_dir(plugins).ok()?;
        entries.flatten().map(|entry| entry.path()).find(|path| path.extension() == Some(appex))
    }

    /// The embedded extension of the RUNNING build, if this build has one.
    ///
    /// An unresolvable executable path answers `None`, which routes callers to
    /// `Unsupported` — staying silent on unverifiable state is this module's
    /// standing rule.
    pub fn current_build_appex_path() -> Option<PathBuf> {
        let Ok(exe) = std::env::current_exe() else {
            tracing::warn!("could not resolve current executable path; treating the Finder extension state as unknown");
            return None;
        };
        app_bundle_root(&exe).and_then(embedded_appex)
    }

    /// Resolve the running executable and apply both rules.
    pub fn current_build_hosts_finder_extension() -> bool {
        current_build_appex_path().is_some()
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

/// Register the embedded extension with the system, switch it on, and report
/// what the system says afterwards.
///
/// Backs the nudge's primary button. The nudge previously only opened the
/// Extensions pane, which assumes the extension is already IN that pane —
/// macOS's documented behaviour is that installing an app registers its
/// extension switched off. On a fresh install that assumption can fail
/// outright: a colleague's Mac in August 2026 had `HippiusFinder.appex` present
/// in `/Applications/Hippius.app/Contents/PlugIns/` and
/// `pluginkit -mAvvv -p com.apple.FinderSync` reporting `(no matches)` — the
/// system had never registered it, so no pane on that machine could ever list
/// Hippius and no amount of better wording would have helped.
///
/// So this runs the two verbs `macos/dev-finder.sh` has always run, which is
/// precisely why developer Macs never saw the bug:
///
/// 1. `pluginkit -a <appex>` — REGISTER. The load-bearing half. Without a
///    registration there is nothing to enable and nothing to display.
/// 2. `pluginkit -e use -i <bundle id>` — ELECT. Keyed by bundle identifier,
///    which is why a developer's election survives replacing the app.
///
/// `pluginkit(8)` is a *debugging* tool and Apple's DTS position is that it
/// should not be architected around, so two rules keep the dependency honest:
/// its OUTPUT is never parsed (the answer still comes from Apple's
/// `FIFinderSyncController`, as [`finder_extension_state`]), and a failure here
/// is not fatal — the caller falls back to
/// [`open_finder_extension_settings`], i.e. exactly today's behaviour. When
/// Apple removes the verb, the feature degrades rather than breaks.
///
/// Shelling out is only viable because the app is NOT sandboxed
/// (`entitlements.plist` sets `com.apple.security.app-sandbox` to false);
/// DTS notes the call does not work from inside a sandbox.
#[tauri::command]
pub async fn enable_finder_extension(app: AppHandle) -> Result<FinderExtensionState> {
    #[cfg(target_os = "macos")]
    {
        // Same gate as `finder_extension_state`: a build with no embedded
        // extension has nothing to register, and saying so is more useful than
        // running a command that cannot succeed.
        let Some(appex) = hosting::current_build_appex_path() else {
            return Err(AppError::Validation("This build of Hippius does not include the Finder extension.".into()));
        };

        let registered = run_pluginkit(&[OsStr::new("-a"), appex.as_os_str()]).await;
        let elected =
            run_pluginkit(&[OsStr::new("-e"), OsStr::new("use"), OsStr::new("-i"), OsStr::new(FINDER_EXTENSION_BUNDLE_ID)]).await;

        // Ask the system, rather than trusting either exit status: `-e use` can
        // report success while the elected instance is a different copy of the
        // app (see the module docs on system election).
        let state = finder_extension_state(app).await;
        tracing::info!(registered, elected, ?state, "attempted to enable the Finder extension");
        Ok(state)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err(AppError::Validation("Finder extensions are only available on macOS.".into()))
    }
}

/// Run `pluginkit` with `args`, reporting only whether it succeeded.
///
/// Never fatal and never parsed: every failure mode — missing binary, non-zero
/// exit, a hang — is logged and answered `false`, leaving the caller's
/// after-the-fact state check to decide what actually happened. The timeout
/// exists because this sits behind a button; a wedged helper must not leave the
/// notice spinning forever.
#[cfg(target_os = "macos")]
async fn run_pluginkit(args: &[&OsStr]) -> bool {
    let output = tokio::process::Command::new(PLUGINKIT_BIN).args(args).output();

    match tokio::time::timeout(PLUGINKIT_TIMEOUT, output).await {
        Ok(Ok(out)) if out.status.success() => true,
        Ok(Ok(out)) => {
            tracing::warn!(
                status = ?out.status.code(),
                stderr = %String::from_utf8_lossy(&out.stderr).trim(),
                "pluginkit exited non-zero while enabling the Finder extension"
            );
            false
        }
        Ok(Err(err)) => {
            tracing::warn!(%err, "could not run pluginkit to enable the Finder extension");
            false
        }
        Err(_elapsed) => {
            tracing::warn!(timeout = ?PLUGINKIT_TIMEOUT, "pluginkit timed out while enabling the Finder extension");
            false
        }
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
    use super::hosting::{app_bundle_root, embedded_appex};
    use std::path::{Path, PathBuf};

    /// The nudge gate's question — "can this build host an extension at all?" —
    /// expressed over the one resolver, so the two can never disagree.
    fn bundle_embeds_app_extension(bundle_root: &Path) -> bool {
        embedded_appex(bundle_root).is_some()
    }

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

    /// `pluginkit -a` takes a PATH, so the enable path needs the appex itself
    /// and not merely the yes/no the nudge gate asks for.
    #[test]
    fn the_embedded_extension_path_is_recoverable() {
        let dir = bundle_with(&["HippiusFinder.appex"]);
        let root = dir.path().join("Hippius.app");

        assert_eq!(embedded_appex(&root), Some(root.join("Contents/PlugIns/HippiusFinder.appex")));
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

    /// Drift pin: `pluginkit -e use -i` is keyed by bundle identifier, so if the
    /// Xcode project's identifier is ever changed the enable button would elect
    /// an identifier that no longer exists — and would fail SILENTLY, since the
    /// verb reports success for an unknown identifier and the state check would
    /// simply keep saying `disabled`.
    ///
    /// Reads the project file rather than duplicating the string, so the pin
    /// cannot be satisfied by editing both copies in the same wrong way.
    #[test]
    fn bundle_id_matches_the_extension_project() {
        let project = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../macos/HippiusFinder/project.yml"))
            .expect("read macos/HippiusFinder/project.yml");

        let declared = project
            .lines()
            .find_map(|line| line.trim().strip_prefix("PRODUCT_BUNDLE_IDENTIFIER:"))
            .map(str::trim)
            .expect("project.yml declares PRODUCT_BUNDLE_IDENTIFIER");

        assert_eq!(
            declared,
            super::FINDER_EXTENSION_BUNDLE_ID,
            "the Finder extension's bundle identifier changed in macos/HippiusFinder/project.yml; \
             update FINDER_EXTENSION_BUNDLE_ID to match or the enable button becomes a silent no-op"
        );
    }
}
