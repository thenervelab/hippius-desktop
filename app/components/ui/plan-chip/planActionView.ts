import type { PlanAction } from "@/app/lib/hooks/api/useStorageOverview";
import { BILLING_ROUTE } from "@/app/lib/routes";

export interface PlanActionView {
  label: string;
  href: string;
  /** Whether to draw the plans icon (the upgrade route shows it). */
  withPlanIcon: boolean;
}

/**
 * The sentence shown beside a top-up prompt, or `null` for the actions
 * that need no explanation.
 *
 * A bare "+ Top up Credits" button does not say why it is there, and the
 * consequence — the plan not renewing — is the part worth reading. The
 * countdown is included when Rust supplies one, because "in 6 days" is
 * what makes it actionable rather than a standing nag.
 *
 * Upgrade needs no note: the usage bar beside it is already the reason,
 * and a sentence repeating it would crowd the header.
 */
export function getPlanActionNote(
  action: PlanAction | undefined,
  renewsInDays: number | null | undefined,
): string | null {
  if (action !== "top-up-credits") return null;
  if (typeof renewsInDays !== "number" || renewsInDays < 0) {
    // No date from the rail, or one already past: say the thing that is
    // true either way rather than inventing a countdown.
    return "Low credits. Not enough to renew your plan";
  }
  return `Low credits. Your plan renews ${describeDaysAway(renewsInDays)}`;
}

/** "today" / "tomorrow" / "in 6 days", for the renewal countdown. */
function describeDaysAway(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

/**
 * Label and destination for the header's plan call to action.
 *
 * Which action to offer is decided in Rust (`planAction`) so every surface
 * agrees; this only maps that decision onto copy and a route. Keeping the
 * mapping pure is what lets the header be tested without a backend.
 *
 * `null` means render nothing — a healthy plan with room left should not
 * be sold anything.
 */
export function getPlanActionView(action: PlanAction | undefined): PlanActionView | null {
  switch (action) {
    case "upgrade":
      // Credits buy no Drive storage, so an account short of space is
      // never sent to the credits flow — only to a bigger plan.
      return { label: "Upgrade", href: BILLING_ROUTE, withPlanIcon: true };
    case "top-up-credits":
      return { label: "+ Top up Credits", href: BILLING_ROUTE, withPlanIcon: false };
    default:
      // Includes `undefined`: while the decision is still loading there is
      // nothing to offer, and guessing would flash the wrong prompt.
      return null;
  }
}
