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
use tauri::{AppHandle, Url};
use tauri_plugin_updater::UpdaterExt;
use tracing::{debug, info, warn};

use crate::error::{AppError, Result};
use crate::release_channel::{self, ReleaseChannel};

/// An update the running channel is offering.
///
/// `channel` rides along so the frontend can say WHICH lane the update comes
/// from — on a beta build "Update to 0.5.0-beta.4" is a different proposition
/// from the same string on production, and the user opted into knowing that.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableUpdate {
    pub version: String,
    pub current_version: String,
    pub notes: String,
    pub channel: ReleaseChannel,
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

    let url = Url::parse(manifest).map_err(|err| AppError::Other(format!("update manifest URL for {channel:?} is not a valid URL: {err}")))?;

    let mut builder = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|err| AppError::Other(format!("could not target the {channel:?} update manifest: {err}")))?;

    if cross_channel {
        builder = builder.version_comparator(|_current, _remote| true);
    }

    let updater = builder
        .build()
        .map_err(|err| AppError::Other(format!("could not build the updater for {channel:?}: {err}")))?;

    Ok(Some(updater))
}

/// Whether the running build's own channel is offering a newer version.
///
/// Infallible in spirit: a network failure is an error the caller may show, but
/// a channel with no manifest is simply `None`.
#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<Option<AvailableUpdate>> {
    let channel = release_channel::current();

    let Some(updater) = updater_for(&app, channel, false)? else {
        return Ok(None);
    };

    let found = updater
        .check()
        .await
        .map_err(|err| AppError::Other(format!("could not check the {channel:?} channel for updates: {err}")))?;

    let Some(update) = found else {
        debug!(?channel, "no update available");
        return Ok(None);
    };

    info!(?channel, version = %update.version, current = %update.current_version, "update available");
    Ok(Some(AvailableUpdate {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        notes: update.body.clone().unwrap_or_default(),
        channel,
    }))
}

/// Linux ships `.deb` (`tauri.conf.json` `bundle.targets`), not AppImage.
/// Tauri's updater can only replace a self-contained image in-place;
/// applying a `.deb` needs the package manager. Calling `download_and_install`
/// on Linux looks like an update started and then fails with an opaque
/// plugin error (H-061). The FE surfaces this string from the structured
/// `{ kind: "Validation", message }` payload.
///
/// Referenced only from `#[cfg(target_os = "linux")]` arms (and the unit
/// test that pins the wire shape). macOS/Windows CI still compile this
/// module, so the const is dead there on purpose.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const LINUX_DEB_INPLACE_UPDATE: &str = "This Linux package cannot update itself. Download the new .deb from the release page.";

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
/// Linux cannot apply a `.deb` in-place — that arm returns
/// [`AppError::Validation`] with [`LINUX_DEB_INPLACE_UPDATE`] instead of
/// calling `download_and_install`.
#[tauri::command]
pub async fn install_update(app: AppHandle, on_progress: Channel<DownloadProgress>) -> Result<()> {
    #[cfg(target_os = "linux")]
    {
        drop((app, on_progress));
        Err(AppError::Validation(LINUX_DEB_INPLACE_UPDATE.into()))
    }

    #[cfg(not(target_os = "linux"))]
    {
        let channel = release_channel::current();

        let Some(updater) = updater_for(&app, channel, false)? else {
            return Err(AppError::Validation("This build does not receive automatic updates.".into()));
        };

        let update = updater
            .check()
            .await
            .map_err(|err| AppError::Other(format!("could not check the {channel:?} channel for updates: {err}")))?
            .ok_or_else(|| AppError::Validation("There is no update to install.".into()))?;

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
            .map_err(|err| AppError::Other(format!("could not install the {channel:?} update: {err}")))?;

        info!(?channel, %version, "update installed; awaiting relaunch");
        Ok(())
    }
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
}

/// The message shown when the epoch guard refuses a switch.
///
/// Names what the user can do next. "Blocked for data-safety reasons" tells
/// someone nothing they can act on; "wait for the stable release to catch up"
/// tells them the condition that clears it.
fn blocked_message(target: ReleaseChannel) -> String {
    let name = match target {
        ReleaseChannel::Production => "stable",
        ReleaseChannel::Beta => "beta",
        ReleaseChannel::Staging => "staging",
    };

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
        return Ok(ChannelStatus {
            current,
            target: None,
            target_version: None,
            blocked_reason: None,
        });
    };

    let Some(updater) = updater_for(&app, target, true)? else {
        return Ok(ChannelStatus {
            current,
            target: Some(target),
            target_version: None,
            blocked_reason: None,
        });
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
        return Ok(ChannelStatus {
            current,
            target: Some(target),
            target_version: None,
            blocked_reason: None,
        });
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

    Ok(ChannelStatus {
        current,
        target: Some(target),
        target_version: Some(update.version.clone()),
        blocked_reason,
    })
}

/// Install the other channel's build, so the app restarts on that lane.
///
/// Does NOT relaunch — the caller does, after telling the user what happened.
///
/// `target` is checked against [`switch_target`] rather than trusted: the
/// frontend computes the same thing, and a mismatch means the two have drifted.
/// Installing whatever was asked for would be the wrong answer to that.
///
/// Linux cannot apply a `.deb` in-place, so this shares
/// [`install_update`]'s refusal rather than calling `download_and_install`.
#[tauri::command]
pub async fn switch_release_channel(app: AppHandle, target: String, on_progress: Channel<DownloadProgress>) -> Result<()> {
    #[cfg(target_os = "linux")]
    {
        drop((app, target, on_progress));
        Err(AppError::Validation(LINUX_DEB_INPLACE_UPDATE.into()))
    }

    #[cfg(not(target_os = "linux"))]
    {
        let current = release_channel::current();
        let expected = switch_target(current).ok_or_else(|| AppError::Validation("This build cannot switch release channels.".into()))?;

        let requested = release_channel::parse_release_channel(Some(&target));
        if requested != expected {
            return Err(AppError::Validation(format!("Cannot switch from {current:?} to {requested:?}.")));
        }

        let updater =
            updater_for(&app, expected, true)?.ok_or_else(|| AppError::Validation("That channel does not publish installable builds.".into()))?;

        let update = updater
            .check()
            .await
            .map_err(|err| AppError::Other(format!("could not reach the {expected:?} channel: {err}")))?
            .ok_or_else(|| AppError::Other(format!("the {expected:?} channel is not publishing a build for this platform")))?;

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
            .map_err(|err| AppError::Other(format!("could not install the {expected:?} build: {err}")))?;

        info!(from = ?current, to = ?expected, %version, "switched release channel; awaiting relaunch");
        Ok(())
    }
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
        })
        .expect("serialize");

        assert_eq!(
            json,
            serde_json::json!({
                "version": "0.5.0-beta.2",
                "currentVersion": "0.5.0-beta.1",
                "notes": "notes",
                "channel": "beta",
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
        })
        .expect("serialize");

        assert_eq!(
            json,
            serde_json::json!({
                "current": "production",
                "target": "beta",
                "targetVersion": "0.5.0-beta.1",
                "blockedReason": null,
            })
        );
    }

    /// Wire shape the FE matches: `{ kind: "Validation", message: <stable copy> }`.
    /// A kind rename or wrapping this in `Other` would make UpdateDialog's
    /// structured match miss and show a generic "try again later".
    #[test]
    fn linux_deb_refusal_serializes_as_validation() {
        let json = serde_json::to_value(&AppError::Validation(LINUX_DEB_INPLACE_UPDATE.into())).expect("serialize");
        assert_eq!(json["kind"], "Validation");
        assert_eq!(json["message"], LINUX_DEB_INPLACE_UPDATE);
        assert_eq!(
            LINUX_DEB_INPLACE_UPDATE,
            "This Linux package cannot update itself. Download the new .deb from the release page."
        );
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
}
