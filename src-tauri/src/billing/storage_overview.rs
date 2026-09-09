//! Plan/credits-aware overview for the home page's two small cards and the
//! top-bar "Active Plan" chip.
//!
//! One IPC round-trip composing three facts: bytes used (the same indexer
//! row `get_drive_storage_stats` reads), the active subscription, and the
//! credit balance. `used_bytes` is always that indexer row — never a local
//! dir_stats walk (that would be a confident wrong *account* total). When
//! the indexer is still 0 but own-drive `dir_stats` is > 0, `used_pending`
//! is set so the card shows "Updating…" instead of "0 B". The
//! **capacity-source priority chain lives HERE, once**:
//!
//!   1. active subscription → capacity is the plan's allowance
//!   2. else                → the free SKU's allowance, read from the plans
//!      catalogue (the number the server itself enforces)
//!
//! Credits deliberately do NOT price a capacity any more: Drive storage is
//! sold as plans (the free tier included), and the earlier credits-buyable
//! chain painted a "5 TB" cap for a balance the user might spend on
//! anything. Credits still ride along on the wire for display.
//!
//! Every consumer (storage card, plan card, top-bar chip) renders from this
//! single decision, so the surfaces can never disagree about whether the
//! user is "on a plan" or on the free tier.

use serde::Serialize;

use crate::api::client::ApiClient;
use crate::error::AppError;

/// Capacity math is decimal GB end-to-end (`calculate_storage_capacity`
/// returns SI GB; display labels are SI too), so the GB→bytes
/// conversion must be SI too — 1e9, not 2^30.
const BYTES_PER_GB: u64 = 1_000_000_000;

/// SI units for the home storage card. Same 1000-based scale as `formatBytes`.
const SI_UNITS: [&str; 6] = ["B", "KB", "MB", "GB", "TB", "PB"];

/// Which source won the capacity decision. Lowercase on the wire.
#[derive(Serialize, Debug, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum CapacitySource {
    Subscription,
    /// No active subscription — the account sits on the free tier.
    Free,
}

/// Fallback free-tier allowance, used ONLY when the plans catalogue cannot
/// be read. The live number comes from the catalogue's free SKU via
/// `free_plan_bytes`, the field the server enforces; this constant just
/// keeps the card from plotting a zero capacity during an outage.
const FREE_TIER_FALLBACK_GB: u64 = 10;

/// Active-plan facts for the plan card / top-bar chip. camelCase over IPC.
#[derive(Serialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PlanInfo {
    /// Human plan name (e.g. "Pro"); may be empty if the API omits it.
    pub name: String,
    /// Price per billing interval, in the plan's currency unit.
    pub amount: f64,
    /// Billing interval as the API reports it (e.g. "month", "year").
    pub interval: String,
    /// The plan's storage allowance in bytes.
    pub storage_bytes: u64,
    /// Marketed SKU label (`format_storage_display`): 999 GB → "1.00 TB".
    /// Chip / plan card render this instead of `formatBytes(storageBytes)`.
    pub storage_display: String,
    /// How the plan is paid for: `"credits"` or `"card"`, as the drive rail
    /// reports it. `None` for the legacy Stripe storage subscription, which
    /// predates the field. Only [`PlanAction`] reads it — the FE must not
    /// re-derive a prompt from it, or the two disagree.
    pub funding: Option<String>,
    /// Days until the plan next charges, or `None` when the rail did not
    /// say. Negative means the charge date has passed and the rail has not
    /// caught up — stale data, not a state to warn about.
    pub renews_in_days: Option<i64>,
    /// The renewal itself, as days since the epoch.
    ///
    /// Not on the wire: the frontend has no use for an absolute day, but
    /// the notification does — it is what makes the warning fire once per
    /// CYCLE rather than once per day of the ten leading up to it.
    #[serde(skip)]
    pub renewal_unix_day: Option<i64>,
}

/// What the header should offer this account, decided once here.
///
/// Three surfaces show this cell (home header, Files header, and the Drive
/// page) and they must agree, for the same reason `CapacitySource` is
/// resolved in Rust: a prompt derived independently per surface is a prompt
/// that eventually contradicts itself.
#[derive(Serialize, Debug, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "kebab-case")]
pub enum PlanAction {
    /// No plan, or a plan that is filling up. More storage means a bigger
    /// plan, so credits are not the answer and must not be offered.
    Upgrade,
    /// A credits-funded plan whose balance will not cover its next renewal.
    /// Card-funded plans never get this: the card renews itself and there
    /// is nothing to top up.
    TopUpCredits,
    /// Nothing to prompt — a healthy plan with room left.
    None,
}

/// Storage fill at which a plan stops being big enough to recommend
/// sitting on. Matches the FE's `getUsageTone` amber threshold, so the bar
/// turning amber and the header asking for an upgrade happen together
/// rather than at two different numbers.
const UPGRADE_AT_PERCENT: f64 = 80.0;

/// The rule behind [`PlanAction`], pure so the matrix is testable without a
/// backend.
///
/// Order matters. Running out of SPACE is answered by a bigger plan
/// whatever funds it, so it is checked first and applies to card accounts
/// too. Running low on CREDITS is only meaningful for a credits-funded
/// plan, and is judged against the plan's own price rather than a fixed
/// number, so it tracks the plan instead of needing a threshold nobody
/// revisits.
fn resolve_plan_action(source: CapacitySource, percent: f64, plan: Option<&PlanInfo>) -> PlanAction {
    if source != CapacitySource::Subscription || plan.is_none() {
        // The free tier is an allowance, not a plan: the way to more room
        // is to subscribe.
        return PlanAction::Upgrade;
    }
    if percent >= UPGRADE_AT_PERCENT {
        return PlanAction::Upgrade;
    }
    PlanAction::None
}

/// Whether a credits-funded plan's balance covers its next renewal.
///
/// Split from [`resolve_plan_action`] because the balance arrives as a
/// pre-formatted display string; parsing it is a separate concern from the
/// rule that consumes it. An unreadable balance is NOT evidence of being
/// short — it must not raise a top-up prompt at an account that is fine.
fn credits_short_for_renewal(plan: &PlanInfo, credits_hip: Option<&str>) -> bool {
    if plan.funding.as_deref() != Some("credits") {
        return false;
    }
    if plan.amount <= 0.0 {
        return false;
    }
    match credits_hip.and_then(|c| c.parse::<f64>().ok()) {
        Some(balance) if balance.is_finite() => balance < plan.amount,
        _ => false,
    }
}

/// How close a renewal has to be before it is worth interrupting over.
const RENEWAL_WARNING_DAYS: i64 = 10;

/// Today, as days since the epoch — the unit the drive rail reports the
/// next charge in.
fn today_unix_day() -> i64 {
    chrono::Utc::now().timestamp().div_euclid(86_400)
}

/// Whether to raise the one-off "your credits will not cover the renewal"
/// notification.
///
/// The header says this whenever the balance is short, because a line of
/// text costs the reader nothing. A notification is louder, so it waits
/// until the renewal is close enough to be worth acting on — and a date
/// already past is stale data from the rail rather than a renewal that is
/// about to happen, so it does not qualify.
fn should_warn_about_renewal(action: PlanAction, renews_in_days: Option<i64>) -> bool {
    if action != PlanAction::TopUpCredits {
        return false;
    }
    matches!(renews_in_days, Some(days) if (0..=RENEWAL_WARNING_DAYS).contains(&days))
}

/// Wire shape of the home overview. camelCase over IPC.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StorageOverview {
    /// Bytes currently stored in Drive (latest indexer snapshot).
    pub used_bytes: u64,
    /// Effective capacity in bytes per the priority chain; `0` for `None`.
    pub total_bytes: u64,
    /// `used / total * 100`, clamped to `[0, 100]`; `0` when no capacity.
    /// Clamped because over-quota is a real state (usage recorded before a
    /// downgrade) and the bar must not overflow.
    pub percent: f64,
    pub source: CapacitySource,
    /// Present when `source == Subscription`.
    pub plan: Option<PlanInfo>,
    /// Pre-formatted HIP credit balance (from `planck_to_hip`, the single
    /// credit formatter). Present whenever the balance fetch succeeded, so
    /// the plan card can show it even alongside a subscription if design
    /// ever wants to.
    pub credits_hip: Option<String>,
    /// True when `used_bytes` is the indexer's empty row (0) but this
    /// device already has files under own-drive sync roots. The card
    /// shows "Updating…" instead of a confident "0 B". Never substitute
    /// the local walk into `used_bytes` — that is this device's files,
    /// not the account total (other devices, member drives, and
    /// encryption overhead all disagree).
    pub used_pending: bool,
    /// Display labels for the storage card. Authored here so used / total /
    /// free cannot disagree about units or rounding (H-109). The FE renders
    /// these strings; it must not `formatBytes` the raw counts.
    pub used_display: String,
    pub total_display: String,
    pub free_display: String,
    /// What the header should offer — see [`PlanAction`]. Render this;
    /// never re-derive it from `source` / `percent` / `plan` on the FE.
    pub plan_action: PlanAction,
}

/// Pure composition of the overview from its inputs.
///
/// `free_tier_bytes` is the free SKU's allowance, already mapped to its
/// marketed size by the caller; `None` when the catalogue could not be
/// read, which falls back to [`FREE_TIER_FALLBACK_GB`].
fn build_overview(used_bytes: u64, plan: Option<PlanInfo>, free_tier_bytes: Option<u64>, credits_hip: Option<String>) -> StorageOverview {
    if let Some(plan) = plan {
        let total_bytes = plan.storage_bytes;
        return finish_overview(used_bytes, total_bytes, CapacitySource::Subscription, Some(plan), credits_hip);
    }
    // No subscription: every account has the free tier, so there is always
    // a capacity to plot — "No active plan" with an empty card is gone.
    let total_bytes = free_tier_bytes.unwrap_or_else(|| FREE_TIER_FALLBACK_GB.saturating_mul(BYTES_PER_GB));
    finish_overview(used_bytes, total_bytes, CapacitySource::Free, None, credits_hip)
}

fn finish_overview(
    used_bytes: u64,
    total_bytes: u64,
    source: CapacitySource,
    plan: Option<PlanInfo>,
    credits_hip: Option<String>,
) -> StorageOverview {
    let labels = format_overview_labels(used_bytes, total_bytes);
    let percent = percent_of(used_bytes, total_bytes);
    // Decide here, where every input is already resolved, so no surface
    // has to combine source + percent + funding + balance for itself.
    let plan_action = match resolve_plan_action(source, percent, plan.as_ref()) {
        PlanAction::None if plan.as_ref().is_some_and(|p| credits_short_for_renewal(p, credits_hip.as_deref())) => PlanAction::TopUpCredits,
        decided => decided,
    };
    StorageOverview {
        used_bytes,
        total_bytes,
        percent,
        source,
        plan,
        credits_hip,
        used_pending: false,
        used_display: labels.used,
        total_display: labels.total,
        free_display: labels.free,
        plan_action,
    }
}

struct OverviewLabels {
    used: String,
    total: String,
    free: String,
}

/// Used stays in its natural unit (31.91 GB is more readable than 0.03 TB).
/// Total and free share the total's unit and keep two decimal places so
/// leftover GB cannot collapse to "5 TB" the way `formatBytes` does after
/// `parseFloat` (H-109).
fn format_overview_labels(used_bytes: u64, total_bytes: u64) -> OverviewLabels {
    let free_bytes = total_bytes.saturating_sub(used_bytes);
    let used_idx = si_unit_index(used_bytes);
    let total_idx = si_unit_index(total_bytes);
    // Same-unit used keeps `.00` so "5 TB of 5.00 TB" cannot return.
    let keep_used_decimals = used_idx == total_idx && total_idx > 0;
    let free = format_si(free_bytes, total_idx, true);
    // Shared-unit rounding can hide leftover GB as "0.00 TB". Call that
    // out rather than dropping to a smaller unit (which reopens H-109).
    let free = if free_bytes > 0 && free.starts_with("0.00 ") {
        format!("<0.01 {}", SI_UNITS[total_idx])
    } else {
        free
    };
    OverviewLabels {
        used: format_si(used_bytes, used_idx, keep_used_decimals),
        total: format_si(total_bytes, total_idx, true),
        free,
    }
}

fn si_unit_index(bytes: u64) -> usize {
    if bytes == 0 {
        return 0;
    }
    let mut i = 0;
    let mut v = bytes;
    while v >= 1000 && i + 1 < SI_UNITS.len() {
        v /= 1000;
        i += 1;
    }
    i
}

fn format_si(bytes: u64, unit_idx: usize, keep_two_decimals: bool) -> String {
    if unit_idx == 0 {
        return format!("{bytes} B");
    }
    let val = bytes as f64 / 1000f64.powi(unit_idx as i32);
    if keep_two_decimals {
        format!("{:.2} {}", val, SI_UNITS[unit_idx])
    } else {
        let formatted = format!("{val:.2}");
        format!("{} {}", trim_dot_zeros(&formatted), SI_UNITS[unit_idx])
    }
}

fn trim_dot_zeros(s: &str) -> &str {
    if !s.contains('.') {
        return s;
    }
    s.trim_end_matches('0').trim_end_matches('.')
}

/// Indexer-lag flag for the home storage card.
///
/// `used_bytes` on the wire is ALWAYS the indexer row — never the local
/// walk. When the indexer is still 0 but this device already has files,
/// the FE shows "Updating…" instead of "0 B". A true empty (both 0)
/// stays 0 B. An indexer HTTP failure must not reach this helper — the
/// caller `?`s it first so the card errors.
fn used_pending(indexer_bytes: u64, local_bytes: u64) -> bool {
    indexer_bytes == 0 && local_bytes > 0
}

/// Sum of [`crate::sync::files::dir_stats_recursive`] over `paths`.
///
/// Short-circuits on the first non-zero size: the flag only needs `> 0`.
/// Hidden (dot-prefixed) names are skipped by the same walk the Files
/// header uses, so 46 B vs 0 B cannot disagree about what counts.
///
/// Walked with NO exclude rules, deliberately for now: this probe has no
/// drive labels to resolve patterns from. The dir-stats cache keys on the
/// ruleset AND holds one entry per ruleset, so this walk neither serves the
/// listing's numbers nor evicts them — see `dir_stats::DirStatsKey`, and do
/// not "simplify" that key back to the path alone: a single slot per
/// directory would make this probe and the listing overwrite each other on
/// every refresh. KNOWN GAP: a drive whose only un-uploaded bytes are
/// excluded reads as "local data the indexer has not caught up with",
/// pinning the card on "Updating…" for something that will never upload.
async fn local_bytes_for_paths(paths: &[std::path::PathBuf]) -> u64 {
    let mut total = 0u64;
    for path in paths {
        let (size, _) = crate::sync::files::dir_stats_recursive(path, None).await;
        total = total.saturating_add(size);
        if total > 0 {
            return total;
        }
    }
    total
}

/// Own-drive roots for the lag probe: skip the migration pseudo-drive
/// and member slots. Member files live in the owner's indexer row, so
/// counting them here would flash "Updating…" on a genuinely empty
/// account that only has Shared-with-me data.
///
/// Paused drives are excluded too: "Updating…" promises the number is
/// about to move, and a paused drive will never upload those bytes. An
/// account whose every drive is paused reads an honest 0 B instead of a
/// permanent "Updating…". (Files a paused drive already uploaded are in
/// the indexer row, so the probe never runs for them.)
async fn own_drive_paths(pool: &sqlx::SqlitePool, account_id: &str) -> Result<Vec<std::path::PathBuf>, AppError> {
    use sqlx::Row;

    let owner = crate::auth::account_key::account_key(account_id);
    let rows = sqlx::query(
        "SELECT path FROM sync_paths
         WHERE owner = ?
           AND label != 'migration'
           AND owner_ss58 IS NULL
           AND wire_folder_hash IS NULL
           AND is_paused = 0",
    )
    .bind(&owner)
    .fetch_all(pool)
    .await?;

    Ok(rows.iter().map(|row| std::path::PathBuf::from(row.get::<String, _>("path"))).collect())
}

async fn local_own_drive_bytes(pool: &sqlx::SqlitePool, account_id: &str) -> u64 {
    let paths = match own_drive_paths(pool, account_id).await {
        Ok(paths) => paths,
        Err(err) => {
            tracing::warn!(
                error = %err,
                "storage overview: failed listing own drives for indexer-lag probe"
            );
            return 0;
        }
    };
    local_bytes_for_paths(&paths).await
}

fn percent_of(used: u64, total: u64) -> f64 {
    if total == 0 {
        return 0.0;
    }
    ((used as f64 / total as f64) * 100.0).clamp(0.0, 100.0)
}

/// Extract [`PlanInfo`] from the active-subscription payload, or `None` when
/// the account has no usable subscription. Fail-soft by design: a malformed
/// or missing field reads as "no plan" (the priority chain then falls to
/// credits), mirroring `get_subscription_data`'s `unwrap_or` posture.
/// Marketed size of a drive-plan allowance: the label AND the decimal byte
/// count it names.
///
/// Plan grants are exact powers of 1024 (10 GiB, 2 TiB, 10 TiB) but they
/// are SOLD in marketing units — the plans page, the console and the mobile
/// app all render "2 TB" through the same divide-by-1024 rule
/// (`formatPlanStorage` in drive-plans.ts). The overview must agree, and
/// its bar math must run on the same number: formatting the raw binary
/// grant with the SI formatter put "≈ 2.20 TB" on the chip beside a plans
/// page selling "2 TB".
fn marketed_plan_size(raw_bytes: u64) -> (u64, String) {
    const UNITS: [&str; 6] = ["B", "KB", "MB", "GB", "TB", "PB"];
    if raw_bytes == 0 {
        return (0, "0 GB".into());
    }
    let mut value = raw_bytes as f64;
    let mut i = 0;
    while value >= 1024.0 && i < UNITS.len() - 1 {
        value /= 1024.0;
        i += 1;
    }
    let rounded = (value * 100.0).round() / 100.0;
    let label = format!("{rounded:.2}");
    let display = format!("{} {}", trim_dot_zeros(&label), UNITS[i]);
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let decimal_bytes = (rounded * 1000f64.powi(i32::try_from(i).unwrap_or(0))).round() as u64;
    (decimal_bytes, display)
}

/// The free plan's allowance out of the catalogue payload (a bare array or
/// `{ results: [...] }`, same tolerance as the FE's `useDrivePlans`).
///
/// Display only: the upload gate no longer enforces a number of its own —
/// it asks hcfs-server (`drive_quota`) — so the card is the last reader of
/// this field.
fn free_plan_bytes(plans: &serde_json::Value) -> Option<u64> {
    let list = plans.as_array().or_else(|| plans.get("results").and_then(serde_json::Value::as_array))?;
    list.iter()
        .find(|p| p.get("is_free").and_then(serde_json::Value::as_bool).unwrap_or(false))
        .and_then(|p| p.get("storage_bytes"))
        .and_then(serde_json::Value::as_u64)
        .filter(|b| *b > 0)
}

/// Map the DRIVE-rail subscription (`/api/drive/subscription/`) onto
/// [`PlanInfo`], joining the plans catalogue for the price the subscription
/// payload does not carry. This is the rail the Subscription Plans page
/// subscribes through, so the chip/cards must read it FIRST or a
/// credits-funded plan renders as the free tier (the page said "Plus", the
/// home card said "Free Drive Plan").
///
/// The free tier can report as its own "plan" on this rail; it must resolve
/// to `None` here so the chain lands on [`CapacitySource::Free`] — an
/// "Active Plan (0$/mo.)" chip is the free tier mislabelled.
fn plan_from_drive_subscription(sub: &serde_json::Value, plans: &serde_json::Value) -> Option<PlanInfo> {
    if !sub.get("active").and_then(serde_json::Value::as_bool).unwrap_or(false) {
        return None;
    }
    let code = sub.get("plan").and_then(serde_json::Value::as_str).unwrap_or("");
    // The catalogue arrives as a bare array or `{ results: [...] }` — the
    // same tolerance the FE's `useDrivePlans` select applies.
    let catalogue = plans.as_array().or_else(|| plans.get("results").and_then(serde_json::Value::as_array));
    let entry = catalogue.and_then(|list| list.iter().find(|p| p.get("code").and_then(serde_json::Value::as_str) == Some(code)));

    if code.eq_ignore_ascii_case("free") || entry.and_then(|p| p.get("is_free")).and_then(serde_json::Value::as_bool).unwrap_or(false) {
        return None;
    }

    let raw_bytes = sub
        .get("storage_bytes")
        .and_then(serde_json::Value::as_u64)
        .filter(|bytes| *bytes > 0)
        .or_else(|| entry.and_then(|p| p.get("storage_bytes")).and_then(serde_json::Value::as_u64))?;
    let (storage_bytes, storage_display) = marketed_plan_size(raw_bytes);

    let name = sub
        .get("plan_name")
        .and_then(serde_json::Value::as_str)
        .or_else(|| entry.and_then(|p| p.get("name")).and_then(serde_json::Value::as_str))
        .unwrap_or(code)
        .to_string();

    // Both price fields are effective per-month credits (drive-plans.ts),
    // so the interval is "month" either way.
    let annual = sub.get("billing_period").and_then(serde_json::Value::as_str) == Some("annual");
    let price_key = if annual { "price_credits_annual" } else { "price_credits_monthly" };
    let amount = entry.and_then(|p| p.get(price_key)).and_then(serde_json::Value::as_f64).unwrap_or(0.0);

    // `funding` says what actually pays the renewal; `provider` is the
    // rail it was bought through. Prefer funding and fall back, since an
    // older payload may carry only the latter.
    let funding = sub
        .get("funding")
        .and_then(serde_json::Value::as_str)
        .or_else(|| sub.get("provider").and_then(serde_json::Value::as_str))
        .map(|f| if f == "stripe" { "card" } else { f })
        .map(str::to_string);

    // Days since the epoch, not seconds — the rail's own unit (see
    // `DriveSubscription.next_charge_unix_day`).
    let renewal_unix_day = sub.get("next_charge_unix_day").and_then(serde_json::Value::as_i64);

    Some(PlanInfo {
        name,
        amount,
        interval: "month".into(),
        storage_bytes,
        storage_display,
        funding,
        renews_in_days: renewal_unix_day.map(|day| day - today_unix_day()),
        renewal_unix_day,
    })
}

fn plan_from_subscription(active: &serde_json::Value) -> Option<PlanInfo> {
    if !active.get("has_subscription").and_then(serde_json::Value::as_bool).unwrap_or(false) {
        return None;
    }
    let sub = active.get("subscription")?;
    let credits_per_billing = sub.get("credits_per_billing").and_then(serde_json::Value::as_f64).unwrap_or(0.0);
    if credits_per_billing <= 0.0 {
        return None;
    }
    let storage_gb = capacity_gb_for_credits(credits_per_billing);
    Some(PlanInfo {
        name: sub.get("plan_name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        amount: sub.get("amount").and_then(serde_json::Value::as_f64).unwrap_or(0.0),
        interval: sub.get("interval").and_then(|v| v.as_str()).unwrap_or("month").to_string(),
        storage_bytes: storage_gb.saturating_mul(BYTES_PER_GB),
        storage_display: crate::billing::charts::format_storage_display(storage_gb),
        // The legacy Stripe storage subscription predates the field; it is
        // card-billed by definition of the rail it came from.
        funding: Some("card".into()),
        // A card plan renews itself, so there is nothing this would drive.
        renews_in_days: None,
        renewal_unix_day: None,
    })
}

/// GB a plan's monthly credit allowance buys, via the canonical pricing
/// model (`calculate_storage_capacity`'s binary search). Sizes a
/// SUBSCRIPTION's allowance from `credits_per_billing` — the free tier and
/// the user's spendable balance never price a capacity.
fn capacity_gb_for_credits(credits: f64) -> u64 {
    if credits <= 0.0 {
        return 0;
    }
    crate::billing::charts::calculate_storage_capacity(vec![credits])
        .into_iter()
        .next()
        .map_or(0, |info| info.storage_gb)
}

/// Fetch the storage/plan overview for the home page and top-bar chip.
///
/// # Errors
///
/// Returns [`AppError`] when the indexer used-bytes read fails — the card
/// must not render a confident "0 B used" over an outage. The subscription
/// and credit fetches, by contrast, degrade softly (no plan / no credits):
/// each alone is a display concern, and the priority chain still resolves.
#[tauri::command]
pub async fn get_storage_overview(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: crate::app_state::SessionAccount,
) -> Result<StorageOverview, AppError> {
    let client = ApiClient::new(state.api_client.clone(), state.pool()?.clone());

    let (stats_result, drive_sub_result, drive_plans_result, active_result, credits_result) = tokio::join!(
        crate::billing::queries::fetch_drive_storage_stats(state.inner(), account_id.as_str()),
        client.get::<serde_json::Value>("/api/drive/subscription/", &account_id),
        client.get::<serde_json::Value>("/api/drive/plans/", &account_id),
        client.get::<serde_json::Value>("/api/billing/stripe/active-subscription/", &account_id),
        crate::billing::credits::fetch_credit_balance_planck(state.inner(), &account_id),
    );

    let stats = stats_result?;
    let drive_sub = drive_sub_result.unwrap_or_else(|_| serde_json::json!({ "active": false }));
    let drive_plans = drive_plans_result.unwrap_or_else(|_| serde_json::json!([]));
    let active = active_result.unwrap_or_else(|_| serde_json::json!({ "has_subscription": false }));

    // Credits no longer price a capacity; the balance rides along purely
    // for display (the plan card / top-up cell).
    let credits_hip = credits_result.ok().map(|planck| crate::blockchain::convert::planck_to_hip(&planck));

    // The drive rail (what the Subscription Plans page subscribes through)
    // wins; the legacy Stripe storage subscription stays as the fallback for
    // accounts that predate drive plans.
    let plan = plan_from_drive_subscription(&drive_sub, &drive_plans).or_else(|| plan_from_subscription(&active));

    // Indexer empty-row is success + 0 bytes (not an error). Probe local
    // own-drive dir_stats only then, so a lagging indexer cannot paint
    // "0 B" over files the Files header already shows. Skip the walk
    // when the indexer already has a total.
    let local_bytes = if stats.total_bytes == 0 {
        local_own_drive_bytes(state.pool()?, account_id.as_str()).await
    } else {
        0
    };

    // The free SKU's allowance comes from the catalogue already fetched
    // above, mapped to its marketed size like any other grant (the free plan
    // is 10 GiB, sold as "10 GB").
    let free_tier_bytes = free_plan_bytes(&drive_plans).map(|raw| marketed_plan_size(raw).0);

    let mut overview = build_overview(stats.total_bytes, plan, free_tier_bytes, credits_hip);
    overview.used_pending = used_pending(stats.total_bytes, local_bytes);

    // The header states this the moment the balance is short; the
    // notification waits until the renewal is close. Raised from here
    // because this is where the decision already exists — a second copy of
    // it on a timer would eventually disagree with what the header shows.
    // Idempotent per billing cycle, so running it on every poll is safe,
    // and a failure is logged rather than failing the whole overview.
    let warn_about = overview
        .plan
        .as_ref()
        .filter(|p| should_warn_about_renewal(overview.plan_action, p.renews_in_days))
        .and_then(|p| p.renewal_unix_day);
    if let Some(day) = warn_about
        && let Err(e) = crate::notifications::credits::ensure_renewal_credits_notification(state.pool()?, account_id.as_str(), day).await
    {
        tracing::warn!(error = %e, "could not record the renewal credits warning");
    }

    Ok(overview)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pro_plan(gb: u64) -> PlanInfo {
        PlanInfo {
            name: "Pro".into(),
            amount: 5.0,
            interval: "month".into(),
            storage_bytes: gb * BYTES_PER_GB,
            storage_display: crate::billing::charts::format_storage_display(gb),
            funding: None,
            renews_in_days: None,
            renewal_unix_day: None,
        }
    }

    fn plan_funded(by: &str, amount: f64) -> PlanInfo {
        PlanInfo {
            funding: Some(by.into()),
            amount,
            ..pro_plan(100)
        }
    }

    /// The free tier is an allowance, not a plan — credits buy no Drive
    /// storage, so the only useful prompt is to subscribe.
    #[test]
    fn a_free_account_is_asked_to_upgrade_not_to_top_up() {
        let o = build_overview(0, None, Some(10 * BYTES_PER_GB), Some("0".into()));
        assert_eq!(o.plan_action, PlanAction::Upgrade);
    }

    /// Running out of SPACE is answered by a bigger plan whatever funds it,
    /// so a card account gets the upgrade prompt too.
    #[test]
    fn a_card_plan_near_capacity_is_asked_to_upgrade() {
        let plan = plan_funded("card", 5.0);
        let used = (plan.storage_bytes as f64 * 0.85) as u64;
        let o = build_overview(used, Some(plan), None, Some("999".into()));
        assert_eq!(o.plan_action, PlanAction::Upgrade);
    }

    /// A card renews itself, so there is nothing to top up: a card account
    /// with room left is never prompted, whatever its credit balance.
    #[test]
    fn a_card_plan_with_room_is_never_asked_to_top_up() {
        let plan = plan_funded("card", 5.0);
        let o = build_overview(1, Some(plan), None, Some("0".into()));
        assert_eq!(o.plan_action, PlanAction::None);
    }

    /// Credits-funded and the balance will not cover the next renewal.
    #[test]
    fn a_credits_plan_that_cannot_renew_is_asked_to_top_up() {
        let plan = plan_funded("credits", 4.0);
        let o = build_overview(1, Some(plan), None, Some("2".into()));
        assert_eq!(o.plan_action, PlanAction::TopUpCredits);
    }

    #[test]
    fn a_credits_plan_that_can_renew_is_left_alone() {
        let plan = plan_funded("credits", 4.0);
        let o = build_overview(1, Some(plan), None, Some("9.5".into()));
        assert_eq!(o.plan_action, PlanAction::None);
    }

    /// Space beats credits: at 80% the answer is a bigger plan, not more
    /// credits to renew a plan that is already too small.
    #[test]
    fn a_full_credits_plan_is_asked_to_upgrade_not_to_top_up() {
        let plan = plan_funded("credits", 4.0);
        let used = (plan.storage_bytes as f64 * 0.9) as u64;
        let o = build_overview(used, Some(plan), None, Some("0".into()));
        assert_eq!(o.plan_action, PlanAction::Upgrade);
    }

    /// An unreadable balance is not evidence of being short — prompting a
    /// healthy account to top up because a string failed to parse is worse
    /// than staying quiet.
    #[test]
    fn an_unreadable_balance_raises_no_prompt() {
        let plan = plan_funded("credits", 4.0);
        for balance in [None, Some(String::new()), Some("n/a".to_string())] {
            let o = build_overview(1, Some(plan.clone()), None, balance);
            assert_eq!(o.plan_action, PlanAction::None);
        }
    }

    /// The header prompt and the amber bar must fire at the same number,
    /// or the bar warns while the header stays silent.
    #[test]
    fn the_upgrade_threshold_matches_the_amber_bar() {
        let plan = plan_funded("card", 5.0);
        let just_under = (plan.storage_bytes as f64 * 0.79) as u64;
        let at = (plan.storage_bytes as f64 * UPGRADE_AT_PERCENT / 100.0).ceil() as u64;
        assert_eq!(build_overview(just_under, Some(plan.clone()), None, None).plan_action, PlanAction::None);
        assert_eq!(build_overview(at, Some(plan), None, None).plan_action, PlanAction::Upgrade);
    }

    /// The wire value is what the FE switches on.
    #[test]
    fn plan_action_serializes_kebab_case() {
        assert_eq!(serde_json::to_string(&PlanAction::TopUpCredits).unwrap(), "\"top-up-credits\"");
        assert_eq!(serde_json::to_string(&PlanAction::Upgrade).unwrap(), "\"upgrade\"");
        assert_eq!(serde_json::to_string(&PlanAction::None).unwrap(), "\"none\"");
    }

    #[test]
    fn subscription_wins() {
        // 300 GB of a 1000 GB plan → 30%; the balance rides along for display.
        let overview = build_overview(300 * BYTES_PER_GB, Some(pro_plan(1000)), None, Some("500".into()));
        assert_eq!(overview.source, CapacitySource::Subscription);
        assert_eq!(overview.total_bytes, 1000 * BYTES_PER_GB);
        assert!((overview.percent - 30.0).abs() < 1e-9);
        assert_eq!(overview.plan.as_ref().map(|p| p.name.as_str()), Some("Pro"));
        assert_eq!(overview.credits_hip.as_deref(), Some("500"));
    }

    /// No subscription resolves to the FREE tier, never to a credits-priced
    /// capacity and never to an empty "no plan" card — every account has the
    /// free allowance, and a fat balance must not change the cap.
    ///
    /// With no catalogue reading, the fallback constant keeps the card from
    /// plotting a zero capacity during an outage.
    #[test]
    fn no_subscription_falls_back_to_the_free_tier() {
        let overview = build_overview(3 * BYTES_PER_GB, None, None, Some("500".into()));
        assert_eq!(overview.source, CapacitySource::Free);
        assert_eq!(overview.total_bytes, FREE_TIER_FALLBACK_GB * BYTES_PER_GB);
        assert!((overview.percent - 30.0).abs() < 1e-9);
        assert_eq!(overview.plan, None);
        assert_eq!(overview.credits_hip.as_deref(), Some("500"));
        assert_eq!(overview.total_display, "10.00 GB");
    }

    /// The free plan is read from the catalogue's `is_free` SKU, in either
    /// wrapping the API uses; no free SKU means nothing to plot from.
    #[test]
    fn the_free_plan_allowance_is_read_from_the_catalogue() {
        let ten_gib: u64 = 10 * 1024 * 1024 * 1024;
        let plans = serde_json::json!([
            { "code": "plus", "is_free": false, "storage_bytes": 999u64 },
            { "code": "free", "is_free": true, "storage_bytes": ten_gib }
        ]);
        assert_eq!(free_plan_bytes(&plans), Some(ten_gib));

        let wrapped = serde_json::json!({ "results": [ { "is_free": true, "storage_bytes": ten_gib } ] });
        assert_eq!(free_plan_bytes(&wrapped), Some(ten_gib));

        let none = serde_json::json!([ { "code": "plus", "is_free": false, "storage_bytes": 999u64 } ]);
        assert_eq!(free_plan_bytes(&none), None);
        assert_eq!(free_plan_bytes(&serde_json::json!([ { "is_free": true, "storage_bytes": 0u64 } ])), None);
    }

    /// The catalogue's free SKU wins over the fallback constant, so the
    /// card plots the number the server enforces. A raw 10 GiB grant maps to
    /// its marketed "10 GB" exactly like a paid plan's does.
    #[test]
    fn the_catalogue_free_sku_beats_the_fallback_constant() {
        let ten_gib: u64 = 10 * 1024 * 1024 * 1024;
        let plans = serde_json::json!([{ "code": "free", "is_free": true, "storage_bytes": ten_gib }]);
        let from_catalogue = free_plan_bytes(&plans).map(|raw| marketed_plan_size(raw).0);
        assert_eq!(from_catalogue, Some(10_000_000_000));

        // A server that moved the free tier to 20 GB must move the card.
        let twenty_gib: u64 = 20 * 1024 * 1024 * 1024;
        let bigger = serde_json::json!({ "results": [{ "is_free": true, "storage_bytes": twenty_gib }] });
        let bumped = free_plan_bytes(&bigger).map(|raw| marketed_plan_size(raw).0);
        let overview = build_overview(0, None, bumped, None);
        assert_eq!(overview.total_bytes, 20_000_000_000);
        assert_eq!(overview.total_display, "20.00 GB");
        assert_ne!(overview.total_bytes, FREE_TIER_FALLBACK_GB * BYTES_PER_GB);
    }

    #[test]
    fn overview_labels_use_camel_case_on_the_wire() {
        let overview = build_overview(31_910_000_000, Some(pro_plan(4_999)), None, Some("15".into()));
        let json = serde_json::to_value(&overview).expect("serialize");
        assert_eq!(json["usedDisplay"], "31.91 GB");
        assert_eq!(json["totalDisplay"], "5.00 TB");
        assert_eq!(json["freeDisplay"], "4.97 TB");
        assert_eq!(json["source"], "subscription");
    }

    /// The FE keys three surfaces on this exact wire string; a rename hides
    /// the free tier behind the resolvers' fallback branch.
    #[test]
    fn free_source_serializes_lowercase() {
        let overview = build_overview(0, None, None, None);
        let json = serde_json::to_value(&overview).expect("serialize");
        assert_eq!(json["source"], "free");
    }

    #[test]
    fn over_quota_free_is_zero_in_the_total_unit() {
        let overview = build_overview(6_000 * BYTES_PER_GB, Some(pro_plan(5_000)), None, None);
        assert_eq!(overview.total_display, "5.00 TB");
        assert_eq!(overview.free_display, "0.00 TB");
        assert!((overview.percent - 100.0).abs() < 1e-9);
    }

    /// 4 GB leftover on a 5 TB plan must not vanish as "5 TB of 5.00 TB /
    /// 0.00 TB free". Used keeps two decimals when it shares total's unit;
    /// free that rounds to 0.00 while bytes remain is "<0.01 TB".
    #[test]
    fn leftover_gb_on_a_tb_plan_does_not_vanish() {
        let overview = build_overview(4_996 * BYTES_PER_GB, Some(pro_plan(5_000)), None, None);
        assert_eq!(overview.used_display, "5.00 TB");
        assert_eq!(overview.total_display, "5.00 TB");
        assert_eq!(overview.free_display, "<0.01 TB");
        assert_ne!(overview.free_display, "0.00 TB");
        assert!(
            (overview.percent - 99.92).abs() < 0.01,
            "raw percent must stay unclamped, got {}",
            overview.percent
        );
    }

    #[test]
    fn over_quota_clamps_to_100() {
        // Usage above the allowance (downgrade case) must not overflow the bar.
        let overview = build_overview(2000 * BYTES_PER_GB, Some(pro_plan(1000)), None, None);
        assert!((overview.percent - 100.0).abs() < 1e-9);
        // Raw byte counts stay honest even while the percent clamps.
        assert_eq!(overview.used_bytes, 2000 * BYTES_PER_GB);
    }

    #[test]
    fn zero_gb_plan_does_not_divide_by_zero() {
        let overview = build_overview(500, Some(pro_plan(0)), None, None);
        assert_eq!(overview.source, CapacitySource::Subscription);
        assert_eq!(overview.total_bytes, 0);
        assert!(overview.percent.abs() < 1e-9);
    }

    /// Plan grants come as exact powers of 1024 (2 TiB for the "2 TB" SKU).
    const TWO_TIB: u64 = 2 * 1024 * 1024 * 1024 * 1024;
    const TEN_GIB: u64 = 10 * 1024 * 1024 * 1024;

    fn drive_catalogue() -> serde_json::Value {
        serde_json::json!([
            { "code": "free", "name": "Free Drive Plan", "storage_bytes": TEN_GIB, "price_credits_monthly": 0.0, "price_credits_annual": 0.0, "is_free": true },
            { "code": "plus", "name": "Plus", "storage_bytes": TWO_TIB, "price_credits_monthly": 7.0, "price_credits_annual": 6.0, "is_free": false }
        ])
    }

    /// The drive rail is what the Subscription Plans page subscribes
    /// through; the chip/cards must map it, price joined from the
    /// catalogue — a credits-funded Plus must never render as "Free Plan".
    ///
    /// The binary grant maps to its MARKETED size: the "2 TB" SKU must not
    /// read "≈ 2.20 TB" on the chip (the SI formatter over 2 TiB), and the
    /// bar math runs on the same 2 TB so every surface agrees.
    #[test]
    fn drive_subscription_maps_to_plan_with_catalogue_price() {
        let sub = serde_json::json!({ "active": true, "plan": "plus", "plan_name": "Plus", "storage_bytes": TWO_TIB });
        let plan = plan_from_drive_subscription(&sub, &drive_catalogue()).expect("plan expected");
        assert_eq!(plan.name, "Plus");
        assert!((plan.amount - 7.0).abs() < 1e-9);
        assert_eq!(plan.storage_bytes, 2_000_000_000_000, "bar math must use the marketed size");
        assert_eq!(plan.storage_display, "2 TB");

        // And the overview built from it labels the cap the same way.
        let overview = build_overview(500 * BYTES_PER_GB, Some(plan), None, None);
        assert_eq!(overview.total_display, "2.00 TB");
        assert!((overview.percent - 25.0).abs() < 1e-9);
    }

    #[test]
    fn annual_drive_billing_uses_the_per_month_annual_price() {
        let sub = serde_json::json!({ "active": true, "plan": "plus", "billing_period": "annual" });
        let plan = plan_from_drive_subscription(&sub, &drive_catalogue()).expect("plan expected");
        assert!((plan.amount - 6.0).abs() < 1e-9);
        // Storage falls back to the catalogue when the payload omits it.
        assert_eq!(plan.storage_bytes, 2_000_000_000_000);
    }

    #[test]
    fn inactive_or_free_drive_subscription_is_no_plan() {
        let inactive = serde_json::json!({ "active": false });
        assert_eq!(plan_from_drive_subscription(&inactive, &drive_catalogue()), None);

        // The free tier reporting as an "active plan" must still resolve to
        // the Free source, not an active 0$/mo plan.
        let free = serde_json::json!({ "active": true, "plan": "free", "storage_bytes": TEN_GIB });
        assert_eq!(plan_from_drive_subscription(&free, &drive_catalogue()), None);
    }

    /// Mirrors `formatPlanStorage` in drive-plans.ts — the rule the plans
    /// page, console and mobile all sell storage in.
    #[test]
    fn marketed_plan_size_renders_binary_grants_in_marketing_units() {
        assert_eq!(marketed_plan_size(TWO_TIB), (2_000_000_000_000, "2 TB".into()));
        assert_eq!(marketed_plan_size(TEN_GIB), (10_000_000_000, "10 GB".into()));
        assert_eq!(marketed_plan_size(500 * 1024 * 1024 * 1024), (500_000_000_000, "500 GB".into()));
        assert_eq!(marketed_plan_size(0), (0, "0 GB".into()));
    }

    #[test]
    fn subscription_payload_maps_to_plan() {
        let active = serde_json::json!({
            "has_subscription": true,
            "subscription": {
                "plan_name": "Pro",
                "credits_per_billing": 5.0,
                "amount": 12.0,
                "interval": "month"
            }
        });
        let plan = plan_from_subscription(&active).expect("plan expected");
        assert_eq!(plan.name, "Pro");
        assert!((plan.amount - 12.0).abs() < 1e-9);
        assert_eq!(plan.interval, "month");
        // 5 credits/month buys well over 1 TB under the current pricing
        // model (~0.003 credits per GB-month); pin a loose lower bound so a
        // pricing tweak doesn't break the test, while a unit slip (GB→MB or
        // a missing 1e9) still fails loudly.
        assert!(
            plan.storage_bytes > 1000 * BYTES_PER_GB,
            "expected > 1 TB for 5 credits, got {}",
            plan.storage_bytes
        );
        assert!(
            !plan.storage_display.is_empty(),
            "chip/plan card render storageDisplay, not formatBytes(storageBytes)"
        );
    }

    #[test]
    fn missing_or_inactive_subscription_maps_to_none() {
        assert_eq!(plan_from_subscription(&serde_json::json!({ "has_subscription": false })), None);
        assert_eq!(plan_from_subscription(&serde_json::json!({})), None);
        // has_subscription true but no subscription object → fail-soft None.
        assert_eq!(plan_from_subscription(&serde_json::json!({ "has_subscription": true })), None);
        // Zero credits_per_billing cannot price an allowance.
        assert_eq!(
            plan_from_subscription(&serde_json::json!({
                "has_subscription": true,
                "subscription": { "plan_name": "X", "credits_per_billing": 0.0 }
            })),
            None
        );
    }

    // H-007: indexer empty-row is success + 0 bytes. A local dir_stats
    // walk that sees files means the indexer is lagging, not that the
    // account is empty. used_bytes stays the indexer row (never the
    // local walk — that would be a confident wrong account total).
    #[test]
    fn used_pending_when_indexer_is_zero_and_local_has_bytes() {
        assert!(used_pending(0, 46));
    }

    #[test]
    fn used_pending_false_when_both_are_zero() {
        assert!(!used_pending(0, 0), "true empty must stay 0 B, not Updating");
    }

    #[test]
    fn used_pending_false_when_indexer_already_has_bytes() {
        assert!(!used_pending(46, 100));
        assert!(!used_pending(1, 0));
    }

    #[test]
    fn used_bytes_stay_the_indexer_row_when_pending() {
        let mut overview = build_overview(0, None, None, Some("1".into()));
        overview.used_pending = used_pending(overview.used_bytes, 46);
        assert_eq!(overview.used_bytes, 0, "local walk must not be written into used_bytes");
        assert!(overview.used_pending);
        assert_eq!(overview.source, CapacitySource::Free);
    }

    /// Brace-matched body of the function whose signature contains `sig`.
    fn fn_body<'a>(src: &'a str, sig: &str) -> &'a str {
        let sig_idx = src.find(sig).unwrap_or_else(|| panic!("`{sig}` declaration present"));
        let body_start = src[sig_idx..].find('{').expect("fn body opens") + sig_idx;
        let mut depth = 0usize;
        for (i, ch) in src[body_start..].char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return &src[body_start..=body_start + i];
                    }
                }
                _ => {}
            }
        }
        panic!("`{sig}` body never closes");
    }

    #[test]
    fn indexer_failure_still_errors_the_card() {
        // The used-bytes fetch is `?`'d — an indexer HTTP failure must
        // not degrade to 0 B / usedPending. The local walk is only
        // consulted after a successful indexer read. Search the command
        // body, not the whole file — a whole-file `contains` would match
        // this test's own assertion string.
        let src = include_str!("storage_overview.rs");
        let body = fn_body(src, "pub async fn get_storage_overview(");
        let stats_q = body
            .find("let stats = stats_result?;")
            .expect("indexer result is ?-propagated so a failed fetch still errors the card");
        let pending = body
            .find("overview.used_pending = used_pending(")
            .expect("used_pending is assigned onto the overview after the indexer read");
        assert!(stats_q < pending, "local lag probe must run only after a successful indexer read");
        assert!(
            !body.contains("stats_result.unwrap_or"),
            "do not coerce an indexer error into a 0-byte overview"
        );
    }

    // Each phase gets its OWN directory rather than mutating one in
    // place: `dir_stats_recursive` memoises on `(path, mtime)`, and three
    // writes microseconds apart can land inside one mtime tick, which
    // would serve the stale cached 0 and flake the last assertion.
    #[tokio::test]
    async fn local_dir_stats_walk_sees_a_visible_file_and_skips_dotfiles() {
        let dir = tempfile::tempdir().expect("tempdir");

        let empty = dir.path().join("empty");
        std::fs::create_dir(&empty).expect("empty dir");
        assert_eq!(
            local_bytes_for_paths(std::slice::from_ref(&empty)).await,
            0,
            "an empty own-drive root is a true empty, not pending"
        );

        let hidden_only = dir.path().join("hidden-only");
        std::fs::create_dir(&hidden_only).expect("hidden-only dir");
        std::fs::write(hidden_only.join(".hidden"), b"secret").expect("dotfile");
        assert_eq!(
            local_bytes_for_paths(std::slice::from_ref(&hidden_only)).await,
            0,
            "dir_stats skips dotfiles — a hidden-only tree must not flip usedPending"
        );

        let visible = dir.path().join("visible");
        std::fs::create_dir(&visible).expect("visible dir");
        std::fs::write(visible.join("note.txt"), b"hello").expect("visible file");
        let seen = local_bytes_for_paths(std::slice::from_ref(&visible)).await;
        assert!(seen > 0, "a visible file must make the lag probe > 0, got {seen}");

        // The probe only needs `> 0`, so an earlier empty root must not
        // stop the scan before a later root that does have bytes.
        let across = local_bytes_for_paths(&[empty, hidden_only, visible]).await;
        assert!(across > 0, "an empty first root must not short-circuit the scan, got {across}");
    }

    /// The own-drive filter is the part of this feature that fails
    /// SILENTLY: `local_own_drive_bytes` swallows a query error into a
    /// `warn!` and 0, so a renamed column or a wrong clause turns the whole
    /// fix into a no-op nobody notices. Run it against the REAL production
    /// DDL (`ensure_table_schema`), not a hand-copied CREATE TABLE, so a
    /// schema change breaks this test rather than the feature.
    #[tokio::test]
    async fn own_drive_paths_selects_only_active_own_drives() {
        use sqlx::sqlite::SqlitePoolOptions;

        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("in-memory pool");
        crate::utils::schema::ensure_table_schema(&pool).await.expect("schema");

        let account = "5TestStorageOverviewAccount";
        let owner = crate::auth::account_key::account_key(account);
        let other = crate::auth::account_key::account_key("5SomeOtherAccount");

        /// One seeded `sync_paths` row. A struct rather than a tuple so each
        /// exclusion the query encodes is named at the call site.
        struct Seed<'a> {
            owner: &'a str,
            path: &'a str,
            label: &'a str,
            is_paused: i64,
            owner_ss58: Option<&'a str>,
            wire_folder_hash: Option<&'a str>,
        }

        let own = |path, label| Seed {
            owner: owner.as_str(),
            path,
            label,
            is_paused: 0,
            owner_ss58: None,
            wire_folder_hash: None,
        };

        let rows = [
            own("/tmp/own", "default"),
            own("/tmp/mig", "migration"),
            Seed {
                owner: owner.as_str(),
                path: "/tmp/team",
                label: "team",
                is_paused: 0,
                owner_ss58: Some("5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty"),
                wire_folder_hash: Some("0123456789abcdef"),
            },
            Seed {
                is_paused: 1,
                ..own("/tmp/paused", "paused")
            },
            Seed {
                owner: other.as_str(),
                ..own("/tmp/theirs", "default")
            },
        ];
        for Seed {
            owner: row_owner,
            path,
            label,
            is_paused,
            owner_ss58,
            wire_folder_hash,
        } in rows
        {
            sqlx::query(
                "INSERT INTO sync_paths (owner, path, type, label, timestamp, is_paused, owner_ss58, wire_folder_hash)
                 VALUES (?, ?, 'folder', ?, 0, ?, ?, ?)",
            )
            .bind(row_owner)
            .bind(path)
            .bind(label)
            .bind(is_paused)
            .bind(owner_ss58)
            .bind(wire_folder_hash)
            .execute(&pool)
            .await
            .expect("insert sync_path");
        }

        let paths = own_drive_paths(&pool, account).await.expect("query own drives");
        assert_eq!(
            paths,
            vec![std::path::PathBuf::from("/tmp/own")],
            "lag probe must count only this account's active, non-migration, non-member drives"
        );
    }

    /// The whole point of the absolute-day key: keyed on days REMAINING,
    /// the warning would fire on each of the ten days before the charge.
    #[test]
    fn the_warning_window_is_the_ten_days_before_the_charge() {
        let short = |days: Option<i64>| should_warn_about_renewal(PlanAction::TopUpCredits, days);

        assert!(short(Some(0)), "the charge is today");
        assert!(short(Some(1)));
        assert!(short(Some(RENEWAL_WARNING_DAYS)));
        assert!(!short(Some(RENEWAL_WARNING_DAYS + 1)), "still too far off to interrupt");
    }

    /// A date already past is the rail lagging, not a renewal about to
    /// happen — warning about it would be noise the user cannot act on.
    #[test]
    fn a_renewal_date_in_the_past_does_not_warn() {
        assert!(!should_warn_about_renewal(PlanAction::TopUpCredits, Some(-1)));
    }

    /// No date from the rail is not evidence of anything.
    #[test]
    fn an_unknown_renewal_date_does_not_warn() {
        assert!(!should_warn_about_renewal(PlanAction::TopUpCredits, None));
    }

    /// The notification exists to say credits are short. An account being
    /// asked to upgrade, or asked nothing at all, has no business getting
    /// it however close its renewal is.
    #[test]
    fn only_the_top_up_prompt_warns() {
        for action in [PlanAction::Upgrade, PlanAction::None] {
            assert!(
                !should_warn_about_renewal(action, Some(1)),
                "{action:?} must not raise the credits warning",
            );
        }
    }

    /// The rail reports the charge as days since the epoch, so the
    /// remaining count is a subtraction against the same unit — computed
    /// in Rust so every surface counts down from the same "today".
    #[test]
    fn the_drive_rail_renewal_reaches_the_wire_as_days_remaining() {
        let today = today_unix_day();
        let sub = serde_json::json!({
            "active": true,
            "plan": "plus",
            "storage_bytes": 500_u64 * BYTES_PER_GB,
            "funding": "credits",
            "next_charge_unix_day": today + 6,
        });
        let plan = plan_from_drive_subscription(&sub, &serde_json::Value::Null).expect("a plan with a storage grant parses");

        assert_eq!(plan.renews_in_days, Some(6));
        assert_eq!(plan.renewal_unix_day, Some(today + 6));
    }

    /// A card plan renews itself; there is nothing here to count down to.
    #[test]
    fn the_legacy_stripe_plan_reports_no_renewal_countdown() {
        let active = serde_json::json!({
            "has_subscription": true,
            "subscription": { "credits_per_billing": 10.0, "plan_name": "Legacy" },
        });
        let plan = plan_from_subscription(&active).expect("a funded legacy subscription parses");

        assert_eq!(plan.renews_in_days, None);
        assert_eq!(plan.renewal_unix_day, None);
    }
}
