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
const PLANCK_PER_HIP = BigInt("1000000000000000000"); // 10^18
const PLANCK_PER_MICRO_HIP = BigInt("1000000000000"); // 10^12 (→ 6 decimals)

export function formatPlanckToHip(planck: bigint): string {
  if (planck <= BigInt(0)) return "0";

  const whole = planck / PLANCK_PER_HIP;
  const remainder = planck % PLANCK_PER_HIP;

  // First 6 fractional digits, truncated (never rounded).
  const sixDecimals = (remainder / PLANCK_PER_MICRO_HIP).toString().padStart(6, "0");
  const trimmed = sixDecimals.replace(/0+$/, "");

  return trimmed.length > 0 ? `${whole}.${trimmed}` : `${whole}`;
}

export default formatPlanckToHip;
