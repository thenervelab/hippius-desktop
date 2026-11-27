import { describe, expect, it } from "vitest";

import { isFolderLinkPaused, pausedTooltip } from "@/app/lib/utils/folderLinkPause";

describe("folder link pause", () => {
  it("is paused only when the server said so, and never once revoked", () => {
    expect(isFolderLinkPaused({ revokedAt: null, paused: true })).toBe(true);
    expect(isFolderLinkPaused({ revokedAt: null, held: true })).toBe(true);
    expect(isFolderLinkPaused({ revokedAt: null, paused: false, held: false })).toBe(false);
    expect(isFolderLinkPaused({ revokedAt: null })).toBe(false);
    expect(isFolderLinkPaused({ revokedAt: "2026-11-02T10:00:00Z", paused: true, held: true })).toBe(false);
  });

  it("says why, in the console's words", () => {
    expect(pausedTooltip({})).toBe("Off while its folder is in Trash");
    expect(pausedTooltip({ held: true })).toBe("Off until you revoke it: its folder left Trash another way");
  });
});
