import { describe, it, expect } from "vitest";
import { macosNameCmp } from "@/app/lib/utils/fileSort";

// macosNameCmp mirrors the Rust `macos_name_cmp` in sync/files.rs so the NAME
// column header sorts identically to the backend's default load order. A drift
// here silently desyncs the two. Known-answer cases below pin the three
// documented rules: case-insensitive, natural-number, category order
// (punctuation < digits < letters). Sign is asserted (not exact magnitude)
// because the numeric branch returns a parsed-int difference.

const sign = (n: number): -1 | 0 | 1 => (n < 0 ? -1 : n > 0 ? 1 : 0);

describe("macosNameCmp — documented rules", () => {
  it("is case-insensitive", () => {
    expect(macosNameCmp("apple", "Apple")).toBe(0);
    expect(macosNameCmp("README", "readme")).toBe(0);
  });

  it("orders numbers naturally, not lexically", () => {
    expect(sign(macosNameCmp("file9", "file10"))).toBe(-1); // 9 < 10, not "9" > "1"
    expect(sign(macosNameCmp("2025", "2026"))).toBe(-1);
    expect(sign(macosNameCmp("img2", "img12"))).toBe(-1);
    expect(sign(macosNameCmp("v100", "v99"))).toBe(1);
  });

  it("category order: punctuation/symbols < digits < letters", () => {
    expect(sign(macosNameCmp("-file", "1file"))).toBe(-1); // symbol < digit
    expect(sign(macosNameCmp("1file", "afile"))).toBe(-1); // digit < letter
    expect(sign(macosNameCmp("_x", "0x"))).toBe(-1); // underscore is a symbol here
  });

  it("falls back to length when one name is a prefix of the other", () => {
    expect(sign(macosNameCmp("file", "file2"))).toBe(-1);
    expect(sign(macosNameCmp("folder", "folder"))).toBe(0);
  });

  it("treats leading zeros as numerically equal (Rust parity)", () => {
    // The old parseInt-then-length impl reported "007" > "7"; the Rust
    // macos_name_cmp skips leading zeros, so they are equal.
    expect(macosNameCmp("007", "7")).toBe(0);
    expect(macosNameCmp("file007", "file7")).toBe(0);
    expect(sign(macosNameCmp("file08", "file9"))).toBe(-1); // 8 < 9 after zero-strip
  });

  it("orders very long digit runs by sequence, not float (Rust parity)", () => {
    // 20+ digit runs overflow Number; the old parseInt impl collapsed distinct
    // runs to a tie (a non-total order). Sequence comparison stays correct.
    const lo = "10000000000000000001"; // 20 digits
    const hi = "10000000000000000002";
    expect(sign(macosNameCmp(lo, hi))).toBe(-1);
    expect(sign(macosNameCmp(hi, lo))).toBe(1);
    expect(macosNameCmp(lo, lo)).toBe(0);
    // Longer significant run is the larger number.
    expect(sign(macosNameCmp("999999999999999999999", "1000000000000000000000"))).toBe(
      -1
    );
  });
});

describe("macosNameCmp — ordering invariants", () => {
  it("is antisymmetric in sign", () => {
    const pairs: Array<[string, string]> = [
      ["file9", "file10"],
      ["Apple", "banana"],
      ["-a", "1a"],
      ["img2", "img12"],
    ];
    for (const [a, b] of pairs) {
      expect(sign(macosNameCmp(a, b))).toBe(-sign(macosNameCmp(b, a)));
    }
  });

  it("sorts a mixed list into Finder order", () => {
    const input = ["banana", "Apple", "file10", "file2", "_hidden", "2025", "10things"];
    const sorted = [...input].sort(macosNameCmp);
    // symbols first, then numbers (natural), then letters (case-insensitive),
    // with file2 before file10.
    expect(sorted).toEqual([
      "_hidden",
      "10things",
      "2025",
      "Apple",
      "banana",
      "file2",
      "file10",
    ]);
  });
});
