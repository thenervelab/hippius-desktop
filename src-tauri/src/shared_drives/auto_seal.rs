//! Deliver emailed invitations' keys without an Approve click.
//!
//! An emailed invitation carries no key. The recipient opens it in the
//! console, signs in, and their browser publishes an X25519 public key; the
//! row becomes `awaiting_seal`. Someone who holds the drive key then seals it
//! to that public key, and only then can the recipient join. The server lets
//! only the invited mailbox publish that key (HCFS #480), so sealing it is
//! key delivery to the right person and needs no human in the loop.
//!
//! This task does it while an owner or a Manager has the app signed in:
//!
//! - **Owner or Manager.** It reads this account's OWN drives
//!   (`/list_folders` in its own namespace) and the drives shared with it
//!   (`/v1/drive-memberships`), and keeps the ones the owner-or-Manager rule
//!   ([`commands::manages_drive`]) admits: every own drive, and a member drive
//!   only where this account is a whole-drive Manager. A Manager's seal goes
//!   through the delegated owner path (`?owner=`), which the server opens to
//!   any Manager. A Viewer, an Editor or a folder grant holder never seals.
//! - **Never prompts.** The key comes from the session mnemonic already in
//!   memory. A locked session (no mnemonic loaded) is a quiet pass, never a
//!   dialog; the Approve button stays as the fallback for that case.
//! - **One code path.** Keys are resolved by [`commands::invite_seal_keys`]
//!   and sealed by [`commands::seal_invite_row`], the same two calls the
//!   manual Approve makes, so the folder-key rule (derived key for a folder
//!   invitation, entropy for a whole drive) cannot drift between them.
//! - **One attempt per published key.** `(invite_id, requester_pubkey)` is
//!   remembered once tried; a stale or transient failure forgets it so the
//!   next pass retries, and a key rotation is a new pair.
//! - **Plan gate.** Delivering a key adds a person, so it follows the same
//!   rule as inviting: on an own drive, this account's plan
//!   ([`crate::billing::storage_overview::fetch_can_share_drives`]); on a drive
//!   it manages, the OWNER's plan, which only the server knows, so this
//!   account's plan never holds those back.
//! - **Cheap.** About every 15 s while some drive it manages has an emailed
//!   invitation in flight, every few minutes otherwise, backing off
//!   exponentially on errors. [`nudge_invite_auto_seal`] wakes it early (an
//!   invite was sent, Manage access was opened).
//!
//! Started by the frontend once signed in, and only behind the same feature
//! flags that show the manual Approve (`SHARED_DRIVES_ENABLED`, and
//! `FOLDER_ROLES_ENABLED` for folder invitations). It stops on sign-out
//! (`logout_full`) and ends itself when the session account changes.

use super::commands::{self, ApprovableInvite, DriveInviteInfo, SealKeyPut};
use crate::app_state::AppState;
use crate::error::{AppError, NotReadyKind, Result};
use serde::Serialize;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
use tracing::{debug, info, warn};

/// Emitted once per key this task delivers.
pub const INVITE_KEY_DELIVERED_EVENT: &str = "shared-drive:invite-key-delivered";

/// Cadence while some drive it owns or manages has an emailed invitation in
/// flight.
pub(crate) const ACTIVE_INTERVAL: Duration = Duration::from_secs(15);
/// Cadence with nothing in flight, or when delivery is not possible now
/// (locked session, plan without sharing, server without the feature).
pub(crate) const QUIET_INTERVAL: Duration = Duration::from_mins(3);
/// Ceiling for the error backoff.
pub(crate) const MAX_BACKOFF: Duration = Duration::from_mins(5);
/// How long a plan answer is trusted before it is read again. A nudge
/// always reads it again.
const PLAN_TTL: Duration = Duration::from_mins(10);

/// What one pass found, which decides when the next one runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PassOutcome {
    /// Some drive it owns or manages has an emailed invitation that is `sent` or
    /// `awaiting_seal`: its recipient may publish a key any moment.
    Active,
    /// Nothing in flight.
    Quiet,
    /// Delivery is not possible right now and polling cannot change that
    /// quickly: the session is locked, the plan has no sharing, or the
    /// server does not run shared drives.
    Unavailable,
    /// The pass could not read what it needed (offline, server error).
    Failed,
}

/// When the next pass runs. Pure, so the cadence is testable.
///
/// `consecutive_failures` counts [`PassOutcome::Failed`] passes in a row,
/// this one included; it is ignored for every other outcome.
pub(crate) fn next_delay(outcome: PassOutcome, consecutive_failures: u32) -> Duration {
    match outcome {
        PassOutcome::Active => ACTIVE_INTERVAL,
        PassOutcome::Quiet | PassOutcome::Unavailable => QUIET_INTERVAL,
        PassOutcome::Failed => {
            let exp = consecutive_failures.clamp(1, 16);
            ACTIVE_INTERVAL.saturating_mul(1u32 << exp).min(MAX_BACKOFF)
        }
    }
}

/// Whether an invitation row is one this task should seal now.
///
/// Mirrors the console's filter (`valid && awaiting_seal && requester_pubkey`)
/// and keys on `email_status`, never on the key being present: the key stays
/// on the row after sealing, and sealing it again earns a 409. A folder
/// invitation is only delivered when folder collaboration is on, which is
/// also when its manual Approve is shown.
pub(crate) fn auto_sealable(invite: &DriveInviteInfo, folder_invites: bool) -> Option<ApprovableInvite> {
    if !invite.valid || invite.revoked || invite.email_status.as_deref() != Some("awaiting_seal") {
        return None;
    }
    if invite.path_prefix.is_some() && !folder_invites {
        return None;
    }
    let requester_pubkey = invite.requester_pubkey.as_deref().map(str::trim).filter(|k| !k.is_empty())?;
    Some(ApprovableInvite {
        requester_pubkey: requester_pubkey.to_string(),
        path_prefix: invite.path_prefix.clone(),
    })
}

/// Whether a drive has an emailed invitation still on its way to a key:
/// `sent` (the recipient may open it any moment) or `awaiting_seal`.
pub(crate) fn has_open_email_invite(invites: &[DriveInviteInfo]) -> bool {
    invites
        .iter()
        .any(|i| i.valid && !i.revoked && matches!(i.email_status.as_deref(), Some("sent" | "awaiting_seal")))
}

/// What to do with an attempt once its seal came back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AttemptVerdict {
    /// Done (sealed, or somebody else sealed it first), or failed in a way a
    /// retry cannot fix: never try this pair again.
    Keep,
    /// Stale (the recipient replaced their key) or transient: try again on
    /// the next pass.
    Forget,
}

/// Decide [`AttemptVerdict`] from a seal's result.
pub(crate) fn attempt_verdict(result: &Result<SealKeyPut>) -> AttemptVerdict {
    let retry = match result {
        // Sealed, or somebody else sealed it first: done. Stale: the
        // recipient replaced their key, so the next pass reads the new one.
        Ok(put) => *put == SealKeyPut::Stale,
        // A key that does not parse, or a row this account cannot seal, will
        // fail the same way every pass; the Approve button still shows the
        // reason. Everything else (network, server, auth) may clear.
        Err(e) => !matches!(e, AppError::Crypto(_) | AppError::Validation(_)),
    };
    if retry { AttemptVerdict::Forget } else { AttemptVerdict::Keep }
}

/// The `(invite_id, requester_pubkey)` pairs already tried.
#[derive(Debug, Default)]
pub(crate) struct AttemptMemory {
    tried: HashSet<(String, String)>,
}

impl AttemptMemory {
    /// Claim a pair. `false` when it was already tried, so it is skipped.
    pub(crate) fn begin(&mut self, invite_id: &str, pubkey: &str) -> bool {
        self.tried.insert((invite_id.to_string(), pubkey.to_string()))
    }

    /// Settle a claimed pair.
    pub(crate) fn settle(&mut self, invite_id: &str, pubkey: &str, verdict: AttemptVerdict) {
        if verdict == AttemptVerdict::Forget {
            self.tried.remove(&(invite_id.to_string(), pubkey.to_string()));
        }
    }

    /// Whether a pair was tried.
    pub(crate) fn contains(&self, invite_id: &str, pubkey: &str) -> bool {
        self.tried.contains(&(invite_id.to_string(), pubkey.to_string()))
    }

    /// Drop pairs no longer waiting, so the set stays bounded. Only called
    /// after a pass that read every drive, so a pair is never forgotten
    /// because its drive's listing failed.
    pub(crate) fn retain_waiting(&mut self, waiting: &HashSet<(String, String)>) {
        self.tried.retain(|pair| waiting.contains(pair));
    }
}

/// The Tauri event payload for one delivered key. The recipient's address is
/// already normalized (a placeholder `@hippius.local` address is absent), so
/// the toast says "Someone" instead.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InviteKeyDelivered {
    pub label: String,
    pub folder_hash: String,
    pub invite_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recipient_email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path_prefix: Option<String>,
}

/// The one running task, if any.
struct Running {
    account_id: String,
    folder_invites: bool,
    handle: tokio::task::JoinHandle<()>,
}

/// Lives on [`AppState`]: the running task and its wake-up.
#[derive(Default)]
pub struct AutoSealState {
    running: tokio::sync::Mutex<Option<Running>>,
    nudge: Arc<tokio::sync::Notify>,
}

impl AutoSealState {
    /// Stop the task, if one runs. Sign-out calls this.
    pub async fn stop(&self) {
        if let Some(running) = self.running.lock().await.take() {
            running.handle.abort();
            info!("Email invite delivery stopped");
        }
    }

    /// Run a pass now instead of at the next tick. A nudge with no task
    /// waiting is kept, so the next wait returns at once.
    pub fn nudge(&self) {
        self.nudge.notify_one();
    }
}

/// Start delivering emailed invitation keys for the signed-in account.
///
/// Idempotent: a task already running for this account with the same flags
/// is nudged instead of restarted. `folder_invites` is the frontend's
/// `FOLDER_ROLES_ENABLED`; the frontend only calls this at all behind
/// `SHARED_DRIVES_ENABLED`.
#[tauri::command]
pub async fn start_invite_auto_seal(app: tauri::AppHandle, folder_invites: bool) -> Result<()> {
    let state = app.state::<AppState>();
    let account_id = state.current_account_id()?;
    let auto = &state.invite_auto_seal;
    let mut running = auto.running.lock().await;
    if let Some(current) = running.as_ref()
        && current.account_id == account_id
        && current.folder_invites == folder_invites
        && !current.handle.is_finished()
    {
        auto.nudge();
        return Ok(());
    }
    if let Some(previous) = running.take() {
        previous.handle.abort();
    }
    let handle = tokio::spawn(run(app.clone(), account_id.clone(), folder_invites, auto.nudge.clone()));
    *running = Some(Running {
        account_id,
        folder_invites,
        handle,
    });
    info!(folder_invites, "Email invite delivery started");
    Ok(())
}

/// Stop delivering. The frontend calls it when its host unmounts; sign-out
/// stops it from Rust as well.
#[tauri::command]
pub async fn stop_invite_auto_seal(app: tauri::AppHandle) -> Result<()> {
    app.state::<AppState>().invite_auto_seal.stop().await;
    Ok(())
}

/// Look again now: an email invitation was just sent, or Manage access was
/// opened. A no-op when nothing runs.
#[tauri::command]
pub fn nudge_invite_auto_seal(app: tauri::AppHandle) {
    app.state::<AppState>().invite_auto_seal.nudge();
}

/// The task body: one pass, then a wait decided by [`next_delay`] that a
/// nudge cuts short. Ends when the session account is no longer the one it
/// started for.
async fn run(app: tauri::AppHandle, account_id: String, folder_invites: bool, nudge: Arc<tokio::sync::Notify>) {
    let mut memory = AttemptMemory::default();
    let mut plan = PlanGate::default();
    let mut failures: u32 = 0;
    loop {
        let state = app.state::<AppState>();
        if !session_is(&state, &account_id) {
            debug!("Email invite delivery ended: the session account changed");
            return;
        }
        let outcome = pass(&app, &state, &account_id, folder_invites, &mut memory, &mut plan).await;
        failures = if outcome == PassOutcome::Failed { failures.saturating_add(1) } else { 0 };
        let delay = next_delay(outcome, failures);
        tokio::select! {
            () = tokio::time::sleep(delay) => {}
            () = nudge.notified() => {
                // Something changed on purpose (an invite sent, the panel
                // opened, maybe a plan upgrade): read the plan again too.
                plan.forget();
            }
        }
    }
}

fn session_is(state: &AppState, account_id: &str) -> bool {
    state.current_account_id().is_ok_and(|current| current == account_id)
}

/// Whether the error says the server does not run the feature or the plan
/// lacks it: nothing a quick retry fixes.
fn is_unavailable(err: &AppError) -> bool {
    matches!(
        err,
        AppError::NotReady(NotReadyKind::SharedDrivesUnavailable | NotReadyKind::SharedDrivesNotEntitled)
    )
}

/// Whether a session key is in memory: this task never asks for one.
fn has_session_key(state: &AppState) -> bool {
    crate::sync::remote::session_mnemonic(state).is_ok()
}

/// Whether this account's plan includes sharing, which gates its OWN drives
/// only. A drive it manages follows its owner's plan.
async fn own_plan_allows(state: &AppState, plan: &mut PlanGate) -> bool {
    if let Some(answer) = plan.fresh(Instant::now()) {
        return answer;
    }
    match crate::billing::storage_overview::fetch_can_share_drives(state).await {
        Ok(answer) => {
            plan.record(answer, Instant::now());
            answer
        }
        Err(_) => false,
    }
}

/// The plan answer, trusted for [`PLAN_TTL`]. Delivering a key adds a
/// person, so it follows the rule inviting follows; a nudge forgets the
/// answer so an upgrade is picked up at once.
#[derive(Debug, Default)]
pub(crate) struct PlanGate {
    answer: Option<(bool, Instant)>,
}

impl PlanGate {
    /// The remembered answer, if it is still fresh at `now`.
    pub(crate) fn fresh(&self, now: Instant) -> Option<bool> {
        self.answer
            .filter(|(_, at)| now.saturating_duration_since(*at) < PLAN_TTL)
            .map(|(answer, _)| answer)
    }

    pub(crate) fn record(&mut self, answer: bool, now: Instant) {
        self.answer = Some((answer, now));
    }

    pub(crate) fn forget(&mut self) {
        self.answer = None;
    }
}

/// What one pass keeps track of across drives.
#[derive(Default)]
struct PassTally {
    active: bool,
    failed: bool,
    unavailable: bool,
    every_drive_read: bool,
    waiting: HashSet<(String, String)>,
}

impl PassTally {
    fn outcome(&self) -> PassOutcome {
        if self.active {
            PassOutcome::Active
        } else if self.failed {
            PassOutcome::Failed
        } else if self.unavailable {
            PassOutcome::Unavailable
        } else {
            PassOutcome::Quiet
        }
    }
}

/// How sealing one drive's due rows ended.
enum DriveSeal {
    /// Every due row was tried (whatever each outcome).
    Done { failed: bool },
    /// The key could not be resolved or the recovery lock was busy; try
    /// again next pass.
    Retry,
    /// The session locked or changed mid-pass: stop the pass.
    Stop,
}

/// A drive this account manages, as the memberships listing names it.
#[derive(Debug, Clone)]
pub(crate) struct MembershipDrive {
    pub owner_ss58: String,
    pub folder_hash: String,
    /// The wire role, read through [`commands::drive_role_from_wire`].
    pub role: String,
    /// The owner's name for the drive, for the delivered toast.
    pub display_label: String,
    /// The local label when this device syncs the drive; key material for a
    /// synced drive is read by it.
    pub local_label: Option<String>,
}

/// One drive a pass reads invites for and may seal on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SealTarget {
    /// The label key material resolves by.
    pub label: String,
    /// The name the delivered toast uses.
    pub name: String,
    pub identity: crate::sync::identity::DriveIdentity,
}

/// Which drives a pass works on, through the one owner-or-Manager rule
/// ([`commands::manages_drive`]).
///
/// Own drives only when this account's plan includes sharing; drives it
/// manages whatever its own plan says (their owner's plan decides, on the
/// server). A membership naming this account as the owner is not a
/// delegated drive and is skipped. Pure, so the gate is tested.
pub(crate) fn seal_targets(
    account_id: &str,
    own: Vec<(String, String)>,
    own_plan_allows: bool,
    memberships: Vec<MembershipDrive>,
) -> Vec<SealTarget> {
    let mut targets = Vec::new();
    if own_plan_allows && commands::manages_drive(false, None) {
        for (label, folder_hash) in own {
            if label.trim().is_empty() || folder_hash.trim().is_empty() {
                continue;
            }
            targets.push(SealTarget {
                name: label.clone(),
                label,
                identity: crate::sync::identity::DriveIdentity {
                    wire_ss58: account_id.to_string(),
                    wire_folder_hash: folder_hash,
                    is_member: false,
                },
            });
        }
    }
    for m in memberships {
        if m.owner_ss58 == account_id || m.owner_ss58.trim().is_empty() || m.folder_hash.trim().is_empty() {
            continue;
        }
        if !commands::manages_drive(true, Some(&m.role)) {
            continue;
        }
        targets.push(SealTarget {
            label: m.local_label.unwrap_or_else(|| m.display_label.clone()),
            name: m.display_label,
            identity: crate::sync::identity::DriveIdentity {
                wire_ss58: m.owner_ss58,
                wire_folder_hash: m.folder_hash,
                is_member: true,
            },
        });
    }
    targets
}

/// Note a listing that could not be read in the tally.
fn note_unread(tally: &mut PassTally, err: &AppError, what: &str) {
    tally.every_drive_read = false;
    if is_unavailable(err) {
        tally.unavailable = true;
    } else {
        debug!(error = %err, "Email invite delivery could not list {what}");
        tally.failed = true;
    }
}

/// The drives this account manages but does not own, from its memberships.
async fn managed_drives(pool: &sqlx::SqlitePool, http: &reqwest::Client, ctx: &commands::ApiCtx, account_id: &str) -> Result<Vec<MembershipDrive>> {
    let listing = commands::http_list_memberships(http, ctx.base_url(), ctx.bearer()).await?;
    let mut drives = Vec::new();
    for m in listing.memberships {
        let role = commands::drive_role_from_wire(&m.role);
        // Only what the rule could admit needs a local lookup.
        if !commands::manages_drive(true, Some(&role)) {
            continue;
        }
        let local = crate::sync::identity::member_row_for_wire_identity(pool, account_id, &m.owner_ss58, &m.folder_hash)
            .await
            .ok()
            .flatten();
        drives.push(MembershipDrive {
            owner_ss58: m.owner_ss58,
            folder_hash: m.folder_hash,
            role,
            display_label: m.display_label,
            local_label: local.map(|row| row.label),
        });
    }
    Ok(drives)
}

/// One pass over the drives this account owns or manages.
async fn pass(
    app: &tauri::AppHandle,
    state: &AppState,
    account_id: &str,
    folder_invites: bool,
    memory: &mut AttemptMemory,
    plan: &mut PlanGate,
) -> PassOutcome {
    if !has_session_key(state) {
        return PassOutcome::Unavailable;
    }
    let Ok(ctx) = commands::api_ctx_for(state).await else {
        return PassOutcome::Unavailable;
    };
    let Ok(pool) = state.pool() else {
        return PassOutcome::Unavailable;
    };
    if ctx.account_id() != account_id {
        return PassOutcome::Unavailable;
    }
    let http = state.api_client.clone();

    let mut tally = PassTally {
        every_drive_read: true,
        ..PassTally::default()
    };

    let own_allowed = own_plan_allows(state, plan).await;
    let own = if own_allowed {
        match commands::http_list_owner_folders(&http, ctx.base_url(), ctx.bearer(), account_id).await {
            Ok(folders) => folders.into_iter().map(|f| (f.label, f.folder_hash)).collect(),
            Err(e) => {
                note_unread(&mut tally, &e, "drives");
                Vec::new()
            }
        }
    } else {
        // Nothing to do on own drives until the plan changes.
        tally.unavailable = true;
        Vec::new()
    };
    let memberships = match managed_drives(pool, &http, &ctx, account_id).await {
        Ok(drives) => drives,
        Err(e) => {
            note_unread(&mut tally, &e, "shared drives");
            Vec::new()
        }
    };

    for target in seal_targets(account_id, own, own_allowed, memberships) {
        let owner = commands::member_owner(&target.identity);
        let mut invites = match commands::http_list_invites(&http, ctx.base_url(), ctx.bearer(), &target.identity.wire_folder_hash, owner).await {
            Ok(invites) => invites,
            Err(e) => {
                note_unread(&mut tally, &e, "invites");
                continue;
            }
        };
        for invite in &mut invites {
            commands::normalize_invite_fields(invite);
        }
        tally.active |= has_open_email_invite(&invites);

        let mut due = Vec::new();
        for invite in &invites {
            if let Some(row) = auto_sealable(invite, folder_invites) {
                tally.waiting.insert((invite.invite_id.clone(), row.requester_pubkey.clone()));
                if !memory.contains(&invite.invite_id, &row.requester_pubkey) {
                    due.push((invite, row));
                }
            }
        }
        if due.is_empty() {
            continue;
        }

        match seal_drive(app, state, &http, &ctx, account_id, &target, due, memory).await {
            DriveSeal::Done { failed } => tally.failed |= failed,
            DriveSeal::Retry => tally.failed = true,
            DriveSeal::Stop => return PassOutcome::Unavailable,
        }
    }

    if tally.every_drive_read {
        memory.retain_waiting(&tally.waiting);
    }
    tally.outcome()
}

/// Resolve one drive's keys and seal its due rows, reporting each delivery.
#[allow(clippy::too_many_arguments)] // one drive's worth of context, all borrowed
async fn seal_drive(
    app: &tauri::AppHandle,
    state: &AppState,
    http: &reqwest::Client,
    ctx: &commands::ApiCtx,
    account_id: &str,
    drive: &SealTarget,
    due: Vec<(&DriveInviteInfo, ApprovableInvite)>,
    memory: &mut AttemptMemory,
) -> DriveSeal {
    // Never wait behind a recovery or a password rotation; the next pass
    // tries again.
    let Ok(recovery_guard) = state.recovery_lock.try_lock() else {
        return DriveSeal::Retry;
    };
    let Ok(mnemonic) = crate::sync::remote::session_mnemonic(state) else {
        return DriveSeal::Stop;
    };
    let keys = commands::invite_seal_keys(state, account_id, &drive.label, &mnemonic, &drive.identity).await;
    drop(mnemonic);
    drop(recovery_guard);
    let keys = match keys {
        Ok(keys) => keys,
        Err(e) => {
            warn!(label = %drive.label, error = %e, "Email invite delivery could not resolve the drive key");
            return DriveSeal::Retry;
        }
    };

    let mut failed = false;
    for (invite, row) in due {
        // Signed out or switched mid-pass: post nothing for the old account.
        if !session_is(state, account_id) {
            return DriveSeal::Stop;
        }
        if !memory.begin(&invite.invite_id, &row.requester_pubkey) {
            continue;
        }
        let result = commands::seal_invite_row(http, ctx, &drive.identity, &invite.invite_id, &row, &keys).await;
        let verdict = attempt_verdict(&result);
        memory.settle(&invite.invite_id, &row.requester_pubkey, verdict);
        match result {
            Ok(SealKeyPut::Sealed) => {
                info!(label = %drive.label, invite_id = %invite.invite_id, "Emailed invite key delivered");
                let payload = InviteKeyDelivered {
                    label: drive.name.clone(),
                    folder_hash: drive.identity.wire_folder_hash.clone(),
                    invite_id: invite.invite_id.clone(),
                    recipient_email: invite.recipient_email.clone(),
                    path_prefix: invite.path_prefix.clone(),
                };
                if let Err(e) = app.emit("shared-drive:invite-key-delivered", &payload) {
                    warn!(error = %e, "Could not report a delivered invite key");
                }
            }
            Ok(SealKeyPut::AlreadySealed) => {
                debug!(invite_id = %invite.invite_id, "Emailed invite was already approved");
            }
            Ok(SealKeyPut::Stale) => {
                debug!(invite_id = %invite.invite_id, "Recipient key changed; retrying next pass");
            }
            Err(e) => {
                warn!(invite_id = %invite.invite_id, error = %e, "Emailed invite key delivery failed");
                failed |= verdict == AttemptVerdict::Forget;
            }
        }
    }
    // `keys` drops here, which zeroizes both keys.
    DriveSeal::Done { failed }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, status: Option<&str>, pubkey: Option<&str>) -> DriveInviteInfo {
        serde_json::from_value(serde_json::json!({
            "invite_id": id,
            "role": "reader",
            "expires_at": "",
            "max_uses": 1,
            "use_count": 0,
            "revoked": false,
            "valid": true,
            "created_at": "",
            "email_status": status,
            "requester_pubkey": pubkey,
        }))
        .expect("row")
    }

    #[test]
    fn only_a_valid_row_awaiting_seal_with_a_key_is_sealed() {
        assert_eq!(
            auto_sealable(&row("a", Some("awaiting_seal"), Some(" PUB ")), false),
            Some(ApprovableInvite {
                requester_pubkey: "PUB".into(),
                path_prefix: None
            })
        );
        // Sealed rows keep their key; sealing again would 409.
        assert!(auto_sealable(&row("b", Some("sealed"), Some("PUB")), false).is_none());
        assert!(auto_sealable(&row("c", Some("sent"), None), false).is_none());
        assert!(auto_sealable(&row("d", None, Some("PUB")), false).is_none(), "a link invite");
        assert!(auto_sealable(&row("e", Some("awaiting_seal"), None), false).is_none());
        assert!(auto_sealable(&row("f", Some("awaiting_seal"), Some("   ")), false).is_none());

        let mut dead = row("g", Some("awaiting_seal"), Some("PUB"));
        dead.valid = false;
        assert!(auto_sealable(&dead, false).is_none(), "expired or spent");
        let mut revoked = row("h", Some("awaiting_seal"), Some("PUB"));
        revoked.revoked = true;
        assert!(auto_sealable(&revoked, false).is_none(), "revoked");
    }

    #[test]
    fn a_folder_invite_is_sealed_only_with_folder_collaboration_on() {
        let mut folder = row("f", Some("awaiting_seal"), Some("PUB"));
        folder.path_prefix = Some("Clients/ACME".into());
        assert!(auto_sealable(&folder, false).is_none());
        let due = auto_sealable(&folder, true).expect("due");
        assert_eq!(due.path_prefix.as_deref(), Some("Clients/ACME"), "the folder rule needs the prefix");
    }

    #[test]
    fn sent_and_awaiting_rows_keep_the_fast_cadence() {
        assert!(has_open_email_invite(&[row("a", Some("sent"), None)]));
        assert!(has_open_email_invite(&[row("a", Some("awaiting_seal"), Some("P"))]));
        assert!(!has_open_email_invite(&[row("a", Some("sealed"), Some("P"))]));
        assert!(!has_open_email_invite(&[row("a", None, None)]));
        let mut dead = row("a", Some("sent"), None);
        dead.valid = false;
        assert!(!has_open_email_invite(&[dead]));
        assert!(!has_open_email_invite(&[]));
    }

    #[test]
    fn a_pair_is_tried_once_and_retried_after_stale_or_transient() {
        let mut memory = AttemptMemory::default();
        assert!(memory.begin("i", "k1"));
        memory.settle("i", "k1", attempt_verdict(&Ok(SealKeyPut::Sealed)));
        assert!(!memory.begin("i", "k1"), "no double seal");

        assert!(memory.begin("j", "k"));
        memory.settle("j", "k", attempt_verdict(&Ok(SealKeyPut::Stale)));
        assert!(memory.begin("j", "k"), "stale is retried");

        assert!(memory.begin("n", "k"));
        memory.settle("n", "k", attempt_verdict(&Err(AppError::Hcfs("offline".into()))));
        assert!(memory.begin("n", "k"), "transient is retried");

        assert!(memory.begin("x", "k"));
        memory.settle("x", "k", attempt_verdict(&Ok(SealKeyPut::AlreadySealed)));
        assert!(!memory.begin("x", "k"), "somebody else sealed it: done");

        assert!(memory.begin("bad", "k"));
        memory.settle("bad", "k", attempt_verdict(&Err(AppError::Crypto("not a key".into()))));
        assert!(!memory.begin("bad", "k"), "a key that does not parse is not hammered");

        // A rotated key is a new delivery.
        assert!(memory.begin("i", "k2"));
    }

    #[test]
    fn memory_forgets_pairs_that_are_no_longer_waiting() {
        let mut memory = AttemptMemory::default();
        memory.begin("i", "k");
        memory.begin("j", "k");
        let waiting: HashSet<(String, String)> = [("j".to_string(), "k".to_string())].into();
        memory.retain_waiting(&waiting);
        assert!(!memory.contains("i", "k"));
        assert!(memory.contains("j", "k"));
    }

    #[test]
    fn cadence_is_fast_only_while_something_is_in_flight() {
        assert_eq!(next_delay(PassOutcome::Active, 0), ACTIVE_INTERVAL);
        assert_eq!(next_delay(PassOutcome::Quiet, 0), QUIET_INTERVAL);
        assert_eq!(next_delay(PassOutcome::Unavailable, 0), QUIET_INTERVAL);
        assert!(QUIET_INTERVAL >= Duration::from_mins(2) && QUIET_INTERVAL <= MAX_BACKOFF);
    }

    #[test]
    fn errors_back_off_exponentially_to_a_ceiling() {
        let delays: Vec<u64> = (1..=6).map(|n| next_delay(PassOutcome::Failed, n).as_secs()).collect();
        assert_eq!(delays, vec![30, 60, 120, 240, 300, 300]);
        assert_eq!(next_delay(PassOutcome::Failed, u32::MAX), MAX_BACKOFF, "never overflows");
        assert_eq!(next_delay(PassOutcome::Failed, 0).as_secs(), 30);
    }

    #[test]
    fn the_plan_gate_and_a_feature_off_server_are_not_errors() {
        assert!(is_unavailable(&AppError::NotReady(NotReadyKind::SharedDrivesNotEntitled)));
        assert!(is_unavailable(&AppError::NotReady(NotReadyKind::SharedDrivesUnavailable)));
        assert!(!is_unavailable(&AppError::Hcfs("offline".into())));
    }

    /// The plan answer is reused only while fresh, and a nudge (an upgrade,
    /// Manage access opened) reads it again.
    #[test]
    fn the_plan_answer_is_reused_until_stale_or_nudged() {
        let start = Instant::now();
        let mut gate = PlanGate::default();
        assert_eq!(gate.fresh(start), None, "nothing read yet");
        gate.record(false, start);
        assert_eq!(gate.fresh(start + Duration::from_secs(1)), Some(false));
        assert_eq!(gate.fresh(start + PLAN_TTL), None, "stale answers are read again");
        gate.record(true, start);
        gate.forget();
        assert_eq!(gate.fresh(start), None, "a nudge forgets the answer");
    }

    fn membership(owner: &str, hash: &str, role: &str, local: Option<&str>) -> MembershipDrive {
        MembershipDrive {
            owner_ss58: owner.into(),
            folder_hash: hash.into(),
            role: role.into(),
            display_label: format!("{owner}-drive"),
            local_label: local.map(str::to_string),
        }
    }

    /// Own drives and drives this account manages are sealed for; a drive it
    /// only views or edits, or where the role is unknown, never is.
    #[test]
    fn own_and_managed_drives_are_sealed_for_and_nothing_else() {
        let targets = seal_targets(
            "5Me",
            vec![("Team".into(), "fh1".into()), (" ".into(), "fh2".into())],
            true,
            vec![
                membership("5Ann", "fa", "manager", None),
                membership("5Bo", "fb", "writer", None),
                membership("5Cy", "fc", "reader", None),
                membership("5Di", "fd", "admin", None),
                membership("5Me", "fe", "manager", None),
                membership("5Ed", "ff", "manager", Some("synced-here")),
            ],
        );
        let seen: Vec<(&str, &str, bool, &str)> = targets
            .iter()
            .map(|t| {
                (
                    t.identity.wire_ss58.as_str(),
                    t.identity.wire_folder_hash.as_str(),
                    t.identity.is_member,
                    t.label.as_str(),
                )
            })
            .collect();
        assert_eq!(
            seen,
            [
                ("5Me", "fh1", false, "Team"),
                ("5Ann", "fa", true, "5Ann-drive"),
                ("5Ed", "ff", true, "synced-here"),
            ]
        );
        // A managed drive names its owner on the wire.
        assert_eq!(commands::member_owner(&targets[1].identity), Some("5Ann"));
        assert_eq!(commands::member_owner(&targets[0].identity), None);
        assert_eq!(targets[2].name, "5Ed-drive", "the toast uses the owner's name for the drive");
    }

    /// This account's plan gates its own drives only: a drive it manages
    /// follows the owner's plan, which the server enforces.
    #[test]
    fn this_accounts_plan_never_holds_back_a_managed_drive() {
        let targets = seal_targets(
            "5Me",
            vec![("Team".into(), "fh1".into())],
            false,
            vec![membership("5Ann", "fa", "manager", None)],
        );
        assert_eq!(targets.len(), 1);
        assert!(targets[0].identity.is_member);
    }

    /// Automatic delivery seals exactly what Approve and a link would: the
    /// derived file key for a folder invitation, the entropy for a drive.
    #[test]
    fn folder_invites_carry_the_derived_key_like_approve() {
        use crate::sync::remote::DriveKeyMaterial;
        use zeroize::Zeroizing;
        let phrase = Zeroizing::new(
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon \
             abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art"
                .to_string(),
        );
        let keys = commands::InviteSealKeys::from_material(DriveKeyMaterial::Phrase(phrase.clone())).expect("keys");
        let folder = keys.key_for(true).expect("folder");
        let drive = keys.key_for(false).expect("drive");
        assert_eq!(
            *folder,
            crate::sync::remote::encryption_key_from_phrase(&phrase).expect("derived"),
            "a folder invitation gets the derived key"
        );
        assert_eq!(*drive, *super::super::grant::entropy_from_phrase(&phrase).expect("entropy"));
        assert_ne!(*folder, *drive);

        // A folder grant holder has only the derived key.
        let holder = commands::InviteSealKeys::from_material(DriveKeyMaterial::FileKey(folder.clone())).expect("holder");
        assert_eq!(*holder.key_for(true).expect("folder"), *folder);
        assert!(matches!(holder.key_for(false), Err(AppError::Validation(_))));
    }

    #[test]
    fn delivered_event_wire_keys_are_pinned() {
        let payload = InviteKeyDelivered {
            label: "Team".into(),
            folder_hash: "fh".into(),
            invite_id: "i".into(),
            recipient_email: None,
            path_prefix: Some("A".into()),
        };
        let json = serde_json::to_value(&payload).expect("json");
        assert_eq!(
            json,
            serde_json::json!({"label":"Team","folderHash":"fh","inviteId":"i","pathPrefix":"A"})
        );
        assert_eq!(INVITE_KEY_DELIVERED_EVENT, "shared-drive:invite-key-delivered");
    }
}
