import type { PlanInfo, CapacitySource } from "@/app/lib/hooks/api/useStorageOverview";
import { describeDaysAway } from "@/components/ui/plan-chip/planActionView";

/**
 * What the Billing page's next-charge card should say.
 *
 * The balance card beside it answers "what do I have". This one answers
 * "what is leaving, and when", which the page could not answer at all: the
 * amount and the date existed on the wire but only surfaced as a WARNING
 * when the balance was short, so a healthy account was told nothing about a
 * recurring charge it is signed up for.
 *
 * Pure, so the branches are testable without a backend.
 */
export type NextChargeView =
  | { kind: "skeleton" }
  /** No subscription, so nothing recurring. The free tier charges nothing. */
  | { kind: "none" }
  | {
      kind: "charge";
      planName: string;
      /** Dollars, already formatted. */
      amount: string;
      /** "per month", from the plan's own interval. */
      cadence: string;
      /**
       * "in 6 days" / "today", or null when the rail did not say. A card
       * plan renews itself and reports no countdown, so the card says how
       * it renews instead of inventing a date.
       */
      whenText: string | null;
      /** Which rail pays, in the same words the plan cards use. */
      fundingLabel: string;
    };

/** The rail, named the way the rest of the app names it. */
export function fundingLabelFor(funding: string | null | undefined): string {
  if (funding === "card") return "Card";
  if (funding === "credits") return "Account balance";
  // The legacy Stripe subscription reports no rail. It is card-backed, but
  // saying so would be a guess, so the card states only what is known.
  return "Not stated";
}

export function getNextChargeView(input: {
  showSkeleton: boolean;
  source: CapacitySource | undefined;
  plan: PlanInfo | null | undefined;
}): NextChargeView {
  if (input.showSkeleton) return { kind: "skeleton" };
  // Only a subscription charges. The free tier and the no-plan state have
  // nothing recurring, and an error resolves here too rather than inventing
  // a charge: the storage card beside it already reports the failure.
  if (input.source !== "subscription" || !input.plan) return { kind: "none" };

  const plan = input.plan;
  const days = plan.renewsInDays;

  return {
    kind: "charge",
    planName: plan.name,
    amount: `$${plan.amount}`,
    cadence: `per ${plan.interval || "month"}`,
    whenText:
      typeof days === "number" && days >= 0 ? describeDaysAway(days) : null,
    fundingLabel: fundingLabelFor(plan.funding),
  };
}
