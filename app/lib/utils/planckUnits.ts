/**
 * BigInt base-unit math for token amounts (display/input side only — the
 * authoritative balance/affordability gates stay in Rust, same rule as
 * `formatPlanckToHip`).
 *
 * Why not `Number(planck) / 1e18`: realistic balances exceed
 * `Number.MAX_SAFE_INTEGER`, so the float path rounds to the nearest double
 * BEFORE truncating — a value the client showed as affordable could clear an
 * inline guard yet be rejected by the authoritative Rust validator (audit
 * R-26 / W-21). The Bridge additionally mixes 9-decimal (alpha) and
 * 18-decimal (HIP) tokens, hence the generic `decimals` parameter.
 */

/**
 * Format a base-unit balance as a decimal string, truncated (never rounded)
 * to `displayDecimals` fractional digits, trailing zeros stripped.
 *
 * `decimals` is the token's base-unit exponent (18 for HIP planck, 9 for
 * Bittensor alpha rao). Values <= 0 render as "0".
 */
export function formatUnitsTruncated(
  value: bigint,
  decimals: number,
  displayDecimals = 6,
): string {
  if (value <= BigInt(0)) return "0";

  const divisor = BigInt(10) ** BigInt(decimals);
  const whole = value / divisor;
  const remainder = value % divisor;

  const shownDigits = Math.min(displayDecimals, decimals);
  // First `shownDigits` fractional digits, truncated.
  const truncatedFraction =
    shownDigits < decimals
      ? remainder / BigInt(10) ** BigInt(decimals - shownDigits)
      : remainder;
  const fraction = truncatedFraction
    .toString()
    .padStart(shownDigits, "0")
    .replace(/0+$/, "");

  return fraction.length > 0 ? `${whole}.${fraction}` : `${whole}`;
}

/**
 * Parse a user-typed decimal amount string into base units (BigInt).
 *
 * Accepts plain non-negative decimals (`"12"`, `"0.5"`, `".5"`, `"3."`).
 * Fractional digits beyond `decimals` are truncated (they cannot be
 * represented on-chain). Returns `null` for anything else — empty, signs,
 * exponents, grouping separators, multiple dots — so callers treat
 * unparseable input as "cannot submit", never as zero.
 */
export function parseUnitsToBase(amount: string, decimals: number): bigint | null {
  const trimmed = amount.trim();
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(trimmed)) return null;

  const [wholePart = "", fractionPart = ""] = trimmed.split(".");
  const fraction = fractionPart.slice(0, decimals).padEnd(decimals, "0");

  return (
    BigInt(wholePart || "0") * BigInt(10) ** BigInt(decimals) + BigInt(fraction || "0")
  );
}
