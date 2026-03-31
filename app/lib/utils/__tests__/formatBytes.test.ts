/**
 * formatBytes consistency tests
 *
 * Verify that formatBytes(number) and formatBytesFromBigInt(bigint) produce
 * identical output for the same input values. Both are used for storage stats
 * display — formatBytes on Home page (from indexer), formatBytesFromBigInt on
 * Files page (from local filesystem). They must agree.
 */
import { describe, it, expect } from "vitest";
import {
  formatBytes,
  formatBytesFromBigInt,
  bytesToUnit,
  unitToBytes,
  BYTE_UNITS,
} from "@/app/lib/utils/formatBytes";

describe("formatBytes (number input)", () => {
  it("returns '0 B' for zero", () => {
    expect(formatBytes(0)).toBe("0 B");
  });

  it("formats bytes", () => {
    expect(formatBytes(500)).toBe("500 B");
  });

  it("formats kilobytes", () => {
    expect(formatBytes(1000)).toBe("1 KB");
    expect(formatBytes(1500)).toBe("1.5 KB");
  });

  it("formats megabytes", () => {
    expect(formatBytes(1000000)).toBe("1 MB");
    expect(formatBytes(1500000)).toBe("1.5 MB");
  });

  it("formats gigabytes", () => {
    expect(formatBytes(1000000000)).toBe("1 GB");
    expect(formatBytes(5000000000)).toBe("5 GB");
  });

  it("formats terabytes", () => {
    expect(formatBytes(1000000000000)).toBe("1 TB");
  });

  it("respects decimal parameter", () => {
    expect(formatBytes(1234567, 0)).toBe("1 MB");
    expect(formatBytes(1234567, 1)).toBe("1.2 MB");
    expect(formatBytes(1234567, 3)).toBe("1.235 MB");
  });

  it("handles negative decimals as 0", () => {
    expect(formatBytes(1500, -1)).toBe("2 KB");
  });
});

describe("formatBytesFromBigInt (bigint input)", () => {
  it("returns '0 B' for zero", () => {
    expect(formatBytesFromBigInt(BigInt(0))).toBe("0 B");
  });

  it("formats bytes", () => {
    expect(formatBytesFromBigInt(BigInt(500))).toBe("500 B");
  });

  it("formats kilobytes", () => {
    expect(formatBytesFromBigInt(BigInt(1000))).toBe("1 KB");
    expect(formatBytesFromBigInt(BigInt(1500))).toBe("1.5 KB");
  });

  it("formats megabytes", () => {
    expect(formatBytesFromBigInt(BigInt(1000000))).toBe("1 MB");
    expect(formatBytesFromBigInt(BigInt(1500000))).toBe("1.5 MB");
  });

  it("formats gigabytes", () => {
    expect(formatBytesFromBigInt(BigInt(1000000000))).toBe("1 GB");
    expect(formatBytesFromBigInt(BigInt(5000000000))).toBe("5 GB");
  });

  it("formats terabytes", () => {
    expect(formatBytesFromBigInt(BigInt(1000000000000))).toBe("1 TB");
  });
});

describe("formatBytes and formatBytesFromBigInt produce identical output", () => {
  const testValues = [
    0,
    1,
    500,
    999,
    1000,
    1500,
    10000,
    100000,
    1000000,
    1500000,
    1234567,
    10000000,
    100000000,
    1000000000,
    5000000000,
    7500000000,
    1000000000000,
  ];

  for (const bytes of testValues) {
    it(`matches for ${bytes} bytes`, () => {
      const fromNumber = formatBytes(bytes, 2);
      const fromBigInt = formatBytesFromBigInt(BigInt(bytes), 2);
      expect(fromNumber).toBe(fromBigInt);
    });
  }
});

describe("Unit conversion helpers", () => {
  it("bytesToUnit converts correctly", () => {
    expect(bytesToUnit(5000000000, "GB")).toBe(5);
    expect(bytesToUnit(1500000, "MB")).toBe(1.5);
    expect(bytesToUnit(1000, "KB")).toBe(1);
  });

  it("unitToBytes converts correctly", () => {
    expect(unitToBytes(5, "GB")).toBe(5000000000);
    expect(unitToBytes(1.5, "MB")).toBe(1500000);
    expect(unitToBytes(1, "KB")).toBe(1000);
  });

  it("round-trips correctly", () => {
    const originalBytes = 5000000000;
    const gb = bytesToUnit(originalBytes, "GB");
    const backToBytes = unitToBytes(gb, "GB");
    expect(backToBytes).toBe(originalBytes);
  });

  it("BYTE_UNITS constants are SI (1000-based)", () => {
    expect(BYTE_UNITS.KB).toBe(1000);
    expect(BYTE_UNITS.MB).toBe(1000000);
    expect(BYTE_UNITS.GB).toBe(1000000000);
    expect(BYTE_UNITS.TB).toBe(1000000000000);
  });
});
