import { describe, it, expect } from "vitest";

import type { InsightsViewer } from "@/app/lib/tauri/shareInsights";
import {
  ANONYMOUS,
  AVATAR_COLORS,
  REPLIES_SHOWN,
  averageWatchMs,
  avatarFor,
  biggestDrop,
  emptyInsightsCopy,
  estimateDurationMs,
  formatAgo,
  formatMomentAt,
  headerLine,
  defaultInsightsTab,
  initials,
  mentionSegments,
  sortThreads,
  threadsMentioningYou,
  switchOffLine,
  switchPills,
  tabLabel,
  viewerName,
  visibleReplies,
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

  it("picks the same colour as the console for the same name", () => {
    // The console's own results for these names: a person keeps one colour in both apps.
    expect(avatarFor("Maya Chen")!.color).toBe("#D9486F");
    expect(avatarFor("Daniel Okafor")!.color).toBe("#8B5CF6");
    expect(avatarFor("Sofia Alvarez")!.color).toBe("#E8743B");
    expect(avatarFor("Priya Raman")!.color).toBe("#0E8FA8");
    expect(avatarFor("Grace Liu")!.color).toBe("#D9486F");
    // Case does not change it.
    expect(avatarFor("maya chen")!.color).toBe("#D9486F");
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

describe("the tabs", () => {
  it("opens on Comments when there are any, otherwise Viewers", () => {
    expect(defaultInsightsTab(3)).toBe("comments");
    expect(defaultInsightsTab(0)).toBe("viewers");
  });
  it("puts the count in the label once it is known", () => {
    expect(tabLabel("Comments", 20)).toBe("Comments (20)");
    expect(tabLabel("Viewers", 0)).toBe("Viewers (0)");
    expect(tabLabel("Viewers", null)).toBe("Viewers");
  });
});

describe("sortThreads", () => {
  const threads = [
    { id: "b", createdAt: "2026-10-13T10:00:00Z" },
    { id: "late", createdAt: "2026-10-14T10:00:00Z" },
    { id: "bad", createdAt: "not a date" },
    { id: "a", createdAt: "2026-10-13T10:00:00Z" },
    { id: "early", createdAt: "2026-10-01T10:00:00Z" },
  ];
  it("puts the newest first, a time that does not parse last, and keeps ties in the server's order", () => {
    expect(sortThreads(threads, "newest").map((t) => t.id)).toEqual(["late", "b", "a", "early", "bad"]);
  });
  it("puts the oldest first the other way round", () => {
    expect(sortThreads(threads, "oldest").map((t) => t.id)).toEqual(["bad", "early", "b", "a", "late"]);
  });
  it("leaves the list it was given alone", () => {
    const copy = [...threads];
    sortThreads(threads, "newest");
    expect(threads).toEqual(copy);
  });
});

describe("visibleReplies", () => {
  it("shows the first two and folds the rest until opened", () => {
    expect(REPLIES_SHOWN).toBe(2);
    expect(visibleReplies([1, 2, 3, 4, 5], false)).toEqual({ shown: [1, 2], hidden: 3 });
    expect(visibleReplies([1, 2, 3, 4, 5], true)).toEqual({ shown: [1, 2, 3, 4, 5], hidden: 0 });
    expect(visibleReplies([1, 2], false)).toEqual({ shown: [1, 2], hidden: 0 });
    expect(visibleReplies([], false)).toEqual({ shown: [], hidden: 0 });
  });
});

describe("the switches' status row", () => {
  const all = { insights: true, comments: true, reactions: true };
  const on = { insights: true, comments: false, reactions: true };
  it("draws a pill per switch the server takes, on or off, in order", () => {
    expect(switchPills({ offered: all, on })).toEqual([
      { key: "insights", label: "Insights", on: true },
      { key: "comments", label: "Comments", on: false },
      { key: "reactions", label: "Reactions", on: true },
    ]);
    expect(switchPills({ offered: { insights: true, comments: false, reactions: false }, on }).map((p) => p.key)).toEqual([
      "insights",
    ]);
  });
  it("draws none when Link settings would draw no switches", () => {
    expect(switchPills(null)).toEqual([]);
    expect(switchPills({ offered: { insights: false, comments: true, reactions: true }, on })).toEqual([]);
  });
  it("gives a tab its one line only while its switch is off", () => {
    expect(switchOffLine({ offered: all, on }, "comments")).toBe("Comments are off, so viewers can't add new ones.");
    expect(switchOffLine({ offered: all, on }, "insights")).toBeNull();
    expect(switchOffLine({ offered: all, on: { ...on, insights: false } }, "insights")).toMatch(/Insights are off/);
    expect(switchOffLine({ offered: all, on: { ...on, reactions: false } }, "reactions")).toMatch(/Reactions are off/);
    expect(switchOffLine({ offered: { ...all, comments: false }, on }, "comments")).toBeNull();
    expect(switchOffLine(null, "comments")).toBeNull();
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

describe("emptyInsightsCopy", () => {
  it("mentions comments and reactions only where the server has them", () => {
    expect(emptyInsightsCopy({ notCounting: false, commentsEnabled: true }).body).toMatch(/comments and reactions/);
    expect(emptyInsightsCopy({ notCounting: false, commentsEnabled: false }).body).not.toMatch(/comments/);
  });
  it("says a link that is not counting views is not, rather than that nobody came", () => {
    const copy = emptyInsightsCopy({ notCounting: true, commentsEnabled: false });
    expect(copy.title).toBe("Not counting views");
    expect(copy.body).not.toMatch(/Nobody/);
  });
});

describe("mentionSegments", () => {
  const owner = { kind: "owner" as const, name: "Owner", label: "Owner", you: true };
  const grace = { kind: "commenter" as const, name: "Grace Liu", label: "Grace Liu", you: false };

  it("cuts the text into runs and mentions, in order", () => {
    expect(mentionSegments("@Owner thanks, and @Grace Liu see 0:42", [owner, grace])).toEqual([
      { kind: "mention", mention: owner },
      { kind: "text", text: " thanks, and " },
      { kind: "mention", mention: grace },
      { kind: "text", text: " see 0:42" },
    ]);
  });

  it("matches whole words only and skips a mention not in the text", () => {
    expect(mentionSegments("mail me@Owner.com or @Owners", [owner])).toEqual([
      { kind: "text", text: "mail me@Owner.com or @Owners" },
    ]);
    expect(mentionSegments("hi @Owner", [grace, owner])).toEqual([
      { kind: "text", text: "hi " },
      { kind: "mention", mention: owner },
    ]);
  });

  it("is the text as it is without mentions", () => {
    expect(mentionSegments("@Owner hi", undefined)).toEqual([{ kind: "text", text: "@Owner hi" }]);
  });

  it("finds threads that mention the owner in the comment or a reply", () => {
    const threads = [
      { id: "a", mentionsYou: true },
      { id: "b", replies: [{ mentionsYou: true }] },
      { id: "c", replies: [{ mentionsYou: false }] },
      { id: "d" },
    ];
    expect(threadsMentioningYou(threads).map((t) => t.id)).toEqual(["a", "b"]);
  });
});

