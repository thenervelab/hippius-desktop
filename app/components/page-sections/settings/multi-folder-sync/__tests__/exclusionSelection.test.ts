import { describe, it, expect } from "vitest";

import { initialSelection } from "../exclusionSelection";

// The browser pre-ticks every file the drive does not exclude. A file the
// user unticked earlier is stored escaped (`[[]` for `[`); Rust returns the
// file name as `display`, and that is what a picker path can equal.
describe("initialSelection", () => {
  const paths = ["Photos [2024]/IMG [1].jpg", "Photos 2/IMG 1.jpg", "notes.txt"];

  it("leaves a literally excluded file unticked and ticks the rest", () => {
    const selected = initialSelection(paths, [
      { pattern: "Photos [[]2024[]]/IMG [[]1[]].jpg", display: "Photos [2024]/IMG [1].jpg" },
    ]);
    expect([...selected]).toEqual(["Photos 2/IMG 1.jpg", "notes.txt"]);
  });

  it("does not untick anything for a typed glob", () => {
    const selected = initialSelection(paths, [{ pattern: "*.tmp", display: "*.tmp" }]);
    expect(selected.size).toBe(3);
  });
});
