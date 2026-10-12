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
//! **Never on an unknown plan.** Every capture decision (the watermark, the
//! length limit, the recording count) is made only on a plan the API
//! returned for this capture. While the plan is being read the capture bar
//! says so and nothing can start ([`SessionPlan`]); a read that fails
//! (offline, an API error, [`LOOKUP_WITHIN`] passed, a payload that cannot
//! tell) refuses the capture with a Retry ([`PlanRefusal::Unreachable`]).
//! No verdict is kept across reads to stand in for a failed one.
//!
//! An account with no Drive storage at all (an access-key login with no paid
//! plan, `storage_overview::free_tier_entitled`) has nowhere for a capture
//! to go, so it is refused at once with an Upgrade
//! ([`PlanRefusal::NoDrivePlan`]) instead of capturing.
//!
//! The public surface is small on purpose, because other recording limits
//! read it: [`RecordingTier`], [`recording_tier`], [`session_tier`] and
//! [`FREE_MAX_RECORDING`].

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use crate::app_state::{AppState, SessionAccount};
use crate::billing::storage_overview::{PlanInfo, PlanReads};
use crate::error::{AppError, NotReadyKind, Result};

/// The longest a Free plan recording runs. Recorded time only: paused time
/// does not count.
pub const FREE_MAX_RECORDING: Duration = Duration::from_mins(5);

/// From how far before the limit the pill shows the time left.
pub const REMAINING_SHOWN_FROM: Duration = Duration::from_mins(1);

/// How long a plan read may take before it counts as failed. The read
/// starts with the capture session, while the user is still choosing, so it
/// is usually done before anything waits for it.
pub const LOOKUP_WITHIN: Duration = Duration::from_secs(10);

/// What the card says after a Free plan recording stopped at the limit.
pub const FREE_LIMIT_NOTICE: &str = "Free recordings stop at 5 minutes. Upgrade for longer recordings.";

/// What the capture bar says while the plan is being read.
pub const PLAN_CHECKING: &str = "Checking your plan…";

/// The refusal when the plan could not be read (`CapturePlanUnavailable`).
pub const PLAN_UNAVAILABLE: &str = "We couldn't check your plan. Check your connection and try again.";

/// The refusal for an account with no Drive storage (`CaptureNoDrivePlan`).
pub const NO_DRIVE_PLAN: &str = "Captures are saved to Hippius Drive, and this account has no Drive storage yet. Choose a plan to start capturing.";

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
}

/// Why no capture can start on the plan read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanRefusal {
    /// The plan could not be read (offline, an API error, too slow, or an
    /// answer that cannot tell). The way out is to try again.
    Unreachable,
    /// The account has no Drive storage at all (an access-key login with no
    /// paid plan). The way out is a plan.
    NoDrivePlan,
}

impl PlanRefusal {
    /// The structured refusal every capture entry point returns.
    #[must_use]
    pub fn not_ready(self) -> NotReadyKind {
        match self {
            Self::Unreachable => NotReadyKind::CapturePlanUnavailable,
            Self::NoDrivePlan => NotReadyKind::CaptureNoDrivePlan,
        }
    }

    /// What the bar offers next to the refusal.
    #[must_use]
    pub fn action(self) -> PlanAction {
        match self {
            Self::Unreachable => PlanAction::Retry,
            Self::NoDrivePlan => PlanAction::Upgrade,
        }
    }
}

impl From<PlanRefusal> for AppError {
    fn from(refusal: PlanRefusal) -> Self {
        Self::NotReady(refusal.not_ready())
    }
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

/// What a capture may do on a plan read: `read` is the tier the API's
/// answers resolved to (`None` when they could not tell or never came), and
/// `free_tier_entitled` whether the account gets the included free storage.
///
/// No verdict refuses with a Retry. The free tier on an account that is not
/// entitled to it is no Drive storage at all, refused with an Upgrade. A
/// paid plan is a paid plan however the account signed in.
///
/// # Errors
///
/// [`PlanRefusal`] when no capture may start.
pub fn decide_plan(read: Option<RecordingTier>, free_tier_entitled: bool) -> std::result::Result<RecordingTier, PlanRefusal> {
    match read {
        None => Err(PlanRefusal::Unreachable),
        Some(RecordingTier::Free) if !free_tier_entitled => Err(PlanRefusal::NoDrivePlan),
        Some(tier) => Ok(tier),
    }
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

/// This account's recording tier now, read fresh from the plan API and
/// bounded by [`LOOKUP_WITHIN`].
///
/// # Errors
///
/// [`PlanRefusal::Unreachable`] when the plan could not be read or cannot
/// tell; [`PlanRefusal::NoDrivePlan`] for an account with no Drive storage.
pub async fn recording_tier(state: &AppState, account: &SessionAccount) -> std::result::Result<RecordingTier, PlanRefusal> {
    let read = match tokio::time::timeout(LOOKUP_WITHIN, crate::billing::storage_overview::fetch_plan_reads(state, account)).await {
        Ok(Ok(reads)) => tier_from_reads(&reads),
        Ok(Err(e)) => {
            tracing::warn!(error = %e, "could not read the plan for the recording tier");
            None
        }
        Err(_) => {
            tracing::warn!("the plan read for the recording tier took too long");
            None
        }
    };
    // Only the free tier asks how the account signed in: a paid plan is paid
    // whatever the login, and no verdict is refused either way.
    let entitled = match read {
        Some(RecordingTier::Free) => free_tier_entitled(state, account).await,
        _ => true,
    };
    let decided = decide_plan(read, entitled);
    if let Err(refusal) = decided {
        tracing::info!(?refusal, "capture refused on the plan read");
    }
    decided
}

/// Whether the account gets the included free storage: how it signed in,
/// the same rule the storage overview applies.
async fn free_tier_entitled(state: &AppState, account: &SessionAccount) -> bool {
    let provider = match state.pool() {
        Ok(pool) => crate::auth::auth_session_repo::get_provider(pool, account.as_str())
            .await
            .unwrap_or_else(|e| {
                tracing::warn!(error = %e, "could not read the session provider; assuming the free tier applies");
                None
            }),
        Err(_) => None,
    };
    crate::billing::storage_overview::free_tier_entitled(provider.as_deref())
}

// ── This capture's plan ─────────────────────────────────────────────────────

/// Where this capture session's plan read is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanCheck {
    /// No read began for this session.
    NotStarted,
    /// The read is under way: nothing can start yet.
    Checking,
    /// The read's verdict.
    Done(std::result::Result<RecordingTier, PlanRefusal>),
}

/// This capture session's plan read: started with the session
/// (`commands::prefetch_tier`), answered once, and read by every decision
/// the capture makes. A newer read (a new session, the bar's Retry) replaces
/// an older one, whose late answer is dropped.
#[derive(Debug)]
pub struct SessionPlan {
    tx: tokio::sync::watch::Sender<PlanCheck>,
    seq: AtomicU64,
}

impl Default for SessionPlan {
    fn default() -> Self {
        Self {
            tx: tokio::sync::watch::Sender::new(PlanCheck::NotStarted),
            seq: AtomicU64::new(0),
        }
    }
}

impl SessionPlan {
    /// A new read begins; returns its number for [`Self::finish`].
    pub fn begin(&self) -> u64 {
        let seq = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        self.tx.send_replace(PlanCheck::Checking);
        seq
    }

    /// Read `seq` answered. Kept only if no newer read began since; returns
    /// whether it was.
    pub fn finish(&self, seq: u64, verdict: std::result::Result<RecordingTier, PlanRefusal>) -> bool {
        let mut kept = false;
        self.tx.send_if_modified(|check| {
            if self.seq.load(Ordering::SeqCst) != seq {
                return false;
            }
            *check = PlanCheck::Done(verdict);
            kept = true;
            true
        });
        kept
    }

    /// Where the read is now.
    #[must_use]
    pub fn current(&self) -> PlanCheck {
        *self.tx.borrow()
    }

    /// The session's verdict, waiting for a read under way (at most
    /// `within`; a read that has not answered by then is a failed one).
    /// `None` when no read began.
    pub async fn settled(&self, within: Duration) -> Option<std::result::Result<RecordingTier, PlanRefusal>> {
        let mut rx = self.tx.subscribe();
        let waited = tokio::time::timeout(within, rx.wait_for(|check| *check != PlanCheck::Checking)).await;
        match waited {
            Ok(Ok(check)) => match *check {
                PlanCheck::NotStarted => None,
                PlanCheck::Done(verdict) => Some(verdict),
                PlanCheck::Checking => Some(Err(PlanRefusal::Unreachable)),
            },
            // The sender lives as long as `self`; a timeout is a failed read.
            Ok(Err(_)) | Err(_) => Some(Err(PlanRefusal::Unreachable)),
        }
    }
}

/// How long a decision waits on the session's read: the read's own bound
/// and a little more, so it never waits forever on one that hung.
const SETTLE_WITHIN: Duration = LOOKUP_WITHIN.saturating_add(Duration::from_secs(2));

/// THE plan decision for a capture: the session's read, waited for if it is
/// still under way, or a fresh read when the session started none.
///
/// # Errors
///
/// [`NotReadyKind::CapturePlanUnavailable`] (Retry) or
/// [`NotReadyKind::CaptureNoDrivePlan`] (Upgrade); `Auth` when nobody is
/// signed in.
pub async fn session_tier(state: &AppState) -> Result<RecordingTier> {
    let plan = &state.capture.plan;
    if let Some(verdict) = plan.settled(SETTLE_WITHIN).await {
        return Ok(verdict?);
    }
    let account = state.current_session_account()?;
    let seq = plan.begin();
    let verdict = recording_tier(state, &account).await;
    plan.finish(seq, verdict);
    Ok(verdict?)
}

/// What the capture bar shows about the plan.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PlanState {
    /// Being read: the bar says so and nothing can start.
    Checking,
    /// Read: captures can start.
    Ready,
    /// No capture can start: the bar says why, with `action`.
    Refused,
}

/// What the bar offers beside a refusal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PlanAction {
    /// Read the plan again (`capture_plan_retry`).
    Retry,
    /// Go to the plans (`capture_limit_upgrade`).
    Upgrade,
}

/// The bar's view of the session's plan read, in Rust's words.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturePlanStatus {
    pub state: PlanState,
    /// What the bar says: the checking line or the refusal; `None` when ready.
    pub message: Option<String>,
    /// The refusal's way out; `None` unless refused.
    pub action: Option<PlanAction>,
}

/// [`CapturePlanStatus`] for where the read is. A read not begun yet is
/// shown as checking: the bar's own status request begins it.
#[must_use]
pub fn plan_status(check: PlanCheck) -> CapturePlanStatus {
    match check {
        PlanCheck::NotStarted | PlanCheck::Checking => CapturePlanStatus {
            state: PlanState::Checking,
            message: Some(PLAN_CHECKING.to_string()),
            action: None,
        },
        PlanCheck::Done(Ok(_)) => CapturePlanStatus {
            state: PlanState::Ready,
            message: None,
            action: None,
        },
        PlanCheck::Done(Err(refusal)) => CapturePlanStatus {
            state: PlanState::Refused,
            message: Some(refusal.not_ready().to_string()),
            action: Some(refusal.action()),
        },
    }
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
    fn only_free_has_a_length_limit() {
        assert_eq!(RecordingTier::Free.max_recording(), Some(Duration::from_mins(5)));
        assert_eq!(RecordingTier::Paid.max_recording(), None);
    }

    /// A read that came back decides; one that did not refuses with a Retry,
    /// never "no limits".
    #[test]
    fn a_failed_read_refuses_and_a_known_one_decides() {
        use RecordingTier::{Free, Paid};
        assert_eq!(decide_plan(Some(Free), true), Ok(Free));
        assert_eq!(decide_plan(Some(Paid), true), Ok(Paid));
        assert_eq!(
            decide_plan(None, true),
            Err(PlanRefusal::Unreachable),
            "never captured on an unknown plan"
        );
        assert_eq!(decide_plan(None, false), Err(PlanRefusal::Unreachable));
        assert_eq!(PlanRefusal::Unreachable.action(), PlanAction::Retry);
        assert!(matches!(PlanRefusal::Unreachable.not_ready(), NotReadyKind::CapturePlanUnavailable));
    }

    /// An access-key account with no paid plan has no Drive storage: refused
    /// with an Upgrade. One that pays is paid like anyone else.
    #[test]
    fn no_drive_entitlement_refuses_with_an_upgrade() {
        use RecordingTier::{Free, Paid};
        assert_eq!(decide_plan(Some(Free), false), Err(PlanRefusal::NoDrivePlan));
        assert_eq!(decide_plan(Some(Paid), false), Ok(Paid));
        assert_eq!(PlanRefusal::NoDrivePlan.action(), PlanAction::Upgrade);
        assert!(matches!(PlanRefusal::NoDrivePlan.not_ready(), NotReadyKind::CaptureNoDrivePlan));
    }

    /// The bar shows a checking line while reading, nothing once ready, and
    /// the refusal in Rust's words with its way out.
    #[test]
    fn the_bar_status_follows_the_read() {
        let checking = plan_status(PlanCheck::Checking);
        assert_eq!(checking.state, PlanState::Checking);
        assert_eq!(checking.message.as_deref(), Some(PLAN_CHECKING));
        assert_eq!(plan_status(PlanCheck::NotStarted).state, PlanState::Checking);

        let ready = plan_status(PlanCheck::Done(Ok(RecordingTier::Free)));
        assert_eq!((ready.state, ready.message, ready.action), (PlanState::Ready, None, None));

        let failed = plan_status(PlanCheck::Done(Err(PlanRefusal::Unreachable)));
        assert_eq!(failed.state, PlanState::Refused);
        assert_eq!(failed.action, Some(PlanAction::Retry));
        assert_eq!(
            failed.message.as_deref(),
            Some("We couldn't check your plan. Check your connection and try again.")
        );
        let no_drive = plan_status(PlanCheck::Done(Err(PlanRefusal::NoDrivePlan)));
        assert_eq!((no_drive.state, no_drive.action), (PlanState::Refused, Some(PlanAction::Upgrade)));
    }

    /// A decision waits for the read under way, and gets its verdict.
    #[tokio::test]
    async fn a_decision_waits_for_the_read_under_way() {
        let plan = std::sync::Arc::new(SessionPlan::default());
        assert_eq!(plan.settled(Duration::from_millis(10)).await, None, "no read began");
        let seq = plan.begin();
        assert_eq!(plan.current(), PlanCheck::Checking);
        let waiting = {
            let plan = plan.clone();
            tokio::spawn(async move { plan.settled(Duration::from_secs(5)).await })
        };
        tokio::task::yield_now().await;
        assert!(plan.finish(seq, Ok(RecordingTier::Paid)));
        assert_eq!(waiting.await.expect("joined"), Some(Ok(RecordingTier::Paid)));
        assert_eq!(plan.current(), PlanCheck::Done(Ok(RecordingTier::Paid)));
    }

    /// A read that never answers in time is a failed read, not a free pass.
    #[tokio::test]
    async fn a_read_that_hangs_refuses() {
        let plan = SessionPlan::default();
        plan.begin();
        assert_eq!(plan.settled(Duration::from_millis(20)).await, Some(Err(PlanRefusal::Unreachable)));
    }

    /// A Retry (or a new session) replaces the read; the older answer that
    /// arrives late is dropped.
    #[tokio::test]
    async fn a_late_answer_from_an_older_read_is_dropped() {
        let plan = SessionPlan::default();
        let first = plan.begin();
        assert!(plan.finish(first, Err(PlanRefusal::Unreachable)));
        let retry = plan.begin();
        assert_eq!(plan.current(), PlanCheck::Checking, "a Retry checks again");
        assert!(!plan.finish(first, Ok(RecordingTier::Free)), "the older read is stale");
        assert_eq!(plan.current(), PlanCheck::Checking);
        assert!(plan.finish(retry, Ok(RecordingTier::Free)));
        assert_eq!(plan.settled(Duration::from_millis(10)).await, Some(Ok(RecordingTier::Free)));
    }

    /// Five minutes of recorded time, and not a second before.
    #[test]
    fn the_free_limit_is_reached_at_five_minutes_of_recorded_time() {
        let free = RecordingTier::Free.max_recording();
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
        let free = RecordingTier::Free.max_recording();
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
        let free = RecordingTier::Free.max_recording();
        assert_eq!(remaining_to_show(0, free), None);
        assert_eq!(remaining_to_show(239, free), None);
        assert_eq!(remaining_to_show(240, free), Some(60));
        assert_eq!(remaining_to_show(299, free), Some(1));
        assert_eq!(remaining_to_show(300, free), Some(0));
        assert_eq!(remaining_to_show(400, free), Some(0), "never below zero");
        assert_eq!(remaining_to_show(299, None), None, "no limit, nothing to count down");
    }
}
