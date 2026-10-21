import { describe, it, expect } from "vitest";

import type { InsightsViewer } from "@/app/lib/tauri/shareInsights";
import {
  ANONYMOUS,
  AVATAR_COLORS,
  TABS_THRESHOLD,
  averageWatchMs,
  avatarFor,
  biggestDrop,
  estimateDurationMs,
  formatAgo,
  formatMomentAt,
  headerLine,
  initials,
  usesTabs,
  viewerName,
} from "../insightsView";

const viewer = (over: Partial<InsightsViewer>): InsightsViewer => ({
  viewerId: "v",
  name: null,
  visits: 1,
  watchedMs: 0,
  completion: null,
  lastViewedAt: null,
  comments: 0,
  reactions: 0,
  ...over,
});

describe("biggestDrop", () => {
  it("finds where the curve falls furthest, at its steepest step", () => {
    // 100 points, a slow slide, then 14 points lost between 49% and 52%.
    const r = Array.from({ length: 100 }, (_, i) => (i < 50 ? 100 - i * 0.4 : 66 - (i - 50) * 0.3));
    r[50] = 75;
    r[51] = 68;
    const drop = biggestDrop(r);
    expect(drop).not.toBeNull();
    // The steepest single step is 75 -> 68, into point 51.
    expect(drop!.at).toBeCloseTo(51 / 99, 5);
    expect(drop!.drop).toBeGreaterThan(10);
  });

  it("counts one drop split across two points as one", () => {
    // A single 9-point step at 20%, and a 13-point drop split 7 + 6 at 50%.
    const r: number[] = [];
    let v = 100;
    for (let i = 0; i < 100; i++) {
      if (i === 20) v -= 9;
      if (i === 50) v -= 7;
      if (i === 51) v -= 6;
      r.push(v);
      v -= 0.1;
    }
    // Step by step, 20% is the biggest; over the window, 50% is.
    expect(biggestDrop(r)!.at).toBeCloseTo(50 / 99, 5);
  });

  it("calls a flat curve no drop", () => {
    expect(biggestDrop(Array.from({ length: 100 }, () => 80))).toBeNull();
    expect(biggestDrop([100, 99.5, 99])).toBeNull();
  });

  it("needs at least two points", () => {
    expect(biggestDrop([])).toBeNull();
    expect(biggestDrop([100])).toBeNull();
  });
});

describe("formatMomentAt", () => {
  it("reads a time when the length is known, else how far in", () => {
    expect(formatMomentAt(0.5, 250_000)).toBe("2:05");
    expect(formatMomentAt(0.5, null)).toBe("50% in");
  });
});

describe("estimateDurationMs", () => {
  it("takes the length from the single visit that saw the most of it", () => {
    const vs = [
      viewer({ visits: 1, watchedMs: 126_000, completion: 0.5 }),
      viewer({ visits: 1, watchedMs: 240_000, completion: 0.952 }),
      // Two visits: their watched time is summed, so it says nothing exact.
      viewer({ visits: 2, watchedMs: 900_000, completion: 1 }),
    ];
    expect(estimateDurationMs(vs)).toBe(252_000);
  });

  it("is never shorter than the latest comment", () => {
    const vs = [viewer({ visits: 1, watchedMs: 50_000, completion: 0.5 })];
    expect(estimateDurationMs(vs, [{ atMs: 130_000 }, { atMs: null }])).toBe(130_000);
  });

  it("says nothing without a single visit that covered enough of it", () => {
    expect(estimateDurationMs([viewer({ visits: 1, watchedMs: 5_000, completion: 0.05 })])).toBeNull();
    expect(estimateDurationMs([viewer({ visits: 1, watchedMs: 0, completion: null })])).toBeNull();
    expect(estimateDurationMs([])).toBeNull();
  });
});

describe("averageWatchMs", () => {
  it("is everything watched over every view", () => {
    const vs = [viewer({ watchedMs: 60_000, completion: 0.5 }), viewer({ watchedMs: 30_000, completion: 0.2 })];
    expect(averageWatchMs(vs, 3)).toBe(30_000);
  });

  it("is nothing for a picture or before any view", () => {
    expect(averageWatchMs([viewer({ watchedMs: 0, completion: null })], 4)).toBeNull();
    expect(averageWatchMs([], 0)).toBeNull();
  });
});

describe("the avatar palette", () => {
  it("gives a name the same colour every time, from the fixed palette", () => {
    const a = avatarFor("Maya Chen");
    expect(a).toEqual(avatarFor("Maya Chen"));
    expect(AVATAR_COLORS).toContain(a!.color);
    // Surrounding spaces are not part of the name.
    expect(avatarFor("  Maya Chen ")).toEqual(a);
  });

  it("spreads names over more than one colour", () => {
    const names = ["Maya Chen", "Daniel Okafor", "Sofia Alvarez", "Priya Raman", "Lukas Becker", "Grace Liu", "Elena Park"];
    expect(new Set(names.map((n) => avatarFor(n)!.color)).size).toBeGreaterThan(2);
  });

  it("gives someone without a name the neutral avatar", () => {
    expect(avatarFor(null)).toBeNull();
    expect(avatarFor("   ")).toBeNull();
  });

  it("uses the first letters of the first and last word", () => {
    expect(initials("Maya Chen")).toBe("MC");
    expect(initials("Maya")).toBe("M");
    expect(initials("ana maría de la cruz")).toBe("AC");
    // A letter outside the BMP stays whole.
    expect(initials("𝒜da Lovelace")).toBe("𝒜L");
  });

  it("calls someone without a name an anonymous viewer", () => {
    expect(viewerName(null)).toBe(ANONYMOUS);
    expect(viewerName(" ")).toBe(ANONYMOUS);
    expect(viewerName("Ada")).toBe("Ada");
  });
});

describe("usesTabs", () => {
  it("splits into tabs only past ten viewers or comments", () => {
    expect(TABS_THRESHOLD).toBe(10);
    expect(usesTabs(10, 10)).toBe(false);
    expect(usesTabs(11, 0)).toBe(true);
    expect(usesTabs(0, 11)).toBe(true);
  });
});

describe("headerLine and formatAgo", () => {
  const now = Date.parse("2026-10-21T12:00:00Z");

  it("reads Shared <date> · <length> · link on, leaving out what is unknown", () => {
    expect(
      headerLine({ sharedAt: "2026-10-20T10:00:00Z", durationMs: 252_000, expiresAt: null, now }),
    ).toBe("Shared Oct 20 · 4:12 · link on");
    expect(headerLine({ sharedAt: null, durationMs: null, expiresAt: undefined, now })).toBe("");
    expect(headerLine({ sharedAt: null, durationMs: null, expiresAt: "2026-10-21T11:00:00Z", now })).toBe(
      "link expired",
    );
    expect(headerLine({ sharedAt: "2025-03-02T10:00:00Z", durationMs: null, expiresAt: undefined, now })).toBe(
      "Shared Mar 2, 2025",
    );
  });

  it("shortens how long ago", () => {
    expect(formatAgo("2026-10-21T11:59:40Z", now)).toBe("now");
    expect(formatAgo("2026-10-21T11:55:00Z", now)).toBe("5m");
    expect(formatAgo("2026-10-21T10:00:00Z", now)).toBe("2h");
    expect(formatAgo("2026-10-18T12:00:00Z", now)).toBe("3d");
    expect(formatAgo("2026-10-01T12:00:00Z", now)).toBe("Oct 1");
    expect(formatAgo("not a date", now)).toBe("");
  });
});
