import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

import { RemoteFoldersSection } from "../RemoteFoldersSection";
import type { RemoteFolder } from "@/app/lib/types/sync-folder";
import {
  LOCALLY_REMOVED_SECTION_LABEL,
  OTHER_DEVICE_SECTION_LABEL,
} from "../remoteFoldersState";

vi.mock("react-intersection-observer", () => ({
  InView: ({
    children,
  }: {
    children: (args: {
      inView: boolean;
      ref: (node?: Element | null) => void;
    }) => React.ReactNode;
  }) => children({ inView: true, ref: () => {} }),
}));

function folder(overrides: Partial<RemoteFolder>): RemoteFolder {
  return {
    folderName: "docs",
    deviceName: "Georges-MacBook",
    lastModified: 0,
    fileCount: 1,
    totalBytes: 10,
    ...overrides,
  };
}

const noop = vi.fn();

describe("RemoteFoldersSection", () => {
  it("lists a locally-removed folder under the not-synced heading, not other devices", () => {
    render(
      <RemoteFoldersSection
        remoteFolders={[
          folder({
            folderName: "was-here",
            origin: { kind: "locallyRemoved" },
          }),
        ]}
        isLoading={false}
        onSyncFolder={noop}
        onDeleteFromServer={noop}
        onBrowseFolder={noop}
      />,
    );

    expect(screen.getByText(LOCALLY_REMOVED_SECTION_LABEL)).toBeInTheDocument();
    expect(screen.getByText("was-here")).toBeInTheDocument();
    expect(screen.queryByText(OTHER_DEVICE_SECTION_LABEL)).not.toBeInTheDocument();
  });

  it("keeps a different-device folder under Sync from Other Devices", () => {
    render(
      <RemoteFoldersSection
        remoteFolders={[
          folder({
            folderName: "office-docs",
            deviceName: "Office PC",
            origin: { kind: "otherDevice" },
          }),
        ]}
        isLoading={false}
        onSyncFolder={noop}
        onDeleteFromServer={noop}
        onBrowseFolder={noop}
      />,
    );

    expect(screen.getByText(OTHER_DEVICE_SECTION_LABEL)).toBeInTheDocument();
    expect(screen.getByText("office-docs")).toBeInTheDocument();
    expect(screen.queryByText(LOCALLY_REMOVED_SECTION_LABEL)).not.toBeInTheDocument();
  });
});
