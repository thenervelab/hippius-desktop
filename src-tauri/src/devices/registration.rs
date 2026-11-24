//! Registering this computer as one of the account's devices, and noticing
//! when another device unlinks it.
//!
//! Started from `auto_init_sync` (every sign-in path and the launch restore
//! reach it), once per account at a time, and checked again every
//! [`RECHECK`] while that account is signed in. Each round reads
//! `GET /v1/devices` and acts ONLY on a clean `200` it could read whole; an
//! error or no connection does nothing until the next round.
//!
//! What a round does is [`decide`], a pure function of what this computer
//! saved ([`super::store`]), the list and this computer's name:
//!
//! - its saved device is listed: linked (and the server's name follows a
//!   rename made here);
//! - nothing saved: register a new device. Never adopt another device by
//!   name: two computers can share one;
//! - saved but not listed, after an explicit sign-in: reconnect it (a `404`
//!   means it is gone: register a new one);
//! - saved, not listed, and seen linked before: another device unlinked
//!   this computer. The account is signed out through the app's full
//!   logout and the webview is told why ([`THIS_DEVICE_UNLINKED_EVENT`]).
//!   Read twice first, so one odd answer cannot sign anyone out;
//! - saved but never seen linked: register a new one.
//!
//! `409 device_limit` ends the loop for this run: the account has 100
//! devices and asking every minute would change nothing.
//!
//! Not here yet: uploads do not name this device (`device_id` in the
//! manifest), because the sync engine's uploads are built inside the pinned
//! hcfs-client. That needs an hcfs-client change; see
//! `docs/plans/2026-11-23-desktop-devices-and-starred.md`.

use super::api::{DevicesApi, server_name};
use super::store::{self, SavedDevice};
use super::wire::{DeviceRecord, this_platform};
use crate::app_state::AppState;
use serde::Serialize;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager};
use tokio::sync::Notify;
use tracing::{debug, info, warn};

/// How often a signed-in account's device is checked again.
pub const RECHECK: Duration = Duration::from_mins(1);

/// Told to the webview after the account was signed out because another
/// device unlinked this computer. Mirrors `THIS_DEVICE_UNLINKED_EVENT` in
/// `app/lib/tauri/devices.ts`.
pub const THIS_DEVICE_UNLINKED_EVENT: &str = "this_device_unlinked";

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ThisDeviceUnlinked {
    pub account_id: String,
}

/// What one round does, decided from what is saved and what is listed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// The saved device is listed. `rename_to`: the server's name differs
    /// from this computer's, so send this computer's.
    Linked { device_id: String, rename_to: Option<String> },
    /// Register a new device.
    Register,
    /// Link the saved device again (after an explicit sign-in).
    Reconnect { device_id: String },
    /// Another device unlinked this computer.
    Unlinked { device_id: String },
}

/// The decision, pure. `computer_name` is the name as the server would
/// store it ([`server_name`]).
pub fn decide(saved: &SavedDevice, listed: &[DeviceRecord], computer_name: &str) -> Step {
    let Some(device_id) = saved.device_id.clone() else {
        return Step::Register;
    };
    if let Some(device) = listed.iter().find(|d| d.device_id == device_id) {
        let rename_to = (device.name != computer_name).then(|| computer_name.to_string());
        return Step::Linked { device_id, rename_to };
    }
    if saved.reconnect_pending {
        Step::Reconnect { device_id }
    } else if saved.confirmed {
        Step::Unlinked { device_id }
    } else {
        Step::Register
    }
}

/// How a round ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Round {
    Linked,
    Registered,
    Reconnected,
    /// Another device unlinked this computer: sign out.
    Unlinked,
    /// The account cannot have more devices: stop for this run.
    Stop,
    /// Nothing could be read or written this round; try again later.
    Skipped,
}

/// One round against the server, everything but the sign-out.
pub async fn run_round(api: &DevicesApi, pool: &SqlitePool, account_id: &str, computer_name: &str, platform: &str) -> Round {
    let listed = match api.list().await {
        Ok(listed) => listed,
        Err(r) => {
            debug!(status = r.status, code = ?r.code, "devices: list unreadable; nothing this round");
            return Round::Skipped;
        }
    };
    let saved = match store::load(pool, account_id).await {
        Ok(saved) => saved,
        Err(e) => {
            warn!(error = %e, "devices: saved registration unreadable");
            return Round::Skipped;
        }
    };
    match decide(&saved, &listed, computer_name) {
        Step::Linked { device_id, rename_to } => {
            if (!saved.confirmed || saved.reconnect_pending)
                && let Err(e) = store::save_linked(pool, account_id, &device_id).await
            {
                warn!(error = %e, "devices: could not note this computer as linked");
            }
            if let Some(name) = rename_to
                && let Err(r) = api.rename(&device_id, &name).await
            {
                debug!(status = r.status, "devices: rename not sent; next round");
            }
            Round::Linked
        }
        Step::Register => register(api, pool, account_id, computer_name, platform).await,
        Step::Reconnect { device_id } => match api.reconnect(&device_id).await {
            Ok(device) => {
                if let Err(e) = store::save_linked(pool, account_id, &device.device_id).await {
                    warn!(error = %e, "devices: could not note the reconnected device");
                }
                if device.name != computer_name {
                    let _ = api.rename(&device.device_id, computer_name).await;
                }
                info!("devices: this computer is linked again");
                Round::Reconnected
            }
            Err(r) if r.status == 404 => register(api, pool, account_id, computer_name, platform).await,
            Err(r) => {
                debug!(status = r.status, "devices: reconnect not answered; next round");
                Round::Skipped
            }
        },
        Step::Unlinked { device_id } => {
            // Read again before signing anyone out.
            match api.list().await {
                Ok(again) if again.iter().any(|d| d.device_id == device_id) => Round::Linked,
                Ok(_) => {
                    info!("devices: this computer was unlinked from another device");
                    Round::Unlinked
                }
                Err(_) => Round::Skipped,
            }
        }
    }
}

async fn register(api: &DevicesApi, pool: &SqlitePool, account_id: &str, computer_name: &str, platform: &str) -> Round {
    match api.create(platform, computer_name).await {
        Ok(device) => {
            if let Err(e) = store::save_linked(pool, account_id, &device.device_id).await {
                warn!(error = %e, "devices: registered, but could not save the device id");
            }
            info!("devices: this computer is registered");
            Round::Registered
        }
        Err(r) if r.is_device_limit() => {
            warn!("devices: the account has reached its device limit; not registering this computer");
            Round::Stop
        }
        Err(r) => {
            debug!(status = r.status, code = ?r.code, "devices: register not answered; next round");
            Round::Skipped
        }
    }
}

/// The running loops, one per account, each with its wake-up.
#[derive(Default)]
pub struct RegistrationLoops(Mutex<HashMap<String, Arc<Notify>>>);

impl RegistrationLoops {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<Notify>>> {
        self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Ensure a loop runs for `account_id`: wake the running one (a fresh
    /// sign-in should not wait a minute to reconnect), or note a new one.
    /// `Some` when the caller must spawn it.
    pub fn claim(&self, account_id: &str) -> Option<Arc<Notify>> {
        let mut loops = self.lock();
        if let Some(notify) = loops.get(account_id) {
            notify.notify_one();
            return None;
        }
        let notify = Arc::new(Notify::new());
        loops.insert(account_id.to_string(), notify.clone());
        Some(notify)
    }

    /// Whether the loop for `account_id` should go on: it should while that
    /// account is the session's. Ending is decided under the same lock
    /// [`Self::claim`] takes, so a sign-in never lands between "this loop is
    /// ending" and "it is gone" and finds nobody running.
    pub fn keep_going(&self, account_id: &str, notify: &Arc<Notify>, signed_in: impl FnOnce() -> bool) -> bool {
        let mut loops = self.lock();
        if signed_in() {
            return true;
        }
        Self::forget(&mut loops, account_id, notify);
        false
    }

    /// Drop this loop's entry (a newer loop's is left alone).
    pub fn end(&self, account_id: &str, notify: &Arc<Notify>) {
        Self::forget(&mut self.lock(), account_id, notify);
    }

    fn forget(loops: &mut HashMap<String, Arc<Notify>>, account_id: &str, notify: &Arc<Notify>) {
        if loops.get(account_id).is_some_and(|n| Arc::ptr_eq(n, notify)) {
            loops.remove(account_id);
        }
    }
}

fn signed_in_as(state: &AppState, account_id: &str) -> bool {
    state.current_account_id().is_ok_and(|current| current == account_id)
}

/// Start (or wake) this computer's device check for `account_id`.
pub fn start(app: &tauri::AppHandle, account_id: &str) {
    let state = app.state::<AppState>();
    let Some(notify) = state.device_registration.claim(account_id) else {
        return;
    };
    let app = app.clone();
    let account_id = account_id.to_string();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        loop {
            if !state
                .device_registration
                .keep_going(&account_id, &notify, || signed_in_as(&state, &account_id))
            {
                break;
            }
            match round_for(&state, &account_id).await {
                Round::Unlinked => {
                    state.device_registration.end(&account_id, &notify);
                    if signed_in_as(&state, &account_id) {
                        sign_out_unlinked(&app, &account_id).await;
                    }
                    break;
                }
                Round::Stop => {
                    state.device_registration.end(&account_id, &notify);
                    break;
                }
                _ => {}
            }
            tokio::select! {
                () = tokio::time::sleep(RECHECK) => {}
                () = notify.notified() => {}
            }
        }
    });
}

/// One round with this account's server, token and computer name.
async fn round_for(state: &AppState, account_id: &str) -> Round {
    let Ok(api) = devices_api(state, account_id).await else {
        return Round::Skipped;
    };
    let Ok(pool) = state.pool() else {
        return Round::Skipped;
    };
    let name = match crate::sync::device::get_device_name_internal(pool).await {
        Ok(name) => server_name(&name),
        Err(_) => return Round::Skipped,
    };
    run_round(&api, pool, account_id, &name, this_platform()).await
}

/// The devices calls' HTTP context: the HCFS server the Drive page browses,
/// as the signed-in account.
pub async fn devices_api(state: &AppState, account_id: &str) -> crate::error::Result<DevicesApi> {
    let pool = state.pool()?;
    let server_url = crate::sync::remote::get_server_url(pool, account_id).await?;
    let bearer = crate::auth::tokens::get_api_token(pool, account_id)
        .await?
        .ok_or_else(|| crate::error::AppError::Auth("No authentication token found. Please log in again.".into()))?;
    Ok(DevicesApi {
        http: state.api_client.clone(),
        base_url: crate::sync::region::resolve_base_url(&server_url).to_string(),
        bearer,
    })
}

/// Sign the account out the way the app's own Sign out does, then tell the
/// webview why, so the sign-in screen can say so.
async fn sign_out_unlinked(app: &tauri::AppHandle, account_id: &str) {
    match crate::auth::logout::logout_full(app.clone(), account_id.to_string()).await {
        Ok(()) => {
            let payload = ThisDeviceUnlinked {
                account_id: account_id.to_string(),
            };
            if let Err(e) = app.emit(THIS_DEVICE_UNLINKED_EVENT, payload) {
                warn!(error = %e, "devices: could not tell the window this computer was unlinked");
            }
        }
        Err(e) => warn!(error = %e, "devices: signing out the unlinked computer failed; the next launch checks again"),
    }
}

/// Send this computer's new name to its device, if it has one. Best effort:
/// the next round sends it anyway when the names differ.
pub async fn push_name(state: &AppState, account_id: &str, name: &str) {
    let Ok(pool) = state.pool() else { return };
    let Ok(saved) = store::load(pool, account_id).await else { return };
    let Some(device_id) = saved.device_id else { return };
    let Ok(api) = devices_api(state, account_id).await else { return };
    if let Err(r) = api.rename(&device_id, &server_name(name)).await {
        debug!(status = r.status, "devices: new name not sent; the next check sends it");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0123456789abcdef0123456789abcdef";
    const OTHER: &str = "fedcba9876543210fedcba9876543210";

    fn listed(id: &str, name: &str) -> DeviceRecord {
        DeviceRecord {
            device_id: id.to_string(),
            platform: "linux".into(),
            name: name.into(),
            model_id: None,
            model_name: None,
            created_at: 1,
            last_active_at: 2,
        }
    }

    fn saved(id: Option<&str>, confirmed: bool, reconnect_pending: bool) -> SavedDevice {
        SavedDevice {
            device_id: id.map(str::to_string),
            confirmed,
            reconnect_pending,
        }
    }

    #[test]
    fn nothing_saved_registers_and_never_adopts_a_device_by_name() {
        let list = [listed(OTHER, "Desk")];
        assert_eq!(decide(&saved(None, false, false), &list, "Desk"), Step::Register);
        assert_eq!(decide(&saved(None, false, true), &list, "Desk"), Step::Register);
    }

    #[test]
    fn a_listed_device_is_linked_and_follows_this_computers_name() {
        let list = [listed(ID, "Desk")];
        for flags in [(false, false), (true, false), (true, true), (false, true)] {
            assert_eq!(
                decide(&saved(Some(ID), flags.0, flags.1), &list, "Desk"),
                Step::Linked {
                    device_id: ID.into(),
                    rename_to: None
                }
            );
        }
        assert_eq!(
            decide(&saved(Some(ID), true, false), &list, "Studio"),
            Step::Linked {
                device_id: ID.into(),
                rename_to: Some("Studio".into())
            }
        );
    }

    #[test]
    fn a_missing_device_is_reconnected_after_a_sign_in_else_unlinked_once_confirmed() {
        let list = [listed(OTHER, "Phone")];
        assert_eq!(
            decide(&saved(Some(ID), true, true), &list, "Desk"),
            Step::Reconnect { device_id: ID.into() }
        );
        assert_eq!(
            decide(&saved(Some(ID), false, true), &list, "Desk"),
            Step::Reconnect { device_id: ID.into() }
        );
        assert_eq!(
            decide(&saved(Some(ID), true, false), &list, "Desk"),
            Step::Unlinked { device_id: ID.into() }
        );
        // Never seen linked: it was never this account's to lose.
        assert_eq!(decide(&saved(Some(ID), false, false), &list, "Desk"), Step::Register);
        assert_eq!(
            decide(&saved(Some(ID), true, false), &[], "Desk"),
            Step::Unlinked { device_id: ID.into() }
        );
    }

    #[test]
    fn one_loop_per_account_and_a_second_start_wakes_it() {
        let loops = RegistrationLoops::default();
        let first = loops.claim("5A").expect("first start spawns");
        assert!(loops.claim("5A").is_none(), "a second start wakes the running loop");
        let other = loops.claim("5B").expect("another account gets its own loop");
        // The wake is stored, so the running loop does not wait a minute.
        let woke = futures_util::FutureExt::now_or_never(first.notified());
        assert!(woke.is_some());
        // A loop whose account signed out ends and frees the slot.
        assert!(loops.keep_going("5A", &first, || true));
        assert!(!loops.keep_going("5A", &first, || false));
        assert!(loops.claim("5A").is_some(), "a later sign-in starts a fresh loop");
        // An old loop never removes a newer one's entry.
        loops.end("5B", &first);
        assert!(loops.claim("5B").is_none());
        loops.end("5B", &other);
        assert!(loops.claim("5B").is_some());
    }
}
