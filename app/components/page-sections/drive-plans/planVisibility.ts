/**
 * Which plans an account may actually be offered.
 *
 * Pure and shared, because two surfaces ask the same question — the
 * plans page and the empty-state catalogue under an empty Drive — and a
 * second copy of the rule is one that drifts.
 */

export interface OfferablePlan {
  is_free: boolean;
}

/**
 * Whether the free tier is something this account could have.
 *
 * `undefined` — the overview not settled yet — counts as entitled. This
 * decides what the UI SHOWS, and the pessimistic reading would blink the
 * free card out of the grid on every load for the accounts that do have
 * it. Anything that actually spends storage is gated server-side.
 */
export function isFreeTierEntitled(freeTierEntitled: boolean | undefined): boolean {
  return freeTierEntitled !== false;
}

/**
 * The plans to render.
 *
 * An account signed in with an access key has no included allowance, so a
 * Free Drive Plan card is not a plan it is on, nor one it could fall back
 * to — it is an offer of storage that does not exist for them. Dropped
 * rather than disabled: there is no circumstance in which they can take
 * it.
 *
 * Note this cannot be answered from the capacity `source`: an unentitled
 * account holding a paid plan reports `"subscription"`, identical to an
 * entitled one. Only the entitlement flag separates them.
 */
export function offeredPlans<T extends OfferablePlan>(
  plans: T[] | undefined,
  freeTierEntitled: boolean | undefined,
): T[] | undefined {
  if (isFreeTierEntitled(freeTierEntitled)) return plans;
  return plans?.filter((plan) => !plan.is_free);
}
