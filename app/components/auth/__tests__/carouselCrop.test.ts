import { describe, it, expect } from "vitest";
import { computeCropLockScale } from "../carouselCrop";

describe("computeCropLockScale", () => {
  it("returns 1 when base is null", () => {
    expect(computeCropLockScale(null, { width: 1200, height: 900 })).toBe(1);
  });

  it("returns 1 for zero sizes", () => {
    expect(
      computeCropLockScale(
        { width: 0, height: 900 },
        { width: 1200, height: 900 },
      ),
    ).toBe(1);
    expect(
      computeCropLockScale(
        { width: 1200, height: 900 },
        { width: 0, height: 900 },
      ),
    ).toBe(1);
  });

  it("returns 1 when sizes match", () => {
    expect(
      computeCropLockScale(
        { width: 1200, height: 900 },
        { width: 1200, height: 900 },
      ),
    ).toBe(1);
  });

  it("grows when width increases faster than height", () => {
    const scale = computeCropLockScale(
      { width: 1200, height: 900 },
      { width: 1400, height: 900 },
    );
    expect(scale).toBeGreaterThan(1);
  });

  it("shrinks when height increases faster than width", () => {
    const scale = computeCropLockScale(
      { width: 1200, height: 900 },
      { width: 1200, height: 1100 },
    );
    expect(scale).toBeLessThan(1);
  });
});
