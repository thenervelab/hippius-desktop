//! Update checks, pointed at the manifest of the channel this build came from.
//!
//! **Why this is in Rust rather than the frontend.** The updater must ask its
//! OWN lane for updates, and only Rust can express that. `tauri.conf.json`'s
//! `plugins.updater.endpoints` is a single compile-time list shared by every
//! branch, `tauri_plugin_updater::Builder` exposes no `endpoints` setter, and
//! the JS `check()`'s `CheckOptions` carries `headers`, `timeout`, `proxy`,
//! `target` and `allowDowngrades` — no endpoints either. Only
//! `UpdaterExt::updater_builder().endpoints(..)` can retarget a check, and that
//! is Rust-only.
//!
//! Getting this wrong is not a missing feature, it is a silent wrong-lane
//! install. With every lane sharing one signing key, a staging build asking the
//! PRODUCTION endpoint receives a manifest whose signature verifies, and
//! replaces the build under test with a production release — no error, no
//! prompt, and the tester loses what they were testing. Before the keys were
//! unified the same mismatch merely failed verification, so the misconfiguration
//! was invisible AND harmless; unifying the keys made it harmful. That is why
//! `ReleaseChannel::manifest_url()` returning `None` for staging is enforced
//! here, at the only place that performs a check.

use serde::Serialize;
// `tauri::Url` is Tauri's re-export of `url::Url`, so the endpoint type matches
// the plugin's without taking a direct dependency on `url` for one call.
use tauri::ipc::Channel;
use tauri::utils::config::BundleType;
use tauri::utils::platform::bundle_type;
use tauri::{AppHandle, Url};
use tauri_plugin_updater::UpdaterExt;
use tracing::{debug, error, info, warn};

use crate::error::{AppError, Result};
use crate::release_channel::{self, ReleaseChannel};

/// An update the running channel is offering.
///
/// `channel` rides along so the frontend can say WHICH lane the update comes
/// from — on a beta build "Update to 0.5.0-beta.4" is a different proposition
/// from the same string on production, and the user opted into knowing that.
///
/// `install_in_place` is false for packages plugin-updater cannot write as the
/// current user (a `.deb` / `.rpm`). The dialog must then open the release page
/// rather than call [`install_update`] — calling it would download a `.deb` and
/// fail with `Permission denied (os error 13)`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableUpdate {
    pub version: String,
    pub current_version: String,
    pub notes: String,
    pub channel: ReleaseChannel,
    pub install_in_place: bool,
    pub release_page_url: String,
    pub manual_install_hint: String,
}

/// Download progress, mirroring `ShareProgress`'s camelCase wire shape.
///
/// `bytesTotal` is optional because a manifest's asset may be served without a
/// Content-Length; the frontend renders an indeterminate bar in that case rather
/// than dividing by zero.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub bytes_done: u64,
    pub bytes_total: Option<u64>,
}

/// How many times this app's on-disk state has changed in a way an older build
/// cannot read. Bumped BY HAND, and only for such a change.
///
/// It is not a version number and must not track one. Bumping it on every
/// release would block every channel switch; never bumping it when a real
/// breaking change lands lets a downgraded build read state it does not
/// understand. The manifest of each lane carries the epoch of the build it
/// advertises, which is what makes a cross-channel comparison possible at all.
const STATE_EPOCH: u32 = 1;

/// The key `tauri-beta.yml` writes into `latest.json` beside `version`.
///
/// Tauri ignores unknown manifest keys and hands the whole document back on
/// `Update::raw_json`, so this rides along at no cost.
const STATE_EPOCH_MANIFEST_KEY: &str = "stateEpoch";

/// The channel a build of `current` can switch to, if any.
///
/// Production and beta are each other's only target. Staging is not a switch
/// target and cannot switch out: it is the internal lane, installed by hand and
/// publishing no manifest, so there is nothing to install from and nothing to
/// go back to.
pub fn switch_target(current: ReleaseChannel) -> Option<ReleaseChannel> {
    match current {
        ReleaseChannel::Production => Some(ReleaseChannel::Beta),
        ReleaseChannel::Beta => Some(ReleaseChannel::Production),
        ReleaseChannel::Staging => None,
    }
}

/// Whether switching to a build at `target_epoch` is safe for state written by
/// a build at `local_epoch`.
///
/// **A missing target epoch permits the switch.** Two reasons, and the first is
/// decisive: no manifest carried this field before it was introduced, so
/// refusing on absence would block every switch at rollout — a guard that
/// blocks everything is indistinguishable from a broken feature. The second is
/// that absence means "this build predates the concept", which is only
/// dangerous if a breaking change also landed, and that is precisely what
/// bumping the epoch is for.
///
/// Equal epochs pass. Production trailing beta by version is NOT a downgrade in
/// this sense and must not be treated as one — that mistake would make the
/// return path a one-way door, since production always trails beta by design.
pub fn downgrade_is_safe(local_epoch: u32, target_epoch: Option<u32>) -> bool {
    target_epoch.is_none_or(|target| target >= local_epoch)
}

/// Read the state epoch a manifest advertises, if it advertises one.
///
/// Anything unparseable — absent, null, a string, a negative number — reads as
/// `None`, i.e. "unknown", which [`downgrade_is_safe`] permits. A malformed
/// field must not be louder than a missing one; both mean the same thing.
fn manifest_state_epoch(raw: &serde_json::Value) -> Option<u32> {
    raw.get(STATE_EPOCH_MANIFEST_KEY)?.as_u64()?.try_into().ok()
}

/// Build an updater aimed at `channel`'s manifest.
///
/// `None` when the channel publishes no manifest — staging, which is installed
/// by hand. Every caller must treat that as "no update", never as an error: it
/// is the designed state of that lane, not a failure.
///
/// `cross_channel` replaces the version comparator with one that always offers
/// the remote build. It must be `false` for a routine check — a beta build must
/// never silently walk backwards — and `true` for an explicit switch, where the
/// target is a DIFFERENT lane whose version legitimately trails: production sits
/// at `0.4.0` while beta is already at `0.5.0-beta.3`, so the default comparator
/// would report "no update" and the switch would do nothing at all.
fn updater_for(app: &AppHandle, channel: ReleaseChannel, cross_channel: bool) -> Result<Option<tauri_plugin_updater::Updater>> {
    let Some(manifest) = channel.manifest_url() else {
        debug!(?channel, "channel publishes no update manifest; skipping the check");
        return Ok(None);
    };

    // Every failure below is a build misconfiguration, not something the user
    // did or can fix, so they all reach the frontend as one sentence and the
    // diagnostic detail is left to the log. `every_manifest_url_parses` pins
    // the only one of the three that a source edit can realistically cause.
    let misconfigured = |err: &dyn std::fmt::Display| {
        error!(?channel, %err, "the updater could not be pointed at this channel's manifest");
        AppError::Other("This build's updater is not configured correctly. Reinstall Hippius to update.".into())
    };

    let url = Url::parse(manifest).map_err(|err| misconfigured(&err))?;

    let mut builder = app.updater_builder().endpoints(vec![url]).map_err(|err| misconfigured(&err))?;

    if cross_channel {
        builder = builder.version_comparator(|_current, _remote| true);
    }

    let updater = builder.build().map_err(|err| misconfigured(&err))?;

    Ok(Some(updater))
}

/// Whether the running build's own channel is offering a newer version.
///
/// Infallible in spirit: a network failure is an error the caller may show, but
/// a channel with no manifest is simply `None`.
#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<Option<AvailableUpdate>> {
    // A debug build is compiled from source, not installed from a lane, so no
    // manifest can meaningfully update it. Without this skip a local dev run
    // resolves to the Production channel (unset HIPPIUS_RELEASE_CHANNEL fails
    // safe there) and nags on every launch: semver orders any published
    // release above the working tree's `-dev.N` version. Release builds are
    // unaffected — `debug_assertions` is off for every shipped lane.
    //
    // `HIPPIUS_DEV_UPDATE_CHECK=1` re-enables the check for a dev run so the
    // update dialog/flow can still be exercised locally (e.g. with a lowered
    // version in tauri.conf.json). Runtime env on purpose: it needs no
    // rebuild, and in release builds this whole branch is compiled out, so
    // the variable can never affect anything a user runs.
    if cfg!(debug_assertions) && std::env::var("HIPPIUS_DEV_UPDATE_CHECK").is_err() {
        debug!("debug build — skipping update check (set HIPPIUS_DEV_UPDATE_CHECK=1 to test the updater)");
        return Ok(None);
    }

    let channel = release_channel::current();

    let Some(updater) = updater_for(&app, channel, false)? else {
        return Ok(None);
    };

    let found = updater.check().await.map_err(|err| check_failure(channel, &err))?;

    let Some(update) = found else {
        debug!(?channel, "no update available");
        return Ok(None);
    };

    info!(?channel, version = %update.version, current = %update.current_version, "update available");
    Ok(Some(available_update_from(
        channel,
        &update.version,
        &update.current_version,
        update.body.as_deref().unwrap_or(""),
    )))
}

/// Human name of a lane, for copy the user reads.
fn channel_name(channel: ReleaseChannel) -> &'static str {
    match channel {
        ReleaseChannel::Production => "stable",
        ReleaseChannel::Beta => "beta",
        ReleaseChannel::Staging => "staging",
    }
}

/// Where a user can pick up an installer by hand for `channel`.
///
/// Production resolves through `releases/latest`, which GitHub only ever points
/// at a non-prerelease. Beta and staging builds ARE prereleases, which that
/// alias never resolves to, so they get the releases index instead — sending a
/// beta user to `/latest` would hand them the stable build and silently move
/// them off the lane they opted into.
fn release_page_url(channel: ReleaseChannel) -> &'static str {
    match channel {
        ReleaseChannel::Production => "https://github.com/thenervelab/hippius-desktop/releases/latest",
        ReleaseChannel::Beta | ReleaseChannel::Staging => "https://github.com/thenervelab/hippius-desktop/releases",
    }
}

/// How to install `channel`'s build by hand, phrased for the package THIS
/// binary was shipped in.
///
/// Keyed on the bundle, not the OS. A `.deb` and an AppImage are both Linux and
/// are installed by different means, so `cfg!(target_os = "linux")` would name
/// the wrong artifact the moment a second Linux target ships — and naming a
/// file the user cannot use is worse than saying nothing. `bundle_type()` reads
/// the marker tauri-bundler patches into the binary.
///
/// The marker is absent from the shipped `.deb` (see
/// [`in_place_install_supported`]), so on Linux `None` is the released package
/// rather than a dev build, and `.deb` is the only Linux artifact this project
/// publishes. Sending that user to "the installer" names a file the release
/// page does not carry, which is the failure this hint exists to avoid.
fn manual_install_hint(channel: ReleaseChannel) -> String {
    manual_install_hint_on(channel, bundle_type(), cfg!(target_os = "linux"))
}

fn manual_install_hint_on(channel: ReleaseChannel, bundle: Option<BundleType>, on_linux: bool) -> String {
    let url = release_page_url(channel);
    let deb = format!("Download the .deb from {url} and install it with your package manager.");

    match bundle {
        Some(BundleType::Deb) => deb,
        Some(BundleType::Rpm) => format!("Download the .rpm from {url} and install it with your package manager."),
        Some(BundleType::AppImage) => format!("Download the AppImage from {url} and replace the one you are running."),
        None if on_linux => deb,
        _ => format!("Download the installer from {url} and run it."),
    }
}

/// Whether plugin-updater can replace THIS bundle as the current user.
///
/// A `.deb` / `.rpm` needs `dpkg`/`rpm` plus root. The plugin tries pkexec,
/// then a graphical sudo prompt, then terminal sudo; a normal desktop session
/// (QA on amd64, 0.6.0-beta.4 → 0.6.0-beta.5) got `Permission denied (os error
/// 13)` instead of a prompt. AppImage, NSIS, MSI, and macOS `.app` write files
/// the user owns.
///
/// **On Linux, an unknown bundle must refuse.** `bundle_type()` reads a marker
/// tauri-bundler patches into the binary, and it does NOT patch the `.deb`:
/// the published `usr/bin/Hippius` still carries the literal
/// `__TAURI_BUNDLE_TYPE_VAR_UNK`, so the shipped package reports `None`. Only
/// macOS has a hard-coded fallback (`Some(App)`). Treating `None` as "try the
/// plugin" therefore describes the shipped `.deb`, not a dev build, and sends
/// it into `install_appimage`, which renames `/usr/bin/Hippius` and produces
/// exactly the `Permission denied (os error 13)` this exists to prevent.
fn in_place_install_supported(bundle: Option<BundleType>) -> bool {
    in_place_install_supported_on(bundle, cfg!(target_os = "linux"))
}

/// `in_place_install_supported` with the host split out, so both platform
/// answers are pinned from whichever runner the suite happens to run on.
fn in_place_install_supported_on(bundle: Option<BundleType>, on_linux: bool) -> bool {
    match bundle {
        Some(BundleType::Deb | BundleType::Rpm) => false,
        Some(BundleType::AppImage | BundleType::Msi | BundleType::Nsis | BundleType::App | BundleType::Dmg) => true,
        // Unknown: the shipped Linux artifact, or an unbundled `cargo run`
        // elsewhere. Only the second one is safe to hand to the plugin.
        None => !on_linux,
    }
}

/// Refuse Deb/Rpm in-place install before the plugin downloads a payload it
/// cannot apply. Must run AFTER the re-check so "already up to date" still
/// wins, and BEFORE `download_and_install` so a `.deb` is never fetched only
/// to fail with EACCES.
fn refuse_if_privileged_package(channel: ReleaseChannel) -> Result<()> {
    if in_place_install_supported(bundle_type()) {
        return Ok(());
    }

    Err(privileged_package_manual_install(channel))
}

fn privileged_package_manual_install(channel: ReleaseChannel) -> AppError {
    AppError::Validation(format!(
        "This package cannot be updated from inside the app. {}",
        manual_install_hint(channel)
    ))
}

fn available_update_from(channel: ReleaseChannel, version: &str, current_version: &str, notes: &str) -> AvailableUpdate {
    AvailableUpdate {
        version: version.to_string(),
        current_version: current_version.to_string(),
        notes: notes.to_string(),
        channel,
        install_in_place: in_place_install_supported(bundle_type()),
        release_page_url: release_page_url(channel).to_string(),
        manual_install_hint: manual_install_hint(channel),
    }
}

/// True when the plugin failed because this is a `.deb` / `.rpm` it cannot
/// apply as the current user. Io PermissionDenied is NOT this: macOS returns
/// that kind when the AppleScript admin move is declined, and AppImage
/// replace can EACCES a non-writable file — those bundles still support
/// in-place install.
fn is_privileged_package_failure(err: &tauri_plugin_updater::Error) -> bool {
    use tauri_plugin_updater::Error as UpdaterError;

    matches!(err, UpdaterError::DebInstallFailed | UpdaterError::PackageInstallFailed)
}

/// User-facing copy for a failed install; the raw error goes to the log.
///
/// The plugin's `Display` is diagnostics — "Failed to install package", a
/// reqwest chain, "temp directory is not on the same mount point". The dialog
/// and the toast show `message` verbatim, so whatever lands there IS the copy;
/// it is written here, and the original is left to `error!` for the support
/// bundle. Every arm ends in something the user can do next.
fn install_failure(channel: ReleaseChannel, err: &tauri_plugin_updater::Error) -> AppError {
    use tauri_plugin_updater::Error as UpdaterError;

    error!(?channel, %err, "could not install the update");

    let lead = if is_privileged_package_failure(err) {
        // QA on a `.deb` install: the plugin's Io Display is exactly
        // "Permission denied (os error 13)". That string is diagnostics. A
        // match that forwarded Display — or a user message that WAS the EACCES
        // line — is what the dialog must never show.
        "This package cannot be updated from inside the app."
    } else {
        match err {
            // The signature is checked against the pubkey compiled into the RUNNING
            // build. A mismatch means that copy carries a retired key, so no future
            // release can ever install over it — "try again later" is the one thing
            // that will never work, and a manual reinstall is the only way out.
            UpdaterError::Minisign(_) | UpdaterError::SignatureUtf8(_) => "This update could not be verified, so it was not installed.",
            // `dpkg`/`rpm` need root. The plugin escalates through pkexec, then a
            // graphical sudo prompt, then sudo; a session offering none of those
            // cannot finish the install however often it is retried.
            UpdaterError::AuthenticationFailed => "The update was not installed because the administrator prompt was declined or unavailable.",
            _ => "Could not install the update.",
        }
    };

    AppError::Validation(format!("{lead} {}", manual_install_hint(channel)))
}

/// User-facing copy for a failed update check; the raw error goes to the log.
fn check_failure(channel: ReleaseChannel, err: &tauri_plugin_updater::Error) -> AppError {
    error!(?channel, %err, "could not check for updates");

    AppError::Other(format!(
        "Could not reach the {} update channel. Try again in a moment.",
        channel_name(channel)
    ))
}

/// Download and install the update the running channel is offering.
///
/// Re-checks rather than holding a handle from [`check_for_update`]: the two
/// calls are separated by however long the user leaves the dialog open, and a
/// stale `Update` would install a version the manifest no longer advertises.
/// One extra request is a fair price for never installing something the user
/// was not shown.
///
/// Does NOT relaunch. The caller decides when to restart, because on the
/// channel-switch path it has a second thing to say first.
///
/// **Deb and RPM do not install in place.** plugin-updater applies a `.deb`
/// with `dpkg -i` behind pkexec; that path returned `Permission denied (os
/// error 13)` in QA rather than a prompt. [`refuse_if_privileged_package`]
/// returns the download instruction before the plugin is asked to write.
/// AppImage / macOS / Windows still call `download_and_install`. Gating the
/// whole command on `target_os = "linux"` would also disable AppImage.
#[tauri::command]
pub async fn install_update(app: AppHandle, on_progress: Channel<DownloadProgress>) -> Result<()> {
    let channel = release_channel::current();

    let Some(updater) = updater_for(&app, channel, false)? else {
        return Err(AppError::Validation("This build does not receive automatic updates.".into()));
    };

    let update = updater
        .check()
        .await
        .map_err(|err| check_failure(channel, &err))?
        .ok_or_else(|| AppError::Validation("There is no update to install.".into()))?;

    refuse_if_privileged_package(channel)?;

    let mut bytes_done: u64 = 0;
    let version = update.version.clone();

    update
        .download_and_install(
            |chunk, total| {
                bytes_done += chunk as u64;
                // A send failure means the webview dropped the channel (window
                // closed mid-download). The install itself should still finish.
                if let Err(err) = on_progress.send(DownloadProgress {
                    bytes_done,
                    bytes_total: total,
                }) {
                    debug!(%err, "update progress receiver is gone; continuing the download");
                }
            },
            || debug!("update download finished; installing"),
        )
        .await
        .map_err(|err| install_failure(channel, &err))?;

    info!(?channel, %version, "update installed; awaiting relaunch");
    Ok(())
}

/// What the channel-switch surface needs to render itself.
///
/// `targetVersion` is `None` when the target's manifest could not be read — an
/// offline machine, or a lane that has published nothing yet. The UI must then
/// offer the switch WITHOUT naming a version rather than hiding it: "we could
/// not reach the beta channel" is a different message from "there is no beta".
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelStatus {
    pub current: ReleaseChannel,
    pub target: Option<ReleaseChannel>,
    pub target_version: Option<String>,
    pub blocked_reason: Option<String>,
    /// False for Deb/Rpm: the switch dialog must open the target's release
    /// page rather than call [`switch_release_channel`].
    pub install_in_place: bool,
    pub release_page_url: String,
    pub manual_install_hint: String,
}

fn channel_status(
    current: ReleaseChannel,
    target: Option<ReleaseChannel>,
    target_version: Option<String>,
    blocked_reason: Option<String>,
) -> ChannelStatus {
    let page_channel = target.unwrap_or(current);

    ChannelStatus {
        current,
        target,
        target_version,
        blocked_reason,
        install_in_place: in_place_install_supported(bundle_type()),
        release_page_url: release_page_url(page_channel).to_string(),
        manual_install_hint: manual_install_hint(page_channel),
    }
}

/// The message shown when the epoch guard refuses a switch.
///
/// Names what the user can do next. "Blocked for data-safety reasons" tells
/// someone nothing they can act on; "wait for the stable release to catch up"
/// tells them the condition that clears it.
fn blocked_message(target: ReleaseChannel) -> String {
    let name = channel_name(target);

    format!("This build has already saved data that the {name} version cannot read. Wait for the {name} release to catch up.")
}

/// The running channel, the channel it can switch to, and what that channel is
/// currently publishing.
///
/// Never fails on a network problem: an unreachable manifest leaves
/// `targetVersion` empty rather than erroring, because the switch surface must
/// still render — a user who cannot reach GitHub should see the control and a
/// missing version, not a broken page.
#[tauri::command]
pub async fn release_channel_status(app: AppHandle) -> Result<ChannelStatus> {
    let current = release_channel::current();
    let Some(target) = switch_target(current) else {
        return Ok(channel_status(current, None, None, None));
    };

    let Some(updater) = updater_for(&app, target, true)? else {
        return Ok(channel_status(current, Some(target), None, None));
    };

    // The cross-channel comparator always offers, so `None` here means the
    // manifest could not be read at all, not "you are up to date".
    let found = match updater.check().await {
        Ok(found) => found,
        Err(err) => {
            warn!(?target, %err, "could not read the target channel's manifest");
            None
        }
    };

    let Some(update) = found else {
        return Ok(channel_status(current, Some(target), None, None));
    };

    let target_epoch = manifest_state_epoch(&update.raw_json);
    let blocked_reason = (!downgrade_is_safe(STATE_EPOCH, target_epoch)).then(|| blocked_message(target));
    if blocked_reason.is_some() {
        info!(
            ?target,
            local = STATE_EPOCH,
            ?target_epoch,
            "channel switch blocked by the state epoch guard"
        );
    }

    Ok(channel_status(current, Some(target), Some(update.version.clone()), blocked_reason))
}

/// Install the other channel's build, so the app restarts on that lane.
///
/// Does NOT relaunch — the caller does, after telling the user what happened.
///
/// `target` is checked against [`switch_target`] rather than trusted: the
/// frontend computes the same thing, and a mismatch means the two have drifted.
/// Installing whatever was asked for would be the wrong answer to that.
///
/// A failed install points at the TARGET channel's release page, not the
/// running one's: the user asked to leave this lane, so the stable build's
/// download page is no help to someone whose switch to beta failed.
#[tauri::command]
pub async fn switch_release_channel(app: AppHandle, target: String, on_progress: Channel<DownloadProgress>) -> Result<()> {
    let current = release_channel::current();
    let expected = switch_target(current).ok_or_else(|| AppError::Validation("This build cannot switch release channels.".into()))?;

    let requested = release_channel::parse_release_channel(Some(&target));
    if requested != expected {
        return Err(AppError::Validation(format!("Cannot switch from {current:?} to {requested:?}.")));
    }

    let updater =
        updater_for(&app, expected, true)?.ok_or_else(|| AppError::Validation("That channel does not publish installable builds.".into()))?;

    let update = updater.check().await.map_err(|err| check_failure(expected, &err))?.ok_or_else(|| {
        AppError::Validation(format!(
            "The {} channel is not publishing a build for this platform.",
            channel_name(expected)
        ))
    })?;

    // Re-checked here rather than trusting the status call: the two are
    // separated by however long the confirmation dialog stays open, and this is
    // the call that writes to disk.
    let target_epoch = manifest_state_epoch(&update.raw_json);
    if !downgrade_is_safe(STATE_EPOCH, target_epoch) {
        info!(
            ?expected,
            local = STATE_EPOCH,
            ?target_epoch,
            "refusing the channel switch: state epoch guard"
        );
        return Err(AppError::Validation(blocked_message(expected)));
    }

    refuse_if_privileged_package(expected)?;

    let mut bytes_done: u64 = 0;
    let version = update.version.clone();

    update
        .download_and_install(
            |chunk, total| {
                bytes_done += chunk as u64;
                if let Err(err) = on_progress.send(DownloadProgress {
                    bytes_done,
                    bytes_total: total,
                }) {
                    debug!(%err, "switch progress receiver is gone; continuing the download");
                }
            },
            || debug!("channel build downloaded; installing"),
        )
        .await
        .map_err(|err| install_failure(expected, &err))?;

    info!(from = ?current, to = ?expected, %version, "switched release channel; awaiting relaunch");
    Ok(())
}

/// The channel this build came from, for display.
///
/// Separate from [`check_for_update`] so the UI can name the current lane
/// without a network round-trip.
#[tauri::command]
pub fn current_release_channel() -> ReleaseChannel {
    let channel = release_channel::current();
    if channel == ReleaseChannel::Staging {
        // Support bundles: "why did this build never update?" is answered by
        // this one line rather than by reasoning about endpoints.
        warn!("running a staging build; automatic updates are disabled on this lane");
    }
    channel
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Wire-shape pins. The frontend reads these keys and there is no codegen
    /// between the two sides, so a field rename would surface as an update
    /// dialog with a blank version rather than as a compile error.
    #[test]
    fn available_update_serializes_camel_case() {
        let json = serde_json::to_value(AvailableUpdate {
            version: "0.5.0-beta.2".into(),
            current_version: "0.5.0-beta.1".into(),
            notes: "notes".into(),
            channel: ReleaseChannel::Beta,
            install_in_place: false,
            release_page_url: "https://github.com/thenervelab/hippius-desktop/releases".into(),
            manual_install_hint:
                "Download the .deb from https://github.com/thenervelab/hippius-desktop/releases and install it with your package manager.".into(),
        })
        .expect("serialize");

        assert_eq!(
            json,
            serde_json::json!({
                "version": "0.5.0-beta.2",
                "currentVersion": "0.5.0-beta.1",
                "notes": "notes",
                "channel": "beta",
                "installInPlace": false,
                "releasePageUrl": "https://github.com/thenervelab/hippius-desktop/releases",
                "manualInstallHint": "Download the .deb from https://github.com/thenervelab/hippius-desktop/releases and install it with your package manager.",
            })
        );
    }

    #[test]
    fn download_progress_serializes_camel_case() {
        let json = serde_json::to_value(DownloadProgress {
            bytes_done: 12,
            bytes_total: Some(100),
        })
        .expect("serialize");
        assert_eq!(json, serde_json::json!({"bytesDone": 12, "bytesTotal": 100}));

        // An asset served without Content-Length must reach the FE as null, so
        // it can render an indeterminate bar instead of dividing by zero.
        let unknown = serde_json::to_value(DownloadProgress {
            bytes_done: 12,
            bytes_total: None,
        })
        .expect("serialize");
        assert_eq!(unknown, serde_json::json!({"bytesDone": 12, "bytesTotal": null}));
    }

    /// Behavioural pin for the rule this module exists to enforce.
    ///
    /// `updater_for` needs an AppHandle, so the reachable half is asserted
    /// directly: staging has no manifest, which is what makes both commands
    /// short-circuit before any endpoint is chosen. If this ever returns a URL,
    /// staging builds resume checking SOME lane — and with one shared signing
    /// key that lane's manifest would verify and install.
    #[test]
    fn staging_has_no_manifest_to_check() {
        assert_eq!(ReleaseChannel::Staging.manifest_url(), None);
        assert!(ReleaseChannel::Production.manifest_url().is_some());
        assert!(ReleaseChannel::Beta.manifest_url().is_some());
    }

    #[test]
    fn the_two_public_channels_target_each_other() {
        assert_eq!(switch_target(ReleaseChannel::Production), Some(ReleaseChannel::Beta));
        assert_eq!(switch_target(ReleaseChannel::Beta), Some(ReleaseChannel::Production));
    }

    /// Staging is installed by hand and publishes no manifest, so there is
    /// nothing to switch into it from and nothing to install to leave it.
    #[test]
    fn staging_cannot_switch() {
        assert_eq!(switch_target(ReleaseChannel::Staging), None);
    }

    /// The case the epoch design exists for.
    ///
    /// Production ALWAYS trails beta by version — `0.4.0` against
    /// `0.5.0-beta.3` — so a guard keyed on version would refuse every return
    /// and make the switch a one-way door. Equal epochs must pass.
    #[test]
    fn returning_to_a_lower_version_is_allowed_at_the_same_epoch() {
        assert!(downgrade_is_safe(1, Some(1)));
        assert!(downgrade_is_safe(2, Some(2)));
        // A target that has moved AHEAD is fine too — it can read older state.
        assert!(downgrade_is_safe(1, Some(2)));
    }

    #[test]
    fn a_target_behind_the_local_epoch_is_refused() {
        assert!(!downgrade_is_safe(2, Some(1)));
        assert!(!downgrade_is_safe(5, Some(0)));
    }

    /// A manifest published before the field existed carries no epoch. Refusing
    /// on absence would block every switch at rollout, which is
    /// indistinguishable from the feature being broken.
    #[test]
    fn an_unknown_target_epoch_permits_the_switch() {
        assert!(downgrade_is_safe(1, None));
        assert!(downgrade_is_safe(99, None));
    }

    /// A malformed field must read exactly like a missing one — never louder.
    #[test]
    fn a_malformed_epoch_reads_as_unknown() {
        let unknown = |value: serde_json::Value| manifest_state_epoch(&value);

        assert_eq!(unknown(serde_json::json!({})), None);
        assert_eq!(unknown(serde_json::json!({"stateEpoch": null})), None);
        assert_eq!(unknown(serde_json::json!({"stateEpoch": "2"})), None);
        assert_eq!(unknown(serde_json::json!({"stateEpoch": -1})), None);
        assert_eq!(unknown(serde_json::json!({"stateEpoch": 1.5})), None);
        // …and a well-formed one is read.
        assert_eq!(unknown(serde_json::json!({"stateEpoch": 3})), Some(3));
    }

    /// Wire-shape pin for the switch surface.
    #[test]
    fn channel_status_serializes_camel_case() {
        let json = serde_json::to_value(ChannelStatus {
            current: ReleaseChannel::Production,
            target: Some(ReleaseChannel::Beta),
            target_version: Some("0.5.0-beta.1".into()),
            blocked_reason: None,
            install_in_place: true,
            release_page_url: "https://github.com/thenervelab/hippius-desktop/releases".into(),
            manual_install_hint: "Download the installer from https://github.com/thenervelab/hippius-desktop/releases and run it.".into(),
        })
        .expect("serialize");

        assert_eq!(
            json,
            serde_json::json!({
                "current": "production",
                "target": "beta",
                "targetVersion": "0.5.0-beta.1",
                "blockedReason": null,
                "installInPlace": true,
                "releasePageUrl": "https://github.com/thenervelab/hippius-desktop/releases",
                "manualInstallHint": "Download the installer from https://github.com/thenervelab/hippius-desktop/releases and run it.",
            })
        );
    }

    /// A beta or staging build sent to `/releases/latest` lands on the STABLE
    /// release, because GitHub never resolves that alias to a prerelease. The
    /// user would install the wrong lane by hand and silently leave the channel
    /// they opted into — the manual-install equivalent of a wrong-lane update.
    #[test]
    fn only_production_uses_the_latest_alias() {
        assert!(release_page_url(ReleaseChannel::Production).ends_with("/releases/latest"));

        for channel in [ReleaseChannel::Beta, ReleaseChannel::Staging] {
            let url = release_page_url(channel);
            assert!(
                !url.contains("/releases/latest"),
                "{channel:?} ships prereleases, which /releases/latest never resolves to"
            );
            assert!(url.ends_with("/releases"), "{channel:?} needs the release index: {url}");
        }
    }

    /// Every page a user can be sent to must be a URL on the real repo, over
    /// TLS. A typo here is a dead end at exactly the moment the in-app path has
    /// already failed.
    #[test]
    fn every_release_page_url_parses() {
        for channel in [ReleaseChannel::Production, ReleaseChannel::Beta, ReleaseChannel::Staging] {
            let raw = release_page_url(channel);
            let url = Url::parse(raw).unwrap_or_else(|err| panic!("{channel:?} release page URL does not parse: {err}"));

            assert_eq!(url.scheme(), "https", "release pages are fetched over TLS");
            assert_eq!(url.host_str(), Some("github.com"));
            assert!(url.path().starts_with("/thenervelab/hippius-desktop/releases"), "{raw}");
        }
    }

    /// H-061's regression pin, from the copy side.
    ///
    /// An install failure must reach the user as `{ kind: "Validation" }` — the
    /// shape UpdateDialog renders — and must name a page and an action. Dropping
    /// the hint sends a Linux user whose pkexec escalation failed back to a bare
    /// "Could not install the update", which is what H-061 was reported as.
    #[test]
    fn an_install_failure_tells_the_user_where_to_get_the_build() {
        let err = tauri_plugin_updater::Error::PackageInstallFailed;
        let failure = install_failure(ReleaseChannel::Beta, &err);

        let json = serde_json::to_value(failure).expect("serialize");
        assert_eq!(json["kind"], "Validation");

        let message = json["message"].as_str().expect("message is a string");
        assert!(message.contains(release_page_url(ReleaseChannel::Beta)), "{message}");
        assert!(message.starts_with("This package cannot be updated from inside the app."), "{message}");
    }

    /// A verification failure is the one case where retrying can never work:
    /// the running build's compiled-in pubkey is wrong, so every future release
    /// fails the same way. The copy must say the update was NOT installed and
    /// route the user to a manual reinstall.
    #[test]
    fn a_verification_failure_does_not_read_as_transient() {
        let err = tauri_plugin_updater::Error::SignatureUtf8("not base64".into());
        let AppError::Validation(message) = install_failure(ReleaseChannel::Production, &err) else {
            panic!("an install failure must stay a Validation error");
        };

        assert!(message.starts_with("This update could not be verified"), "{message}");
        assert!(message.contains(release_page_url(ReleaseChannel::Production)), "{message}");
    }

    /// Nothing the user reads may carry the plugin's own `Display`. Those
    /// strings are diagnostics ("temp directory is not on the same mount
    /// point", a reqwest chain) and the dialog shows `message` verbatim.
    #[test]
    fn failure_copy_never_leaks_the_plugin_error() {
        let raw = "temp directory is not on the same mount point as the AppImage";
        let err = tauri_plugin_updater::Error::TempDirNotOnSameMountPoint;
        assert_eq!(err.to_string(), raw, "the fixture must be the string this test guards against");

        for channel in [ReleaseChannel::Production, ReleaseChannel::Beta] {
            let install = install_failure(channel, &tauri_plugin_updater::Error::TempDirNotOnSameMountPoint).to_string();
            assert!(!install.contains(raw), "{install}");

            let check = check_failure(channel, &tauri_plugin_updater::Error::ReleaseNotFound).to_string();
            assert!(!check.contains("Could not fetch a valid release JSON"), "{check}");
            assert!(check.contains(channel_name(channel)), "{check}");
        }
    }

    /// The hint names the artifact the running build was packaged as, never the
    /// OS. Tests run unbundled, so `bundle_type()` reports nothing and the
    /// generic wording is what is reachable here; the per-bundle arms are pinned
    /// by `updater_install_paths.rs`, which reads the source.
    #[test]
    fn the_manual_hint_names_a_page_and_an_action() {
        let hint = manual_install_hint(ReleaseChannel::Production);

        assert!(hint.contains(release_page_url(ReleaseChannel::Production)), "{hint}");
        assert!(hint.ends_with('.'), "{hint}");
    }

    /// Every manifest a check can target must parse as a URL — `updater_for`
    /// turns a parse failure into a runtime error the user would see as a failed
    /// update check, and no test would otherwise catch a typo.
    #[test]
    fn every_manifest_url_parses() {
        for channel in [ReleaseChannel::Production, ReleaseChannel::Beta] {
            let raw = channel.manifest_url().expect("public channels publish a manifest");
            Url::parse(raw).unwrap_or_else(|err| panic!("{channel:?} manifest URL does not parse: {err}"));
        }
    }

    /// A `.deb` / `.rpm` cannot be applied as the current user. AppImage, the
    /// Windows installers, and macOS `.app` can.
    #[test]
    fn deb_and_rpm_cannot_install_in_place() {
        for on_linux in [true, false] {
            assert!(!in_place_install_supported_on(Some(BundleType::Deb), on_linux));
            assert!(!in_place_install_supported_on(Some(BundleType::Rpm), on_linux));
            assert!(in_place_install_supported_on(Some(BundleType::AppImage), on_linux));
            assert!(in_place_install_supported_on(Some(BundleType::Nsis), on_linux));
            assert!(in_place_install_supported_on(Some(BundleType::Msi), on_linux));
            assert!(in_place_install_supported_on(Some(BundleType::App), on_linux));
            assert!(in_place_install_supported_on(Some(BundleType::Dmg), on_linux));
        }
    }

    /// The regression that made the whole refusal a no-op in production.
    ///
    /// tauri-bundler does not patch the bundle-type marker into the shipped
    /// `.deb` — its `usr/bin/Hippius` still carries
    /// `__TAURI_BUNDLE_TYPE_VAR_UNK` — so `bundle_type()` is `None` on exactly
    /// the build QA hit EACCES on. Treating `None` as "unbundled dev build,
    /// try the plugin" therefore green-lit the released package, and
    /// plugin-updater's `install_inner` fell through to `install_appimage`,
    /// which renames `/usr/bin/Hippius`. Off Linux, `None` really is a local
    /// `cargo run` and must stay permissive.
    #[test]
    fn an_unknown_bundle_refuses_in_place_install_on_linux_only() {
        assert!(
            !in_place_install_supported_on(None, true),
            "the shipped .deb reports no bundle type; a permissive default is the EACCES path"
        );
        assert!(in_place_install_supported_on(None, false));
    }

    /// With no marker on Linux there is still only one Linux artifact this
    /// project publishes, so the hint must name the `.deb` rather than send the
    /// user looking for an "installer" the release page does not carry.
    #[test]
    fn an_unknown_linux_bundle_is_still_told_about_the_deb() {
        let channel = ReleaseChannel::Beta;

        let linux = manual_install_hint_on(channel, None, true);
        assert!(linux.contains(".deb"), "{linux}");
        assert_eq!(linux, manual_install_hint_on(channel, Some(BundleType::Deb), true));

        let elsewhere = manual_install_hint_on(channel, None, false);
        assert!(!elsewhere.contains(".deb"), "{elsewhere}");
    }

    /// QA log line: `err=Permission denied (os error 13)`. That Display must
    /// not be the user-facing error — not as the whole message, and not as a
    /// substring of the Validation copy.
    ///
    /// Io PermissionDenied is also what macOS returns when the admin move is
    /// declined. Do not label that as "this package cannot be updated from
    /// inside the app" — Deb/Rpm never reach `install_failure` (they refuse
    /// first); remaining EACCES is a failed in-place install, not an
    /// unsupported package type.
    #[test]
    fn permission_denied_is_not_the_user_facing_error() {
        let raw = "Permission denied (os error 13)";
        let err = tauri_plugin_updater::Error::Io(std::io::Error::new(std::io::ErrorKind::PermissionDenied, raw));
        assert_eq!(err.to_string(), raw, "fixture is the QA log line");

        let failure = install_failure(ReleaseChannel::Beta, &err);
        let json = serde_json::to_value(&failure).expect("serialize");
        assert_eq!(json["kind"], "Validation");

        let message = json["message"].as_str().expect("message is a string");
        assert_ne!(message, raw, "EACCES must not be the only error the user sees");
        assert!(!message.contains(raw) && !message.contains("os error 13"), "raw EACCES leaked: {message}");
        assert!(!message.to_ascii_lowercase().contains("permission denied"), "{message}");
        assert!(message.contains(release_page_url(ReleaseChannel::Beta)), "{message}");
        assert!(
            message.starts_with("Could not install the update."),
            "a declined macOS admin prompt must not read as an unsupported package: {message}"
        );
        assert!(!message.contains("cannot be updated from inside the app"), "{message}");
    }

    /// Deb/Rpm plugin failures (if they still reach install_failure) keep the
    /// package-type copy. Io PermissionDenied above must not.
    #[test]
    fn a_deb_install_failure_names_the_package_type() {
        let failure = install_failure(ReleaseChannel::Beta, &tauri_plugin_updater::Error::PackageInstallFailed);
        let json = serde_json::to_value(&failure).expect("serialize");
        let message = json["message"].as_str().expect("message is a string");

        assert!(message.contains("cannot be updated from inside the app"), "{message}");
        assert!(message.contains(release_page_url(ReleaseChannel::Beta)), "{message}");
    }
}
