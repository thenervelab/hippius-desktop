import { describe, expect, it } from "vitest";

import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import type { FolderShareSummary, ShareSummary } from "@/app/lib/tauri/shares";
import {
  COPY_LINK_LABEL,
  copyLinkLabel,
  existingFileLink,
  existingFolderLink,
  linkFacts,
  linkPathFor,
  UNLOCK_TO_COPY_LINK_LABEL,
} from "../existingLink";

const share = (over: Partial<ShareSummary>): ShareSummary =>
  ({
    shareToken: "tok",
    filename: "Screenshot.png",
    plaintextSize: 10,
    ciphertextSize: 10,
    mimeType: "image/png",
    createdAt: "2026-10-01T10:00:00Z",
    expiresAt: null,
    shareUrl: "https://console.hippius.com/s/tok#k=KEY",
    isPrivate: false,
    folderLabel: "Captures",
    relativePath: "Screenshot.png",
    ...over,
  }) as ShareSummary;

const folderShare = (over: Partial<FolderShareSummary>): FolderShareSummary =>
  ({
    tokenHash: "h1",
    folderHash: "fh",
    pathPrefix: "Trips",
    displayName: "Trips",
    createdAt: "2026-10-01T10:00:00Z",
    expiresAt: null,
    revokedAt: null,
    resolvable: true,
    shareToken: "ftok",
    shareUrl: "https://console.hippius.com/share/folder/ftok#s=SECRET",
    isPrivate: false,
    source: "drive",
    linkFormat: "linkSecret",
    reshareOffered: false,
    ...over,
  }) as FolderShareSummary;

describe("existingFileLink", () => {
  it("has nothing to say for a file with no live link", () => {
    expect(existingFileLink([], false)).toBeNull();
  });

  it("copies the newest link, key included, the one Insights are about", () => {
    const link = existingFileLink(
      [
        share({ shareToken: "old", createdAt: "2026-09-01T10:00:00Z", shareUrl: "https://x/s/old#k=OLD" }),
        share({ shareToken: "new", createdAt: "2026-10-12T10:00:00Z", shareUrl: "https://x/s/new#k=NEW" }),
      ],
      false,
    );
    expect(link).toMatchObject({
      state: "ready",
      url: "https://x/s/new#k=NEW",
      shareToken: "new",
      count: 2,
      kind: "file",
      isPrivate: false,
      needsPassword: false,
      manageRowIds: ["file:old", "file:new"],
    });
    expect(copyLinkLabel(link!)).toBe(COPY_LINK_LABEL);
  });

  it("says a password link needs its password", () => {
    const link = existingFileLink([share({ isPrivate: true, shareUrl: "https://x/s/t#p=WRAP" })], false);
    expect(link).toMatchObject({ state: "ready", needsPassword: true, isPrivate: true });
  });

  it("waits on an unlock while Hippius is locked and the key is not here", () => {
    const link = existingFileLink([share({ shareUrl: null })], true);
    expect(link).toMatchObject({ state: "locked", url: null, isPrivate: null });
    expect(copyLinkLabel(link!)).toBe(UNLOCK_TO_COPY_LINK_LABEL);
  });

  it("says the key is elsewhere when unlocked and still missing", () => {
    const link = existingFileLink([share({ shareUrl: null })], false);
    expect(link).toMatchObject({ state: "elsewhere", url: null, isPrivate: null });
    expect(copyLinkLabel(link!)).toBe(COPY_LINK_LABEL);
  });

  it("copies a link that is here even while locked", () => {
    expect(existingFileLink([share({})], true)?.state).toBe("ready");
  });

  it("carries views only when the listing has them", () => {
    expect(existingFileLink([share({})], false)).not.toHaveProperty("views");
    expect(existingFileLink([share({ views: 4 })], false)?.views).toBe(4);
  });
});

describe("existingFolderLink", () => {
  it("copies the newest live folder link", () => {
    const link = existingFolderLink(
      [
        folderShare({ tokenHash: "a", createdAt: "2026-09-01T00:00:00Z", shareUrl: "https://x/f/a#s=A" }),
        folderShare({ tokenHash: "b", createdAt: "2026-10-01T00:00:00Z", shareUrl: "https://x/f/b#s=B" }),
      ],
      false,
    );
    expect(link).toMatchObject({
      state: "ready",
      url: "https://x/f/b#s=B",
      kind: "folder",
      shareToken: null,
      manageRowIds: ["folder:a", "folder:b"],
    });
  });

  it("keeps an unknown password state unknown for a folder link made elsewhere", () => {
    const link = existingFolderLink([folderShare({ shareUrl: null, shareToken: null, isPrivate: null, resolvable: false })], false);
    expect(link).toMatchObject({ state: "elsewhere", isPrivate: null });
  });
});

describe("linkFacts", () => {
  // Local times, so "today" and "tomorrow" hold in any time zone.
  const now = new Date(2026, 9, 31, 12);
  const at = (day: number, hour: number) => new Date(2026, 9, day, hour).toISOString();

  it("states the lifetime either way, the password and the views", () => {
    const link = existingFileLink([share({ createdAt: at(31, 9), views: 1 })], false)!;
    expect(linkFacts(link, now)).toEqual(["Created today", "Never expires", "No password", "1 view"]);
  });

  it("names the expiry and a password", () => {
    const link = existingFileLink(
      [share({ createdAt: at(30, 9), expiresAt: at(32, 9), isPrivate: true, views: 3 })],
      false,
    )!;
    expect(linkFacts(link, now)).toEqual(["Created yesterday", "Expires tomorrow", "Password protected", "3 views"]);
  });

  it("says nothing about a password this computer cannot see", () => {
    const link = existingFileLink([share({ shareUrl: null })], false)!;
    expect(linkFacts(link, now).join(" ")).not.toMatch(/password/i);
  });
});

describe("linkPathFor", () => {
  it("resolves a file the way its link icon does", () => {
    const file = { name: "a.png", actualFileName: "a.png", isFolder: false } as FormattedUserFile;
    expect(linkPathFor(file, "Trips")).toBe("Trips/a.png");
    expect(linkPathFor({ ...file, actualFileName: "Trips/a.png" }, "Trips")).toBe("Trips/a.png");
    expect(linkPathFor(file, "")).toBe("a.png");
  });

  it("resolves a folder the way its Share via link does", () => {
    const folder = { name: "Photos", actualFileName: "Photos", isFolder: true } as FormattedUserFile;
    expect(linkPathFor(folder, "Trips")).toBe("Trips/Photos");
  });
});
