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
#[cfg(target_os = "macos")]
use tauri::Manager;

use crate::app_state::AppState;
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

/// Absolute path to `lsregister`, which is NOT on `PATH` at all — it lives
/// inside the LaunchServices framework and has for every macOS release that
/// matters here.
#[cfg(target_os = "macos")]
const LSREGISTER_BIN: &str = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

/// How long any one registration helper may run before it is abandoned.
#[cfg(target_os = "macos")]
const TOOL_TIMEOUT: Duration = Duration::from_secs(10);

/// Pause between registering the extension and electing it on a first run.
/// PlugInKit discovers the appex asynchronously after `pluginkit -a`, and an
/// election sent before discovery lands is a silent no-op — every Finder Sync
/// peer carries this wait (MEGAsync 5 s at runtime, ownCloud and Nextcloud
/// 10 s in their installers).
#[cfg(target_os = "macos")]
const DISCOVERY_WAIT: Duration = Duration::from_secs(5);

/// Pause between un-electing and re-electing after an update, so Finder
/// tears the old extension host down before it loads the new bundle.
#[cfg(target_os = "macos")]
const REELECT_WAIT: Duration = Duration::from_secs(1);

/// Upper bound on how long `finder_extension_state` waits for the launch
/// check to finish before answering. The check needs at most
/// [`DISCOVERY_WAIT`] plus a few tool invocations; past this the answer is
/// given from whatever state the system is in, so a wedged helper can never
/// hang the IPC.
#[cfg(target_os = "macos")]
const LAUNCH_CHECK_CAP: Duration = Duration::from_secs(8);

/// Settings-store key for [`FinderExtensionPreference`].
const PREFERENCE_KEY: &str = "finder_extension_preference";

/// Settings-store key for the [`ElectionFingerprint`] of the last election
/// this app performed and saw take.
const FINGERPRINT_KEY: &str = "finder_extension_election_fingerprint";

/// Where macOS records its own build number. Read for the election
/// fingerprint; a missing or unparseable file reads as an empty build, which
/// still fingerprints the app version.
#[cfg(target_os = "macos")]
const SYSTEM_VERSION_PLIST: &str = "/System/Library/CoreServices/SystemVersion.plist";

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

    /// The running build's `.app` bundle and the extension inside it.
    ///
    /// Both or neither: registration needs the bundle (for LaunchServices) and
    /// the appex (for PlugInKit), and there is no useful state where one is
    /// known without the other. An unresolvable executable path answers `None`,
    /// which routes callers to `Unsupported` — staying silent on unverifiable
    /// state is this module's standing rule.
    pub fn current_build_bundle_and_appex() -> Option<(PathBuf, PathBuf)> {
        let Ok(exe) = std::env::current_exe() else {
            tracing::warn!("could not resolve current executable path; treating the Finder extension state as unknown");
            return None;
        };
        let root = app_bundle_root(&exe)?.to_path_buf();
        let appex = embedded_appex(&root)?;

        Some((root, appex))
    }

    /// Resolve the running executable and apply both rules.
    pub fn current_build_hosts_finder_extension() -> bool {
        current_build_bundle_and_appex().is_some()
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
    /// Off, and the user has said not to ask: the nudge stays silent, while
    /// the Settings switch still renders it as off so there is a way back.
    Muted,
    Unsupported,
}

/// The policy half of enablement: what the user said, what environment the
/// extension was last elected in, and what the launch check should do about
/// it. Pure and platform-independent so the decision table is unit-tested in
/// every CI lane; only the macOS launch/enable paths consult it at runtime.
#[cfg_attr(
    not(target_os = "macos"),
    allow(
        dead_code,
        reason = "only the macOS launch/enable paths consult it; kept compiled so its tests run in every CI lane"
    )
)]
mod policy {
    use serde::{Deserialize, Serialize};
    use sqlx::SqlitePool;

    #[cfg(target_os = "macos")]
    use super::SYSTEM_VERSION_PLIST;
    use super::{FINGERPRINT_KEY, FinderExtensionState, PREFERENCE_KEY};
    use crate::error::Result;
    use crate::utils::preferences::{get_user_preference_internal, save_user_preference_internal};

    /// What the user has said about the Finder extension. Absent means never
    /// asked — a fresh install, or an upgrade from a build that did not record it.
    ///
    /// Stored in `user_preferences` under [`PREFERENCE_KEY`]; the wire form of the
    /// `set_finder_extension_preference` argument is the same lowercase string.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "lowercase")]
    pub enum FinderExtensionPreference {
        /// Keep it on: elected on first run and re-elected after updates.
        Wanted,
        /// Leave it off and never ask: "Don't ask again", or the Settings switch.
        Unwanted,
    }

    impl FinderExtensionPreference {
        fn as_str(self) -> &'static str {
            match self {
                Self::Wanted => "wanted",
                Self::Unwanted => "unwanted",
            }
        }

        fn parse(raw: &str) -> Option<Self> {
            match raw {
                "wanted" => Some(Self::Wanted),
                "unwanted" => Some(Self::Unwanted),
                other => {
                    tracing::warn!(value = other, "unrecognized Finder extension preference; treating it as never asked");
                    None
                }
            }
        }
    }

    /// The stored preference, or `None` when there is none (or it cannot be read
    /// — a read failure must not turn into an election the user refused, so it
    /// reads as "never asked", which elects only on a fresh install).
    pub(super) async fn load_preference(pool: &SqlitePool) -> Option<FinderExtensionPreference> {
        match get_user_preference_internal(pool, PREFERENCE_KEY).await {
            Ok(Some(raw)) => FinderExtensionPreference::parse(&raw),
            Ok(None) => None,
            Err(err) => {
                tracing::warn!(%err, "could not read the Finder extension preference");
                None
            }
        }
    }

    pub(super) async fn store_preference(pool: &SqlitePool, preference: FinderExtensionPreference) -> Result<()> {
        save_user_preference_internal(pool, PREFERENCE_KEY, preference.as_str()).await
    }

    /// The environment the extension was last elected in: `<app version>|<macOS
    /// build>`. Either half changing is the event that flips or stales the
    /// election in the field — an app update swaps the bundle Finder loaded, a
    /// macOS update rebuilds the extension registry — and it is what MEGAsync
    /// re-elects on after each of its own updates.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub(super) struct ElectionFingerprint(String);

    impl ElectionFingerprint {
        pub(super) fn new(app_version: &str, macos_build: &str) -> Self {
            Self(format!("{app_version}|{macos_build}"))
        }

        /// This build, on this macOS. The app version is the crate version,
        /// which the release invariant keeps equal to `tauri.conf.json`.
        #[cfg(target_os = "macos")]
        pub(super) fn current() -> Self {
            Self::new(env!("CARGO_PKG_VERSION"), &macos_build())
        }

        pub(super) fn as_str(&self) -> &str {
            &self.0
        }
    }

    /// The running macOS build (`25G83`), or empty when it cannot be read.
    #[cfg(target_os = "macos")]
    fn macos_build() -> String {
        std::fs::read_to_string(SYSTEM_VERSION_PLIST)
            .ok()
            .and_then(|plist| product_build_version(&plist))
            .unwrap_or_default()
    }

    /// `ProductBuildVersion` out of `SystemVersion.plist`'s XML. A string scan
    /// rather than a plist parser: the file is Apple's, tiny, and has carried
    /// this exact `<key>`/`<string>` pair since Mac OS X; a dependency for one
    /// field is not worth its surface.
    pub(super) fn product_build_version(plist: &str) -> Option<String> {
        let key = plist.find("<key>ProductBuildVersion</key>")?;
        let after_key = &plist[key..];
        let start = after_key.find("<string>")? + "<string>".len();
        let end = after_key[start..].find("</string>")? + start;
        let value = after_key[start..end].trim();
        (!value.is_empty()).then(|| value.to_owned())
    }

    pub(super) async fn load_fingerprint(pool: &SqlitePool) -> Option<String> {
        match get_user_preference_internal(pool, FINGERPRINT_KEY).await {
            Ok(value) => value,
            Err(err) => {
                tracing::warn!(%err, "could not read the Finder extension election fingerprint");
                None
            }
        }
    }

    /// Record that the extension is on in this environment and that the user
    /// wants it: the next launch in the same environment does nothing, and the
    /// next one after an update re-elects.
    #[cfg(target_os = "macos")]
    pub(super) async fn adopt_election(pool: &SqlitePool, fingerprint: &ElectionFingerprint) {
        if let Err(err) = store_preference(pool, FinderExtensionPreference::Wanted).await {
            tracing::warn!(%err, "could not record the Finder extension preference");
        }
        if let Err(err) = save_user_preference_internal(pool, FINGERPRINT_KEY, fingerprint.as_str()).await {
            tracing::warn!(%err, "could not record the Finder extension election fingerprint");
        }
    }

    /// What the launch check should do, given what the user said, what the
    /// system reports, and whether the environment changed since the last
    /// election. Pure so the whole table is unit-tested on every platform.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub(super) enum LaunchAction {
        Nothing,
        /// Register with LaunchServices and PlugInKit so the extension appears in
        /// the settings pane, but leave the switch alone: the user turned it off
        /// in steady state, and the nudge is the surface that asks.
        RegisterOnly,
        /// First run: register, wait for discovery, elect.
        RegisterAndElect,
        /// After an app or macOS update: register, un-elect, re-elect, so Finder
        /// drops the stale extension host and loads the current bundle.
        Reelect,
    }

    #[allow(
        clippy::match_same_arms,
        reason = "the `(Some(Wanted), Enabled) => Nothing` arm must stay BELOW the fingerprint guard; folding it into the first arm would match before the guard and skip the post-update re-election"
    )]
    pub(super) fn launch_action(
        preference: Option<FinderExtensionPreference>,
        state: FinderExtensionState,
        fingerprint_changed: bool,
    ) -> LaunchAction {
        use FinderExtensionPreference::{Unwanted, Wanted};
        use FinderExtensionState::{Disabled, Enabled, Muted, Unsupported};

        match (preference, state) {
            // Nothing to act on: no extension to speak of, the user said no,
            // or never asked and already on (a developer Mac, or a user who
            // flipped it in Settings before this build) — adopted, untouched.
            (_, Unsupported | Muted) | (Some(Unwanted), Enabled | Disabled) | (None, Enabled) => LaunchAction::Nothing,
            (None, Disabled) => LaunchAction::RegisterAndElect,
            (Some(Wanted), Enabled | Disabled) if fingerprint_changed => LaunchAction::Reelect,
            (Some(Wanted), Enabled) => LaunchAction::Nothing,
            (Some(Wanted), Disabled) => LaunchAction::RegisterOnly,
        }
    }

    /// The state the frontend is told, given what the system reports and what
    /// the user said. An off extension the user does not want is `Muted`, which
    /// the nudge treats as silence and the Settings switch renders as off.
    pub(super) fn report_state(raw: FinderExtensionState, preference: Option<FinderExtensionPreference>) -> FinderExtensionState {
        match (raw, preference) {
            (FinderExtensionState::Disabled, Some(FinderExtensionPreference::Unwanted)) => FinderExtensionState::Muted,
            (other, _) => other,
        }
    }
}

pub use policy::FinderExtensionPreference;
use policy::{ElectionFingerprint, LaunchAction, launch_action, load_preference, report_state, store_preference};
#[cfg(target_os = "macos")]
use policy::{adopt_election, load_fingerprint};

/// Report whether the Finder extension is enabled for the current user, as
/// the frontend should understand it.
///
/// Infallible by design (like `is_app_translocated`): the frontend polls this on
/// mount and on every window focus, and an error there would only be swallowed.
/// Anything it cannot determine is [`FinderExtensionState::Unsupported`].
///
/// Waits (bounded) for [`ensure_finder_extension_at_launch`] to finish first:
/// a fresh install is electing the extension during the first seconds of the
/// first launch, and answering `Disabled` in that window would raise the
/// nudge over a switch that is about to flip on its own.
#[tauri::command]
pub async fn finder_extension_state(app: AppHandle) -> FinderExtensionState {
    #[cfg(target_os = "macos")]
    {
        let app_state = app.state::<AppState>();
        wait_for_launch_check(&app_state).await;

        let raw = read_state(&app).await;
        let preference = match app_state.pool() {
            Ok(pool) => load_preference(pool).await,
            Err(_) => None,
        };
        let state = report_state(raw, preference);
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

/// What the system says, before the user's preference is applied.
///
/// Never answers `Muted`; that is [`report_state`]'s to add.
#[cfg(target_os = "macos")]
async fn read_state(app: &AppHandle) -> FinderExtensionState {
    // A translocated launch — Hippius opened straight from the mounted DMG,
    // which is what a first-time user does — is the one case where
    // `Disabled` is both accurate and useless. macOS never registers an
    // extension from the randomized read-only `…/AppTranslocation/<UUID>/d/`
    // path, so it is in NO pane, and [`enable_finder_extension`] refuses to
    // register it (electing an ephemeral copy by bundle id can strand the
    // real install as `Disabled` for good). Without this gate the nudge fires
    // with an Enable button that cannot succeed, and the Settings pane it
    // falls back to cannot list us — on top of the permanent notice
    // `TranslocationGuard` is already showing. Moving the app is the only
    // thing that helps, and that guard owns saying so.
    if crate::utils::app_location::is_app_translocated() {
        tracing::debug!("app is translocated, so its Finder extension is unregistrable; reporting the state as unsupported");
        return FinderExtensionState::Unsupported;
    }

    // Ask only when the answer can carry meaning. Without this, every build
    // that embeds no extension reports `Disabled` and nags about a switch
    // that would not help — see `hosting`.
    if !hosting::current_build_hosts_finder_extension() {
        tracing::debug!("this build embeds no Finder extension; reporting the enablement state as unsupported");
        return FinderExtensionState::Unsupported;
    }

    match on_main_thread(app, macos::is_extension_enabled).await {
        Some(true) => FinderExtensionState::Enabled,
        Some(false) => FinderExtensionState::Disabled,
        None => FinderExtensionState::Unsupported,
    }
}

/// Block until the launch check has run, or [`LAUNCH_CHECK_CAP`] passes.
///
/// The check flips `AppState::finder_launch_check` exactly once per process,
/// on every exit path; a launch that never reaches it (the DB failed to open)
/// costs each caller the cap once and nothing more.
#[cfg(target_os = "macos")]
async fn wait_for_launch_check(app_state: &AppState) {
    let mut settled = app_state.finder_launch_check.subscribe();
    if tokio::time::timeout(LAUNCH_CHECK_CAP, settled.wait_for(|done| *done)).await.is_err() {
        tracing::debug!("finder extension launch check has not settled; answering from the current state");
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
        // A translocated app runs from a randomized, read-only
        // `…/AppTranslocation/<UUID>/d/` path that is gone by the next launch.
        // Registering THAT path would be actively harmful: `-e use` elects by
        // bundle identifier, and `isExtensionEnabled` reports on the elected
        // instance (see the module's "two registered copies" note), so electing
        // an ephemeral copy can leave the real `/Applications` one reporting
        // `Disabled` indefinitely — making the reported bug worse, for exactly
        // the fresh-from-DMG users the nudge exists to help. `TranslocationGuard`
        // already tells them to move the app; there is nothing useful to do here
        // until they have.
        if crate::utils::app_location::is_app_translocated() {
            tracing::warn!("refusing to register the Finder extension from a translocated app bundle");
            return Err(AppError::Validation(
                "Move Hippius to your Applications folder first, then try again — macOS is running it from a temporary location.".into(),
            ));
        }

        // Same gate as `finder_extension_state`: a build with no embedded
        // extension has nothing to register, and saying so is more useful than
        // running a command that cannot succeed.
        let Some((bundle, appex)) = hosting::current_build_bundle_and_appex() else {
            return Err(AppError::Validation(
                "This build of Hippius does not include the Finder extension.".into(),
            ));
        };

        let registered = register_with_the_system(&bundle, &appex).await;
        let elected = elect().await;

        // Ask the system, rather than trusting either exit status: `-e use` can
        // report success while the elected instance is a different copy of the
        // app (see the module docs on system election).
        let state = read_state(&app).await;
        tracing::info!(registered, elected, ?state, "attempted to enable the Finder extension");
        log_registry().await;

        // The user asked for it by name, so this is the preference from here
        // on — and the environment it took in is what a later launch compares
        // against to decide whether an update warrants a re-election.
        if state == FinderExtensionState::Enabled
            && let Ok(pool) = app.state::<AppState>().pool()
        {
            adopt_election(pool, &ElectionFingerprint::current()).await;
        }
        Ok(state)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err(AppError::Validation("Finder extensions are only available on macOS.".into()))
    }
}

/// Record what the user wants and act on it now: `wanted` registers and
/// elects like the Enable button; `unwanted` switches the extension off.
///
/// Backs both "Don't ask again" on the nudge and the Settings switch. Returns
/// the resulting state so a switch can render the truth rather than its own
/// optimism.
#[tauri::command]
pub async fn set_finder_extension_preference(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    preference: FinderExtensionPreference,
) -> Result<FinderExtensionState> {
    #[cfg(target_os = "macos")]
    {
        store_preference(state.pool()?, preference).await?;
        tracing::info!(?preference, "finder extension preference recorded");

        match preference {
            FinderExtensionPreference::Wanted => enable_finder_extension(app).await,
            FinderExtensionPreference::Unwanted => {
                let unelected = unelect().await;
                let raw = read_state(&app).await;
                tracing::info!(unelected, ?raw, "switched the Finder extension off at the user's request");
                Ok(report_state(raw, Some(preference)))
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, state, preference);
        Err(AppError::Validation("Finder extensions are only available on macOS.".into()))
    }
}

/// Switch the extension on: `pluginkit -e use`, keyed by bundle identifier.
#[cfg(target_os = "macos")]
async fn elect() -> bool {
    run_pluginkit(&[
        OsStr::new("-e"),
        OsStr::new("use"),
        OsStr::new("-i"),
        OsStr::new(FINDER_EXTENSION_BUNDLE_ID),
    ])
    .await
}

/// Switch the extension off: `pluginkit -e ignore`. Only two paths may do
/// this — the user's own preference, and the post-update re-election that
/// follows it with [`elect`] a second later.
#[cfg(target_os = "macos")]
async fn unelect() -> bool {
    run_pluginkit(&[
        OsStr::new("-e"),
        OsStr::new("ignore"),
        OsStr::new("-i"),
        OsStr::new(FINDER_EXTENSION_BUNDLE_ID),
    ])
    .await
}

/// Log what PlugInKit holds for Finder Sync extensions, for the support
/// bundle: two rows for our identifier is the second-registered-copy case,
/// a leading `-` an un-elected one, no output an unregistered one. Logged,
/// never parsed — nothing in the app branches on this text.
#[cfg(target_os = "macos")]
async fn log_registry() {
    let listing = run_tool_capturing(PLUGINKIT_BIN, &[OsStr::new("-m"), OsStr::new("-p"), OsStr::new("com.apple.FinderSync")]).await;
    if let Some(listing) = listing {
        tracing::info!(registry = %listing.trim(), "finder sync extensions registered with the system");
    } else {
        tracing::info!("finder sync extension registry could not be listed");
    }
}

/// Make the system aware the extension exists, without switching it on.
///
/// **Two stages, and the first was missing.** macOS discovers app extensions in
/// order: `lsd` builds a LaunchServices bundle record for the containing app,
/// and THAT record seeds PlugInKit, which then finds the `.appex` inside. Both
/// `pluginkit` verbs act on the appex database, which is downstream of the seed
/// — so when the seed never happened they have nothing to work from.
///
/// That is not hypothetical. A colleague's Mac ran a correctly-installed
/// `/Applications/Hippius.app` for six days with the appex on disk and
/// `pluginkit -mAvvv -p com.apple.FinderSync` answering `(no matches)` — a
/// system-wide query, so nothing was registered at all, which is upstream of any
/// System Settings behaviour. It began working 69 seconds after a macOS upgrade,
/// whose unified log shows `lsd` building the bundle record and `pkd` discovering
/// the plugin immediately after. The app bundle was never modified. Any macOS
/// version can land in this state; the LaunchServices layer has been reported
/// unreliable since 2017, and nothing user-facing can force re-discovery.
///
/// `lsregister -f` forces that first stage on demand. Note the flag is `-f`
/// alone: `-R` means "recurse into packages", which for a single `.app` descends
/// INTO the bundle rather than registering it.
///
/// **That `lsregister` re-seeds PlugInKit is inferred, not proven.** The evidence
/// shows an OS-driven bundle-record rebuild being followed by discovery, not that
/// a manual invocation produces the same. It is cheap, idempotent and contained,
/// so it is worth running first — but every caller must still handle it not
/// working, which is why this reports a bool nobody is required to act on.
///
/// Contained exactly as `run_pluginkit` is: output never parsed, failure never
/// fatal.
#[cfg(target_os = "macos")]
async fn register_with_the_system(bundle: &std::path::Path, appex: &std::path::Path) -> bool {
    let seeded = run_tool(LSREGISTER_BIN, &[OsStr::new("-f"), bundle.as_os_str()]).await;
    let discovered = run_pluginkit(&[OsStr::new("-a"), appex.as_os_str()]).await;

    tracing::debug!(seeded, discovered, "registered the Finder extension with the system");
    seeded || discovered
}

/// Keep the Finder extension in the state the user wants, at launch.
///
/// This is how every Finder Sync peer does it — MEGAsync, ownCloud and
/// Nextcloud all elect their extension themselves and none of them nag — with
/// one addition: an explicit "off" from the user is never overridden. The
/// decision table is [`launch_action`]; in short, a fresh install is elected
/// once, a wanted extension is re-elected after an app or macOS update (the
/// events that flip or stale it in the field), and an extension the user
/// switched off in steady state is only registered so the pane can list it,
/// leaving the nudge to ask.
///
/// Spawned from `main.rs` once the database is open, because the preference
/// and the fingerprint live there. Settles `AppState::finder_launch_check` on
/// every exit path, which is what lets `finder_extension_state` wait for the
/// verdict instead of nudging over an election in progress.
#[cfg(target_os = "macos")]
pub async fn ensure_finder_extension_at_launch(app: AppHandle) {
    // Same refusal as the enable path: registering a randomized
    // `…/AppTranslocation/<UUID>/d/` path writes a soon-to-vanish bundle into
    // the LaunchServices database, which is worse than doing nothing.
    if crate::utils::app_location::is_app_translocated() {
        tracing::debug!("skipping the Finder extension launch check: the app is translocated");
    } else if let Err(err) = launch_check(&app).await {
        tracing::warn!(%err, "finder extension launch check could not run");
    }

    app.state::<AppState>().finder_launch_check.send_replace(true);
}

#[cfg(target_os = "macos")]
async fn launch_check(app: &AppHandle) -> Result<()> {
    let Some((bundle, appex)) = hosting::current_build_bundle_and_appex() else {
        tracing::debug!("this build embeds no Finder extension; nothing to elect at launch");
        return Ok(());
    };
    let app_state = app.state::<AppState>();
    let pool = app_state.pool()?;

    let before = read_state(app).await;
    let preference = load_preference(pool).await;
    let fingerprint = ElectionFingerprint::current();
    let fingerprint_changed = load_fingerprint(pool).await.as_deref() != Some(fingerprint.as_str());
    let action = launch_action(preference, before, fingerprint_changed);

    match action {
        LaunchAction::Nothing => {}
        LaunchAction::RegisterOnly => {
            register_with_the_system(&bundle, &appex).await;
        }
        LaunchAction::RegisterAndElect => {
            register_with_the_system(&bundle, &appex).await;
            tokio::time::sleep(DISCOVERY_WAIT).await;
            elect().await;
        }
        LaunchAction::Reelect => {
            register_with_the_system(&bundle, &appex).await;
            unelect().await;
            tokio::time::sleep(REELECT_WAIT).await;
            elect().await;
        }
    }

    let after = read_state(app).await;
    tracing::info!(?action, ?before, ?after, fingerprint_changed, "finder extension launch check");
    if action != LaunchAction::Nothing {
        log_registry().await;
    }
    // `Unwanted` never reaches an election above, so adopting here can only
    // ever record a `None` or `Wanted` preference as `Wanted`.
    if after == FinderExtensionState::Enabled && preference != Some(FinderExtensionPreference::Unwanted) {
        adopt_election(pool, &fingerprint).await;
    }
    Ok(())
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
    run_tool(PLUGINKIT_BIN, args).await
}

/// Run a helper and hand back its stdout, for logging only.
///
/// Same containment as [`run_tool`]; the text is never branched on. `None`
/// on any failure, so a caller has nothing to log rather than a fragment.
#[cfg(target_os = "macos")]
async fn run_tool_capturing(bin: &str, args: &[&OsStr]) -> Option<String> {
    let output = tokio::process::Command::new(bin).args(args).kill_on_drop(true).output();
    match tokio::time::timeout(TOOL_TIMEOUT, output).await {
        Ok(Ok(out)) if out.status.success() => Some(String::from_utf8_lossy(&out.stdout).into_owned()),
        Ok(Ok(_) | Err(_)) | Err(_) => None,
    }
}

/// Run one of the undocumented LaunchServices/PlugInKit helpers.
///
/// Shared by `pluginkit` and `lsregister`, which need identical containment:
/// both are debugging tools Apple's DTS says not to architect around, so output
/// is never parsed, failure is never fatal, and the caller falls back to asking
/// the system what actually happened.
#[cfg(target_os = "macos")]
async fn run_tool(bin: &str, args: &[&OsStr]) -> bool {
    // `kill_on_drop` matters on the timeout branch: `timeout` only drops the
    // future, and tokio's default would leave the child running unsupervised
    // while the caller immediately starts the NEXT invocation — two concurrent
    // writers to one system database, the opposite of what the timeout is for.
    let output = tokio::process::Command::new(bin).args(args).kill_on_drop(true).output();

    match tokio::time::timeout(TOOL_TIMEOUT, output).await {
        Ok(Ok(out)) if out.status.success() => true,
        Ok(Ok(out)) => {
            tracing::warn!(
                tool = bin,
                status = ?out.status.code(),
                stderr = %String::from_utf8_lossy(&out.stderr).trim(),
                "exited non-zero while registering the Finder extension"
            );
            false
        }
        Ok(Err(err)) => {
            tracing::warn!(tool = bin, %err, "could not run the tool to register the Finder extension");
            false
        }
        Err(_elapsed) => {
            tracing::warn!(tool = bin, timeout = ?TOOL_TIMEOUT, "timed out while registering the Finder extension");
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
    /// *this app's* Finder extension on?
    ///
    /// Available since macOS 10.14, and this send is deliberately unguarded: the
    /// app's `LSMinimumSystemVersion` is 11.0, so the selector always exists.
    /// That was NOT true until 2026-08-27 — the floor was Tauri's default
    /// 10.13.0 while this comment claimed otherwise, which made a 10.13 launch
    /// abort on an unrecognized selector. `tests/release_lane_pins.rs` now pins
    /// the floor so the claim cannot go stale again.
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
mod policy_tests {
    use super::policy::{
        ElectionFingerprint, LaunchAction, launch_action, load_fingerprint, load_preference, product_build_version, report_state, store_preference,
    };
    use super::{FinderExtensionPreference, FinderExtensionState};
    use FinderExtensionPreference::{Unwanted, Wanted};
    use FinderExtensionState::{Disabled, Enabled, Muted, Unsupported};

    // ── The launch decision table ─────────────────────────────────────────

    /// A fresh install switches the extension on by itself, like every
    /// Finder Sync peer; there is nothing to ask the user before they have
    /// seen the feature missing.
    #[test]
    fn a_fresh_install_is_elected_once() {
        assert_eq!(launch_action(None, Disabled, true), LaunchAction::RegisterAndElect);
        assert_eq!(launch_action(None, Disabled, false), LaunchAction::RegisterAndElect);
    }

    /// Never asked, already on: a developer Mac or a user who flipped it in
    /// System Settings. Adopt, do nothing.
    #[test]
    fn an_already_enabled_extension_is_left_alone_on_first_sight() {
        assert_eq!(launch_action(None, Enabled, true), LaunchAction::Nothing);
    }

    /// The one guarantee the peers do not give: an explicit off is never
    /// overridden — not on an update, not in steady state.
    #[test]
    fn an_explicit_off_is_never_touched() {
        for changed in [true, false] {
            assert_eq!(launch_action(Some(Unwanted), Disabled, changed), LaunchAction::Nothing);
            assert_eq!(launch_action(Some(Unwanted), Enabled, changed), LaunchAction::Nothing);
        }
    }

    /// After an app or macOS update a wanted extension is re-elected whether
    /// the system reads it as off (the update flipped it) or on (Finder may
    /// still be holding the previous bundle's extension host).
    #[test]
    fn an_update_reelects_a_wanted_extension() {
        assert_eq!(launch_action(Some(Wanted), Disabled, true), LaunchAction::Reelect);
        assert_eq!(launch_action(Some(Wanted), Enabled, true), LaunchAction::Reelect);
    }

    /// Steady state, wanted, off: the user turned it off in System Settings
    /// since we last saw it on. Make sure the pane can list it; let the nudge
    /// ask once rather than flipping it back behind their back.
    #[test]
    fn steady_state_off_only_registers() {
        assert_eq!(launch_action(Some(Wanted), Disabled, false), LaunchAction::RegisterOnly);
    }

    #[test]
    fn enabled_and_unchanged_does_nothing() {
        assert_eq!(launch_action(Some(Wanted), Enabled, false), LaunchAction::Nothing);
    }

    /// No extension to speak of (dev build, non-macOS, failed hop): nothing
    /// to register or elect, whatever was stored.
    #[test]
    fn unsupported_does_nothing() {
        for preference in [None, Some(Wanted), Some(Unwanted)] {
            assert_eq!(launch_action(preference, Unsupported, true), LaunchAction::Nothing);
            assert_eq!(launch_action(preference, Muted, true), LaunchAction::Nothing);
        }
    }

    // ── What the frontend is told ──────────────────────────────────────────

    #[test]
    fn an_unwanted_off_extension_reports_as_muted() {
        assert_eq!(report_state(Disabled, Some(Unwanted)), Muted);
    }

    #[test]
    fn every_other_reading_passes_through() {
        assert_eq!(report_state(Disabled, Some(Wanted)), Disabled);
        assert_eq!(report_state(Disabled, None), Disabled);
        // The user said no but turned it on in System Settings anyway: the
        // truth wins, and the Settings switch shows it on.
        assert_eq!(report_state(Enabled, Some(Unwanted)), Enabled);
        assert_eq!(report_state(Unsupported, Some(Unwanted)), Unsupported);
    }

    // ── The fingerprint ────────────────────────────────────────────────────

    #[test]
    fn the_fingerprint_changes_with_either_half() {
        let base = ElectionFingerprint::new("0.6.1", "25G83");
        assert_eq!(base, ElectionFingerprint::new("0.6.1", "25G83"));
        assert_ne!(base, ElectionFingerprint::new("0.6.2", "25G83"), "an app update must re-elect");
        assert_ne!(base, ElectionFingerprint::new("0.6.1", "25G90"), "a macOS update must re-elect");
        assert_eq!(base.as_str(), "0.6.1|25G83");
    }

    #[test]
    fn the_macos_build_is_read_out_of_the_system_version_plist() {
        let plist = r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>ProductBuildVersion</key>
	<string>25G83</string>
	<key>ProductName</key>
	<string>macOS</string>
	<key>ProductVersion</key>
	<string>26.6.2</string>
</dict>
</plist>"#;
        assert_eq!(product_build_version(plist).as_deref(), Some("25G83"));
        assert_eq!(product_build_version("<plist><dict></dict></plist>"), None);
        assert_eq!(
            product_build_version("<key>ProductBuildVersion</key><string></string>"),
            None,
            "an empty build is no build"
        );
    }

    // ── The settings store ─────────────────────────────────────────────────

    async fn pool() -> sqlx::SqlitePool {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.expect("memory sqlite");
        sqlx::query(
            "CREATE TABLE user_preferences (
                preference_key TEXT PRIMARY KEY,
                preference_value TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            )",
        )
        .execute(&pool)
        .await
        .expect("create user_preferences");
        pool
    }

    #[tokio::test]
    async fn a_fresh_install_has_no_preference_and_no_fingerprint() {
        let pool = pool().await;
        assert_eq!(load_preference(&pool).await, None);
        assert_eq!(load_fingerprint(&pool).await, None);
    }

    #[tokio::test]
    async fn the_preference_round_trips_and_the_last_write_wins() {
        let pool = pool().await;
        store_preference(&pool, Wanted).await.expect("store wanted");
        assert_eq!(load_preference(&pool).await, Some(Wanted));
        store_preference(&pool, Unwanted).await.expect("store unwanted");
        assert_eq!(load_preference(&pool).await, Some(Unwanted));
    }

    /// A value this build does not recognise reads as "never asked" rather
    /// than as either answer: guessing `Wanted` could elect over a refusal,
    /// guessing `Unwanted` could mute a user who never said so.
    #[tokio::test]
    async fn an_unrecognized_stored_value_reads_as_never_asked() {
        let pool = pool().await;
        crate::utils::preferences::save_user_preference_internal(&pool, "finder_extension_preference", "maybe")
            .await
            .expect("seed");
        assert_eq!(load_preference(&pool).await, None);
    }

    /// The store cannot be read at all (no table yet): never asked, so the
    /// worst case is a first-run election, never a muted or overridden user.
    #[tokio::test]
    async fn an_unreadable_store_reads_as_never_asked() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.expect("memory sqlite");
        assert_eq!(load_preference(&pool).await, None);
        assert_eq!(load_fingerprint(&pool).await, None);
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
    use super::{FINDER_EXTENSION_BUNDLE_ID, FinderExtensionState};

    /// Wire-shape pin: the frontend switches on `kind`, so these three strings are
    /// the contract. A `rename_all` or variant rename would silently turn the
    /// nudge off (every state stops matching `"disabled"`).
    #[test]
    fn state_serializes_to_the_tagged_wire_shape() {
        let json = |state: FinderExtensionState| serde_json::to_value(state).expect("serialize");

        assert_eq!(json(FinderExtensionState::Enabled), serde_json::json!({"kind": "enabled"}));
        assert_eq!(json(FinderExtensionState::Disabled), serde_json::json!({"kind": "disabled"}));
        assert_eq!(json(FinderExtensionState::Muted), serde_json::json!({"kind": "muted"}));
        assert_eq!(json(FinderExtensionState::Unsupported), serde_json::json!({"kind": "unsupported"}));
    }

    /// The `set_finder_extension_preference` argument is the same lowercase
    /// word the settings store holds, so the frontend sends one string.
    #[test]
    fn preference_deserializes_from_its_wire_word() {
        let parse = |raw: &str| serde_json::from_value::<super::FinderExtensionPreference>(serde_json::Value::String(raw.into()));
        assert_eq!(parse("wanted").expect("wanted"), super::FinderExtensionPreference::Wanted);
        assert_eq!(parse("unwanted").expect("unwanted"), super::FinderExtensionPreference::Unwanted);
        assert!(parse("Wanted").is_err(), "the wire word is lowercase, like the state kinds");
    }

    /// The source text of the named `pub async fn`, from its signature to its
    /// closing brace.
    ///
    /// Runtime translocation cannot be simulated in a unit test, so the two
    /// gates below are pinned at their call sites — the repo's
    /// `tests/*_wiring.rs` idiom.
    ///
    /// The end bound is the closing brace in COLUMN ZERO, and a missing one is
    /// a panic rather than "take the rest of the file". Both details are what
    /// keep these pins from passing vacuously: this reads the very file the
    /// assertions live in, and those assertions contain the literal they search
    /// for. A slice that overran its function would find the needle in the test
    /// source and keep reporting success with the gate deleted — the exact
    /// regression the pins exist to catch. An earlier version bounded on the
    /// next `\n///` and fell back to the file end, which would have overrun the
    /// moment a command became the last one with no doc comment after it.
    fn command_body(name: &str) -> String {
        body_of(&format!("pub async fn {name}"))
    }

    /// Same bound as [`command_body`], for a private fn named by its full
    /// declaration prefix (e.g. `async fn launch_check`).
    fn body_of(declaration: &str) -> String {
        let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/finder_bridge/enablement.rs")).expect("read enablement.rs");
        let start = src.find(declaration).unwrap_or_else(|| panic!("{declaration} is declared"));
        let body = &src[start..];
        // Every brace nested inside the function is indented, so the first
        // `\n}` is the function's own close.
        let end = body
            .find("\n}")
            .unwrap_or_else(|| panic!("{declaration} has a closing brace in column zero"));

        body[..end].to_string()
    }

    /// The translocation gate, as both call sites spell it.
    ///
    /// Matched with the `if` and without a `!` so an INVERTED gate fails the
    /// pin — a bare `is_app_translocated` needle is blind to polarity, and
    /// `if !…` would sail through while doing the opposite of the intent. The
    /// cost is that importing the function would fail these pins; that is the
    /// right direction to fail in, since the fix is one line and the alternative
    /// is a guard that silently stops guarding.
    const TRANSLOCATION_GATE: &str = "if crate::utils::app_location::is_app_translocated() {";

    /// Wiring pin: the state check must stay silent on a translocated bundle.
    ///
    /// A copy opened from the mounted DMG has an unregistrable extension, so
    /// `Disabled` is accurate and useless: the nudge would fire on every window
    /// focus, its Enable button would refuse, and the Settings pane it falls
    /// back to could not list Hippius. `TranslocationGuard` already tells the
    /// user the one thing that helps.
    #[test]
    fn the_state_check_ignores_a_translocated_bundle() {
        assert!(
            body_of("async fn read_state(").contains(TRANSLOCATION_GATE),
            "read_state must report Unsupported while translocated; otherwise the nudge \
             nags with an Enable button that cannot succeed"
        );
        assert!(
            command_body("finder_extension_state").contains("read_state(&app)"),
            "finder_extension_state must read through read_state, where the translocation gate lives"
        );
    }

    /// Wiring pin: the launch check decides through the tested table, and
    /// electing is one of that table's outcomes — never a bare verb the table
    /// did not choose.
    ///
    /// The table (`launch_action`) is what keeps an explicit off from being
    /// overridden and a steady-state off from being flipped; a launch path
    /// that elected on its own initiative would bypass both guarantees while
    /// every unit test stayed green.
    #[test]
    fn the_launch_check_decides_through_the_tested_table() {
        let body = body_of("async fn launch_check(");

        assert!(
            body.contains("launch_action("),
            "launch_check must route its decision through launch_action"
        );
        assert!(
            !body.contains(FINDER_EXTENSION_BUNDLE_ID) && !body.contains("\"use\""),
            "launch_check must elect only through elect(), inside a LaunchAction arm"
        );
        assert!(
            body.contains("register_with_the_system"),
            "launch_check must be able to register — a first run has nothing to elect otherwise"
        );
    }

    /// Wiring pin: the launch check must refuse a translocated bundle.
    ///
    /// `lsregister -f` on a `…/AppTranslocation/<UUID>/d/` path writes a
    /// bundle record for a directory that is gone by the next launch — worse
    /// than the election hazard the enable path already guards, because it
    /// pollutes the LaunchServices database rather than just the appex one.
    #[test]
    fn the_launch_check_ignores_a_translocated_bundle() {
        assert!(
            command_body("ensure_finder_extension_at_launch").contains(TRANSLOCATION_GATE),
            "ensure_finder_extension_at_launch must skip a translocated bundle; registering an \
             ephemeral path writes a soon-to-vanish record into the LaunchServices database"
        );
    }

    /// Wiring pin: the launch check settles the latch on every path, or the
    /// frontend's first state query waits the full cap for nothing.
    #[test]
    fn the_launch_check_always_settles_the_latch() {
        let body = command_body("ensure_finder_extension_at_launch");
        let settle = body
            .rfind("finder_launch_check.send_replace(true)")
            .expect("the launch check settles the latch");
        assert!(
            !body[settle..].contains("return"),
            "nothing may return after the latch is settled, and nothing before it may return early"
        );
        assert!(
            !body[..settle].contains("return;"),
            "an early return before the latch strands finder_extension_state on its cap"
        );
    }

    /// Wiring pin: switching the extension OFF happens in exactly two places —
    /// the user's own preference, and the post-update re-election that turns it
    /// straight back on. A third `ignore` would be a way for the app to switch
    /// off something the user turned on.
    #[test]
    fn only_the_preference_and_the_reelection_may_switch_the_extension_off() {
        let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/finder_bridge/enablement.rs")).expect("read enablement.rs");
        let tests_start = src
            .find("#[cfg(all(test, target_os = \"macos\"))]")
            .expect("test modules follow the production code");
        let production = &src[..tests_start];

        let ignore_verbs = production.matches("OsStr::new(\"ignore\")").count();
        assert_eq!(ignore_verbs, 1, "the ignore verb belongs to unelect() alone");
        let unelect_calls = production.matches("unelect().await").count();
        assert_eq!(
            unelect_calls, 2,
            "unelect() is called from set_finder_extension_preference and the Reelect arm, nowhere else"
        );
    }

    /// Wiring pin: registration must seed LaunchServices BEFORE PlugInKit.
    ///
    /// macOS discovers extensions in that order — `lsd` builds the app's bundle
    /// record, and that record seeds `pkd`, which then finds the appex. Both
    /// `pluginkit` verbs act downstream of the seed, so running them alone
    /// cannot help an app LaunchServices has never recorded. Reversing the order
    /// here would look fine and fix nothing.
    #[test]
    fn registration_seeds_launch_services_before_pluginkit() {
        let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/finder_bridge/enablement.rs")).expect("read enablement.rs");
        let start = src
            .find("async fn register_with_the_system")
            .expect("register_with_the_system is declared");
        let body = &src[start..];
        let end = body.find("\n}").expect("register_with_the_system has a closing brace in column zero");
        let body = &body[..end];

        let seed = body
            .find("LSREGISTER_BIN")
            .expect("registration must run lsregister to seed LaunchServices");
        let discover = body.find("run_pluginkit").expect("registration must run pluginkit to register the appex");

        assert!(
            seed < discover,
            "lsregister must run BEFORE pluginkit: PlugInKit discovers the appex from the \
             LaunchServices bundle record, so seeding second cannot help an app that has none"
        );
    }

    /// Wiring pin: the enable path must refuse to run from a translocated
    /// bundle.
    ///
    /// Registering the randomized `…/AppTranslocation/<UUID>/d/` path elects an
    /// ephemeral copy by bundle identifier, which can leave the real
    /// `/Applications` install reporting `Disabled` for good — the button would
    /// make the very bug it exists to fix worse, for the fresh-from-DMG users it
    /// targets.
    #[test]
    fn the_enable_path_refuses_a_translocated_bundle() {
        assert!(
            command_body("enable_finder_extension").contains(TRANSLOCATION_GATE),
            "enable_finder_extension must refuse to register from a translocated bundle; \
             electing an ephemeral copy can strand the real install as Disabled"
        );
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
