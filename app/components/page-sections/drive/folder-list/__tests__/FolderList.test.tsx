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
