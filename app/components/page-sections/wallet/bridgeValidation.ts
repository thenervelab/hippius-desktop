// Pure client-side guard for the bridge amount, extracted from BridgeDialog so
// the BigInt boundary rules can be unit-tested without rendering the dialog.
// Returns a reason CODE rather than a formatted message — the dialog owns the
// token/decimals formatting, this owns the rules. All arithmetic is BigInt
// (planck/base units), so balances past Number.MAX_SAFE_INTEGER are exact.

export type BridgeAmountVerdict =
  | { ok: true }
  | { ok: false; reason: "invalid" | "below_min" | "exceeds_balance" };

export function evaluateBridgeAmount(input: {
  amountPlanck: bigint | null;
  minAmountPlanck: bigint;
  sourceBalancePlanck: bigint | null;
}): BridgeAmountVerdict {
  const { amountPlanck, minAmountPlanck, sourceBalancePlanck } = input;
  // Unparseable or non-positive.
  if (amountPlanck === null || amountPlanck <= 0n) {
    return { ok: false, reason: "invalid" };
  }
  // Below a configured floor (min of 0 means "no floor").
  if (minAmountPlanck > 0n && amountPlanck < minAmountPlanck) {
    return { ok: false, reason: "below_min" };
  }
  // Over the known source balance. A null balance is "still loading" — the
  // dialog optimistically allows it and the server is the backstop.
  if (sourceBalancePlanck !== null && amountPlanck > sourceBalancePlanck) {
    return { ok: false, reason: "exceeds_balance" };
  }
  return { ok: true };
}
