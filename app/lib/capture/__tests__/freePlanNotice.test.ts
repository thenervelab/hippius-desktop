import { describe, expect, it } from "vitest";
import { freePlanBarLine, freeRecordingsUsed } from "../freePlanNotice";

const NOTICE = { used: 3, limit: 25, maxRecordingMins: 5 };

describe("free plan notice", () => {
  it("says the watermark, the length limit and the count", () => {
    expect(freePlanBarLine(NOTICE, true)).toBe(
      "Free plan: captures carry a small Hippius watermark and recordings stop at 5 minutes. 3 of 25 free recordings used.",
    );
    expect(freeRecordingsUsed(NOTICE)).toBe("3 of 25 free recordings used");
  });

  it("leaves out a count it does not know", () => {
    expect(freeRecordingsUsed({ ...NOTICE, used: null })).toBeNull();
    expect(freePlanBarLine({ ...NOTICE, used: null }, true)).toBe(
      "Free plan: captures carry a small Hippius watermark and recordings stop at 5 minutes.",
    );
  });

  it("says nothing about recordings where this computer cannot record", () => {
    expect(freePlanBarLine(NOTICE, false)).toBe("Free plan: captures carry a small Hippius watermark.");
  });
});
