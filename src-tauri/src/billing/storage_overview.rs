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
//!   2. else credits > 0    → capacity is `used + credits-buyable storage`
//!      (the mobile app's original hybrid: the balance prices the *free*
//!      space, so what's already stored still counts toward the total)
//!   3. else                → no capacity to plot ("No active plan")
//!
//! Every consumer (storage card, plan card, top-bar chip) renders from this
//! single decision, so the surfaces can never disagree about whether the
//! user is "on a plan" or "on credits". Allowances are derived from
//! credit amounts through the same pricing model every other surface uses
//! (`calculate_storage_capacity` — console ProHeader, plan cards).

use serde::Serialize;

use crate::api::client::ApiClient;
use crate::error::AppError;

/// Capacity math is decimal GB end-to-end (`calculate_storage_capacity`
/// returns SI GB; the FE formats with the SI `formatBytes`), so the GB→bytes
/// conversion must be SI too — 1e9, not 2^30.
const BYTES_PER_GB: u64 = 1_000_000_000;

/// Which source won the capacity decision. Lowercase on the wire.
#[derive(Serialize, Debug, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum CapacitySource {
    Subscription,
    Credits,
    None,
}

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
}

/// Pure composition of the overview from its three inputs.
///
/// `credits` is the balance in HIP units; `credits_capacity_gb` is what that
/// balance buys per month (pre-computed by the caller so this stays pure and
/// unit-testable without the pricing binary search).
fn build_overview(used_bytes: u64, plan: Option<PlanInfo>, credits: f64, credits_capacity_gb: u64, credits_hip: Option<String>) -> StorageOverview {
    if let Some(plan) = plan {
        let total_bytes = plan.storage_bytes;
        let percent = percent_of(used_bytes, total_bytes);
        return StorageOverview {
            used_bytes,
            total_bytes,
            percent,
            source: CapacitySource::Subscription,
            plan: Some(plan),
            credits_hip,
            used_pending: false,
        };
    }
    if credits > 0.0 {
        // The balance prices what can still be stored, so capacity is
        // used + buyable — matching the mobile app's original hybrid.
        let total_bytes = used_bytes.saturating_add(credits_capacity_gb.saturating_mul(BYTES_PER_GB));
        let percent = percent_of(used_bytes, total_bytes);
        return StorageOverview {
            used_bytes,
            total_bytes,
            percent,
            source: CapacitySource::Credits,
            plan: None,
            credits_hip,
            used_pending: false,
        };
    }
    StorageOverview {
        used_bytes,
        total_bytes: 0,
        percent: 0.0,
        source: CapacitySource::None,
        plan: None,
        credits_hip,
        used_pending: false,
    }
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
/// drive labels to resolve patterns from, and the cache keys on the ruleset
/// so a rule-less walk cannot poison the listing's entries. KNOWN GAP: a
/// drive whose only un-uploaded bytes are excluded reads as "local data the
/// indexer has not caught up with", pinning the card on "Updating…" for
/// something that will never upload.
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
fn plan_from_subscription(active: &serde_json::Value) -> Option<PlanInfo> {
    if !active.get("has_subscription").and_then(serde_json::Value::as_bool).unwrap_or(false) {
        return None;
    }
    let sub = active.get("subscription")?;
    let credits_per_billing = sub.get("credits_per_billing").and_then(serde_json::Value::as_f64).unwrap_or(0.0);
    if credits_per_billing <= 0.0 {
        return None;
    }
    Some(PlanInfo {
        name: sub.get("plan_name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        amount: sub.get("amount").and_then(serde_json::Value::as_f64).unwrap_or(0.0),
        interval: sub.get("interval").and_then(|v| v.as_str()).unwrap_or("month").to_string(),
        storage_bytes: capacity_gb_for_credits(credits_per_billing).saturating_mul(BYTES_PER_GB),
    })
}

/// GB purchasable per month for a credit amount, via the canonical pricing
/// model (`calculate_storage_capacity`'s binary search).
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

    let (stats_result, active_result, credits_result) = tokio::join!(
        crate::billing::queries::fetch_drive_storage_stats(state.inner(), account_id.as_str()),
        client.get::<serde_json::Value>("/api/billing/stripe/active-subscription/", &account_id),
        crate::billing::credits::fetch_credit_balance_planck(state.inner(), &account_id),
    );

    let stats = stats_result?;
    let active = active_result.unwrap_or_else(|_| serde_json::json!({ "has_subscription": false }));

    let credits_hip = credits_result.ok().map(|planck| crate::blockchain::convert::planck_to_hip(&planck));
    // The display string is plain decimal ("1.5"), so it parses directly;
    // an absent/unparseable balance reads as 0 → the chain falls to None.
    let credits: f64 = credits_hip.as_deref().and_then(|hip| hip.parse().ok()).unwrap_or(0.0);

    let plan = plan_from_subscription(&active);
    // Only price the credits capacity when it can win the chain — the
    // binary search is cheap, but skipping it keeps the plan path lean.
    let credits_capacity_gb = if plan.is_none() { capacity_gb_for_credits(credits) } else { 0 };

    // Indexer empty-row is success + 0 bytes (not an error). Probe local
    // own-drive dir_stats only then, so a lagging indexer cannot paint
    // "0 B" over files the Files header already shows. Skip the walk
    // when the indexer already has a total.
    let local_bytes = if stats.total_bytes == 0 {
        local_own_drive_bytes(state.pool()?, account_id.as_str()).await
    } else {
        0
    };

    let mut overview = build_overview(stats.total_bytes, plan, credits, credits_capacity_gb, credits_hip);
    overview.used_pending = used_pending(stats.total_bytes, local_bytes);
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
        }
    }

    #[test]
    fn subscription_wins_over_credits() {
        // 300 GB of a 1000 GB plan → 30%, even with a fat credit balance.
        let overview = build_overview(300 * BYTES_PER_GB, Some(pro_plan(1000)), 500.0, 999_999, Some("500".into()));
        assert_eq!(overview.source, CapacitySource::Subscription);
        assert_eq!(overview.total_bytes, 1000 * BYTES_PER_GB);
        assert!((overview.percent - 30.0).abs() < 1e-9);
        assert_eq!(overview.plan.as_ref().map(|p| p.name.as_str()), Some("Pro"));
        // Credits still ride along for display.
        assert_eq!(overview.credits_hip.as_deref(), Some("500"));
    }

    #[test]
    fn credits_capacity_is_used_plus_buyable() {
        // 100 GB stored, credits buy 300 GB → total 400 GB, 25% used.
        let overview = build_overview(100 * BYTES_PER_GB, None, 1.0, 300, Some("1".into()));
        assert_eq!(overview.source, CapacitySource::Credits);
        assert_eq!(overview.total_bytes, 400 * BYTES_PER_GB);
        assert!((overview.percent - 25.0).abs() < 1e-9);
        assert_eq!(overview.plan, None);
    }

    #[test]
    fn no_plan_no_credits_yields_none() {
        let overview = build_overview(42, None, 0.0, 0, Some("0".into()));
        assert_eq!(overview.source, CapacitySource::None);
        assert_eq!(overview.used_bytes, 42);
        assert_eq!(overview.total_bytes, 0);
        assert!(overview.percent.abs() < 1e-9);
    }

    #[test]
    fn over_quota_clamps_to_100() {
        // Usage above the allowance (downgrade case) must not overflow the bar.
        let overview = build_overview(2000 * BYTES_PER_GB, Some(pro_plan(1000)), 0.0, 0, None);
        assert!((overview.percent - 100.0).abs() < 1e-9);
        // Raw byte counts stay honest even while the percent clamps.
        assert_eq!(overview.used_bytes, 2000 * BYTES_PER_GB);
    }

    #[test]
    fn credits_that_buy_nothing_still_count_as_credits() {
        // A dust balance prices 0 extra GB: total == used → a full bar,
        // which is the honest reading ("you can't store more on this").
        let overview = build_overview(500, None, 0.0001, 0, Some("0.0001".into()));
        assert_eq!(overview.source, CapacitySource::Credits);
        assert_eq!(overview.total_bytes, 500);
        assert!((overview.percent - 100.0).abs() < 1e-9);
    }

    #[test]
    fn zero_gb_plan_does_not_divide_by_zero() {
        let overview = build_overview(500, Some(pro_plan(0)), 0.0, 0, None);
        assert_eq!(overview.source, CapacitySource::Subscription);
        assert_eq!(overview.total_bytes, 0);
        assert!(overview.percent.abs() < 1e-9);
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
        let mut overview = build_overview(0, None, 1.0, 300, Some("1".into()));
        overview.used_pending = used_pending(overview.used_bytes, 46);
        assert_eq!(overview.used_bytes, 0, "local walk must not be written into used_bytes");
        assert!(overview.used_pending);
        assert_eq!(overview.source, CapacitySource::Credits);
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
}
