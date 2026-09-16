import { describe, expect, it } from "vitest";
import { formatBalanceUsd } from "../formatBalanceUsd";

const DOLLAR = BigInt(10) ** BigInt(18);
const CENT = DOLLAR / BigInt(100);

describe("formatBalanceUsd", () => {
  it("quotes a balance in dollars and cents", () => {
    expect(formatBalanceUsd(DOLLAR * BigInt(5) + CENT * BigInt(13))).toBe("$5.13");
    expect(formatBalanceUsd(BigInt(0))).toBe("$0.00");
    expect(formatBalanceUsd(DOLLAR)).toBe("$1.00");
  });

  it("always shows both cents, so a balance reads as money", () => {
    // "$5.1" reads as a truncated number; a balance is a price-shaped thing.
    expect(formatBalanceUsd(DOLLAR * BigInt(5) + CENT * BigInt(10))).toBe("$5.10");
  });

  it("groups thousands", () => {
    expect(formatBalanceUsd(DOLLAR * BigInt(1660) + CENT * BigInt(60))).toBe(
      "$1,660.60",
    );
    expect(formatBalanceUsd(DOLLAR * BigInt(1234567))).toBe("$1,234,567.00");
  });

  it("stays exact above Number.MAX_SAFE_INTEGER", () => {
    // The float path would round to the nearest double before reaching cents.
    // 737553.122357... planck is the value audit R-26 pinned for the wallet.
    const planck = BigInt("737553122357999955504448");
    expect(formatBalanceUsd(planck)).toBe("$737,553.12");
  });

  it("rounds the last cent half-up, matching the console", () => {
    // Half a cent up, so the two apps cannot quote one account a cent apart.
    expect(formatBalanceUsd(CENT * BigInt(5) + CENT / BigInt(2))).toBe("$0.06");
    // Just under half stays down.
    expect(formatBalanceUsd(CENT * BigInt(5) + CENT / BigInt(2) - BigInt(1))).toBe(
      "$0.05",
    );
  });

  it("reads an unknown balance as unknown, not as zero", () => {
    // A balance nobody has read yet is not the same as an empty one.
    expect(formatBalanceUsd(null)).toBe("---");
    expect(formatBalanceUsd(undefined)).toBe("---");
  });

  it("keeps a negative balance signed outside the dollar sign", () => {
    expect(formatBalanceUsd(-(DOLLAR * BigInt(2) + CENT * BigInt(50)))).toBe("-$2.50");
  });
});

describe("formatBalanceUsd from the HIP string Rust already formatted", () => {
  it("rounds a six-decimal display string to cents", () => {
    // `credits_hip` comes from planck_to_hip, so it can carry six decimals.
    // Printing it straight after a dollar sign gave "$5.123456".
    expect(formatBalanceUsd("5.123456")).toBe("$5.12");
    expect(formatBalanceUsd("737553.122357")).toBe("$737,553.12");
  });

  it("agrees with the planck path for the same balance", () => {
    const planck = DOLLAR * BigInt(5) + CENT * BigInt(13);
    expect(formatBalanceUsd("5.13")).toBe(formatBalanceUsd(planck));
  });

  it("treats an unparseable string as unknown rather than zero", () => {
    expect(formatBalanceUsd("")).toBe("---");
    expect(formatBalanceUsd("not a number")).toBe("---");
  });
});
