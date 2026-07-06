import { describe, it, expect } from "vitest";
import { formatUnitsTruncated, parseUnitsToBase } from "../planckUnits";

describe("formatUnitsTruncated", () => {
  it("truncates (never rounds) beyond Number.MAX_SAFE_INTEGER — the R-26 case", () => {
    // The float path rendered this as 737553.122358 (rounded); the true
    // truncated display is .122357.
    expect(formatUnitsTruncated(BigInt("737553122357999955504448"), 18)).toBe(
      "737553.122357",
    );
  });

  it("handles zero, negatives, and dust", () => {
    expect(formatUnitsTruncated(BigInt(0), 18)).toBe("0");
    expect(formatUnitsTruncated(BigInt(-5), 18)).toBe("0");
    expect(formatUnitsTruncated(BigInt(1), 18)).toBe("0"); // < 10^-6 HIP truncates away
  });

  it("strips trailing zeros and renders exact wholes bare", () => {
    expect(formatUnitsTruncated(BigInt("1000000000000000000"), 18)).toBe("1");
    expect(formatUnitsTruncated(BigInt("1500000000000000000"), 18)).toBe("1.5");
  });

  it("supports 9-decimal tokens (Bridge alpha) with full precision", () => {
    expect(formatUnitsTruncated(BigInt("1234567891"), 9)).toBe("1.234567");
    expect(formatUnitsTruncated(BigInt("1234567891"), 9, 9)).toBe("1.234567891");
  });

  it("caps shown digits at the token's own decimals", () => {
    // displayDecimals > decimals must not invent digits.
    expect(formatUnitsTruncated(BigInt("105"), 2, 6)).toBe("1.05");
  });
});

describe("parseUnitsToBase", () => {
  it("parses whole and fractional amounts into base units", () => {
    expect(parseUnitsToBase("1", 18)).toBe(BigInt("1000000000000000000"));
    expect(parseUnitsToBase("0.5", 18)).toBe(BigInt("500000000000000000"));
    expect(parseUnitsToBase(".5", 9)).toBe(BigInt("500000000"));
    expect(parseUnitsToBase("3.", 9)).toBe(BigInt("3000000000"));
    expect(parseUnitsToBase("0", 18)).toBe(BigInt(0));
  });

  it("round-trips values beyond Number.MAX_SAFE_INTEGER exactly", () => {
    expect(parseUnitsToBase("737553.122357", 18)).toBe(
      BigInt("737553122357000000000000"),
    );
  });

  it("truncates fractional digits beyond the token's decimals", () => {
    expect(parseUnitsToBase("1.2345678999", 9)).toBe(BigInt("1234567899"));
  });

  it("rejects invalid input as null, never zero", () => {
    for (const bad of ["", " ", "-1", "+1", "1e5", "1,000", "1.2.3", "abc", "."]) {
      expect(parseUnitsToBase(bad, 18)).toBeNull();
    }
  });
});
