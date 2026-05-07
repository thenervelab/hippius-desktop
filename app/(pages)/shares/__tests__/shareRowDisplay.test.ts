import { describe, expect, it } from "vitest";
import { pickHistoryRowDisplay } from "../shareRowDisplay";

describe("pickHistoryRowDisplay", () => {
  it("returns the supplied filename when present", () => {
    expect(pickHistoryRowDisplay("report.pdf")).toEqual({
      text: "report.pdf",
      isPlaceholder: false,
    });
  });

  it("returns the console-origin placeholder when filename is null", () => {
    // History rows captured by the diff path on a device that never
    // had the keystore entry surface with `filename: null` — the same
    // marker the active-list helper handles via `shareUrl === null`.
    expect(pickHistoryRowDisplay(null)).toEqual({
      text: "Created from the console",
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
