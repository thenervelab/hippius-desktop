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
 * A bare "Top up" button does not say why it is there, and the
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

/**
 * The full low-credit warning for a page with room to explain it.
 *
 * `getPlanActionNote` is the one-line version for the header, where
 * there is space for a clause and no more. "Low credits. Your plan
 * renews in 22 days" states a fact and a date without saying what
 * happens, what it costs, or how short the balance actually is — so the
 * reader has to work out that the plan is about to stop.
 *
 * This says all three: what the plan costs, what the balance is, and by
 * when. The price is in dollars and the balance in credits, which is the
 * app's rule — a price is always dollars, and credits are named only
 * where they are the subject.
 *
 * Takes the whole overview rather than the balance, so the surfaces stay
 * unable to decide anything for themselves: whether the balance is short
 * is Rust's call, carried on `planAction`, and this only reads it.
 *
 * `null` whenever Rust is not asking for a top-up, so a caller can render
 * it unconditionally.
 */
export function getRenewalNotice(
  overview:
    | {
        planAction?: PlanAction;
        creditsHip?: string | null;
        plan?: { name?: string | null; amount?: number | null; renewsInDays?: number | null } | null;
      }
    | undefined,
): { title: string; description: string } | null {
  if (overview?.planAction !== "top-up-credits") return null;

  const plan = overview.plan;
  const planName = plan?.name?.trim();
  const named = planName ? `Your ${planName} plan` : "Your plan";

  // Each clause is dropped rather than guessed at when its input is
  // missing: a warning that invents a price is worse than a shorter one.
  const cost = typeof plan?.amount === "number" ? ` costs $${plan.amount} a month and` : " needs more credits than you have —";
  const balance = overview.creditsHip ? ` you have ${overview.creditsHip} credits` : " your balance will not cover it";

  const days = plan?.renewsInDays;
  const when =
    typeof days === "number" && days >= 0
      ? ` Top up before it renews ${describeDaysAway(days)}, or it will not renew.`
      : " Top up to keep it running.";

  return {
    title: "Not enough credits to renew your plan",
    description: `${named}${cost}${balance}.${when}`,
  };
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
      // "Top up", not "+ Top up Credits". The leading plus reads as
      // "create new", which is the same thing it got wrong on the upload
      // buttons, and "Credits" is already said by the amber note sitting
      // beside it in the chip. It was also the widest element in a header
      // cell whose size was the complaint. Matches
      // `CreditsExhaustedBanner`, which has always said "Top up".
      return { label: "Top up", href: BILLING_ROUTE, withPlanIcon: false };
    default:
      // Includes `undefined`: while the decision is still loading there is
      // nothing to offer, and guessing would flash the wrong prompt.
      return null;
  }
}
