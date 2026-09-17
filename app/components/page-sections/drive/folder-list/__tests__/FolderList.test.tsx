import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

import FolderList from "../FolderList";
import type { FolderRow } from "../folderRows";
import type { SyncFolder } from "@/app/lib/types/sync-folder";

function localRow(over: Partial<SyncFolder> = {}): FolderRow {
  const folder: SyncFolder = {
    id: "drive",
    folderName: "Drive",
    localPath: "/Users/me/Drive",
    isLocal: true,
    status: "syncing",
    ...over,
  };
  return {
    id: folder.id,
    folderName: folder.folderName,
    presence: "on-this-device",
    status: folder.status,
    lastModified: 1,
    // Carried through so a row can be a member drive: `toFolderRows` copies
    // this from the sync folder, and the shared badge is what reads it.
    ownerSs58: folder.ownerSs58,
    local: folder,
  };
}

describe("FolderList hosted-root note", () => {
  it("says so under a drive rooted inside another provider's folder", () => {
    render(
      <FolderList
        rows={[
          localRow({
            id: "gd",
            folderName: "Design Work",
            localPath:
              "/Users/me/Library/CloudStorage/GoogleDrive-me@example.com/Design Work",
            hostedBy: { kind: "fileProvider", name: "Google Drive" },
          }),
        ]}
      />,
    );

    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("inside Google Drive");
    expect(note).toHaveTextContent("Share with Hippius");
  });

  it("stays silent for a root Hippius owns", () => {
    render(<FolderList rows={[localRow({ id: "own", folderName: "Own" })]} />);
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("names a macOS special folder without claiming another provider will download files", () => {
    render(
      <FolderList
        rows={[
          localRow({
            id: "docs",
            folderName: "Documents",
            localPath: "/Users/me/Documents/Hippius",
            hostedBy: { kind: "specialFolder", name: "Documents" },
          }),
        ]}
      />,
    );

    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("Documents");
    expect(note).toHaveTextContent("special");
    expect(note).not.toHaveTextContent("download each file");
  });
});

const OWNER = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

describe("shared drives in the list", () => {
  // A drive belonging to another account rendered identically to an owned one,
  // so there was nothing to say whose it was or what the viewer could do.
  it("marks a drive owned by another account", () => {
    render(
      <FolderList
        rows={[localRow({ id: "m", folderName: "team-docs", ownerSs58: OWNER })]}
      />,
    );
    expect(screen.getByText(/Shared/)).toBeInTheDocument();
  });

  it("leaves an owned drive unmarked", () => {
    render(<FolderList rows={[localRow({ id: "own", folderName: "Mine" })]} />);
    expect(screen.queryByText(/Shared/)).not.toBeInTheDocument();
  });

  it("names the role when the membership listing has arrived", () => {
    render(
      <FolderList
        rows={[localRow({ id: "m", folderName: "team-docs", ownerSs58: OWNER })]}
        rolesByLabel={new Map([["team-docs", "manager" as const]])}
      />,
    );
    expect(screen.getByText("Shared · Manager")).toBeInTheDocument();
  });

  // Rows and roles come from different sources. Showing "Shared" alone beats
  // withholding the badge until a second request lands, which would make the
  // row flicker between two meanings.
  it("still marks the drive when its role has not arrived", () => {
    render(
      <FolderList
        rows={[localRow({ id: "m", folderName: "team-docs", ownerSs58: OWNER })]}
        rolesByLabel={new Map()}
      />,
    );
    expect(screen.getByText("Shared")).toBeInTheDocument();
  });

  // The join is by local label, which both sides agree on: a row's folderName
  // is `sync_paths.label`, and so is a membership's localLabel.
  it("does not borrow another drive's role", () => {
    render(
      <FolderList
        rows={[localRow({ id: "m", folderName: "team-docs", ownerSs58: OWNER })]}
        rolesByLabel={new Map([["a-different-drive", "manager" as const]])}
      />,
    );
    expect(screen.getByText("Shared")).toBeInTheDocument();
    expect(screen.queryByText(/Manager/)).not.toBeInTheDocument();
  });

  it("names the owner in the badge tooltip", () => {
    render(
      <FolderList
        rows={[localRow({ id: "m", folderName: "team-docs", ownerSs58: OWNER })]}
      />,
    );
    expect(screen.getByTitle(`Shared with you by ${OWNER}`)).toBeInTheDocument();
  });
});

describe("a drive the owner has shared", () => {
  // The gap: the badge only ever appeared on the receiving side, so an owner
  // could not tell a drive they had shared from a private one.
  it("says how many people an own drive reached", () => {
    render(
      <FolderList
        rows={[localRow({ id: "own", folderName: "team-docs" })]}
        shareCountsByLabel={new Map([["team-docs", 3]])}
      />,
    );
    expect(screen.getByText("Shared with 3")).toBeInTheDocument();
  });

  it("leaves a private own drive unmarked", () => {
    render(
      <FolderList
        rows={[localRow({ id: "own", folderName: "team-docs" })]}
        shareCountsByLabel={new Map([["team-docs", 0]])}
      />,
    );
    expect(screen.queryByText(/Shared/)).not.toBeInTheDocument();
  });

  // Not knowing must not read as "private".
  it("shows nothing while the count is still unknown", () => {
    render(
      <FolderList rows={[localRow({ id: "own", folderName: "team-docs" })]} />,
    );
    expect(screen.queryByText(/Shared/)).not.toBeInTheDocument();
  });

  it("prefers the with-me reading on a drive owned by someone else", () => {
    render(
      <FolderList
        rows={[localRow({ id: "m", folderName: "team-docs", ownerSs58: OWNER })]}
        rolesByLabel={new Map([["team-docs", "writer" as const]])}
        shareCountsByLabel={new Map([["team-docs", 9]])}
      />,
    );
    expect(screen.getByText("Shared · Editor")).toBeInTheDocument();
    expect(screen.queryByText(/Shared with 9/)).not.toBeInTheDocument();
  });
});
