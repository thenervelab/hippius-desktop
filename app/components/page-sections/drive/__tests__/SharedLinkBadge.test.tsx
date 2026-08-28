// SharedLinkBadge source routing: file rows read the file-share origin
// index, folder rows read the folder-share LISTING by `(folderHash,
// pathPrefix)` identity — and each kind must leave the other's source
// alone. The index internals are covered in `useFolderShares.test.ts`;
// here the hooks are mocked per repo idiom.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

import SharedLinkBadge from "../SharedLinkBadge";

const getSharesForMock = vi.fn();
vi.mock("@/app/lib/hooks/useSharedFiles", () => ({
  useSharedFiles: () => ({ getSharesFor: getSharesForMock, isLoading: false }),
}));

const useFolderShareBadgeMock = vi.fn();
vi.mock("@/app/lib/hooks/useFolderShares", () => ({
  useFolderShareBadge: (
    label: string | null | undefined,
    relativePath: string | null | undefined,
    enabled: boolean,
  ) => useFolderShareBadgeMock(label, relativePath, enabled),
}));

const LIVE_FOLDER_ROW = {
  tokenHash: "ab".repeat(32),
  folderHash: "37a8eec1ce19687d",
  pathPrefix: "Trips/Photos",
  displayName: "Photos",
  createdAt: "2026-08-21T10:00:00Z",
  expiresAt: null,
  revokedAt: null,
  resolvable: true,
  shareToken: "tok",
  shareUrl: "https://x#k=y",
  isPrivate: false,
};

describe("SharedLinkBadge", () => {
  beforeEach(() => {
    getSharesForMock.mockReset().mockReturnValue([]);
    useFolderShareBadgeMock.mockReset().mockReturnValue([]);
  });

  it("badges a folder row from the folder-share listing", () => {
    useFolderShareBadgeMock.mockReturnValue([LIVE_FOLDER_ROW]);

    render(
      <SharedLinkBadge
        label="Drive"
        actualName="Photos"
        isFolder
        folderRelativePath="Trips/Photos"
      />,
    );

    expect(screen.getByLabelText(/shared via public link/i)).toBeInTheDocument();
    // The lookup must use the caller-resolved rel-path (the mint's own
    // derivation), never the row's bare basename.
    expect(useFolderShareBadgeMock).toHaveBeenCalledWith("Drive", "Trips/Photos", true);
  });

  it("renders nothing for an unshared folder", () => {
    render(
      <SharedLinkBadge
        label="Drive"
        actualName="Photos"
        isFolder
        folderRelativePath="Trips/Photos"
      />,
    );

    expect(screen.queryByLabelText(/shared/i)).not.toBeInTheDocument();
  });

  it("keeps file rows on the file-share index and skips the folder lookup", () => {
    getSharesForMock.mockReturnValue([
      { expiresAt: null, isPrivate: false },
    ]);

    render(<SharedLinkBadge label="Drive" actualName="doc.pdf" />);

    expect(screen.getByLabelText(/shared via public link/i)).toBeInTheDocument();
    expect(getSharesForMock).toHaveBeenCalledWith("Drive", "doc.pdf");
    // The folder hook is mounted (hooks are unconditional) but disabled.
    expect(useFolderShareBadgeMock).toHaveBeenCalledWith(null, undefined, false);
  });
});
