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

// Flip the shared-drives flag per test — the section reads it at render
// time for the owner badge and the member-vs-own menu gating.
const flagState = vi.hoisted(() => ({ sharedDrivesEnabled: false }));
vi.mock("@/app/lib/featureFlags", () => ({
  get SHARED_DRIVES_ENABLED() {
    return flagState.sharedDrivesEnabled;
  },
}));

// `next/dynamic` wraps the boring-avatars identicon in the owner badge; a
// plain stub avoids lazy-loading timing in jsdom.
vi.mock("next/dynamic", () => ({
  default: () => {
    const Stub = ({ name }: { name?: string }) => <span data-testid="avatar" data-name={name} />;
    Stub.displayName = "AvatarStub";
    return Stub;
  },
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
  onRemoveFolder = vi.fn(),
  onLeaveDrive = vi.fn()
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
      onLeaveDrive={onLeaveDrive}
    />
  );
  return { onRemoveFolder, onLeaveDrive };
}

/** Open the right-click context menu on the row containing `folderName`.
 * Both menus render from the SAME `buildFolderActions` list, so asserting
 * the plain-portal context menu covers the Radix 3-dot menu's items too. */
function openContextMenu(folderName: string) {
  fireEvent.contextMenu(screen.getByText(folderName));
}

describe("LocalFoldersSection three-state rows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    flagState.sharedDrivesEnabled = false;
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

const OWNER = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

describe("LocalFoldersSection shared-drive rows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    flagState.sharedDrivesEnabled = false;
  });

  it("flag off: no Share drive item or owner badge, but member rows KEEP the member gating", () => {
    // The flag hides only the opt-in surfaces (Share drive item, badge).
    // The protective member gating keys on the row's ownerSs58 data alone,
    // so a flag rollback can't hand a member row Delete from Server or a
    // plain Remove that strands the live membership.
    renderSection([folder({ id: "m", folderName: "Team", ownerSs58: OWNER })]);

    expect(screen.queryByTestId("avatar")).not.toBeInTheDocument();

    openContextMenu("Team");
    expect(screen.queryByText("Share drive…")).not.toBeInTheDocument();
    expect(screen.getByText("Leave shared drive")).toBeInTheDocument();
    expect(screen.queryByText("Remove from Sync")).not.toBeInTheDocument();
    expect(screen.queryByText("Excluded from Sync")).not.toBeInTheDocument();
    expect(screen.queryByText("Delete from Server")).not.toBeInTheDocument();
  });

  it("flag on, own drive: Share drive item shows, wording stays Remove from Sync", () => {
    flagState.sharedDrivesEnabled = true;
    renderSection([folder({ id: "own", folderName: "Docs" })]);

    openContextMenu("Docs");
    expect(screen.getByText("Share drive…")).toBeInTheDocument();
    expect(screen.getByText("Remove from Sync")).toBeInTheDocument();
    expect(screen.queryByText("Leave shared drive")).not.toBeInTheDocument();
  });

  it("flag on, member drive: owner badge, no owner-only items, Leave routes to onLeaveDrive", () => {
    flagState.sharedDrivesEnabled = true;
    const { onRemoveFolder, onLeaveDrive } = renderSection([
      folder({ id: "team", folderName: "Team", ownerSs58: OWNER }),
    ]);

    // Owner badge: identicon keyed by the owner's ss58.
    expect(screen.getByTestId("avatar")).toHaveAttribute("data-name", OWNER);

    openContextMenu("Team");
    expect(screen.queryByText("Share drive…")).not.toBeInTheDocument();
    expect(screen.queryByText("Excluded from Sync")).not.toBeInTheDocument();
    expect(screen.queryByText("Delete from Server")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Leave shared drive"));
    expect(onLeaveDrive).toHaveBeenCalledTimes(1);
    expect(onLeaveDrive.mock.calls[0][0].id).toBe("team");
    expect(onRemoveFolder).not.toHaveBeenCalled();
  });
});
