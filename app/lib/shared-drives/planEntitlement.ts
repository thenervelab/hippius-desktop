/**
 * Whether a plan includes shared drives.
 *
 * The server is the authority — a mint against a plan without the perk answers
 * 403 `shared_drives_not_entitled`, which the dialog turns into an upgrade
 * prompt. This is the surface gate in front of that: offering "Share drive" to
 * someone who cannot use it wastes a click and reads as a broken feature
 * rather than one they have not bought.
 *
 * Keyed on the plan CODE, never the display name. The name is a marketing
 * label that changes without a release, so a gate written against it stops
 * matching silently — which is exactly what the desktop shipped: a denylist of
 * `["starter", "free"]` compared against `plan.name`, where "starter" is not a
 * plan code at all and `solo` fell through as permitted. Solo customers got a
 * control the server refuses.
 *
 * An ALLOWLIST of the codes that include the perk, and a deliberate escape
 * hatch for codes this build has never heard of — the two failure modes are
 * not symmetric:
 *
 *   - Hiding it from a plan that DOES include it strands a paying customer
 *     with no route to a feature they own and no way to discover why.
 *   - Showing it to a plan that does not ends at the server's gate, which
 *     says "upgrade" — informative, and already built.
 *
 * So a code we recognise is decided here, and one we do not is left to the
 * server. A new tier is far more likely to include shared drives than not.
 */

import type { DrivePlanCode } from "@/app/lib/types/drive-plans";

/** Plan codes that include shared drives. Marketing names: Plus, Max, Scale. */
export const SHARED_DRIVE_PLAN_CODES: readonly DrivePlanCode[] = [
  "duo",
  "max",
  "scale",
];

/**
 * Every code this build knows. A code outside this set is a plan shipped after
 * this build, and is left to the server rather than refused here.
 */
const KNOWN_PLAN_CODES: readonly DrivePlanCode[] = [
  "free",
  "solo",
  "duo",
  "max",
  "scale",
];

export function planSupportsSharedDrives(
  planCode: string | null | undefined,
): boolean {
  // No plan at all is the free tier, which does not include shared drives.
  // An EMPTY code on a plan that exists is different — see `planInfo` below.
  if (planCode === null || planCode === undefined) return false;

  const normalized = planCode.trim().toLowerCase();
  // A plan whose code the rail did not report (the legacy Stripe storage
  // subscription has none). Unknown, not free — let the server decide.
  if (!normalized) return true;

  if (!(KNOWN_PLAN_CODES as readonly string[]).includes(normalized)) return true;
  return (SHARED_DRIVE_PLAN_CODES as readonly string[]).includes(normalized);
}
