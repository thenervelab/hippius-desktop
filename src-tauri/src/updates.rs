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

/// Build an updater aimed at `channel`'s manifest.
///
/// `None` when the channel publishes no manifest — staging, which is installed
/// by hand. Every caller must treat that as "no update", never as an error: it
/// is the designed state of that lane, not a failure.
fn updater_for(app: &AppHandle, channel: ReleaseChannel) -> Result<Option<tauri_plugin_updater::Updater>> {
    let Some(manifest) = channel.manifest_url() else {
        debug!(?channel, "channel publishes no update manifest; skipping the check");
        return Ok(None);
    };

    let url = Url::parse(manifest).map_err(|err| AppError::Other(format!("update manifest URL for {channel:?} is not a valid URL: {err}")))?;

    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|err| AppError::Other(format!("could not target the {channel:?} update manifest: {err}")))?
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

    let Some(updater) = updater_for(&app, channel)? else {
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
#[tauri::command]
pub async fn install_update(app: AppHandle, on_progress: Channel<DownloadProgress>) -> Result<()> {
    let channel = release_channel::current();

    let Some(updater) = updater_for(&app, channel)? else {
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
