//! Whether this account's Drive plan lets it share drives and folders.
//!
//! Sharing for collaboration (an emailed invite, an invite link for a drive
//! or a folder, and anything else that adds people) is part of the Plus,
//! Max and Scale plans. Free and Starter accounts see an upgrade prompt
//! instead. This is the ONE place that rule lives: `get_storage_overview`
//! puts the answer on the wire as `canShareDrives`, and the frontend only
//! reads it.
//!
//! The server stays the authority. A mint on a plan without the perk is
//! refused with 403 `shared_drives_not_entitled`, which
//! `shared_drives::commands::classify_error_status` maps to
//! `NotReady(SharedDrivesNotEntitled)`. This answer exists so the app can
//! say so before anyone types an address, not to replace that gate.
//!
//! Keyed on the plan CODE, never the marketing name, which changes without
//! a release. The two ways of being wrong are not symmetric:
//!
//! - hiding sharing from a plan that includes it strands a paying customer
//!   with no route to a feature they own;
//! - offering it to one that does not ends at the server's refusal, which
//!   the app already turns into the same upgrade prompt.
//!
//! So a code this build knows is decided here, and anything it cannot read
//! (a code it has never heard of, an empty code, a subscription that could
//! not be loaded) is left to the server.

use crate::billing::storage_overview::PlanInfo;

/// Plan codes that include sharing. Marketing names: Plus, Max, Scale.
pub const SHARING_PLAN_CODES: [&str; 3] = ["duo", "max", "scale"];

/// Every plan code this build knows. `solo` is sold as Starter.
const KNOWN_PLAN_CODES: [&str; 5] = ["free", "solo", "duo", "max", "scale"];

/// Whether a plan code includes sharing.
///
/// `None` is an account with no plan at all, which is the free tier. An
/// empty code is a plan that exists but did not say which it is (the legacy
/// card subscription has none), so it is unknown rather than free.
pub fn plan_code_allows_sharing(code: Option<&str>) -> bool {
    let Some(code) = code else { return false };
    let code = code.trim().to_ascii_lowercase();
    if code.is_empty() || !KNOWN_PLAN_CODES.contains(&code.as_str()) {
        return true;
    }
    SHARING_PLAN_CODES.contains(&code.as_str())
}

/// The drive-rail subscription's plan code, when it names an active plan.
fn active_drive_plan_code(sub: &serde_json::Value) -> Option<&str> {
    if !sub.get("active").and_then(serde_json::Value::as_bool).unwrap_or(false) {
        return None;
    }
    sub.get("plan").and_then(serde_json::Value::as_str)
}

/// Decide `canShareDrives` from what the overview managed to read.
///
/// - `plan` is the plan the overview resolved; when there is one, its code
///   decides.
/// - `drive_sub` is the drive-rail subscription payload, `None` when it
///   could not be read. An unreadable subscription blocks nothing.
/// - An active drive subscription the overview could not turn into a plan
///   (a payload missing its size, say) is still decided by its code.
/// - `legacy_read` is whether the legacy card subscription was read. With
///   no plan found anywhere, a failed read there is unknown too.
///
/// Only a clean read that finds no plan, or a known code without sharing,
/// answers `false`.
pub fn resolve_can_share_drives(plan: Option<&PlanInfo>, drive_sub: Option<&serde_json::Value>, legacy_read: bool) -> bool {
    if let Some(plan) = plan {
        return plan_code_allows_sharing(Some(&plan.code));
    }
    let Some(sub) = drive_sub else { return true };
    if let Some(code) = active_drive_plan_code(sub) {
        return plan_code_allows_sharing(Some(code));
    }
    if !legacy_read {
        return true;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn plan(code: &str) -> PlanInfo {
        PlanInfo {
            name: "Any name".into(),
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

    #[test]
    fn plus_max_and_scale_can_share() {
        for code in ["duo", "max", "scale"] {
            assert!(plan_code_allows_sharing(Some(code)), "{code} includes sharing");
        }
    }

    #[test]
    fn free_and_starter_cannot_share() {
        for code in ["free", "solo"] {
            assert!(!plan_code_allows_sharing(Some(code)), "{code} does not include sharing");
        }
    }

    #[test]
    fn casing_and_padding_do_not_change_the_answer() {
        assert!(plan_code_allows_sharing(Some("  DUO ")));
        assert!(plan_code_allows_sharing(Some("Scale")));
        assert!(!plan_code_allows_sharing(Some(" SOLO ")));
        assert!(!plan_code_allows_sharing(Some("Free")));
    }

    #[test]
    fn no_plan_at_all_is_the_free_tier() {
        assert!(!plan_code_allows_sharing(None));
    }

    /// A plan that exists but did not report a code, or a tier shipped
    /// after this build: the server decides, and says "upgrade" if it must.
    #[test]
    fn an_unknown_or_empty_code_is_left_to_the_server() {
        assert!(plan_code_allows_sharing(Some("")));
        assert!(plan_code_allows_sharing(Some("   ")));
        assert!(plan_code_allows_sharing(Some("team")));
        // A marketing name is not a code: it reads as unknown, never as free.
        assert!(plan_code_allows_sharing(Some("Starter")));
    }

    #[test]
    fn the_resolved_plan_decides_when_there_is_one() {
        let sub = json!({ "active": true, "plan": "solo" });
        assert!(resolve_can_share_drives(Some(&plan("max")), Some(&sub), true));
        assert!(!resolve_can_share_drives(Some(&plan("solo")), Some(&sub), true));
        // The legacy card plan has no code: unknown, so not blocked.
        assert!(resolve_can_share_drives(Some(&plan("")), None, false));
    }

    #[test]
    fn a_clean_read_with_no_plan_is_the_free_tier() {
        let inactive = json!({ "active": false });
        assert!(!resolve_can_share_drives(None, Some(&inactive), true));
        let free = json!({ "active": true, "plan": "free" });
        assert!(!resolve_can_share_drives(None, Some(&free), true));
    }

    /// A plan that cannot be loaded must not block anyone.
    #[test]
    fn a_subscription_that_could_not_be_read_blocks_nothing() {
        assert!(resolve_can_share_drives(None, None, true));
        let inactive = json!({ "active": false });
        assert!(resolve_can_share_drives(None, Some(&inactive), false));
    }

    /// An active subscription the overview could not size is still a plan:
    /// its code decides, so a Plus account is not told it is on Free.
    #[test]
    fn an_active_subscription_without_a_resolved_plan_is_decided_by_its_code() {
        let plus = json!({ "active": true, "plan": "duo" });
        assert!(resolve_can_share_drives(None, Some(&plus), true));
        let starter = json!({ "active": true, "plan": "solo" });
        assert!(!resolve_can_share_drives(None, Some(&starter), true));
    }
}
