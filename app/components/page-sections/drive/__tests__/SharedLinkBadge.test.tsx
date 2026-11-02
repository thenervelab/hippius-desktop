// SharedLinkBadge source routing: file rows read the file-share origin
// index, folder rows read the folder-share LISTING by `(folderHash,
// pathPrefix)` identity — and each kind must leave the other's source
// alone. The index internals are covered in `useFolderShares.test.ts`;
// here the hooks are mocked per repo idiom.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

import SharedLinkBadge from "../SharedLinkBadge";

const getSharesForMock = vi.fn();
const getUnplacedSharesNamedMock = vi.fn();
vi.mock("@/app/lib/hooks/useSharedFiles", () => ({
  useSharedFiles: () => ({
    getSharesFor: getSharesForMock,
    getUnplacedSharesNamed: getUnplacedSharesNamedMock,
    isLoading: false,
  }),
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
  source: "drive",
  linkFormat: "legacy",
  reshareOffered: false,
};

describe("SharedLinkBadge", () => {
  beforeEach(() => {
    getSharesForMock.mockReset().mockReturnValue([]);
    getUnplacedSharesNamedMock.mockReset().mockReturnValue([]);
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

  // Recent Files on the Overview and the Drive, not only the Captures page:
  // a capture's link made in the web console has no origin on this computer
  // and is found by its capture name, which used to badge only the top rows
  // (the links made here) in Recent Files.
  it("badges a capture whose link was made elsewhere, on any page", () => {
    const name = "Recording 2026-10-30 at 11.09.18.mp4";
    getUnplacedSharesNamedMock.mockImplementation((n: string) =>
      n === name
        ? [{ shareToken: "web", filename: name, plaintextSize: 320870, createdAt: "2026-10-30T09:00:00Z", expiresAt: null }]
        : [],
    );
    render(<SharedLinkBadge label="Hippius Captures" actualName={name} fileSize={320870} />);
    expect(screen.getByLabelText(/shared via public link/i)).toBeInTheDocument();
  });

  it("does not badge a plain file from another file's link of the same name", () => {
    getUnplacedSharesNamedMock.mockReturnValue([
      { shareToken: "web", filename: "image.png", plaintextSize: 1, createdAt: "2026-10-30T09:00:00Z", expiresAt: null },
    ]);
    render(<SharedLinkBadge label="Drive" actualName="image.png" fileSize={1} />);
    expect(screen.queryByLabelText(/shared/i)).not.toBeInTheDocument();
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

  it("hands its file's share row ids to Manage, for the shares page to highlight", () => {
    getSharesForMock.mockReturnValue([
      { shareToken: "t1", expiresAt: null, isPrivate: false },
      { shareToken: "t2", expiresAt: null, isPrivate: true },
    ]);
    const onManageShare = vi.fn();

    render(
      <SharedLinkBadge label="Drive" actualName="doc.pdf" onManageShare={onManageShare} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /manage share link/i }));

    expect(onManageShare).toHaveBeenCalledWith(["file:t1", "file:t2"]);
  });

  it("hands a folder's live share and any legacy archive link to Manage", () => {
    useFolderShareBadgeMock.mockReturnValue([LIVE_FOLDER_ROW]);
    getSharesForMock.mockReturnValue([
      { shareToken: "zip", expiresAt: null, isPrivate: false },
    ]);
    const onManageShare = vi.fn();

    render(
      <SharedLinkBadge
        label="Drive"
        actualName="Photos"
        isFolder
        folderRelativePath="Trips/Photos"
        onManageShare={onManageShare}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /manage share link/i }));

    expect(onManageShare).toHaveBeenCalledWith([
      `folder:${LIVE_FOLDER_ROW.tokenHash}`,
      "file:zip",
    ]);
  });
});
