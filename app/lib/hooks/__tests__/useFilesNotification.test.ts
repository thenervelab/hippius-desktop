// @vitest-environment node
import { describe, it, expect, vi } from "vitest";

// Mock Tauri APIs (not available in test environment)
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import { buildSyncDescription } from "../useFilesNotification";
import { parseFileDetails } from "@/components/page-sections/notifications/NotificationDetailView";

describe("buildSyncDescription", () => {
  it("describes a single uploaded file", () => {
    expect(
      buildSyncDescription({ uploaded: 1, downloaded: 0, deletedLocally: 0, deletedRemotely: 0 })
    ).toBe("1 file uploaded.");
  });

  it("pluralizes multiple uploaded files", () => {
    expect(
      buildSyncDescription({ uploaded: 5, downloaded: 0, deletedLocally: 0, deletedRemotely: 0 })
    ).toBe("5 files uploaded.");
  });

  it("describes a single downloaded file", () => {
    expect(
      buildSyncDescription({ uploaded: 0, downloaded: 1, deletedLocally: 0, deletedRemotely: 0 })
    ).toBe("1 file downloaded.");
  });

  it("combines uploads and downloads", () => {
    expect(
      buildSyncDescription({ uploaded: 3, downloaded: 2, deletedLocally: 0, deletedRemotely: 0 })
    ).toBe("3 files uploaded, 2 files downloaded.");
  });

  it("includes all action types", () => {
    expect(
      buildSyncDescription({ uploaded: 1, downloaded: 2, deletedLocally: 3, deletedRemotely: 1 })
    ).toBe("1 file uploaded, 2 files downloaded, 3 files deleted locally, 1 file deleted remotely.");
  });

  it("omits zero-count actions", () => {
    expect(
      buildSyncDescription({ uploaded: 0, downloaded: 0, deletedLocally: 2, deletedRemotely: 0 })
    ).toBe("2 files deleted locally.");
  });

  it("handles all zeros gracefully", () => {
    expect(
      buildSyncDescription({ uploaded: 0, downloaded: 0, deletedLocally: 0, deletedRemotely: 0 })
    ).toBe(".");
  });
});

describe("parseFileDetails", () => {
  it("returns empty array for non-Files type", () => {
    const json = JSON.stringify([{ fileName: "test.txt", totalBytes: 100, action: "upload" }]);
    expect(parseFileDetails("Credits", json)).toEqual([]);
  });

  it("returns empty array for empty releaseNotes", () => {
    expect(parseFileDetails("Files", "")).toEqual([]);
  });

  it("parses valid JSON file details", () => {
    const files = [
      { fileName: "photo.png", totalBytes: 5060000, action: "upload" },
      { fileName: "doc.pdf", totalBytes: 120000, action: "download" },
    ];
    expect(parseFileDetails("Files", JSON.stringify(files))).toEqual(files);
  });

  it("returns empty array for non-JSON releaseNotes", () => {
    expect(parseFileDetails("Files", "Some regular release notes text")).toEqual([]);
  });

  it("returns empty array for JSON that is not an array", () => {
    expect(parseFileDetails("Files", JSON.stringify({ key: "value" }))).toEqual([]);
  });

  it("handles deleted file actions", () => {
    const files = [
      { fileName: "old.txt", totalBytes: 500, action: "local_delete" },
      { fileName: "remote.txt", totalBytes: 0, action: "remote_delete" },
    ];
    const result = parseFileDetails("Files", JSON.stringify(files));
    expect(result).toHaveLength(2);
    expect(result[0].action).toBe("local_delete");
    expect(result[1].action).toBe("remote_delete");
  });
});
