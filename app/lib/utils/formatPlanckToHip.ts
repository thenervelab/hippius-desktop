/**
 * Format a planck balance (10^-18 HIP) to a HIP display string, truncated to
 * 6 decimal places.
 *
 * Uses BigInt string-division — NOT `Number(planck) / 1e18`. For realistic
 * balances `planck > Number.MAX_SAFE_INTEGER`, so the old float path rounded
 * to the nearest double *before* truncating; a value the client showed as
 * affordable could then clear the inline over-balance guard yet be rejected by
 * the authoritative Rust validator (audit R-26 / W-21). E.g. true available
 * `737553122357999955504448` planck must display as `737553.122357`, not
 * `737553.122358`.
 *
 * Mirrors the precision of Rust `convert::planck_to_hip_with_decimals`. The
 * authoritative gates remain Rust (`compute_max_transferable`,
 * `validate_send_balance`); this is display-only formatting.
 */
import { formatUnitsTruncated } from "./planckUnits";

export function formatPlanckToHip(planck: bigint): string {
  return formatUnitsTruncated(planck, 18, 6);
}

export default formatPlanckToHip;
