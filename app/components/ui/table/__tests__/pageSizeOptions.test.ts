import { describe, expect, it } from "vitest";

import { buildPageSizeOptions } from "@/components/ui/table/pageSizeOptions";

const PRESETS = [10, 25, 50, 100];

describe("buildPageSizeOptions", () => {
  it("keeps the starting size available after switching away from it", () => {
    // Drive opens at 20, user picks 25. 20 must survive, or there is no way
    // back to the size the table started on.
    expect(
      buildPageSizeOptions({ options: PRESETS, current: 25, initial: 20 }),
    ).toEqual([10, 20, 25, 50, 100]);
  });

  it("offers the size actually in use when it is not a preset", () => {
    expect(
      buildPageSizeOptions({ options: PRESETS, current: 20, initial: 20 }),
    ).toEqual([10, 20, 25, 50, 100]);
  });

  it("keeps both a non-preset start and a non-preset current", () => {
    expect(
      buildPageSizeOptions({ options: PRESETS, current: 15, initial: 20 }),
    ).toEqual([10, 15, 20, 25, 50, 100]);
  });

  it("adds nothing when both are already presets", () => {
    expect(
      buildPageSizeOptions({ options: PRESETS, current: 50, initial: 10 }),
    ).toEqual(PRESETS);
  });

  it("returns the presets unchanged when no sizes are given", () => {
    expect(buildPageSizeOptions({ options: PRESETS })).toEqual(PRESETS);
  });

  it("ignores unusable sizes rather than rendering a 0/PAGE entry", () => {
    expect(
      buildPageSizeOptions({ options: PRESETS, current: 0, initial: NaN }),
    ).toEqual(PRESETS);
  });

  it("orders an added size among the presets, not at the end", () => {
    expect(
      buildPageSizeOptions({ options: PRESETS, current: 75, initial: 20 }),
    ).toEqual([10, 20, 25, 50, 75, 100]);
  });
});
