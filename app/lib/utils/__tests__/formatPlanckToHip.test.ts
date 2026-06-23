import { describe, it, expect } from "vitest";
import { formatPlanckToHip } from "../formatPlanckToHip";

const HIP = BigInt("1000000000000000000"); // 10^18

describe("formatPlanckToHip", () => {
  it("formats whole and fractional HIP, trimming trailing zeros", () => {
    expect(formatPlanckToHip(BigInt(0))).toBe("0");
    expect(formatPlanckToHip(HIP)).toBe("1");
    expect(formatPlanckToHip(HIP + HIP / BigInt(2))).toBe("1.5"); // 1.5 HIP
    expect(formatPlanckToHip(HIP * BigInt(737553))).toBe("737553");
  });

  it("truncates to 6 decimals (never rounds up)", () => {
    // 1.1234567 HIP → 1.123456 (7th digit dropped, not rounded).
    const planck = HIP + BigInt("123456700000000000");
    expect(formatPlanckToHip(planck)).toBe("1.123456");
  });

  it("is precise at the balance boundary the float path got wrong (R-26/W-21)", () => {
    // True available is 737553.122357999… HIP. The old `Number(planck)/1e18`
    // path rounded this UP to 737553.122358, letting a value the client showed
    // as affordable clear the inline guard yet be rejected by Rust. The precise
    // BigInt path must truncate to 737553.122357.
    const planck = BigInt("737553122357999955504448");
    expect(formatPlanckToHip(planck)).toBe("737553.122357");
  });

  it("returns 0 for non-positive input", () => {
    expect(formatPlanckToHip(BigInt(-5))).toBe("0");
  });
});
