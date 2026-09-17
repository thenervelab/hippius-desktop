/**
 * Whether a plan includes shared drives.
 *
 * The server is the authority — a mint against a plan without the perk answers
 * 403 `shared_drives_not_entitled`, which the modal already turns into an
 * upgrade prompt. This is the surface gate in front of that: offering "Share
 * drive" to someone who cannot use it wastes a click and reads as a broken
 * feature rather than one they have not bought.
 *
 * A DENYLIST, not an allowlist, and that direction is deliberate. The failure
 * modes are not symmetric:
 *
 *   - Hiding it from a plan that does include it strands a paying customer with
 *     no route to a feature they own and no way to discover why.
 *   - Showing it to a plan that does not ends at the server's gate, which says
 *     "upgrade" — informative, and already built.
 *
 * So an unrecognised plan shows the surface. A new tier is far more likely to
 * include shared drives than not, and the server still decides.
 *
 * (Note this is the opposite of `parseDriveRole`, which degrades DOWN. There,
 * over-claiming implies powers the user does not hold over other people's
 * access; here, under-claiming just hides something they bought.)
 */

/** Plans known NOT to include shared drives, compared case-insensitively. */
const PLANS_WITHOUT_SHARED_DRIVES = ["starter", "free"];

export function planSupportsSharedDrives(
  planName: string | null | undefined,
): boolean {
  // No plan at all is the free tier, which does not include shared drives.
  if (!planName) return false;

  const normalized = planName.trim().toLowerCase();
  if (!normalized) return false;

  return !PLANS_WITHOUT_SHARED_DRIVES.includes(normalized);
}
