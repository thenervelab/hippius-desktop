/**
 * The account balance, in dollars.
 *
 * One credit is one dollar, so this is a formatting choice rather than a
 * conversion. The app quotes money in dollars everywhere else (see
 * `formatPlanPrice`), and the balance is the one number a reader is most
 * likely to hold against a price, so quoting it in a second unit asked them
 * to learn an exchange rate to answer "can I afford this".
 *
 * BigInt throughout, never `Number(planck) / 1e18`: realistic balances exceed
 * `Number.MAX_SAFE_INTEGER`, so the float path rounds to the nearest double
 * before it rounds to cents (audit R-26 / W-21, same reason as
 * `formatPlanckToHip`). Here the cents are derived exactly and only the final
 * cent is rounded, half-up, which is what the console's balance does too, so
 * the two apps cannot quote the same account a cent apart.
 *
 * Display only. The authoritative affordability gate is Rust's
 * `check_action_eligibility`, reached through `useCreditCheck`.
 *
 * `formatPlanckToHip` keeps its own shape for the wallet, where the figure
 * sits beside on-chain amounts and the extra precision is the point.
 */

import { parseUnitsToBase } from "./planckUnits";

const PER_DOLLAR = BigInt(10) ** BigInt(18);
const HUNDRED = BigInt(100);

/** Thousands separators, so a four-figure balance reads as money. */
function group(whole: bigint): string {
  return whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * `null` and `undefined` render as "---" rather than "$0.00": a balance that
 * has not been read yet is unknown, and quoting zero for it tells the reader
 * they have nothing when the truth is that nobody has looked.
 */
export function formatBalanceUsd(
  /**
   * Either the 18-decimal planck integer, or the HIP decimal string Rust
   * already formatted (`credits_hip` on the storage overview). The string is
   * parsed back to base units exactly rather than through `Number`, so the
   * two inputs cannot round to different cents.
   */
  balance: bigint | string | null | undefined,
): string {
  if (balance === null || balance === undefined) return "---";

  const planck =
    typeof balance === "string" ? parseUnitsToBase(balance, 18) : balance;
  // Unparseable is unknown, not zero, for the same reason as null.
  if (planck === null) return "---";

  const negative = planck < BigInt(0);
  const magnitude = negative ? -planck : planck;

  // Exact cents, with only the last one rounded (half-up).
  const cents = (magnitude * HUNDRED + PER_DOLLAR / BigInt(2)) / PER_DOLLAR;
  const dollars = cents / HUNDRED;
  const remainder = cents % HUNDRED;

  return `${negative ? "-" : ""}$${group(dollars)}.${remainder
    .toString()
    .padStart(2, "0")}`;
}

export default formatBalanceUsd;
