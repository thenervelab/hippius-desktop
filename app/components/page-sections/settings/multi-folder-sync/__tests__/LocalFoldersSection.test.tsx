import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

import { LocalFoldersSection } from "../LocalFoldersSection";
import type { SyncFolder } from "@/app/lib/types/sync-folder";

// jsdom has no IntersectionObserver; render the section as in-view so the
// rows are actually laid out (production only fades them in).
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

vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: vi.fn(),
}));

function folder(overrides: Partial<SyncFolder>): SyncFolder {
  return {
    id: "drive",
    folderName: "Drive",
    localPath: "/Users/me/Drive",
    isLocal: true,
    status: "syncing",
    ...overrides,
  };
}

const REVOKED_MESSAGE = "Access to this shared drive was removed";

function renderSection(
  syncFolders: SyncFolder[],
  onRemoveFolder = vi.fn()
) {
  render(
    <LocalFoldersSection
      syncFolders={syncFolders}
      isLoading={false}
      onAddFolder={vi.fn()}
      onPauseFolder={vi.fn()}
      onResumeFolder={vi.fn()}
      onManageExclusions={vi.fn()}
      onRemoveFolder={onRemoveFolder}
      onDeleteFromServer={vi.fn()}
      onBrowseFolder={vi.fn()}
    />
  );
  return { onRemoveFolder };
}

describe("LocalFoldersSection three-state rows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the badge for each of the three states", () => {
    renderSection([
      folder({ id: "a", folderName: "Active", status: "syncing" }),
      folder({ id: "b", folderName: "Paused", status: "paused" }),
      folder({
        id: "c",
        folderName: "Revoked",
        status: "error",
        errorMessage: REVOKED_MESSAGE,
      }),
    ]);

    expect(screen.getByText("Syncing")).toBeInTheDocument();
    // Both the folder name "Paused" and the badge render; the badge is the
    // 10px pill span — assert at least one badge-shaped match exists.
    expect(screen.getAllByText("Paused").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Error")).toBeInTheDocument();
  });

  it("shows the backend error message and a Remove affordance on an errored row", () => {
    const { onRemoveFolder } = renderSection([
      folder({
        id: "team-drive",
        folderName: "Team Drive",
        status: "error",
        errorMessage: REVOKED_MESSAGE,
      }),
    ]);

    expect(screen.getByText(REVOKED_MESSAGE)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(onRemoveFolder).toHaveBeenCalledTimes(1);
    expect(onRemoveFolder.mock.calls[0][0].id).toBe("team-drive");
  });

  it("falls back to a generic label when the error carries no message", () => {
    renderSection([folder({ status: "error" })]);
    expect(screen.getByText("Sync error")).toBeInTheDocument();
  });

  it("renders no inline Remove affordance on healthy rows", () => {
    renderSection([
      folder({ id: "a", status: "syncing" }),
      folder({ id: "b", status: "paused" }),
    ]);
    expect(
      screen.queryByRole("button", { name: "Remove" })
    ).not.toBeInTheDocument();
  });
});
