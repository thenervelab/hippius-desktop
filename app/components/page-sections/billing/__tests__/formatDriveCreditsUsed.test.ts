import { describe, expect, it } from "vitest";

import { formatDriveCreditsUsed } from "../formatDriveCreditsUsed";

describe("formatDriveCreditsUsed", () => {
  it("keeps a day of Drive storage as milli-HIP, not 0.00 (H-083)", () => {
    expect(formatDriveCreditsUsed(0.0038)).toBe("0.0038");
    expect(formatDriveCreditsUsed(0.0038)).not.toBe("0.00");
    expect(formatDriveCreditsUsed(0.0038)).not.toBe("0");
  });

  it("uses two decimals for ordinary HIP amounts", () => {
    expect(formatDriveCreditsUsed(0)).toBe("0.00");
    expect(formatDriveCreditsUsed(1.23)).toBe("1.23");
  });
});
