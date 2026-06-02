import { describe, expect, it } from "vitest";
import { groupUploadFeed } from "../groupUploadFeed";
import type { UploadFeedItem } from "../mergeUploadFeed";

// Fixed reference "now": Wednesday, 2026-06-17 12:00 local time.
const NOW = new Date(2026, 5, 17, 12, 0, 0).getTime();

function item(
  name: string,
  createdAt: number,
  over: Partial<UploadFeedItem> = {},
): UploadFeedItem {
  return {
    name,
    actualFileName: name,
    createdAt,
    arionHash: name,
    arionCid: "",
    minerIds: [],
    isAssigned: true,
    lastChargedAt: 0,
    isErasureCoded: false,
    mainReqHash: "",
    label: "Docs",
    syncStatus: "synced",
    feedStatus: "completed",
    ...over,
  };
}

const at = (y: number, m: number, d: number, h = 12) =>
  new Date(y, m, d, h).getTime();

describe("groupUploadFeed", () => {
  it("returns no groups for an empty feed", () => {
    expect(groupUploadFeed([], NOW)).toEqual([]);
  });

  it("buckets items into the expected date headings, newest first", () => {
    const feed = [
      item("today.png", at(2026, 5, 17, 9)),
      item("yesterday.png", at(2026, 5, 16)),
      item("thisweek.png", at(2026, 5, 15)), // Mon of this week
      item("lastweek.png", at(2026, 5, 10)), // prior week
      item("thismonth.png", at(2026, 5, 3)), // earlier this month
      item("older.png", at(2026, 2, 1)), // months ago
    ];
    const groups = groupUploadFeed(feed, NOW);
    expect(groups.map((g) => g.label)).toEqual([
      "Today",
      "Yesterday",
      "This Week",
      "Last Week",
      "This Month",
      "Older",
    ]);
    expect(groups.map((g) => g.items[0].name)).toEqual([
      "today.png",
      "yesterday.png",
      "thisweek.png",
      "lastweek.png",
      "thismonth.png",
      "older.png",
    ]);
  });

  it("omits empty groups", () => {
    const groups = groupUploadFeed(
      [item("a", at(2026, 5, 17)), item("b", at(2026, 2, 1))],
      NOW,
    );
    expect(groups.map((g) => g.label)).toEqual(["Today", "Older"]);
  });

  it("places live uploading/failed rows (createdAt=now) in Today, in feed order", () => {
    const feed = [
      item("uploading.png", NOW, { feedStatus: "uploading", syncStatus: "uploading" }),
      item("failed.png", NOW, { feedStatus: "failed", syncStatus: "failed" }),
      item("done-today.png", at(2026, 5, 17, 8)),
      item("done-older.png", at(2026, 2, 1)),
    ];
    const groups = groupUploadFeed(feed, NOW);
    expect(groups[0].label).toBe("Today");
    // Feed order is preserved within the bucket: active rows lead.
    expect(groups[0].items.map((i) => i.name)).toEqual([
      "uploading.png",
      "failed.png",
      "done-today.png",
    ]);
    expect(groups[1].label).toBe("Older");
  });

  it("preserves input order within a bucket", () => {
    const feed = [
      item("first.png", at(2026, 5, 17, 10)),
      item("second.png", at(2026, 5, 17, 2)),
    ];
    const groups = groupUploadFeed(feed, NOW);
    expect(groups[0].items.map((i) => i.name)).toEqual([
      "first.png",
      "second.png",
    ]);
  });

  it("buckets across a month boundary (weekday-independent)", () => {
    // First of the month → "Yesterday" is the last day of the previous month.
    const firstOfMonth = new Date(2026, 5, 1, 12).getTime();
    const groups = groupUploadFeed(
      [
        item("today.png", at(2026, 5, 1, 9)),
        item("prev-month-eve.png", at(2026, 4, 31)), // May 31 = yesterday
      ],
      firstOfMonth,
    );
    const byLabel = Object.fromEntries(
      groups.map((g) => [g.label, g.items.map((i) => i.name)]),
    );
    expect(byLabel["Today"]).toEqual(["today.png"]);
    expect(byLabel["Yesterday"]).toEqual(["prev-month-eve.png"]);
  });
});
