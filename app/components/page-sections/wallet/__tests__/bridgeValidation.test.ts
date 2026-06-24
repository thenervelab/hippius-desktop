import { describe, it, expect } from "vitest";
import { evaluateBridgeAmount } from "@/components/page-sections/wallet/bridgeValidation";

describe("evaluateBridgeAmount", () => {
  const min = 10n;
  const balance = 1000n;

  it("rejects an unparseable amount", () => {
    expect(
      evaluateBridgeAmount({ amountPlanck: null, minAmountPlanck: min, sourceBalancePlanck: balance })
    ).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects zero and negative amounts", () => {
    expect(
      evaluateBridgeAmount({ amountPlanck: 0n, minAmountPlanck: min, sourceBalancePlanck: balance })
        .reason
    ).toBe("invalid");
    expect(
      evaluateBridgeAmount({ amountPlanck: -5n, minAmountPlanck: min, sourceBalancePlanck: balance })
        .reason
    ).toBe("invalid");
  });

  it("rejects below the minimum, but accepts exactly the minimum", () => {
    expect(
      evaluateBridgeAmount({ amountPlanck: 9n, minAmountPlanck: min, sourceBalancePlanck: balance })
    ).toEqual({ ok: false, reason: "below_min" });
    expect(
      evaluateBridgeAmount({ amountPlanck: 10n, minAmountPlanck: min, sourceBalancePlanck: balance })
    ).toEqual({ ok: true });
  });

  it("treats a zero minimum as 'no floor'", () => {
    expect(
      evaluateBridgeAmount({ amountPlanck: 1n, minAmountPlanck: 0n, sourceBalancePlanck: balance })
    ).toEqual({ ok: true });
  });

  it("rejects over balance, but accepts exactly the balance", () => {
    expect(
      evaluateBridgeAmount({ amountPlanck: 1001n, minAmountPlanck: min, sourceBalancePlanck: balance })
    ).toEqual({ ok: false, reason: "exceeds_balance" });
    expect(
      evaluateBridgeAmount({ amountPlanck: 1000n, minAmountPlanck: min, sourceBalancePlanck: balance })
    ).toEqual({ ok: true });
  });

  it("optimistically allows when the balance is still loading (null)", () => {
    expect(
      evaluateBridgeAmount({
        amountPlanck: 999999n,
        minAmountPlanck: min,
        sourceBalancePlanck: null,
      })
    ).toEqual({ ok: true });
  });

  it("is exact past Number.MAX_SAFE_INTEGER (BigInt, no float drift)", () => {
    const huge = BigInt(Number.MAX_SAFE_INTEGER) * 1000n; // 9.007e21
    expect(
      evaluateBridgeAmount({
        amountPlanck: huge + 1n,
        minAmountPlanck: 0n,
        sourceBalancePlanck: huge,
      })
    ).toEqual({ ok: false, reason: "exceeds_balance" });
    expect(
      evaluateBridgeAmount({
        amountPlanck: huge,
        minAmountPlanck: 0n,
        sourceBalancePlanck: huge,
      })
    ).toEqual({ ok: true });
  });

  it("checks the minimum before the balance (precedence)", () => {
    // Below both min and balance bounds → the min reason wins.
    expect(
      evaluateBridgeAmount({ amountPlanck: 5n, minAmountPlanck: 10n, sourceBalancePlanck: 3n })
        .reason
    ).toBe("below_min");
  });
});
