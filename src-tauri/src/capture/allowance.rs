//! What this account's plan allows a screen recording: its recording tier.
//!
//! Free plan recordings stop at [`FREE_MAX_RECORDING`]; any paid Drive plan
//! records without a length limit. Screenshots are not affected. The tier is
//! decided once, when a recording starts (`commands::begin_recording`), and
//! the session's tick loop stops the recording at the limit exactly as Stop
//! would, so the file is saved and delivered as usual.
//!
//! The plan is read the way the rest of the app reads it
//! (`billing::storage_overview::PlanReads`): the drive-rail subscription
//! first, then the legacy card subscription. A plan that resolves is paid,
//! because the free tier never resolves to a plan; the `free` code and the
//! catalogue's `is_free` SKU are the free tier.
//!
//! **Fails open.** The cap is a product limit, not a security boundary, and
//! the two ways of being wrong are not symmetric: cutting a paying customer's
//! recording at five minutes loses their work, while letting a free account
//! record longer costs little. So:
//!
//! - a fresh read that cannot tell (a subscription that could not be loaded,
//!   a plan with no code) is no verdict;
//! - with no verdict now, the last one seen for this account is used (kept in
//!   memory and in `user_preferences`, so an offline start still knows);
//! - with no verdict ever seen, there is no cap.
//!
//! This matches the Drive quota gate (`billing::drive_quota`), which also
//! falls open on anything short of a verdict.
//!
//! The public surface is small on purpose, because other recording limits
//! read it: [`RecordingTier`], [`recording_tier`] and [`FREE_MAX_RECORDING`].

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use crate::app_state::{AppState, SessionAccount};
use crate::billing::storage_overview::{PlanInfo, PlanReads};

/// The longest a Free plan recording runs. Recorded time only: paused time
/// does not count.
pub const FREE_MAX_RECORDING: Duration = Duration::from_mins(5);

/// From how far before the limit the pill shows the time left.
pub const REMAINING_SHOWN_FROM: Duration = Duration::from_mins(1);

/// How long a recording's start waits for a fresh plan read before it uses
/// the last one it knows. The read runs alongside the recorder's own start,
/// which takes a second or two, so it adds nothing in the usual case.
pub const LOOKUP_WITHIN: Duration = Duration::from_secs(3);

/// What the card says after a Free plan recording stopped at the limit.
pub const FREE_LIMIT_NOTICE: &str = "Free recordings stop at 5 minutes. Upgrade for longer recordings.";

/// Which recording allowance an account has.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RecordingTier {
    /// No paid Drive plan: recordings stop at [`FREE_MAX_RECORDING`].
    Free,
    /// Any paid Drive plan: no length limit.
    Paid,
}

impl RecordingTier {
    /// The longest a recording on this tier may run, or `None` for no limit.
    #[must_use]
    pub fn max_recording(self) -> Option<Duration> {
        match self {
            Self::Free => Some(FREE_MAX_RECORDING),
            Self::Paid => None,
        }
    }

    fn as_stored(self) -> &'static str {
        match self {
            Self::Free => "free",
            Self::Paid => "paid",
        }
    }

    fn from_stored(value: &str) -> Option<Self> {
        match value {
            "free" => Some(Self::Free),
            "paid" => Some(Self::Paid),
            _ => None,
        }
    }
}

/// The length limit for a recording that starts with `tier`. An unknown tier
/// has none (fail open, see the module docs).
#[must_use]
pub fn max_recording(tier: Option<RecordingTier>) -> Option<Duration> {
    tier.and_then(RecordingTier::max_recording)
}

/// The tier from what the plan reads found, or `None` when they cannot tell.
///
/// - `plan` is the resolved paid plan; when there is one, the account is paid
///   (the free tier never resolves to a plan).
/// - `drive_sub` is the drive-rail subscription, `None` when it could not be
///   read: no verdict.
/// - An active drive subscription that did not resolve to a plan (a payload
///   missing its size, say) is decided by its code: the free code or a
///   catalogue `is_free` SKU is free, any other named code is paid, and an
///   empty code is no verdict.
/// - With no drive plan, a failed read of the legacy card subscription is no
///   verdict; a clean read that finds nothing is the free tier.
#[must_use]
pub fn resolve_recording_tier(
    plan: Option<&PlanInfo>,
    drive_sub: Option<&serde_json::Value>,
    drive_plans: &serde_json::Value,
    legacy_read: bool,
) -> Option<RecordingTier> {
    if plan.is_some() {
        return Some(RecordingTier::Paid);
    }
    let sub = drive_sub?;
    if let Some(code) = crate::billing::sharing_entitlement::active_drive_plan_code(sub) {
        let code = code.trim();
        if code.is_empty() {
            return None;
        }
        return Some(if crate::billing::storage_overview::drive_code_is_free(code, drive_plans) {
            RecordingTier::Free
        } else {
            RecordingTier::Paid
        });
    }
    if !legacy_read {
        return None;
    }
    Some(RecordingTier::Free)
}

/// [`resolve_recording_tier`] over the reads the overview already made.
pub(crate) fn tier_from_reads(reads: &PlanReads) -> Option<RecordingTier> {
    resolve_recording_tier(reads.plan.as_ref(), reads.drive_sub.as_ref(), &reads.drive_plans, reads.legacy_read)
}

/// A fresh verdict wins; without one, the last one seen for the account;
/// without that, `None`, which means no cap.
#[must_use]
pub fn decide(fresh: Option<RecordingTier>, last_known: Option<RecordingTier>) -> Option<RecordingTier> {
    fresh.or(last_known)
}

/// Whether a recording with `recorded_secs` of recorded time (pauses left
/// out) has reached `limit`.
#[must_use]
pub fn limit_reached(recorded_secs: u64, limit: Option<Duration>) -> bool {
    limit.is_some_and(|limit| recorded_secs >= limit.as_secs())
}

/// The seconds left before `limit`, once there are [`REMAINING_SHOWN_FROM`]
/// or fewer; `None` when there is no limit or plenty of time left.
#[must_use]
pub fn remaining_to_show(recorded_secs: u64, limit: Option<Duration>) -> Option<u64> {
    let left = limit?.as_secs().saturating_sub(recorded_secs);
    (left <= REMAINING_SHOWN_FROM.as_secs()).then_some(left)
}

/// The `user_preferences` key holding an account's last known tier.
fn stored_key(account: &str) -> String {
    format!("capture.recordingTier.{account}")
}

/// The last tier seen per account: in memory for this run, and in
/// `user_preferences` so a start without a network still knows it.
#[derive(Debug, Default)]
pub struct TierCache {
    seen: Mutex<HashMap<String, RecordingTier>>,
}

impl TierCache {
    fn in_memory(&self, account: &str) -> Option<RecordingTier> {
        self.seen.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(account).copied()
    }

    /// Keep `tier` as the account's latest verdict. Written to disk only when
    /// it changes, since the overview reports it on every poll.
    pub async fn remember(&self, pool: Option<&sqlx::SqlitePool>, account: &str, tier: RecordingTier) {
        let previous = self
            .seen
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(account.to_string(), tier);
        if previous == Some(tier) {
            return;
        }
        let Some(pool) = pool else { return };
        if let Err(e) = crate::utils::preferences::save_user_preference_internal(pool, &stored_key(account), tier.as_stored()).await {
            tracing::warn!(error = %e, "could not keep the recording tier");
        }
    }

    /// The account's last verdict: this run's, or else the one kept on disk.
    pub async fn last_known(&self, pool: Option<&sqlx::SqlitePool>, account: &str) -> Option<RecordingTier> {
        if let Some(tier) = self.in_memory(account) {
            return Some(tier);
        }
        let pool = pool?;
        let stored = match crate::utils::preferences::get_user_preference_internal(pool, &stored_key(account)).await {
            Ok(value) => value.as_deref().and_then(RecordingTier::from_stored),
            Err(e) => {
                tracing::warn!(error = %e, "could not read the last recording tier");
                None
            }
        };
        if let Some(tier) = stored {
            self.seen
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .entry(account.to_string())
                .or_insert(tier);
        }
        stored
    }
}

/// Keep `tier` as `account`'s latest verdict (the storage overview calls this
/// on every read of the plan).
pub async fn remember(state: &AppState, account: &SessionAccount, tier: RecordingTier) {
    state.capture.recording_tiers.remember(state.pool().ok(), account.as_str(), tier).await;
}

/// This account's recording tier now, or `None` when nothing is known (no
/// cap: see the module docs).
///
/// Reads the plan fresh, bounded by [`LOOKUP_WITHIN`]; a fresh verdict is
/// remembered. Without one, the last verdict kept for the account answers.
pub async fn recording_tier(state: &AppState, account: &SessionAccount) -> Option<RecordingTier> {
    let fresh = match tokio::time::timeout(LOOKUP_WITHIN, crate::billing::storage_overview::fetch_plan_reads(state, account)).await {
        Ok(Ok(reads)) => tier_from_reads(&reads),
        Ok(Err(e)) => {
            tracing::warn!(error = %e, "could not read the plan for the recording tier");
            None
        }
        Err(_) => {
            tracing::warn!("the plan read for the recording tier took too long; using the last one known");
            None
        }
    };
    if let Some(tier) = fresh {
        remember(state, account, tier).await;
        return Some(tier);
    }
    let last_known = state.capture.recording_tiers.last_known(state.pool().ok(), account.as_str()).await;
    let tier = decide(fresh, last_known);
    if tier.is_none() {
        tracing::info!("no recording tier known for this account; recording without a length limit");
    }
    tier
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn plan(code: &str) -> PlanInfo {
        PlanInfo {
            name: "Any".into(),
            code: code.into(),
            amount: 5.0,
            interval: "month".into(),
            storage_bytes: 1,
            storage_display: "1 GB".into(),
            funding: None,
            renews_in_days: None,
            renewal_unix_day: None,
        }
    }

    fn catalogue() -> serde_json::Value {
        json!([
            { "code": "free", "is_free": true, "storage_bytes": 10u64 },
            { "code": "starter-free", "is_free": true, "storage_bytes": 10u64 },
            { "code": "duo", "is_free": false, "storage_bytes": 2000u64 }
        ])
    }

    #[test]
    fn a_resolved_plan_is_paid() {
        let sub = json!({ "active": true, "plan": "duo" });
        assert_eq!(
            resolve_recording_tier(Some(&plan("duo")), Some(&sub), &catalogue(), true),
            Some(RecordingTier::Paid)
        );
        // The legacy card plan has no code, and is still a paid plan.
        assert_eq!(
            resolve_recording_tier(Some(&plan("")), None, &json!([]), false),
            Some(RecordingTier::Paid)
        );
    }

    #[test]
    fn no_plan_on_a_clean_read_is_free() {
        let inactive = json!({ "active": false });
        assert_eq!(
            resolve_recording_tier(None, Some(&inactive), &catalogue(), true),
            Some(RecordingTier::Free)
        );
        let free = json!({ "active": true, "plan": "free" });
        assert_eq!(resolve_recording_tier(None, Some(&free), &catalogue(), true), Some(RecordingTier::Free));
        let free_caps = json!({ "active": true, "plan": "FREE" });
        assert_eq!(
            resolve_recording_tier(None, Some(&free_caps), &json!([]), true),
            Some(RecordingTier::Free)
        );
        // A free SKU under another code is free by the catalogue's word.
        let free_sku = json!({ "active": true, "plan": "starter-free" });
        assert_eq!(
            resolve_recording_tier(None, Some(&free_sku), &catalogue(), true),
            Some(RecordingTier::Free)
        );
    }

    /// A paying account the overview could not size is still paid.
    #[test]
    fn an_active_paid_code_without_a_plan_is_paid() {
        let plus = json!({ "active": true, "plan": "duo" });
        assert_eq!(resolve_recording_tier(None, Some(&plus), &catalogue(), true), Some(RecordingTier::Paid));
    }

    /// Anything that cannot tell is no verdict, never "free".
    #[test]
    fn an_unreadable_plan_is_no_verdict() {
        assert_eq!(resolve_recording_tier(None, None, &catalogue(), true), None, "drive rail unreadable");
        let inactive = json!({ "active": false });
        assert_eq!(
            resolve_recording_tier(None, Some(&inactive), &catalogue(), false),
            None,
            "legacy unreadable"
        );
        let nameless = json!({ "active": true, "plan": "  " });
        assert_eq!(resolve_recording_tier(None, Some(&nameless), &catalogue(), true), None, "no code");
    }

    #[test]
    fn only_free_has_a_length_limit_and_unknown_has_none() {
        assert_eq!(max_recording(Some(RecordingTier::Free)), Some(Duration::from_mins(5)));
        assert_eq!(max_recording(Some(RecordingTier::Paid)), None);
        assert_eq!(max_recording(None), None, "fail open");
    }

    #[test]
    fn a_fresh_verdict_wins_then_the_last_known_then_none() {
        use RecordingTier::{Free, Paid};
        assert_eq!(decide(Some(Paid), Some(Free)), Some(Paid), "an upgrade takes effect at once");
        assert_eq!(decide(Some(Free), Some(Paid)), Some(Free));
        assert_eq!(decide(None, Some(Free)), Some(Free), "offline: the last verdict");
        assert_eq!(decide(None, None), None, "never seen: no cap");
    }

    /// Five minutes of recorded time, and not a second before.
    #[test]
    fn the_free_limit_is_reached_at_five_minutes_of_recorded_time() {
        let free = max_recording(Some(RecordingTier::Free));
        assert!(!limit_reached(0, free));
        assert!(!limit_reached(299, free));
        assert!(limit_reached(300, free));
        assert!(limit_reached(301, free), "a skipped tick still stops it");
        assert!(!limit_reached(10_000, None), "no limit, never reached");
    }

    /// Pauses do not count: the limit reads the recorder's clock, which
    /// leaves them out, so 200 s, a long pause and 99 s more is not there yet.
    #[test]
    fn paused_time_does_not_bring_the_limit_closer() {
        use crate::capture::recording::RecordedClock;
        use std::time::Instant;
        let free = max_recording(Some(RecordingTier::Free));
        let t0 = Instant::now();
        let at = |secs: u64| t0 + Duration::from_secs(secs);
        let mut clock = RecordedClock::default();
        clock.start_at(t0);
        clock.freeze_at(at(200));
        assert!(!limit_reached(clock.elapsed_at(at(900)).as_secs(), free), "ten minutes paused");
        clock.start_at(at(900));
        assert!(!limit_reached(clock.elapsed_at(at(999)).as_secs(), free));
        assert!(limit_reached(clock.elapsed_at(at(1000)).as_secs(), free));
    }

    #[test]
    fn the_time_left_shows_only_in_the_last_minute() {
        let free = max_recording(Some(RecordingTier::Free));
        assert_eq!(remaining_to_show(0, free), None);
        assert_eq!(remaining_to_show(239, free), None);
        assert_eq!(remaining_to_show(240, free), Some(60));
        assert_eq!(remaining_to_show(299, free), Some(1));
        assert_eq!(remaining_to_show(300, free), Some(0));
        assert_eq!(remaining_to_show(400, free), Some(0), "never below zero");
        assert_eq!(remaining_to_show(299, None), None, "no limit, nothing to count down");
    }

    async fn pool() -> sqlx::SqlitePool {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.expect("memory sqlite");
        sqlx::query("CREATE TABLE user_preferences (preference_key TEXT PRIMARY KEY, preference_value TEXT NOT NULL, updated_at INTEGER NOT NULL)")
            .execute(&pool)
            .await
            .expect("create user_preferences");
        pool
    }

    /// A restart with no network still knows the last verdict, per account.
    #[tokio::test]
    async fn the_last_verdict_survives_a_restart_per_account() {
        let pool = pool().await;
        let before = TierCache::default();
        before.remember(Some(&pool), "5Alice", RecordingTier::Free).await;
        before.remember(Some(&pool), "5Bob", RecordingTier::Paid).await;
        assert_eq!(before.last_known(Some(&pool), "5Alice").await, Some(RecordingTier::Free));

        let after = TierCache::default();
        assert_eq!(after.last_known(Some(&pool), "5Alice").await, Some(RecordingTier::Free));
        assert_eq!(after.last_known(Some(&pool), "5Bob").await, Some(RecordingTier::Paid));
        assert_eq!(after.last_known(Some(&pool), "5Carol").await, None, "never seen");
        assert_eq!(after.last_known(None, "5Carol").await, None);
    }

    /// An upgrade replaces the kept verdict, on disk too.
    #[tokio::test]
    async fn a_new_verdict_replaces_the_kept_one() {
        let pool = pool().await;
        let cache = TierCache::default();
        cache.remember(Some(&pool), "5Alice", RecordingTier::Free).await;
        cache.remember(Some(&pool), "5Alice", RecordingTier::Paid).await;
        assert_eq!(cache.last_known(Some(&pool), "5Alice").await, Some(RecordingTier::Paid));
        assert_eq!(
            TierCache::default().last_known(Some(&pool), "5Alice").await,
            Some(RecordingTier::Paid),
            "the disk copy moved with it"
        );
    }

    /// Without a database the verdict is still kept for this run.
    #[tokio::test]
    async fn without_a_database_the_verdict_is_kept_in_memory() {
        let cache = TierCache::default();
        cache.remember(None, "5Alice", RecordingTier::Free).await;
        assert_eq!(cache.last_known(None, "5Alice").await, Some(RecordingTier::Free));
    }
}
