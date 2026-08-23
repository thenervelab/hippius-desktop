import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSharedBadgeTooltip } from "../sharedBadgeTooltip";
import type { ShareSummary } from "@/app/lib/tauri/shares";

const NOW = new Date("2026-04-30T12:00:00Z").getTime();

const row = (overrides: Partial<ShareSummary> = {}): ShareSummary => ({
  shareToken: "tok",
  filename: "f.pdf",
  plaintextSize: 0,
  ciphertextSize: 0,
  mimeType: "application/pdf",
  createdAt: "2026-04-30T10:00:00Z",
  expiresAt: "2026-05-04T12:00:00Z",
  shareUrl: "https://x#k=y",
  isPrivate: false,
  folderLabel: "default",
  relativePath: "f.pdf",
  ...overrides,
});

describe("buildSharedBadgeTooltip", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => vi.useRealTimers());

  it("returns null for empty input (caller should not render badge)", () => {
    expect(buildSharedBadgeTooltip([])).toBeNull();
  });

  it("formats a single share with relative + absolute expiry", () => {
    const lines = buildSharedBadgeTooltip([row()]);
    expect(lines).toEqual([
      "Shared via public link · expires in 4d",
      // The exact absolute string is locale-dependent; assert the
      // shape rather than the literal output.
      expect.stringMatching(/^Expires .+/),
    ]);
  });

  it("formats multiple shares with count + soonest-expiry only", () => {
    const lines = buildSharedBadgeTooltip([
      row({ shareToken: "a", expiresAt: "2026-04-30T15:00:00Z" }),
      row({ shareToken: "b", expiresAt: "2026-05-06T12:00:00Z" }),
    ]);
    expect(lines).toEqual([
      "Shared via 2 links · soonest expires in 3h",
    ]);
  });

  it("drops the public/private wording when protection is unknown", () => {
    // A folder share minted on another device has no local secret to
    // inspect (`isPrivate: null`) — the tooltip must not guess "public"
    // for a link that may well be password-protected.
    const lines = buildSharedBadgeTooltip([
      { expiresAt: "2026-05-04T12:00:00Z", isPrivate: null },
    ]);
    expect(lines?.[0]).toBe("Shared via link · expires in 4d");
  });
});
