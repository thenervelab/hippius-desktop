import type { PlanAction } from "@/app/lib/hooks/api/useStorageOverview";

export interface PlanActionView {
  label: string;
  href: string;
  /** Whether to draw the plans icon (the upgrade route shows it). */
  withPlanIcon: boolean;
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
      return { label: "Upgrade", href: "/drive-plans", withPlanIcon: true };
    case "top-up-credits":
      return { label: "+ Top up Credits", href: "/billing", withPlanIcon: false };
    default:
      // Includes `undefined`: while the decision is still loading there is
      // nothing to offer, and guessing would flash the wrong prompt.
      return null;
  }
}
