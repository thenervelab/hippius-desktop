import { describe, expect, it } from "vitest";
import type { UploadFeedItem } from "@/app/lib/upload-feed/mergeUploadFeed";
import { formatClipDuration, trayRowKind, trayRowSubtitle } from "../trayRowDisplay";

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);

function item(name: string, overrides: Partial<UploadFeedItem> = {}): UploadFeedItem {
  return {
    name,
    actualFileName: name,
    size: 1_700_000,
    createdAt: NOW - 5 * 60 * 1000,
    arionHash: "p",
    arionCid: "c",
    minerIds: [],
    isAssigned: true,
    lastChargedAt: 0,
    isErasureCoded: false,
    mainReqHash: "",
    source: "",
    syncStatus: "synced",
    label: "Drive",
    feedStatus: "completed",
    ...overrides,
  };
}

describe("trayRowKind", () => {
  it("calls a capture a Screenshot or a Recording", () => {
    expect(trayRowKind(item("a.png"), true)).toBe("Screenshot");
    expect(trayRowKind(item("a.mp4"), true)).toBe("Recording");
  });

  it("calls the same file by its type outside the captures", () => {
    expect(trayRowKind(item("a.png"), false)).toBe("Image");
    expect(trayRowKind(item("a.mp4"), false)).toBe("Video");
  });

  it("names other files by type, and a nameless type as File", () => {
    expect(trayRowKind(item("report.pdf"), true)).toBe("PDF");
    expect(trayRowKind(item("sheet.xlsx"), false)).toBe("Spreadsheet");
    expect(trayRowKind(item("README"), false)).toBe("File");
    expect(trayRowKind(item("Photos", { isFolder: true }), false)).toBe("Folder");
  });
});

describe("trayRowSubtitle", () => {
  it("reads kind, size and time for a finished upload", () => {
    expect(trayRowSubtitle(item("a.png"), true, NOW)).toBe("Screenshot · 1.7 MB · 5m ago");
    expect(trayRowSubtitle(item("a.mp4", { size: 20_200_000 }), true, NOW)).toBe(
      "Recording · 20.2 MB · 5m ago",
    );
  });

  it("leaves the time out while a file is on its way, and an unknown size", () => {
    expect(trayRowSubtitle(item("a.png", { feedStatus: "uploading" }), true, NOW)).toBe(
      "Screenshot · 1.7 MB",
    );
    expect(trayRowSubtitle(item("a.png", { size: 0 }), true, NOW)).toBe("Screenshot · 5m ago");
  });
});

describe("formatClipDuration", () => {
  it("reads minutes and seconds, and hours when there are any", () => {
    expect(formatClipDuration(0)).toBe("0:00");
    expect(formatClipDuration(42.4)).toBe("0:42");
    expect(formatClipDuration(59.6)).toBe("1:00");
    expect(formatClipDuration(725)).toBe("12:05");
    expect(formatClipDuration(3729)).toBe("1:02:09");
  });

  it("says nothing for a length it does not have", () => {
    expect(formatClipDuration(null)).toBeNull();
    expect(formatClipDuration(undefined)).toBeNull();
    expect(formatClipDuration(Number.NaN)).toBeNull();
    expect(formatClipDuration(-1)).toBeNull();
  });
});
