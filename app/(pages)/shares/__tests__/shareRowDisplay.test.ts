import { describe, expect, it } from "vitest";
import { pickHistoryRowDisplay, pickShareRowDisplay } from "../shareRowDisplay";
import type { ShareSummary } from "@/app/lib/tauri/shares";

const baseRow: ShareSummary = {
  shareToken: "tok",
  filename: "report.pdf",
  plaintextSize: 1024,
  ciphertextSize: 1100,
  mimeType: "application/pdf",
  createdAt: "2026-04-30T10:00:00Z",
  expiresAt: "2026-05-07T10:00:00Z",
  shareUrl: "https://share.example/abc#k=def",
  folderLabel: "default",
  relativePath: "report.pdf",
};

describe("pickShareRowDisplay", () => {
  it("returns the row's filename when shareUrl is present", () => {
    expect(pickShareRowDisplay(baseRow)).toEqual({
      text: "report.pdf",
      isPlaceholder: false,
    });
  });

  it("returns the cross-device placeholder when shareUrl is null", () => {
    expect(pickShareRowDisplay({ ...baseRow, shareUrl: null })).toEqual({
      text: "Shared from another device",
      isPlaceholder: true,
    });
  });

  it("returns the literal filename when shareUrl is non-null, even if filename is the marker", () => {
    // The helper keys solely on `shareUrl` — `<unknown>` is hcfs-client's
    // marker for "key forgotten", but it only surfaces alongside `shareUrl: null`.
    // If a future wire-format change ever sent `<unknown>` with a real URL,
    // the helper would render it verbatim. Pin that contract.
    expect(
      pickShareRowDisplay({ ...baseRow, filename: "<unknown>", shareUrl: "https://share.example/abc#k=def" }),
    ).toEqual({ text: "<unknown>", isPlaceholder: false });
  });
});

describe("pickHistoryRowDisplay", () => {
  it("returns the supplied filename when present", () => {
    expect(pickHistoryRowDisplay("report.pdf")).toEqual({
      text: "report.pdf",
      isPlaceholder: false,
    });
  });

  it("returns the cross-device placeholder when filename is null", () => {
    // History rows captured by the diff path on a device that never
    // had the keystore entry surface with `filename: null` — the same
    // marker the active-list helper handles via `shareUrl === null`.
    expect(pickHistoryRowDisplay(null)).toEqual({
      text: "Shared from another device",
      isPlaceholder: true,
    });
  });

  it("returns a literal `<unknown>` filename verbatim", () => {
    // Defense in depth: an upstream wire change could surface the
    // marker string with a non-null filename column. Pin the
    // null-only branch so we don't silently start italicising it.
    expect(pickHistoryRowDisplay("<unknown>")).toEqual({
      text: "<unknown>",
      isPlaceholder: false,
    });
  });
});
